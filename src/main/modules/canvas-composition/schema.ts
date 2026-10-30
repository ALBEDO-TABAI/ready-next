import type { DatabaseConnection } from '../database/connection'

export function migrateCanvasComposition(db: Pick<DatabaseConnection, 'exec'>): void {
  db.exec(`CREATE TABLE canvas_compositions (
    operation_id TEXT PRIMARY KEY, vault_root TEXT NOT NULL, input_hash TEXT NOT NULL,
    draft_id TEXT NOT NULL UNIQUE REFERENCES document_drafts(draft_id),
    state TEXT NOT NULL CHECK(state IN ('prepared','completed')),
    plan_json TEXT NOT NULL, receipt_json TEXT,
    CHECK((state='completed')=(receipt_json IS NOT NULL))
  );`)
}
