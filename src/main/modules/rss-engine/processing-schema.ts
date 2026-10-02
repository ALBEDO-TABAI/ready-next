import type { MigrationDatabase } from '../migrations'

export const RSS_PROCESSING_MIGRATION = '126_rss_processing'
export function migrateRSSProcessing(db: MigrationDatabase): void {
  db.exec(`CREATE TABLE rss_processing_jobs (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, title TEXT NOT NULL, article_revision TEXT NOT NULL, fingerprint TEXT NOT NULL,
    method TEXT NOT NULL, definitions_json TEXT NOT NULL, trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('automatic','manual')),
    status TEXT NOT NULL CHECK(status IN ('queued','running','success','failed','unknown','canceled','stale')),
    message TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
  );
  CREATE INDEX idx_rss_processing_fingerprint ON rss_processing_jobs(fingerprint);
  CREATE INDEX idx_rss_processing_queue ON rss_processing_jobs(status,created_at);
  CREATE INDEX idx_rss_processing_usage ON rss_processing_jobs(started_at);
  CREATE INDEX idx_rss_processing_item ON rss_processing_jobs(item_id);
  CREATE TRIGGER rss_processing_item_delete AFTER DELETE ON rss_items BEGIN
    UPDATE rss_processing_jobs SET status='stale',message='文章已删除，整理已停止。',finished_at=unixepoch()*1000
    WHERE item_id=OLD.id AND status IN ('queued','running');
  END;`)
}
