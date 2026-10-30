import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { registerDocumentPagesIPC } from '../main/modules/document-pages/ipc'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { rebuildObjectIndex } from '../main/modules/search-engine/object-index-rebuild'
import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMigrations } from '../main/modules/migrations'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { DocumentPageService } from '../main/modules/document-pages/service'
import { configureDocumentWriteService, documentVersion, saveUserDocument } from '../main/modules/document-engine/document-write-service'
import { ObjectLinkRepository } from '../main/modules/search-engine/object-links'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-pages-')))
  const db = new Database(':memory:'); runMigrations(db)
  const registry = new ObjectRegistry(db), engine = new SearchEngine(db, { fts5Available: true })
  engine.getRepository().ensureWorkspace(root)
  const index = async (path: string) => { const result = await engine.indexDocument(root, path); assert.ok(result.ok, result.error) }
  configureDocumentWriteService({ index })
  const service = new DocumentPageService(registry, { index })
  return { root, db, registry, engine, index, service, close: () => { configureDocumentWriteService(null); engine.cancelPendingWorkspaceResolves(); db.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('M3-P2 child creation, triplet rename/move, trash/restore and deletion retain identity and links', async t => {
  if (skipIfSqliteUnavailable(t, 'Document pages')) return
  const f = fixture()
  try {
    const parent = join(f.root, 'A.md'); writeFileSync(parent, '# A\r\n[[A/child]]')
    mkdirSync(join(f.root, 'A.assets')); writeFileSync(join(f.root, 'A.assets', 'image.txt'), 'image')
    const objectId = f.registry.register(parent).id, bytes = readFileSync(parent)
    const child = await f.service.operate({ type: 'create', root: f.root, operationId: 'child', parentObjectId: objectId, title: 'child', content: '[[../A]]' })
    assert.equal(child.path, join(f.root, 'A', 'child.md')); assert.deepEqual(readFileSync(parent), bytes)
    assert.deepEqual(await f.service.operate({ type: 'create', root: f.root, operationId: 'child', parentObjectId: objectId, title: 'child', content: '[[../A]]' }), child)
    writeFileSync(join(f.root, 'ref.md'), '[[A]]'); await f.index(parent); await f.index(join(f.root, 'ref.md'))
    const ref = f.registry.find(join(f.root, 'ref.md'))!
    const renamed = await f.service.operate({ type: 'rename', root: f.root, operationId: 'rename', objectId, title: 'B' })
    assert.equal(renamed.objectId, objectId); assert.equal(readFileSync(join(f.root, 'ref.md'), 'utf8'), '[[B]]')
    assert.match(readFileSync(join(f.root,'B.md'),'utf8'), /\[\[B\/child\]\]/)
    assert.equal(readFileSync(join(f.root,'B','child.md'),'utf8'),'[[../B]]')
    for (const name of ['B.md', 'B', 'B.assets']) assert.ok(existsSync(join(f.root, name)))
    mkdirSync(join(f.root, 'destination'))
    await f.service.operate({ type: 'move', root: f.root, operationId: 'move', objectId, parentPath: join(f.root, 'destination') })
    assert.equal(f.registry.get(objectId)?.current_path, join(f.root, 'destination', 'B.md'))
    await f.service.operate({ type: 'trash', root: f.root, operationId: 'trash', objectId })
    assert.equal(f.registry.get(objectId)?.status, 'trashed')
    assert.equal(f.service.trash(f.root)[0].title,'B')
    assert.equal(f.service.trash(f.root)[0].originalPath,join(f.root,'destination','B.md'))
    assert.equal(f.db.prepare('SELECT id FROM documents WHERE object_id=?').get(objectId), undefined)
    assert.equal(new ObjectLinkRepository(f.db).outgoing({ objectId: ref.id })[0].unresolvedReason, '已回收')
    f.registry.scan(f.root)
    assert.equal(f.registry.get(objectId)?.status, 'trashed')
    assert.equal(f.registry.list().some(row => row.current_path?.includes('/.ready/')), false)
    writeFileSync(join(f.root, 'destination', 'B.md'), 'collision')
    await assert.rejects(f.service.operate({ type: 'restore', root: f.root, operationId: 'restore-conflict', objectId }), /collision/)
    assert.equal(readFileSync(join(f.root, 'destination', 'B.md'), 'utf8'), 'collision')
    rmSync(join(f.root, 'destination', 'B.md'))
    const restored = await f.service.operate({ type: 'restore', root: f.root, operationId: 'restore', objectId })
    assert.equal(restored.objectId, objectId); assert.equal(restored.path, join(f.root, 'destination', 'B.md'))
    await f.service.operate({ type: 'trash', root: f.root, operationId: 'trash-again', objectId })
    await f.service.operate({ type: 'delete', root: f.root, operationId: 'delete', objectId })
    assert.equal(f.registry.get(objectId)?.status, 'deleted')
  } finally { f.close() }
})

test('M3-P2 failed group rolls back, restart resolves interrupted group, repeated operation is stable', async t => {
  if (skipIfSqliteUnavailable(t, 'Document pages')) return
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'A.md'), '# A'); mkdirSync(join(f.root, 'A')); mkdirSync(join(f.root, 'A.assets'))
    const objectId = f.registry.register(join(f.root, 'A.md')).id
    const request = { type: 'rename' as const, root: f.root, operationId: 'fail', objectId, title: 'B' }
    const failing = new DocumentPageService(f.registry, { index: f.index, afterMove: () => { throw new Error('injected') } })
    await assert.rejects(failing.operate(request), /injected/)
    for (const name of ['A.md', 'A', 'A.assets']) assert.ok(existsSync(join(f.root, name)))
    assert.equal(existsSync(join(f.root, 'B.md')), false)
    const recovered = new DocumentPageService(f.registry, { index: f.index }); await recovered.recover()
    const receipt = await recovered.operate({ ...request, operationId: 'retry' })
    assert.deepEqual(await recovered.operate({ ...request, operationId: 'retry' }), receipt)
  } finally { f.close() }
})

