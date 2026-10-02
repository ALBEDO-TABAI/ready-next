import { createHash, randomUUID } from 'node:crypto'
import { assertDatabaseConnectionReady, type DatabaseConnection } from './connection'
import type { RSSContentStore } from './rss-content-store'
import type { RSSOrganizationStore } from './rss-organization-store'
import { RSS_EVENT_ARTICLE_REVISION_SQL, type RSSEventStore } from './rss-event-store'
import type { RSSEventContext } from '../../../shared/rss-events'
import { SettingsStore } from './settings-store'
import { RSS_PROCESSING_METHOD, RSS_PROCESSING_SETTINGS_KEY, RSSProcessingSettingsSchema, RSSProcessingListSchema,
  type RSSProcessingSettings, type RSSProcessingJob, type RSSProcessingListInput, type RSSProcessingList,
  type RSSProcessingStatus, type RSSJudgment } from '../../../shared/rss-processing'

interface JobRow {
  event_requested: number; event_reprocess: number; event_context_json: string | null
  id: string; item_id: string; title: string; article_revision: string; method: string; definitions_json: string
  trigger_kind: RSSProcessingJob['trigger']; status: RSSProcessingJob['status']; message: string | null
  created_at: number; started_at: number | null; finished_at: number | null
}
function job(row: JobRow): Omit<RSSProcessingJob, 'inputCurrent' | 'savedDecisionCount'> {
  return { eventReprocess: row.event_reprocess === 1, eventRequested: row.event_requested === 1, id: row.id, itemId: row.item_id, title: row.title, articleRevision: row.article_revision, method: row.method,
    definitions: JSON.parse(row.definitions_json), trigger: row.trigger_kind, status: row.status, message: row.message,
    createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at }
}

