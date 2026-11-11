import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toReadyUri } from '../shared/ready-ref'
import { runMigrations } from '../main/modules/migrations'
import { DocumentPageService } from '../main/modules/document-pages/service'
import { registerDocumentPagesIPC } from '../main/modules/document-pages/ipc'
import { ObjectRegistry, isInside } from '../main/modules/object-service/registry'
import { ObjectLinkRepository } from '../main/modules/search-engine/object-links'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { DocumentDraftService } from '../main/modules/document-drafts/service'
import { configureDocumentWriteService, documentVersion } from '../main/modules/document-engine/document-write-service'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ready-adopt-')))
  const root = join(directory, 'vault'), mount = join(directory, 'mounted')
  mkdirSync(root); mkdirSync(mount)
  const db = new Database(':memory:'); runMigrations(db)
  const registry = new ObjectRegistry(db), engine = new SearchEngine(db, { fts5Available: true })
  for (const path of [root, mount]) engine.getRepository().ensureWorkspace(path)
  const index = async (path: string) => {
    const result = await engine.indexDocument(isInside(root, path) ? root : mount, path)
    assert.ok(result.ok, result.error)
  }
  configureDocumentWriteService({ index })
  const dependencies = { index, vaultRoot: () => root }
  const service = new DocumentPageService(registry, dependencies)
  return { directory, root, mount, db, registry, engine, index, dependencies, service,
    close: () => { configureDocumentWriteService(null); engine.cancelPendingWorkspaceResolves(); db.close(); rmSync(directory, { recursive: true, force: true }) } }
}

function triplet(mount: string) {
  const files = new Map([
    ['A.md', '---\ntitle: 原标题\ncustom: untouched\n---\n原文\r\n'],
    ['A/child.md', 'child bytes'], ['A.assets/image.bin', 'asset bytes'],
  ])
  mkdirSync(join(mount, 'A')); mkdirSync(join(mount, 'A.assets'))
  for (const [path, content] of files) writeFileSync(join(mount, path), content)
  return files
}

test('adopt triplet through IPC preserves IDs, bytes, queries and repeated-operation receipt', async t => {
  if (skipIfSqliteUnavailable(t, 'Adopt into the library')) return
  const f = fixture(); t.after(f.close)
  const files = triplet(f.mount)
  f.registry.reconcile([f.mount])
  const before = f.registry.list().filter(o => o.current_path !== f.mount)
  const source = join(f.mount, 'A.md'), target = f.registry.find(source)!
  const reference = join(f.root, 'ref.md')
  writeFileSync(reference, `[[../mounted/A]]\n[id](${toReadyUri({ kind: 'page', id: target.id })})`)
  await f.index(reference)
  const links = new ObjectLinkRepository(f.db), refId = f.registry.find(reference)!.id
  assert.equal(links.incoming({ objectId: target.id }).length, 2)
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>(), authorized: string[] = []
  registerDocumentPagesIPC({ handle: (name, handler) => { handlers.set(name, handler) } }, f.service, Promise.resolve(), path => { authorized.push(path) })
  const invoke = (input: unknown) => handlers.get('documentPages:operate')!({} as IpcMainInvokeEvent, input)
  const request = { type: 'adopt', operationId: 'adopt-triplet', root: f.root, source, parentPath: f.root }
  const result = await invoke(request)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.value.objectId, target.id); assert.equal(result.value.path, join(f.root, 'A.md'))
  assert.ok(authorized.includes(source)); assert.ok(authorized.includes(f.root))
  assert.deepEqual(await invoke(request), result)
  for (const object of before) {
    const next = object.current_path!.replace(f.mount, f.root)
    assert.equal(f.registry.get(object.id)?.current_path, next)
    assert.equal(f.registry.find(next)?.id, object.id)
    assert.equal(existsSync(object.current_path!), false)
  }
  for (const [path, content] of files) assert.equal(readFileSync(join(f.root, path), 'utf8'), content)
  const outgoing = links.outgoing({ objectId: refId }), incoming = links.incoming({ objectId: target.id })
  assert.equal(outgoing.length, 2); assert.equal(incoming.length, 2)
  for (const edge of outgoing) { assert.equal(edge.resolved, true); assert.deepEqual(edge.target, { objectId: target.id }) }
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0)
})

