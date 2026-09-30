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
  body_status: RSSBodyStatus | null; body_revision: string | null; markdown: string | null
  body_item_revision: string | null; body_fetched_at: number | null; source_url: string | null; error: string | null
}

export interface RSSContentClaim { itemId: string; itemRevision: string; requestId: string }
export interface RSSContentResult {
  status: 'ready' | 'partial' | 'failed' | 'login_required'
  markdown?: string
  sourceUrl: string
  error?: string
}

const ARTICLE_SELECT = `SELECT i.*, s.name AS source_name,
  c.status AS body_status,c.item_revision AS body_item_revision,c.body_revision,c.markdown,
  c.fetched_at AS body_fetched_at,c.source_url,c.error
  FROM rss_items i LEFT JOIN rss_sources s ON s.id=i.source_id
  LEFT JOIN rss_article_content c ON c.item_id=i.id`
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function summary(row: ArticleRow): RSSArticleSummary {
  const currentBody = row.body_item_revision === row.content_revision
  return {
    id: row.id, revision: `${row.content_revision}:${currentBody ? row.body_revision ?? 'none' : 'none'}`,
    sourceId: row.source_id, source: row.source_name || row.source_id, title: row.title, link: row.link,
    summary: row.summary || '', author: row.author, publishedAt: row.published_at === null ? null : row.published_at * 1000,
    collectedAt: row.first_seen_at * 1000, coverImage: row.cover_image,
    read: row.read !== 0, starred: row.starred !== 0, inboxVisible: row.inbox_visible !== 0,
    bodyStatus: row.body_status ? currentBody ? row.body_status : 'stale' : 'missing',
  }
}

export class RSSContentStore {
  constructor(private readonly getConnection: () => DatabaseConnection | null) {}

  private connection(): DatabaseConnection {
    const db = this.getConnection()
    assertDatabaseConnectionReady(db, 'RSS content database')
    return db
  }

  query(input: RSSQueryInput = {}): RSSQueryResult {
    const { cursor, expectedRevision: requestedRevision, ...query } = RSSQuerySchema.parse(input)
    const fingerprint = hash(JSON.stringify(query))
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
    const db = this.connection()
    db.exec('SAVEPOINT rss_read_query')
    try {
      const revision = db.prepare('SELECT revision FROM rss_workspace_state WHERE id=1').get<{ revision: number }>()!.revision
      if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('cursor_stale')
      const where: string[] = [], args: unknown[] = []
      if (query.scope === 'inbox') where.push('(i.inbox_visible=1 OR i.starred=1)')
      if (query.filter === 'unread') where.push('i.read=0')
      if (query.filter === 'starred') where.push('i.starred=1')
      if (query.sourceId) { where.push('i.source_id=?'); args.push(query.sourceId) }
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
      const total = db.prepare(`SELECT COUNT(*) AS count FROM rss_items i LEFT JOIN rss_article_content c ON c.item_id=i.id${predicate}`).get<{ count: number }>(...args)!.count
      const direction = query.sort === 'newest' ? 'DESC' : 'ASC'
      const rows = db.prepare(`${ARTICLE_SELECT}${predicate} ORDER BY COALESCE(i.published_at,i.first_seen_at) ${direction},i.id ${direction} LIMIT ? OFFSET ?`)
        .all<ArticleRow>(...args, query.limit, offset)
      const lastFetch = query.sourceId
        ? db.prepare('SELECT last_fetched AS time FROM rss_sources WHERE id=?').get<{ time: number | null }>(query.sourceId)?.time
        : db.prepare('SELECT MAX(last_fetched) AS time FROM rss_sources').get<{ time: number | null }>()?.time
      const nextOffset = offset + rows.length
      return {
        query, revision, total, lastFetchAt: lastFetch == null ? null : lastFetch * 1000, items: rows.map(summary),
        nextCursor: nextOffset < total ? Buffer.from(JSON.stringify({ offset: nextOffset, revision, query: fingerprint })).toString('base64url') : null,
      }
    } finally { db.exec('RELEASE rss_read_query') }
  }

  getArticle(itemId: string): RSSArticle | null {
    const row = this.connection().prepare(`${ARTICLE_SELECT} WHERE i.id=?`).get<ArticleRow>(itemId)
    if (!row) return null
    const item = summary(row)
    const currentBody = row.body_item_revision === row.content_revision
    return {
      ...item,
      body: {
        status: item.bodyStatus, revision: currentBody ? row.body_revision : null,
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

  beginLoad(itemId: string): RSSContentClaim | null {
    const db = this.connection()
    const requestId = randomUUID()
    const result = db.prepare(`INSERT INTO rss_article_content(item_id,item_revision,status,request_id,source_url)
      SELECT id,content_revision,'loading',?,link FROM rss_items WHERE id=?
      ON CONFLICT(item_id) DO UPDATE SET item_revision=excluded.item_revision,status='loading',request_id=excluded.request_id,
        source_url=excluded.source_url,body_revision=NULL,markdown=NULL,error=NULL
      WHERE rss_article_content.status<>'loading' OR rss_article_content.item_revision<>excluded.item_revision
      RETURNING item_revision`).get<{ item_revision: string }>(requestId, itemId)
    return result ? { itemId, itemRevision: result.item_revision, requestId } : null
  }

  finishLoad(claim: RSSContentClaim, result: RSSContentResult): boolean {
    const text = result.markdown ?? null
    if ((result.status === 'ready' || result.status === 'partial') && !text?.trim()) throw new Error('body_empty')
    const updated = this.connection().prepare(`UPDATE rss_article_content
      SET status=?,markdown=?,body_revision=?,source_url=?,fetched_at=?,error=?,request_id=NULL
      WHERE item_id=? AND item_revision=? AND request_id=? AND status='loading'
        AND EXISTS(SELECT 1 FROM rss_items WHERE id=? AND content_revision=?)`).run(
      result.status, text, text === null ? null : hash(text), result.sourceUrl, Date.now(), result.error ?? null,
      claim.itemId, claim.itemRevision, claim.requestId, claim.itemId, claim.itemRevision,
    ) as { changes: number }
    return updated.changes === 1
  }

  recoverInterruptedLoads(): void {
    this.connection().prepare(`UPDATE rss_article_content SET status='failed',request_id=NULL,error='interrupted'
      WHERE status='loading'`).run()
  }
}
