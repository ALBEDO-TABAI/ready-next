import { RSSReadExcerptSchema, type RSSReadExcerptInput, type RSSSelectionExcerpt } from '../../../shared/rss-excerpt'
import { readingExcerpt } from '../../../shared/rss-reading'
import { rssIncludedClassificationSQL, type RSSOrganizationStore } from './rss-organization-store'
import { rssEffectiveEventCondition, rssEventRepresentativeOrder, type RSSEventStore } from './rss-event-store'
import { rssArticleRevision, type RSSDefinition, type RSSMembership } from '../../../shared/rss-organization'
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseConnection } from './connection'
import { assertDatabaseConnectionReady } from './connection'
import {
  RSSQuerySchema, RSSReadArticleSchema,
  type RSSArticle, type RSSArticleExcerpt, type RSSArticleSummary, type RSSBodyStatus,
  type RSSQueryInput, type RSSQueryResult, type RSSReadArticleInput,
} from '../../../shared/rss-workspace'

interface ArticleRow {
  id: string; content_revision: string; source_id: string; source_name: string | null
  title: string; link: string; summary: string | null; author: string | null
  published_at: number | null; first_seen_at: number; cover_image: string | null
  read: number; starred: number; inbox_visible: number
  request_id: string | null; body_status: RSSBodyStatus | null; body_revision: string | null; markdown: string | null
  body_item_revision: string | null; body_fetched_at: number | null; source_url: string | null; error: string | null
}

export interface RSSContentClaim { itemId: string; itemRevision: string; requestId: string }
export interface RSSContentResult {
  status: 'ready' | 'partial' | 'failed' | 'login_required'
  markdown?: string
  sourceUrl: string
  error?: string
}

const ARTICLE_COLUMNS = `i.*, s.name AS source_name,
  c.status AS body_status,c.item_revision AS body_item_revision,c.body_revision,
  c.fetched_at AS body_fetched_at,c.source_url,c.error,c.request_id`
const ARTICLE_FROM = `FROM rss_items i LEFT JOIN rss_sources s ON s.id=i.source_id
  LEFT JOIN rss_article_content c ON c.item_id=i.id`
const ARTICLE_SELECT = `SELECT ${ARTICLE_COLUMNS},c.markdown ${ARTICLE_FROM}`
const LIST_SELECT = `SELECT ${ARTICLE_COLUMNS},NULL AS markdown ${ARTICLE_FROM}`
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function summary(row: ArticleRow, classifications: RSSMembership[]): RSSArticleSummary {
  const currentBody = row.body_item_revision === row.content_revision
  return {
    id: row.id, revision: rssArticleRevision(row.content_revision, row.body_item_revision, row.body_revision), classifications,
    sourceRevision: row.content_revision,
    sourceId: row.source_id, source: row.source_name || row.source_id, title: row.title, link: row.link,
    summary: row.summary || '', author: row.author, publishedAt: row.published_at === null ? null : row.published_at * 1000,
    collectedAt: row.first_seen_at * 1000, coverImage: row.cover_image,
    read: row.read !== 0, starred: row.starred !== 0, inboxVisible: row.inbox_visible !== 0,
    bodyStatus: row.body_status ? currentBody ? row.body_status : 'stale' : 'missing',
  }
}

