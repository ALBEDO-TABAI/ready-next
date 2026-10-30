import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './utils/ready-object-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { ObjectLinkRepository } from '../main/modules/search-engine/object-links'
import { rebuildObjectIndex } from '../main/modules/search-engine/object-index-rebuild'
import { FastCardRepository } from '../main/modules/repositories/fastcard-repository'
import { queryDocumentGraph } from '../main/modules/database/document-graph-query'
import { toReadyUri } from '../shared/ready-ref'

test('C5 extracts positioned links, prefers paths, reports ambiguity, and queries both endpoint types', async t => {
  if (skipIfSqliteUnavailable(t, 'Object links')) return
  const f = fixture()
  try {
    for (const dir of ['one', 'two', 'notes']) mkdirSync(join(f.root, dir))
    for (const file of ['one/Page.md', 'two/Page.md', 'Target.md']) writeFileSync(join(f.root, file), '# target')
    const path = join(f.root, 'notes/source.md')
    const raw = '---\nrelated: "[[../Target#标题]]"\ntitle: Ordinary title\n---\n[[Page]]\n[[../Target#标题]]\n[[../Target#^block]]\n![[../Target#标题]]\n[relative](../Target.md#标题)\n[原文](ready://read/book/book-1#c2:10+4)\nready://calendar/event/event-1\n`[[ignored]]`\n```md\n[[ignored]]\n```\n'
    writeFileSync(path, raw)
    assert.equal((await f.engine.reindexWorkspace({ root: f.root })).ok, true)
    const links = new ObjectLinkRepository(f.db)
    const source = { objectId: f.registry.find(path)!.id }
    const target = { objectId: f.registry.find(join(f.root, 'Target.md'))!.id }
    const outgoing = links.outgoing(source)
    assert.equal(outgoing.length, 8)
    assert.deepEqual(outgoing.map(e => e.kind).sort(), ['annotation-source', 'block-ref', 'embed', 'frontmatter', 'mdlink', 'ready-ref', 'wikilink', 'wikilink'].sort())
    const ambiguous = outgoing.find(e => e.rawTarget === 'Page')!
    assert.equal(ambiguous.resolved, false)
    assert.equal(ambiguous.unresolvedReason, '多个候选')
    assert.equal(links.incoming(target).length, 5)
    const block = outgoing.find(e => e.kind === 'block-ref')!
    assert.equal(block.fragment, '^block')
    assert.equal(raw.slice(block.sourceOffset!, block.sourceOffset! + 2), '[[')
    assert.equal(block.sourceLine, 7)
    const ref = { kind: 'book-location' as const, book: 'book-1', loc: 'c2:10+4' }
    assert.equal(links.incoming({ ref })[0].kind, 'annotation-source')
    assert.equal(toReadyUri(ref), 'ready://read/book/book-1#c2%3A10%2B4')
    assert.ok(queryDocumentGraph(f.db, { centerPath: path }).edges.length >= 2)
    assert.throws(() => links.outgoing({ objectId: '', ref }), /./)
  } finally { f.close() }
})

