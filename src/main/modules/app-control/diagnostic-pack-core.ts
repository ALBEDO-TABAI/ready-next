import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'

const MAX_LOG_BYTES = 2 * 1024 * 1024
const MAX_PREVIEW_CHARS = 280

const KNOWN_LOG_PREFIXES = [
  'ready-agent-metrics.log',
  'ready-agent-sdk.log',
  'ready-browser.log',
  'ready-database.log',
  'ready-directchat.log',
  'ready-memory-tools.log',
  'ready-process-events.log',
  'ready-search.log',
  'ready-settings.log',
  'ready-startup.log',
  'ready-system-tools.log',
  'ready-tools.log',
] as const

const SUMMARY_TABLES = [
  'chat_conversations',
  'chat_messages',
  'task_projections',
  'agent_channels',
  'agent_schedules',
  'rss_sources',
  'rss_items',
  'calendar_sources',
  'calendar_events',
  'skill_task_runs',
  'run_meta',
] as const

const SECRET_KEY_PATTERN = /(api[_-]?key|secret|token|password|authorization|cookie|sessdata|bili[_-]?jct|csrf)/i
const ERROR_TEXT_PATTERN = /(ready 跟丢|跟丢|error|failed|失败|异常|timeout|超时|infra_error|stale_request)/i

export interface DiagnosticPackAppInfo {
  appName: string
  appVersion: string
  isPackaged: boolean
  appPath: string
  userDataPath: string
  logsPath: string
  platform: NodeJS.Platform
  arch: string
  versions: NodeJS.ProcessVersions
}

export interface DiagnosticPackResult {
  path: string
  fileName: string
  bytes: number
  includedLogs: string[]
  skippedLogs: Array<{ name: string; reason: string }>
}

interface RawStatement {
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

export interface DiagnosticRawDb {
  prepare(sql: string): RawStatement
}

export interface CreateDiagnosticPackOptions {
  outputDir: string
  logDir: string
  appInfo: DiagnosticPackAppInfo
  rawDb?: DiagnosticRawDb | null
  now?: Date
}

interface LogCandidate {
  name: string
  path: string
}

function safeNamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ready'
}

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-[REDACTED]')
    .replace(/([A-Za-z0-9_-]{24,})/g, (token) => {
      if (/^[0-9a-f-]{24,}$/i.test(token)) return token
      return '[REDACTED_TOKEN]'
    })
}

function sanitizeValue(value: unknown, key = ''): unknown {
  if (value == null) return value
  if (SECRET_KEY_PATTERN.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, key))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = sanitizeValue(childValue, childKey)
    }
    return out
  }
  return String(value)
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function previewText(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '')
  const normalized = raw.replace(/\s+/g, ' ').trim()
  return normalized.length > MAX_PREVIEW_CHARS
    ? `${normalized.slice(0, MAX_PREVIEW_CHARS)}…`
    : normalized
}

function safeAll<T>(rawDb: DiagnosticRawDb | null | undefined, sql: string, ...params: unknown[]): T[] {
  if (!rawDb) return []
  try {
    return rawDb.prepare(sql).all<T>(...params)
  } catch {
    return []
  }
}

function safeGet<T>(rawDb: DiagnosticRawDb | null | undefined, sql: string, ...params: unknown[]): T | null {
  if (!rawDb) return null
  try {
    return rawDb.prepare(sql).get<T>(...params) || null
  } catch {
    return null
  }
}

function tableCounts(rawDb: DiagnosticRawDb | null | undefined): Record<string, number | string> {
  const out: Record<string, number | string> = {}
  for (const table of SUMMARY_TABLES) {
    const row = safeGet<{ count: number }>(rawDb, `SELECT COUNT(1) as count FROM ${table}`)
    out[table] = row ? row.count : 'unavailable'
  }
  return out
}

