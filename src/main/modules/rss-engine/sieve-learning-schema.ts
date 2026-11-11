import type { MigrationDatabase } from '../migrations'

export const RSS_SIEVE_LEARNING_MIGRATION = '156_rss_sieve_learning_delivery'
export function migrateRSSSieveLearning(db: MigrationDatabase): void {
  db.exec(`CREATE TABLE rss_sieve_exposures (item_id TEXT PRIMARY KEY, shown_at INTEGER NOT NULL);
    CREATE TABLE rss_calibrations (
      week TEXT PRIMARY KEY, base_version INTEGER NOT NULL, status TEXT NOT NULL
        CHECK(status IN ('queued','running','pending','accepted','dismissed','failed','unknown')),
      text TEXT, explanation TEXT, started_at INTEGER, finished_at INTEGER, error TEXT,
      CHECK(status NOT IN ('pending','accepted') OR (text IS NOT NULL AND explanation IS NOT NULL))
    );
    CREATE TABLE rss_topic_notifications (topic_id TEXT PRIMARY KEY REFERENCES rss_definitions(id) ON DELETE CASCADE,
      urgent INTEGER NOT NULL CHECK(urgent IN (0,1)));
    CREATE INDEX rss_notification_day ON rss_notification_deliveries(delivered_at);
    ALTER TABLE rss_sources DROP COLUMN fetch_interval;`)
}
