import type { MigrationDatabase } from '../migrations'

export const RSS_RESULT_MIGRATION = '083_rss_saved_results'
export function migrateRSSResults(db: MigrationDatabase): void {
  db.exec(`CREATE TABLE rss_classification_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL REFERENCES rss_items(id) ON DELETE CASCADE,
    definition_id TEXT NOT NULL REFERENCES rss_definitions(id) ON DELETE CASCADE,
    job_id TEXT REFERENCES rss_processing_jobs(id),method TEXT,
    decision INTEGER NOT NULL CHECK(decision IN (0,1,2)),origin TEXT NOT NULL CHECK(origin IN ('legacy','model')),
    reason TEXT,evidence TEXT,content_revision TEXT,rule_revision INTEGER,
    UNIQUE(item_id,definition_id,id),UNIQUE(job_id,definition_id)
  );
  CREATE INDEX idx_rss_results_version ON rss_classification_results(item_id,definition_id,content_revision,rule_revision,method,id);
  CREATE TRIGGER rss_classification_results_immutable BEFORE UPDATE ON rss_classification_results
    BEGIN SELECT RAISE(ABORT,'classification result is immutable'); END;
  DROP TRIGGER rss_memberships_insert;
  DROP TRIGGER rss_memberships_update;
  DROP TRIGGER rss_memberships_delete;
  DROP INDEX idx_rss_memberships_definition;
  ALTER TABLE rss_memberships RENAME TO rss_memberships_before_results;
  CREATE TABLE rss_memberships (
    item_id TEXT NOT NULL REFERENCES rss_items(id) ON DELETE CASCADE,
    definition_id TEXT NOT NULL REFERENCES rss_definitions(id) ON DELETE CASCADE,
    manual_decision INTEGER CHECK(manual_decision IN (0,1)),result_id INTEGER,
    PRIMARY KEY(item_id,definition_id),
    FOREIGN KEY(item_id,definition_id,result_id) REFERENCES rss_classification_results(item_id,definition_id,id)
  );
  CREATE INDEX idx_rss_memberships_definition ON rss_memberships(definition_id,item_id);
  INSERT INTO rss_classification_results(item_id,definition_id,decision,origin,reason,evidence,content_revision,rule_revision)
    SELECT item_id,definition_id,derived_decision,derived_origin,reason,evidence,content_revision,rule_revision
    FROM rss_memberships_before_results WHERE derived_decision IS NOT NULL;
  INSERT INTO rss_memberships(item_id,definition_id,manual_decision,result_id)
    SELECT m.item_id,m.definition_id,m.manual_decision,r.id FROM rss_memberships_before_results m
    LEFT JOIN rss_classification_results r ON r.item_id=m.item_id AND r.definition_id=m.definition_id;
  DROP TABLE rss_memberships_before_results;`)
  // Existing values are real, but their processing method/job cannot be inferred from a success receipt.
  for (const event of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER rss_memberships_${event.toLowerCase()} AFTER ${event} ON rss_memberships
    BEGIN UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1; END;`)
  db.exec('UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1')
}
