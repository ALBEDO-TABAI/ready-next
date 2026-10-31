import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMigrations } from '../main/modules/migrations'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { DocumentPageService } from '../main/modules/document-pages/service'
import { DocumentDatabaseService } from '../main/modules/document-database/service'
import { DocumentImportService, type ImportStage } from '../main/modules/document-import/service'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { readDocumentSource } from '../shared/document-operations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { notionFixture, inkwellFixture } from './fixtures/document-import/sources'

function fixture(hook?: (stage: ImportStage, index: number) => void) {
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'ready-import-'))), root = join(temporary, 'vault')
  mkdirSync(root)
  let db: Database.Database, engine: SearchEngine
  const open = () => {
    db = new Database(join(temporary, 'test.db')); runMigrations(db)
    const registry = new ObjectRegistry(db); engine = new SearchEngine(db, { fts5Available: true }); engine.getRepository().ensureWorkspace(root)
    const index = async (path: string) => { const result = await engine.indexDocument(root, path); assert.ok(result.ok, result.error) }
    const pages = new DocumentPageService(registry, { index }), databases = new DocumentDatabaseService(root, registry, pages, { index })
    return { importer: new DocumentImportService(root, pages, databases, hook), registry, databases, db }
  }
  const stop = () => { engine.cancelPendingWorkspaceResolves(); db.close() }
  return { temporary, root, open, stop, close: () => { stop(); rmSync(temporary, { recursive: true, force: true }) } }
}

test('DB6 real SQLite: read-only preview, complete Inkwell import, restart, unique retry and source unchanged', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-E import')) return
  const f = fixture(), s = f.open(), source = join(f.temporary, 'workspace.json'), bytes = Buffer.from(JSON.stringify(inkwellFixture()))
  writeFileSync(source, bytes)
  try {
    const selected = s.importer.addSource(source, 'inkwell'), before = s.db.prepare('SELECT COUNT(*) AS count FROM objects').get()
    const report = s.importer.preflight(selected.sourceId, { parentPath: f.root, title: '导入' })
    assert.deepEqual(readdirSync(f.root), []); assert.deepEqual(s.db.prepare('SELECT COUNT(*) AS count FROM objects').get(), before)
    const [result, duplicate] = await Promise.all([s.importer.execute(report.id), s.importer.execute(report.id)])
    assert.deepEqual(duplicate.results, result.results)
    assert.equal(result.state, 'completed', result.error ?? JSON.stringify(result.issues)); assert.equal(result.results.length, 5)
    const database = result.results.find(result => result.database)!, read = s.databases.read(database.objectId)
    assert.equal(read.rows.length, 1); assert.equal(read.rows[0].values.import_n, 12); assert.equal(read.definition.views.length, 6)
    assert.deepEqual(readFileSync(join(f.root, '导入', '首页.assets', 'image.png')), Buffer.from('iVBORwECAw==', 'base64'))
    const ids = result.results.map(result => result.objectId)
    f.stop(); const restarted = f.open(), retried = await restarted.importer.resume(report.id)
    assert.deepEqual(retried.results.map(result => result.objectId), ids); assert.equal(retried.state, 'completed')
    assert.deepEqual(readFileSync(source), bytes)
    assert.equal(restarted.importer.preflight(restarted.importer.addSource(source, 'inkwell').sourceId, { parentPath: f.root, title: '导入' }).id, report.id)
    writeFileSync(join(f.root, '导入', '首页.md'), '用户新修改')
    const changed = await restarted.importer.resume(report.id); assert.equal(changed.state, 'incomplete'); assert.ok(changed.issues.some(issue => issue.message.includes('变化')))
    assert.equal(readFileSync(join(f.root, '导入', '首页.md'), 'utf8'), '用户新修改')
  } finally { f.close() }
})

