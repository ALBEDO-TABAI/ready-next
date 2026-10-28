import type { DatabaseConnection } from './connection'
import { assertDatabaseConnectionReady } from './connection'
import type {
  RSSArticleTranslation, RSSTranslationBlock, RSSTranslationLanguage, RSSTranslationStatus,
} from '../../../shared/rss-translation'

interface TranslationRow {
  item_id: string; target_lang: RSSTranslationLanguage; body_revision: string; status: RSSTranslationStatus
  request_id: string | null; total: number; done: number; blocks_json: string; error: string | null; updated_at: number
}

/** One translation per article and language, bound to the body revision it was made from. */
export class RSSTranslationStore {
  constructor(private readonly getConnection: () => DatabaseConnection | null) {}

  private connection(): DatabaseConnection {
    const db = this.getConnection()
    assertDatabaseConnectionReady(db, 'RSS translation database')
    return db
  }

  get(itemId: string, targetLang: RSSTranslationLanguage): RSSArticleTranslation | null {
    const row = this.connection().prepare('SELECT * FROM rss_article_translations WHERE item_id=? AND target_lang=?')
      .get<TranslationRow>(itemId, targetLang)
    return row ? {
      itemId: row.item_id, targetLang: row.target_lang, bodyRevision: row.body_revision, status: row.status,
      done: row.done, total: row.total, blocks: JSON.parse(row.blocks_json) as RSSTranslationBlock[],
      error: row.error, updatedAt: row.updated_at,
    } : null
  }

  begin(input: {
    itemId: string; targetLang: RSSTranslationLanguage; bodyRevision: string; requestId: string; blocks: RSSTranslationBlock[]
  }): void {
    const done = input.blocks.filter((block) => block.state === 'translated').length
    this.connection().prepare(`INSERT INTO rss_article_translations
      (item_id,target_lang,body_revision,status,request_id,total,done,blocks_json,error,updated_at)
      VALUES (?,?,?,'running',?,?,?,?,NULL,?)
      ON CONFLICT(item_id,target_lang) DO UPDATE SET body_revision=excluded.body_revision,status='running',
        request_id=excluded.request_id,total=excluded.total,done=excluded.done,blocks_json=excluded.blocks_json,
        error=NULL,updated_at=excluded.updated_at`)
      .run(input.itemId, input.targetLang, input.bodyRevision, input.requestId, input.blocks.length, done,
        JSON.stringify(input.blocks), Date.now())
  }

  /** Writes only while this request still owns the row; a replaced or deleted translation ignores late results. */
  progress(itemId: string, targetLang: RSSTranslationLanguage, requestId: string, blocks: RSSTranslationBlock[]): boolean {
    const done = blocks.filter((block) => block.state !== 'pending').length
    return (this.connection().prepare(`UPDATE rss_article_translations SET blocks_json=?,done=?,updated_at=?
      WHERE item_id=? AND target_lang=? AND request_id=?`)
      .run(JSON.stringify(blocks), done, Date.now(), itemId, targetLang, requestId) as { changes?: number }).changes === 1
  }

  finish(itemId: string, targetLang: RSSTranslationLanguage, requestId: string, status: Exclude<RSSTranslationStatus, 'running'>, error: string | null): boolean {
    return (this.connection().prepare(`UPDATE rss_article_translations SET status=?,error=?,request_id=NULL,updated_at=?
      WHERE item_id=? AND target_lang=? AND request_id=?`)
      .run(status, error, Date.now(), itemId, targetLang, requestId) as { changes?: number }).changes === 1
  }

  recoverInterrupted(): void {
    this.connection().prepare(`UPDATE rss_article_translations SET status='cancelled',request_id=NULL,error='interrupted'
      WHERE status='running'`).run()
  }
}
