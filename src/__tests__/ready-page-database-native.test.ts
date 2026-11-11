import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { runMigrations } from '../main/modules/migrations'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { DocumentPageService } from '../main/modules/document-pages/service'
import { DocumentDatabaseService } from '../main/modules/document-database/service'
import { configureDocumentWriteService } from '../main/modules/document-engine/document-write-service'
import { readDatabase, writeDatabase } from '../shared/document-database/format'
import { readDocumentSource } from '../shared/document-operations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ready-page-db-'))), root = join(directory, 'vault')
  mkdirSync(root)
  const databaseFile = join(directory, 'ready.db'), db = new Database(databaseFile); runMigrations(db)
  const registry = new ObjectRegistry(db), engine = new SearchEngine(db, { fts5Available: true })
  engine.getRepository().ensureWorkspace(root)
  const index = async (path: string) => { const result = await engine.indexDocument(root, path); assert.ok(result.ok, result.error) }
  configureDocumentWriteService({ index })
  const pages = new DocumentPageService(registry, { index }), service = new DocumentDatabaseService(root, registry, pages, { index })
  const create = (operationId = 'create', title = '库', content = '') => pages.operate({ type: 'create', root, parentPath: root, operationId, title, content, database: true })
  return { directory, root, databaseFile, db, registry, engine, index, pages, service, create,
    close: () => { configureDocumentWriteService(null); engine.cancelPendingWorkspaceResolves(); if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }) } }
}

test('W3-T6 create uses the page receipt, defines three fields, creates a row and hides rows only in the page tree', async t => {
  if (skipIfSqliteUnavailable(t, 'Page database')) return
  const f = fixture()
  try {
    const page = await f.create(), content = readFileSync(page.path!, 'utf8'), definition = readDatabase(content)
    assert.equal(page.path, join(f.root, '库.md'))
    assert.ok(existsSync(join(f.root, '库')))
    assert.deepEqual(definition, { version: 1, source: '库', fields: {
      状态: { id: 'status', name: '状态', type: 'select', options: ['未开始', '进行中', '完成'] },
      日期: { id: 'date', name: '日期', type: 'date' },
      标签: { id: 'tags', name: '标签', type: 'multi_select', options: [] },
    }, views: [{ id: 'table', name: '表格', type: 'table', visibleFields: ['$title', 'status', 'date', 'tags'] }] })
    assert.equal(readDocumentSource(content).body, '')
    assert.deepEqual(f.service.read(page.objectId).definition, definition)
    assert.deepEqual(await f.create(), page)
    await f.service.request({ type: 'createRow', databaseId: page.objectId, operationId: 'row', title: '第一行', values: { status: '进行中', date: '2026-11-11', tags: [] } })
    const rowPath = join(f.root, '库', '第一行.md'), row = f.registry.find(rowPath)!
    assert.ok(existsSync(rowPath))
    assert.deepEqual(f.service.query(page.objectId, 'table').rows.map(r => r.id), [row.id])
    const tree = f.pages.tree({ path: f.root, kind: 'vault' })
    assert.equal(tree.children.length, 1)
    assert.equal(tree.children[0].database, true)
    assert.deepEqual(tree.children[0].children, [])
    assert.equal(tree.children[0].hasChildren, false)
    assert.ok(existsSync(rowPath), 'tree projection never removes the row file')
  } finally { f.close() }
})

test('W3-T6 database collisions use the final filename; ordinary page collisions still return candidates', async t => {
  if (skipIfSqliteUnavailable(t, 'Page database')) return
  const f = fixture()
  try {
    await f.create()
    mkdirSync(join(f.root, '库 (2)'))
    const page = await f.create('second')
    assert.equal(page.path, join(f.root, '库 (3).md'))
    assert.equal(readDatabase(readFileSync(page.path!, 'utf8')).source, '库 (3)')
    assert.ok(existsSync(join(f.root, '库 (3)')))
    assert.deepEqual(await f.create('second'), page)
    const sanitized = await f.create('sanitized', '有:名字')
    assert.equal(readDatabase(readFileSync(sanitized.path!, 'utf8')).source, '有_名字')
    await assert.rejects(f.pages.operate({ type: 'create', root: f.root, parentPath: f.root, operationId: 'ordinary', title: '库' }), { code: 'name_collision' })
  } finally { f.close() }
})

test('W3-T6 rename updates the owned source in the same patch, preserves other bytes and move keeps source', async t => {
  if (skipIfSqliteUnavailable(t, 'Page database')) return
  const f = fixture()
  try {
    const page = await f.create('create', 'A', '---\nunknown: { x: 1 } # keep\n---\n正文\n')
    const original = readFileSync(page.path!, 'utf8').replace('source: A', 'source: A # row folder').replace(/\n/g, '\r\n')
    writeFileSync(page.path!, original)
    await f.service.request({ type: 'createRow', databaseId: page.objectId, operationId: 'row', title: '行', values: {} })
    const rowId = f.service.read(page.objectId).rows[0].id
    const renamed = await f.pages.operate({ type: 'rename', root: f.root, operationId: 'rename', objectId: page.objectId, title: 'B' })
    const after = readFileSync(renamed.path!, 'utf8')
    assert.equal(after.replace('source: B', 'source: A').replace('title: B\r\n', ''), original)
    assert.equal(readDatabase(after).source, 'B')
    assert.ok(existsSync(join(f.root, 'B', '行.md')))
    assert.deepEqual(f.service.query(page.objectId, 'table').rows.map(r => r.id), [rowId])
    mkdirSync(join(f.root, '目标'))
    const moved = await f.pages.operate({ type: 'move', root: f.root, operationId: 'move', objectId: page.objectId, parentPath: join(f.root, '目标') })
    assert.equal(readFileSync(moved.path!, 'utf8'), after)
    assert.deepEqual(f.service.query(page.objectId, 'table').rows.map(r => r.id), [rowId])
  } finally { f.close() }
})

