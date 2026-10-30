import type { DatabaseConnection } from '../database/connection'

export const DOCUMENT_DRAFT_MIGRATION = '140_document_drafts'
export function migrateDocumentDrafts(db: Pick<DatabaseConnection, 'exec'>): void {
  db.exec(`CREATE TABLE document_drafts (
    draft_id TEXT PRIMARY KEY NOT NULL, vault_root TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0 AND typeof(revision)='integer'),
    content TEXT NOT NULL, content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
    origin TEXT NOT NULL CHECK(origin IN ('new','document','canvas')),
    object_id TEXT REFERENCES objects(id), base_version TEXT, suggested_parent TEXT,
    source_canvas_json TEXT, attachments_json TEXT NOT NULL, title TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('editing','finalizing','finalized','conflict','discarded')),
    finalize_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    CHECK((origin='document' AND object_id IS NOT NULL AND base_version IS NOT NULL) OR
      (origin<>'document' AND object_id IS NULL AND base_version IS NULL)),
    CHECK(state NOT IN ('finalizing','finalized') OR finalize_json IS NOT NULL)
  );
  CREATE INDEX document_drafts_recovery ON document_drafts(vault_root,state);
  CREATE UNIQUE INDEX document_drafts_operation ON document_drafts(json_extract(finalize_json,'$.request.operationId'));
  CREATE UNIQUE INDEX document_drafts_target ON document_drafts(json_extract(finalize_json,'$.path')) WHERE state='finalizing';
  CREATE TABLE document_draft_imports (
    vault_root TEXT NOT NULL, migration_key TEXT NOT NULL, content_hash TEXT NOT NULL,
    draft_id TEXT NOT NULL REFERENCES document_drafts(draft_id), receipt_json TEXT NOT NULL,
    PRIMARY KEY(vault_root,migration_key)
  );`)
}
