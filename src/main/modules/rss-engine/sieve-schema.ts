import type { MigrationDatabase } from '../migrations'
export const RSS_SIEVE_MIGRATION = '155_rss_sieve'
export function migrateRSSSieve(db: MigrationDatabase): void {
  db.exec(`CREATE TABLE rss_behaviors (
    id TEXT PRIMARY KEY, item_id TEXT NOT NULL, source_id TEXT NOT NULL, topic_ids_json TEXT NOT NULL,
    action TEXT NOT NULL, reason TEXT, topic_id TEXT, occurred_at INTEGER NOT NULL
  );
  CREATE INDEX rss_behaviors_item ON rss_behaviors(item_id,occurred_at);
  CREATE TABLE rss_source_preferences (source_id TEXT PRIMARY KEY, positive REAL NOT NULL DEFAULT 0, negative REAL NOT NULL DEFAULT 0, value REAL NOT NULL CHECK(value BETWEEN 0 AND 1));
  CREATE TABLE rss_topic_preferences (topic_id TEXT PRIMARY KEY, positive REAL NOT NULL DEFAULT 0, negative REAL NOT NULL DEFAULT 0, value REAL NOT NULL CHECK(value BETWEEN 0 AND 1));
  CREATE TABLE rss_focus (singleton INTEGER PRIMARY KEY CHECK(singleton=1), text TEXT NOT NULL, version INTEGER NOT NULL);
  INSERT INTO rss_focus VALUES(1,'',0);
  CREATE TABLE rss_work_excluded_pages (object_id TEXT PRIMARY KEY);
  CREATE TABLE rss_notification_deliveries (item_id TEXT PRIMARY KEY, delivered_at INTEGER NOT NULL);
  CREATE TABLE rss_relevance (
    job_id TEXT PRIMARY KEY REFERENCES rss_processing_jobs(id), item_id TEXT NOT NULL REFERENCES rss_items(id) ON DELETE CASCADE,
    score REAL NOT NULL CHECK(score BETWEEN 0 AND 100), because TEXT NOT NULL CHECK(because IN ('work','standard','interest')),
    method TEXT NOT NULL, article_revision TEXT NOT NULL, base_rule_revision INTEGER NOT NULL,
    reason TEXT NOT NULL, work_ref TEXT, work_kind TEXT CHECK(work_kind IN ('page','project','calendar','book')), summary_only INTEGER NOT NULL CHECK(summary_only IN (0,1)),
    CHECK(because<>'work' OR work_ref IS NOT NULL)
  );
  CREATE INDEX rss_relevance_item ON rss_relevance(item_id);
  CREATE INDEX rss_classification_job ON rss_classification_results(job_id);
  CREATE INDEX rss_processing_latest ON rss_processing_jobs(item_id,created_at DESC,id DESC);
  CREATE INDEX rss_source_recent_items ON rss_items(source_id,first_seen_at);
  CREATE INDEX rss_behaviors_source_recent ON rss_behaviors(source_id,occurred_at,item_id);
  ALTER TABLE rss_items DROP COLUMN ai_score;
  UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1;`)
}
