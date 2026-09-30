import { randomUUID } from 'node:crypto'
import { assertDatabaseConnectionReady, type DatabaseConnection } from './connection'
import type { RSSContentStore } from './rss-content-store'
import type { RSSOrganizationStore } from './rss-organization-store'
import { RSS_EVENT_ARTICLE_REVISION_SQL } from './rss-event-store'
import { RSSDigestReadSchema, type RSSDigestReadInput, type RSSDigestReadResult, type RSSDigestHeader, type RSSDigestSource, type RSSDigestCoverageSource, type RSSDigestScheduleState, type RSSDigestSettings, type RSSDigestFetch, type RSSDigestCriteria } from '../../../shared/rss-digests'
import { RSSQuerySchema, type RSSQueryInput } from '../../../shared/rss-workspace'

type ReportRow = { id: string; edition_key: string; version: number; kind: 'daily' | 'range'; window_start: number; window_end: number; timezone: string; created_at: number; query_json: string | null; coverage_json: string; definitions_json: string }

export class RSSDigestStore {
  constructor(private readonly getConnection: () => DatabaseConnection | null, private readonly content: RSSContentStore, private readonly organization: RSSOrganizationStore) {}
  private get db(): DatabaseConnection { const db = this.getConnection(); assertDatabaseConnectionReady(db, 'RSS digest database'); return db }
  transaction<T>(action: () => T): T {
    this.db.exec('SAVEPOINT rss_digest')
    try { const result = action(); this.db.exec('RELEASE rss_digest'); return result }
    catch (error) { this.db.exec('ROLLBACK TO rss_digest; RELEASE rss_digest'); throw error }
  }
  private row(id: string): ReportRow {
    const row = this.db.prepare('SELECT * FROM rss_digests WHERE id=?').get<ReportRow>(id)
    if (!row) throw new Error('刊物不存在。')
    return row
  }
  private header(row: ReportRow): RSSDigestHeader {
    const counts = this.db.prepare('SELECT COUNT(DISTINCT group_key) AS total,COUNT(*) AS referenceCount FROM rss_digest_entries WHERE report_id=?').get<{ total: number; referenceCount: number }>(row.id)!
    const missing = this.db.prepare(`SELECT x.id FROM rss_digest_entries x LEFT JOIN rss_items i ON i.id=x.item_id
      LEFT JOIN rss_article_content c ON c.item_id=i.id LEFT JOIN rss_event_members cm ON cm.item_id=i.id
      LEFT JOIN rss_event_evidence ce ON ce.id=cm.evidence_id LEFT JOIN rss_event_facts cf ON cf.id=ce.fact_id LEFT JOIN rss_event_evidence e ON e.id=x.evidence_id LEFT JOIN rss_event_facts f ON f.id=e.fact_id
      WHERE x.report_id=? AND (i.id IS NULL OR x.article_revision<>(${RSS_EVENT_ARTICLE_REVISION_SQL})
        OR (x.evidence_id IS NOT NULL AND (e.id IS NULL OR e.withdrawn=1 OR f.event_id IS NOT x.event_id))
        OR (CASE WHEN ce.withdrawn=0 AND ce.article_revision=(${RSS_EVENT_ARTICLE_REVISION_SQL}) THEN ce.fact_id END) IS NOT x.fact_id
        OR (CASE WHEN ce.withdrawn=0 AND ce.article_revision=(${RSS_EVENT_ARTICLE_REVISION_SQL}) THEN cf.event_id END) IS NOT x.event_id) LIMIT 1`).get(row.id)
    const definitions = this.organization.list()
    const savedDefinitions = JSON.parse(row.definitions_json) as Array<RSSDigestCriteria & { revision: number }>
    let needsUpdate = !!missing || savedDefinitions.some((saved) => !definitions.some((current) => current.id === saved.id && current.revision === saved.revision))
    if (!needsUpdate) {
      const sources = this.db.prepare('SELECT item_id,payload_json FROM rss_digest_entries WHERE report_id=?').all<{ item_id: string; payload_json: string }>(row.id)
      const current = this.organization.memberships(sources.map((s) => s.item_id))
      needsUpdate = sources.some((source) => {
        const saved = JSON.parse(source.payload_json) as RSSDigestSource
        const selected = (current[source.item_id] || []).filter((m) => m.included && !m.stale)
        return JSON.stringify([saved.curation, saved.topics]) !== JSON.stringify([selected.find((m) => m.kind === 'curated') || null, selected.filter((m) => m.kind === 'topic')])
      })
    }
    const query = row.query_json ? RSSQuerySchema.parse(JSON.parse(row.query_json)) : null
    const scopeLabel = query ? [query.scope === 'library' ? '全部保存资料' : '收件箱',
      ...[query.collectionId, query.categoryId].filter(Boolean).map((id) => savedDefinitions.find((d) => d.id === id)?.name || id),
      query.filter === 'unread' ? '未读' : query.filter === 'starred' ? '收藏' : '', query.search ? `搜索：${query.search}` : '',
      query.from !== undefined ? `从 ${new Date(query.from).toISOString()}` : '', query.until !== undefined ? `至 ${new Date(query.until).toISOString()}` : '',
      query.sourceId ? JSON.parse(this.db.prepare('SELECT payload_json FROM rss_digest_sources WHERE report_id=? AND source_id=?').get<{ payload_json: string }>(row.id, query.sourceId)?.payload_json || '{}').name || query.sourceId : '',
    ].filter(Boolean).join(' · ') : '新增、有效精选且尚未入刊的保存资讯'
    return { id: row.id, kind: row.kind, editionKey: row.edition_key, version: row.version, from: row.window_start, until: row.window_end, timezone: row.timezone, createdAt: row.created_at,
      query, scopeLabel, ruleCount: savedDefinitions.length, coverage: JSON.parse(row.coverage_json), needsUpdate, ...counts }
  }
  schedule(): RSSDigestScheduleState | null {
    const row = this.db.prepare('SELECT * FROM rss_digest_schedule WHERE id=1').get<{ enabled: number; local_time: string; timezone: string; next_run_at: string | null; last_error: string | null }>()
    return row ? { enabled: row.enabled === 1, localTime: row.local_time, timezone: row.timezone, nextRunAt: row.next_run_at, error: row.last_error } : null
  }
  configureSchedule(settings: RSSDigestSettings, timezone: string, nextRunAt: string): void {
    this.db.prepare(`INSERT INTO rss_digest_schedule(id,enabled,local_time,timezone,next_run_at) VALUES (1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,local_time=excluded.local_time,timezone=excluded.timezone,next_run_at=excluded.next_run_at,last_error=NULL`)
      .run(Number(settings.enabled), settings.localTime, timezone, nextRunAt)
  }
  reconcileDaily(cutoff: number | null, previousBoundary: number, nextRunAt: string | null, now: number, fetches: RSSDigestFetch[] = []): void {
    try {
      this.transaction(() => {
        if (cutoff !== null) this.generate({ kind: 'daily', from: this.lastDailyEnd() ?? previousBoundary, until: cutoff, timezone: this.schedule()!.timezone, fetches }, now)
        this.db.prepare('UPDATE rss_digest_schedule SET next_run_at=?,last_error=NULL WHERE id=1').run(nextRunAt)
      })
    } catch (error) {
      // Keep the published cutoff unchanged; expose the same future wake used by the shared clock. Startup/resume retries the latest missing edition.
      this.db.prepare('UPDATE rss_digest_schedule SET next_run_at=?,last_error=? WHERE id=1').run(nextRunAt, error instanceof Error ? error.message : String(error))
    }
  }
  lastDailyEnd(): number | null { return this.db.prepare("SELECT MAX(window_end) AS n FROM rss_digests WHERE kind='daily'").get<{ n: number | null }>()!.n }
  generate(input: { kind: 'daily' | 'range'; from: number; until: number; timezone: string; query?: RSSQueryInput; fetches?: RSSDigestFetch[]; editionKey?: string; regenerate?: boolean }, now = Date.now()): RSSDigestHeader {
    return this.transaction(() => {
      const editionKey = input.editionKey || (input.kind === 'daily' ? `daily:${input.timezone}:${input.until}` : `range:${randomUUID()}`)
      const previous = this.db.prepare('SELECT * FROM rss_digests WHERE edition_key=? ORDER BY version DESC LIMIT 1').get<ReportRow>(editionKey)
      if (previous && !input.regenerate) return this.header(previous)
      const query = input.kind === 'daily' ? { scope: 'library' as const, collectionId: 'curated' } : RSSQuerySchema.parse(input.query)
      const first = this.content.query({ ...query, limit: 100 })
      const items = [...first.items]
      let cursor = first.nextCursor
      while (cursor) { const page = this.content.query({ ...query, limit: 100, cursor, expectedRevision: first.revision }); items.push(...page.items); cursor = page.nextCursor }
      const id = randomUUID(), references: Array<{ groupKey: string; originFactId: string | null; source: RSSDigestSource }> = []
      let suppressed = 0, matchingArticles = 0
      for (const item of items) {
        const available = this.db.prepare('SELECT available_at FROM rss_digest_intake WHERE item_id=? AND article_revision=?').get<{ available_at: number }>(item.id, item.revision)
        if (input.kind === 'daily' && (!available || available.available_at === null || available.available_at >= input.until)) continue
        matchingArticles++
        const article = this.content.getArticle(item.id)!
        const event = article.event && !article.event.stale ? this.db.prepare(`SELECT e.id,e.fact_id,e.quote,e.source_role,f.event_id,f.origin_fact_id FROM rss_event_members m
          JOIN rss_event_evidence e ON e.id=m.evidence_id JOIN rss_event_facts f ON f.id=e.fact_id WHERE m.item_id=? AND e.withdrawn=0`).get<{ id: string; fact_id: string; quote: string; source_role: RSSDigestSource['sourceRole']; event_id: string; origin_fact_id: string }>(item.id) : undefined
        if (input.kind === 'daily' && this.db.prepare(`SELECT x.id FROM rss_digest_entries x JOIN rss_digests r ON r.id=x.report_id
          WHERE r.kind='daily' AND r.edition_key<>? AND (x.origin_fact_id=? OR (x.item_id=? AND x.article_revision=?)) LIMIT 1`).get(editionKey, event?.origin_fact_id || null, item.id, item.revision)) { suppressed++; continue }
        const selected = article.classifications.filter((m) => m.included && !m.stale)
        const text = event?.quote || article.summary || article.body.markdown || article.title
        let quoteEnd = Math.min(text.length, 1200)
        if (quoteEnd < text.length && /[\uD800-\uDBFF]/.test(text[quoteEnd - 1]) && /[\uDC00-\uDFFF]/.test(text[quoteEnd])) quoteEnd--
        references.push({ groupKey: event ? `fact:${event.origin_fact_id}` : `article:${item.id}:${item.revision}`, originFactId: event?.origin_fact_id || null,
          source: { itemId: item.id, articleRevision: item.revision, title: item.title, link: item.link, sourceId: item.sourceId, source: item.source,
            quote: text.slice(0, quoteEnd), quoteKind: event ? 'event_evidence' : article.summary ? 'source_summary' : article.body.markdown ? 'saved_body' : 'title', quoteTruncated: text.length > quoteEnd,
            sourceRole: event?.source_role || 'unknown', bodyStatus: item.bodyStatus, factId: event?.fact_id || null, eventId: event?.event_id || null, evidenceId: event?.id || null,
            availableAt: available?.available_at ?? item.collectedAt, carriedOver: input.kind === 'daily' && available!.available_at < input.from,
            curation: selected.find((m) => m.kind === 'curated') || null, topics: selected.filter((m) => m.kind === 'topic') } })
      }
      const pendingArticles = this.db.prepare(`SELECT COUNT(DISTINCT j.item_id) AS n FROM rss_processing_jobs j JOIN rss_items i ON i.id=j.item_id
        LEFT JOIN rss_article_content c ON c.item_id=i.id WHERE j.status IN ('queued','running') AND j.article_revision=(${RSS_EVENT_ARTICLE_REVISION_SQL})
        AND ${input.kind === 'daily' ? `EXISTS (SELECT 1 FROM rss_digest_intake intake WHERE intake.item_id=i.id AND intake.article_revision=(${RSS_EVENT_ARTICLE_REVISION_SQL}) AND intake.received_at<${input.until})` : 'i.id IN (SELECT value FROM json_each(?))'}`).get<{ n: number }>(...(input.kind === 'range' ? [JSON.stringify(items.map((i) => i.id))] : []))!.n
      const unresolved = this.db.prepare(`SELECT i.id FROM rss_items i LEFT JOIN rss_article_content c ON c.item_id=i.id
        WHERE ${input.kind === 'daily' ? `EXISTS (SELECT 1 FROM rss_digest_intake intake WHERE intake.item_id=i.id AND intake.article_revision=(${RSS_EVENT_ARTICLE_REVISION_SQL}) AND intake.received_at<${input.until})` : 'i.id IN (SELECT value FROM json_each(?))'} AND NOT EXISTS
        (SELECT 1 FROM rss_memberships m JOIN rss_definitions d ON d.id=m.definition_id LEFT JOIN rss_classification_results r ON r.id=m.result_id
          WHERE m.item_id=i.id AND d.kind='curated' AND (m.manual_decision IS NOT NULL OR
          (r.decision IN (0,1) AND r.rule_revision=d.rule_revision AND r.content_revision=(${RSS_EVENT_ARTICLE_REVISION_SQL}))))`)
        .all<{ id: string }>(...(input.kind === 'range' ? [JSON.stringify(items.map((i) => i.id))] : []))
      const failedArticles = this.db.prepare(`SELECT COUNT(DISTINCT j.item_id) AS n FROM rss_processing_jobs j JOIN rss_items i ON i.id=j.item_id
        LEFT JOIN rss_article_content c ON c.item_id=i.id WHERE j.item_id IN (SELECT value FROM json_each(?))
        AND j.article_revision=(${RSS_EVENT_ARTICLE_REVISION_SQL}) AND j.status IN ('failed','unknown','canceled')`).get<{ n: number }>(JSON.stringify(unresolved.map((i) => i.id)))!.n
      const coverage = { matchingArticles, pendingArticles, unresolvedArticles: unresolved.length, failedArticles, missingBodies: references.filter((r) => r.source.bodyStatus !== 'ready').length,
        carriedOverArticles: references.filter((r) => r.source.carriedOver).length, duplicateOrPublishedArticles: suppressed }
      const usedDefinitions = new Set(['curated', first.query.collectionId, first.query.categoryId, ...references.flatMap(({ source }) => [...(source.curation ? [source.curation.definitionId] : []), ...source.topics.map((m) => m.definitionId)])])
      this.db.prepare(`INSERT INTO rss_digests(id,edition_key,version,kind,window_start,window_end,timezone,created_at,query_json,coverage_json,definitions_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, editionKey, (previous?.version || 0) + 1, input.kind, input.from, input.until, input.timezone, now, input.kind === 'range' ? JSON.stringify(first.query) : null,
          JSON.stringify(coverage), JSON.stringify(this.organization.list().filter((d) => usedDefinitions.has(d.id))))
      const save = this.db.prepare('INSERT INTO rss_digest_entries(report_id,position,group_key,item_id,article_revision,fact_id,origin_fact_id,evidence_id,event_id,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
      references.forEach(({ groupKey, originFactId, source }, position) => save.run(id, position, groupKey, source.itemId, source.articleRevision, source.factId, originFactId, source.evidenceId, source.eventId, JSON.stringify(source)))
      for (const source of this.db.prepare(`SELECT id,name,url,last_fetched,enabled FROM rss_sources ${input.kind === 'range' && first.query.sourceId ? 'WHERE id=?' : ''} ORDER BY id`)
        .all<{ id: string; name: string; url: string; last_fetched: number | null; enabled: number }>(...(input.kind === 'range' && first.query.sourceId ? [first.query.sourceId] : []))) {
        const snapshot: RSSDigestCoverageSource = { id: source.id, name: source.name, url: source.url, lastFetchedAt: source.last_fetched === null ? null : source.last_fetched * 1000, enabled: source.enabled === 1, fetch: input.fetches?.find((f) => f.sourceId === source.id) || null }
        this.db.prepare('INSERT INTO rss_digest_sources(report_id,source_id,payload_json) VALUES (?,?,?)').run(id, source.id, JSON.stringify(snapshot))
      }
      return this.header(this.row(id))
    })
  }
  regenerate(reportId: string, now = Date.now(), fetches: RSSDigestFetch[] = []): RSSDigestHeader {
    const row = this.row(reportId)
    const query = row.query_json ? JSON.parse(row.query_json) : undefined
    if (query) { delete query.expectedRevision; delete query.cursor }
    return this.generate({ kind: row.kind, from: row.window_start, until: row.window_end, timezone: row.timezone, query, fetches, editionKey: row.edition_key, regenerate: true }, now)
  }
  read(input: RSSDigestReadInput = {}): RSSDigestReadResult {
    const params = RSSDigestReadSchema.parse(input)
    return this.transaction(() => {
      const next = (total: number, length: number) => params.offset + length < total ? params.offset + length : null
      if (params.view === 'editions') {
        const snapshot = params.snapshot ?? this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM rss_digests').get<{ n: number }>()!.n
        const total = this.db.prepare('SELECT COUNT(*) AS n FROM rss_digests WHERE rowid<=?').get<{ n: number }>(snapshot)!.n
        const editions = this.db.prepare('SELECT * FROM rss_digests WHERE rowid<=? ORDER BY rowid DESC LIMIT ? OFFSET ?').all<ReportRow>(snapshot, params.limit, params.offset).map((r) => this.header(r))
        return { view: 'editions', editions, total, snapshot, nextOffset: next(total, editions.length) }
      }
      const report = this.header(this.row(params.reportId!))
      if (params.view === 'criteria') {
        const saved = JSON.parse(this.row(report.id).definitions_json) as RSSDigestCriteria[]
        const criteria = saved.slice(params.offset, params.offset + params.limit).map(({ id, name, description, ruleRevision, kind }) => ({ id, name, description, ruleRevision, kind }))
        return { view: 'criteria', report, criteria, total: saved.length, nextOffset: next(saved.length, criteria.length) }
      }
      if (params.view === 'coverage') {
        const total = this.db.prepare('SELECT COUNT(*) AS n FROM rss_digest_sources WHERE report_id=?').get<{ n: number }>(report.id)!.n
        const sources = this.db.prepare('SELECT payload_json FROM rss_digest_sources WHERE report_id=? ORDER BY source_id LIMIT ? OFFSET ?').all<{ payload_json: string }>(report.id, params.limit, params.offset).map((r) => JSON.parse(r.payload_json) as RSSDigestCoverageSource)
        return { view: 'coverage', report, sources, total, nextOffset: next(total, sources.length) }
      }
      if (params.view === 'sources') {
        const total = this.db.prepare('SELECT COUNT(*) AS n FROM rss_digest_entries WHERE report_id=? AND group_key=?').get<{ n: number }>(report.id, params.groupKey!)!.n
        if (!total) throw new Error('刊物条目不存在。')
        const sources = this.db.prepare('SELECT payload_json FROM rss_digest_entries WHERE report_id=? AND group_key=? ORDER BY position LIMIT ? OFFSET ?').all<{ payload_json: string }>(report.id, params.groupKey!, params.limit, params.offset).map((r) => JSON.parse(r.payload_json) as RSSDigestSource)
        return { view: 'sources', report, sources, total, nextOffset: next(total, sources.length) }
      }
      const entries = this.db.prepare(`WITH ranked AS (SELECT group_key,payload_json,position,COUNT(*) OVER(PARTITION BY group_key) AS referenceCount,
        ROW_NUMBER() OVER(PARTITION BY group_key ORDER BY CASE WHEN json_extract(payload_json,'$.sourceRole')='direct' THEN 0 ELSE 1 END,
          CASE WHEN json_extract(payload_json,'$.bodyStatus')='ready' THEN 0 ELSE 1 END,position) AS n FROM rss_digest_entries WHERE report_id=?)
        SELECT group_key,payload_json,referenceCount FROM ranked WHERE n=1 ORDER BY COALESCE((SELECT json_extract(value,'$.position')
          FROM json_each((SELECT definitions_json FROM rss_digests WHERE id=?)) WHERE json_extract(value,'$.id')=json_extract(ranked.payload_json,'$.topics[0].definitionId')),2147483647),position LIMIT ? OFFSET ?`).all<{ group_key: string; payload_json: string; referenceCount: number }>(report.id, report.id, params.limit, params.offset)
        .map((r) => { const source = JSON.parse(r.payload_json) as RSSDigestSource; return { section: source.topics[0]?.name || '未分类', groupKey: r.group_key, referenceCount: r.referenceCount, source } })
      return { view: 'entries', report, entries, total: report.total, nextOffset: next(report.total, entries.length) }
    })
  }
}
