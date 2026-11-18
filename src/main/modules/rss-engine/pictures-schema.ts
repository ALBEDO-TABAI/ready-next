import type { MigrationDatabase } from '../migrations'

export const RSS_PICTURES_MIGRATION = '162_rss_item_pictures'

export function migrateRSSPictures(db: MigrationDatabase): void {
  db.exec(`CREATE TABLE rss_item_pictures (
    item_id TEXT PRIMARY KEY REFERENCES rss_items(id) ON DELETE CASCADE,
    link TEXT NOT NULL,
    picture_url TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('page','none','failed')),
    attempts INTEGER NOT NULL DEFAULT 1,
    checked_at INTEGER NOT NULL
  );`)
}
