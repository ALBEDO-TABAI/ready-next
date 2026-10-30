import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { DatabaseConnection } from '../database/connection'

export const OBJECT_MIGRATION = '138_object_identity'
export const OBJECT_SCHEMA = `CREATE TABLE objects (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)>0),
  kind TEXT NOT NULL CHECK(kind IN ('markdown','canvas','file','directory')),
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE RESTRICT,
  current_path TEXT, path_key TEXT, last_known_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('unverified','present','missing','deleted')),
  embedded_ready_id TEXT,
  identity_state TEXT NOT NULL CHECK(identity_state IN ('local','portable','conflict')),
  device TEXT, inode TEXT, birthtime_ns TEXT, size INTEGER CHECK(size>=0), mtime_ns TEXT,
  content_hash TEXT CHECK(content_hash IS NULL OR (length(content_hash)=64 AND content_hash NOT GLOB '*[^0-9a-f]*')),
  observed_since INTEGER NOT NULL, last_verified_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  CHECK((status='present' AND current_path IS NOT NULL AND path_key IS NOT NULL) OR (status<>'present' AND current_path IS NULL AND path_key IS NULL)),
  CHECK((device IS NULL)=(inode IS NULL)),
  CHECK(kind<>'directory' OR content_hash IS NULL),
  CHECK((identity_state='local' AND embedded_ready_id IS NULL) OR
    (identity_state='portable' AND embedded_ready_id IS NOT NULL AND embedded_ready_id=id AND kind IN ('markdown','canvas')) OR
    (identity_state='conflict' AND embedded_ready_id IS NOT NULL))
);
CREATE UNIQUE INDEX objects_live_path ON objects(path_key) WHERE status='present';
CREATE INDEX objects_inode ON objects(device,inode);
CREATE INDEX objects_hash ON objects(content_hash);
CREATE INDEX objects_embedded_id ON objects(embedded_ready_id);`

/** Full copy (committed WAL included) before 138 rebuilds file identity and the tables that reference it. */
export function backupBeforeObjectMigration(db: Pick<DatabaseConnection, 'prepare'>, databasePath: string): string | null {
  if (databasePath === ':memory:') return null
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_identities'").get()) return null
  const directory = join(dirname(databasePath), 'backups')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const backup = join(directory, `before-objects-138-${Date.now()}-${randomUUID()}.sqlite`)
  db.prepare('VACUUM INTO ?').run(backup)
  chmodSync(backup, 0o600)
  return backup
}

export function objectKind(path: string): 'markdown' | 'canvas' | 'file' {
  const ext = extname(path).toLowerCase()
  return ext === '.md' ? 'markdown' : ext === '.canvas' ? 'canvas' : 'file'
}

