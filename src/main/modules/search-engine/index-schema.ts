import type { MigrationDatabase } from '../migrations'
import { buildFtsSearchText, searchIndexTitle } from './query'

/** Rebuild derived text inside the migration transaction, holding one body at a time. */
export function migrateSearchTitlesAndTokenBoundaries(db: MigrationDatabase): void {
  try {
    db.exec(`CREATE VIRTUAL TABLE documents_fts_rebuild USING fts5(
      name, body, title, tokenize='unicode61 remove_diacritics 2'
    )`)
  } catch (error) {
    if (!(error instanceof Error) || !/no such module: fts5/i.test(error.message)) throw error
    db.exec('UPDATE documents SET content_hash=NULL,mtime=NULL')
    return
  }
  if (db.prepare("SELECT name FROM sqlite_master WHERE name='documents_fts'").get()) {
    // Primary-key order avoids sorting the remaining FTS rows for every step.
    const next = db.prepare(`SELECT d.id,d.name,f.body,d.frontmatter_json
      FROM documents d JOIN documents_fts f ON f.rowid=d.id
      WHERE d.id>? ORDER BY d.id LIMIT 1`)
    const insert = db.prepare('INSERT INTO documents_fts_rebuild(rowid,name,body,title) VALUES(?,?,?,?)')
    let cursor = 0
    while (true) {
      const row = next.get<{ id: number; name: string; body: string; frontmatter_json: string | null }>(cursor)
      if (!row) break
      insert.run(row.id, buildFtsSearchText(row.name), row.body, buildFtsSearchText(searchIndexTitle(row.frontmatter_json)))
      cursor = row.id
    }
  }
  db.exec(`DROP TRIGGER IF EXISTS documents_ad;
    DROP TABLE IF EXISTS documents_fts;
    ALTER TABLE documents_fts_rebuild RENAME TO documents_fts;
    CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
      DELETE FROM documents_fts WHERE rowid=old.id;
    END;
    UPDATE documents SET content_hash=NULL,mtime=NULL;`)
}