function collectDatabaseSummary(rawDb: DiagnosticRawDb | null | undefined): Record<string, unknown> {
  const settings = safeAll<{ key: string; value: string }>(
    rawDb,
    'SELECT key, value FROM settings ORDER BY key ASC',
  )
  const conversations = safeAll<Record<string, unknown>>(
    rawDb,
    `SELECT id, agent, title, source_kind, source_id, thread_key, lineage_root_id, resume_title, created_at, updated_at, meta_json
     FROM chat_conversations
     ORDER BY updated_at DESC
     LIMIT 20`,
  ).map((row) => ({
    ...row,
    meta_json: sanitizeValue(parseMaybeJson(String(row.meta_json || '{}')), 'meta_json'),
  }))
  const messages = safeAll<Record<string, unknown>>(
    rawDb,
    `SELECT id, conversation_id, role, content, timestamp, meta_json
     FROM chat_messages
     ORDER BY timestamp DESC
     LIMIT 80`,
  ).map((row) => {
    const role = String(row.role || '')
    const content = String(row.content || '')
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      role,
      timestamp: row.timestamp,
      content_length: content.length,
      content_preview: role === 'user' && !ERROR_TEXT_PATTERN.test(content)
        ? '[user message omitted]'
        : previewText(redactString(content)),
      meta: sanitizeValue(parseMaybeJson(String(row.meta_json || '{}')), 'meta_json'),
    }
  })
  const projections = safeAll<Record<string, unknown>>(
    rawDb,
    `SELECT task_id, scope_id, run_id, parent_task_id, task_type, module, task_title, task_summary,
            status, interaction_state, waiting_for, degradation_reason, blocked_reason,
            resumable_actions_json, continuation_ref_json, progress_json, recent_artifacts_json,
            created_at, updated_at
     FROM task_projections
     ORDER BY updated_at DESC
     LIMIT 60`,
  ).map((row) => {
    const continuationRef = parseMaybeJson(String(row.continuation_ref_json || '{}'))
    const resumableActions = parseMaybeJson(String(row.resumable_actions_json || '[]'))
    const frozenLegacy =
      row.status === 'blocked'
      && row.interaction_state === 'suspended'
      && (!Array.isArray(resumableActions) || resumableActions.length === 0)
      && (!continuationRef || typeof continuationRef !== 'object' || Object.keys(continuationRef as Record<string, unknown>).length === 0)
    return {
      ...row,
      task_summary: previewText(row.task_summary || ''),
      blocked_reason: previewText(row.blocked_reason || ''),
      resumable_actions_json: sanitizeValue(resumableActions),
      continuation_ref_json: sanitizeValue(continuationRef),
      progress_json: sanitizeValue(parseMaybeJson(String(row.progress_json || '{}'))),
      recent_artifacts_json: sanitizeValue(parseMaybeJson(String(row.recent_artifacts_json || '[]'))),
      legacy_continuation_state: frozenLegacy ? 'legacy_not_resumable' : 'normal',
    }
  })
  const runMeta = safeAll<Record<string, unknown>>(
    rawDb,
    `SELECT run_id, task_id, scope_id, agent_id, status, task_type, terminal_reason,
            provider_protocol, wire_api, context_window, provider_diagnostics_json,
            budget_json, continuation_ref_json, recovery_history_json,
            input_tokens, output_tokens, total_tokens,
            first_message_text, last_message_text, follow_up_text,
            created_at, updated_at
     FROM run_meta
     ORDER BY updated_at DESC
     LIMIT 40`,
  ).map((row) => ({
    ...row,
    provider_diagnostics_json: sanitizeValue(parseMaybeJson(String(row.provider_diagnostics_json || '{}'))),
    budget_json: sanitizeValue(parseMaybeJson(String(row.budget_json || '{}'))),
    continuation_ref_json: sanitizeValue(parseMaybeJson(String(row.continuation_ref_json || '{}'))),
    recovery_history_json: sanitizeValue(parseMaybeJson(String(row.recovery_history_json || '[]'))),
    first_message_text: previewText(redactString(String(row.first_message_text || ''))),
    last_message_text: previewText(redactString(String(row.last_message_text || ''))),
    follow_up_text: previewText(redactString(String(row.follow_up_text || ''))),
  }))
  const channels = safeAll<Record<string, unknown>>(
    rawDb,
    `SELECT id, type, name, enabled, last_seen_at, last_error, updated_at
     FROM agent_channels
     ORDER BY updated_at DESC
     LIMIT 40`,
  )

  return {
    tableCounts: tableCounts(rawDb),
    settings: Object.fromEntries(settings.map((row) => [
      row.key,
      sanitizeValue(parseMaybeJson(row.value), row.key),
    ])),
    recentConversations: conversations,
    recentMessageMarkers: messages,
    recentTaskProjections: projections,
    recentRunMeta: runMeta,
    channels,
  }
}