function queryPredicate(query: ReturnType<typeof RSSQuerySchema.parse>, definitions: RSSDefinition[]): { predicate: string; args: unknown[] } {
  const where: string[] = [], args: unknown[] = []
  const collection = definitions.find((entry) => entry.id === query.collectionId)
  for (const id of [collection && ['topic', 'curated'].includes(collection.kind) ? collection.id : undefined, query.categoryId].filter(Boolean)) {
    where.push(`EXISTS (SELECT 1 FROM rss_memberships m LEFT JOIN rss_classification_results r ON r.id=m.result_id JOIN rss_definitions d ON d.id=m.definition_id WHERE m.item_id=i.id AND m.definition_id=? AND ${rssIncludedClassificationSQL})`)
    args.push(id)
  }
  if (query.scope === 'inbox') where.push('(i.inbox_visible=1 OR i.starred=1)')
  if (query.filter === 'unread') where.push('i.read=0')
  if (query.filter === 'starred') where.push('i.starred=1')
  if (query.sourceId) { where.push('i.source_id=?'); args.push(query.sourceId) }
  if (query.eventId) { where.push(`EXISTS (SELECT 1 FROM rss_event_members em JOIN rss_event_evidence ee ON ee.id=em.evidence_id JOIN rss_event_facts ef ON ef.id=ee.fact_id WHERE em.item_id=i.id AND ef.event_id=? AND ${rssEffectiveEventCondition()})`); args.push(query.eventId) }
  if (query.from !== undefined) { where.push('COALESCE(i.published_at,i.first_seen_at)*1000>=?'); args.push(query.from) }
  if (query.until !== undefined) { where.push('COALESCE(i.published_at,i.first_seen_at)*1000<?'); args.push(query.until) }
  if (query.search) {
    const pattern = `%${query.search.replace(/[\\%_]/g, (value) => `\\${value}`)}%`
    const text = query.searchIn === 'body'
  ? "CASE WHEN c.item_revision=i.content_revision AND c.status IN ('ready','partial') THEN COALESCE(c.markdown,'') ELSE '' END"
  : "i.title || char(10) || COALESCE(i.summary,'')"
    where.push(`(${text}) LIKE ? ESCAPE '\\'`)
    args.push(pattern)
  }
  const predicate = where.length ? ` WHERE ${where.join(' AND ')}` : ''
  return { predicate, args }
}

export class RSSContentStore {
  constructor(private readonly getConnection: () => DatabaseConnection | null, private readonly organization: RSSOrganizationStore, private readonly onBodySaved?: (itemId: string) => void, private readonly events?: RSSEventStore) {}

  private connection(): DatabaseConnection {
    const db = this.getConnection()
    assertDatabaseConnectionReady(db, 'RSS content database')
    return db
  }

  private normalizeQuery(input: RSSQueryInput, definitions: RSSDefinition[]) {
    const query = RSSQuerySchema.parse(input)
    const collection = definitions.find((entry) => entry.id === query.collectionId)
    if (query.collectionId && !collection) throw new Error('栏目已删除，请选择其他栏目。')
    if (query.categoryId && !definitions.some((entry) => entry.id === query.categoryId && entry.kind === 'topic')) throw new Error('分类已删除，请选择其他分类。')
    if (collection?.kind === 'history') query.scope = 'library'
    if (collection?.kind === 'unread' || collection?.kind === 'starred') { query.scope = 'inbox'; query.filter = collection.kind }
    return query
  }

  query(input: RSSQueryInput = {}): RSSQueryResult {
    return this.queryWindow(input, false)
  }

  cards(input: RSSQueryInput = {}): RSSQueryResult {
    return this.queryWindow(input, true)
  }

