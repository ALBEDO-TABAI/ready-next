import { createHash } from 'node:crypto'
import { RSSReadCatalogSchema, type RSSReadCatalogInput } from '../../../shared/rss-catalog'
import { RSS_PROCESSING_METHOD } from '../../../shared/rss-processing'
import { RSS_EVENT_METHOD } from '../../../shared/rss-events'
import type { RSSDefinition } from '../../../shared/rss-organization'
import type { RSSAnalysisJob, RSSSource } from './records'
import type { RSSOrganizationStore } from './rss-organization-store'
import { RSS_EVENT_ARTICLE_REVISION_SQL } from './rss-event-store'
import { assertDatabaseConnectionReady, type DatabaseConnection } from './connection'

export interface RSSCatalogPage {
  view: RSSReadCatalogInput['view']; revision: number; total: number; nextCursor: string | null
  entries: Array<RSSSource | RSSDefinition | RSSAnalysisJob | Record<string, unknown>>
}

const ARTICLE_REVISION = `(${RSS_EVENT_ARTICLE_REVISION_SQL})`

export class RSSCatalogStore {
  constructor(private readonly getConnection: () => DatabaseConnection | null, private readonly organization: RSSOrganizationStore) {}

  read(input: RSSReadCatalogInput): RSSCatalogPage {
    const params = RSSReadCatalogSchema.parse(input)
    const fingerprint = createHash('sha256').update(JSON.stringify([params.view, params.itemId ?? null, params.eventId ?? null])).digest('hex')
    const db = this.getConnection()
    assertDatabaseConnectionReady(db, 'RSS catalog database')
    db.exec('SAVEPOINT rss_catalog_read')
    try {
      const revision = db.prepare('SELECT catalog_revision FROM rss_workspace_state WHERE id=1').get<{ catalog_revision: number }>()!.catalog_revision
      let offset = 0
      if (params.cursor) {
        let cursor: { fingerprint: string; revision: number; offset: number }
        try { cursor = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')) }
        catch { throw new Error('RSS 目录游标无效。') }
        if (!cursor || cursor.fingerprint !== fingerprint || cursor.revision !== revision || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
          throw new Error('RSS 目录已变化或筛选不一致，请重新开始读取。')
        }
        offset = cursor.offset
      }
      let entries: RSSCatalogPage['entries'], total: number
      if (params.view === 'definitions') {
        const definitions = this.organization.list()
        total = definitions.length
        entries = definitions.slice(offset, offset + params.limit)
      } else {
        const args: unknown[] = []
        let from: string, columns: string, order: string, predicate = ''
        if (params.view === 'sources') {
          from = 'rss_sources s'; columns = 's.*'; order = 's.id'
        } else if (params.view === 'analysis') {
          from = 'rss_analysis_jobs a'; columns = 'a.*'; order = 'a.created_at DESC,a.id'
          if (params.itemId) { predicate = ' WHERE a.item_id=?'; args.push(params.itemId) }
        } else if (params.view === 'judgments') {
          from = `rss_classification_results r JOIN rss_items i ON i.id=r.item_id
            JOIN rss_definitions d ON d.id=r.definition_id LEFT JOIN rss_article_content c ON c.item_id=i.id
            LEFT JOIN rss_memberships m ON m.item_id=r.item_id AND m.definition_id=r.definition_id`
          columns = `r.*,d.name AS definition_name,COALESCE(m.result_id=r.id,0) AS selected_automatic_base,
            m.manual_decision,COALESCE(r.content_revision=${ARTICLE_REVISION} AND r.rule_revision=d.rule_revision,0) AS matches_current_content_and_rule,
            COALESCE(r.method=?,0) AS matches_current_method`
          order = 'r.id DESC'
          if (params.itemId) { predicate = ' WHERE r.item_id=?'; args.push(params.itemId) }
        } else {
          from = `rss_event_evidence e LEFT JOIN rss_event_facts f ON f.id=e.fact_id
            JOIN rss_items i ON i.id=e.item_id LEFT JOIN rss_article_content c ON c.item_id=i.id
            LEFT JOIN rss_event_members m ON m.item_id=e.item_id`
          columns = `e.*,f.event_id,f.origin_fact_id,COALESCE(m.evidence_id=e.id AND e.withdrawn=0,0) AS selected_current_evidence,
            m.manual AS current_manual_override,m.manual_reason AS current_manual_reason,COALESCE(e.article_revision=${ARTICLE_REVISION},0) AS matches_current_content,
            (e.method=?) AS matches_current_method`
          order = 'e.captured_at DESC,e.id'
          const where: string[] = []
          if (params.itemId) { where.push('e.item_id=?'); args.push(params.itemId) }
          if (params.eventId) { where.push('f.event_id=?'); args.push(params.eventId) }
          if (where.length) predicate = ` WHERE ${where.join(' AND ')}`
        }
        total = db.prepare(`SELECT COUNT(*) AS total FROM ${from}${predicate}`).get<{ total: number }>(...args)!.total
        const method = params.view === 'judgments' ? [RSS_PROCESSING_METHOD] : params.view === 'evidence' ? [RSS_EVENT_METHOD] : []
        entries = db.prepare(`SELECT ${columns} FROM ${from}${predicate} ORDER BY ${order} LIMIT ? OFFSET ?`)
          .all<Record<string, unknown>>(...method, ...args, params.limit, offset)
      }
      if (offset > total) throw new Error('RSS 目录续读位置无效。')
      const nextOffset = offset + entries.length
      const result: RSSCatalogPage = { view: params.view, revision, total, entries,
        nextCursor: nextOffset < total ? Buffer.from(JSON.stringify({ fingerprint, revision, offset: nextOffset })).toString('base64url') : null }
      db.exec('RELEASE rss_catalog_read')
      return result
    } catch (error) {
      db.exec('ROLLBACK TO rss_catalog_read; RELEASE rss_catalog_read')
      throw error
    }
  }
}
