import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { runMigrations } from '../main/modules/migrations'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { DocumentPageService } from '../main/modules/document-pages/service'
import { DocumentDatabaseService } from '../main/modules/document-database/service'
import { registerDocumentDatabaseIPC } from '../main/modules/document-database/ipc'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { configureDocumentWriteService, documentVersion } from '../main/modules/document-engine/document-write-service'
import { readDocumentSource, applyDocumentOperation as applyPure } from '../shared/document-operations'
import { DatabaseDefinitionSchema, writeDatabase, readDatabase } from '../shared/document-database'
import { upgradeReadingDatabase } from '../main/modules/library-engine/database-upgrade'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const definition = () => DatabaseDefinitionSchema.parse({ version: 1, source: '库', fields: { 分数: { id: 'score', name: '评分', type: 'number' }, 双倍: { id: 'double', name: '双倍', type: 'formula', expression: 'prop("score") * 2' } }, views: [{ id: 'all', name: '全部', type: 'table' }] })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-m5-'))), db = new Database(join(root, 'ready.db')); runMigrations(db)
  const registry = new ObjectRegistry(db), engine = new SearchEngine(db, { fts5Available: true })
  engine.getRepository().ensureWorkspace(root)
  const index = async (path: string) => { const result = await engine.indexDocument(root, path); assert.ok(result.ok, result.error) }
  const dependencies = { index }; configureDocumentWriteService(dependencies)
  const pages = new DocumentPageService(registry, dependencies)
  const create = (extra: Partial<ConstructorParameters<typeof DocumentDatabaseService>[3]> = {}) => new DocumentDatabaseService(root, registry, pages, { ...dependencies, ...extra })
  writeFileSync(join(root, '库.md'), writeDatabase('# database\n', definition())); mkdirSync(join(root, '库'))
  const databaseId = registry.register(join(root, '库.md')).id
  const path = join(root, '库', 'A.md'), content = '---\r\n分数: 2 # comment\r\nunknown: { nested: yes } # keep\r\n---\r\n正文\r\n'
  writeFileSync(path, content)
  const rowId = registry.register(path).id, service = create()
  return { root, db, registry, engine, index, dependencies, pages, create, service, databaseId, rowId, path, content,
    close: () => { configureDocumentWriteService(null); engine.cancelPendingWorkspaceResolves(); if (db.open) db.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('DB3 real writer patches only the requested key, rejects stale versions and does not store formula results', async t => {
  if (skipIfSqliteUnavailable(t, 'Document database')) return
  const f = fixture()
  try {
    const first = f.service.read(f.databaseId)
    const receipt = await f.service.request({ type: 'setFields', databaseId: f.databaseId, rowId: f.rowId, expectedVersion: first.rows[0].version, set: { score: 4 } })
    assert.equal(readFileSync(f.path, 'utf8'), f.content.replace('分数: 2', '分数: 4'))
    assert.match(JSON.stringify(receipt), /"state":"saved"/)
    assert.deepEqual(f.service.query(f.databaseId, 'all').rows[0].cells.double, { status: 'value', value: 8 })
    assert.equal('双倍' in readDocumentSource(readFileSync(f.path, 'utf8')).frontmatter, false)
    await assert.rejects(f.service.request({ type: 'setFields', databaseId: f.databaseId, rowId: f.rowId, expectedVersion: first.rows[0].version, set: { score: 6 } }), /version/)
    await assert.rejects(f.service.request({ type: 'setFields', databaseId: f.databaseId, rowId: f.rowId, expectedVersion: documentVersion(readFileSync(f.path, 'utf8')), set: { double: 9 } }), /computed/)
    writeFileSync(f.path, f.content.replace('分数: 2', '分数: 7'))
    assert.deepEqual(f.service.query(f.databaseId, 'all').rows[0].cells.double, { status: 'value', value: 14 })
    mkdirSync(join(f.root, '库', 'A')); writeFileSync(join(f.root, '库', 'A', 'child.md'), 'child')
    assert.equal(f.service.read(f.databaseId).rows.length, 1)
    const snapshot = f.service.read(f.databaseId); snapshot.definition.fields.分数.name = '显示名'
    await f.service.request({ type: 'setDefinition', databaseId: f.databaseId, expectedVersion: snapshot.version, definition: snapshot.definition })
    assert.equal(readDocumentSource(readFileSync(f.path, 'utf8')).frontmatter.分数, 7)
    const renamed = f.service.read(f.databaseId); renamed.definition.views[0].name = '新视图名'
    await f.service.request({ type: 'setDefinition', databaseId: f.databaseId, expectedVersion: renamed.version, definition: renamed.definition })
    assert.deepEqual(f.service.read(f.databaseId).referenceRepairs, [{ viewId: 'all', oldName: '全部', newName: '新视图名', state: 'pending_reference_repair' }])
    await assert.rejects(f.service.request({ type: 'setDefinition', databaseId: f.databaseId, expectedVersion: renamed.version, definition: renamed.definition }), /version_conflict/)
  } finally { f.close() }
})

test('DB3 key migration resumes after interrupted publish, retries once and preserves new user edits', async t => {
  if (skipIfSqliteUnavailable(t, 'Document database')) return
  const f = fixture()
  try {
    const request = { type: 'renameKey' as const, databaseId: f.databaseId, expectedVersion: f.service.read(f.databaseId).version, operationId: 'rename-score', fieldId: 'score', key: '评分' }
    const failing = f.create({ afterMigrationWrite: () => { throw new Error('injected interruption') } })
    await assert.rejects(failing.request(request), /injected/)
    assert.equal(readDocumentSource(readFileSync(f.path, 'utf8')).frontmatter.评分, 2)
    assert.throws(() => f.service.read(f.databaseId), /migration_in_progress/)
    const recovered = f.create(); await recovered.recover()
    const receipt = await recovered.request(request), bytes = readFileSync(f.path, 'utf8')
    assert.deepEqual(await recovered.request(request), receipt)
    assert.equal(readFileSync(f.path, 'utf8'), bytes)
    assert.equal(recovered.read(f.databaseId).definition.fields.评分.id, 'score')
    assert.equal(recovered.query(f.databaseId, 'all').rows[0].cells.double.status, 'value')
    assert.match(bytes, /unknown: \{ nested: yes \} # keep\r\n/)
    await assert.rejects(recovered.request({ ...request, key: 'other' }), /operation_conflict/)
    const second = { ...request, operationId: 'second', key: '成绩', expectedVersion: recovered.read(f.databaseId).version }
    await assert.rejects(failing.request(second), /injected/)
    writeFileSync(f.path, readFileSync(f.path, 'utf8') + 'new user text\n')
    await assert.rejects(f.create().recover(), /version_conflict/)
    assert.ok(readFileSync(f.path, 'utf8').endsWith('new user text\n'))
  } finally { f.close() }
})

test('DB3 new rows use page service receipts and deletion enters its recoverable trash', async t => {
  if (skipIfSqliteUnavailable(t, 'Document database')) return
  const f = fixture()
  try {
    const request = { type: 'createRow' as const, databaseId: f.databaseId, operationId: 'create', title: 'new', values: { score: 5 }, body: 'body' }
    const created = await f.service.request(request)
    assert.deepEqual(await f.service.request(request), created)
    const row = f.service.read(f.databaseId).rows.find(row => row.title === 'new')!
    assert.ok(row); assert.equal(f.service.read(f.databaseId).rows.length, 2)
    const trash = { type: 'deleteRow' as const, databaseId: f.databaseId, rowId: row.id, operationId: 'trash' }
    const receipt = await f.service.request(trash); assert.deepEqual(await f.service.request(trash), receipt)
    assert.equal(f.registry.get(row.id)?.status, 'trashed'); assert.equal(f.pages.trash(f.root)[0].objectId, row.id)
    assert.equal(f.service.read(f.databaseId).rows.length, 1)
    await f.pages.operate({ type: 'restore', root: f.root, objectId: row.id, operationId: 'restore' })
    assert.equal(f.service.read(f.databaseId).rows.length, 2)
  } finally { f.close() }
})

test('DB3 dirty buffer receipt is unsaved and never changes disk', async t => {
  if (skipIfSqliteUnavailable(t, 'Document database')) return
  const f = fixture()
  try {
    let next = '', buffer = f.content + 'draft'
    const service = f.create({ tabs: async request => {
      if (request.phase === 'prepare') next = applyPure(buffer, request.operation)
      if (request.phase === 'commit') buffer = next
      return { ok: true, tabs: [{ id: 'dirty', path: f.path, content: f.content + 'draft', isDirty: true }], content: next }
    } })
    const receipt = await service.request({ type: 'setFields', databaseId: f.databaseId, rowId: f.rowId, expectedVersion: documentVersion(f.content), set: { score: 8 } })
    assert.match(JSON.stringify(receipt), /"state":"unsaved"/)
    assert.equal(readFileSync(f.path, 'utf8'), f.content); assert.match(buffer, /分数: 8/)
  } finally { f.close() }
})

test('DB5 reading migration backs up original files, resumes, and preserves custom views and nested sources', async t => {
  if (skipIfSqliteUnavailable(t, 'Document database')) return
  const f = fixture()
  try {
    mkdirSync(join(f.root, '阅读', 'nested'), { recursive: true })
    const path = join(f.root, '阅读.md'), original = '---\r\ncustom: { untouched: yes } # keep\r\nready_database:\r\n  source: 阅读\r\n  fields:\r\n    来源: { type: text }\r\n    作者: { type: text }\r\n  views:\r\n    - { name: 私人视图, type: table, custom: true }\r\n---\r\n阅读正文\r\n'
    writeFileSync(path, original)
    const rowPath = join(f.root, '阅读', 'nested', 'book.md'), row = '---\n作者: author\n来源: {kind: local, ref: original}\n---\nnotes\n'
    writeFileSync(rowPath, row)
    await assert.rejects(upgradeReadingDatabase(f.root, { afterWrite: () => { throw new Error('interrupted') } }), /interrupted/)
    assert.equal(readFileSync(path, 'utf8'), original)
    const backupDir = join(f.root, '.ready', 'database-upgrades', 'reading-v1')
    const backups = readdirSync(backupDir).filter(name => name.endsWith('.backup')).map(name => readFileSync(join(backupDir, name), 'utf8'))
    assert.ok(backups.includes(original)); assert.ok(backups.includes(row))
    await upgradeReadingDatabase(f.root)
    const next = readFileSync(path, 'utf8'), def = readDatabase(next)
    assert.equal(def.recursive, true); assert.equal(def.fields.来源说明.type, 'text'); assert.equal(def.views[0].name, '私人视图'); assert.equal(def.views[0].custom, true)
    assert.ok(next.includes('custom: { untouched: yes } # keep\r\n')); assert.ok(next.endsWith('阅读正文\r\n'))
    assert.deepEqual(readDocumentSource(readFileSync(rowPath, 'utf8')).frontmatter.来源, { kind: 'local', ref: 'original' })
    assert.equal(readDocumentSource(readFileSync(rowPath, 'utf8')).frontmatter.来源说明, 'local · original')
    assert.equal(f.service.read(f.registry.register(path).id).rows.length, 1)
    assert.equal(writeDatabase(next, def), next)
    await upgradeReadingDatabase(f.root); assert.equal(readFileSync(path, 'utf8'), next)
  } finally { f.close() }
})

test('DB3 IPC rejects unauthorized roots and invalid requests; personal state persists without touching files', async t => {
  if (skipIfSqliteUnavailable(t, 'Document database')) return
  const f = fixture()
  try {
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
    let allowed = true
    registerDocumentDatabaseIPC({ handle: (channel, handler) => { handlers.set(channel, handler) } }, f.service, Promise.resolve(), path => { assert.equal(path, f.root); if (!allowed) throw new Error('unauthorized') })
    const invoke = (input: unknown) => handlers.get('documentDatabase:request')!({} as IpcMainInvokeEvent, input)
    assert.equal((await invoke({ type: 'query', databaseId: f.databaseId, viewId: 'all' })).ok, true)
    assert.equal((await invoke({ type: 'query', databaseId: f.databaseId, viewId: 'all', limit: -1 })).ok, false)
    const before = readFileSync(join(f.root, '库.md'), 'utf8')
    const state = { currentViewId: 'all', widths: { score: 200 }, scroll: { x: 0, y: 20 } }
    assert.equal((await invoke({ type: 'setState', databaseId: f.databaseId, state })).ok, true)
    assert.deepEqual(await f.create().request({ type: 'getState', databaseId: f.databaseId }), state)
    assert.equal(readFileSync(join(f.root, '库.md'), 'utf8'), before)
    allowed = false; assert.equal((await invoke({ type: 'read', databaseId: f.databaseId })).ok, false)
    assert.equal(existsSync(join(f.root, 'outside')), false)
  } finally { f.close() }
})

test('DB3 related-object changes invalidate rollups and relations pin the target identity', async t => {
  if (skipIfSqliteUnavailable(t, 'Document database')) return
  const f = fixture()
  try {
    const original = f.content.replace(/\r\n/g, '\n'); writeFileSync(f.path, original)
    const target = join(f.root, 'target.md'); writeFileSync(target, '---\n价格: 7\n---\ntarget')
    const targetId = f.registry.register(target).id; await f.index(target)
    const snapshot = f.service.read(f.databaseId)
    snapshot.definition.fields.关联 = { id: 'links', name: '关联', type: 'relation' }
    snapshot.definition.fields.总价 = { id: 'total', name: '总价', type: 'rollup', relation: 'links', target: '价格', operation: 'sum' }
    await f.service.request({ type: 'setDefinition', databaseId: f.databaseId, expectedVersion: snapshot.version, definition: snapshot.definition })
    await f.service.request({ type: 'setFields', databaseId: f.databaseId, rowId: f.rowId, expectedVersion: documentVersion(original), set: { links: ['[[target]]'] } })
    assert.equal(readDocumentSource(readFileSync(target, 'utf8')).frontmatter.ready_id, targetId)
    assert.deepEqual(f.service.query(f.databaseId, 'all').rows[0].cells.total, { status: 'value', value: 7 })
    writeFileSync(target, readFileSync(target, 'utf8').replace('价格: 7', '价格: 9'))
    assert.deepEqual(f.service.query(f.databaseId, 'all').rows[0].cells.total, { status: 'value', value: 9 })
    const before = readFileSync(f.path, 'utf8')
    await assert.rejects(f.service.request({ type: 'setFields', databaseId: f.databaseId, rowId: f.rowId, expectedVersion: documentVersion(before), set: { links: ['[[missing]]'] } }), /incomplete/)
    assert.equal(readFileSync(f.path, 'utf8'), before)
    // Returned snapshots never let a caller mutate the read cache.
    const returned = f.service.read(f.databaseId); returned.rows[0].values.分数 = 123
    assert.equal(f.service.read(f.databaseId).rows[0].values.分数, 2)
    await f.pages.operate({ type: 'trash', root: f.root, operationId: 'trash-target', objectId: targetId })
    assert.equal(f.service.query(f.databaseId, 'all').rows[0].cells.total.status, 'incomplete')
  } finally { f.close() }
})

test('DB3 a process exit after a row publish resumes from the persistent operation after reopening SQLite', async t => {
  if (skipIfSqliteUnavailable(t, 'Document database')) return
  const f = fixture(), databaseFile = join(f.root, 'ready.db')
  let reopened: Database.Database | undefined
  try {
    const request = { type: 'renameKey' as const, databaseId: f.databaseId, operationId: 'crash-key', expectedVersion: f.service.read(f.databaseId).version, fieldId: 'score', key: '成绩' }
    f.engine.cancelPendingWorkspaceResolves(); f.db.close()
    const url = (path: string) => JSON.stringify(pathToFileURL(join(process.cwd(), path)).href)
    const child = join(f.root, 'crash.ts')
    writeFileSync(child, `import Database from ${url('node_modules/better-sqlite3/lib/index.js')};
import {ObjectRegistry} from ${url('src/main/modules/object-service/registry.ts')};
import {DocumentPageService} from ${url('src/main/modules/document-pages/service.ts')};
import {DocumentDatabaseService} from ${url('src/main/modules/document-database/service.ts')};
import {SearchEngine} from ${url('src/main/modules/search-engine/indexer.ts')};
const root=${JSON.stringify(f.root)}, db=new Database(${JSON.stringify(databaseFile)}), registry=new ObjectRegistry(db), engine=new SearchEngine(db,{fts5Available:true});
const index=async path=>{const result=await engine.indexDocument(root,path);if(!result.ok)throw new Error(result.error)};
const service=new DocumentDatabaseService(root,registry,new DocumentPageService(registry,{index}),{index,afterMigrationWrite:()=>process.exit(86)});
service.request(${JSON.stringify(request)}).catch(error=>{console.error(error);process.exit(1)});`)
    const result = spawnSync(process.execPath, ['--import', 'tsx', child], { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
    assert.equal(result.status, 86, result.stderr)
    reopened = new Database(databaseFile)
    const registry = new ObjectRegistry(reopened), engine = new SearchEngine(reopened, { fts5Available: true })
    const index = async (path: string) => { const result = await engine.indexDocument(f.root, path); assert.ok(result.ok, result.error) }
    const service = new DocumentDatabaseService(f.root, registry, new DocumentPageService(registry, { index }), { index })
    try {
      await service.recover(); await service.recover()
      assert.equal(service.operation(f.databaseId, 'crash-key')?.state, 'committed')
      assert.deepEqual(await service.request(request), await service.request(request))
      assert.equal(service.read(f.databaseId).definition.fields.成绩.id, 'score')
      assert.equal(readDocumentSource(readFileSync(f.path, 'utf8')).frontmatter.成绩, 2)
      assert.equal(reopened.prepare('PRAGMA foreign_key_check').all().length, 0)
    } finally { engine.cancelPendingWorkspaceResolves() }
  } finally { reopened?.close(); f.close() }
})
