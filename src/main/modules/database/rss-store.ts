import type { DatabaseConnection } from './connection'
import type { RSSSource, RSSItem, RSSDraftStoreSourceSummary, RSSStats, RSSAnalysisAction, RSSAnalysisJobStatus, RSSAnalysisJob } from './records'

export class RSSStore {
  constructor(private readonly getConnection: () => DatabaseConnection | null) {}

  private get db(): DatabaseConnection | null {
    return this.getConnection()
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
    ai_tags?: string | null
  }>): number {
    if (!this.db) throw new Error('Database not available')
    let inserted = 0
    const stmt = this.db.prepare(
      `INSERT INTO rss_items
       (id, source_id, guid, title, link, summary, cover_image, author, published_at, ai_tags, inbox_visible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         source_id = excluded.source_id,
         guid = excluded.guid,
         title = excluded.title,
         link = excluded.link,
         summary = excluded.summary,
         cover_image = excluded.cover_image,
         author = excluded.author,
         published_at = excluded.published_at,
         ai_tags = COALESCE(excluded.ai_tags, rss_items.ai_tags),
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
        item.published_at || null,
        item.ai_tags ?? null
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
}
