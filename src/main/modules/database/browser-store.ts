import type { BrowserPowerPreflightAuditRecord } from './records'
import type { DatabaseConnection } from './connection'
import type { BrowserBookmark, BrowserHistoryEntry, BrowserDownload, BrowserTaskRecord } from './records'


function deriveBrowserDomain(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}
export class BrowserStore {
  constructor(private readonly getConnection: () => DatabaseConnection | null) {}

  private get db(): DatabaseConnection | null {
    return this.getConnection()
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

  getBrowserPowerPreflightAudit(id: string): BrowserPowerPreflightAuditRecord | undefined {
    if (!this.db) return undefined
    return this.db.prepare(
      'SELECT * FROM browser_power_preflight_audit WHERE id = ? LIMIT 1',
    ).get<BrowserPowerPreflightAuditRecord>(id)
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
}
