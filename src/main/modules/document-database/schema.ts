import type { DatabaseConnection } from '../database/connection'
export const DOCUMENT_DATABASE_MIGRATION = '145_document_database'
export function migrateDocumentDatabase(db: Pick<DatabaseConnection, 'exec'>): void {
  db.exec(`
    CREATE TABLE document_database_operations (
      id TEXT PRIMARY KEY, database_id TEXT NOT NULL REFERENCES objects(id), request_json TEXT NOT NULL,
      plan_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','committed','recovery_required')),
      receipt_json TEXT, error TEXT
    );
    CREATE UNIQUE INDEX document_database_one_writer ON document_database_operations(database_id) WHERE state <> 'committed';
    CREATE TABLE document_database_state (database_id TEXT PRIMARY KEY REFERENCES objects(id), state_json TEXT NOT NULL);
    CREATE TABLE document_database_view_repairs (
      database_id TEXT NOT NULL REFERENCES objects(id), view_id TEXT NOT NULL, old_name TEXT NOT NULL, new_name TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','pending_reference_repair','completed')), PRIMARY KEY(database_id,view_id,old_name)
    );
  `)
}
