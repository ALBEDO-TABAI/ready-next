import type { DatabaseConnection } from '../database/connection'
import { parseReadyUri, toReadyUri } from '../../../shared/ready-ref'
import { OBJECT_LINK_KINDS } from '../../../shared/object-links'

export function migrateObjectLinks(db: Pick<DatabaseConnection, 'exec' | 'prepare'>): void {
  db.exec(`CREATE TABLE object_links (
    id TEXT PRIMARY KEY NOT NULL,
    source_id TEXT REFERENCES objects(id), source_ref TEXT,
    target_id TEXT REFERENCES objects(id), target_ref TEXT,
    kind TEXT NOT NULL CHECK(kind IN (${OBJECT_LINK_KINDS.map(k => `'${k}'`).join(',')})),
    raw_target TEXT NOT NULL, target_text TEXT NOT NULL, fragment TEXT,
    source_line INTEGER CHECK(source_line>0), source_offset INTEGER CHECK(source_offset>=0),
    resolved INTEGER NOT NULL CHECK(resolved IN (0,1)), unresolved_reason TEXT,
    CHECK((source_id IS NOT NULL)+(source_ref IS NOT NULL)=1),
    CHECK(NOT(target_id IS NOT NULL AND target_ref IS NOT NULL)),
    CHECK((resolved=1 AND unresolved_reason IS NULL AND (target_id IS NOT NULL OR target_ref IS NOT NULL)) OR (resolved=0 AND unresolved_reason IS NOT NULL))
  );
  CREATE INDEX object_links_source ON object_links(source_id);
  CREATE INDEX object_links_source_ref ON object_links(source_ref);
  CREATE INDEX object_links_target ON object_links(target_id);
  CREATE INDEX object_links_target_ref ON object_links(target_ref);
  CREATE INDEX object_links_text ON object_links(target_text);
  CREATE INDEX objects_workspace_filename ON objects(workspace_id,
    lower(replace(current_path, rtrim(current_path, replace(current_path, '/', '')), '')));
  ALTER TABLE object_link_targets RENAME TO object_link_repairs;
  DROP TRIGGER documents_unresolve_before_delete;`)
  const rows = db.prepare(`SELECT l.*,s.object_id AS source_id,s.path AS source_path,t.object_id AS target_id,t.path AS target_path
    FROM doc_links l JOIN documents s ON s.id=l.src_doc_id LEFT JOIN documents t ON t.id=l.target_doc_id`).all<{
    src_doc_id: number; kind: string; target_text: string; resolved: number; source_id: string | null; source_path: string; target_id: string | null; target_path: string | null
  }>()
  for (const [index, row] of rows.entries()) {
    const source = parseReadyUri(row.source_path)
    // Invalid non-file search rows are disposable; their domain adapters rebuild them.
    if (!row.source_id && !source.ok) continue
    const target = parseReadyUri(row.target_path ?? row.target_text)
    const hash = row.target_text.indexOf('#')
    const resolved = !!(row.resolved && row.target_id) || target.ok
    db.prepare(`INSERT INTO object_links(id,source_id,source_ref,target_id,target_ref,kind,raw_target,target_text,fragment,resolved,unresolved_reason)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(`migration:${index}`, row.source_id, row.source_id ? null : source.ok ? toReadyUri(source.ref) : null,
      row.target_id, !row.target_id && target.ok ? toReadyUri(target.ref) : null, row.kind, row.target_text,
      hash < 0 ? row.target_text : row.target_text.slice(0, hash), hash < 0 ? null : row.target_text.slice(hash + 1), resolved ? 1 : 0, resolved ? null : '目标不存在')
  }
  db.exec(`DROP TABLE doc_links;
    UPDATE documents SET content_hash=NULL,mtime=NULL;
    CREATE TRIGGER documents_delete_object_links AFTER DELETE ON documents BEGIN
      DELETE FROM object_links WHERE source_id=OLD.object_id OR source_ref=OLD.path;
    END;
    CREATE TRIGGER objects_update_link_availability AFTER UPDATE OF status,identity_state ON objects BEGIN
      UPDATE object_links SET resolved=CASE WHEN NEW.status='present' AND NEW.identity_state<>'conflict' THEN 1 ELSE 0 END,
      unresolved_reason=CASE WHEN NEW.status='present' AND NEW.identity_state<>'conflict' THEN NULL ELSE '目标不可用' END WHERE target_id=NEW.id;
    END;`)
}
