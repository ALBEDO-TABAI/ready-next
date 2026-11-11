import { createHash } from 'node:crypto'
import type { RSSArticleSummary } from '../../../shared/rss-workspace'
import { z } from 'zod'
import type { DatabaseConnection } from './connection'
import { assertDatabaseConnectionReady } from './connection'
import type { RSSContentStore } from './rss-content-store'
import { RSS_EVENT_ARTICLE_REVISION_SQL } from './rss-event-store'
import { SettingsStore } from './settings-store'
import { RSSBehaviorSchema, RSS_FEEDBACK_TARGET, RSSWorkPrivacySchema, RSSWorkPrivacyPatchSchema, RSS_RELEVANCE_METHOD, RSSSieveQuerySchema, RSSSieveSettingsSchema, type RSSSieveSettings, type RSSBehavior, type RSSBehaviorInput,
  type RSSFocus, type RSSRelevance, type RSSWorkPrivacy, type RSSSieveItem, type RSSSieveQuery, type RSSSieveResult } from '../../../shared/rss-sieve'
import { scoreRSSArticle, smoothPreference, type RSSScoreInput } from '../rss-engine/sieve-scoring'

// Shared by the queue and ranking; no persistent view can block later table rebuilds.
export const RSS_SOURCE_PREFERENCE_SQL = `WITH delivered AS (
  SELECT i.id,i.source_id,EXISTS(SELECT 1 FROM rss_behaviors b WHERE b.item_id=i.id AND b.source_id=i.source_id
    AND b.occurred_at>=(unixepoch()-30*86400)*1000
    AND b.action IN ('open','finish','star','highlight','note','fastcard','document')) AS engaged
  FROM rss_items i WHERE i.first_seen_at>=unixepoch()-30*86400
), baseline AS (
  SELECT COALESCE(NULLIF(AVG(engaged),0),0.1) AS rate FROM delivered
), counts AS (
  SELECT source_id,COUNT(*) AS delivered,SUM(engaged) AS engaged FROM delivered GROUP BY source_id
)
SELECT s.id AS source_id,MIN(1.0,MAX(0.0,
  ((COALESCE(c.engaged,0)+10*b.rate)/(COALESCE(c.delivered,0)+10.0))/(((COALESCE(c.engaged,0)+10*b.rate)/(COALESCE(c.delivered,0)+10.0))+b.rate)
  * (2.0*(COALESCE(p.positive,0)+2)/(COALESCE(p.positive,0)+COALESCE(p.negative,0)+4)))) AS value
FROM rss_sources s CROSS JOIN baseline b LEFT JOIN counts c ON c.source_id=s.id
LEFT JOIN rss_source_preferences p ON p.source_id=s.id`

