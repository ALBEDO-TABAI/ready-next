import type { DatabaseConnection } from '../database/connection'

export const DOCUMENT_PAGES_MIGRATION = '141_document_pages'
/** Rebuild only the status constraint; preserve every existing column, index and FK target. */
export function migrateDocumentPages(db: Pick<DatabaseConnection, 'exec' | 'prepare'>): void {
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='objects'").get<{ sql: string }>()!.sql
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='objects' AND sql IS NOT NULL").all<{ sql: string }>()
  db.exec('DROP TRIGGER objects_update_link_availability')
  db.exec(schema.replace(/CREATE TABLE ["`]?objects["`]?/, 'CREATE TABLE objects_next').replace("'missing','deleted'", "'missing','trashed','deleted'"))
  db.exec('INSERT INTO objects_next SELECT * FROM objects; DROP TABLE objects; ALTER TABLE objects_next RENAME TO objects;')
  for (const index of indexes) db.exec(index.sql)
  db.exec(`CREATE TRIGGER objects_update_link_availability AFTER UPDATE OF status,identity_state ON objects BEGIN
    UPDATE object_links SET resolved=CASE WHEN NEW.status='present' AND NEW.identity_state<>'conflict' THEN 1 ELSE 0 END,
    unresolved_reason=CASE WHEN NEW.status='present' AND NEW.identity_state<>'conflict' THEN NULL WHEN NEW.status='trashed' THEN '已回收' ELSE '目标不可用' END WHERE target_id=NEW.id;
  END;
  CREATE TABLE document_page_state (object_id TEXT PRIMARY KEY REFERENCES objects(id), favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)), last_visited_at INTEGER);
  CREATE TABLE document_page_order (parent_id TEXT NOT NULL REFERENCES objects(id), object_id TEXT NOT NULL REFERENCES objects(id), position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(parent_id,object_id));
  CREATE TABLE document_page_operations (id TEXT PRIMARY KEY, request_json TEXT NOT NULL, intent_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','committed','rolled_back','recovery_required')), receipt_json TEXT, error TEXT);
  CREATE TABLE object_move_groups (id TEXT PRIMARY KEY, intent_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','committed','rolled_back','recovery_required')), error TEXT);
  CREATE TABLE object_move_group_locations (operation_id TEXT NOT NULL REFERENCES object_move_groups(id), path TEXT NOT NULL, device TEXT NOT NULL, inode TEXT NOT NULL, PRIMARY KEY(operation_id,path));`)
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Page migration foreign key check failed')
}