test('adopt a mounted root with nested files and adopt a previously unregistered file', async t => {
  if (skipIfSqliteUnavailable(t, 'Adopt into the library')) return
  const f = fixture(); t.after(f.close)
  mkdirSync(join(f.mount, 'nested')); writeFileSync(join(f.mount, 'nested', 'note.md'), 'nested')
  writeFileSync(join(f.mount, 'data.bin'), Buffer.from([0, 255, 1]))
  f.registry.reconcile([f.mount])
  const before = f.registry.list()
  const parent = join(f.root, 'Parent.md'); writeFileSync(parent, 'parent')
  const parentObjectId = f.registry.register(parent).id
  const request = { type: 'adopt' as const, operationId: 'adopt-root', root: f.root, source: f.mount, parentObjectId }
  const receipt = await f.service.operate(request)
  assert.equal(receipt.path, join(f.root, 'Parent', 'mounted'))
  for (const row of before) assert.equal(f.registry.get(row.id)?.current_path, row.current_path!.replace(f.mount, receipt.path!))
  assert.equal(existsSync(f.mount), false)
  assert.deepEqual(readFileSync(join(receipt.path!, 'data.bin')), Buffer.from([0, 255, 1]))
  assert.equal(readFileSync(join(receipt.path!, 'nested', 'note.md'), 'utf8'), 'nested')
  assert.deepEqual(await f.service.operate(request), receipt)
  mkdirSync(f.mount)
  const source = join(f.mount, 'fresh.bin'); writeFileSync(source, 'new')
  assert.equal(f.registry.find(source), null)
  const fresh = await f.service.operate({ type: 'adopt', operationId: 'fresh', root: f.root, source, parentPath: f.root })
  assert.equal(f.registry.get(fresh.objectId)?.current_path, fresh.path)
  assert.equal(existsSync(source), false); assert.equal(readFileSync(fresh.path!, 'utf8'), 'new')
})

test('adopt rejects collisions, invalid boundaries and unavailable sources without changing disk', async t => {
  if (skipIfSqliteUnavailable(t, 'Adopt into the library')) return
  const f = fixture(); t.after(f.close)
  const files = triplet(f.mount), source = join(f.mount, 'A.md')
  writeFileSync(join(f.root, 'a.md'), 'collision')
  await assert.rejects(f.service.operate({ type: 'adopt', operationId: 'collision', root: f.root, source, parentPath: f.root }), { code: 'name_collision' })
  assert.equal(readFileSync(join(f.root, 'a.md'), 'utf8'), 'collision')
  for (const [path, content] of files) assert.equal(readFileSync(join(f.mount, path), 'utf8'), content)
  rmSync(join(f.root, 'a.md'))
  const inside = join(f.root, 'inside.md'); writeFileSync(inside, 'inside')
  const outside = join(f.directory, 'unmounted.md'); writeFileSync(outside, 'outside')
  const alias = join(f.mount, 'alias.md'); symlinkSync(inside, alias)
  const targetAlias = join(f.root, 'outside'); symlinkSync(f.mount, targetAlias)
  for (const [i, overrides] of [
    { source: inside }, { source: f.root }, { source: f.directory }, { parentPath: f.mount },
    { source: outside }, { source: alias }, { parentPath: targetAlias }, { root: f.mount, source: inside, parentPath: f.mount },
  ].entries()) {
    await assert.rejects(f.service.operate({ type: 'adopt', operationId: `boundary-${i}`, root: f.root, source, parentPath: f.root, ...overrides }), { code: 'invalid_path' })
  }
  await assert.rejects(f.service.operate({ type: 'adopt', operationId: 'missing', root: f.root, source: join(f.mount, 'missing.md'), parentPath: f.root }), { code: 'source_unavailable' })
  assert.equal(readFileSync(inside, 'utf8'), 'inside'); assert.equal(readFileSync(outside, 'utf8'), 'outside')
  for (const [path, content] of files) assert.equal(readFileSync(join(f.mount, path), 'utf8'), content)
  assert.equal(existsSync(join(f.root, 'A.md')), false)
  assert.equal(f.db.prepare('SELECT * FROM document_page_operations').all().length, 0)
})