test('M3-P1 ordering, favorites and recents survive disposable search rows', async t => {
  if (skipIfSqliteUnavailable(t, 'Document pages')) return
  const f = fixture()
  try {
    for (const name of ['A', 'B']) { writeFileSync(join(f.root, name + '.md'), name); await f.index(join(f.root, name + '.md')) }
    const tree = f.service.tree({ path: f.root, kind: 'vault' })
    const [a, b] = tree.children
    f.service.order(tree.objectId, [b.objectId, a.objectId]); f.service.favorite(a.objectId, true); f.service.visit(a.objectId)
    await rebuildObjectIndex(f.engine,[f.root])
    for (const name of ['A', 'B', 'C']) { if (name === 'C') writeFileSync(join(f.root, 'C.md'), 'C'); await f.index(join(f.root, name + '.md')) }
    assert.deepEqual(f.service.tree({ path: f.root, kind: 'vault' }).children.map(n => n.name), ['B.md', 'A.md', 'C.md'])
    assert.equal(f.service.states().find(s => s.objectId === a.objectId)?.favorite, true)
    assert.ok(f.service.states().find(s => s.objectId === a.objectId)?.lastVisitedAt)
  } finally { f.close() }
})

test('user save checks expected version, reads disk and index, and rolls back failed index', async t => {
  if (skipIfSqliteUnavailable(t, 'Document pages')) return
  const f = fixture()
  try {
    const path = join(f.root, 'save.md'); writeFileSync(path, 'before')
    const receipt = await saveUserDocument({ path, content: 'after', expectedVersion: documentVersion('before') }, { index: f.index })
    assert.equal(receipt.afterVersion, documentVersion('after')); assert.ok(f.registry.find(path))
    await assert.rejects(saveUserDocument({ path, content: 'stale', expectedVersion: documentVersion('before') }, { index: f.index }), /version/)
    let failed = false
    await assert.rejects(saveUserDocument({ path, content: 'bad', expectedVersion: receipt.afterVersion }, { index: async p => { if (!failed) { failed = true; throw new Error('index failed') } await f.index(p) } }), /index failed/)
    assert.equal(readFileSync(path, 'utf8'), 'after')
  } finally { f.close() }
})


