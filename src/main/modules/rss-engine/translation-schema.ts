import type { MigrationDatabase } from '../migrations'

export const RSS_TRANSLATION_MIGRATION = '132_rss_article_translations'

export function migrateRSSTranslations(db: MigrationDatabase): void {
  db.exec(`
    CREATE TABLE rss_article_translations (
      item_id TEXT NOT NULL REFERENCES rss_items(id) ON DELETE CASCADE,
      target_lang TEXT NOT NULL,
      body_revision TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','completed','partial','failed','cancelled')),
      request_id TEXT,
      total INTEGER NOT NULL,
      done INTEGER NOT NULL,
      blocks_json TEXT NOT NULL,
      error TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, target_lang)
    );
    -- Foreign keys are not enforced on this connection; translations leave with their item explicitly.
    CREATE TRIGGER rss_translation_item_delete AFTER DELETE ON rss_items
    BEGIN DELETE FROM rss_article_translations WHERE item_id=OLD.id; END;
  `)
}
