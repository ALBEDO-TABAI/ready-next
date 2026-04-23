import { appendFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { runMigrations } from './migrations'
import { getLogPath } from '../utils/platform'

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
}

type BetterSqliteConstructor = new (path: string) => DatabaseConnection

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
  reminders: string | null
  agent_action: string | null
  created_at: number
  updated_at: number
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
}

export type AgentChannelType =
  | 'local-debug'
  | 'generic-webhook'
  | 'feishu-bot'
  | 'feishu-app'
  | 'telegram-bot'

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

export interface AgentScheduleRecord {
  id: string
  name: string
  cron_expr: string
  prompt: string
  channel_id: string | null
  enabled: number
  payload_json: string | null
  last_run_at: string | null
  next_run_at: string | null
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
  user_id?: string | null
  title: string
  parent_conversation_id?: string | null
  lineage_root_id?: string | null
  resume_title?: string | null
  source_kind: ConversationSourceKind
  source_id: string
  thread_key: string
  meta_json: string | null
  created_at: string
  updated_at: string
}

export interface ChatMessageRecord {
  id: string
  conversation_id: string
  role: string
  content: string
  timestamp: string
  meta_json: string | null
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
const require = createRequire(import.meta.url)
const DATABASE_LOG = getLogPath('ready-database.log')

function logDatabase(message: string): void {
  try { appendFileSync(DATABASE_LOG, `[${new Date().toISOString()}] ${message}\n`) } catch { /* ignore */ }
}

// Lazy load better-sqlite3 to handle missing module gracefully
try {
  const betterSqlite3 = require('better-sqlite3') as BetterSqliteConstructor & {
    default?: BetterSqliteConstructor
  }
  DatabaseConstructor = betterSqlite3.default || betterSqlite3
  logDatabase('better-sqlite3 loaded successfully')
} catch (error) {
  logDatabase(`better-sqlite3 load failed: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  console.warn('better-sqlite3 not available, using in-memory fallback')
}

function deriveBrowserDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

export class DatabaseManager {
  private db: DatabaseConnection | null = null
  private dbPath: string
  private useMemoryDb: boolean

  constructor(useMemoryDb = false) {
    this.useMemoryDb = useMemoryDb || !DatabaseConstructor

    if (this.useMemoryDb) {
      this.dbPath = ':memory:'
    } else {
      try {
        const userDataPath = app.getPath('userData')
        this.dbPath = join(userDataPath, 'ready.db')
      } catch {
        this.dbPath = ':memory:'
        this.useMemoryDb = true
      }
    }

    this.init()
  }

  private init(): void {
    try {
      if (!DatabaseConstructor) {
        logDatabase('DatabaseConstructor unavailable; database disabled')
        console.warn('Database module not available, using mock implementation')
        this.db = null
        return
      }

      logDatabase(`opening database path=${this.dbPath}`)
      this.db = new DatabaseConstructor(this.dbPath)
      this.createTables()
      logDatabase(`database initialized path=${this.dbPath}`)
    } catch (error) {
      logDatabase(`database initialization failed path=${this.dbPath} error=${error instanceof Error ? error.stack || error.message : String(error)}`)
      console.error('Database initialization failed:', error)
      this.db = null
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
    return this.db.prepare(
      `SELECT * FROM calendar_events
       WHERE start_time < ? AND end_time > ?
       ORDER BY start_time`
    ).all<CalendarEvent>(endTime, startTime)
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
  }): string {
    if (!this.db) throw new Error('Database not available')
    const id = `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.db.prepare(
      `INSERT INTO calendar_events
       (id, calendar_id, title, description, location, start_time, end_time, all_day)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      event.calendar_id,
      event.title,
      event.description || null,
      event.location || null,
      event.start_time,
      event.end_time,
      event.all_day || 0
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

  getHistory(limit?: number): BrowserHistoryEntry[] {
    if (!this.db) return []
    const sql = limit
      ? 'SELECT * FROM browser_history ORDER BY visited_at DESC LIMIT ?'
      : 'SELECT * FROM browser_history ORDER BY visited_at DESC'
    return limit
      ? this.db.prepare(sql).all<BrowserHistoryEntry>(limit)
      : this.db.prepare(sql).all<BrowserHistoryEntry>()
  }

  clearHistory(): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('DELETE FROM browser_history').run()
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

  clearDownloads(): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('DELETE FROM browser_downloads').run()
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
  }): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare(
      `INSERT INTO browser_tasks (
        id, kind, status, payload_json, checkpoint_json, result_json,
        progress_total, progress_completed, progress_failed, current_label, error,
        created_at, started_at, updated_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    )
  }

  updateBrowserTask(
    id: string,
    updates: {
      status?: string
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
    },
  ): void {
    if (!this.db) return
    const setClauses: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(updates)) {
      setClauses.push(`${key} = ?`)
      values.push(value ?? null)
    }
    if (!('updated_at' in updates)) {
      setClauses.push('updated_at = ?')
      values.push(new Date().toISOString())
    }
    values.push(id)
    this.db.prepare(`UPDATE browser_tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
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

  // ===================== Chat History =====================

  createConversation(id: string, agent: string, title: string): void {
    this.upsertConversationScope({
      id,
      agent,
      title,
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: id,
      meta: {},
    })
  }

  updateConversationTitle(id: string, title: string): void {
    if (!this.db) return
    const existing = this.getConversationScope(id)
    this.db.prepare(
      'UPDATE chat_conversations SET title = ?, resume_title = ?, updated_at = ? WHERE id = ?'
    ).run(title, title, new Date().toISOString(), id)
    if (existing) this.syncConversationRecallMetadata(id)
  }

  getConversations(agent: string, limit = 50): Array<{ id: string; agent: string; title: string; created_at: string; updated_at: string }> {
    if (!this.db) return []
    return this.db.prepare(
      `SELECT id, agent, title, created_at, updated_at
       FROM chat_conversations
       WHERE agent = ? AND source_kind = 'local'
       ORDER BY updated_at DESC LIMIT ?`
    ).all<{ id: string; agent: string; title: string; created_at: string; updated_at: string }>(agent, limit)
  }

  getConversationScope(id: string): ChatConversationRecord | null {
    if (!this.db) return null
    const row = this.db.prepare(
      'SELECT * FROM chat_conversations WHERE id = ? LIMIT 1'
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
       LIMIT 1`
    ).get<ChatConversationRecord>(sourceKind, sourceId, threadKey, agent)
    return row ?? null
  }

  upsertConversationScope(payload: {
    id: string
    agent: string
    userId?: string
    title: string
    parentConversationId?: string | null
    lineageRootId?: string | null
    resumeTitle?: string | null
    sourceKind: ConversationSourceKind
    sourceId: string
    threadKey: string
    meta?: Record<string, unknown>
  }): ChatConversationRecord {
    if (!this.db) throw new Error('Database not available')
    const now = new Date().toISOString()
    const existing =
      this.getConversationScope(payload.id) ||
      this.findConversationScope(payload.sourceKind, payload.sourceId, payload.threadKey, payload.agent)
    const id = existing?.id || payload.id
    const metaJson = JSON.stringify(payload.meta || {})
    this.db.prepare(
      `INSERT INTO chat_conversations (
         id, agent, user_id, title, parent_conversation_id, lineage_root_id, resume_title,
         source_kind, source_id, thread_key, meta_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         agent = excluded.agent,
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
      payload.userId || null,
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
    return this.getConversationScope(id)!
  }

  listConversationScopes(
    agent?: string,
    limit = 100,
  ): Array<ChatConversationRecord & { last_message_at?: string | null }> {
    if (!this.db) return []
    const sql = agent
      ? `SELECT c.*, (
           SELECT MAX(timestamp) FROM chat_messages m WHERE m.conversation_id = c.id
         ) AS last_message_at
         FROM chat_conversations c
         WHERE c.agent = ?
         ORDER BY c.updated_at DESC
         LIMIT ?`
      : `SELECT c.*, (
           SELECT MAX(timestamp) FROM chat_messages m WHERE m.conversation_id = c.id
         ) AS last_message_at
         FROM chat_conversations c
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
  ): void {
    if (!this.db) throw new Error('Database not available')
    const metaJson = JSON.stringify(meta || {})
    this.db.prepare(
      'INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, conversationId, role, content, timestamp, metaJson)
    this.db.prepare(
      'INSERT INTO chat_messages_fts (message_id, conversation_id, content) VALUES (?, ?, ?)'
    ).run(id, conversationId, content || '')
    this.syncConversationRecallAttachments(conversationId, id, timestamp, meta)
    this.syncConversationRecallMetadata(conversationId, {
      previewText: content,
      updatedAt: timestamp,
    })
    // Touch conversation updated_at
    this.db.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?').run(timestamp, conversationId)
  }

  updateConversationScopeMeta(id: string, meta: Record<string, unknown>): ChatConversationRecord | null {
    if (!this.db) return null
    const existing = this.getConversationScope(id)
    if (!existing) return null
    this.db.prepare('UPDATE chat_conversations SET meta_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(meta || {}), new Date().toISOString(), id)
    return this.getConversationScope(id)
  }

  updateConversationRecallTaskState(conversationId: string, taskTitle?: string | null, taskSummary?: string | null): void {
    if (!this.db) return
    this.syncConversationRecallMetadata(conversationId, {
      latestTaskTitle: taskTitle ?? null,
      latestTaskSummary: taskSummary ?? null,
    })
  }

  getChatMessages(conversationId: string): ChatMessageRecord[] {
    if (!this.db) return []
    return this.db.prepare(
      'SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY timestamp ASC'
    ).all<ChatMessageRecord>(conversationId)
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
        user_id, channel_key, preview_text, latest_task_title, latest_task_summary, attachment_names_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        lineage_root_id = excluded.lineage_root_id,
        resume_title = excluded.resume_title,
        title = excluded.title,
        source_kind = excluded.source_kind,
        source_id = excluded.source_id,
        thread_key = excluded.thread_key,
        user_id = excluded.user_id,
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
    if (!this.db) return undefined
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
    if (!this.db) return {}
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

  listAgentSchedules(): AgentScheduleRecord[] {
    if (!this.db) return []
    return this.db
      .prepare('SELECT * FROM agent_schedules ORDER BY updated_at DESC')
      .all<AgentScheduleRecord>()
  }

  getAgentSchedule(id: string): AgentScheduleRecord | null {
    if (!this.db) return null
    const row = this.db
      .prepare('SELECT * FROM agent_schedules WHERE id = ? LIMIT 1')
      .get<AgentScheduleRecord>(id)
    return row ?? null
  }

  upsertAgentSchedule(payload: {
    id: string
    name: string
    cronExpr: string
    prompt: string
    channelId?: string | null
    enabled: boolean
    payloadJson?: string | null
    nextRunAt?: string | null
  }): AgentScheduleRecord {
    if (!this.db) throw new Error('Database not available')
    const now = new Date().toISOString()
    const existing = this.getAgentSchedule(payload.id)
    this.db.prepare(
      `INSERT INTO agent_schedules
       (id, name, cron_expr, prompt, channel_id, enabled, payload_json, last_run_at, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         cron_expr = excluded.cron_expr,
         prompt = excluded.prompt,
         channel_id = excluded.channel_id,
         enabled = excluded.enabled,
         payload_json = excluded.payload_json,
         next_run_at = excluded.next_run_at,
         updated_at = excluded.updated_at`
    ).run(
      payload.id,
      payload.name,
      payload.cronExpr,
      payload.prompt,
      payload.channelId ?? null,
      payload.enabled ? 1 : 0,
      payload.payloadJson ?? null,
      existing?.last_run_at ?? null,
      payload.nextRunAt ?? existing?.next_run_at ?? null,
      existing?.created_at ?? now,
      now,
    )
    return this.getAgentSchedule(payload.id)!
  }

  setAgentScheduleEnabled(id: string, enabled: boolean): AgentScheduleRecord | null {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('UPDATE agent_schedules SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), id)
    return this.getAgentSchedule(id)
  }

  markAgentScheduleRun(id: string, nextRunAt?: string | null): AgentScheduleRecord | null {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare(
      'UPDATE agent_schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?'
    ).run(new Date().toISOString(), nextRunAt ?? null, new Date().toISOString(), id)
    return this.getAgentSchedule(id)
  }

  deleteAgentSchedule(id: string): boolean {
    if (!this.db) return false
    const result = this.db.prepare('DELETE FROM agent_schedules WHERE id = ?').run(id) as {
      changes?: number
    }
    return (result.changes ?? 0) > 0
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