  private queryWindow(input: RSSQueryInput, grouped: boolean): RSSQueryResult {
    const db = this.connection()
    db.exec('SAVEPOINT rss_read_query')
    try {
      const definitions = this.organization.list()
      const { cursor, expectedRevision: requestedRevision, ...query } = this.normalizeQuery(input, definitions)
      const fingerprint = hash(JSON.stringify([grouped ? 'cards' : 'articles', query]))
      let offset = 0, expectedRevision: number | undefined = requestedRevision
      if (cursor) {
        let parsed: unknown
        try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { throw new Error('invalid_cursor') }
        const token = parsed as { offset?: number; revision?: number; query?: string } | null
        if (!token || !Number.isSafeInteger(token.offset) || token.offset! < 0 || !Number.isSafeInteger(token.revision)) throw new Error('invalid_cursor')
        if (token.query !== fingerprint) throw new Error('cursor_query_mismatch')
        if (requestedRevision !== undefined && requestedRevision !== token.revision) throw new Error('cursor_stale')
        offset = token.offset!
        expectedRevision = token.revision
      }
      const revision = db.prepare('SELECT revision FROM rss_workspace_state WHERE id=1').get<{ revision: number }>()!.revision
      if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('cursor_stale')
      const { predicate, args } = queryPredicate(query, definitions)
      const total = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(i.read=0),0) AS unread FROM rss_items i LEFT JOIN rss_article_content c ON c.item_id=i.id${predicate}`).get<{ count: number; unread: number }>(...args)!
      const direction = query.sort === 'newest' ? 'DESC' : 'ASC'
      type CardRow = ArticleRow & { group_id?: string | null; matching_count?: number; matching_unread?: number; matching_starred?: number; display_time?: number }
      let rows: CardRow[], cardTotal = total.count
      if (grouped) {
        const eventKey = `CASE WHEN ${rssEffectiveEventCondition()} THEN ef.event_id ELSE NULL END`
        const bucket = `COALESCE('event:' || (${eventKey}),'article:' || i.id)`
        const matches = `WITH matches AS (SELECT i.id,${eventKey} AS group_id,${bucket} AS bucket,
          COUNT(*) OVER (PARTITION BY ${bucket}) AS matching_count,SUM(i.read=0) OVER (PARTITION BY ${bucket}) AS matching_unread,
          SUM(i.starred=1) OVER (PARTITION BY ${bucket}) AS matching_starred,
          ${query.sort === 'newest' ? 'MAX' : 'MIN'}(COALESCE(i.published_at,i.first_seen_at)) OVER (PARTITION BY ${bucket}) AS display_time,
          ROW_NUMBER() OVER (PARTITION BY ${bucket} ORDER BY ${rssEventRepresentativeOrder('ee')}) AS representative
          FROM rss_items i LEFT JOIN rss_article_content c ON c.item_id=i.id
          LEFT JOIN rss_event_members em ON em.item_id=i.id LEFT JOIN rss_event_evidence ee ON ee.id=em.evidence_id LEFT JOIN rss_event_facts ef ON ef.id=ee.fact_id${predicate})`
        cardTotal = db.prepare(`${matches} SELECT COUNT(*) AS n FROM matches WHERE representative=1`).get<{ n: number }>(...args)!.n
        rows = db.prepare(`${matches} SELECT ${ARTICLE_COLUMNS},NULL AS markdown,matched.group_id,matched.matching_count,matched.matching_unread,matched.matching_starred,matched.display_time
          ${ARTICLE_FROM} JOIN matches matched ON matched.id=i.id WHERE matched.representative=1
          ORDER BY matched.display_time ${direction},matched.bucket ${direction} LIMIT ? OFFSET ?`).all<CardRow>(...args, query.limit, offset)
      } else rows = db.prepare(`${LIST_SELECT}${predicate} ORDER BY COALESCE(i.published_at,i.first_seen_at) ${direction},i.id ${direction} LIMIT ? OFFSET ?`)
        .all<CardRow>(...args, query.limit, offset)
      const lastFetch = query.sourceId
        ? db.prepare('SELECT last_fetched AS time FROM rss_sources WHERE id=?').get<{ time: number | null }>(query.sourceId)?.time
        : db.prepare('SELECT MAX(last_fetched) AS time FROM rss_sources').get<{ time: number | null }>()?.time
      const memberships = this.organization.memberships(rows.map((row) => row.id))
      const events = this.events?.memberships(rows.map((row) => row.id)) || {}
      const nextOffset = offset + rows.length
      return {
        query, definitions, revision, total: total.count, ...(grouped ? { cardTotal } : {}), unreadTotal: total.unread, lastFetchAt: lastFetch == null ? null : lastFetch * 1000,
        items: rows.map((row) => ({ ...summary(row, memberships[row.id] || []), ...(events[row.id] ? { event: events[row.id] } : {}),
          ...(row.group_id && this.events ? { eventGroup: { ...this.events.summary(row.group_id), matchingCount: row.matching_count!, matchingUnread: row.matching_unread!, matchingStarred: row.matching_starred!, displayTime: row.display_time! * 1000 } } : {}) })),
        nextCursor: nextOffset < cardTotal ? Buffer.from(JSON.stringify({ offset: nextOffset, revision, query: fingerprint })).toString('base64url') : null,
      }
    } finally { db.exec('RELEASE rss_read_query') }
  }

  dismissQuery(input: RSSQueryInput): { dismissed: number } {
    const definitions = this.organization.list()
    const query = this.normalizeQuery(input, definitions)
    if (query.scope !== 'inbox' || query.cursor || query.expectedRevision === undefined) throw new Error('清空操作需要当前收件箱范围及资料版本。')
    const db = this.connection()
    db.exec('SAVEPOINT rss_dismiss_query')
    try {
      this.query({ ...query, limit: 1 })
      const { predicate, args } = queryPredicate(query, definitions)
      const result = db.prepare(`UPDATE rss_items SET inbox_visible=0 WHERE inbox_visible=1 AND starred=0 AND id IN (
        SELECT i.id FROM rss_items i LEFT JOIN rss_article_content c ON c.item_id=i.id${predicate}
      )`).run(...args) as { changes: number }
      db.exec('RELEASE rss_dismiss_query')
      return { dismissed: result.changes }
    } catch (error) {
      db.exec('ROLLBACK TO rss_dismiss_query; RELEASE rss_dismiss_query')
      throw error
    }
  }

  getArticle(itemId: string): RSSArticle | null {
    const row = this.connection().prepare(`${ARTICLE_SELECT} WHERE i.id=?`).get<ArticleRow>(itemId)
    if (!row) return null
    const item = summary(row, this.organization.memberships([itemId])[itemId] || [])
    const event = this.events?.memberships([itemId])[itemId]
    const currentBody = row.body_item_revision === row.content_revision
    return {
      ...item,
      ...(event ? { event } : {}),
      body: {
        status: item.bodyStatus, fetching: currentBody && !!row.request_id, revision: currentBody ? row.body_revision : null,
        markdown: currentBody ? row.markdown : null, fetchedAt: row.body_fetched_at,
        sourceUrl: currentBody ? row.source_url || row.link : row.link,
        error: currentBody ? row.error : null,
      },
    }
  }

  readArticle(input: RSSReadArticleInput): RSSArticleExcerpt {
    const params = RSSReadArticleSchema.parse(input)
    const article = this.getArticle(params.itemId)
    if (!article) throw new Error('article_not_found')
    if (params.expectedRevision && params.expectedRevision !== article.revision) throw new Error('article_changed')
    const { body: { markdown, ...body }, ...metadata } = article
    const text = markdown ?? article.summary
    if (params.offset > text.length) throw new Error('offset_out_of_range')
    if (params.offset > 0 && /[\uD800-\uDBFF]/.test(text[params.offset - 1]) && /[\uDC00-\uDFFF]/.test(text[params.offset] || '')) throw new Error('offset_inside_surrogate')
    let end = Math.min(text.length, params.offset + params.length)
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end++
    return {
      article: metadata, body, text: text.slice(params.offset, end), textKind: markdown === null ? 'source_summary' : 'body',
      offset: params.offset, totalLength: text.length, nextOffset: end < text.length ? end : null,
    }
  }

  readExcerpt(input: RSSReadExcerptInput): RSSSelectionExcerpt {
    const params = RSSReadExcerptSchema.parse(input)
    const article = this.getArticle(params.itemId)
    if (!article) throw new Error('article_not_found')
    if (article.revision !== params.expectedRevision) throw new Error('article_changed')
    const { body: { markdown, error: _error, ...body }, summary, classifications: _classifications, event: _event, eventGroup: _eventGroup, coverImage: _coverImage, ...metadata } = article
    const text = readingExcerpt(markdown ?? summary, params.range)
    if (params.offset > text.length) throw new Error('offset_out_of_range')
    if (params.offset > 0 && /[\uD800-\uDBFF]/.test(text[params.offset - 1]) && /[\uDC00-\uDFFF]/.test(text[params.offset] || '')) throw new Error('offset_inside_surrogate')
    let end = Math.min(text.length, params.offset + params.length)
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end++
    return { article: metadata, body, text: text.slice(params.offset, end), textKind: 'reading_text', textSource: markdown === null ? 'source_summary' : 'body', range: params.range,
      offset: params.offset, totalLength: text.length, nextOffset: end < text.length ? end : null }
  }

  beginLoad(itemId: string): RSSContentClaim | null {
    const db = this.connection()
    const requestId = randomUUID()
    const result = db.prepare(`INSERT INTO rss_article_content(item_id,item_revision,status,request_id,source_url)
      SELECT id,content_revision,'loading',?,link FROM rss_items WHERE id=?
      ON CONFLICT(item_id) DO UPDATE SET item_revision=excluded.item_revision,request_id=excluded.request_id,error=NULL,
        status=CASE WHEN rss_article_content.item_revision=excluded.item_revision AND body_revision IS NOT NULL THEN rss_article_content.status ELSE 'loading' END,
        source_url=CASE WHEN rss_article_content.item_revision=excluded.item_revision THEN source_url ELSE excluded.source_url END,
        body_revision=CASE WHEN rss_article_content.item_revision=excluded.item_revision THEN body_revision END,
        markdown=CASE WHEN rss_article_content.item_revision=excluded.item_revision THEN markdown END
      WHERE rss_article_content.request_id IS NULL OR rss_article_content.item_revision<>excluded.item_revision
      RETURNING item_revision`).get<{ item_revision: string }>(requestId, itemId)
    return result ? { itemId, itemRevision: result.item_revision, requestId } : null
  }

  finishLoad(claim: RSSContentClaim, result: RSSContentResult): boolean {
    const text = result.markdown ?? null
    if ((result.status === 'ready' || result.status === 'partial') && !text?.trim()) throw new Error('body_empty')
    const db = this.connection()
    db.exec('SAVEPOINT rss_body_save')
    try {
      const updated = db.prepare(`UPDATE rss_article_content
        SET status=CASE WHEN ? IS NULL AND body_revision IS NOT NULL THEN status ELSE ? END,
          markdown=COALESCE(?,markdown),body_revision=COALESCE(?,body_revision),
          source_url=CASE WHEN ? IS NULL AND body_revision IS NOT NULL THEN source_url ELSE ? END,
          fetched_at=CASE WHEN ? IS NULL AND body_revision IS NOT NULL THEN fetched_at ELSE ? END,error=?,request_id=NULL
        WHERE item_id=? AND item_revision=? AND request_id=?
          AND EXISTS(SELECT 1 FROM rss_items WHERE id=? AND content_revision=?)`).run(
        text, result.status, text, text === null ? null : hash(text), text, result.sourceUrl, text, Date.now(), result.error ?? (['failed', 'login_required'].includes(result.status) ? result.status : null),
        claim.itemId, claim.itemRevision, claim.requestId, claim.itemId, claim.itemRevision,
      ) as { changes: number }
      if (updated.changes === 1 && text !== null) this.onBodySaved?.(claim.itemId)
      db.exec('RELEASE rss_body_save')
      return updated.changes === 1
    } catch (error) { db.exec('ROLLBACK TO rss_body_save; RELEASE rss_body_save'); throw error }
  }

  recoverInterruptedLoads(): void {
    this.connection().prepare(`UPDATE rss_article_content SET status=CASE WHEN body_revision IS NOT NULL THEN status ELSE 'failed' END,request_id=NULL,error='interrupted'
      WHERE request_id IS NOT NULL`).run()
  }
}
