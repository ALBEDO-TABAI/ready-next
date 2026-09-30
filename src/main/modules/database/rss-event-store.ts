import { randomUUID } from 'node:crypto'
import { assertDatabaseConnectionReady, type DatabaseConnection } from './connection'
import { RSSEventDecisionSchema, RSSEventReadSchema, RSSEventMoveSchema, RSSEventMergeSchema,
  RSSReadEventsSchema, RSSSeenFactsSchema, RSS_EVENT_METHOD, type RSSReadEventsInput, type RSSReadEventsResult,
  type RSSEventContext, type RSSEventDecision, type RSSEventMembership, type RSSEventMember, type RSSEventSummary, type RSSEventFact,
  type RSSEventReadInput, type RSSEventReadResult, type RSSEventMoveInput, type RSSEventMergeInput } from '../../../shared/rss-events'

export const RSS_EVENT_ARTICLE_REVISION_SQL = "i.content_revision || ':' || CASE WHEN c.item_revision=i.content_revision THEN COALESCE(c.body_revision,'none') ELSE 'none' END"
const REVISION = RSS_EVENT_ARTICLE_REVISION_SQL
export function rssEventMethodCurrentSQL(memberAlias = 'm', evidenceAlias = 'e'): string {
  return `(${memberAlias}.manual=1 OR ${evidenceAlias}.method='${RSS_EVENT_METHOD}')`
}
export function rssEventCurrentEvidenceSQL(memberAlias = 'm', evidenceAlias = 'e'): string {
  return `${evidenceAlias}.withdrawn=0 AND ${evidenceAlias}.article_revision=(${REVISION}) AND ${rssEventMethodCurrentSQL(memberAlias, evidenceAlias)}`
}
export function rssEffectiveEventCondition(memberAlias = 'em', evidenceAlias = 'ee'): string {
  return `${evidenceAlias}.fact_id IS NOT NULL AND ${evidenceAlias}.withdrawn=0 AND (${memberAlias}.manual=1 OR (${evidenceAlias}.article_revision=(${REVISION}) AND ${rssEventMethodCurrentSQL(memberAlias, evidenceAlias)}))`
}
export function rssEventRepresentativeOrder(evidence = 'e', memberAlias = 'm'): string {
  return `CASE WHEN ${rssEventCurrentEvidenceSQL(memberAlias, evidence)} THEN 0 ELSE 1 END,
    CASE WHEN ${evidence}.source_role='direct' THEN 0 ELSE 1 END,CASE WHEN c.status='ready' AND c.item_revision=i.content_revision THEN 0 ELSE 1 END,
    COALESCE(i.published_at,i.first_seen_at) DESC,i.id`
}
const JOINS = `FROM rss_event_members m JOIN rss_event_evidence e ON e.id=m.evidence_id LEFT JOIN rss_event_facts f ON f.id=e.fact_id
  JOIN rss_items i ON i.id=m.item_id LEFT JOIN rss_sources s ON s.id=i.source_id LEFT JOIN rss_article_content c ON c.item_id=i.id`
const SELECT = `SELECT m.*,e.relation,COALESCE(m.manual_reason,e.reason) AS reason,e.fact_id,e.article_revision,e.quote,e.source_role,e.captured_at,f.event_id,f.available_at,
  i.title,i.link,i.source_id,s.name AS source_name,i.read,i.starred,i.published_at,${REVISION} AS current_revision,COALESCE(${rssEventMethodCurrentSQL()},0) AS current_method ${JOINS}`
interface MemberRow {
  item_id: string; event_id: string | null; fact_id: string | null; article_revision: string; current_revision: string
  quote: string | null; source_role: RSSEventDecision['sourceRole']; relation: RSSEventMembership['relation']; manual: number
  reason: string; revision: number; captured_at: number; available_at: number | null; current_method: number
  title: string; link: string; source_id: string; source_name: string | null; read: number; starred: number; published_at: number | null
}
function membership(row: MemberRow): RSSEventMembership {
  return { eventId: row.event_id, factId: row.fact_id, revision: row.revision, articleRevision: row.article_revision, quote: row.quote,
    sourceRole: row.source_role, relation: row.relation, manual: row.manual === 1, reason: row.reason, stale: row.article_revision !== row.current_revision || row.current_method !== 1 }
}
function member(row: MemberRow): RSSEventMember {
  return { ...membership(row), itemId: row.item_id, title: row.title, link: row.link, sourceId: row.source_id, source: row.source_name || row.source_id,
    read: row.read === 1, starred: row.starred === 1, publishedAt: row.published_at === null ? null : row.published_at * 1000, factAvailableAt: row.available_at }
}

