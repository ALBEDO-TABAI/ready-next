import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMigrations } from '../../main/modules/migrations'
import { ObjectRegistry } from '../../main/modules/object-service/registry'
import { SearchEngine } from '../../main/modules/search-engine/indexer'
import { DocumentPageService } from '../../main/modules/document-pages/service'
import { DocumentDatabaseService } from '../../main/modules/document-database/service'
import { CalendarLayersService } from '../../main/modules/calendar-layers/service'

export function todoFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-b9-todos-')))
  const db = new Database(':memory:'); runMigrations(db)
  const registry = new ObjectRegistry(db), engine = new SearchEngine(db, { fts5Available: true })
  engine.getRepository().ensureWorkspace(root)
  const writer = { index: async (path: string) => { const result = await engine.indexDocument(root, path); assert.ok(result.ok, result.error) } }
  const pages = new DocumentPageService(registry, writer), database = new DocumentDatabaseService(root, registry, pages, writer)
  const service = new CalendarLayersService(root, registry, database, writer, pages)
  return { root, db, registry, engine, writer, pages, database, service,
    add(name: string, content: string) { const path = join(root, name); writeFileSync(path, content); return registry.register(path) },
    close() { engine.cancelPendingWorkspaceResolves(); db.close(); rmSync(root, { recursive: true, force: true }) },
  }
}
