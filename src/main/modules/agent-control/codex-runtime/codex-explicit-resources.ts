import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { z } from 'zod'

import type { SendScopedResourceSelection } from '../../../../shared/ipc-contracts/agent-runtime'
import type { RequestEnvelopeResource } from '../contracts/request-envelope'

import type { CodexUserInput } from './codex-user-input'
import type { ResourceVersionReference } from './codex-turn-input-builder'

const IMAGE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp',
])
const AUDIO_EXTENSIONS = new Set([
  '.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav', '.webm',
])
const TEXT_EXTENSIONS = new Set([
  '.csv', '.html', '.htm', '.json', '.log', '.markdown', '.md', '.txt', '.xml', '.yaml', '.yml',
])
const EXTRACTABLE_DOCUMENT_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  '.docx', '.pdf', '.xls', '.xlsx',
])

export type CodexResolvedSkillInput = {
  name: string
  path: string
}

export type CodexResolvedInlineResource = {
  name: string
  path: string | null
  text: string
  digest: string
}

export type PreparedCodexResourceAuthority = {
  kind: 'local_file' | 'local_directory'
  logicalResourceId: string
  name: string
  path: string
  currentVersion: string
  currentDigest: string
  policyEpoch: number
  directoryIdentity?: {
    device: string
    inode: string
    mode: number
    mtimeMs: number
  }
  allowedToolNames: Array<'file_extract_text' | 'file_read_excerpt' | 'file_inventory'>
}

export const preparedCodexResourceAuthoritySchema = z.object({
  kind: z.enum(['local_file', 'local_directory']),
  logicalResourceId: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  currentVersion: z.string().min(1),
  currentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policyEpoch: z.number().int().positive(),
  directoryIdentity: z.object({
    device: z.string().min(1),
    inode: z.string().min(1),
    mode: z.number().int().nonnegative(),
    mtimeMs: z.number().nonnegative(),
  }).strict().optional(),
  allowedToolNames: z.array(z.enum([
    'file_extract_text', 'file_read_excerpt', 'file_inventory',
  ])),
}).strict()

export type ResolvedCodexExplicitResources = {
  input: CodexUserInput[]
  resourceRefs: ResourceVersionReference[]
  requestResources: RequestEnvelopeResource[]
  authorities: PreparedCodexResourceAuthority[]
}

export type CodexRetryLocalResourceSelection = {
  selection: Extract<SendScopedResourceSelection, { kind: 'local_file' | 'local_directory' }>
  logicalResourceId: string
  directoryIdentity?: PreparedCodexResourceAuthority['directoryIdentity']
}