export class RSSEventStore {
  constructor(private readonly getConnection: () => DatabaseConnection | null) {}
  private get db(): DatabaseConnection { const db = this.getConnection(); assertDatabaseConnectionReady(db, 'RSS event database'); return db }
  private transaction<T>(action: () => T): T {
    this.db.exec('SAVEPOINT rss_event')
    try { const result = action(); this.db.exec('RELEASE rss_event'); return result }
    catch (error) { this.db.exec('ROLLBACK TO rss_event; RELEASE rss_event'); throw error }
  }
  private material(itemId: string) {
    const row = this.db.prepare(`SELECT i.title,i.link,i.source_id,COALESCE(s.name,i.source_id) AS source_name,i.published_at,${REVISION} AS revision,
      CASE WHEN c.item_revision=i.content_revision AND c.status IN ('ready','partial') THEN c.markdown ELSE i.summary END AS text
      FROM rss_items i LEFT JOIN rss_sources s ON s.id=i.source_id LEFT JOIN rss_article_content c ON c.item_id=i.id WHERE i.id=?`)
      .get<{ title: string; revision: string; text: string | null; link: string; source_id: string; source_name: string; published_at: number | null }>(itemId)
    if (!row) throw new Error('文章不存在。')
    return row
  }
  memberships(itemIds: readonly string[]): Record<string, RSSEventMembership> {
    const result: Record<string, RSSEventMembership> = {}
    for (let offset = 0; offset < itemIds.length; offset += 500) {
      const ids = itemIds.slice(offset, offset + 500)
      for (const row of this.db.prepare(`${SELECT} WHERE m.item_id IN (${ids.map(() => '?').join(',')}) AND e.withdrawn=0`).all<MemberRow>(...ids)) result[row.item_id] = membership(row)
    }
    return result
  }
  summary(eventId: string): RSSEventSummary {
    const event = this.db.prepare('SELECT revision FROM rss_events WHERE id=?').get<{ revision: number }>(eventId)
    const best = this.facts(eventId, 0, 1)[0]
    if (!event || !best) throw new Error('事件不存在或已无可读依据。')
    const counts = this.db.prepare(`SELECT COUNT(*) AS memberCount,COUNT(DISTINCT i.source_id) AS sourceCount,COALESCE(SUM(i.read=0),0) AS unreadCount,
      COALESCE(SUM(i.starred=1),0) AS starredCount,COALESCE(SUM(NOT (${rssEventCurrentEvidenceSQL()})),0) AS staleCount ${JOINS} WHERE f.event_id=? AND e.withdrawn=0`)
      .get<Pick<RSSEventSummary, 'memberCount' | 'sourceCount' | 'unreadCount' | 'starredCount' | 'staleCount'>>(eventId)!
    const facts = this.db.prepare('SELECT COUNT(DISTINCT f.id) AS factCount,COUNT(DISTINCT CASE WHEN f.seen_at IS NULL THEN f.id END) AS unseenFactCount,MAX(f.available_at) AS latestAt FROM rss_event_facts f JOIN rss_event_evidence e ON e.fact_id=f.id WHERE f.event_id=? AND e.withdrawn=0')
      .get<Pick<RSSEventSummary, 'factCount' | 'latestAt' | 'unseenFactCount'>>(eventId)!
    const representative = this.db.prepare(`${SELECT} WHERE f.event_id=? AND e.withdrawn=0 ORDER BY ${rssEventRepresentativeOrder()} LIMIT 1`).get<MemberRow>(eventId)
    return { id: eventId, revision: event.revision, title: representative?.title || best.title, representativeId: representative?.item_id || best.itemId, ...counts, ...facts }
  }
  private facts(eventId: string, offset: number, limit: number, preferredFact = ''): RSSEventFact[] {
    return this.db.prepare(`WITH ranked AS (SELECT f.id,f.available_at AS availableAt,f.seen_at IS NOT NULL AS seen,e.id AS evidenceId,e.item_id AS itemId,e.article_revision AS articleRevision,
      e.quote,e.title,e.source_url AS link,e.source_name AS source,e.source_role AS sourceRole,e.published_at AS publishedAt,
      NOT COALESCE((${rssEventCurrentEvidenceSQL()}),0) AS historical,ROW_NUMBER() OVER (PARTITION BY f.id ORDER BY ${rssEventRepresentativeOrder()},e.captured_at DESC,e.id) AS rank
      FROM rss_event_facts f JOIN rss_event_evidence e ON e.fact_id=f.id JOIN rss_items i ON i.id=e.item_id LEFT JOIN rss_article_content c ON c.item_id=i.id
      LEFT JOIN rss_event_members m ON m.item_id=e.item_id AND m.evidence_id=e.id
      WHERE f.event_id=? AND e.withdrawn=0)
      SELECT * FROM ranked WHERE rank=1 ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,availableAt DESC,id LIMIT ? OFFSET ?`)
      .all<Omit<RSSEventFact, 'historical' | 'seen'> & { historical: number; seen: number; rank: number }>(eventId, preferredFact, limit, offset)
      .map(({ rank: _rank, ...row }) => ({ ...row, historical: row.historical === 1, seen: row.seen === 1, publishedAt: row.publishedAt === null ? null : row.publishedAt * 1000 }))
  }
  markSeen(input: { factIds: string[] }): { changed: number; seenIds: string[] } {
    const { factIds } = RSSSeenFactsSchema.parse(input)
    return this.transaction(() => {
      const predicate = `id IN (${factIds.map(() => '?').join(',')}) AND EXISTS(SELECT 1 FROM rss_event_evidence e WHERE e.fact_id=rss_event_facts.id AND e.withdrawn=0)`
      const result = this.db.prepare(`UPDATE rss_event_facts SET seen_at=? WHERE ${predicate} AND seen_at IS NULL`).run(Date.now(), ...factIds) as { changes: number }
      const seenIds = this.db.prepare(`SELECT id FROM rss_event_facts WHERE ${predicate} AND seen_at IS NOT NULL`).all<{ id: string }>(...factIds).map((row) => row.id)
      return { changed: result.changes, seenIds }
    })
  }
  read(input: RSSEventReadInput): RSSEventReadResult {
    const params = RSSEventReadSchema.parse(input), summary = this.summary(params.eventId)
    if (params.expectedRevision !== undefined && params.expectedRevision !== summary.revision) throw new Error('事件已变化，请重新读取。')
    const members = this.db.prepare(`${SELECT} WHERE f.event_id=? AND e.withdrawn=0 ORDER BY f.available_at,e.fact_id,${rssEventRepresentativeOrder()} LIMIT ? OFFSET ?`)
      .all<MemberRow>(params.eventId, params.limit, params.offset).map(member)
    return { summary, members, total: summary.memberCount, nextOffset: params.offset + members.length < summary.memberCount ? params.offset + members.length : null }
  }
  readFacts(input: RSSEventReadInput): { summary: RSSEventSummary; facts: RSSEventFact[]; total: number; nextOffset: number | null } {
    const params = RSSEventReadSchema.parse(input), summary = this.summary(params.eventId)
    if (params.expectedRevision !== undefined && params.expectedRevision !== summary.revision) throw new Error('事件已变化，请重新读取。')
    const facts = this.facts(params.eventId, params.offset, params.limit)
    return { summary, facts, total: summary.factCount, nextOffset: params.offset + facts.length < summary.factCount ? params.offset + facts.length : null }
  }
  browse(input: RSSReadEventsInput = {}): RSSReadEventsResult {
    const params = RSSReadEventsSchema.parse(input)
    if (params.view !== 'list') {
      const query = { eventId: params.eventId!, expectedRevision: params.expectedRevision, offset: params.offset, limit: params.limit }
      if (params.view === 'facts') { const data = this.readFacts(query); return { ...data, view: 'facts', revision: data.summary.revision } }
      const data = this.read(query); return { ...data, view: 'members', revision: data.summary.revision }
    }
    return this.transaction(() => {
      const revision = this.db.prepare('SELECT revision FROM rss_workspace_state WHERE id=1').get<{ revision: number }>()!.revision
      if (params.expectedRevision !== undefined && params.expectedRevision !== revision) throw new Error('事件目录已变化，请重新读取。')
      const pattern = `%${params.search.replace(/[\\%_]/g, (value) => `\\${value}`)}%`
      const predicate = `FROM rss_event_facts f JOIN rss_event_evidence e ON e.fact_id=f.id WHERE e.withdrawn=0 AND (e.title || char(10) || e.quote) LIKE ? ESCAPE '\\'`
      const total = this.db.prepare(`SELECT COUNT(DISTINCT f.event_id) AS n ${predicate}`).get<{ n: number }>(pattern)!.n
      const events = this.db.prepare(`SELECT f.event_id AS id ${predicate} GROUP BY f.event_id ORDER BY MAX(f.available_at) DESC,f.event_id LIMIT ? OFFSET ?`)
        .all<{ id: string }>(pattern, params.limit, params.offset).map(({ id }) => this.summary(id))
      return { view: 'list', revision, total, events, nextOffset: params.offset + events.length < total ? params.offset + events.length : null }
    })
  }
  context(itemId: string, now: number, allowReuse = true): RSSEventContext {
    const current = this.memberships([itemId])[itemId], since = now - 30 * 86400000, candidateLimit = 20
    const reused = allowReuse && this.canReuse(itemId, this.material(itemId).revision)
    if (current?.manual || reused) return { membershipRevision: current?.revision || 0, manual: current?.manual || false, reused, candidates: [], since, candidateLimit, truncated: false }
    const rows = this.db.prepare(`SELECT f.event_id AS id FROM rss_event_evidence e JOIN rss_event_facts f ON f.id=e.fact_id
      WHERE e.withdrawn=0 AND e.captured_at>=? GROUP BY f.event_id ORDER BY MAX(e.captured_at) DESC,f.event_id LIMIT ?`).all<{ id: string }>(since, candidateLimit + 1)
    const ids = [...new Set([...(current?.eventId ? [current.eventId] : []), ...rows.map((row) => row.id)])]
    const candidates = ids.slice(0, candidateLimit).map((id) => {
      const summary = this.summary(id)
      const facts = this.facts(id, 0, 3, current?.factId || '').map((fact) => ({ id: fact.id, evidenceId: fact.evidenceId, itemId: fact.itemId,
        articleRevision: fact.articleRevision, quote: fact.quote, title: fact.title.slice(0, 500), titleTruncated: fact.title.length > 500,
        link: fact.link.slice(0, 2000), linkTruncated: fact.link.length > 2000, publishedAt: fact.publishedAt, historical: fact.historical }))
      return { id, revision: summary.revision, title: summary.title.slice(0, 500), titleTruncated: summary.title.length > 500, factsTruncated: summary.factCount > facts.length, facts }
    })
    return { membershipRevision: current?.revision || 0, manual: current?.manual || false, reused: false, candidates, since, candidateLimit, truncated: ids.length > candidateLimit }
  }
  canReuse(itemId: string, articleRevision: string): boolean {
    return !!this.db.prepare(`SELECT m.item_id FROM rss_event_members m JOIN rss_event_evidence e ON e.id=m.evidence_id
      WHERE m.item_id=? AND m.manual=0 AND e.article_revision=? AND e.method=? AND e.withdrawn=0`).get(itemId, articleRevision, RSS_EVENT_METHOD)
  }
  restore(itemId: string, articleRevision: string): boolean {
    if (this.material(itemId).revision !== articleRevision) throw new Error('文章已变化，不能恢复旧归属。')
    if (this.memberships([itemId])[itemId]?.manual) return true
    const saved = this.db.prepare(`SELECT id,withdrawn FROM rss_event_evidence WHERE item_id=? AND article_revision=? AND method=? ORDER BY rowid DESC LIMIT 1`)
      .get<{ id: string; withdrawn: number }>(itemId, articleRevision, RSS_EVENT_METHOD)
    // A withdrawn latest decision cannot be replaced by an older, previously superseded decision.
    if (!saved || saved.withdrawn) return false
    this.db.prepare(`INSERT INTO rss_event_members(item_id,evidence_id,manual) VALUES (?,?,0)
      ON CONFLICT(item_id) DO UPDATE SET evidence_id=excluded.evidence_id,manual_reason=NULL,revision=revision+1
      WHERE evidence_id<>excluded.evidence_id`).run(itemId, saved.id)
    return true
  }
  private createEvent(): string { const id = randomUUID(); this.db.prepare('INSERT INTO rss_events(id) VALUES (?)').run(id); return id }
  private createFact(eventId: string, availableAt = Date.now(), originFactId?: string): string {
    const id = randomUUID(); this.db.prepare('INSERT INTO rss_event_facts(id,event_id,available_at,origin_fact_id) VALUES (?,?,?,?)').run(id, eventId, availableAt, originFactId || id); return id
  }
  private write(itemId: string, articleRevision: string, factId: string | null, quote: string | null, role: RSSEventDecision['sourceRole'], relation: RSSEventMembership['relation'], reason: string, manual: boolean): void {
    const evidenceId = randomUUID(), material = this.material(itemId)
    if (material.revision !== articleRevision) throw new Error('文章已变化。')
    this.db.prepare(`INSERT INTO rss_event_evidence(id,item_id,article_revision,method,fact_id,quote,title,source_id,source_name,source_url,published_at,source_role,captured_at,relation,reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(evidenceId, itemId, articleRevision, manual ? 'manual' : RSS_EVENT_METHOD, factId, quote, material.title, material.source_id, material.source_name, material.link, material.published_at, role, Date.now(), relation, reason)
    this.db.prepare(`INSERT INTO rss_event_members(item_id,evidence_id,manual) VALUES (?,?,?)
      ON CONFLICT(item_id) DO UPDATE SET evidence_id=excluded.evidence_id,manual=excluded.manual,manual_reason=NULL,revision=revision+1`)
      .run(itemId, evidenceId, Number(manual))
  }
  apply(itemId: string, articleRevision: string, context: RSSEventContext, input: RSSEventDecision): 'saved' | 'manual_preserved' {
    const decision = RSSEventDecisionSchema.parse(input)
    return this.transaction(() => {
      const material = this.material(itemId), current = this.memberships([itemId])[itemId]
      if (material.revision !== articleRevision) throw new Error('文章已变化。')
      if (current?.manual) return 'manual_preserved'
      if (context.reused) throw new Error('本次事件结果已复用，不接受额外判断。')
      if ((current?.revision || 0) !== context.membershipRevision) throw new Error('事件归属已变化。')
      if (decision.kind !== 'insufficient' && (!decision.quote || !material.title.includes(decision.quote) && !material.text?.includes(decision.quote))) throw new Error('事件依据不在原文中。')
      let factId: string | null = null
      if (decision.kind === 'duplicate' || decision.kind === 'progress') {
        const candidate = context.candidates.find((event) => event.id === decision.eventId)
        if (!candidate) throw new Error('事件不在本次候选中。')
        if (this.summary(candidate.id).revision !== candidate.revision) throw new Error('候选事件已变化。')
        for (const fact of candidate.facts) {
          const saved = this.db.prepare('SELECT e.article_revision,e.fact_id,e.quote,e.item_id FROM rss_event_evidence e JOIN rss_event_facts f ON f.id=e.fact_id WHERE e.id=? AND f.event_id=? AND e.withdrawn=0')
            .get<{ article_revision: string; fact_id: string; quote: string; item_id: string }>(fact.evidenceId, candidate.id)
          if (!saved || saved.fact_id !== fact.id || saved.article_revision !== fact.articleRevision || saved.quote !== fact.quote || saved.item_id !== fact.itemId) throw new Error('候选依据已变化。')
        }
        if (decision.kind === 'duplicate') {
          if (!candidate.facts.some((fact) => fact.id === decision.factId)) throw new Error('事实不在本次候选中。')
          factId = decision.factId
        } else {
          if (decision.factId !== null) throw new Error('新进展不能冒用已有事实。')
          factId = this.createFact(candidate.id)
        }
      } else {
        if (decision.eventId !== null || decision.factId !== null) throw new Error('独立事件或证据不足不能指定候选。')
        if (decision.kind === 'new') factId = this.createFact(this.createEvent())
        else if (decision.quote !== null) throw new Error('证据不足不能发布事件事实。')
      }
      this.db.prepare("UPDATE rss_event_evidence SET withdrawn=1 WHERE item_id=? AND article_revision=? AND method<>'manual' AND withdrawn=0").run(itemId, articleRevision)
      this.write(itemId, articleRevision, factId, decision.quote, decision.sourceRole,
        decision.kind === 'insufficient' ? null : decision.kind === 'new' ? 'original' : decision.kind, decision.reason, false)
      return 'saved'
    })
  }
  move(input: RSSEventMoveInput): RSSEventMembership {
    const params = RSSEventMoveSchema.parse(input)
    return this.transaction(() => {
      const material = this.material(params.itemId), current = this.memberships([params.itemId])[params.itemId]
      if (material.revision !== params.expectedArticleRevision || (current?.revision || 0) !== params.expectedMembershipRevision) throw new Error('文章或归属已变化。')
      const quote = params.quote ?? (current && !current.stale ? current.quote : null)
      if (!quote || !material.title.includes(quote) && !material.text?.includes(quote)) throw new Error('请提供来自当前标题或正文的归组依据摘句。')
      const sameFact = current && !current.stale && current.quote === quote
      if (params.targetEventId && this.summary(params.targetEventId).revision !== params.expectedEventRevision) throw new Error('目标事件已变化。')
      const target = params.targetEventId || this.createEvent()
      let factId = params.targetFactId || null
      if (factId && !this.db.prepare('SELECT f.id FROM rss_event_facts f JOIN rss_event_evidence e ON e.fact_id=f.id WHERE f.id=? AND f.event_id=? AND e.withdrawn=0 LIMIT 1').get(factId, target)) throw new Error('目标事实不存在。')
      if (!factId) {
        const others = current?.factId ? this.db.prepare('SELECT COUNT(*) AS n FROM rss_event_evidence WHERE fact_id=? AND (item_id<>? OR article_revision<>?) AND withdrawn=0').get<{ n: number }>(current.factId, params.itemId, material.revision)!.n : 0
        if (current?.factId && sameFact && !others) { factId = current.factId; this.db.prepare('UPDATE rss_event_facts SET event_id=? WHERE id=?').run(target, factId) }
        else {
          factId = this.createFact(target, current?.factId && sameFact ? this.db.prepare('SELECT MIN(captured_at) AS available_at FROM rss_event_evidence WHERE fact_id=? AND item_id=? AND article_revision=? AND withdrawn=0').get<{ available_at: number }>(current.factId, params.itemId, material.revision)!.available_at : Date.now(), current?.factId && sameFact ? this.db.prepare('SELECT origin_fact_id FROM rss_event_facts WHERE id=?').get<{ origin_fact_id: string }>(current.factId)!.origin_fact_id : undefined)
        }
      }
      if (current?.factId && current.factId !== factId) this.db.prepare('UPDATE rss_event_evidence SET withdrawn=1 WHERE item_id=? AND fact_id=? AND article_revision=?').run(params.itemId, current.factId, material.revision)
      this.write(params.itemId, material.revision, factId, quote, current && !current.stale ? current.sourceRole : 'unknown', params.targetFactId ? 'duplicate' : 'original', '手工调整事件归属', true)
      return this.memberships([params.itemId])[params.itemId]!
    })
  }
  merge(input: RSSEventMergeInput): RSSEventSummary {
    const params = RSSEventMergeSchema.parse(input)
    return this.transaction(() => {
      if (this.summary(params.fromEventId).revision !== params.expectedFromRevision || this.summary(params.intoEventId).revision !== params.expectedIntoRevision) throw new Error('事件已变化。')
      this.db.prepare(`UPDATE rss_event_members SET manual=1,manual_reason='手工合并事件',revision=revision+1 WHERE evidence_id IN
        (SELECT e.id FROM rss_event_evidence e JOIN rss_event_facts f ON f.id=e.fact_id WHERE f.event_id IN (?,?))`).run(params.fromEventId, params.intoEventId)
      this.db.prepare('UPDATE rss_event_facts SET event_id=? WHERE event_id=?').run(params.intoEventId, params.fromEventId)
      return this.summary(params.intoEventId)
    })
  }
}