test('M3-P2 actual process exit after first move is rolled back on database reopen', async t => {
  if (skipIfSqliteUnavailable(t, 'Document pages')) return
  const directory = realpathSync(mkdtempSync(join(tmpdir(),'ready-pages-crash-'))), root = join(directory,'vault')
  mkdirSync(root)
  const database = join(directory,'ready.db')
  let db = new Database(database); runMigrations(db)
  const registry = new ObjectRegistry(db)
  writeFileSync(join(root,'A.md'),'before'); mkdirSync(join(root,'A')); writeFileSync(join(root,'A','child.md'),'child'); mkdirSync(join(root,'A.assets'))
  const objectId = registry.register(join(root,'A.md')).id
  db.close()
  const moduleUrl = (path: string) => pathToFileURL(join(process.cwd(),path)).href
  const child = join(directory,'crash.ts')
  writeFileSync(child, `import Database from ${JSON.stringify(moduleUrl('node_modules/better-sqlite3/lib/index.js'))};
import { ObjectRegistry } from ${JSON.stringify(moduleUrl('src/main/modules/object-service/registry.ts'))};
import { DocumentPageService } from ${JSON.stringify(moduleUrl('src/main/modules/document-pages/service.ts'))};
const db = new Database(${JSON.stringify(database)});
const service = new DocumentPageService(new ObjectRegistry(db),{ index: async () => {}, afterMove: () => process.exit(86) });
service.operate(${JSON.stringify({ type:'rename',root,objectId,title:'B',operationId:'crash' })}).catch(error => { console.error(error); process.exit(1) });`)
  try {
    const result = spawnSync(process.execPath,['--import','tsx',child], { cwd: process.cwd(),env: { ...process.env,ELECTRON_RUN_AS_NODE:'1' },encoding:'utf8' })
    assert.equal(result.status,86,result.stderr)
    assert.equal(existsSync(join(root,'A.md')),false); assert.equal(existsSync(join(root,'B.md')),true)
    db = new Database(database)
    const reopened = new ObjectRegistry(db), service = new DocumentPageService(reopened,{index:async()=>{}})
    await service.recover(); await service.recover()
    assert.equal(service.operation('crash')?.state,'rolled_back')
    assert.equal(reopened.get(objectId)?.current_path,join(root,'A.md'))
    assert.equal(readFileSync(join(root,'A.md'),'utf8'),'before'); assert.equal(existsSync(join(root,'B.md')),false)
    await assert.rejects(service.operate({ type:'rename',root,objectId,title:'B',operationId:'crash' }),/rolled back/)
    assert.equal(readFileSync(join(root,'A','child.md'),'utf8'),'child')
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
  } finally { if (db.open) db.close(); rmSync(directory,{recursive:true,force:true}) }
})

test('M3-P2 dirty buffers, missing restore parents and unsafe names cannot lose files', async t => {
  if (skipIfSqliteUnavailable(t, 'Document pages')) return
  const f = fixture()
  try {
    mkdirSync(join(f.root,'folder')); const path = join(f.root,'folder','A.md'); writeFileSync(path,'body')
    const objectId = f.registry.register(path).id
    configureDocumentWriteService({ index:f.index,tabs:async()=>({ok:true,tabs:[{id:'dirty',path,content:'unsaved',isDirty:true}]}) })
    await assert.rejects(f.service.operate({type:'trash',root:f.root,objectId,operationId:'dirty'}),/dirty_conflict/)
    assert.equal(readFileSync(path,'utf8'),'body')
    configureDocumentWriteService({index:f.index})
    await assert.rejects(f.service.operate({type:'rename',root:f.root,objectId,operationId:'unsafe',title:'../escape'}),/separators/)
    await f.service.operate({type:'trash',root:f.root,objectId,operationId:'remove'})
    rmSync(join(f.root,'folder'),{recursive:true})
    await assert.rejects(f.service.operate({type:'restore',root:f.root,objectId,operationId:'restore-missing'}),/parent_conflict/)
    await f.service.operate({type:'restore',root:f.root,objectId,operationId:'restore-selected',parentPath:f.root})
    assert.equal(f.registry.get(objectId)?.current_path,join(f.root,'A.md'))
    const renamed = await f.service.operate({type:'rename',root:f.root,objectId,operationId:'safe',title:'CON'})
    assert.equal(renamed.path,join(f.root,'_CON.md')); assert.equal(f.service.properties(objectId).properties.title,'CON')
    const version = f.service.properties(objectId).version
    await f.service.patchProperties(objectId,version,{icon:'🌿'})
    assert.equal(f.service.properties(objectId).properties.icon,'🌿')
    await assert.rejects(f.service.patchProperties(objectId,version,{icon:'bad'}),/version/)
  } finally { f.close() }
})