test('DB6 every import stage can be interrupted and resumed after SQLite reopen without duplicate pages', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-E import recovery')) return
  const points: { stage: ImportStage; index: number }[] = [
    ...(['prepared', 'staged', 'asset', 'verified'] as const).map(stage => ({ stage, index: 0 })),
    ...Array.from({ length: 8 }, (_, index) => ({ stage: 'page' as const, index })),
  ]
  for (const { stage, index } of points) {
    let failed = false
    const f = fixture((current, currentIndex) => { if (current === stage && currentIndex === index && !failed) { failed = true; throw new Error(`injected ${stage}`) } }), s = f.open()
    const source = join(f.temporary, 'source.zip'), bytes = await notionFixture(); writeFileSync(source, bytes)
    try {
      const report = s.importer.preflight(s.importer.addSource(source, 'notion').sourceId, { parentPath: f.root, title: '导入' })
      try { const result = await s.importer.execute(report.id); assert.equal(result.state, 'interrupted') } catch (error) { assert.equal(stage, 'prepared'); assert.match(String(error), /injected/) }
      assert.ok(failed); f.stop(); const next = f.open(), result = await next.importer.resume(report.id)
      assert.equal(result.state, 'incomplete', result.error); assert.equal(result.results.length, 8)
      assert.equal(new Set(result.results.map(result => result.objectId)).size, 8)
      assert.deepEqual((await next.importer.resume(report.id)).results, result.results)
      assert.deepEqual(readFileSync(source), bytes)
      const row = result.results.find(result => result.path.endsWith('/事项.md'))!
      assert.equal(readDocumentSource(readFileSync(row.path, 'utf8')).frontmatter.import_1, '00123')
      assert.ok(result.issues.some(issue => issue.message.includes('missing.png')))
    } finally { f.close() }
  }
})

test('DB6 target collisions and source attachment symlinks are rejected without altering existing files', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-E import boundaries')) return
  const f = fixture(), s = f.open(), source = join(f.temporary, 'source.json')
  writeFileSync(source, JSON.stringify(inkwellFixture())); writeFileSync(join(f.root, '导入.md'), '保持原文')
  try {
    const selection = s.importer.addSource(source, 'inkwell'), report = s.importer.preflight(selection.sourceId, { parentPath: f.root, title: '导入' })
    assert.equal(report.issues.filter(issue => issue.kind === 'conflict').length, 1)
    await assert.rejects(s.importer.execute(report.id), /覆盖/); assert.equal(readFileSync(join(f.root, '导入.md'), 'utf8'), '保持原文')
    assert.throws(() => s.importer.preflight(selection.sourceId, { parentPath: f.temporary, title: '越界' }), /outside/)
    const data = inkwellFixture(); const image = data.blocks.find(block => block.id === 'image')!; image.props = { src: 'link.png' }
    symlinkSync(source, join(f.temporary, 'link.png')); writeFileSync(source, JSON.stringify(data))
    assert.throws(() => s.importer.preflight(selection.sourceId), /symbolic/)
  } finally { f.close() }
})

test('DB6 an edit after interrupted publication is preserved and stops recovery', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-E interrupted edit')) return
  let injected = false
  const f = fixture(stage => { if (stage === 'page' && !injected) { injected = true; throw new Error('after publication') } }), s = f.open()
  const source = join(f.temporary, 'source.json'); writeFileSync(source, JSON.stringify(inkwellFixture()))
  try {
    const report = s.importer.preflight(s.importer.addSource(source, 'inkwell').sourceId, { parentPath: f.root, title: '导入' })
    assert.equal((await s.importer.execute(report.id)).state, 'interrupted')
    const target = join(f.root, '导入.md'); writeFileSync(target, '用户在中断后修改')
    f.stop(); const reopened = f.open(), result = await reopened.importer.resume(report.id)
    assert.equal(result.state, 'interrupted'); assert.match(result.error!, /回读|变化/)
    assert.equal(readFileSync(target, 'utf8'), '用户在中断后修改')
    assert.equal(readdirSync(join(f.root, '导入')).length, 0)
  } finally { f.close() }
})