test('adopt rolls back all members after a partial move and rejects dirty tabs', async t => {
  if (skipIfSqliteUnavailable(t, 'Adopt into the library')) return
  const f = fixture(); t.after(f.close)
  const files = triplet(f.mount), source = join(f.mount, 'A.md')
  f.registry.reconcile([f.mount])
  const before = f.registry.list()
  const drafts = new DocumentDraftService(f.db, { registry: f.registry, index: (_root, path) => f.index(path) })
  const draft = drafts.create({ origin: 'document', vaultRoot: f.mount, objectId: f.registry.find(source)!.id, baseVersion: documentVersion(files.get('A.md')!), content: files.get('A.md')! })
  const request = { type: 'adopt' as const, operationId: 'partial', root: f.root, source, parentPath: f.root }
  const failing = new DocumentPageService(f.registry, { ...f.dependencies, afterMove: index => { if (index === 1) throw new Error('injected failure') } })
  await assert.rejects(failing.operate(request), /injected failure/)
  await f.service.recover()
  assert.equal(f.service.operation('partial')?.state, 'rolled_back')
  for (const row of before) assert.equal(f.registry.get(row.id)?.current_path, row.current_path)
  for (const [path, content] of files) { assert.equal(readFileSync(join(f.mount, path), 'utf8'), content); assert.equal(existsSync(join(f.root, path)), false) }
  assert.equal(f.registry.list().length, before.length + 1) // destination root registered by the parent resolver
  assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length, 0)
  configureDocumentWriteService({ index: f.index, tabs: async () => ({ ok: true, tabs: [{ id: 'dirty', path: source, content: 'unsaved', isDirty: true }] }) })
  await assert.rejects(f.service.operate({ ...request, operationId: 'dirty' }), /dirty_conflict/)
  assert.equal(readFileSync(source, 'utf8'), files.get('A.md'))
  configureDocumentWriteService({ index: f.index })
  const dirtyDraft = drafts.save(draft.draftId, draft.revision, 'unsaved draft', 'tab')
  await assert.rejects(f.service.operate({ ...request, operationId: 'dirty-draft' }), /dirty_conflict/)
  drafts.save(draft.draftId, dirtyDraft.revision, files.get('A.md')!, 'tab')
  assert.equal((await f.service.operate({ ...request, operationId: 'retry' })).path, join(f.root, 'A.md'))
  const movedDraft = drafts.read(draft.draftId)!
  assert.equal(movedDraft.vaultRoot, f.root)
  assert.equal(drafts.save(draft.draftId, movedDraft.revision, 'after adoption', 'tab').revision, movedDraft.revision + 1)
})


test('adopt of a mounted root survives process exit and rolls back on database reopen', async t => {
  if (skipIfSqliteUnavailable(t, 'Adopt into the library')) return
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ready-adopt-crash-')))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, 'vault'), source = join(directory, 'mounted'), database = join(directory, 'ready.db')
  mkdirSync(root); mkdirSync(source); mkdirSync(join(source, 'nested'))
  writeFileSync(join(source, 'nested', 'file.txt'), 'original bytes')
  let db = new Database(database); runMigrations(db)
  const registry = new ObjectRegistry(db)
  db.prepare('INSERT INTO workspaces(root) VALUES (?)').run(source)
  registry.reconcile([source]); const before = registry.list()
  db.close()
  const moduleUrl = (path: string) => pathToFileURL(join(process.cwd(), path)).href
  const child = join(directory, 'crash.ts')
  writeFileSync(child, `import Database from ${JSON.stringify(moduleUrl('node_modules/better-sqlite3/lib/index.js'))};
import { ObjectRegistry } from ${JSON.stringify(moduleUrl('src/main/modules/object-service/registry.ts'))};
import { DocumentPageService } from ${JSON.stringify(moduleUrl('src/main/modules/document-pages/service.ts'))};
const db = new Database(${JSON.stringify(database)});
const service = new DocumentPageService(new ObjectRegistry(db), { vaultRoot: () => ${JSON.stringify(root)}, index: async () => {}, afterMove: () => process.exit(86) });
service.operate(${JSON.stringify({ type: 'adopt', root, source, parentPath: root, operationId: 'crash' })}).catch(error => { console.error(error); process.exit(1) });`)
  const result = spawnSync(process.execPath, ['--import', 'tsx', child], { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
  assert.equal(result.status, 86, result.stderr)
  assert.equal(existsSync(source), false)
  db = new Database(database); t.after(() => db.close())
  const reopened = new ObjectRegistry(db), service = new DocumentPageService(reopened, { vaultRoot: () => root, index: async () => {} })
  await service.recover(); await service.recover()
  assert.equal(service.operation('crash')?.state, 'rolled_back')
  assert.equal(readFileSync(join(source, 'nested', 'file.txt'), 'utf8'), 'original bytes')
  assert.equal(existsSync(join(root, 'mounted')), false)
  for (const row of before) assert.equal(reopened.get(row.id)?.current_path, row.current_path)
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0)
})