export class RSSProcessingStore {
  private readonly listeners = new Set<() => void>()
  constructor(private readonly getConnection: () => DatabaseConnection | null, private readonly content: RSSContentStore, private readonly organization: RSSOrganizationStore, private readonly events: RSSEventStore) {}
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
    return { settings, callsToday, pending: counts.pending || 0, running: counts.running || 0, unresolved: this.unresolvedItemIds().length,
      blocked: !hasModel ? 'model' : callsToday >= settings.dailyLimit ? 'limit' : !settings.enabled ? 'disabled' : null }
  }
  private present(row: JobRow): RSSProcessingJob {
    const value = job(row)
    const article = this.db.prepare(`SELECT ${RSS_EVENT_ARTICLE_REVISION_SQL} AS revision FROM rss_items i LEFT JOIN rss_article_content c ON c.item_id=i.id WHERE i.id=?`).get<{ revision: string }>(row.item_id)
    const definitions = this.organization.list()
    const inputCurrent = row.method === RSS_PROCESSING_METHOD && article?.revision === row.article_revision
      && value.definitions.every((target) => definitions.some((d) => d.id === target.id && d.ruleRevision === target.ruleRevision))
    const savedDecisionCount = this.db.prepare('SELECT COUNT(*) AS n FROM rss_classification_results WHERE job_id=?').get<{ n: number }>(row.id)!.n
    return { ...value, inputCurrent, savedDecisionCount }
  }
  get(id: string): (RSSProcessingJob & { eventContext: RSSEventContext | null }) | null {
    const row = this.db.prepare('SELECT * FROM rss_processing_jobs WHERE id=?').get<JobRow>(id)
    return row ? { ...this.present(row), eventContext: row.event_context_json ? JSON.parse(row.event_context_json) : null } : null
  }
  list(input: RSSProcessingListInput = {}): RSSProcessingList {
    const { itemId, offset, limit, snapshot: requestedSnapshot } = RSSProcessingListSchema.parse(input)
    const snapshot = requestedSnapshot ?? this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM rss_processing_jobs').get<{ n: number }>()!.n
    const where = ` WHERE rowid<=?${itemId ? ' AND item_id=?' : ''}`, args = itemId ? [snapshot, itemId] : [snapshot]
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM rss_processing_jobs${where}`).get<{ n: number }>(...args)!.n
    const jobs = this.db.prepare(`SELECT * FROM rss_processing_jobs${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all<JobRow>(...args, limit, offset).map((row) => this.present(row))
    return { jobs, total, nextOffset: offset + jobs.length < total ? offset + jobs.length : null, snapshot }
  }
  enqueue(itemId: string, trigger: RSSProcessingJob['trigger'], expectedRevision?: string): string[] {
    let restored = false
    const ids = this.transaction(() => {
      const article = this.content.getArticle(itemId)
      if (!article || expectedRevision && expectedRevision !== article.revision) throw new Error('文章已变化，请重新读取后整理。')
      if (trigger === 'automatic' && !this.settings().enabled) return []
      const definitions = this.organization.list().filter((d) => ['topic', 'curated'].includes(d.kind)).sort((a, b) => a.id.localeCompare(b.id))
      const previousEvent = this.events.memberships([itemId])[itemId]
      const ids: string[] = []
      for (let i = 0; i < definitions.length; i += 8) {
        const targets = definitions.slice(i, i + 8).map(({ id, name, description, ruleRevision }) => ({ id, name, description, ruleRevision }))
        const eventReprocess = i === 0 && trigger === 'manual' && !previousEvent?.manual && this.events.canReuse(itemId, article.revision)
        const eventRequested = i === 0 && !previousEvent?.manual && (eventReprocess || !this.events.canReuse(itemId, article.revision))
        const fingerprint = createHash('sha256').update(JSON.stringify([itemId, article.revision, RSS_PROCESSING_METHOD, targets.map((d) => [d.id, d.ruleRevision])])).digest('hex')
        const previous = this.db.prepare(`SELECT id,status FROM rss_processing_jobs WHERE fingerprint=? ORDER BY created_at DESC,id DESC`).all<{ id: string; status: string }>(fingerprint)
        const active = previous.find((p) => ['queued', 'running'].includes(p.status))
        if (active) {
          const current = this.get(active.id)!
          if (trigger === 'manual' && current.status === 'queued' && current.trigger === 'automatic') {
            this.finish(current.id, 'canceled', '已由本篇的手工整理请求接替。', Date.now())
          } else { ids.push(active.id); continue }
        }
        if (trigger === 'automatic' && previous.length) {
          restored = this.organization.restore(itemId, article.revision, targets) || restored
          if (i === 0) this.events.restore(itemId, article.revision)
          continue
        }
        const id = randomUUID()
        this.db.prepare(`INSERT INTO rss_processing_jobs(id,item_id,title,article_revision,fingerprint,method,definitions_json,trigger_kind,status,created_at,event_requested,event_reprocess)
          VALUES (?,?,?,?,?,?,?,?,'queued',?,?,?)`).run(id, itemId, article.title, article.revision, fingerprint, RSS_PROCESSING_METHOD, JSON.stringify(targets), trigger, Date.now(), Number(eventRequested), Number(eventReprocess))
        ids.push(id)
      }
      return ids
    })
    if (ids.length || restored) this.changed()
    return ids
  }
  // Latest run per article ended failed or unknown, and the article still exists.
  private unresolvedItemIds(): string[] {
    return this.db.prepare(`SELECT item_id FROM (
        SELECT item_id,status,ROW_NUMBER() OVER (PARTITION BY item_id ORDER BY created_at DESC,id DESC) AS position FROM rss_processing_jobs
      ) latest WHERE position=1 AND status IN ('failed','unknown') AND item_id IN (SELECT id FROM rss_items) ORDER BY item_id`)
      .all<{ item_id: string }>().map((row) => row.item_id)
  }
  /** User-confirmed re-run of unresolved articles at their current version; the daily limit still applies. */
  retryUnresolved(expectedCount: number): { queued: number; jobIds: string[] } {
    const itemIds = this.unresolvedItemIds()
    if (itemIds.length !== expectedCount) throw new Error('待重新整理的范围已变化，请重新查看数量后再确认。')
    const jobIds = itemIds.flatMap((itemId) => this.enqueue(itemId, 'manual'))
    return { queued: itemIds.length, jobIds }
  }
  next(): RSSProcessingJob | null {
    const row = this.db.prepare(`SELECT * FROM rss_processing_jobs WHERE status='queued' AND (?=1 OR trigger_kind='manual') ORDER BY created_at,id LIMIT 1`).get<JobRow>(Number(this.settings().enabled))
    return row ? this.present(row) : null
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
  eventContext(value: RSSProcessingJob, now: number): RSSEventContext | undefined { return value.eventRequested ? this.events.context(value.itemId, now, !value.eventReprocess) : undefined }
  claim(id: string, now: number, hasModel: boolean, eventContext?: RSSEventContext): RSSProcessingJob | null {
    return this.transaction(() => {
      const value = this.get(id), status = this.status(now, hasModel)
      if (!value || value.status !== 'queued' || !hasModel || status.callsToday >= status.settings.dailyLimit || !status.settings.enabled && value.trigger === 'automatic') return null
      if (!this.isCurrent(value)) { this.finish(id, 'stale', '文章或分类标准已变化，请选择是否重新整理。', now); return null }
      if (value.eventRequested && (!eventContext || (this.events.memberships([value.itemId])[value.itemId]?.revision || 0) !== eventContext.membershipRevision)) throw new Error('事件判断上下文未绑定或已变化。')
      this.db.prepare("UPDATE rss_processing_jobs SET status='running',started_at=?,message=NULL,event_context_json=? WHERE id=? AND status='queued'").run(now, eventContext ? JSON.stringify(eventContext) : null, id)
      return this.get(id)
    })
  }
  publish(id: string, result: RSSJudgment, now: number): boolean {
    return this.transaction(() => {
      const value = this.get(id)
      if (!value || value.status !== 'running') return false
      if (!this.isCurrent(value)) { this.finish(id, 'stale', '文章或分类标准已变化，本次结果未发布。', now); return false }
      this.organization.applyDerived(value.itemId, value.articleRevision, value.definitions, result.decisions, value.id)
      if (value.eventRequested) {
        if (!value.eventContext) throw new Error('缺少已发送的事件上下文。')
        if (!value.eventContext.manual && !value.eventContext.reused && !this.events.memberships([value.itemId])[value.itemId]?.manual) {
          if (!result.event) throw new Error('缺少本次事件判断。')
          this.events.apply(value.itemId, value.articleRevision, value.eventContext, result.event)
        }
      }
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
