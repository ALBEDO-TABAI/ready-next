import type { MigrationDatabase } from '../migrations'
import { createHash } from 'node:crypto'

export const RSS_EVENT_MIGRATION = '127_rss_events'
export function migrateRSSEvents(db: MigrationDatabase): void {
  db.exec(`CREATE TABLE rss_events (id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE rss_event_facts (id TEXT PRIMARY KEY,event_id TEXT NOT NULL REFERENCES rss_events(id),available_at INTEGER NOT NULL,seen_at INTEGER);
    CREATE INDEX idx_rss_event_facts_event ON rss_event_facts(event_id);
    CREATE TABLE rss_event_evidence (
      id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES rss_items(id) ON DELETE CASCADE,
      article_revision TEXT NOT NULL,method TEXT NOT NULL,fact_id TEXT REFERENCES rss_event_facts(id),quote TEXT,
      title TEXT NOT NULL,source_id TEXT NOT NULL,source_name TEXT NOT NULL,source_url TEXT NOT NULL,published_at INTEGER,
      source_role TEXT NOT NULL CHECK(source_role IN ('direct','secondary','unknown')),
      relation TEXT CHECK(relation IN ('original','duplicate','progress')),reason TEXT NOT NULL,
      captured_at INTEGER NOT NULL,withdrawn INTEGER NOT NULL DEFAULT 0 CHECK(withdrawn IN (0,1)),
      UNIQUE(item_id,id),CHECK((fact_id IS NULL AND quote IS NULL) OR (fact_id IS NOT NULL AND quote IS NOT NULL))
    );
    CREATE INDEX idx_rss_event_evidence_fact ON rss_event_evidence(fact_id);
    CREATE INDEX idx_rss_event_evidence_item ON rss_event_evidence(item_id);
    CREATE TRIGGER rss_event_evidence_immutable BEFORE UPDATE OF id,item_id,article_revision,method,fact_id,quote,title,source_id,source_name,source_url,published_at,source_role,captured_at,relation,reason ON rss_event_evidence
    BEGIN SELECT RAISE(ABORT,'event evidence is immutable'); END;
    CREATE TABLE rss_event_members (
      item_id TEXT PRIMARY KEY REFERENCES rss_items(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,
      manual INTEGER NOT NULL CHECK(manual IN (0,1)),manual_reason TEXT,revision INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY(item_id,evidence_id) REFERENCES rss_event_evidence(item_id,id) ON DELETE CASCADE
    );
    CREATE TRIGGER rss_event_member_insert AFTER INSERT ON rss_event_members BEGIN
      UPDATE rss_events SET revision=revision+1 WHERE id IN (SELECT f.event_id FROM rss_event_evidence e JOIN rss_event_facts f ON f.id=e.fact_id WHERE e.id=NEW.evidence_id);
      UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER rss_event_member_update AFTER UPDATE ON rss_event_members BEGIN
      UPDATE rss_events SET revision=revision+1 WHERE id IN (SELECT f.event_id FROM rss_event_evidence e JOIN rss_event_facts f ON f.id=e.fact_id WHERE e.id=OLD.evidence_id OR e.id=NEW.evidence_id);
      UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER rss_event_member_delete AFTER DELETE ON rss_event_members BEGIN
      UPDATE rss_events SET revision=revision+1 WHERE id IN (SELECT f.event_id FROM rss_event_evidence e JOIN rss_event_facts f ON f.id=e.fact_id WHERE e.id=OLD.evidence_id);
      UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER rss_event_fact_move AFTER UPDATE OF event_id ON rss_event_facts WHEN OLD.event_id IS NOT NEW.event_id BEGIN
      UPDATE rss_events SET revision=revision+1 WHERE id=OLD.event_id OR id=NEW.event_id;
      UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER rss_event_fact_seen AFTER UPDATE OF seen_at ON rss_event_facts WHEN OLD.seen_at IS NOT NEW.seen_at BEGIN
      UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER rss_event_evidence_insert AFTER INSERT ON rss_event_evidence BEGIN
      UPDATE rss_events SET revision=revision+1 WHERE id IN (SELECT event_id FROM rss_event_facts WHERE id=NEW.fact_id);
      UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER rss_event_evidence_withdraw AFTER UPDATE OF withdrawn ON rss_event_evidence WHEN OLD.withdrawn<>NEW.withdrawn BEGIN
      UPDATE rss_events SET revision=revision+1 WHERE id IN (SELECT event_id FROM rss_event_facts WHERE id=NEW.fact_id);
      UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER rss_event_evidence_delete AFTER DELETE ON rss_event_evidence BEGIN
      UPDATE rss_events SET revision=revision+1 WHERE id IN (SELECT event_id FROM rss_event_facts WHERE id=OLD.fact_id);
      UPDATE rss_workspace_state SET revision=revision+1 WHERE id=1;
    END;
    CREATE TRIGGER rss_event_source_change AFTER UPDATE OF content_revision ON rss_items WHEN OLD.content_revision IS NOT NEW.content_revision BEGIN
      UPDATE rss_events SET revision=revision+1 WHERE id IN (SELECT f.event_id FROM rss_event_evidence e JOIN rss_event_facts f ON f.id=e.fact_id WHERE e.item_id=NEW.id AND e.withdrawn=0);
    END;
    CREATE TRIGGER rss_event_body_change AFTER UPDATE OF body_revision ON rss_article_content WHEN OLD.body_revision IS NOT NEW.body_revision BEGIN
      UPDATE rss_events SET revision=revision+1 WHERE id IN (SELECT f.event_id FROM rss_event_evidence e JOIN rss_event_facts f ON f.id=e.fact_id WHERE e.item_id=NEW.item_id AND e.withdrawn=0);
    END;
    CREATE TRIGGER rss_event_body_insert AFTER INSERT ON rss_article_content WHEN NEW.body_revision IS NOT NULL BEGIN
      UPDATE rss_events SET revision=revision+1 WHERE id IN (SELECT f.event_id FROM rss_event_evidence e JOIN rss_event_facts f ON f.id=e.fact_id WHERE e.item_id=NEW.item_id AND e.withdrawn=0);
    END;
    ALTER TABLE rss_processing_jobs ADD COLUMN event_requested INTEGER NOT NULL DEFAULT 0 CHECK(event_requested IN (0,1));
    ALTER TABLE rss_processing_jobs ADD COLUMN event_reprocess INTEGER NOT NULL DEFAULT 0 CHECK(event_reprocess IN (0,1));
    ALTER TABLE rss_processing_jobs ADD COLUMN event_context_json TEXT;`)
  // Pending requests have never been sent. Assign one explicit event owner without scheduling historical completed work.
  const eventOwners = new Set<string>()
  for (const row of db.prepare("SELECT id,item_id,article_revision,definitions_json FROM rss_processing_jobs WHERE status='queued' ORDER BY created_at,id")
    .all<{ id: string; item_id: string; article_revision: string; definitions_json: string }>()) {
    const definitions = JSON.parse(row.definitions_json) as Array<{ id: string; ruleRevision: number }>
    const fingerprint = createHash('sha256').update(JSON.stringify([row.item_id, row.article_revision, 'rss-organize-v2', definitions.map((d) => [d.id, d.ruleRevision])])).digest('hex')
    const key = JSON.stringify([row.item_id, row.article_revision]), eventRequested = !eventOwners.has(key)
    eventOwners.add(key)
    db.prepare('UPDATE rss_processing_jobs SET method=?,fingerprint=?,event_requested=? WHERE id=?').run('rss-organize-v2', fingerprint, Number(eventRequested), row.id)
  }
}