test('C5 rebuild preserves IDs, business records, file bytes and stable edges without duplicates', async t => {
  if (skipIfSqliteUnavailable(t, 'Object index rebuild')) return
  const f = fixture()
  try {
    const target = join(f.root, 'target.md'), source = join(f.root, 'source.md')
    writeFileSync(target, '# Target')
    writeFileSync(source, '[[target#Heading]]\n[原文](ready://read/book/b#c0:0+2)')
    mkdirSync(join(f.root, '.ready'))
    writeFileSync(join(f.root, '.ready', 'comments.json'), '{"retained":true}')
    new FastCardRepository(f.db).add({ id: 'card', kind: 'text', createdAt: 1, text: 'draft', source: { pageUrl: 'https://example.com/' } })
    f.db.exec(`INSERT INTO calendar_sources(id,name,color) VALUES('cal','calendar','#000000');
      INSERT INTO calendar_events(id,calendar_id,title,start_time,end_time,all_day,ics_uid,created_at,updated_at) VALUES('evt','cal','keep event',1800000000,1800003600,0,'evt@fixture',1,1);
      INSERT INTO chat_conversations(id,agent,title,created_at,updated_at) VALUES('conversation','butler','keep draft','2026-10-30','2026-10-30');
      INSERT INTO chat_messages(id,conversation_id,role,content,timestamp,message_visibility_epoch) VALUES('message','conversation','user','[event](ready://calendar/event/evt)','2026-10-30',0)`)
    const business = () => ['calendar_events','chat_conversations','chat_messages','fastcard_items'].map(table => f.db.prepare(`SELECT * FROM ${table}`).all())
    const businessBefore = business()
    assert.equal((await f.engine.reindexAllSources({ root: f.root })).ok, true)
    const links = new ObjectLinkRepository(f.db)
    const endpoint = { objectId: f.registry.find(source)!.id }
    const snapshot = () => ({ objects: f.registry.list().map(o => [o.id, o.current_path]).sort(), edges: links.outgoing(endpoint), backlinks: links.incoming({ objectId: f.registry.find(target)!.id }), cards: links.outgoing({ ref: { kind: 'fastcard', id: 'card' } }) })
    const before = snapshot()
    assert.equal(before.cards.length, 1)
    assert.equal(links.outgoing({ref:{kind:'conversation',id:'conversation'}}).length,1)
    await rebuildObjectIndex(f.engine, [f.root])
    assert.deepEqual(snapshot(), before)
    await rebuildObjectIndex(f.engine, [f.root])
    assert.deepEqual(snapshot(), before)
    assert.equal(new FastCardRepository(f.db).list()[0].text, 'draft')
    assert.deepEqual(business(),businessBefore)
    assert.equal(readFileSync(source, 'utf8'), '[[target#Heading]]\n[原文](ready://read/book/b#c0:0+2)')
    assert.equal(readFileSync(join(f.root, '.ready', 'comments.json'), 'utf8'), '{"retained":true}')
    assert.deepEqual(f.db.pragma('foreign_key_check'), [])
    assert.deepEqual(f.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('doc_links','object_link_targets')").all(), [])
  } finally { f.close() }
})

test('C2/C5 pending rename survives index deletion and refuses dirty or unwritable source writeback', async t => {
  if (skipIfSqliteUnavailable(t, 'Object repair rebuild')) return
  const { configureDocumentWriteService, getDocumentWriteDependencies } = await import('../main/modules/document-engine/document-write-service')
  const { repairObjectLinks } = await import('../main/modules/object-service/link-repair')
  const f = fixture(), previous = getDocumentWriteDependencies()
  try {
    const source = join(f.root, 'source.md'), target = join(f.root, 'target.md'), next = join(f.root, 'next.md')
    const raw = '[[target#Heading]]\n![[target#^block]]\n[x](target.md#Heading)'
    writeFileSync(source, raw); writeFileSync(target, 'target')
    await f.engine.reindexWorkspace({ root: f.root })
    const targetId = f.registry.find(target)!.id
    renameSync(target, next); f.registry.reconcile([target, next])
    configureDocumentWriteService({ index: async (p, c) => { const r = await f.engine.indexDocument(f.root, p, c); assert.equal(r.ok, true) }, tabs: async () => ({ ok: false, code: 'dirty_conflict', message: 'dirty' }) })
    await repairObjectLinks(f.registry)
    await rebuildObjectIndex(f.engine, [f.root])
    assert.equal(readFileSync(source, 'utf8'), raw)
    assert.equal(new ObjectLinkRepository(f.db).incoming({ objectId: targetId }).length, 3)
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM object_link_repairs WHERE state='pending'").get<{ n: number }>()!.n, 2)
    configureDocumentWriteService({ index: async (p, c) => { assert.equal((await f.engine.indexDocument(f.root, p, c)).ok, true) } })
    chmodSync(source, 0o444)
    await repairObjectLinks(f.registry)
    assert.equal(readFileSync(source, 'utf8'), raw)
    chmodSync(source, 0o644)
    await repairObjectLinks(f.registry)
    assert.equal(readFileSync(source, 'utf8'), '[[next#Heading]]\n![[next#^block]]\n[x](next.md#Heading)')
    assert.equal(new ObjectLinkRepository(f.db).incoming({ objectId: targetId }).length, 3)
  } finally { configureDocumentWriteService(previous); f.close() }
})


test('C5 migration keeps pending binding and old edge, then reconstructs fragment-bearing references after rename', async t => {
  if (skipIfSqliteUnavailable(t, 'Object links migration')) return
  const { default: Database } = await import('better-sqlite3')
  const { runMigrations, __runMigrationForTests } = await import('../main/modules/migrations')
  const f = fixture(), db = new Database(':memory:')
  try {
    db.exec("CREATE TABLE migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL); INSERT INTO migrations(name,applied_at) VALUES('139_object_links','test'),('141_document_pages','test'),('146_canvas_operations','test')")
    runMigrations(db)
    const source = join(f.root, 'source.md'), target = join(f.root, 'moved.md')
    writeFileSync(source, '[[old#Heading]]'); writeFileSync(target, 'target')
    const workspaceId = db.prepare('INSERT INTO workspaces(root) VALUES(?)').run(f.root).lastInsertRowid
    for (const [id,path] of [['s',source],['t',target]]) {
      db.prepare("INSERT INTO objects(id,kind,workspace_id,current_path,path_key,last_known_path,status,identity_state,observed_since) VALUES(?,'markdown',?,?,?,?,'present','local',0)").run(id,workspaceId,path,path,path)
      db.prepare("INSERT INTO documents(workspace_id,path,name,object_id) VALUES(?,?,?,?)").run(workspaceId,path,id+'.md',id)
    }
    db.exec("INSERT INTO doc_links(src_doc_id,kind,target_text,target_doc_id,resolved) VALUES(1,'wikilink','old',2,1); INSERT INTO object_link_targets VALUES('s','wikilink','old','t','original-version','pending')")
    __runMigrationForTests('139_object_links',db)
    db.prepare("DELETE FROM migrations WHERE name IN ('141_document_pages','146_canvas_operations')").run()
    runMigrations(db)
    const links = new ObjectLinkRepository(db)
    assert.equal(links.incoming({objectId:'t'})[0].rawTarget,'old')
    assert.deepEqual(db.prepare('SELECT * FROM object_link_repairs').all(),[{source_id:'s',kind:'wikilink',raw_target:'old',target_id:'t',source_hash:'original-version',state:'pending'}])
    const { extractObjectLinks } = await import('../main/modules/search-engine/object-link-extract')
    links.replace({objectId:'s'},extractObjectLinks(readFileSync(source,'utf8')),'new-version')
    assert.equal(links.incoming({objectId:'t'})[0].fragment,'Heading')
    assert.equal(db.prepare('SELECT source_hash FROM object_link_repairs').get<{source_hash:string}>()!.source_hash,'original-version')
    assert.deepEqual(db.pragma('foreign_key_check'),[])
  } finally {db.close(); f.close()}
})

test('relation IPC returns positioned edges and rejects malformed endpoints', async t => {
  if (skipIfSqliteUnavailable(t, 'Object relation IPC')) return
  const {searchQueryGroup} = await import('../main/modules/search-engine/ipc/query-group')
  const f=fixture()
  try {
    const path=join(f.root,'source.md');writeFileSync(path,'[原文](ready://read/book/b#c1:2+3)')
    assert.equal((await f.engine.indexDocument(f.root,path)).ok,true)
    const handlers = new Map<string, (event: unknown,payload: unknown) => unknown>()
    const ipc = {handle:(name:string,handler:(event:unknown,payload:unknown)=>unknown)=>handlers.set(name,handler),removeHandler:(name:string)=>handlers.delete(name)}
    const dispose=searchQueryGroup.register(ipc as unknown as import('electron').IpcMain,{
      getSearchEngine:()=>f.engine,getWorkerBridge:()=>{throw new Error('unexpected worker access')},
      validateWorkspaceRoot:()=>({ok:true}),recordSearchWorkerFallback:()=>{},noteSearchWorkerSuccess:()=>{},
    })
    const outgoing = await handlers.get('document:getObjectOutgoingLinks')!({}, {endpoint:{objectId:f.registry.find(path)!.id}}) as import('../shared/object-links').ObjectLinksResponse
    assert.equal(outgoing.success,true)
    if(outgoing.success) assert.equal(outgoing.data[0].sourceLine,1)
    const incoming = await handlers.get('document:getObjectIncomingLinks')!({}, {endpoint:{ref:{kind:'book-location',book:'b',loc:'c1:2+3'}}}) as import('../shared/object-links').ObjectLinksResponse
    assert.deepEqual(incoming,outgoing)
    const rejected = await handlers.get('document:getObjectOutgoingLinks')!({}, {endpoint:{objectId:'',ref:{kind:'page',id:'other'}}}) as import('../shared/object-links').ObjectLinksResponse
    assert.equal(rejected.success,false)
    dispose.dispose();assert.equal(handlers.size,0)
  }finally{f.close()}
})

test('M4 canvas node identities survive rebuild twice and FastCard refresh preserves canvas sources', async t => {
  if (skipIfSqliteUnavailable(t, 'Canvas relations')) return
  const f = fixture()
  try {
    const { CanvasService } = await import('../main/modules/board-engine/canvas-service')
    const { refreshCardLinks } = await import('../main/modules/search-engine/object-index-rebuild')
    const service = new CanvasService(f.registry, f.root)
    const node = { id: 'a', type: 'link' as const, x: 0, y: 0, width: 100, height: 100, url: 'https://example.com/', ready: { kind: 'link' as const, sources: [{ uri: 'https://source.example/', method: 'clip' }] } }
    const h = await service.create({ path: 'Links.canvas', operationId: 'create-links', canvas: { nodes: [node, { ...node, id: 'b' }, { ...node, id: 'trash', ready: { ...node.ready, trash: { operationId: 'del', deletedAt: '2026-10-31T00:00:00Z' } } }], edges: [], ready: { id: 'links-board', schemaVersion: 1 } } })
    const links = new ObjectLinkRepository(f.db), snapshot = () => links.outgoing({ objectId: h.objectId })
    const before = snapshot(); assert.equal(before.length, 4)
    refreshCardLinks(f.engine); assert.deepEqual(snapshot(), before)
    assert.equal(links.outgoing({ ref: { kind: 'canvas', id: h.objectId, node: 'a' } }).length, 2)
    for (let i = 0; i < 2; i++) { await rebuildObjectIndex(f.engine, [f.root]); assert.deepEqual(snapshot(), before) }
    assert.equal(f.registry.list().filter(o => o.kind === 'canvas').length, 1)
  } finally { f.close() }
})