const PRIVACY_KEY = 'rss:sieve-work-privacy'
export class RSSSieveStore {
  constructor(private readonly connection: () => DatabaseConnection | null, private readonly content: RSSContentStore) {}
  private get db(): DatabaseConnection { const db = this.connection(); assertDatabaseConnectionReady(db, 'RSS sieve'); return db }
  private transaction<T>(action: () => T): T {
    this.db.exec('SAVEPOINT rss_sieve')
    try { const value = action(); this.db.exec('RELEASE rss_sieve'); return value }
    catch (error) { this.db.exec('ROLLBACK TO rss_sieve; RELEASE rss_sieve'); throw error }
  }
  preference(kind: 'source' | 'topic', id: string): number {
    return this.db.prepare(`SELECT value FROM ${kind === 'source' ? `(${RSS_SOURCE_PREFERENCE_SQL})` : 'rss_topic_preferences'} WHERE ${kind}_id=?`).get<{value:number}>(id)?.value ?? 0.5
  }
  private adjust(kind: 'source' | 'topic', id: string, delta: number): void {
    const row = this.db.prepare(`SELECT positive,negative FROM rss_${kind}_preferences WHERE ${kind}_id=?`).get<{positive:number;negative:number}>(id)
    const positive = (row?.positive ?? 0) + Math.max(delta, 0), negative = (row?.negative ?? 0) + Math.max(-delta, 0)
    this.db.prepare(`INSERT INTO rss_${kind}_preferences(${kind}_id,positive,negative,value) VALUES(?,?,?,?)
      ON CONFLICT(${kind}_id) DO UPDATE SET positive=excluded.positive,negative=excluded.negative,value=excluded.value`).run(id, positive, negative, smoothPreference(positive, negative))
  }
  behaviors(itemId: string): RSSBehavior[] {
    return this.db.prepare('SELECT * FROM rss_behaviors WHERE item_id=? ORDER BY occurred_at,id').all<{
      id:string;item_id:string;source_id:string;topic_ids_json:string;action:RSSBehavior['action'];reason:RSSBehavior['reason']|null;topic_id:string|null;occurred_at:number
    }>(itemId).map(r => ({ id:r.id,itemId:r.item_id,sourceId:r.source_id,topicIds:JSON.parse(r.topic_ids_json),action:r.action,at:r.occurred_at,
      ...(r.reason ? {reason:r.reason} : {}), ...(r.topic_id ? {topicId:r.topic_id} : {}) }))
  }
  recordBehavior(input: RSSBehaviorInput): RSSBehavior {
    const value = RSSBehaviorSchema.parse(input)
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT item_id FROM rss_behaviors WHERE id=?').get<{item_id:string}>(value.id)
      if (existing) {
        const saved = this.behaviors(existing.item_id).find(b => b.id === value.id)!
        if (JSON.stringify(RSSBehaviorSchema.parse({ id:saved.id,itemId:saved.itemId,at:saved.at,action:saved.action,topicId:saved.topicId,reason:saved.reason })) !== JSON.stringify(value)) throw new Error('行为编号已使用')
        return saved
      }
      const article = this.content.getArticle(value.itemId)
      if (!article) throw new Error('文章不存在')
      const topics = article.classifications.filter(c => c.included && !c.stale && c.kind === 'topic').map(c => c.definitionId)
      if (value.topicId && !topics.includes(value.topicId)) throw new Error('话题不属于此文章')
      this.db.prepare('INSERT INTO rss_behaviors(id,item_id,source_id,topic_ids_json,action,reason,topic_id,occurred_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(value.id,value.itemId,article.sourceId,JSON.stringify(topics),value.action,value.reason ?? null,value.topicId ?? null,value.at)
      const duplicate = this.db.prepare(`SELECT 1 FROM rss_behaviors WHERE item_id=? AND action=? AND reason IS ? AND topic_id IS ? AND id<>? LIMIT 1`)
        .get(value.itemId,value.action,value.reason ?? null,value.topicId ?? null,value.id)
      if (duplicate) return { ...value, sourceId:article.sourceId, topicIds:topics }
      const delta = value.action === 'less' || value.action === 'remove' ? -1 : 1
      const target = value.reason ? RSS_FEEDBACK_TARGET[value.reason] : null
      if (target === 'source' || value.action === 'remove') this.adjust('source', article.sourceId, delta)
      if (!target || target === 'topic') for (const id of value.topicId ? [value.topicId] : topics) this.adjust('topic', id, delta)
      return { ...value, sourceId:article.sourceId, topicIds:topics }
    })
  }
  focus(): RSSFocus { return this.db.prepare('SELECT text,version FROM rss_focus WHERE singleton=1').get<RSSFocus>()! }
  saveFocus(input: { text: string; expectedVersion: number }): RSSFocus {
    const value = z.object({ text:z.string(),expectedVersion:z.number().int().nonnegative() }).strict().parse(input)
    const saved = this.db.prepare('UPDATE rss_focus SET text=?,version=version+1 WHERE singleton=1 AND version=? RETURNING text,version').get<RSSFocus>(value.text,value.expectedVersion)
    if (!saved) throw new Error('我的关注已变化，请重新读取')
    return saved
  }
  privacy(): RSSWorkPrivacy {
    const raw = new SettingsStore(this.connection).getSetting(PRIVACY_KEY)
    return RSSWorkPrivacySchema.parse(raw ? JSON.parse(raw) : {})
  }
  configurePrivacy(input: Partial<RSSWorkPrivacy>): RSSWorkPrivacy {
    const patch = Object.fromEntries(Object.entries(RSSWorkPrivacyPatchSchema.parse(input)).filter(([,value]) => value !== undefined))
    const value = RSSWorkPrivacySchema.parse({ ...this.privacy(), ...patch })
    new SettingsStore(this.connection).setSetting(PRIVACY_KEY, JSON.stringify(value)); return value
  }
  excludedPages(): string[] { return this.db.prepare('SELECT object_id FROM rss_work_excluded_pages ORDER BY object_id').all<{object_id:string}>().map(r => r.object_id) }
  excludePage(input: { objectId: string; excluded: boolean }): string[] {
    const value = z.object({ objectId:z.string().min(1),excluded:z.boolean() }).strict().parse(input)
    if (value.excluded) this.db.prepare('INSERT OR IGNORE INTO rss_work_excluded_pages VALUES(?)').run(value.objectId)
    else this.db.prepare('DELETE FROM rss_work_excluded_pages WHERE object_id=?').run(value.objectId)
    return this.excludedPages()
  }
  recordDelivery(itemId: string, now: number): boolean {
    return Boolean(this.db.prepare('INSERT OR IGNORE INTO rss_notification_deliveries VALUES(?,?) RETURNING item_id').get(itemId,now))
  }
  delivery(itemId: string): number | null { return this.db.prepare('SELECT delivered_at FROM rss_notification_deliveries WHERE item_id=?').get<{delivered_at:number}>(itemId)?.delivered_at ?? null }
  relevance(itemId: string): RSSRelevance | null {
    const row = this.db.prepare(`SELECT r.* FROM rss_relevance r
      JOIN rss_processing_jobs j ON j.id=r.job_id JOIN rss_items i ON i.id=r.item_id
      LEFT JOIN rss_article_content c ON c.item_id=i.id JOIN rss_definitions d ON d.id='curated'
      WHERE r.item_id=? AND j.status='success' AND r.method=?
        AND r.article_revision=(${RSS_EVENT_ARTICLE_REVISION_SQL}) AND r.base_rule_revision=d.rule_revision
      ORDER BY j.finished_at DESC,j.rowid DESC LIMIT 1`).get<{
        score:number;because:RSSRelevance['because'];reason:string;work_ref:string|null;work_kind:RSSRelevance['workKind']|null;summary_only:number
      }>(itemId,RSS_RELEVANCE_METHOD)
    return row ? { score:row.score,because:row.because,reason:row.reason,workRef:row.work_ref,
      ...(row.work_kind ? {workKind:row.work_kind} : {}),summaryOnly:row.summary_only === 1 } : null
  }

  rank(candidates: RSSArticleSummary[], now = Date.now(), topicId?: string): RSSSieveItem[] {
    const articles: RSSSieveItem[] = [], inputs = new Map<string, RSSScoreInput>()
    const sources = new Map(this.db.prepare(RSS_SOURCE_PREFERENCE_SQL).all<{source_id:string;value:number}>().map(row => [row.source_id,row.value]))
    const recentTopics = new Set(this.db.prepare(`SELECT DISTINCT topics.value AS topic_id FROM rss_behaviors b,json_each(b.topic_ids_json) topics
      WHERE b.occurred_at>=? AND b.occurred_at<=?
        AND (b.action IN ('star','highlight','fastcard','document') OR (b.action='more' AND b.reason IN ('topic','known')))
        AND (b.topic_id IS NULL OR b.topic_id=topics.value)`)
      .all<{topic_id:string}>(now-30*86400000,now).map(row => row.topic_id))
    for (const article of candidates) {
        const memberships = article.classifications.filter(c => !c.stale && (!topicId || c.definitionId === topicId))
        const included = memberships.filter(c => c.included)
        const topics = included.filter(c => c.kind === 'topic').sort((a,b) => this.preference('topic',b.definitionId)-this.preference('topic',a.definitionId))
        const supported = included.filter(c => c.origin === 'manual' || Boolean(c.evidence))
        const topic = topics.find(c => supported.includes(c)) ?? supported[0]
        const manual = memberships.some(c => c.origin === 'manual' && c.included === false && (topicId || c.kind === 'curated')) ? false
          : memberships.some(c => c.origin === 'manual' && c.included && (topicId || c.kind === 'curated')) ? true : null
        const relevance = this.relevance(article.id)
        const scoring: RSSScoreInput = { relevance,recentTopicInterest:topics.some(c => recentTopics.has(c.definitionId)),sourcePreference:sources.get(article.sourceId) ?? 0.5,
          topicPreference:topics.length ? topics.reduce((sum,c) => sum + this.preference('topic',c.definitionId),0) / topics.length : 0.5,
          ageHours:(now - (article.publishedAt ?? article.collectedAt)) / 3600000,duplicate:false,manual,topicName:topic?.name ?? '', standardIncluded:supported.length > 0 }
        inputs.set(article.id, scoring)
        const sieve = scoreRSSArticle(scoring)
        articles.push({ ...article,relevance,sieve })
    }
    const rank = (a:RSSSieveItem,b:RSSSieveItem) => Number(b.sieve.pinned)-Number(a.sieve.pinned) || b.sieve.score-a.sieve.score || (b.publishedAt ?? b.collectedAt)-(a.publishedAt ?? a.collectedAt) || a.id.localeCompare(b.id)
    articles.sort(rank)
    const events = new Set<string>()
    for (const item of articles) {
      const eventId = !item.event?.stale ? item.event?.eventId : null
      if (!eventId || !item.sieve.eligible) continue
      if (events.has(eventId) && !item.sieve.pinned) item.sieve = scoreRSSArticle({ ...inputs.get(item.id)!, duplicate:true })
      events.add(eventId)
    }
    articles.sort(rank)
    return articles
  }
  settings(): RSSSieveSettings {
    const raw = new SettingsStore(this.connection).getSetting('rss:sieve-settings')
    return RSSSieveSettingsSchema.parse(raw ? JSON.parse(raw) : { explore: true })
  }

  saveSettings(input: RSSSieveSettings): RSSSieveSettings {
    const settings = RSSSieveSettingsSchema.parse(input)
    new SettingsStore(this.connection).setSetting('rss:sieve-settings', JSON.stringify(settings))
    return settings
  }

  private explore(articles: RSSSieveItem[], threshold: number, now: number, topicId?: string): RSSSieveItem | undefined {
    if (!this.settings().explore) return undefined
    const date = new Date(now)
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const settings = new SettingsStore(this.connection)
    const raw = settings.getSetting('rss:sieve-explore-choice')
    const saved = raw ? z.object({ day: z.string(), itemId: z.string() }).strict().parse(JSON.parse(raw)) : null
    const candidates = articles.filter(item => item.sieve.score < threshold && item.inboxVisible &&
      !item.classifications.some(c => !c.stale && c.origin === 'manual' && !c.included &&
        (topicId ? c.definitionId === topicId : c.kind === 'curated')))
    let itemId = saved?.day === day ? saved.itemId : undefined
    if (itemId === undefined) {
      const choices = candidates.map(item => ({ item, hash: createHash('sha256').update(`${day}:${item.id}`).digest('hex') }))
      choices.sort((a, b) => a.hash.localeCompare(b.hash) || a.item.id.localeCompare(b.item.id))
      itemId = choices[0]?.item.id
      if (itemId === undefined) return undefined
      settings.setSetting('rss:sieve-explore-choice', JSON.stringify({ day, itemId }))
    }
    const item = candidates.find(candidate => candidate.id === itemId)
    return item ? { ...item, sieve: { ...item.sieve, explore: true, reason: '换换口味' } } : undefined
  }

  query(input: RSSSieveQuery = {}, now = Date.now(), recordExposure = true, includeExplore = true): RSSSieveResult {
    const params = RSSSieveQuerySchema.parse(input)
    const candidates: RSSArticleSummary[] = []
    let cursor: string | undefined
    do {
      const page = this.content.query({ filter: 'unread', from: now - 48 * 3600000, until: now + 1, categoryId: params.topicId, limit: 100, cursor })
      candidates.push(...page.items)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    const articles = this.rank(candidates, now, params.topicId)
    const items = articles.filter(a => a.sieve.eligible && a.sieve.score >= params.threshold).slice(0, 12)
    const explore = includeExplore ? this.explore(articles, params.threshold, now, params.topicId) : undefined
    if (explore) items.push(explore)
    const chosen = new Set(items.map(a => a.id))
    const remaining = articles.filter(a => !chosen.has(a.id)).sort((a, b) => (b.publishedAt ?? b.collectedAt) - (a.publishedAt ?? a.collectedAt) || a.id.localeCompare(b.id))
    if (recordExposure && !params.topicId && params.threshold === 60) {
      const save = this.db.prepare('INSERT OR IGNORE INTO rss_sieve_exposures VALUES(?,?)')
      for (const item of items) save.run(item.id, now)
    }
    return { items, remaining, remainingCount: remaining.length }
  }

  today(now = Date.now()): RSSSieveItem[] {
    const items = this.query({}, now, false, false).items.slice(0, 5)
    for (const item of items) this.db.prepare('INSERT OR IGNORE INTO rss_sieve_exposures VALUES(?,?)').run(item.id, now)
    return items
  }
}
