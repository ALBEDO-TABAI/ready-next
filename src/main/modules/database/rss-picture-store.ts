import { assertDatabaseConnectionReady, type DatabaseConnection } from './connection'

export const RSS_PICTURE_RETRY_AFTER_MS = 6 * 3600 * 1000
export const RSS_PICTURE_MAX_ATTEMPTS = 2

export interface RSSStoredPicture {
  outcome: 'page' | 'none' | 'failed'
  pictureUrl: string | null
  attempts: number
  checkedAt: number
}

export interface RSSPictureDescription {
  itemId: string
  link: string
  feedCover: string | null
  source: { url: string; platform: string }
  picture: RSSStoredPicture | null
}

const PICTURE_JOIN = 'LEFT JOIN rss_item_pictures p ON p.item_id=i.id AND p.link=i.link'

export class RSSPictureStore {
  constructor(private readonly getConnection: () => DatabaseConnection | null) {}

  private get db(): DatabaseConnection {
    const db = this.getConnection()
    assertDatabaseConnectionReady(db, 'RSS picture database')
    return db
  }

  describe(itemIds: string[]): RSSPictureDescription[] {
    if (!itemIds.length) return []
    const rows = this.db.prepare(`SELECT i.id,i.link,NULLIF(i.cover_image,'') AS feed_cover,s.url,s.platform,
      p.outcome,p.picture_url,p.attempts,p.checked_at
      FROM rss_items i JOIN rss_sources s ON s.id=i.source_id ${PICTURE_JOIN}
      WHERE i.id IN (${itemIds.map(() => '?').join(',')})`).all<{
      id: string; link: string; feed_cover: string | null; url: string; platform: string
      outcome: RSSStoredPicture['outcome'] | null; picture_url: string | null; attempts: number; checked_at: number
    }>(...itemIds)
    return rows.map(row => ({
      itemId: row.id, link: row.link, feedCover: row.feed_cover, source: { url: row.url, platform: row.platform },
      picture: row.outcome === null ? null : { outcome: row.outcome, pictureUrl: row.picture_url, attempts: row.attempts, checkedAt: row.checked_at },
    }))
  }

  candidates(limit: number, now: number): string[] {
    return this.db.prepare(`SELECT i.id FROM rss_items i ${PICTURE_JOIN}
      WHERE NULLIF(i.cover_image,'') IS NULL AND (p.item_id IS NULL OR
        (p.outcome='failed' AND p.attempts<? AND p.checked_at<=?))
      ORDER BY COALESCE(i.published_at,i.first_seen_at) DESC,i.id LIMIT ?`)
      .all<{ id: string }>(RSS_PICTURE_MAX_ATTEMPTS, now - RSS_PICTURE_RETRY_AFTER_MS, limit).map(row => row.id)
  }

  save(input: { itemId: string; link: string; outcome: RSSStoredPicture['outcome']; pictureUrl: string | null; now: number }): void {
    this.db.prepare(`INSERT INTO rss_item_pictures(item_id,link,outcome,picture_url,checked_at)
      VALUES(?,?,?,?,?)
      ON CONFLICT(item_id) DO UPDATE SET link=excluded.link,outcome=excluded.outcome,picture_url=excluded.picture_url,
        checked_at=excluded.checked_at,attempts=CASE WHEN rss_item_pictures.link=excluded.link THEN rss_item_pictures.attempts+1 ELSE 1 END`)
      .run(input.itemId, input.link, input.outcome, input.pictureUrl, input.now)
  }

  /**
   * The same items, each one without a feed cover given the picture kept for its page. Only the app's own reads use
   * this, at the IPC boundary: the stores' reads, the assistant's tools and the migrations that read through the
   * stores never see a page picture.
   */
  fill<T extends { id: string; coverImage: string | null }>(items: T[]): T[] {
    const bare = items.filter(item => !item.coverImage).map(item => item.id)
    if (!bare.length) return items
    const covers = this.covers(bare)
    return items.map(item => item.coverImage ? item : { ...item, coverImage: covers.get(item.id) ?? null })
  }

  covers(itemIds: string[]): Map<string, string | null> {
    if (!itemIds.length) return new Map()
    const rows = this.db.prepare(`SELECT i.id,COALESCE(NULLIF(i.cover_image,''),CASE WHEN p.outcome='page' THEN p.picture_url END) AS cover
      FROM rss_items i ${PICTURE_JOIN} WHERE i.id IN (${itemIds.map(() => '?').join(',')})`)
      .all<{ id: string; cover: string | null }>(...itemIds)
    return new Map(rows.map(row => [row.id, row.cover]))
  }
}
