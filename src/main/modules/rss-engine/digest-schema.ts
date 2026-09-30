import type { MigrationDatabase } from '../migrations'

export const RSS_DIGEST_MIGRATION = '084_rss_digests'
export function migrateRSSDigests(db: MigrationDatabase): void {
  db.exec(`ALTER TABLE rss_items ADD COLUMN daily_eligible INTEGER NOT NULL DEFAULT 0 CHECK(daily_eligible IN (0,1));
    ALTER TABLE rss_event_facts ADD COLUMN origin_fact_id TEXT;
    UPDATE rss_event_facts SET origin_fact_id=id;
    CREATE TRIGGER rss_event_fact_origin_immutable BEFORE UPDATE OF origin_fact_id ON rss_event_facts BEGIN SELECT RAISE(ABORT,'fact origin is immutable'); END;
    CREATE TABLE rss_digest_intake (
      item_id TEXT NOT NULL REFERENCES rss_items(id) ON DELETE CASCADE,article_revision TEXT NOT NULL,received_at INTEGER NOT NULL,available_at INTEGER,
      PRIMARY KEY(item_id,article_revision)
    );
    CREATE TABLE rss_digest_schedule (
      id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL DEFAULT 1,local_time TEXT NOT NULL DEFAULT '08:00',
      timezone TEXT NOT NULL,next_run_at TEXT,last_error TEXT
    );
    CREATE TABLE rss_digests (
      id TEXT PRIMARY KEY,edition_key TEXT NOT NULL,version INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('daily','range')),
      window_start INTEGER NOT NULL,window_end INTEGER NOT NULL,timezone TEXT NOT NULL,created_at INTEGER NOT NULL,
      query_json TEXT,coverage_json TEXT NOT NULL,definitions_json TEXT NOT NULL,
      UNIQUE(edition_key,version)
    );
    CREATE TABLE rss_digest_entries (
      id INTEGER PRIMARY KEY,report_id TEXT NOT NULL REFERENCES rss_digests(id),position INTEGER NOT NULL,group_key TEXT NOT NULL,
      item_id TEXT NOT NULL,article_revision TEXT NOT NULL,fact_id TEXT,origin_fact_id TEXT,evidence_id TEXT,event_id TEXT,payload_json TEXT NOT NULL,
      UNIQUE(report_id,item_id,article_revision)
    );
    CREATE INDEX idx_rss_digest_entries_group ON rss_digest_entries(report_id,group_key,position);
    CREATE INDEX idx_rss_digest_entries_fact ON rss_digest_entries(origin_fact_id,report_id);
    CREATE INDEX idx_rss_digest_entries_article ON rss_digest_entries(item_id,article_revision,report_id);
    CREATE TABLE rss_digest_sources (
      report_id TEXT NOT NULL REFERENCES rss_digests(id),source_id TEXT NOT NULL,payload_json TEXT NOT NULL,
      PRIMARY KEY(report_id,source_id)
    );`)
  for (const table of ['rss_digests', 'rss_digest_entries', 'rss_digest_sources']) {
    db.exec(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'published digest evidence is immutable'); END;`)
  }
  db.exec(`CREATE TRIGGER rss_digest_intake_immutable BEFORE UPDATE ON rss_digest_intake
    WHEN NEW.item_id<>OLD.item_id OR NEW.article_revision<>OLD.article_revision OR NEW.received_at<>OLD.received_at OR (OLD.available_at IS NOT NULL AND NEW.available_at IS NOT OLD.available_at)
    BEGIN SELECT RAISE(ABORT,'first intake and curation times are immutable'); END;`)
  // Existing articles predate this feature. A migration must not turn their historical import into today's intake.
}