test('page IPC validates input, returns collision choices and publishes once for a retried operation', async t => {
  if (skipIfSqliteUnavailable(t, 'Document pages')) return
  const f = fixture()
  try {
    const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
    registerDocumentPagesIPC({handle:(name,listener)=>{handlers.set(name,listener)}},f.service,Promise.resolve(),path=>{assert.ok(path.startsWith(f.root))})
    const invoke = (channel: string,...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent,...args)
    const events: string[] = []; f.service.subscribe(event=>events.push(event.operationId))
    const request = {type:'create',root:f.root,parentPath:f.root,title:'new',operationId:'ipc-create'}
    const result = await invoke('documentPages:operate',request)
    assert.equal(result.ok,true,JSON.stringify(result))
    assert.deepEqual(await invoke('documentPages:operate',request),result)
    assert.deepEqual(events,['ipc-create'])
    const collision = await invoke('documentPages:operate',{...request,operationId:'ipc-collision'})
    assert.equal(collision.ok,false); assert.deepEqual(collision.candidateNames,['new (2)'])
    const invalid = await invoke('documentPages:operate',{...request,title:'../escape',operationId:'ipc-invalid'})
    assert.equal(invalid.ok,false)
    const path = join(f.root,'new.md')
    const saved = await invoke('documentPages:save',{path,content:'saved',expectedVersion:documentVersion('')})
    assert.equal(saved.ok,true,JSON.stringify(saved)); assert.equal(readFileSync(path,'utf8'),'saved')
    assert.equal((await invoke('documentPages:save',{path,content:'stale',expectedVersion:documentVersion('')})).ok,false)
    const fresh = join(f.root,'first.md')
    assert.equal((await invoke('documentPages:save',{path:fresh,content:'first',expectedVersion:'missing'})).ok,true)
    assert.equal(readFileSync(fresh,'utf8'),'first')
    assert.equal((await invoke('documentPages:save',{path:fresh,content:'replace',expectedVersion:'missing'})).ok,false)
    assert.equal((await invoke('documentPages:save',{path:join(f.root,'picture.png'),content:'bad',expectedVersion:'missing'})).ok,false)
    assert.equal(existsSync(join(f.root,'picture.png')),false)
  } finally { f.close() }
})

test('M4 canvas triplet rename, move, trash and restore preserve child identity and readable media', async t => {
  if (skipIfSqliteUnavailable(t, 'Canvas pages')) return
  const f = fixture()
  try {
    const { CanvasService } = await import('../main/modules/board-engine/canvas-service')
    const canvases = new CanvasService(f.registry, f.root)
    const h = await canvases.create({ path: 'A.canvas', operationId: 'canvas-create' })
    await assert.rejects(f.service.save({ path: join(f.root, h.path), content: 'not canvas', expectedVersion: h.version }), /canvas handle/)
    await assert.rejects(f.service.patchProperties(h.objectId, h.version, { icon: 'x' }), /Markdown page/)
    const node = { id: 'child', type: 'file' as const, x: 0, y: 0, width: 100, height: 100, file: 'A/child.canvas', ready: { kind: 'subcanvas' as const, ref: { kind: 'canvas' as const, id: 'child-object' } } }
    const child = { nodes: [], edges: [], ready: { schemaVersion: 1 as const, id: 'child-object' } }
    assert.equal((await canvases.write({ ...h, operationId: 'add-child', expectedVersion: h.version, commands: [{ type: 'createSubcanvas', node, path: node.file, canvas: child }, { type: 'addNode', node: { id: 'text', type: 'text', text: '[child](A/child.canvas)', x: 0, y: 0, width: 100, height: 100, ready: { kind: 'text' } } }] })).state, 'completed')
    mkdirSync(join(f.root, 'A.assets')); writeFileSync(join(f.root, 'A.assets', 'media.txt'), 'media')
    const page = f.service.tree({ path: f.root, kind: 'vault' }).children.find(n => n.objectId === h.objectId)!
    assert.equal(page.children[0].objectId, 'child-object'); assert.ok(page.assetsPath)
    await f.service.operate({ type: 'rename', root: f.root, operationId: 'rename-canvas', objectId: h.objectId, title: 'B' })
    assert.equal(JSON.parse(readFileSync(join(f.root, 'B.canvas'), 'utf8')).nodes[0].file, 'B/child.canvas')
    mkdirSync(join(f.root, 'destination'))
    await f.service.operate({ type: 'move', root: f.root, operationId: 'move-canvas', objectId: h.objectId, parentPath: join(f.root, 'destination') })
    await f.service.operate({ type: 'trash', root: f.root, operationId: 'trash-canvas', objectId: h.objectId })
    assert.equal(new ObjectLinkRepository(f.db).outgoing({ objectId: h.objectId }).length, 0)
    mkdirSync(join(f.root, 'restored'))
    await f.service.operate({ type: 'restore', root: f.root, operationId: 'restore-canvas', objectId: h.objectId, parentPath: join(f.root, 'restored') })
    assert.equal(f.registry.get('child-object')?.id, 'child-object')
    const restored = await canvases.open(h.objectId)
    assert.equal(restored.canvas.nodes[0].file, 'restored/B/child.canvas')
    assert.equal(restored.canvas.nodes[1].text, '[child](restored/B/child.canvas)')
    assert.equal(readFileSync(join(f.root, 'restored/B.assets/media.txt'), 'utf8'), 'media')
    await assert.rejects(f.service.operate({ type: 'move', objectId: 'child-object', root: f.root, operationId: 'child-outside-owner', parentPath: f.root }), /Subcanvas outside parent/)
    assert.ok(existsSync(join(f.root, 'restored/B/child.canvas')))
  } finally { f.close() }
})

