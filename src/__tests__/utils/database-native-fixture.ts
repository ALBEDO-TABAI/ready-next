import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMigrations } from '../../main/modules/migrations'
import { ObjectRegistry } from '../../main/modules/object-service/registry'
import { DocumentPageService } from '../../main/modules/document-pages/service'
import { DocumentDatabaseService } from '../../main/modules/document-database/service'
import { SearchEngine } from '../../main/modules/search-engine/indexer'
import type { DocumentTabTransport } from '../../main/modules/document-engine/document-write-service'
import { writeDatabase } from '../../shared/document-database'
import { definition } from './database-memory-fixture'
import type { DatabaseAPI } from '../../renderer/modules/document/database/access'

export function databaseFixture(count = 2, tabs?: DocumentTabTransport) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-m5b-'))), db = new Database(join(root, 'ready.db'))
  runMigrations(db)
  const registry = new ObjectRegistry(db), engine = new SearchEngine(db, { fts5Available: true })
  engine.getRepository().ensureWorkspace(root)
  const index = async (path: string) => { const result = await engine.indexDocument(root, path); assert.ok(result.ok, result.error) }
  const pages = new DocumentPageService(registry, { index, tabs }), service = new DocumentDatabaseService(root, registry, pages, { index, tabs })
  const databasePath = join(root, '库.md')
  writeFileSync(databasePath, writeDatabase('# 库正文\n', definition)); mkdirSync(join(root, '库'))
  const databaseId = registry.register(databasePath).id
  const paths: string[] = [], ids: string[] = []
  for (let i = 0; i < count; i++) {
    const path = join(root, '库', `页面${i}.md`)
    writeFileSync(path, `---\n文本: 原文 # 保留注释\n分数: ${i + 1}\n状态: 待办\n标签: [甲, 乙]\n日期: {start: '2026-10-15', end: '2026-10-17'}\n类型: 书\n未知: {keep: true}\n---\n正文保持\n`)
    paths.push(path); ids.push(registry.register(path).id)
  }
  const opened: string[] = []
  const api: DatabaseAPI = {
    request: async input => {
      try { return { ok: true, value: await service.request(input) } }
      catch (error) { return { ok: false, code: error instanceof Error && 'code' in error ? String(error.code) : 'database_failed', message: String(error) } }
    },
    pages: async () => [{ id: databaseId, title: '库', reference: '[[库]]' }, ...ids.map((id, i) => ({ id, title: `页面${i}`, reference: `[[库/页面${i}]]` }))],
    openRow: async id => { assert.ok(registry.get(id)); opened.push(id) },
  }
  return { root, db, registry, service, databaseId, databasePath, ids, paths, api, opened, read: (i = 0) => readFileSync(paths[i], 'utf8'), close: () => { engine.cancelPendingWorkspaceResolves(); db.close(); rmSync(root, { recursive: true, force: true }) } }
}
