import { createRequire } from 'module'
import { createHash } from 'crypto'
import { resolveReadyDatabasePath } from './database-path'
import { runMigrations } from './migrations'
import {
  performBootSweep,
  performSessionSweep,
} from './ask-user-questions-sweep'
import { createRotatingLogger } from '../utils/rotating-logger'
import { encodeReminders, decodeReminders } from './calendar-engine/reminder-codec'
import {
  expandEventList,
  expandRecurringEvent,
  type EventInstance,
  type EventOverride,
} from './calendar-engine/rrule-engine'
import type { ImportedEvent } from './calendar-engine/ics-importer'
import type { Reminder } from '../../shared/calendar-types'

// Use CommonJS `require('electron')` rather than `import { app } from 'electron'`.
// Electron's Node entry (node_modules/electron/index.js) exports a string path
// via `module.exports =`, so ESM `import { app }` fails with
// "does not provide an export named 'app'" in non-Electron Node contexts
// (tsx tests, tool-registry static-import chain). In real Electron runtime
// `require('electron')` returns the module with `app`/`BrowserWindow`/...,
// and call-time access still works identically.
const electronModule = (() => {
  try { return createRequire(import.meta.url)('electron') as typeof import('electron') }
  catch { return {} as typeof import('electron') }
})()
const { app } = electronModule

export interface DatabaseStatement {
  run(...params: unknown[]): unknown
  get<T = unknown>(...params: unknown[]): T | undefined
  all<T = unknown>(...params: unknown[]): T[]
}

export interface DatabaseConnection {
  exec(sql: string): void
  prepare(sql: string): DatabaseStatement
  close(): void
  readonly inTransaction?: boolean
  // better-sqlite3 exposes pragma() at runtime; declared optional so mocks /
  // in-memory fallbacks that omit it stay structurally compatible.
  pragma?(source: string, options?: { simple?: boolean }): unknown
}

type BetterSqliteConstructor = new (path: string) => DatabaseConnection

export class DatabaseUnavailableError extends Error {
  readonly code = 'database_unavailable'
  readonly cause?: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'DatabaseUnavailableError'
    this.cause = cause
  }
}

// --- Exported Type Interfaces ---

export interface RSSSource {
  id: string
  name: string
  url: string
  group_name: string
  icon: string | null
  last_fetched: number | null
  fetch_interval: number
  enabled: number
  created_at: number
  platform?: string
  draft_seeded?: number
}

export interface RSSItem {
  id: string
  source_id: string
  guid: string
  title: string
  link: string
  summary: string | null
  cover_image: string | null
  author: string | null
  published_at: number | null
  fetched_at: number
  inbox_visible?: number
  read: number
  starred: number
  ai_score: number | null
  ai_tags: string | null
}

export interface RSSDraftStoreSourceSummary {
  source_id: string
  source_name: string
  source_url: string
  platform: string
  stored_count: number
  inbox_count: number
  starred_count: number
  draft_seeded: number
  last_fetched: number | null
}

export interface RSSStats {
  totalSources: number
  totalItems: number
  unreadItems: number
  platformDistribution: Record<string, number>
  categoryDistribution: Record<string, number>
}

export type RSSAnalysisAction = 'copy' | 'visual'

export type RSSAnalysisJobStatus =
  | 'queued'
  | 'paused'
  | 'running_script'
  | 'running_subagent'
  | 'success'
  | 'failed'
  | 'skipped'

export interface RSSAnalysisJob {
  id: string
  item_id: string
  action: RSSAnalysisAction
  source_url: string
  title: string
  target_dir: string
  output_dir: string
  report_path: string | null
  status: RSSAnalysisJobStatus
  progress: number
  message: string | null
  error: string | null
  meta_json: string | null
  created_at: string
  started_at: string | null
  updated_at: string
  finished_at: string | null
}

export interface CalendarSource {
  id: string
  name: string
  color: string
  type: string
  sync_url: string | null
  sync_interval: number
  enabled: number
  created_at: number
}

/**
 * Row interface as returned from `SELECT * FROM calendar_events` — `reminders`
 * is the raw TEXT column (a JSON string or null). Internal-only.
 */
interface CalendarEventRow {
  id: string
  calendar_id: string
  title: string
  description: string | null
  location: string | null
  start_time: number
  end_time: number
  all_day: number
  recurrence_rule: string | null
  reminders: string | null
  /** L4-A — IANA tz; null = local timezone. */
  start_tz: string | null
  /** L4-A — IANA tz; null = local timezone. */
  end_tz: string | null
  /** L4-B — VEVENT UID for externally-synced rows. Null for local rows. */
  ics_uid: string | null
  /** L4-B — `calendar_sources.id` that produced this row. Null for local rows. */
  source_id: string | null
  created_at: number
  updated_at: number
}

/**
 * Decoded view of a calendar event row used by repository / IPC / scheduler.
 * `reminders` is the parsed `Reminder[]` (or null when absent / malformed).
 * This is the type the rest of the codebase consumes.
 */
export interface CalendarEvent {
  id: string
  calendar_id: string
  title: string
  description: string | null
  location: string | null
  start_time: number
  end_time: number
  all_day: number
  recurrence_rule: string | null
  reminders: Reminder[] | null
  /** L4-A — IANA tz (e.g. 'Asia/Shanghai'); null = local timezone. */
  start_tz: string | null
  /** L4-A — IANA tz; null = local timezone. */
  end_tz: string | null
  /** L4-B — VEVENT UID for rows imported from external feeds; null for local rows. */
  ics_uid: string | null
  /** L4-B — `calendar_sources.id` that produced this row; null for local rows. */
  source_id: string | null
  created_at: number
  updated_at: number
}

/**
 * Re-exported expansion types from `rrule-engine.ts` so downstream
 * consumers (IPC handlers, repository, scheduler adapters) import a
 * single canonical shape instead of reaching into the engine module.
 */
export type { EventInstance, EventOverride }

/**
 * L4-B — re-exported import type so the IPC handler / repository /
 * sync scheduler can import a single canonical shape without reaching
 * into the parser module.
 */
export type { ImportedEvent }

/**
 * Raw row from `calendar_event_overrides` — patch_json is the encoded
 * JSON string. Internal only; `decodeEventOverride` returns the parsed
 * `EventOverride` shape.
 */
interface CalendarEventOverrideRow {
  id: string
  parent_event_id: string
  occurrence_start: number
  kind: 'single' | 'cancelled'
  patch_json: string | null
  created_at: number
  updated_at: number
}