test('M4 rename refuses an unsaved referring canvas before moving the source files', async t => {
  if (skipIfSqliteUnavailable(t, 'Canvas related buffers')) return
  const f = fixture()
  try {
    const { CanvasService } = await import('../main/modules/board-engine/canvas-service')
    const canvases = new CanvasService(f.registry, f.root)
    const target = await canvases.create({ path: 'Target.canvas', operationId: 'create-target' })
    const node = { id: 'ref', type: 'file' as const, file: target.path, x: 0, y: 0, width: 100, height: 100, ready: { kind: 'document' as const, ref: { kind: 'canvas' as const, id: target.objectId } } }
    const reference = await canvases.create({ path: 'Reference.canvas', operationId: 'create-reference', canvas: { nodes: [node], edges: [], ready: { schemaVersion: 1, id: 'reference-board' } } })
    const dirty = structuredClone(reference.canvas); dirty.nodes[0].x = 99
    canvases.updateBuffer({ objectId: reference.objectId, tabId: 'ref-tab', openGeneration: 1, bufferVersion: 1, baseVersion: reference.version, canvas: dirty })
    await assert.rejects(f.service.operate({ type: 'rename', objectId: target.objectId, root: f.root, operationId: 'refused-rename', title: 'NewTarget' }), /dirty_conflict/)
    assert.ok(existsSync(join(f.root, 'Target.canvas'))); assert.equal(existsSync(join(f.root, 'NewTarget.canvas')), false)
    assert.equal(canvases.buffer(reference.objectId)?.canvas.nodes[0].x, 99)
  } finally { f.close() }
})

// M6-B-finish contract: compare the caller's version inside the page operation queue.
test('page rename and move reject stale expected versions without changing files', async t => {
  if (skipIfSqliteUnavailable(t, 'version checked pages')) return
  const f = fixture(); t.after(() => f.close())
  const path = join(f.root, 'diary.md'), original = '# original\n'
  writeFileSync(path, original)
  const object = f.registry.register(path), expectedVersion = documentVersion(original)
  const newer = '# externally edited\n'; writeFileSync(path, newer)
  mkdirSync(join(f.root, 'destination'))
  for (const request of [
    { type: 'rename' as const, title: 'renamed', operationId: 'stale-rename' },
    { type: 'move' as const, parentPath: join(f.root, 'destination'), operationId: 'stale-move' },
  ]) {
    await assert.rejects(f.service.operate({ ...request, root: f.root, objectId: object.id }, expectedVersion), /version_conflict/)
    assert.equal(readFileSync(path, 'utf8'), newer)
    assert.equal(f.registry.get(object.id)?.current_path, path)
  }
  assert.equal(existsSync(join(f.root, 'renamed.md')), false)
  assert.equal(existsSync(join(f.root, 'destination', 'diary.md')), false)
  const request = { type: 'rename' as const, root: f.root, objectId: object.id, title: 'renamed', operationId: 'current-rename' }
  const receipt = await f.service.operate(request, documentVersion(newer))
  assert.equal(receipt.path, join(f.root, 'renamed.md'))
  assert.deepEqual(await f.service.operate(request, documentVersion(newer)), receipt)
})