async function collectLogCandidates(logDir: string): Promise<LogCandidate[]> {
  let names: string[] = []
  try {
    names = await readdir(logDir)
  } catch {
    return []
  }
  return names
    .filter((name) =>
      KNOWN_LOG_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}.`)))
    .sort()
    .map((name) => ({ name, path: join(logDir, name) }))
}

async function addLogFile(
  zip: JSZip,
  candidate: LogCandidate,
  result: Pick<DiagnosticPackResult, 'includedLogs' | 'skippedLogs'>,
): Promise<void> {
  try {
    const info = await stat(candidate.path)
    const bytes = await readFile(candidate.path)
    const body = bytes.length > MAX_LOG_BYTES
      ? Buffer.concat([
        Buffer.from(`[diagnostic-pack] log truncated to last ${MAX_LOG_BYTES} bytes from ${bytes.length} bytes\n`, 'utf8'),
        bytes.subarray(bytes.length - MAX_LOG_BYTES),
      ])
      : bytes
    zip.file(`logs/${candidate.name}`, redactString(body.toString('utf8')))
    result.includedLogs.push(`${candidate.name} (${info.size} bytes)`)
  } catch (error) {
    result.skippedLogs.push({
      name: candidate.name,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

function buildManifest(appInfo: DiagnosticPackAppInfo, createdAt: string): Record<string, unknown> {
  return {
    createdAt,
    app: {
      name: appInfo.appName,
      version: appInfo.appVersion,
      isPackaged: appInfo.isPackaged,
      appPath: appInfo.appPath,
      userDataPath: appInfo.userDataPath,
      logsPath: appInfo.logsPath,
    },
    system: {
      platform: appInfo.platform,
      arch: appInfo.arch,
      versions: appInfo.versions,
    },
    privacy: {
      fullDatabaseIncluded: false,
      userMessages: 'omitted unless they look like error text',
      secrets: 'settings and token-like strings are redacted',
    },
  }
}

export async function createDiagnosticPack(options: CreateDiagnosticPackOptions): Promise<DiagnosticPackResult> {
  const now = options.now ?? new Date()
  const createdAt = now.toISOString()
  const fileName = `Ready-diagnostics-${safeNamePart(createdAt.replace(/[:.]/g, '-'))}.zip`
  const outputPath = join(options.outputDir, fileName)
  const zip = new JSZip()
  const result: DiagnosticPackResult = {
    path: outputPath,
    fileName,
    bytes: 0,
    includedLogs: [],
    skippedLogs: [],
  }

  zip.file('manifest.json', JSON.stringify(buildManifest(options.appInfo, createdAt), null, 2))
  zip.file('state/database-summary.json', JSON.stringify(collectDatabaseSummary(options.rawDb), null, 2))
  zip.file('README.txt', [
    'Ready diagnostic package',
    '',
    'Send this zip back to the Ready team when a packaged app reports an error.',
    'It includes recent Ready logs, redacted settings, recent task state summaries, and environment information.',
    'It does not include the full database or raw user-message history.',
  ].join('\n'))

  const logs = await collectLogCandidates(options.logDir)
  for (const log of logs) {
    await addLogFile(zip, log, result)
  }
  zip.file('state/package-result.json', JSON.stringify({
    includedLogs: result.includedLogs,
    skippedLogs: result.skippedLogs,
  }, null, 2))

  await mkdir(options.outputDir, { recursive: true })
  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  await writeFile(outputPath, data)
  result.bytes = data.length
  return result
}
