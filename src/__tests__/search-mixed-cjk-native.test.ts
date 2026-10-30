import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { runMigrations } from '../main/modules/migrations'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('titles mixing letters or numbers with Chinese are found by their full name and by either part', async t => {
  if (skipIfSqliteUnavailable(t, 'Mixed CJK search')) return
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-search-mixed-')))
  const db = new Database(':memory:'); runMigrations(db)
  const engine = new SearchEngine(db as never, { fts5Available: true })
  t.after(() => { engine.cancelPendingWorkspaceResolves(); db.close(); rmSync(root, { recursive: true, force: true }) })
  engine.getRepository().ensureWorkspace(root)
  writeFileSync(join(root, 'M5验收目标.md'), '# 速览正文')
  writeFileSync(join(root, 'Q4计划.md'), '预算与 2026年度总结')
  for (const name of ['M5验收目标.md', 'Q4计划.md']) assert.ok((await engine.indexDocument(root, join(root, name))).ok)
  const names = async (query: string) => (await engine.search(query, { workspaceRoots: [root] })).items.map(item => item.name)
  assert.deepEqual(await names('M5验收目标'), ['M5验收目标.md'])
  assert.deepEqual(await names('M5'), ['M5验收目标.md'])
  assert.deepEqual(await names('验收目标'), ['M5验收目标.md'])
  assert.deepEqual(await names('Q4计划'), ['Q4计划.md'])
  assert.deepEqual(await names('2026'), ['Q4计划.md'])
})