export function recoverCodexRetrySkillSelection(
  authorization:
    | { mode: 'none' }
    | {
        mode: 'selected'
        skillId: string
        allowedTypedActions?: readonly string[]
        allowedPrimitives?: readonly string[]
      },
): {
  selection: Extract<SendScopedResourceSelection, { kind: 'skill' }>
  applicableToolNames: string[]
} | null {
  if (authorization.mode !== 'selected') return null
  return {
    selection: {
      kind: 'skill',
      id: `retry-skill:${authorization.skillId}`,
      name: authorization.skillId,
      path: '',
      skillId: authorization.skillId,
    },
    applicableToolNames: [...new Set([
      ...(authorization.allowedTypedActions ?? []),
      ...(authorization.allowedPrimitives ?? []),
    ])],
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function localLogicalResourceId(kind: 'local_file' | 'local_directory', canonicalPath: string): string {
  return `${kind === 'local_directory' ? 'local-directory' : 'local-file'}:${sha256(canonicalPath).slice(0, 32)}`
}

export function recoverCodexRetryLocalResourceSelections(input: {
  explicitInput: readonly CodexUserInput[]
  authorities: readonly PreparedCodexResourceAuthority[]
}): CodexRetryLocalResourceSelection[] {
  const authoritiesByPath = new Map(input.authorities.map((authority) => [authority.path, authority]))
  const recovered: CodexRetryLocalResourceSelection[] = []
  const seen = new Set<string>()

  for (const entry of input.explicitInput) {
    if (entry.type !== 'mention' && entry.type !== 'localImage' && entry.type !== 'localAudio') continue
    const path = entry.path
    const authority = authoritiesByPath.get(path)
    if (entry.type === 'mention' && !authority) continue
    const kind = authority?.kind ?? 'local_file'
    const logicalResourceId = authority?.logicalResourceId ?? localLogicalResourceId(kind, path)
    if (seen.has(logicalResourceId)) continue
    seen.add(logicalResourceId)
    const name = entry.type === 'mention' ? entry.name : basename(path)
    recovered.push({
      logicalResourceId,
      ...(authority?.directoryIdentity ? { directoryIdentity: authority.directoryIdentity } : {}),
      selection: kind === 'local_directory'
        ? { kind, id: logicalResourceId, name, path }
        : {
            kind,
            id: logicalResourceId,
            name,
            path,
            size: 0,
            ext: extname(path),
            rendererType: 'other',
          },
    })
  }

  return recovered
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

function versionReference(
  logicalResourceId: string,
  digest: string,
): ResourceVersionReference {
  return {
    logicalResourceId,
    currentVersion: `sha256:${digest}`,
    currentDigest: digest,
    supersedesVersion: null,
    policyEpoch: 1,
  }
}

function bodyFreeRequestResource(input: {
  logicalResourceId: string
  kind: RequestEnvelopeResource['kind']
  source: RequestEnvelopeResource['source']
  name: string
  path: string | null
  order: number
  canRead: boolean
}): RequestEnvelopeResource {
  return {
    id: input.logicalResourceId,
    kind: input.kind,
    source: input.source,
    name: input.name,
    path: input.path,
    text: '',
    summary: null,
    order: input.order,
    canRead: input.canRead,
    canWrite: false,
  }
}

const ISO_WINDOW = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/
const MAX_CALENDAR_WINDOW_MS = 366 * 24 * 60 * 60 * 1000

export function validateCodexCalendarWindow(input: {
  start: string
  end: string
  calendarId?: string
}): { start: string; end: string; calendarId?: string } {
  const start = String(input.start || '').trim()
  const end = String(input.end || '').trim()
  if (!ISO_WINDOW.test(start) || !ISO_WINDOW.test(end)) {
    throw new Error('codex_calendar_window_invalid')
  }
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error('codex_calendar_window_invalid')
  }
  if (startMs >= endMs) throw new Error('codex_calendar_window_order_invalid')
  if (endMs - startMs > MAX_CALENDAR_WINDOW_MS) {
    throw new Error('codex_calendar_window_span_invalid')
  }
  const calendarId = typeof input.calendarId === 'string' && input.calendarId.trim()
    ? input.calendarId.trim()
    : undefined
  return { start, end, ...(calendarId ? { calendarId } : {}) }
}

export async function resolveCodexExplicitResources(input: {
  selections: readonly SendScopedResourceSelection[]
  resolveSkill: (selection: Extract<SendScopedResourceSelection, { kind: 'skill' }>) => CodexResolvedSkillInput | null
  resolveBrowser?: (
    selection: Extract<SendScopedResourceSelection, { kind: 'browser_tab' }>,
  ) => Promise<CodexResolvedInlineResource | null>
  resolveCalendar?: (
    selection: Extract<SendScopedResourceSelection, { kind: 'calendar_event' }>,
  ) => CodexResolvedInlineResource | null
  resolveRssItem?: (
    selection: Extract<SendScopedResourceSelection, { kind: 'rss_item' }>,
  ) => CodexResolvedInlineResource | null
  resolveRssSource?: (
    selection: Extract<SendScopedResourceSelection, { kind: 'rss_source' }>,
  ) => CodexResolvedInlineResource | null
  selectedSkill?: CodexResolvedSkillInput | null
}): Promise<ResolvedCodexExplicitResources> {
  const nativeInput: CodexUserInput[] = []
  const resourceRefs: ResourceVersionReference[] = []
  const requestResources: RequestEnvelopeResource[] = []
  const authorities: PreparedCodexResourceAuthority[] = []
  const seen = new Set<string>()

  const addSkill = async (
    skill: CodexResolvedSkillInput,
    unavailableCode: 'codex_explicit_skill_unavailable' | 'codex_selected_skill_unavailable',
  ): Promise<void> => {
    let canonicalPath: string
    let metadata
    try {
      canonicalPath = await realpath(skill.path)
      metadata = await stat(canonicalPath)
    } catch {
      throw new Error(unavailableCode)
    }
    if (!metadata.isDirectory()) throw new Error('codex_explicit_skill_not_directory')
    const key = `skill\u0000${canonicalPath}`
    if (seen.has(key)) return
    seen.add(key)
    const digest = await sha256File(join(canonicalPath, 'SKILL.md')).catch(() => {
      throw new Error(unavailableCode)
    })
    const logicalResourceId = `skill:${sha256(canonicalPath).slice(0, 32)}`
    nativeInput.push({ type: 'skill', name: skill.name, path: canonicalPath })
    resourceRefs.push(versionReference(logicalResourceId, digest))
    requestResources.push(bodyFreeRequestResource({
      logicalResourceId,
      kind: 'skill_reference',
      source: 'explicit_reference',
      name: skill.name,
      path: canonicalPath,
      order: requestResources.length,
      canRead: false,
    }))
  }

  for (const selection of input.selections) {
    if (selection.kind === 'skill') {
      let skill: CodexResolvedSkillInput | null
      try {
        skill = input.resolveSkill(selection)
      } catch {
        throw new Error('codex_explicit_skill_unavailable')
      }
      if (!skill) throw new Error('codex_explicit_skill_unavailable')
      await addSkill(skill, 'codex_explicit_skill_unavailable')
      continue
    }

    if (selection.kind === 'browser_tab' || selection.kind === 'calendar_event') {
      const resolved = selection.kind === 'browser_tab'
        ? await input.resolveBrowser?.(selection) ?? null
        : input.resolveCalendar?.(selection) ?? null
      if (!resolved) {
        throw new Error(selection.kind === 'browser_tab'
          ? 'codex_explicit_browser_reference_unavailable'
          : 'codex_explicit_calendar_reference_unavailable')
      }
      const logicalResourceId = `${selection.kind}:${sha256(
        selection.kind === 'browser_tab' ? selection.tabId : selection.eventId,
      ).slice(0, 32)}`
      const key = `${selection.kind}\u0000${logicalResourceId}`
      if (seen.has(key)) continue
      seen.add(key)
      nativeInput.push({ type: 'text', text: resolved.text, text_elements: [] })
      resourceRefs.push(versionReference(logicalResourceId, resolved.digest))
      requestResources.push(bodyFreeRequestResource({
        logicalResourceId,
        kind: selection.kind === 'browser_tab' ? 'browser_reference' : 'calendar_event',
        source: selection.kind === 'browser_tab' ? 'browser_context' : 'calendar_context',
        name: resolved.name,
        path: resolved.path,
        order: requestResources.length,
        canRead: true,
      }))
      continue
    }

    if (selection.kind === 'rss_item' || selection.kind === 'rss_source') {
      const resolved = selection.kind === 'rss_item'
        ? input.resolveRssItem?.(selection) ?? null
        : input.resolveRssSource?.(selection) ?? null
      if (!resolved) {
        throw new Error(selection.kind === 'rss_item'
          ? 'codex_explicit_rss_item_unavailable'
          : 'codex_explicit_rss_source_unavailable')
      }
      const identity = selection.kind === 'rss_item' ? selection.itemId : selection.sourceId
      const logicalResourceId = `${selection.kind}:${sha256(identity).slice(0, 32)}`
      const key = `${selection.kind}\u0000${logicalResourceId}`
      if (seen.has(key)) continue
      seen.add(key)
      nativeInput.push({ type: 'text', text: resolved.text, text_elements: [] })
      resourceRefs.push(versionReference(logicalResourceId, resolved.digest))
      requestResources.push(bodyFreeRequestResource({
        logicalResourceId,
        kind: selection.kind,
        source: 'rss_context',
        name: resolved.name,
        path: resolved.path,
        order: requestResources.length,
        canRead: true,
      }))
      continue
    }

    if (selection.kind === 'calendar_window') {
      const window = validateCodexCalendarWindow(selection)
      const digest = sha256(JSON.stringify(window))
      const logicalResourceId = `calendar-window:${digest.slice(0, 32)}`
      const key = `calendar_window\u0000${logicalResourceId}`
      if (seen.has(key)) continue
      seen.add(key)
      nativeInput.push({
        type: 'text',
        text: `当前日历可见窗口（结构事实，不含事件正文）：${window.start} 至 ${window.end}${window.calendarId ? `，日历 ${window.calendarId}` : ''}`,
        text_elements: [],
      })
      resourceRefs.push(versionReference(logicalResourceId, digest))
      requestResources.push({
        ...bodyFreeRequestResource({
          logicalResourceId,
          kind: 'calendar_window',
          source: 'calendar_context',
          name: selection.name,
          path: null,
          order: requestResources.length,
          canRead: true,
        }),
        summary: `${window.start}/${window.end}`,
      })
      continue
    }

    if (selection.kind === 'widget_target') {
      const digest = selection.currentDigest
      const logicalResourceId = selection.logicalResourceId
      const key = `widget_target\u0000${logicalResourceId}\u0000${selection.widgetId}`
      if (seen.has(key)) continue
      seen.add(key)
      resourceRefs.push(versionReference(logicalResourceId, digest))
      requestResources.push({
        ...bodyFreeRequestResource({
          logicalResourceId,
          kind: 'widget_target',
          source: 'widget_target',
          name: selection.name,
          path: null,
          order: requestResources.length,
          canRead: true,
        }),
        tabId: selection.tabId,
        widgetId: selection.widgetId,
      })
      continue
    }

    if (selection.kind === 'quoted_text') {
      const text = selection.text.trim()
      if (!text) throw new Error('codex_explicit_quote_unavailable')
      const digest = sha256(JSON.stringify({
        text,
        documentTitle: selection.documentTitle || null,
        sectionTitle: selection.sectionTitle || null,
        lineStart: selection.lineStart || null,
        lineEnd: selection.lineEnd || null,
      }))
      const logicalResourceId = `quoted-text:${digest.slice(0, 32)}`
      const key = `quoted_text\u0000${logicalResourceId}`
      if (seen.has(key)) continue
      seen.add(key)
      const lineLabel = selection.lineStart && selection.lineEnd
        ? `\n位置：第 ${selection.lineStart}-${selection.lineEnd} 行`
        : ''
      const sectionLabel = selection.sectionTitle ? `\n章节：${selection.sectionTitle}` : ''
      nativeInput.push({
        type: 'text',
        text: `用户明确引用的文档摘录（只读材料）：${selection.documentTitle || selection.name}${sectionLabel}${lineLabel}\n\n${text}`,
        text_elements: [],
      })
      resourceRefs.push(versionReference(logicalResourceId, digest))
      requestResources.push(bodyFreeRequestResource({
        logicalResourceId,
        kind: 'document_quote',
        source: 'document_quote',
        name: selection.name,
        path: null,
        order: requestResources.length,
        canRead: true,
      }))
      continue
    }

    let canonicalPath: string
    let metadata
    try {
      canonicalPath = await realpath(selection.path)
      metadata = await stat(canonicalPath)
    } catch {
      throw new Error('codex_explicit_resource_unavailable')
    }
    const expectedDirectory = selection.kind === 'local_directory'
    if (expectedDirectory !== metadata.isDirectory() || (!expectedDirectory && !metadata.isFile())) {
      throw new Error('codex_explicit_resource_kind_mismatch')
    }
    const key = `${selection.kind}\u0000${canonicalPath}`
    if (seen.has(key)) continue
    seen.add(key)

    const name = selection.name.trim() || basename(canonicalPath)
    const digest = expectedDirectory
      ? sha256(JSON.stringify([canonicalPath, metadata.mtimeMs]))
      : await sha256File(canonicalPath).catch(() => {
          throw new Error('codex_explicit_resource_unavailable')
        })
    const logicalResourceId = localLogicalResourceId(selection.kind, canonicalPath)
    const reference = versionReference(logicalResourceId, digest)
    resourceRefs.push(reference)

    if (expectedDirectory) {
      nativeInput.push({ type: 'mention', name, path: canonicalPath })
      requestResources.push(bodyFreeRequestResource({
        logicalResourceId,
        kind: 'folder_reference',
        source: 'folder_reference',
        name,
        path: canonicalPath,
        order: requestResources.length,
        canRead: true,
      }))
      authorities.push({
        kind: 'local_directory',
        logicalResourceId,
        name,
        path: canonicalPath,
        currentVersion: reference.currentVersion,
        currentDigest: reference.currentDigest,
        policyEpoch: reference.policyEpoch,
        directoryIdentity: {
          device: String(metadata.dev),
          inode: String(metadata.ino),
          mode: metadata.mode,
          mtimeMs: metadata.mtimeMs,
        },
        allowedToolNames: ['file_inventory'],
      })
      continue
    }

    const extension = extname(canonicalPath).toLowerCase()
    if (IMAGE_EXTENSIONS.has(extension)) {
      nativeInput.push({ type: 'localImage', path: canonicalPath, detail: null })
    } else if (AUDIO_EXTENSIONS.has(extension)) {
      nativeInput.push({ type: 'localAudio', path: canonicalPath })
    } else if (EXTRACTABLE_DOCUMENT_EXTENSIONS.has(extension)) {
      nativeInput.push({ type: 'mention', name, path: canonicalPath })
    } else {
      throw new Error('codex_explicit_resource_unsupported')
    }
    requestResources.push(bodyFreeRequestResource({
      logicalResourceId,
      kind: 'attachment',
      source: 'user_attachment',
      name,
      path: canonicalPath,
      order: requestResources.length,
      canRead: EXTRACTABLE_DOCUMENT_EXTENSIONS.has(extension),
    }))
    if (EXTRACTABLE_DOCUMENT_EXTENSIONS.has(extension)) {
      authorities.push({
        kind: 'local_file',
        logicalResourceId,
        name,
        path: canonicalPath,
        currentVersion: reference.currentVersion,
        currentDigest: reference.currentDigest,
        policyEpoch: reference.policyEpoch,
        allowedToolNames: [
          'file_extract_text',
          ...(TEXT_EXTENSIONS.has(extension) ? ['file_read_excerpt' as const] : []),
        ],
      })
    }
  }

  if (input.selectedSkill) await addSkill(input.selectedSkill, 'codex_selected_skill_unavailable')

  return { input: nativeInput, resourceRefs, requestResources, authorities }
}