/** Called inside the migration transaction, with foreign keys temporarily disabled. */
export function migrateObjects(db: Pick<DatabaseConnection, 'exec' | 'prepare'>): void {
  // Rename first so SQLite rewrites every dependent foreign key, then rebuild the parent.
  db.exec('ALTER TABLE file_identities RENAME TO objects; ALTER TABLE objects RENAME COLUMN file_key TO id;')
  const old = db.prepare('SELECT * FROM objects').all<{id:string;workspace_root:string;current_path:string;observed_since:number;last_verified_at:number;status:'present'|'missing'|'deleted'}>()
  db.exec('DROP TABLE objects; ' + OBJECT_SCHEMA)
  const workspace = (root: string | null): number | null => {
    if (!root) return null
    db.prepare('INSERT INTO workspaces(root) VALUES (?) ON CONFLICT(root) DO NOTHING').run(root)
    return db.prepare('SELECT id FROM workspaces WHERE root=?').get<{id:number}>(root)!.id
  }
  const create = (id:string, path:string, root:string|null, at:number) => {
    db.prepare(`INSERT INTO objects(id,kind,workspace_id,last_known_path,status,identity_state,observed_since)
      VALUES (?,?,?,?,'unverified','local',?)`).run(id, objectKind(path), workspace(root), path, at)
    return id
  }
  for (const row of old) {create(row.id, row.current_path, row.workspace_root, row.observed_since);db.prepare('UPDATE objects SET last_verified_at=?,status=? WHERE id=?').run(row.last_verified_at,row.status==='present'?'unverified':row.status,row.id)}
  db.exec(`CREATE TABLE object_migration_issues (record_table TEXT NOT NULL, record_id TEXT NOT NULL, object_id TEXT NOT NULL REFERENCES objects(id), reason TEXT NOT NULL, PRIMARY KEY(record_table,record_id));`)
  const map = (path:string, root:string|null, at:number|null, table:string, recordId:string):string => {
    const current = old.filter(row => row.current_path === path && (!root || row.workspace_root === root))
    const receipts = at === null ? [] : db.prepare(`SELECT object_id FROM file_move_receipts WHERE old_path=? AND moved_at>=?`).all<{object_id:string}>(path, at)
    const ids = [...new Set(receipts.map(row => row.object_id))]
    if (ids.length === 1 && (!current.length || current.every(row => row.id === ids[0] || row.observed_since > at!))) return ids[0]
    if (current.length === 1 && !ids.length) return current[0].id
    const existing = db.prepare(`SELECT id FROM objects WHERE last_known_path=? AND status='unverified' AND id NOT IN (SELECT object_id FROM object_migration_issues)`).all<{id:string}>(path)
    if (!current.length && !ids.length && existing.length === 1) return existing[0].id
    const id = create(randomUUID(), path, root, at ?? Date.now())
    if (current.length || ids.length) db.prepare('INSERT INTO object_migration_issues VALUES (?,?,?,?)').run(table, recordId, id, 'ambiguous_historical_path')
    return id
  }
  for (const table of ['file_move_receipts','project_identity_members','file_attention_rollups','file_tag_assignments','artifact_creation_receipts']) {
    db.exec(`ALTER TABLE ${table} RENAME COLUMN file_key TO object_id`)
  }
  db.exec('ALTER TABLE file_move_receipts ADD COLUMN operation_id TEXT')
  // Rebuild the three path-owned tables, preserving every other field and index.
  for (const [table, pathColumn, timeColumn] of [
    ['document_marks','document_path','created_at'], ['document_reading_sessions','path','started_at'], ['file_activity_events','path','created_at'],
  ]) {
    const rows = db.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>()
    const columns = db.prepare(`PRAGMA table_info(${table})`).all<{name:string}>().map(row => row.name)
    const schema = db.prepare('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?').get<{sql:string}>(table)!.sql
    const indexes = db.prepare('SELECT sql FROM sqlite_master WHERE type=\'index\' AND tbl_name=? AND sql IS NOT NULL').all<{sql:string}>(table)
    db.exec(`DROP TABLE ${table}`)
    const history = table !== 'document_marks'
    const replacement = `object_id TEXT NOT NULL REFERENCES objects(id) ON DELETE RESTRICT${history ? ', path_at_event TEXT NOT NULL' : ''}`
    db.exec(schema.replace(new RegExp(`\\b${pathColumn} TEXT NOT NULL`), replacement))
    const nextColumns = columns.flatMap(name => name === pathColumn ? ['object_id', ...(history ? ['path_at_event'] : [])] : [name])
    const insert = db.prepare(`INSERT INTO ${table}(${nextColumns.join(',')}) VALUES (${nextColumns.map(()=>'?').join(',')})`)
    for (const row of rows) {
      const path = String(row[pathColumn]); const rawAt = row[timeColumn]
      const at = typeof rawAt === 'number' ? rawAt : typeof rawAt === 'string' ? Date.parse(rawAt) : null
      const id = map(path, typeof row.workspace_root === 'string' ? row.workspace_root : null, at, table, String(row.id))
      insert.run(...columns.flatMap(name => name === pathColumn ? [id, ...(history ? [path] : [])] : [row[name]]))
    }
    for (const index of indexes) db.exec(index.sql.replace(new RegExp(`\\b${pathColumn}\\b`, 'g'), 'object_id'))
  }
  db.exec('ALTER TABLE document_marks ADD COLUMN portability_json TEXT')
  db.exec('ALTER TABLE documents ADD COLUMN object_id TEXT REFERENCES objects(id) ON DELETE RESTRICT')
  for (const row of db.prepare(`SELECT d.id,d.path,w.root FROM documents d JOIN workspaces w ON w.id=d.workspace_id WHERE source_type='document'`).all<{id:number;path:string;root:string}>()) {
    db.prepare('UPDATE documents SET object_id=? WHERE id=?').run(map(row.path,row.root,null,'documents',String(row.id)),row.id)
  }
  db.exec(`CREATE UNIQUE INDEX documents_object ON documents(object_id) WHERE object_id IS NOT NULL;
    CREATE TRIGGER documents_unresolve_before_delete BEFORE DELETE ON documents BEGIN
      UPDATE doc_links SET resolved=0 WHERE target_doc_id=OLD.id;
    END;
    CREATE TABLE object_link_targets (
      source_id TEXT NOT NULL REFERENCES objects(id), kind TEXT NOT NULL, raw_target TEXT NOT NULL,
      target_id TEXT NOT NULL REFERENCES objects(id), source_hash TEXT,
      state TEXT NOT NULL CHECK(state IN ('pending','confirmed')),
      PRIMARY KEY(source_id,kind,raw_target)
    );
    CREATE TABLE object_identity_writes (
      object_id TEXT PRIMARY KEY REFERENCES objects(id), original TEXT NOT NULL, published_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','file_published','committed','rolled_back','recovery_required')), error TEXT
    );
    CREATE TABLE object_move_operations (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES objects(id), old_path TEXT NOT NULL, new_path TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('prepared','file_published','committed','rolled_back','recovery_required')),
      objects_json TEXT NOT NULL, error TEXT
    );`)
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Object migration foreign key check failed')
}