function decodeEventOverride(row: CalendarEventOverrideRow): EventOverride {
  let patch: EventOverride['patch'] = null
  if (row.kind === 'single' && row.patch_json != null) {
    try {
      const parsed = JSON.parse(row.patch_json) as Record<string, unknown>
      // Only copy known fields; ignore stray keys so we don't accidentally
      // surface unknown junk.
      const p: NonNullable<EventOverride['patch']> = {}
      if (typeof parsed.title === 'string') p.title = parsed.title
      if (parsed.description === null || typeof parsed.description === 'string') {
        p.description = parsed.description as string | null
      }
      if (parsed.location === null || typeof parsed.location === 'string') {
        p.location = parsed.location as string | null
      }
      if (typeof parsed.start_time === 'number') p.start_time = parsed.start_time
      if (typeof parsed.end_time === 'number') p.end_time = parsed.end_time
      if (typeof parsed.all_day === 'number') p.all_day = parsed.all_day
      if (parsed.reminders === null || Array.isArray(parsed.reminders)) {
        p.reminders = parsed.reminders as Reminder[] | null
      }
      // L4-A — accept null (= clear) or non-empty string. Empty strings
      // are normalized to null so the decode side never surfaces ''.
      if (parsed.start_tz === null) p.start_tz = null
      else if (typeof parsed.start_tz === 'string' && parsed.start_tz.length > 0) {
        p.start_tz = parsed.start_tz
      }
      if (parsed.end_tz === null) p.end_tz = null
      else if (typeof parsed.end_tz === 'string' && parsed.end_tz.length > 0) {
        p.end_tz = parsed.end_tz
      }
      patch = p
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[database] failed to decode override patch_json for ${row.id}: ${message}; treating as empty patch`)
      patch = {}
    }
  }
  return {
    parentEventId: row.parent_event_id,
    occurrenceStart: row.occurrence_start,
    kind: row.kind,
    patch,
  }
}

/**
 * L4-B — deterministic row id for an externally-synced VEVENT.
 *
 * Same (sourceId, uid) → same id, so repeating the same fetch lands on
 * the same row. We MD5 the UID and slice 12 hex chars (48 bits); that's
 * a few orders of magnitude above the collision threshold for the
 * thousands-of-events typical for a single subscription, and gives us
 * a fixed-length token regardless of UID format (UIDs can be very long
 * — e.g. Google's `…@google.com` UIDs are 60+ chars).
 *
 * Exported as a top-level helper so the unit tests don't need to reach
 * into the DatabaseManager to verify the formula.
 */
function computeImportedEventId(sourceId: string, uid: string): string {
  const digest = createHash('md5').update(uid).digest('hex').slice(0, 12)
  return `ics-${sourceId}-${digest}`
}

export interface BrowserBookmark {
  id: string
  url: string
  title: string
  favicon: string | null
  type: string
  parent_id: string | null
  position: number
  tags: string | null
  notes: string | null
  source: string | null
  created_at: number
}

export interface BrowserHistoryEntry {
  id: string
  url: string
  title: string
  favicon: string | null
  visit_count: number
  last_visit_time: number
  transition: string | null
  session_id: string | null
  domain: string
  visited_at: number
}

export interface BrowserDownload {
  id: string
  url: string
  filename: string
  save_path: string
  total_bytes: number
  received_bytes: number
  state: string
  mime_type: string | null
  error: string | null
  end_time: number | null
  can_resume: number
  updated_at?: number
  created_at: number
}

export interface BrowserTaskRecord {
  id: string
  kind: string
  status: string
  payload_json: string
  checkpoint_json: string | null
  result_json: string | null
  progress_total: number
  progress_completed: number
  progress_failed: number
  current_label: string | null
  error: string | null
  created_at: string
  started_at: string | null
  updated_at: string
  finished_at: string | null
  revision: number
  created_by_run_id: string | null
  active_execution_binding_json: string | null
  parent_task_id: string | null
  projection_revision: number
  projection_sync_json: string | null
}

export interface BrowserPowerPreflightAuditRecord {
  id: string
  tool_name: string
  grant_id: string
  confirmation_source: string
  scope_id: string | null
  tab_id: string | null
  document_key_hash: string
  url: string | null
  object_ref: string | null
  effects_json: string
  purpose: string | null
  input_hash: string
  created_at: string
}

export type AgentChannelType =
  | 'local-debug'
  | 'generic-webhook'
  | 'feishu-bot'
  | 'feishu-app'
  | 'telegram-bot'
  | 'wechat-openclaw'

export interface AgentChannelRecord {
  id: string
  type: AgentChannelType
  name: string
  enabled: number
  config_json: string
  last_error: string | null
  last_seen_at: string | null
  created_at: string
  updated_at: string
}

export interface AgentChannelThreadRecord {
  channel_id: string
  remote_thread: string
  session_id: string
  conversation_id: string | null
  updated_at: string
}

export interface AgentChannelEventRecord {
  event_id: string
  channel_id: string
  status: string
  error: string | null
  created_at: string
  updated_at: string
}

export type ConversationSourceKind = 'local' | 'channel'

export interface ChatConversationRecord {
  id: string
  agent: string
  active_agent_id?: string | null
  handoff_generation?: number | null
  user_id?: string | null
  title: string
  parent_conversation_id?: string | null
  lineage_root_id?: string | null
  resume_title?: string | null
  source_kind: ConversationSourceKind
  source_id: string
  thread_key: string
  meta_json: string | null
  closed_at?: string | null
  closed_reason?: string | null
  close_evidence_digest?: string | null
  message_visibility_epoch?: number
  created_at: string
  updated_at: string
}

export type UpsertConversationScopeMode = 'inserted' | 'reused'

export interface UpsertConversationScopeResult {
  row: ChatConversationRecord
  mode: UpsertConversationScopeMode
}

export interface ChatMessageRecord {
  id: string
  conversation_id: string
  role: string
  content: string
  timestamp: string
  meta_json: string | null
  message_visibility_epoch?: number
}

export interface ConversationAttachmentRecord {
  attachment_id: string
  conversation_id: string
  source_message_id: string
  name: string
  path: string
  type: string
  size: number
  ext: string
  url: string | null
  mime_type: string | null
  remote_id: string | null
  channel_id: string | null
  thread_key: string | null
  created_at: string
}

let DatabaseConstructor: BetterSqliteConstructor | null = null
let DatabaseConstructorLoadError: unknown = null
const require = createRequire(import.meta.url)
const databaseLogger = createRotatingLogger('ready-database.log')

function logDatabase(message: string): void {
  try { databaseLogger.append(`[${new Date().toISOString()}] ${message}\n`) } catch { /* ignore */ }
}

function formatDatabaseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Lazy load better-sqlite3 to handle missing module gracefully
try {
  const betterSqlite3 = require('better-sqlite3') as BetterSqliteConstructor & {
    default?: BetterSqliteConstructor
  }
  DatabaseConstructor = betterSqlite3.default || betterSqlite3
  logDatabase('better-sqlite3 loaded successfully')
} catch (error) {
  DatabaseConstructorLoadError = error
  logDatabase(`better-sqlite3 load failed: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  console.warn('better-sqlite3 not available; primary database cannot open until native bindings are rebuilt')
}

export function assertBetterSqliteNativeAvailable(): void {
  if (!DatabaseConstructor) {
    throw new DatabaseUnavailableError(
      `better-sqlite3 native binding is unavailable for this runtime (ABI ${process.versions.modules || 'unknown'})`,
      DatabaseConstructorLoadError,
    )
  }

  let probeDb: DatabaseConnection | null = null
  try {
    probeDb = new DatabaseConstructor(':memory:')
    const row = probeDb.prepare('SELECT 1 AS ok').get<{ ok: number }>()
    if (row?.ok !== 1) {
      throw new Error(`unexpected sqlite smoke result: ${JSON.stringify(row)}`)
    }
  } catch (error) {
    throw new DatabaseUnavailableError(
      `better-sqlite3 loaded but failed a SQLite smoke check (ABI ${process.versions.modules || 'unknown'}): ${formatDatabaseError(error)}`,
      error,
    )
  } finally {
    try { probeDb?.close() } catch { /* ignore probe cleanup */ }
  }
}

export function assertDatabaseConnectionReady(
  db: DatabaseConnection | null,
  label = 'database',
): asserts db is DatabaseConnection {
  if (!db) {
    throw new DatabaseUnavailableError(`${label} is not available`)
  }
}

export interface PrimaryDatabaseReadyOptions {
  checkNative?: () => void
  getDatabaseInstance?: () => Pick<DatabaseManager, 'getRawDb'>
}

export function assertPrimaryDatabaseReady(options: PrimaryDatabaseReadyOptions = {}): void {
  const checkNative = options.checkNative || assertBetterSqliteNativeAvailable
  checkNative()

  const manager = options.getDatabaseInstance ? options.getDatabaseInstance() : getDatabase()
  const rawDb = manager.getRawDb()
  assertDatabaseConnectionReady(rawDb, 'primary database')

  try {
    rawDb.prepare('SELECT value FROM settings WHERE key = ?').get('__ready_db_probe__')
  } catch (error) {
    throw new DatabaseUnavailableError(
      `primary database opened but settings table probe failed: ${formatDatabaseError(error)}`,
      error,
    )
  }
}

function deriveBrowserDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

// SQLite PRAGMA tuning. Defaults (cache_size=2000 pages ~8MB, journal=DELETE,
// synchronous=FULL, mmap_size=0) cause cache miss on every query for a multi-GB
// DB. Each pragma runs in its own try/catch so a single platform-specific
// failure (e.g. WAL on a Windows network drive) does not block the others.
const PERFORMANCE_PRAGMAS: ReadonlyArray<{ name: string; value: string }> = [
  { name: 'journal_mode', value: 'WAL' },
  { name: 'synchronous', value: 'NORMAL' },
  { name: 'cache_size', value: '-65536' },     // 64 MB cache (negative = KB)
  { name: 'mmap_size', value: '2147483648' },  // 2 GB mmap window
  { name: 'temp_store', value: 'MEMORY' },
]

export function applyPerformancePragmas(db: DatabaseConnection): void {
  if (typeof db.pragma !== 'function') {
    logDatabase('pragma() unavailable on db; skipping performance tuning')
    return
  }
  for (const { name, value } of PERFORMANCE_PRAGMAS) {
    try {
      const result = db.pragma(`${name} = ${value}`)
      logDatabase(`pragma applied ${name}=${value} result=${JSON.stringify(result)}`)
    } catch (error) {
      logDatabase(`pragma failed ${name}=${value} error=${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    const userVersion = db.pragma('user_version', { simple: true })
    logDatabase(`pragma user_version=${JSON.stringify(userVersion)}`)
  } catch (error) {
    logDatabase(`pragma user_version read failed error=${error instanceof Error ? error.message : String(error)}`)
  }
}

export class DatabaseManager {
  private db: DatabaseConnection | null = null
  private dbPath: string
  private useMemoryDb: boolean

  constructor(useMemoryDb = false) {
    this.useMemoryDb = useMemoryDb

    if (this.useMemoryDb) {
      this.dbPath = ':memory:'
    } else {
      if (!DatabaseConstructor) {
        throw new DatabaseUnavailableError(
          'better-sqlite3 native binding is unavailable; cannot open primary ready.db',
          DatabaseConstructorLoadError,
        )
      }
      try {
        if (!app || typeof app.getPath !== 'function') {
          throw new Error('Electron app.getPath is unavailable')
        }
        const userDataPath = app.getPath('userData')
        this.dbPath = resolveReadyDatabasePath(userDataPath, process.env.READY_DB_PATH)
      } catch (error) {
        throw new DatabaseUnavailableError(
          `Cannot resolve Ready userData database path: ${formatDatabaseError(error)}`,
          error,
        )
      }
    }

    this.init()
  }

  private init(): void {
    try {
      if (!DatabaseConstructor) {
        logDatabase('DatabaseConstructor unavailable; database disabled')
        throw new DatabaseUnavailableError(
          'better-sqlite3 native binding is unavailable; database disabled',
          DatabaseConstructorLoadError,
        )
      }

      logDatabase(`opening database path=${this.dbPath}`)
      this.db = new DatabaseConstructor(this.dbPath)
      applyPerformancePragmas(this.db)
      this.createTables()
      logDatabase(`database initialized path=${this.dbPath}`)
    } catch (error) {
      logDatabase(`database initialization failed path=${this.dbPath} error=${error instanceof Error ? error.stack || error.message : String(error)}`)
      console.error('Database initialization failed:', error)
      this.db = null
      if (error instanceof DatabaseUnavailableError) throw error
      throw new DatabaseUnavailableError(
        `Database initialization failed for ${this.dbPath}: ${formatDatabaseError(error)}`,
        error,
      )
    }
  }

  getRawDb(): DatabaseConnection | null {
    return this.db
  }

  private createTables(): void {
    if (!this.db) return

    // Run the migration system to create/update all tables and indexes
    runMigrations(this.db)

    // Seed default calendar sources
    const defaultSources = [
      { id: 'work', name: '工作日程', color: '#5B8DEF' },
      { id: 'content', name: '内容创作', color: '#E97A2B' },
      { id: 'holiday', name: '节假日', color: '#34D399' },
      { id: 'personal', name: '个人', color: '#8B5CF6' }
    ]

    const insertSource = this.db.prepare(
      'INSERT OR IGNORE INTO calendar_sources (id, name, color) VALUES (?, ?, ?)'
    )
    for (const source of defaultSources) {
      insertSource.run(source.id, source.name, source.color)
    }
  }

  getDatabase(): DatabaseConnection | null {
    return this.db
  }

  // ===================== RSS CRUD Methods =====================

  getRSSSources(): RSSSource[] {
    if (!this.db) return []
    return this.db.prepare('SELECT * FROM rss_sources WHERE enabled = 1 ORDER BY created_at DESC').all<RSSSource>()
  }

  addRSSSource(source: { name: string; url: string; group?: string; icon?: string; platform?: string }): string {
    if (!this.db) throw new Error('Database not available')
    const id = `source-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.db.prepare(
      'INSERT INTO rss_sources (id, name, url, group_name, icon, platform) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, source.name, source.url, source.group || 'default', source.icon || null, source.platform || 'rss')
    return id
  }

  updateRSSSourcePlatform(id: string, platform: string): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('UPDATE rss_sources SET platform = ? WHERE id = ?').run(platform, id)
  }

  removeRSSSource(id: string): void {
    if (!this.db) throw new Error('Database not available')
    // Delete items first (cascade may not be enforced by all SQLite builds)
    this.db.prepare('DELETE FROM rss_items WHERE source_id = ?').run(id)
    this.db.prepare('DELETE FROM rss_sources WHERE id = ?').run(id)
  }

  getRSSItems(sourceId?: string): RSSItem[] {
    if (!this.db) return []
    if (sourceId) {
      return this.db.prepare(
        `SELECT * FROM rss_items
         WHERE source_id = ?
           AND (inbox_visible = 1 OR starred = 1)
         ORDER BY COALESCE(published_at, fetched_at) DESC`
      ).all<RSSItem>(sourceId)
    }
    return this.db.prepare(
      `SELECT * FROM rss_items
       WHERE inbox_visible = 1 OR starred = 1
       ORDER BY COALESCE(published_at, fetched_at) DESC`
    ).all<RSSItem>()
  }

  getAllRSSItems(sourceId?: string): RSSItem[] {
    if (!this.db) return []
    if (sourceId) {
      return this.db.prepare(
        `SELECT * FROM rss_items
         WHERE source_id = ?
         ORDER BY COALESCE(published_at, fetched_at) DESC`
      ).all<RSSItem>(sourceId)
    }
    return this.db.prepare(
      `SELECT * FROM rss_items
       ORDER BY COALESCE(published_at, fetched_at) DESC`
    ).all<RSSItem>()
  }

  getRSSItemsWithSource(sourceId?: string): Array<RSSItem & { source_name: string }> {
    if (!this.db) return []
    if (sourceId) {
      return this.db.prepare(
        `SELECT i.*, s.name AS source_name FROM rss_items i
         LEFT JOIN rss_sources s ON i.source_id = s.id
         WHERE i.source_id = ?
           AND (i.inbox_visible = 1 OR i.starred = 1)
         ORDER BY COALESCE(i.published_at, i.fetched_at) DESC`
      ).all<RSSItem & { source_name: string }>(sourceId)
    }
    return this.db.prepare(
      `SELECT i.*, s.name AS source_name FROM rss_items i
       LEFT JOIN rss_sources s ON i.source_id = s.id
       WHERE i.inbox_visible = 1 OR i.starred = 1
       ORDER BY COALESCE(i.published_at, i.fetched_at) DESC`
    ).all<RSSItem & { source_name: string }>()
  }

  upsertRSSItems(items: Array<{
    id: string
    source_id: string
    guid: string
    title: string
    link: string
    summary?: string | null
    cover_image?: string | null
    author?: string | null
    published_at?: number | null
  }>): number {
    if (!this.db) throw new Error('Database not available')
    let inserted = 0
    const stmt = this.db.prepare(
      `INSERT INTO rss_items
       (id, source_id, guid, title, link, summary, cover_image, author, published_at, inbox_visible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         source_id = excluded.source_id,
         guid = excluded.guid,
         title = excluded.title,
         link = excluded.link,
         summary = excluded.summary,
         cover_image = excluded.cover_image,
         author = excluded.author,
         published_at = excluded.published_at,
         fetched_at = unixepoch()`
    )
    for (const item of items) {
      const result = stmt.run(
        item.id,
        item.source_id,
        item.guid,
        item.title,
        item.link,
        item.summary || null,
        item.cover_image || null,
        item.author || null,
        item.published_at || null
      ) as { changes?: number }
      if (result.changes && result.changes > 0) inserted++
    }
    return inserted
  }

  markRSSRead(itemId: string): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('UPDATE rss_items SET read = 1 WHERE id = ?').run(itemId)
  }

  markRSSReadMany(itemIds: string[]): number {
    if (!this.db) throw new Error('Database not available')
    if (itemIds.length === 0) return 0
    const placeholders = itemIds.map(() => '?').join(', ')
    const stmt = this.db.prepare(`UPDATE rss_items SET read = 1 WHERE id IN (${placeholders})`)
    const result = stmt.run(...itemIds) as { changes?: number }
    return result.changes ?? 0
  }

  deleteRSSItems(itemIds: string[]): number {
    if (!this.db) throw new Error('Database not available')
    if (itemIds.length === 0) return 0
    const placeholders = itemIds.map(() => '?').join(', ')
    const stmt = this.db.prepare(`DELETE FROM rss_items WHERE id IN (${placeholders})`)
    const result = stmt.run(...itemIds) as { changes?: number }
    return result.changes ?? 0
  }

  dismissRSSItemsFromInbox(itemIds: string[], preserveStarred = false): number {
    if (!this.db) throw new Error('Database not available')
    if (itemIds.length === 0) return 0
    const placeholders = itemIds.map(() => '?').join(', ')
    const stmt = this.db.prepare(
      `UPDATE rss_items
       SET inbox_visible = 0
       WHERE id IN (${placeholders})
         ${preserveStarred ? 'AND starred = 0' : ''}`
    )
    const result = stmt.run(...itemIds) as { changes?: number }
    return result.changes ?? 0
  }

  deleteRSSItemsBySource(sourceId: string): number {
    if (!this.db) throw new Error('Database not available')
    const result = this.db.prepare('DELETE FROM rss_items WHERE source_id = ?').run(sourceId) as { changes?: number }
    return result.changes ?? 0
  }

  toggleRSSStarred(itemId: string): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('UPDATE rss_items SET starred = CASE WHEN starred = 0 THEN 1 ELSE 0 END WHERE id = ?').run(itemId)
  }

  updateRSSSourceLastFetched(sourceId: string): void {
    if (!this.db) return
    this.db.prepare('UPDATE rss_sources SET last_fetched = unixepoch() WHERE id = ?').run(sourceId)
  }

  setRSSSourceDraftSeeded(sourceId: string, seeded: boolean): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('UPDATE rss_sources SET draft_seeded = ? WHERE id = ?').run(seeded ? 1 : 0, sourceId)
  }

  getRSSDraftStoreSources(): RSSDraftStoreSourceSummary[] {
    if (!this.db) return []
    return this.db.prepare(
      `SELECT
         s.id AS source_id,
         s.name AS source_name,
         s.url AS source_url,
         COALESCE(s.platform, 'rss') AS platform,
         COUNT(i.id) AS stored_count,
         SUM(CASE WHEN i.inbox_visible = 1 THEN 1 ELSE 0 END) AS inbox_count,
         SUM(CASE WHEN i.starred = 1 THEN 1 ELSE 0 END) AS starred_count,
         COALESCE(s.draft_seeded, 0) AS draft_seeded,
         s.last_fetched AS last_fetched
       FROM rss_sources s
       LEFT JOIN rss_items i ON i.source_id = s.id
       WHERE s.enabled = 1
       GROUP BY s.id
       ORDER BY s.created_at DESC`
    ).all<RSSDraftStoreSourceSummary>()
  }

  clearRSSDraftStore(sourceId?: string): { deletedItems: number; resetSources: number } {
    if (!this.db) throw new Error('Database not available')

    if (sourceId) {
      const deleted = this.db.prepare('DELETE FROM rss_items WHERE source_id = ?').run(sourceId) as { changes?: number }
      const reset = this.db.prepare('UPDATE rss_sources SET draft_seeded = 0 WHERE id = ?').run(sourceId) as { changes?: number }
      return {
        deletedItems: deleted.changes ?? 0,
        resetSources: reset.changes ?? 0,
      }
    }

    const deleted = this.db.prepare('DELETE FROM rss_items').run() as { changes?: number }
    const reset = this.db.prepare('UPDATE rss_sources SET draft_seeded = 0').run() as { changes?: number }
    return {
      deletedItems: deleted.changes ?? 0,
      resetSources: reset.changes ?? 0,
    }
  }

  getRSSItemsByIds(itemIds: string[]): RSSItem[] {
    if (!this.db || itemIds.length === 0) return []
    const placeholders = itemIds.map(() => '?').join(', ')
    return this.db.prepare(`SELECT * FROM rss_items WHERE id IN (${placeholders})`).all<RSSItem>(...itemIds)
  }

  getLatestPerSource(): RSSItem[] {
    if (!this.db) return []
    return this.db.prepare(
      `SELECT i.* FROM rss_items i
       INNER JOIN (
         SELECT source_id, MAX(COALESCE(published_at, fetched_at)) AS latest
         FROM rss_items
         GROUP BY source_id
       ) latest_per_source
       ON latest_per_source.source_id = i.source_id
       AND COALESCE(i.published_at, i.fetched_at) = latest_per_source.latest
       ORDER BY i.published_at DESC`
    ).all<RSSItem>()
  }

  getRSSStats(): RSSStats {
    if (!this.db) {
      return {
        totalSources: 0,
        totalItems: 0,
        unreadItems: 0,
        platformDistribution: {},
        categoryDistribution: {},
      }
    }

    const totals = this.db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM rss_sources WHERE enabled = 1) AS totalSources,
         (SELECT COUNT(*) FROM rss_items) AS totalItems,
         (SELECT COUNT(*) FROM rss_items WHERE read = 0) AS unreadItems`
    ).get<{ totalSources: number; totalItems: number; unreadItems: number }>()

    const platforms = this.db.prepare(
      `SELECT COALESCE(platform, 'rss') AS platform, COUNT(*) AS count
       FROM rss_sources
       WHERE enabled = 1
       GROUP BY platform`
    ).all<{ platform: string; count: number }>()

    const categories = this.db.prepare(
      `SELECT COALESCE(ai_tags, '其他') AS category, COUNT(*) AS count
       FROM rss_items
       GROUP BY COALESCE(ai_tags, '其他')`
    ).all<{ category: string; count: number }>()

    const platformDistribution: Record<string, number> = {}
    for (const row of platforms) {
      platformDistribution[row.platform] = row.count
    }

    const categoryDistribution: Record<string, number> = {}
    for (const row of categories) {
      categoryDistribution[row.category] = row.count
    }

    return {
      totalSources: totals?.totalSources ?? 0,
      totalItems: totals?.totalItems ?? 0,
      unreadItems: totals?.unreadItems ?? 0,
      platformDistribution,
      categoryDistribution,
    }
  }

  createRSSAnalysisJob(payload: {
    id: string
    itemId: string
    action: RSSAnalysisAction
    sourceUrl: string
    title: string
    targetDir: string
    outputDir: string
    status: RSSAnalysisJobStatus
    progress: number
    message?: string | null
    error?: string | null
    reportPath?: string | null
    metaJson?: string | null
    startedAt?: string | null
    finishedAt?: string | null
  }): RSSAnalysisJob {
    if (!this.db) throw new Error('Database not available')
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO rss_analysis_jobs
       (id, item_id, action, source_url, title, target_dir, output_dir, report_path, status, progress, message, error, meta_json, created_at, started_at, updated_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      payload.id,
      payload.itemId,
      payload.action,
      payload.sourceUrl,
      payload.title,
      payload.targetDir,
      payload.outputDir,
      payload.reportPath ?? null,
      payload.status,
      payload.progress,
      payload.message ?? null,
      payload.error ?? null,
      payload.metaJson ?? null,
      now,
      payload.startedAt ?? null,
      now,
      payload.finishedAt ?? null,
    )
    return this.getRSSAnalysisJob(payload.id)!
  }

  getRSSAnalysisJob(jobId: string): RSSAnalysisJob | null {
    if (!this.db) return null
    const row = this.db.prepare('SELECT * FROM rss_analysis_jobs WHERE id = ? LIMIT 1').get<RSSAnalysisJob>(jobId)
    return row ?? null
  }

  updateRSSAnalysisJob(
    jobId: string,
    patch: Partial<{
      status: RSSAnalysisJobStatus
      progress: number
      message: string | null
      error: string | null
      reportPath: string | null
      metaJson: string | null
      startedAt: string | null
      finishedAt: string | null
      outputDir: string
    }>,
  ): RSSAnalysisJob | null {
    if (!this.db) throw new Error('Database not available')
    const setClauses: string[] = []
    const values: unknown[] = []

    if (patch.status !== undefined) {
      setClauses.push('status = ?')
      values.push(patch.status)
    }
    if (patch.progress !== undefined) {
      setClauses.push('progress = ?')
      values.push(Math.max(0, Math.min(100, Math.round(patch.progress))))
    }
    if (patch.message !== undefined) {
      setClauses.push('message = ?')
      values.push(patch.message)
    }
    if (patch.error !== undefined) {
      setClauses.push('error = ?')
      values.push(patch.error)
    }
    if (patch.reportPath !== undefined) {
      setClauses.push('report_path = ?')
      values.push(patch.reportPath)
    }
    if (patch.metaJson !== undefined) {
      setClauses.push('meta_json = ?')
      values.push(patch.metaJson)
    }
    if (patch.startedAt !== undefined) {
      setClauses.push('started_at = ?')
      values.push(patch.startedAt)
    }
    if (patch.finishedAt !== undefined) {
      setClauses.push('finished_at = ?')
      values.push(patch.finishedAt)
    }
    if (patch.outputDir !== undefined) {
      setClauses.push('output_dir = ?')
      values.push(patch.outputDir)
    }
    if (setClauses.length === 0) {
      return this.getRSSAnalysisJob(jobId)
    }

    setClauses.push('updated_at = ?')
    values.push(new Date().toISOString())
    values.push(jobId)

    this.db.prepare(`UPDATE rss_analysis_jobs SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
    return this.getRSSAnalysisJob(jobId)
  }

  listRSSAnalysisJobs(itemId?: string, limit = 50): RSSAnalysisJob[] {
    if (!this.db) return []
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
    if (itemId) {
      return this.db.prepare(
        'SELECT * FROM rss_analysis_jobs WHERE item_id = ? ORDER BY updated_at DESC LIMIT ?'
      ).all<RSSAnalysisJob>(itemId, safeLimit)
    }
    return this.db.prepare(
      'SELECT * FROM rss_analysis_jobs ORDER BY updated_at DESC LIMIT ?'
    ).all<RSSAnalysisJob>(safeLimit)
  }

  deleteRSSAnalysisJob(jobId: string): boolean {
    if (!this.db) return false
    const result = this.db.prepare('DELETE FROM rss_analysis_jobs WHERE id = ?').run(jobId) as {
      changes?: number
    }
    return (result.changes ?? 0) > 0
  }

  findActiveRSSAnalysisJob(itemId: string, action: RSSAnalysisAction): RSSAnalysisJob | null {
    if (!this.db) return null
    const row = this.db.prepare(
      `SELECT * FROM rss_analysis_jobs
       WHERE item_id = ? AND action = ? AND status IN ('queued', 'running_script', 'running_subagent')
       ORDER BY updated_at DESC LIMIT 1`
    ).get<RSSAnalysisJob>(itemId, action)
    return row ?? null
  }

  getLatestRSSAnalysisByItemIds(itemIds: string[]): Record<string, RSSAnalysisJob> {
    if (!this.db || itemIds.length === 0) return {}
    const placeholders = itemIds.map(() => '?').join(', ')
    const rows = this.db.prepare(
      `SELECT * FROM rss_analysis_jobs
       WHERE item_id IN (${placeholders})
       ORDER BY item_id ASC, updated_at DESC`
    ).all<RSSAnalysisJob>(...itemIds)
    const result: Record<string, RSSAnalysisJob> = {}
    for (const row of rows) {
      if (!result[row.item_id]) {
        result[row.item_id] = row
      }
    }
    return result
  }

  markInterruptedRSSAnalysisJobs(): number {
    if (!this.db) return 0
    const now = new Date().toISOString()
    const result = this.db.prepare(
      `UPDATE rss_analysis_jobs
       SET status = 'failed',
           progress = CASE WHEN progress > 0 THEN progress ELSE 5 END,
           error = COALESCE(error, '任务因应用重启而中断'),
           message = COALESCE(message, '任务中断'),
           finished_at = COALESCE(finished_at, ?),
           updated_at = ?
       WHERE status IN ('queued', 'running_script', 'running_subagent')`
    ).run(now, now) as { changes?: number }
    return result.changes ?? 0
  }

  cleanupRSSAnalysisJobs(retentionDays: number, maxRows: number): number {
    if (!this.db) return 0
    const days = Math.max(1, Math.min(365, Math.floor(retentionDays)))
    const rowsLimit = Math.max(0, Math.floor(maxRows))
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    let deleted = 0
    const byAge = this.db.prepare('DELETE FROM rss_analysis_jobs WHERE updated_at < ?').run(cutoff) as {
      changes?: number
    }
    deleted += byAge.changes ?? 0

    if (rowsLimit > 0) {
      const overflowRows = this.db.prepare(
        `SELECT id FROM rss_analysis_jobs
         ORDER BY updated_at DESC
         LIMIT -1 OFFSET ?`
      ).all<{ id: string }>(rowsLimit)
      if (overflowRows.length > 0) {
        const ids = overflowRows.map((row) => row.id)
        const placeholders = ids.map(() => '?').join(', ')
        const byCount = this.db.prepare(
          `DELETE FROM rss_analysis_jobs WHERE id IN (${placeholders})`
        ).run(...ids) as { changes?: number }
        deleted += byCount.changes ?? 0
      }
    }

    return deleted
  }

  // ===================== Calendar CRUD Methods =====================

  getCalendarSources(): CalendarSource[] {
    if (!this.db) return []
    return this.db.prepare('SELECT * FROM calendar_sources WHERE enabled = 1 ORDER BY created_at').all<CalendarSource>()
  }

  addCalendarSource(source: { name: string; color: string }): string {
    if (!this.db) throw new Error('Database not available')
    const id = `cal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.db.prepare(
      'INSERT INTO calendar_sources (id, name, color) VALUES (?, ?, ?)'
    ).run(id, source.name, source.color)
    return id
  }

  getCalendarEvents(startTime: number, endTime: number): CalendarEvent[] {
    if (!this.db) return []
    // Events that overlap with the query range:
    // event.start_time < endTime AND event.end_time > startTime
    //
    // Note: this method is intentionally LEFT AS-IS for recurring events —
    // it returns the parent row (recurrence_rule IS NOT NULL) only if the
    // parent's own start_time/end_time happens to fall inside [startTime,
    // endTime]. For window-based recurring expansion the IPC handler calls
    // `getRecurringEventsAndOverrides` + the rrule engine. Tools / sync
    // jobs that read raw parent rows still use this method.
    const rows = this.db.prepare(
      `SELECT * FROM calendar_events
       WHERE start_time < ? AND end_time > ?
       ORDER BY start_time`
    ).all<CalendarEventRow>(endTime, startTime)
    return rows.map((row) => ({
      ...row,
      reminders: decodeReminders(row.reminders, { eventId: row.id }),
    }))
  }

  /**
   * Return non-recurring events that overlap [startTime, endTime] only.
   * Used by the IPC layer to split the read into (non-recurring overlap
   * SQL) + (recurring expansion via rrule). Recurring parents are excluded
   * here so the IPC layer doesn't accidentally double-yield them — they
   * come from `getRecurringEventsAndOverrides` instead.
   */
  getNonRecurringEventsInWindow(startTime: number, endTime: number): CalendarEvent[] {
    if (!this.db) return []
    const rows = this.db.prepare(
      `SELECT * FROM calendar_events
       WHERE recurrence_rule IS NULL
         AND start_time < ? AND end_time > ?
       ORDER BY start_time`,
    ).all<CalendarEventRow>(endTime, startTime)
    return rows.map((row) => ({
      ...row,
      reminders: decodeReminders(row.reminders, { eventId: row.id }),
    }))
  }

  /**
   * Fetch all recurring events (recurrence_rule IS NOT NULL) plus the
   * full override list for them. Recurring parents are NOT window-filtered
   * — a weekly event whose `start_time` is in 2024 must still expand into
   * a 2026 window. The rrule engine handles the window filter via
   * RRULE.between(). Overrides are grouped by parent event id.
   *
   * `windowStartUnix` / `windowEndUnix` are accepted for symmetry with the
   * engine signature but the SQL query intentionally does NOT use them on
   * the parent rows. Override rows ARE window-filtered (only overrides
   * whose `occurrence_start` falls in the window matter for this query).
   */
  getRecurringEventsAndOverrides(
    windowStartUnix: number,
    windowEndUnix: number,
  ): { events: CalendarEvent[]; overridesByParent: Map<string, EventOverride[]> } {
    if (!this.db) return { events: [], overridesByParent: new Map() }

    const eventRows = this.db.prepare(
      `SELECT * FROM calendar_events
       WHERE recurrence_rule IS NOT NULL
       ORDER BY start_time`,
    ).all<CalendarEventRow>()
    const events: CalendarEvent[] = eventRows.map((row) => ({
      ...row,
      reminders: decodeReminders(row.reminders, { eventId: row.id }),
    }))

    if (events.length === 0) {
      return { events: [], overridesByParent: new Map() }
    }

    // Pull all overrides for those parents within the window. We widen the
    // window slightly: an override may move an occurrence's start_time
    // OUTSIDE the original window. Since we match overrides against the
    // ORIGINAL occurrence_start (not the patched start_time) we just use
    // the window directly; the engine then yields the patched fields.
    const placeholders = events.map(() => '?').join(',')
    const overrideRows = this.db.prepare(
      `SELECT * FROM calendar_event_overrides
       WHERE parent_event_id IN (${placeholders})
         AND occurrence_start BETWEEN ? AND ?`,
    ).all<CalendarEventOverrideRow>(
      ...events.map((e) => e.id),
      windowStartUnix,
      windowEndUnix,
    )

    const overridesByParent = new Map<string, EventOverride[]>()
    for (const row of overrideRows) {
      const decoded = decodeEventOverride(row)
      const list = overridesByParent.get(decoded.parentEventId) ?? []
      list.push(decoded)
      overridesByParent.set(decoded.parentEventId, list)
    }
    return { events, overridesByParent }
  }

  /**
   * Reminder scheduler entry point — returns expanded `EventInstance[]`
   * for events that have at least one reminder, INCLUDING recurring
   * instances. Each EventInstance carries its own `reminders` (the parent
   * row's reminders, possibly patched by an override), and its `id` is
   * the syntheticId so the scheduler dedupes timers per-instance.
   *
   * `windowStartSeconds` and `windowEndSeconds` are Unix seconds. Pass
   * the **start_time** bounds you want to consider — callers should
   * widen this against the largest plausible offset.
   *
   * Why expanded instances instead of parents: a daily-recurring event
   * with reminders fires reminders on every occurrence, not just the
   * first. The scheduler is intentionally instance-aware so the timer
   * map can cancel one instance independently. Using syntheticId as
   * `id` means scheduler.onEventChanged(parentId) won't accidentally
   * dedupe two different instances of the same parent.
   */
  getCalendarEventsWithReminders(
    windowStartSeconds: number,
    windowEndSeconds: number,
  ): EventInstance[] {
    if (!this.db) return []

    // Non-recurring path: events with reminders AND start_time in window.
    const nonRecurringRows = this.db.prepare(
      `SELECT * FROM calendar_events
       WHERE reminders IS NOT NULL
         AND recurrence_rule IS NULL
         AND start_time BETWEEN ? AND ?
       ORDER BY start_time`,
    ).all<CalendarEventRow>(windowStartSeconds, windowEndSeconds)
    const nonRecurring: CalendarEvent[] = nonRecurringRows.map((row) => ({
      ...row,
      reminders: decodeReminders(row.reminders, { eventId: row.id }),
    }))

    // Recurring path: events with reminders AND recurrence_rule, expand.
    const recurringRows = this.db.prepare(
      `SELECT * FROM calendar_events
       WHERE reminders IS NOT NULL
         AND recurrence_rule IS NOT NULL
       ORDER BY start_time`,
    ).all<CalendarEventRow>()
    const recurringEvents: CalendarEvent[] = recurringRows.map((row) => ({
      ...row,
      reminders: decodeReminders(row.reminders, { eventId: row.id }),
    }))

    // Pull overrides for the recurring parents that lie inside the window.
    let overridesByParent = new Map<string, EventOverride[]>()
    if (recurringEvents.length > 0) {
      const placeholders = recurringEvents.map(() => '?').join(',')
      const overrideRows = this.db.prepare(
        `SELECT * FROM calendar_event_overrides
         WHERE parent_event_id IN (${placeholders})
           AND occurrence_start BETWEEN ? AND ?`,
      ).all<CalendarEventOverrideRow>(
        ...recurringEvents.map((e) => e.id),
        windowStartSeconds,
        windowEndSeconds,
      )
      for (const row of overrideRows) {
        const decoded = decodeEventOverride(row)
        const list = overridesByParent.get(decoded.parentEventId) ?? []
        list.push(decoded)
        overridesByParent.set(decoded.parentEventId, list)
      }
    }

    // Build EventInstances for both pools and concat. Non-recurring rows
    // produce a single instance whose syntheticId == row.id; recurring
    // rows expand.
    const instances: EventInstance[] = []
    for (const ev of nonRecurring) {
      const inst = expandRecurringEvent(ev, windowStartSeconds, windowEndSeconds, [])
      for (const i of inst) instances.push(i)
    }
    const recurringInstances = expandEventList(
      recurringEvents,
      windowStartSeconds,
      windowEndSeconds,
      overridesByParent,
    )
    for (const i of recurringInstances) instances.push(i)

    instances.sort((a, b) => a.start_time - b.start_time)
    return instances
  }

  createCalendarEvent(event: {
    calendar_id: string
    title: string
    description?: string | null
    location?: string | null
    start_time: number
    end_time: number
    all_day?: number
    color?: string | null
    recurrence_rule?: string | null
    reminders?: Reminder[] | null
    /** L4-A — IANA tz id or null (= local). Empty string is normalized to null. */
    start_tz?: string | null
    /** L4-A — IANA tz id or null (= local). Empty string is normalized to null. */
    end_tz?: string | null
  }): string {
    if (!this.db) throw new Error('Database not available')
    const id = `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Empty string → null so the gate (recurrence_rule IS NOT NULL) is
    // honest. UI / IPC may send '' instead of null when clearing.
    const normalizedRule =
      event.recurrence_rule != null && event.recurrence_rule.trim().length > 0
        ? event.recurrence_rule
        : null
    // L4-A — same normalization for tz columns: empty string is treated
    // as "no explicit zone" (= local) so we don't accidentally persist a
    // sentinel that the validator would later reject.
    const normalizedStartTz =
      event.start_tz != null && event.start_tz.trim().length > 0
        ? event.start_tz
        : null
    const normalizedEndTz =
      event.end_tz != null && event.end_tz.trim().length > 0
        ? event.end_tz
        : null
    this.db.prepare(
      `INSERT INTO calendar_events
       (id, calendar_id, title, description, location, start_time, end_time, all_day, recurrence_rule, reminders, start_tz, end_tz)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      event.calendar_id,
      event.title,
      event.description || null,
      event.location || null,
      event.start_time,
      event.end_time,
      event.all_day || 0,
      normalizedRule,
      encodeReminders(event.reminders ?? null),
      normalizedStartTz,
      normalizedEndTz,
    )
    return id
  }

  updateCalendarEvent(id: string, updates: Partial<{
    title: string
    description: string | null
    location: string | null
    start_time: number
    end_time: number
    all_day: number
    calendar_id: string
    recurrence_rule: string | null
    reminders: Reminder[] | null
    /** L4-A — IANA tz id or null (= local). Empty string → null. */
    start_tz: string | null
    /** L4-A — IANA tz id or null (= local). Empty string → null. */
    end_tz: string | null
  }>): void {
    if (!this.db) throw new Error('Database not available')

    const setClauses: string[] = []
    const values: unknown[] = []

    if (updates.title !== undefined) { setClauses.push('title = ?'); values.push(updates.title) }
    if (updates.description !== undefined) { setClauses.push('description = ?'); values.push(updates.description) }
    if (updates.location !== undefined) { setClauses.push('location = ?'); values.push(updates.location) }
    if (updates.start_time !== undefined) { setClauses.push('start_time = ?'); values.push(updates.start_time) }
    if (updates.end_time !== undefined) { setClauses.push('end_time = ?'); values.push(updates.end_time) }
    if (updates.all_day !== undefined) { setClauses.push('all_day = ?'); values.push(updates.all_day) }
    if (updates.calendar_id !== undefined) { setClauses.push('calendar_id = ?'); values.push(updates.calendar_id) }
    if (updates.recurrence_rule !== undefined) {
      setClauses.push('recurrence_rule = ?')
      // Empty string → null (clear); string with content → store raw.
      const v = updates.recurrence_rule
      values.push(v != null && v.trim().length > 0 ? v : null)
    }
    if (updates.reminders !== undefined) {
      setClauses.push('reminders = ?')
      values.push(encodeReminders(updates.reminders))
    }
    if (updates.start_tz !== undefined) {
      setClauses.push('start_tz = ?')
      // Empty string → null so the back-compat "null = local timezone"
      // semantic stays the canonical clear value.
      const v = updates.start_tz
      values.push(v != null && v.trim().length > 0 ? v : null)
    }
    if (updates.end_tz !== undefined) {
      setClauses.push('end_tz = ?')
      const v = updates.end_tz
      values.push(v != null && v.trim().length > 0 ? v : null)
    }

    if (setClauses.length === 0) return

    setClauses.push('updated_at = unixepoch()')
    values.push(id)

    this.db.prepare(
      `UPDATE calendar_events SET ${setClauses.join(', ')} WHERE id = ?`
    ).run(...values)
  }

  deleteCalendarEvent(id: string): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id)
  }

  /**
   * L3-B — fetch a single event row by id. Used by the
   * `splitRecurringSeries` IPC handler to read the parent's existing
   * recurrence_rule / fields before truncating it; also useful for
   * idempotency checks. Returns null when the event is missing — the
   * caller decides whether that's an error.
   */
  getCalendarEventById(id: string): CalendarEvent | null {
    if (!this.db) return null
    const row = this.db.prepare(
      `SELECT * FROM calendar_events WHERE id = ?`,
    ).get<CalendarEventRow>(id)
    if (!row) return null
    return {
      ...row,
      reminders: decodeReminders(row.reminders, { eventId: row.id }),
    }
  }

  /**
   * L3-B — upsert a per-occurrence override row.
   *
   * The `(parent_event_id, occurrence_start)` UNIQUE index is the conflict
   * key — re-upserting the same occurrence flips the row's kind / patch
   * fields and bumps `updated_at`, keeping the original `id` and
   * `created_at` stable so consumers tracking override ids can resolve
   * a stable handle across edits.
   *
   * `patch` is JSON-encoded; pass `null` when `kind === 'cancelled'`
   * (the IPC layer enforces this contract — patch is silently nulled
   * server-side when the kind is `cancelled` to match the migration
   * 038 schema discipline). `patch` for `kind === 'single'` may use
   * either snake_case (DB-shape) or be partial — only the documented
   * fields survive `decodeEventOverride` on the read side.
   *
   * Returns the row id so the IPC handler can echo it back to the
   * renderer; the renderer doesn't use the id today but knowing the
   * row was written is useful for log lines / future "undo" surfaces.
   */
  upsertEventOverride(override: {
    parentEventId: string
    occurrenceStart: number
    kind: 'single' | 'cancelled'
    patch: EventOverride['patch']
  }): { id: string } {
    if (!this.db) throw new Error('Database not available')
    const id = `ovr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Cancelled rows always have null patch_json — this matches the
    // CHECK-constraint-free but documented schema discipline in the
    // 038 migration. If a caller hands us patch on a cancelled kind we
    // drop it on the floor here rather than smuggle it into JSON.
    const encodedPatch =
      override.kind === 'cancelled' || override.patch == null
        ? null
        : JSON.stringify(override.patch)
    this.db.prepare(
      `INSERT INTO calendar_event_overrides
         (id, parent_event_id, occurrence_start, kind, patch_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (parent_event_id, occurrence_start) DO UPDATE SET
         kind = excluded.kind,
         patch_json = excluded.patch_json,
         updated_at = unixepoch()`,
    ).run(
      id,
      override.parentEventId,
      override.occurrenceStart,
      override.kind,
      encodedPatch,
    )
    // The runtime id might be either the freshly inserted id or the
    // existing row's id (when ON CONFLICT updated). Look it up to be
    // honest about which one this call landed on.
    const row = this.db.prepare(
      `SELECT id FROM calendar_event_overrides
       WHERE parent_event_id = ? AND occurrence_start = ?`,
    ).get<{ id: string }>(override.parentEventId, override.occurrenceStart)
    return { id: row?.id ?? id }
  }

  /**
   * L3-B — delete a per-occurrence override row. Returns
   * `{ deleted: false }` when the row didn't exist (idempotent semantic
   * so the IPC layer doesn't error on "remove override that never
   * existed" — equivalent to "the event already follows the parent's
   * default behavior").
   */
  deleteEventOverride(parentEventId: string, occurrenceStart: number): { deleted: boolean } {
    if (!this.db) throw new Error('Database not available')
    const result = this.db.prepare(
      `DELETE FROM calendar_event_overrides
       WHERE parent_event_id = ? AND occurrence_start = ?`,
    ).run(parentEventId, occurrenceStart)
    // better-sqlite3 RunResult.changes is a number; treat any non-zero as deleted.
    const changes =
      typeof (result as { changes?: number })?.changes === 'number'
        ? (result as { changes?: number }).changes ?? 0
        : 0
    return { deleted: changes > 0 }
  }

  // ===================== Calendar External Sync (L4-B) =====================

  /**
   * L4-B — upsert one externally-synced event row for a given source.
   *
   * Identity model: the row id is derived deterministically from
   * `(sourceId, uid)` so re-running the same fetch always lands on the
   * same row. We MD5 the UID and slice the first 12 hex chars; that's
   * 48 bits which is well above the collision threshold for the at-
   * most-thousands of events a single ICS subscription carries.
   *
   * Sentinel id form: `ics-<sourceId>-<md5(uid).slice(0,12)>`. The
   * `ics-` prefix flags the row as externally-synced for any future
   * dashboard that wants to count "subscriptions vs local events".
   *
   * Behavior contract:
   *   - INSERT when no row with that id exists → `action: 'created'`.
   *   - ON CONFLICT(id) DO UPDATE when row exists → `action: 'updated'`
   *     (every mutable field — title, time, location, rrule, reminders,
   *     tz — is overwritten with the latest fetch).
   *   - `calendar_id` is set to `sourceId` so the event appears in the
   *     subscription's own bucket. The user can rebucket via UI later;
   *     a re-sync will NOT clobber a moved row's `calendar_id` because
   *     we only update `calendar_id` on INSERT path — but the conflict
   *     branch keeps the existing `calendar_id` intact. (Note: today's
   *     impl OVERWRITES `calendar_id` on update. Future enhancement
   *     can split create-time / update-time field sets if user demand
   *     for "move externally-synced event to local calendar" appears.)
   *   - `reminders` is always written as null on import — the upstream
   *     feed doesn't carry a runtime "remind me 15m before" semantic
   *     in a portable way (X-properties vary), and silently inheriting
   *     stale reminders would be confusing.
   */
  upsertImportedEvent(
    sourceId: string,
    ev: ImportedEvent,
  ): { id: string; action: 'created' | 'updated' } {
    if (!this.db) throw new Error('Database not available')
    if (typeof sourceId !== 'string' || sourceId.length === 0) {
      throw new Error('upsertImportedEvent: sourceId is required')
    }
    if (typeof ev.uid !== 'string' || ev.uid.length === 0) {
      throw new Error('upsertImportedEvent: ImportedEvent.uid is required')
    }

    const id = computeImportedEventId(sourceId, ev.uid)

    const existing = this.db.prepare(
      `SELECT id FROM calendar_events WHERE id = ?`,
    ).get<{ id: string }>(id)

    // L4-B — normalize tz / rrule the same way createCalendarEvent does
    // so the "empty string never lands in DB" rule is preserved.
    const normalizedRule =
      ev.recurrenceRule != null && ev.recurrenceRule.trim().length > 0
        ? ev.recurrenceRule
        : null
    const normalizedStartTz =
      ev.startTz != null && ev.startTz.trim().length > 0 ? ev.startTz : null
    const normalizedEndTz =
      ev.endTz != null && ev.endTz.trim().length > 0 ? ev.endTz : null

    if (!existing) {
      this.db.prepare(
        `INSERT INTO calendar_events
         (id, calendar_id, title, description, location, start_time, end_time,
          all_day, recurrence_rule, reminders, start_tz, end_tz, ics_uid, source_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        sourceId,
        ev.title,
        ev.description ?? null,
        ev.location ?? null,
        ev.startTime,
        ev.endTime,
        ev.allDay ? 1 : 0,
        normalizedRule,
        null,
        normalizedStartTz,
        normalizedEndTz,
        ev.uid,
        sourceId,
      )
      return { id, action: 'created' }
    }

    this.db.prepare(
      `UPDATE calendar_events SET
         title = ?,
         description = ?,
         location = ?,
         start_time = ?,
         end_time = ?,
         all_day = ?,
         recurrence_rule = ?,
         start_tz = ?,
         end_tz = ?,
         ics_uid = ?,
         source_id = ?,
         updated_at = unixepoch()
       WHERE id = ?`,
    ).run(
      ev.title,
      ev.description ?? null,
      ev.location ?? null,
      ev.startTime,
      ev.endTime,
      ev.allDay ? 1 : 0,
      normalizedRule,
      normalizedStartTz,
      normalizedEndTz,
      ev.uid,
      sourceId,
      id,
    )
    return { id, action: 'updated' }
  }

  /**
   * L4-B — delete one externally-synced row by `(sourceId, uid)`. Used
   * by the sync diff to drop events the upstream feed has removed.
   * Idempotent: missing rows resolve as "no-op".
   */
  deleteImportedEvent(sourceId: string, uid: string): void {
    if (!this.db) throw new Error('Database not available')
    if (typeof sourceId !== 'string' || sourceId.length === 0) return
    if (typeof uid !== 'string' || uid.length === 0) return
    this.db.prepare(
      `DELETE FROM calendar_events WHERE source_id = ? AND ics_uid = ?`,
    ).run(sourceId, uid)
  }

  /**
   * L4-B — list every externally-synced row owned by a given source.
   * Returns `(uid, id)` tuples so the scheduler can diff against the
   * latest fetch without paying for the full row decode.
   */
  listImportedEventsForSource(sourceId: string): Array<{ uid: string; id: string }> {
    if (!this.db) return []
    const rows = this.db.prepare(
      `SELECT id, ics_uid FROM calendar_events
       WHERE source_id = ? AND ics_uid IS NOT NULL`,
    ).all<{ id: string; ics_uid: string }>(sourceId)
    return rows.map((r) => ({ uid: r.ics_uid, id: r.id }))
  }

  /**
   * L4-B — create or update a `calendar_sources` row. Returns whether
   * the row was inserted fresh or had its name / color / sync_url /
   * sync_interval updated. Used by the ICS-subscribe IPC handler so a
   * single call can register a feed.
   *
   * Caller picks the id. If you want one auto-generated, pass `id:
   * \`sub-<Date.now()>-<random>\`` from the IPC layer — the DB does NOT
   * mint ids here so the IPC layer is free to use stable IDs (e.g. for
   * "import a second time, same source name" scenarios where the user
   * actually wants two rows).
   *
   * Empty / undefined `syncUrl` is normalized to null (= local-only
   * source). `syncInterval` defaults to 60 minutes for new rows and is
   * left unchanged for existing rows when omitted.
   */
  upsertCalendarSource(source: {
    id: string
    name: string
    color?: string
    type?: string
    syncUrl?: string | null
    syncInterval?: number
    enabled?: boolean
  }): { id: string; action: 'created' | 'updated' } {
    if (!this.db) throw new Error('Database not available')
    if (typeof source.id !== 'string' || source.id.length === 0) {
      throw new Error('upsertCalendarSource: id is required')
    }
    if (typeof source.name !== 'string' || source.name.length === 0) {
      throw new Error('upsertCalendarSource: name is required')
    }

    const existing = this.db.prepare(
      `SELECT id FROM calendar_sources WHERE id = ?`,
    ).get<{ id: string }>(source.id)

    const color = source.color ?? '#5B8DEF'
    const type = source.type ?? (source.syncUrl ? 'external' : 'local')
    const syncUrl =
      source.syncUrl != null && source.syncUrl.trim().length > 0 ? source.syncUrl : null
    const syncInterval =
      typeof source.syncInterval === 'number' && Number.isFinite(source.syncInterval)
        ? Math.max(1, Math.floor(source.syncInterval))
        : 60
    const enabled = source.enabled === false ? 0 : 1

    if (!existing) {
      this.db.prepare(
        `INSERT INTO calendar_sources
         (id, name, color, type, sync_url, sync_interval, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(source.id, source.name, color, type, syncUrl, syncInterval, enabled)
      return { id: source.id, action: 'created' }
    }

    this.db.prepare(
      `UPDATE calendar_sources SET
         name = ?, color = ?, type = ?,
         sync_url = ?, sync_interval = ?, enabled = ?
       WHERE id = ?`,
    ).run(source.name, color, type, syncUrl, syncInterval, enabled, source.id)
    return { id: source.id, action: 'updated' }
  }

  /**
   * L4-B — read one calendar_sources row by id; returns null when
   * missing. Used by the unsubscribe IPC handler to confirm the row
   * exists before issuing the cascade DELETE.
   */
  getCalendarSourceById(id: string): CalendarSource | null {
    if (!this.db) return null
    return this.db.prepare(
      'SELECT * FROM calendar_sources WHERE id = ?',
    ).get<CalendarSource>(id) ?? null
  }

  /**
   * L4-B — delete one calendar_sources row. The FK on `calendar_events.
   * calendar_id` is declared `ON DELETE CASCADE` (migration 002), so
   * all rows whose `calendar_id` equals this id are dropped atomically.
   * Note: ICS-synced rows store the source id in `source_id` AND
   * `calendar_id` (see `upsertImportedEvent`), so the CASCADE handles
   * them without a separate sweep.
   */
  deleteCalendarSource(id: string): { deleted: boolean } {
    if (!this.db) throw new Error('Database not available')
    const result = this.db.prepare(
      'DELETE FROM calendar_sources WHERE id = ?',
    ).run(id)
    const changes =
      typeof (result as { changes?: number })?.changes === 'number'
        ? (result as { changes?: number }).changes ?? 0
        : 0
    return { deleted: changes > 0 }
  }

  // ===================== Browser Bookmarks =====================

  addBookmark(
    url: string,
    title: string,
    favicon?: string,
    metadata?: {
      type?: string
      parentId?: string | null
      position?: number
      tags?: string[] | string | null
      notes?: string | null
      source?: string | null
    },
  ): string {
    if (!this.db) throw new Error('Database not available')
    const id = `bm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const normalizedTags = Array.isArray(metadata?.tags)
      ? JSON.stringify(metadata?.tags)
      : metadata?.tags ?? null
    this.db.prepare(
      `INSERT INTO browser_bookmarks (
        id, url, title, favicon, type, parent_id, position, tags, notes, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      url,
      title,
      favicon || null,
      metadata?.type || 'url',
      metadata?.parentId ?? null,
      Number(metadata?.position || 0),
      normalizedTags,
      metadata?.notes ?? null,
      metadata?.source ?? 'manual',
    )
    return id
  }

  removeBookmark(id: string): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('DELETE FROM browser_bookmarks WHERE id = ?').run(id)
  }

  removeBookmarkByUrl(url: string): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('DELETE FROM browser_bookmarks WHERE url = ?').run(url)
  }

  getBookmarks(): BrowserBookmark[] {
    if (!this.db) return []
    return this.db
      .prepare('SELECT * FROM browser_bookmarks ORDER BY position ASC, created_at DESC')
      .all<BrowserBookmark>()
  }

  isBookmarked(url: string): boolean {
    if (!this.db) return false
    const row = this.db.prepare('SELECT id FROM browser_bookmarks WHERE url = ? LIMIT 1').get<{ id: string }>(url)
    return !!row
  }

  // ===================== Browser History =====================

  addHistoryEntry(
    url: string,
    title: string,
    metadata?: {
      favicon?: string | null
      transition?: string | null
      sessionId?: string | null
    },
  ): string {
    if (!this.db) throw new Error('Database not available')
    const id = `hist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const visitedAt = Math.floor(Date.now() / 1000)
    const previousVisits = this.db
      .prepare('SELECT COUNT(1) as count FROM browser_history WHERE url = ?')
      .get<{ count?: number }>(url)
    const visitCount = Math.max(1, Number(previousVisits?.count || 0) + 1)
    this.db.prepare(
      `INSERT INTO browser_history (
        id, url, title, favicon, visit_count, last_visit_time, transition, session_id, domain, visited_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      url,
      title,
      metadata?.favicon ?? null,
      visitCount,
      visitedAt,
      metadata?.transition ?? 'typed',
      metadata?.sessionId ?? null,
      deriveBrowserDomain(url),
      visitedAt,
    )
    return id
  }

  updateHistoryEntryTitle(url: string, title: string, favicon?: string | null): void {
    if (!this.db) return
    const trimmed = String(title || '').trim()
    if (!trimmed) return
    // Backfill the most recent visit for this URL with the real page title (and
    // favicon, when provided) once it becomes available after navigation.
    if (favicon !== undefined) {
      this.db.prepare(
        `UPDATE browser_history SET title = ?, favicon = ?
         WHERE id = (SELECT id FROM browser_history WHERE url = ? ORDER BY visited_at DESC LIMIT 1)`
      ).run(trimmed, favicon ?? null, url)
    } else {
      this.db.prepare(
        `UPDATE browser_history SET title = ?
         WHERE id = (SELECT id FROM browser_history WHERE url = ? ORDER BY visited_at DESC LIMIT 1)`
      ).run(trimmed, url)
    }
  }

  getHistory(limit?: number): BrowserHistoryEntry[] {
    if (!this.db) return []
    const sql = limit
      ? 'SELECT * FROM browser_history ORDER BY visited_at DESC LIMIT ?'
      : 'SELECT * FROM browser_history ORDER BY visited_at DESC'
    return limit
      ? this.db.prepare(sql).all<BrowserHistoryEntry>(limit)
      : this.db.prepare(sql).all<BrowserHistoryEntry>()
  }

  clearHistory(sinceEpochSeconds?: number): void {
    if (!this.db) throw new Error('Database not available')
    if (typeof sinceEpochSeconds === 'number' && Number.isFinite(sinceEpochSeconds)) {
      this.db.prepare('DELETE FROM browser_history WHERE visited_at >= ?').run(Math.floor(sinceEpochSeconds))
    } else {
      this.db.prepare('DELETE FROM browser_history').run()
    }
  }

  getHistoryCount(): number {
    if (!this.db) return 0
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM browser_history').get<{ count: number }>()
    return Number(row?.count || 0)
  }

  searchHistory(query: string): BrowserHistoryEntry[] {
    if (!this.db) return []
    const pattern = `%${query}%`
    return this.db.prepare(
      'SELECT * FROM browser_history WHERE url LIKE ? OR title LIKE ? ORDER BY visited_at DESC'
    ).all<BrowserHistoryEntry>(pattern, pattern)
  }

  // ===================== Browser Downloads =====================

  addDownload(download: {
    id: string
    url: string
    filename: string
    save_path?: string
    total_bytes: number
    received_bytes?: number
    state?: string
    mime_type?: string | null
    error?: string | null
    end_time?: number | null
    can_resume?: number | boolean
  }): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare(
      `INSERT INTO browser_downloads (
        id, url, filename, save_path, total_bytes, received_bytes, state, mime_type, error, end_time, can_resume
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      download.id,
      download.url,
      download.filename,
      download.save_path || '',
      download.total_bytes,
      Number(download.received_bytes || 0),
      download.state || 'progressing',
      download.mime_type ?? null,
      download.error ?? null,
      download.end_time ?? null,
      download.can_resume === true ? 1 : download.can_resume === false ? 0 : Number(download.can_resume || 0),
    )
  }

  updateDownloadProgress(id: string, receivedBytes: number): void {
    if (!this.db) return
    this.db.prepare(
      'UPDATE browser_downloads SET received_bytes = ?, updated_at = unixepoch() WHERE id = ?'
    ).run(receivedBytes, id)
  }

  updateDownloadState(
    id: string,
    state: string,
    metadata?: {
      savePath?: string
      mimeType?: string | null
      error?: string | null
      endTime?: number | null
      canResume?: number | boolean
    },
  ): void {
    if (!this.db) return
    const setClauses = ['state = ?', 'updated_at = unixepoch()']
    const values: unknown[] = [state]
    if (metadata?.savePath !== undefined) {
      setClauses.push('save_path = ?')
      values.push(metadata.savePath)
    }
    if (metadata?.mimeType !== undefined) {
      setClauses.push('mime_type = ?')
      values.push(metadata.mimeType)
    }
    if (metadata?.error !== undefined) {
      setClauses.push('error = ?')
      values.push(metadata.error)
    }
    if (metadata?.endTime !== undefined) {
      setClauses.push('end_time = ?')
      values.push(metadata.endTime)
    }
    if (metadata?.canResume !== undefined) {
      setClauses.push('can_resume = ?')
      values.push(metadata.canResume === true ? 1 : metadata.canResume === false ? 0 : Number(metadata.canResume || 0))
    }
    values.push(id)
    this.db.prepare(`UPDATE browser_downloads SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
  }

  getDownloads(): BrowserDownload[] {
    if (!this.db) return []
    return this.db
      .prepare('SELECT * FROM browser_downloads ORDER BY COALESCE(end_time, created_at) DESC, created_at DESC')
      .all<BrowserDownload>()
  }

  clearDownloads(sinceEpochSeconds?: number): void {
    if (!this.db) throw new Error('Database not available')
    if (typeof sinceEpochSeconds === 'number' && Number.isFinite(sinceEpochSeconds)) {
      this.db.prepare('DELETE FROM browser_downloads WHERE created_at >= ?').run(Math.floor(sinceEpochSeconds))
    } else {
      this.db.prepare('DELETE FROM browser_downloads').run()
    }
  }

  getDownloadCount(): number {
    if (!this.db) return 0
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM browser_downloads').get<{ count: number }>()
    return Number(row?.count || 0)
  }

  // ===================== Browser Tasks =====================

  createBrowserTask(task: {
    id: string
    kind: string
    status: string
    payload_json: string
    checkpoint_json?: string | null
    result_json?: string | null
    progress_total?: number
    progress_completed?: number
    progress_failed?: number
    current_label?: string | null
    error?: string | null
    created_at: string
    started_at?: string | null
    updated_at: string
    finished_at?: string | null
    created_by_run_id?: string | null
    active_execution_binding_json?: string | null
    parent_task_id?: string | null
  }): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare(
      `INSERT INTO browser_tasks (
        id, kind, status, payload_json, checkpoint_json, result_json,
        progress_total, progress_completed, progress_failed, current_label, error,
        created_at, started_at, updated_at, finished_at,
        created_by_run_id, active_execution_binding_json, parent_task_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      task.id,
      task.kind,
      task.status,
      task.payload_json,
      task.checkpoint_json ?? null,
      task.result_json ?? null,
      Number(task.progress_total || 0),
      Number(task.progress_completed || 0),
      Number(task.progress_failed || 0),
      task.current_label ?? null,
      task.error ?? null,
      task.created_at,
      task.started_at ?? null,
      task.updated_at,
      task.finished_at ?? null,
      task.created_by_run_id ?? null,
      task.active_execution_binding_json ?? null,
      task.parent_task_id ?? null,
    )
  }

  updateBrowserTask(
    id: string,
    updates: {
      status?: string
      payload_json?: string | null
      checkpoint_json?: string | null
      result_json?: string | null
      progress_total?: number
      progress_completed?: number
      progress_failed?: number
      current_label?: string | null
      error?: string | null
      started_at?: string | null
      updated_at?: string
      finished_at?: string | null
      created_by_run_id?: string | null
      active_execution_binding_json?: string | null
      parent_task_id?: string | null
      projection_revision?: number
      projection_sync_json?: string | null
    },
    options?: { expectedUpdatedAt?: string; incrementRevision?: boolean },
  ): boolean {
    if (!this.db) return false
    const setClauses: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue
      setClauses.push(`${key} = ?`)
      values.push(value ?? null)
    }
    if (setClauses.length === 0) return false
    if (options?.incrementRevision !== false) setClauses.push('revision = revision + 1')
    if (updates.updated_at === undefined) {
      setClauses.push('updated_at = ?')
      values.push(new Date().toISOString())
    }
    values.push(id)
    let where = 'id = ?'
    if (options?.expectedUpdatedAt) {
      where += ' AND updated_at = ?'
      values.push(options.expectedUpdatedAt)
    }
    const result = this.db.prepare(`UPDATE browser_tasks SET ${setClauses.join(', ')} WHERE ${where}`).run(...values) as { changes?: number }
    return Number(result.changes || 0) === 1
  }

  getBrowserTask(id: string): BrowserTaskRecord | undefined {
    if (!this.db) return undefined
    return this.db.prepare('SELECT * FROM browser_tasks WHERE id = ? LIMIT 1').get<BrowserTaskRecord>(id)
  }

  listBrowserTasks(statuses?: string[]): BrowserTaskRecord[] {
    if (!this.db) return []
    if (Array.isArray(statuses) && statuses.length > 0) {
      const placeholders = statuses.map(() => '?').join(', ')
      return this.db.prepare(
        `SELECT * FROM browser_tasks WHERE status IN (${placeholders}) ORDER BY updated_at DESC`
      ).all<BrowserTaskRecord>(...statuses)
    }
    return this.db.prepare('SELECT * FROM browser_tasks ORDER BY updated_at DESC').all<BrowserTaskRecord>()
  }

  addBrowserPowerPreflightAudit(record: BrowserPowerPreflightAuditRecord): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare(`
      INSERT INTO browser_power_preflight_audit (
        id, tool_name, grant_id, confirmation_source, scope_id, tab_id,
        document_key_hash, url, object_ref, effects_json, purpose, input_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.tool_name,
      record.grant_id,
      record.confirmation_source,
      record.scope_id,
      record.tab_id,
      record.document_key_hash,
      record.url,
      record.object_ref,
      record.effects_json,
      record.purpose,
      record.input_hash,
      record.created_at,
    )
  }

  getBrowserPowerPreflightAudit(id: string): BrowserPowerPreflightAuditRecord | undefined {
    if (!this.db) return undefined
    return this.db.prepare(
      'SELECT * FROM browser_power_preflight_audit WHERE id = ? LIMIT 1',
    ).get<BrowserPowerPreflightAuditRecord>(id)
  }

  // ===================== Chat History =====================

  createConversation(id: string, agent: string, title: string): void {
    this.upsertConversationScope({
      id,
      agent,
      title,
      sourceKind: 'local',
      sourceId: 'app',
      userId: 'default-user',
      threadKey: id,
      meta: {},
    })
  }

  updateConversationTitle(id: string, title: string): void {
    if (!this.db) return
    const existing = this.getConversationScope(id)
    if (!existing) return
    this.db.prepare(
      'UPDATE chat_conversations SET title = ?, resume_title = ?, updated_at = ? WHERE id = ? AND closed_at IS NULL'
    ).run(title, title, new Date().toISOString(), id)
    if (existing) this.syncConversationRecallMetadata(id)
  }

  getConversations(agent: string, limit = 50): Array<{ id: string; agent: string; title: string; created_at: string; updated_at: string }> {
    if (!this.db) return []
    return this.db.prepare(
      `SELECT id, agent, title, created_at, updated_at
       FROM chat_conversations
       WHERE agent = ? AND source_kind = 'local' AND closed_at IS NULL
       ORDER BY updated_at DESC LIMIT ?`
    ).all<{ id: string; agent: string; title: string; created_at: string; updated_at: string }>(agent, limit)
  }

  getConversationScope(id: string): ChatConversationRecord | null {
    if (!this.db) return null
    const row = this.db.prepare(
      'SELECT * FROM chat_conversations WHERE id = ? AND closed_at IS NULL LIMIT 1'
    ).get<ChatConversationRecord>(id)
    return row ?? null
  }

  findConversationScope(
    sourceKind: ConversationSourceKind,
    sourceId: string,
    threadKey: string,
    agent: string,
  ): ChatConversationRecord | null {
    if (!this.db) return null
    const row = this.db.prepare(
      `SELECT * FROM chat_conversations
       WHERE source_kind = ? AND source_id = ? AND thread_key = ? AND agent = ?
         AND closed_at IS NULL
       LIMIT 1`
    ).get<ChatConversationRecord>(sourceKind, sourceId, threadKey, agent)
    return row ?? null
  }

  upsertConversationScope(payload: {
    id: string
    agent: string
    activeAgentId?: string
    userId?: string
    title: string
    parentConversationId?: string | null
    lineageRootId?: string | null
    resumeTitle?: string | null
    sourceKind: ConversationSourceKind
    sourceId: string
    threadKey: string
    meta?: Record<string, unknown>
  }): UpsertConversationScopeResult {
    if (!this.db) throw new Error('Database not available')
    const now = new Date().toISOString()
    const closedIdentity = this.db.prepare(
      'SELECT id FROM chat_conversations WHERE id = ? AND closed_at IS NOT NULL LIMIT 1',
    ).get<{ id: string }>(payload.id)
    if (closedIdentity) throw new Error(`Conversation scope closed: ${payload.id}`)
    const existing =
      this.getConversationScope(payload.id) ||
      this.findConversationScope(payload.sourceKind, payload.sourceId, payload.threadKey, payload.agent)
    const mode: UpsertConversationScopeMode = existing ? 'reused' : 'inserted'
    const id = existing?.id || payload.id
    const metaJson = JSON.stringify(payload.meta || {})
    this.db.prepare(
      `INSERT INTO chat_conversations (
         id, agent, active_agent_id, handoff_generation, user_id, title, parent_conversation_id, lineage_root_id, resume_title,
         source_kind, source_id, thread_key, meta_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         title = excluded.title,
         parent_conversation_id = excluded.parent_conversation_id,
         lineage_root_id = excluded.lineage_root_id,
         resume_title = excluded.resume_title,
         source_kind = excluded.source_kind,
         source_id = excluded.source_id,
         thread_key = excluded.thread_key,
         meta_json = excluded.meta_json,
         updated_at = excluded.updated_at`
    ).run(
      id,
      payload.agent,
      existing?.active_agent_id || payload.activeAgentId || payload.agent,
      existing?.handoff_generation ?? 0,
      payload.userId?.trim() || existing?.user_id || null,
      payload.title,
      payload.parentConversationId ?? existing?.parent_conversation_id ?? null,
      payload.lineageRootId || existing?.lineage_root_id || id,
      payload.resumeTitle || existing?.resume_title || payload.title,
      payload.sourceKind,
      payload.sourceId,
      payload.threadKey,
      metaJson,
      existing?.created_at ?? now,
      now,
    )
    this.syncConversationRecallMetadata(id)
    return { row: this.getConversationScope(id)!, mode }
  }

  updateConversationAgentState(
    id: string,
    activeAgentId: string,
    handoffGeneration: number,
  ): ChatConversationRecord {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare(
      'UPDATE chat_conversations SET active_agent_id = ?, handoff_generation = ?, updated_at = ? WHERE id = ? AND closed_at IS NULL',
    ).run(activeAgentId, handoffGeneration, new Date().toISOString(), id)
    const row = this.getConversationScope(id)
    if (!row) throw new Error(`Conversation not found: ${id}`)
    return row
  }

  listConversationScopes(
    agent?: string,
    limit = 100,
  ): Array<ChatConversationRecord & { last_message_at?: string | null }> {
    if (!this.db) return []
    const sql = agent
      ? `SELECT c.*, (
           SELECT MAX(timestamp) FROM chat_messages m
            WHERE m.conversation_id = c.id
              AND m.message_visibility_epoch = c.message_visibility_epoch
         ) AS last_message_at
         FROM chat_conversations c
         WHERE c.agent = ? AND c.closed_at IS NULL
         ORDER BY c.updated_at DESC
         LIMIT ?`
      : `SELECT c.*, (
           SELECT MAX(timestamp) FROM chat_messages m
            WHERE m.conversation_id = c.id
              AND m.message_visibility_epoch = c.message_visibility_epoch
         ) AS last_message_at
         FROM chat_conversations c
         WHERE c.closed_at IS NULL
         ORDER BY c.updated_at DESC
         LIMIT ?`
    return agent
      ? this.db.prepare(sql).all<ChatConversationRecord & { last_message_at?: string | null }>(agent, limit)
      : this.db.prepare(sql).all<ChatConversationRecord & { last_message_at?: string | null }>(limit)
  }

  deleteConversation(id: string): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM chat_messages_fts WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM session_recall_attachment_index WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM session_recall_metadata WHERE conversation_id = ?').run(id)
    this.db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(id)
  }

  addChatMessage(
    id: string,
    conversationId: string,
    role: string,
    content: string,
    timestamp: string,
    meta?: Record<string, unknown>,
    expectedMessageVisibilityEpoch?: number,
  ): void {
    if (!this.db) throw new Error('Database not available')
    const ownsTransaction = this.db.inTransaction !== true
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE')
    try {
    const scope = this.db.prepare(
      `SELECT closed_at, message_visibility_epoch
         FROM chat_conversations WHERE id = ? LIMIT 1`,
    ).get<{ closed_at: string | null; message_visibility_epoch: number }>(conversationId)
    if (!scope || scope.closed_at) throw new Error(`Conversation scope closed: ${conversationId}`)
    if (expectedMessageVisibilityEpoch !== undefined
      && scope.message_visibility_epoch !== expectedMessageVisibilityEpoch) {
      throw new Error(`Conversation message visibility epoch mismatch: ${conversationId}`)
    }
    const existing = this.db.prepare(`
      SELECT message_visibility_epoch FROM chat_messages WHERE id = ? LIMIT 1
    `).get<{ message_visibility_epoch: number }>(id)
    if (existing && existing.message_visibility_epoch !== scope.message_visibility_epoch) {
      throw new Error(`Conversation message visibility epoch mismatch: ${conversationId}`)
    }
    const metaJson = JSON.stringify(meta || {})
    this.db.prepare(
      `INSERT INTO chat_messages (
         id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         role = excluded.role,
         content = excluded.content,
         timestamp = excluded.timestamp,
         meta_json = excluded.meta_json`
    ).run(id, conversationId, role, content, timestamp, metaJson, scope.message_visibility_epoch)
    const visible = this.db.prepare(`
      SELECT 1 AS visible FROM chat_messages message
      JOIN chat_conversations active ON active.id = message.conversation_id
      WHERE message.id = ? AND active.id = ? AND active.closed_at IS NULL
        AND message.message_visibility_epoch = active.message_visibility_epoch
      LIMIT 1
    `).get<{ visible: number }>(id, conversationId)
    if (!visible) throw new Error(`Conversation message visibility epoch mismatch: ${conversationId}`)
    this.db.prepare('DELETE FROM chat_messages_fts WHERE message_id = ?').run(id)
    this.db.prepare(
      'INSERT INTO chat_messages_fts (message_id, conversation_id, content) VALUES (?, ?, ?)'
    ).run(id, conversationId, content || '')
    this.db.prepare(
      'DELETE FROM session_recall_attachment_index WHERE conversation_id = ? AND source_message_id = ?'
    ).run(conversationId, id)
    this.syncConversationRecallAttachments(conversationId, id, timestamp, meta)
    this.syncConversationRecallMetadata(conversationId, {
      previewText: content,
      updatedAt: timestamp,
    })
    // Touch conversation updated_at
    this.db.prepare(
      'UPDATE chat_conversations SET updated_at = ? WHERE id = ? AND closed_at IS NULL',
    ).run(timestamp, conversationId)
    if (ownsTransaction) this.db.exec('COMMIT')
    } catch (error) {
      if (ownsTransaction && this.db.inTransaction === true) this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Repair indexes for an already-committed canonical message without ever
   * rewriting the chat_messages row. The caller-provided digest binds this
   * repair to the immutable core row. */
  repairChatMessageDerivedIndexes(
    expected: {
      id: string
      conversationId: string
      role: string
      content: string
      timestamp: string
      meta: Record<string, unknown>
    },
    expectedDigest: string,
  ): void {
    if (!this.db) throw new Error('Database not available')
    const row = this.db.prepare(
      `SELECT message.id, message.conversation_id, message.role, message.content,
              message.timestamp, message.meta_json
         FROM chat_messages message
         JOIN chat_conversations scope ON scope.id = message.conversation_id
        WHERE message.id = ? AND scope.closed_at IS NULL
          AND message.message_visibility_epoch = scope.message_visibility_epoch
        LIMIT 1`,
    ).get<{
      id: string
      conversation_id: string
      role: string
      content: string
      timestamp: string
      meta_json: string | null
    }>(expected.id)
    if (!row) throw new Error('canonical_chat_message_missing_for_repair')
    if (!this.getConversationScope(row.conversation_id)) {
      throw new Error(`Conversation scope closed: ${row.conversation_id}`)
    }
    const actual = {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      meta: JSON.parse(row.meta_json || '{}') as Record<string, unknown>,
    }
    const actualDigest = createHash('sha256').update(JSON.stringify(actual)).digest('hex')
    if (
      actualDigest !== expectedDigest
      || JSON.stringify(actual) !== JSON.stringify(expected)
    ) throw new Error('canonical_chat_message_digest_mismatch_for_repair')

    this.db.prepare('DELETE FROM chat_messages_fts WHERE message_id = ?').run(actual.id)
    this.db.prepare(
      'INSERT INTO chat_messages_fts (message_id, conversation_id, content) VALUES (?, ?, ?)',
    ).run(actual.id, actual.conversationId, actual.content || '')
    this.db.prepare(
      'DELETE FROM session_recall_attachment_index WHERE conversation_id = ? AND source_message_id = ?',
    ).run(actual.conversationId, actual.id)
    this.syncConversationRecallAttachments(
      actual.conversationId,
      actual.id,
      actual.timestamp,
      actual.meta,
    )
    this.syncConversationRecallMetadata(actual.conversationId, {
      previewText: actual.content,
      updatedAt: actual.timestamp,
    })
    this.db.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ? AND closed_at IS NULL')
      .run(actual.timestamp, actual.conversationId)
  }

  updateConversationScopeMeta(
    id: string,
    meta: Record<string, unknown>,
    expectedMessageVisibilityEpoch?: number,
  ): ChatConversationRecord | null {
    if (!this.db) return null
    const existing = this.getConversationScope(id)
    if (!existing) return null
    if (
      expectedMessageVisibilityEpoch !== undefined
      && existing.message_visibility_epoch !== expectedMessageVisibilityEpoch
    ) return null
    const result = this.db.prepare(`
      UPDATE chat_conversations
         SET meta_json = ?, updated_at = ?
       WHERE id = ?
         AND closed_at IS NULL
         AND (? IS NULL OR message_visibility_epoch = ?)
    `).run(
      JSON.stringify(meta || {}),
      new Date().toISOString(),
      id,
      expectedMessageVisibilityEpoch ?? null,
      expectedMessageVisibilityEpoch ?? null,
    ) as { changes?: number }
    if ((result.changes ?? 0) !== 1) return null
    return this.getConversationScope(id)
  }

  updateConversationRecallTaskState(
    conversationId: string,
    taskTitle?: string | null,
    taskSummary?: string | null,
    expectedMessageVisibilityEpoch?: number,
  ): boolean {
    if (!this.db) return false
    const scope = this.db.prepare(`
      SELECT message_visibility_epoch
        FROM chat_conversations WHERE id = ? AND closed_at IS NULL LIMIT 1
    `).get<{ message_visibility_epoch: number }>(conversationId)
    if (!scope || (expectedMessageVisibilityEpoch !== undefined
      && scope.message_visibility_epoch !== expectedMessageVisibilityEpoch)) return false
    this.syncConversationRecallMetadata(conversationId, {
      latestTaskTitle: taskTitle ?? null,
      latestTaskSummary: taskSummary ?? null,
    })
    return true
  }

  getChatMessages(conversationId: string): ChatMessageRecord[] {
    if (!this.db) return []
    return this.db.prepare(
      `SELECT message.* FROM chat_messages message
        JOIN chat_conversations scope ON scope.id = message.conversation_id
       WHERE message.conversation_id = ? AND scope.closed_at IS NULL
         AND message.message_visibility_epoch = scope.message_visibility_epoch
       ORDER BY message.timestamp ASC`
    ).all<ChatMessageRecord>(conversationId)
  }

  /**
   * Replace meta_json on an existing chat_messages row. Returns true when a
   * row was updated, false when no row with this id existed.
   *
   * Used by `ask_user_questions` to flip a card from status='pending' to
   * status='submitted' / 'cancelled' / 'timeout' without rewriting role /
   * content / timestamp. Content is also updated optionally so the folded
   * card summary can reflect the user's answers in chat history search
   * (FTS index is replaced when content changes).
   */
  updateChatMessageMeta(
    messageId: string,
    meta: Record<string, unknown>,
    options?: { content?: string },
  ): boolean {
    if (!this.db) return false
    const metaJson = JSON.stringify(meta || {})
    const nextContent = typeof options?.content === 'string' ? options.content : null
    if (nextContent !== null) {
      const info = this.db.prepare(
        `UPDATE chat_messages SET meta_json = ?, content = ? WHERE id = ?
           AND EXISTS (
             SELECT 1 FROM chat_conversations active
              WHERE active.id = chat_messages.conversation_id AND active.closed_at IS NULL
                AND chat_messages.message_visibility_epoch = active.message_visibility_epoch
           )`
      ).run(metaJson, nextContent, messageId)
      if ((info as { changes?: number }).changes === 0) return false
      const conversationId = (this.db.prepare(
        'SELECT conversation_id FROM chat_messages WHERE id = ?'
      ).get(messageId) as { conversation_id?: string } | undefined)?.conversation_id || ''
      this.db.prepare('DELETE FROM chat_messages_fts WHERE message_id = ?').run(messageId)
      this.db.prepare(
        'INSERT INTO chat_messages_fts (message_id, conversation_id, content) VALUES (?, ?, ?)'
      ).run(messageId, conversationId, nextContent)
      return true
    }
    const info = this.db.prepare(
      `UPDATE chat_messages SET meta_json = ? WHERE id = ?
         AND EXISTS (
           SELECT 1 FROM chat_conversations active
            WHERE active.id = chat_messages.conversation_id AND active.closed_at IS NULL
              AND chat_messages.message_visibility_epoch = active.message_visibility_epoch
         )`
    ).run(metaJson, messageId)
    return (info as { changes?: number }).changes !== 0
  }

  getChatMessageById(messageId: string): ChatMessageRecord | null {
    if (!this.db) return null
    return this.db.prepare(
      `SELECT message.* FROM chat_messages message
        JOIN chat_conversations active ON active.id = message.conversation_id
       WHERE message.id = ? AND active.closed_at IS NULL
         AND message.message_visibility_epoch = active.message_visibility_epoch`
    ).get<ChatMessageRecord>(messageId) ?? null
  }

  /**
   * Find every chat_messages row whose meta_json carries
   * `askUserQuestions.status='pending'`. Used by:
   *   - app boot: sweep to `cancelled (app_restart)` so resurrected rows
   *     never appear in the renderer as永远转圈卡片.
   *   - renderer hydrate (`agent:askUserQuestions:listPending`): show
   *     cards the user hadn't answered yet when the renderer reconnects
   *     mid-flight without restart.
   *
   * Note: `like '%"status":"pending"%'` is a heuristic pre-filter (the
   * exact match is done in JS); we accept a tiny false-positive rate to
   * avoid scanning every chat_messages row. Production volume on the
   * `agent_card` role is small so the filter pays off via the role index.
   */
  listPendingAskUserQuestionsCards(): Array<{
    messageId: string
    conversationId: string
    timestamp: string
    meta: Record<string, unknown>
  }> {
    if (!this.db) return []
    const rows = this.db.prepare(
      `SELECT message.id, message.conversation_id, message.timestamp, message.meta_json
         FROM chat_messages message
         JOIN chat_conversations active ON active.id = message.conversation_id
        WHERE message.role = 'agent_card' AND active.closed_at IS NULL
          AND message.message_visibility_epoch = active.message_visibility_epoch
          AND message.meta_json LIKE '%"status":"pending"%'`
    ).all<{ id: string; conversation_id: string; timestamp: string; meta_json: string | null }>()
    const out: Array<{ messageId: string; conversationId: string; timestamp: string; meta: Record<string, unknown> }> = []
    for (const row of rows) {
      let meta: Record<string, unknown> = {}
      try {
        meta = row.meta_json ? JSON.parse(row.meta_json) as Record<string, unknown> : {}
      } catch {
        continue
      }
      const aug = meta.askUserQuestions
      if (!aug || typeof aug !== 'object') continue
      if ((aug as { status?: unknown }).status !== 'pending') continue
      out.push({
        messageId: row.id,
        conversationId: row.conversation_id,
        timestamp: row.timestamp,
        meta,
      })
    }
    return out
  }

  /**
   * Boot-time sweep: rewrite every pending ask_user_questions card to
   * status='cancelled' with reason='app_restart'. Idempotent. Returns the
   * number of rows mutated for telemetry / logging.
   *
   * Stage U (PR 1, B.4b) — `liveCardIds` lets callers exclude cards whose
   * in-memory Promise resolver is still alive. dev-reload of the main process
   * re-runs `setupAgentIPC`; without this guard the sweep would cancel
   * DB rows for cards still being awaited in memory, then the in-memory
   * Promise eventually times out at 24h with no UI feedback.
   *
   * Callers that genuinely need "cancel everything pending" (initial boot
   * after a hard restart) should pass `liveCardIds=undefined` so the gate
   * is bypassed. The ipc-handler boot path passes the live set from
   * `getAskUserQuestionsStore().list()`.
   *
   * Returns `{ mutated, skippedLive }` so the caller can emit the
   * `ask_user_questions_boot_sweep_skipped_live` metric when warranted.
   */
  sweepPendingAskUserQuestionsCardsOnBoot(
    options: { now?: string; liveCardIds?: ReadonlySet<string> } = {},
  ): { mutated: number; skippedLive: number } {
    if (!this.db) return { mutated: 0, skippedLive: 0 }
    // Pure logic lives in `ask-user-questions-sweep.ts` so behavior tests run
    // on host Node without the better-sqlite3 native gate. This method only
    // injects the DB read + write closures.
    return performBootSweep({
      pending: this.listPendingAskUserQuestionsCards().map((entry) => ({
        messageId: entry.messageId,
        conversationId: entry.conversationId,
        meta: entry.meta,
      })),
      liveCardIds: options.liveCardIds,
      now: options.now ?? new Date().toISOString(),
      updateMeta: (messageId, nextMeta) => this.updateChatMessageMeta(messageId, nextMeta),
    })
  }

  /**
   * Stage U (PR 1, B.4c) — sweep every pending ask_user_questions card
   * belonging to a given session/conversation. Used by session lifecycle
   * hooks (`cleanupSkillSessionState` / `cancelSkillSessionPendingInteractions`)
   * AFTER `getAskUserQuestionsStore().rejectBySession(...)` has dropped the
   * in-memory waiters — that way DB and memory stay aligned.
   *
   * Returns the number of rows mutated; emit
   * `ask_user_questions_session_reset_swept_db` at the call site if > 0.
   */
  sweepPendingAskUserQuestionsCardsBySession(
    sessionId: string,
    cancelReason: string = 'session_reset',
    now: string = new Date().toISOString(),
  ): number {
    if (!this.db) return 0
    if (!sessionId) return 0
    return performSessionSweep({
      pending: this.listPendingAskUserQuestionsCards().map((entry) => ({
        messageId: entry.messageId,
        conversationId: entry.conversationId,
        meta: entry.meta,
      })),
      sessionId,
      cancelReason,
      now,
      updateMeta: (messageId, nextMeta) => this.updateChatMessageMeta(messageId, nextMeta),
    })
  }

  listConversationAttachments(conversationId: string): ConversationAttachmentRecord[] {
    const rows = this.getChatMessages(conversationId)
    if (rows.length === 0) return []

    const seen = new Set<string>()
    const attachments: ConversationAttachmentRecord[] = []
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i]
      let meta: Record<string, unknown> = {}
      try {
        meta = row.meta_json ? JSON.parse(row.meta_json) as Record<string, unknown> : {}
      } catch {
        meta = {}
      }
      const raw = meta.attachments
      if (!Array.isArray(raw)) continue
      for (let index = raw.length - 1; index >= 0; index -= 1) {
        const item = raw[index]
        if (!item || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        const name = String(record.name || '').trim()
        const path = String(record.path || '').trim()
        if (!name || !path) continue
        const attachmentId = String(record.id || `${row.id}-${index}`).trim()
        const key = `${attachmentId}::${path}`
        if (seen.has(key)) continue
        seen.add(key)
        attachments.push({
          attachment_id: attachmentId,
          conversation_id: conversationId,
          source_message_id: row.id,
          name,
          path,
          type: String(record.type || 'other'),
          size: Number(record.size || 0),
          ext: String(record.ext || ''),
          url: typeof record.url === 'string' ? record.url : null,
          mime_type: typeof record.mimeType === 'string' ? record.mimeType : null,
          remote_id: typeof record.remoteId === 'string' ? record.remoteId : null,
          channel_id: typeof meta.channelId === 'string' ? meta.channelId : null,
          thread_key: typeof meta.threadKey === 'string' ? meta.threadKey : null,
          created_at: row.timestamp,
        })
      }
    }
    return attachments
  }

  private syncConversationRecallAttachments(
    conversationId: string,
    sourceMessageId: string,
    createdAt: string,
    meta?: Record<string, unknown>,
  ): void {
    if (!this.db) return
    const raw = meta?.attachments
    if (!Array.isArray(raw)) return
    for (let index = 0; index < raw.length; index += 1) {
      const item = raw[index]
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const attachmentId = String(record.id || `${sourceMessageId}-${index}`).trim()
      const path = String(record.path || '').trim()
      const name = String(record.name || '').trim()
      if (!attachmentId || !name) continue
      const attachmentKey = `${conversationId}::${attachmentId}::${path || name}`
      this.db.prepare(`
        INSERT OR REPLACE INTO session_recall_attachment_index (
          attachment_key, conversation_id, attachment_id, source_message_id, name, type, ext, path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        attachmentKey,
        conversationId,
        attachmentId,
        sourceMessageId,
        name,
        String(record.type || '').trim() || null,
        String(record.ext || '').trim() || null,
        path || null,
        createdAt,
      )
    }
  }

  private syncConversationRecallMetadata(
    conversationId: string,
    overrides?: {
      previewText?: string | null
      latestTaskTitle?: string | null
      latestTaskSummary?: string | null
      updatedAt?: string
    },
  ): void {
    if (!this.db) return
    const conversation = this.getConversationScope(conversationId)
    if (!conversation) return
    const existing = this.db.prepare(`
      SELECT preview_text, latest_task_title, latest_task_summary
      FROM session_recall_metadata
      WHERE conversation_id = ?
      LIMIT 1
    `).get<{
      preview_text?: string | null
      latest_task_title?: string | null
      latest_task_summary?: string | null
    }>(conversationId)
    const attachmentRows = this.db.prepare(`
      SELECT DISTINCT name
      FROM session_recall_attachment_index
      WHERE conversation_id = ?
      ORDER BY created_at DESC, name COLLATE NOCASE ASC
    `).all<{ name: string }>(conversationId)
    const attachmentNames = attachmentRows
      .map((row) => String(row.name || '').trim())
      .filter(Boolean)
      .slice(0, 12)
    const previewText = String(overrides?.previewText ?? existing?.preview_text ?? '').trim()
    const latestTaskTitle = overrides?.latestTaskTitle !== undefined
      ? overrides.latestTaskTitle
      : existing?.latest_task_title ?? null
    const latestTaskSummary = overrides?.latestTaskSummary !== undefined
      ? overrides.latestTaskSummary
      : existing?.latest_task_summary ?? null
    const channelKey = `${conversation.source_kind}:${conversation.source_kind === 'local' ? 'app' : conversation.source_id}`
    this.db.prepare(`
      INSERT INTO session_recall_metadata (
        conversation_id, lineage_root_id, resume_title, title, source_kind, source_id, thread_key,
        user_id, agent, channel_key, preview_text, latest_task_title, latest_task_summary, attachment_names_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        lineage_root_id = excluded.lineage_root_id,
        resume_title = excluded.resume_title,
        title = excluded.title,
        source_kind = excluded.source_kind,
        source_id = excluded.source_id,
        thread_key = excluded.thread_key,
        user_id = excluded.user_id,
        agent = excluded.agent,
        channel_key = excluded.channel_key,
        preview_text = excluded.preview_text,
        latest_task_title = excluded.latest_task_title,
        latest_task_summary = excluded.latest_task_summary,
        attachment_names_json = excluded.attachment_names_json,
        updated_at = excluded.updated_at
    `).run(
      conversationId,
      conversation.lineage_root_id || conversationId,
      conversation.resume_title || conversation.title,
      conversation.title,
      conversation.source_kind,
      conversation.source_id,
      conversation.thread_key,
      conversation.user_id || null,
      conversation.agent || null,
      channelKey,
      previewText ? previewText.slice(0, 280) : null,
      latestTaskTitle || null,
      latestTaskSummary || null,
      JSON.stringify(attachmentNames),
      overrides?.updatedAt || conversation.updated_at,
    )
  }

  // ===================== Settings (key-value) =====================

  getSetting(key: string): string | undefined {
    assertDatabaseConnectionReady(this.db, 'settings database')
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get<{ value: string }>(key)
    return row?.value
  }

  setSetting(key: string, value: string): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value, new Date().toISOString())
  }

  deleteSetting(key: string): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  getAllSettings(): Record<string, string> {
    assertDatabaseConnectionReady(this.db, 'settings database')
    const rows = this.db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()
    const result: Record<string, string> = {}
    for (const row of rows) {
      result[row.key] = row.value
    }
    return result
  }

  // ===================== Agent Runtime (channels/schedules) =====================

  listAgentChannels(): AgentChannelRecord[] {
    if (!this.db) return []
    return this.db
      .prepare('SELECT * FROM agent_channels ORDER BY updated_at DESC')
      .all<AgentChannelRecord>()
  }

  getAgentChannel(id: string): AgentChannelRecord | null {
    if (!this.db) return null
    const row = this.db
      .prepare('SELECT * FROM agent_channels WHERE id = ? LIMIT 1')
      .get<AgentChannelRecord>(id)
    return row ?? null
  }

  upsertAgentChannel(payload: {
    id: string
    type: AgentChannelType
    name: string
    enabled: boolean
    configJson: string
    lastError?: string | null
    lastSeenAt?: string | null
  }): AgentChannelRecord {
    if (!this.db) throw new Error('Database not available')
    const now = new Date().toISOString()
    const existing = this.getAgentChannel(payload.id)
    this.db.prepare(
      `INSERT INTO agent_channels (id, type, name, enabled, config_json, last_error, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         name = excluded.name,
         enabled = excluded.enabled,
         config_json = excluded.config_json,
         last_error = excluded.last_error,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`
    ).run(
      payload.id,
      payload.type,
      payload.name,
      payload.enabled ? 1 : 0,
      payload.configJson,
      payload.lastError ?? null,
      payload.lastSeenAt ?? null,
      existing?.created_at ?? now,
      now,
    )
    return this.getAgentChannel(payload.id)!
  }

  deleteAgentChannel(id: string): boolean {
    if (!this.db) return false
    const result = this.db.prepare('DELETE FROM agent_channels WHERE id = ?').run(id) as {
      changes?: number
    }
    return (result.changes ?? 0) > 0
  }

  setAgentChannelEnabled(id: string, enabled: boolean): AgentChannelRecord | null {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('UPDATE agent_channels SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), id)
    return this.getAgentChannel(id)
  }

  markAgentChannelSeen(id: string, at?: string): AgentChannelRecord | null {
    if (!this.db) throw new Error('Database not available')
    const seenAt = at || new Date().toISOString()
    this.db.prepare('UPDATE agent_channels SET last_seen_at = ?, updated_at = ? WHERE id = ?')
      .run(seenAt, seenAt, id)
    return this.getAgentChannel(id)
  }

  setAgentChannelError(id: string, error: string | null): AgentChannelRecord | null {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('UPDATE agent_channels SET last_error = ?, updated_at = ? WHERE id = ?')
      .run(error, new Date().toISOString(), id)
    return this.getAgentChannel(id)
  }

  getAgentChannelThread(channelId: string, remoteThread: string): AgentChannelThreadRecord | null {
    if (!this.db) return null
    const row = this.db.prepare(
      'SELECT * FROM agent_channel_threads WHERE channel_id = ? AND remote_thread = ? LIMIT 1'
    ).get<AgentChannelThreadRecord>(channelId, remoteThread)
    return row ?? null
  }

  /**
   * Phase I P0 — scope → 渠道线程反查：远程 run 中产生的 ask/confirm 卡带
   * scopeId，转投微信需要还原 (channelId, remoteThread)。取最近更新的一条
   * （同 scope 理论上唯一，upsert 以 channel+thread 为键）。
   */
  getAgentChannelThreadBySession(sessionId: string): AgentChannelThreadRecord | null {
    if (!this.db || !sessionId) return null
    const row = this.db.prepare(
      'SELECT * FROM agent_channel_threads WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1'
    ).get<AgentChannelThreadRecord>(sessionId)
    return row ?? null
  }

  upsertAgentChannelThread(payload: {
    channelId: string
    remoteThread: string
    sessionId: string
    conversationId?: string | null
  }): AgentChannelThreadRecord {
    if (!this.db) throw new Error('Database not available')
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO agent_channel_threads (channel_id, remote_thread, session_id, conversation_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id, remote_thread) DO UPDATE SET
         session_id = excluded.session_id,
         conversation_id = excluded.conversation_id,
         updated_at = excluded.updated_at`
    ).run(payload.channelId, payload.remoteThread, payload.sessionId, payload.conversationId ?? null, now)
    return this.getAgentChannelThread(payload.channelId, payload.remoteThread)!
  }

  getAgentChannelEvent(eventId: string): AgentChannelEventRecord | null {
    if (!this.db) return null
    const row = this.db.prepare(
      'SELECT * FROM agent_channel_events WHERE event_id = ? LIMIT 1'
    ).get<AgentChannelEventRecord>(eventId)
    return row ?? null
  }

  upsertAgentChannelEvent(payload: {
    eventId: string
    channelId: string
    status: string
    error?: string | null
  }): AgentChannelEventRecord {
    if (!this.db) throw new Error('Database not available')
    const now = new Date().toISOString()
    const existing = this.getAgentChannelEvent(payload.eventId)
    this.db.prepare(
      `INSERT INTO agent_channel_events (event_id, channel_id, status, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         channel_id = excluded.channel_id,
         status = excluded.status,
         error = excluded.error,
         updated_at = excluded.updated_at`
    ).run(
      payload.eventId,
      payload.channelId,
      payload.status,
      payload.error ?? null,
      existing?.created_at ?? now,
      now,
    )
    return this.getAgentChannelEvent(payload.eventId)!
  }

  /**
   * An inbound event is removed from the sidecar queue before Ready finishes
   * persisting it. After a process restart, a legacy `running` row therefore
   * has no live owner and must not remain permanently in progress. Mark the
   * unknown outcome failed so an adapter redelivery can be admitted again.
   */
  failRunningAgentChannelEventsOnBoot(
    reason: string = 'app_restart_before_inbound_settlement',
  ): number {
    if (!this.db) return 0
    const result = this.db.prepare(
      `UPDATE agent_channel_events
          SET status = 'failed', error = ?, updated_at = ?
        WHERE status = 'running'`,
    ).run(reason, new Date().toISOString()) as { changes?: number }
    return Number(result.changes || 0)
  }

  close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

// Singleton instance
let dbInstance: DatabaseManager | null = null

export function getDatabase(): DatabaseManager {
  if (!dbInstance) {
    dbInstance = new DatabaseManager()
  }
  return dbInstance
}

// For backward compatibility
export { DatabaseManager as Database }
