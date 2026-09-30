import { createHash, randomUUID } from 'node:crypto'
import { assertDatabaseConnectionReady, type DatabaseConnection } from './connection'
import type { RSSContentStore } from './rss-content-store'
import type { RSSOrganizationStore } from './rss-organization-store'
import { SettingsStore } from './settings-store'
import { RSS_PROCESSING_METHOD, RSS_PROCESSING_SETTINGS_KEY, RSSProcessingSettingsSchema, RSSProcessingListSchema,
  type RSSProcessingSettings, type RSSProcessingJob, type RSSProcessingListInput, type RSSProcessingList,
  type RSSProcessingStatus, type RSSJudgment } from '../../../shared/rss-processing'

interface JobRow {
  id: string; item_id: string; title: string; article_revision: string; method: string; definitions_json: string
  trigger_kind: RSSProcessingJob['trigger']; status: RSSProcessingJob['status']; message: string | null
  created_at: number; started_at: number | null; finished_at: number | null
}
function job(row: JobRow): RSSProcessingJob {
  return { id: row.id, itemId: row.item_id, title: row.title, articleRevision: row.article_revision, method: row.method,
    definitions: JSON.parse(row.definitions_json), trigger: row.trigger_kind, status: row.status, message: row.message,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at }
}

export class RSSProcessingStore {
  private readonly listeners = new Set<() => void>()
  constructor(private readonly getConnection: () => DatabaseConnection | null, private readonly content: RSSContentStore, private readonly organization: RSSOrganizationStore) {}
  private get db(): DatabaseConnection {
    const db = this.getConnection(); assertDatabaseConnectionReady(db, 'RSS processing database'); return db
  }
  onChanged(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  changed(): void { for (const listener of this.listeners) listener() }
  private transaction<T>(action: () => T): T {
    const db = this.db; db.exec('SAVEPOINT rss_processing')
    try { const result = action(); db.exec('RELEASE rss_processing'); return result }
    catch (error) { db.exec('ROLLBACK TO rss_processing; RELEASE rss_processing'); throw error }
  }
  settings(): RSSProcessingSettings {
    const value = new SettingsStore(this.getConnection).getSetting(RSS_PROCESSING_SETTINGS_KEY)
    return value ? RSSProcessingSettingsSchema.parse(JSON.parse(value)) : { enabled: true, dailyLimit: 100 }
  }
  configure(input: RSSProcessingSettings): RSSProcessingSettings {
    const value = RSSProcessingSettingsSchema.parse(input)
    new SettingsStore(this.getConnection).setSetting(RSS_PROCESSING_SETTINGS_KEY, JSON.stringify(value))
    this.changed(); return value
  }
  status(now: number, hasModel: boolean): RSSProcessingStatus {
    const settings = this.settings(), start = new Date(now); start.setHours(0, 0, 0, 0)
    const callsToday = this.db.prepare('SELECT COUNT(*) AS n FROM rss_processing_jobs WHERE started_at>=? AND started_at<=?').get<{ n: number }>(start.getTime(), now)!.n
    const counts = this.db.prepare("SELECT SUM(status='queued') AS pending,SUM(status='running') AS running FROM rss_processing_jobs").get<{ pending: number | null; running: number | null }>()!
    return { settings, callsToday, pending: counts.pending || 0, running: counts.running || 0,
      blocked: !hasModel ? 'model' : callsToday >= settings.dailyLimit ? 'limit' : !settings.enabled ? 'disabled' : null }
  }
  get(id: string): RSSProcessingJob | null {
    const row = this.db.prepare('SELECT * FROM rss_processing_jobs WHERE id=?').get<JobRow>(id); return row ? job(row) : null
  }
  list(input: RSSProcessingListInput = {}): RSSProcessingList {
    const { itemId, offset, limit, snapshot: requestedSnapshot } = RSSProcessingListSchema.parse(input)
    const snapshot = requestedSnapshot ?? this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM rss_processing_jobs').get<{ n: number }>()!.n
    const where = ` WHERE rowid<=?${itemId ? ' AND item_id=?' : ''}`, args = itemId ? [snapshot, itemId] : [snapshot]
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM rss_processing_jobs${where}`).get<{ n: number }>(...args)!.n
    const jobs = this.db.prepare(`SELECT * FROM rss_processing_jobs${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all<JobRow>(...args, limit, offset).map(job)
    return { jobs, total, nextOffset: offset + jobs.length < total ? offset + jobs.length : null, snapshot }
  }
  enqueue(itemId: string, trigger: RSSProcessingJob['trigger'], expectedRevision?: string): string[] {
    const ids = this.transaction(() => {
      const article = this.content.getArticle(itemId)
      if (!article || expectedRevision && expectedRevision !== article.revision) throw new Error('文章已变化，请重新读取后整理。')
      if (trigger === 'automatic' && !this.settings().enabled) return []
      const definitions = this.organization.list().filter((d) => ['topic', 'curated'].includes(d.kind)).sort((a, b) => a.id.localeCompare(b.id))
      const ids: string[] = []
      for (let i = 0; i < definitions.length; i += 8) {
        const targets = definitions.slice(i, i + 8).map(({ id, name, description, ruleRevision }) => ({ id, name, description, ruleRevision }))
        const fingerprint = createHash('sha256').update(JSON.stringify([itemId, article.revision, RSS_PROCESSING_METHOD, targets.map((d) => [d.id, d.ruleRevision])])).digest('hex')
        const previous = this.db.prepare(`SELECT id,status FROM rss_processing_jobs WHERE fingerprint=? ORDER BY created_at DESC,id DESC`).all<{ id: string; status: string }>(fingerprint)
        const active = previous.find((p) => ['queued', 'running'].includes(p.status))
        if (active) {
          const current = this.get(active.id)!
          if (trigger === 'manual' && current.status === 'queued' && current.trigger === 'automatic') {
            this.finish(current.id, 'canceled', '已由本篇的手工整理请求接替。', Date.now())
          } else { ids.push(active.id); continue }
        }
        if (trigger === 'automatic' && previous.length) continue
        const id = randomUUID()
        this.db.prepare(`INSERT INTO rss_processing_jobs(id,item_id,title,article_revision,fingerprint,method,definitions_json,trigger_kind,status,created_at)
          VALUES (?,?,?,?,?,?,?,?,'queued',?)`).run(id, itemId, article.title, article.revision, fingerprint, RSS_PROCESSING_METHOD, JSON.stringify(targets), trigger, Date.now())
        ids.push(id)
      }
      return ids
    })
    if (ids.length) this.changed()
    return ids
  }
  next(): RSSProcessingJob | null {
    const row = this.db.prepare(`SELECT * FROM rss_processing_jobs WHERE status='queued' AND (?=1 OR trigger_kind='manual') ORDER BY created_at,id LIMIT 1`).get<JobRow>(Number(this.settings().enabled))
    return row ? job(row) : null
  }
  enqueueBodyChange(itemId: string): void {
    const article = this.content.getArticle(itemId)
    if (!article) return
    // Reading a historical article is not authorization to reprocess it. Only extend the same automatically admitted source version.
    if (this.db.prepare("SELECT id FROM rss_processing_jobs WHERE item_id=? AND trigger_kind='automatic' AND article_revision LIKE ? LIMIT 1")
      .get(itemId, `${article.sourceRevision}:%`)) this.enqueue(itemId, 'automatic')
  }
  isCurrent(value: RSSProcessingJob): boolean {
    if (value.method !== RSS_PROCESSING_METHOD || this.content.getArticle(value.itemId)?.revision !== value.articleRevision) return false
    const definitions = this.organization.list()
    return value.definitions.every((target) => definitions.some((d) => d.id === target.id && d.ruleRevision === target.ruleRevision))
  }
  claim(id: string, now: number, hasModel: boolean): RSSProcessingJob | null {
    return this.transaction(() => {
      const value = this.get(id), status = this.status(now, hasModel)
      if (!value || value.status !== 'queued' || !hasModel || status.callsToday >= status.settings.dailyLimit || !status.settings.enabled && value.trigger === 'automatic') return null
      if (!this.isCurrent(value)) { this.finish(id, 'stale', '文章或分类标准已变化，请选择是否重新整理。', now); return null }
      this.db.prepare("UPDATE rss_processing_jobs SET status='running',started_at=?,message=NULL WHERE id=? AND status='queued'").run(now, id)
      return this.get(id)
    })
  }
  publish(id: string, result: RSSJudgment, now: number): boolean {
    return this.transaction(() => {
      const value = this.get(id)
      if (!value || value.status !== 'running') return false
      if (!this.isCurrent(value)) { this.finish(id, 'stale', '文章或分类标准已变化，本次结果未发布。', now); return false }
      this.organization.applyDerived(value.itemId, value.articleRevision, value.definitions, result.decisions)
      this.finish(id, 'success', '整理完成', now)
      return true
    })
  }
  finish(id: string, status: Exclude<RSSProcessingJob['status'], 'queued' | 'running'>, message: string, now: number): void {
    this.db.prepare("UPDATE rss_processing_jobs SET status=?,message=?,finished_at=? WHERE id=? AND status IN ('queued','running')").run(status, message, now, id)
  }
  cancel(id: string, now: number): void { this.finish(id, 'canceled', '已取消；已发出的调用仍计入限额。', now); this.changed() }
  recover(): void {
    this.db.prepare("UPDATE rss_processing_jobs SET status='unknown',message='应用关闭前已发出请求，结果未知；不会自动重试。',finished_at=? WHERE status='running'").run(Date.now())
  }
}