test('W3-T6 a database pointing elsewhere retains source and ordinary child pages on rename', async t => {
  if (skipIfSqliteUnavailable(t, 'Page database')) return
  const f = fixture()
  try {
    const page = await f.create('create', 'A')
    const before = readFileSync(page.path!, 'utf8')
    writeFileSync(page.path!, writeDatabase(before, { ...readDatabase(before), source: '别处' }))
    mkdirSync(join(f.root, '别处')); writeFileSync(join(f.root, '别处', '行.md'), 'row')
    writeFileSync(join(f.root, 'A', '子页.md'), 'child')
    const renamed = await f.pages.operate({ type: 'rename', root: f.root, operationId: 'rename', objectId: page.objectId, title: 'B' })
    assert.equal(readDatabase(readFileSync(renamed.path!, 'utf8')).source, '别处')
    assert.equal(f.service.query(page.objectId, 'table').rows.length, 1)
    const tree = f.pages.tree({ path: f.root, kind: 'vault' }), node = tree.children.find(n => n.objectId === page.objectId)!
    assert.equal(node.database, true); assert.equal(node.hasChildren, true)
    assert.deepEqual(node.children.map(n => n.name), ['子页.md'])
    assert.deepEqual(tree.children.find(n => n.name === '别处')!.children.map(n => n.name), ['行.md'])
  } finally { f.close() }
})

test('W3-T6 interrupted creation resumes the chosen name and folder; failed rename restores original bytes', async t => {
  if (skipIfSqliteUnavailable(t, 'Page database')) return
  const f = fixture()
  try {
    await f.create()
    const request = { type: 'create' as const, root: f.root, parentPath: f.root, operationId: 'interrupted', title: '库', database: true }
    const failing = new DocumentPageService(f.registry, { index: async () => { throw new Error('index interrupted') } })
    await assert.rejects(failing.operate(request), /index interrupted/)
    assert.equal(failing.operation(request.operationId)?.state, 'recovery_required')
    await f.pages.recover(); await f.pages.recover()
    const page = await f.pages.operate(request), original = readFileSync(page.path!, 'utf8')
    assert.equal(page.path, join(f.root, '库 (2).md'))
    assert.ok(existsSync(join(f.root, '库 (2)')))
    assert.equal(readDatabase(original).source, '库 (2)')
    const brokenRename = new DocumentPageService(f.registry, { index: f.index, afterMove: () => { throw new Error('move interrupted') } })
    await assert.rejects(brokenRename.operate({ type: 'rename', root: f.root, operationId: 'fail-rename', objectId: page.objectId, title: 'B' }), /move interrupted/)
    assert.equal(readFileSync(page.path!, 'utf8'), original)
    assert.equal(existsSync(join(f.root, 'B.md')), false)
    assert.equal(f.pages.operation('fail-rename')?.state, 'rolled_back')
    assert.deepEqual(f.service.read(page.objectId).rows, [])
  } finally { f.close() }
})

test('W3-T6 process exit after patched rename restores the source, folder, rows and identity on reopen', async t => {
  if (skipIfSqliteUnavailable(t, 'Page database')) return
  const f = fixture()
  let reopened: Database.Database | undefined
  try {
    const page = await f.create(), original = readFileSync(page.path!, 'utf8')
    await f.service.request({ type: 'createRow', databaseId: page.objectId, operationId: 'row', title: '行', values: {} })
    const rowId = f.service.read(page.objectId).rows[0].id
    f.engine.cancelPendingWorkspaceResolves(); f.db.close()
    const url = (path: string) => JSON.stringify(pathToFileURL(join(process.cwd(), path)).href)
    const child = join(f.directory, 'crash.ts')
    writeFileSync(child, `import Database from ${url('node_modules/better-sqlite3/lib/index.js')};
import {ObjectRegistry} from ${url('src/main/modules/object-service/registry.ts')};
import {DocumentPageService} from ${url('src/main/modules/document-pages/service.ts')};
const db = new Database(${JSON.stringify(f.databaseFile)});
const pages = new DocumentPageService(new ObjectRegistry(db), {index: async () => {}, afterMove: () => process.exit(86)});
pages.operate(${JSON.stringify({ type: 'rename', root: f.root, operationId: 'crash', objectId: page.objectId, title: 'B' })}).catch(error => {console.error(error); process.exit(1)});`)
    const childResult = spawnSync(process.execPath, ['--import', 'tsx', child], { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
    assert.equal(childResult.status, 86, childResult.stderr)
    assert.equal(readDatabase(readFileSync(join(f.root, 'B.md'), 'utf8')).source, 'B')
    reopened = new Database(f.databaseFile)
    const registry = new ObjectRegistry(reopened), pages = new DocumentPageService(registry, { index: async () => {} })
    await pages.recover(); await pages.recover()
    assert.equal(pages.operation('crash')?.state, 'rolled_back')
    assert.equal(registry.get(page.objectId)?.current_path, page.path)
    assert.equal(readFileSync(page.path!, 'utf8'), original)
    assert.equal(existsSync(join(f.root, 'B.md')), false)
    const database = new DocumentDatabaseService(f.root, registry, pages, { index: async () => {} })
    assert.deepEqual(database.query(page.objectId, 'table').rows.map(r => r.id), [rowId])
    assert.ok(existsSync(join(f.root, '库', '行.md')))
    assert.equal(pages.tree({ path: f.root, kind: 'vault' }).children[0].hasChildren, false)
    assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { reopened?.close(); f.close() }
})
