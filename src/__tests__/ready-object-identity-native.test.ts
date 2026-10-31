import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync, renameSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ObjectMutations } from '../main/modules/object-service/mutations'
import { ObjectEventWindow } from '../main/modules/object-service/event-window'
import { fixture } from './utils/ready-object-fixture'
import { FileActivityRepository } from '../main/modules/repositories/file-activity-repository'
import { FileAttentionRepository } from '../main/modules/repositories/file-attention-repository'
import { DocumentMarksRepository } from '../main/modules/document-engine/document-marks-repository'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('C2 internal and external moves, atomic save and same-window recreation retain relationships', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Object identity')) return
  const f=fixture()
  try {
    let path=join(f.root,'a.md');writeFileSync(path,'# A\nbody');writeFileSync(join(f.root,'source.md'),'[[a]]')
    assert.equal((await f.engine.reindexWorkspace({root:f.root})).ok,true)
    const id=f.registry.find(path)!.id
    new DocumentMarksRepository(f.db).create({documentPath:path,kind:'bookmark',title:'saved'})
    new FileActivityRepository(f.db).recordEvent({path,workspaceRoot:f.root,eventType:'open',source:'document_mode'})
    const next=join(f.root,'b.md');await new ObjectMutations(f.registry).move(path,next);path=next
    assert.equal(f.registry.find(path)!.id,id)
    assert.equal(new DocumentMarksRepository(f.db).list(path).length,1)
    new FileAttentionRepository(f.db).backfill([f.root],Date.now())
    assert.equal(f.registry.list().filter(row=>row.status==='present').length,2)
    const eventWindow=new ObjectEventWindow(f.registry,async paths=>{for(const p of paths)if(f.registry.find(p))await f.engine.indexDocument(f.root,p)})
    const external=join(f.root,'c.md');renameSync(path,external)
    const pending=[eventWindow.add(path),eventWindow.add(external)];eventWindow.flush();await Promise.all(pending);path=external
    assert.equal(f.registry.find(path)!.id,id)
    const atomic=join(f.root,'replacement');writeFileSync(atomic,'# edited');renameSync(atomic,path)
    const saved=eventWindow.add(path);eventWindow.flush();await saved
    assert.equal(f.registry.find(path)!.id,id)
    const recreated=join(f.root,'d.md');const bytes=readFileSync(path);rmSync(path);writeFileSync(recreated,bytes)
    const pending2=[eventWindow.add(path),eventWindow.add(recreated)];eventWindow.flush();await Promise.all(pending2)
    assert.equal(f.registry.find(recreated)!.id,id)
    assert.deepEqual(f.db.prepare('SELECT resolved,target_id FROM object_links').all(),[{resolved:1,target_id:id}])
    assert.deepEqual(f.db.pragma('foreign_key_check'),[])
    rmSync(recreated);f.registry.reconcile([recreated])
    assert.equal(f.registry.get(id)!.status,'missing')
    assert.deepEqual(f.db.prepare('SELECT resolved,target_id FROM object_links').all(),[{resolved:0,target_id:id}])
    writeFileSync(recreated,'different object')
    await f.engine.indexDocument(f.root,recreated)
    f.engine.getRepository().resolveWikilinkTargets(f.engine.getRepository().ensureWorkspace(f.root))
    assert.notEqual(f.registry.find(recreated)!.id,id)
    assert.deepEqual(f.db.prepare('SELECT resolved,target_id FROM object_links').all(),[{resolved:0,target_id:id}])
  } finally {f.close()}
})
test('C2 duplicate portable IDs are quarantined, initial duplicates have no guessed owner, fresh machine restores IDs', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Object identity')) return
  const f=fixture()
  try {
    const a=join(f.root,'a.md'),b=join(f.root,'b.md');writeFileSync(a,'---\nready_id: portable\n---\ntext')
    assert.equal(f.registry.register(a).id,'portable')
    writeFileSync(b,readFileSync(a));f.registry.reconcile([b])
    assert.equal(f.registry.find(b)!.identity_state,'conflict');assert.equal(f.registry.find(a)!.id,'portable')
    assert.equal(readFileSync(b,'utf8'),readFileSync(a,'utf8'))
    const c=join(f.root,'c.md'),d=join(f.root,'d.md');writeFileSync(c,'---\nready_id: duplicate\n---');writeFileSync(d,readFileSync(c))
    f.registry.reconcile([c,d]);assert.equal(f.registry.find(c)!.identity_state,'conflict');assert.equal(f.registry.find(d)!.identity_state,'conflict')
    const second=fixture();try{const p=join(second.root,'restored.md');writeFileSync(p,readFileSync(a));assert.equal(second.registry.register(p).id,'portable')}finally{second.close()}
  }finally{f.close()}
})
test('C2 directory and cross-workspace moves preserve descendants and reject unauthorized destination before moving', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Object identity')) return
 const f=fixture();try{
  const dir=join(f.root,'dir');mkdirSync(dir);const file=join(dir,'a.md');writeFileSync(file,'body');f.registry.scan(f.root)
  const id=f.registry.find(file)!.id;const target=join(f.root,'target');mkdirSync(target);f.engine.getRepository().ensureWorkspace(target)
  await assert.rejects(new ObjectMutations(f.registry).move(dir,join(target,'dir'),{authorizedRoots:[dir]}),/authorized/)
  assert.equal(readFileSync(file,'utf8'),'body')
  await new ObjectMutations(f.registry).move(dir,join(target,'dir'),{authorizedRoots:[f.root]})
  assert.equal(f.registry.find(join(target,'dir','a.md'))!.id,id)
  assert.equal(f.registry.find(join(target,'dir','a.md'))!.workspace_id,f.registry.workspace(target))
 }finally{f.close()}
})

test('C2 registered Ready handlers and Agent dispatcher share the object move owner, including organize undo', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Object identity')) return
 const {fileMutationGroup}=await import('../main/modules/document-engine/ipc/file-mutation-group')
 const {executeFileManagementMutationTool:tool}=await import('../main/modules/tools/file-management-organize-tools')
 const f=fixture();try{
  const handlers=new Map<string,(event:unknown,payload:unknown)=>Promise<{success:boolean;error?:string}>>()
  const ipc={removeHandler:()=>{},handle:(name:string,handler:never)=>handlers.set(name,handler)}
  fileMutationGroup.register(ipc as unknown as import('electron').IpcMain,{useMock:false,getObjectMutations:()=>new ObjectMutations(f.registry)})
  const a=join(f.root,'a.md');writeFileSync(a,'original');await f.engine.indexDocument(f.root,a);const id=f.registry.find(a)!.id
  const b=join(f.root,'b.md');assert.equal((await handlers.get('document:rename')!({}, {oldPath:a,newPath:b})).success,true)
  const context={searchEngine:f.engine,workspaceRoots:[f.root],organizeStoreDir:join(f.root,'.organize')}
  assert.equal(JSON.parse((await tool('file_rename',{path:b,newName:'c.md'},f.engine,context))!).ok,true)
  const c=join(f.root,'c.md');assert.equal(f.registry.find(c)!.id,id)
  const dest=join(f.root,'dest');mkdirSync(dest)
  assert.equal(JSON.parse((await tool('file_move',{path:c,destDir:dest},f.engine,context))!).ok,true)
  const d=join(dest,'c.md');assert.equal(f.registry.find(d)!.id,id)
  const preview=JSON.parse((await tool('file_organize_preview',{rootPath:f.root,operations:[{path:d,destDir:f.root,newName:'final.md'}]},f.engine,context))!)
  assert.equal(preview.ok,true,JSON.stringify(preview))
  const applied=JSON.parse((await tool('file_organize_apply',{planId:preview.planId,confirmed:true,confirmedVia:'ui_action'},f.engine,context))!)
  assert.equal(applied.ok,true,JSON.stringify(applied));assert.equal(f.registry.find(join(f.root,'final.md'))!.id,id)
  const replay=JSON.parse((await tool('file_organize_apply',{planId:preview.planId,confirmed:true,confirmedVia:'ui_action'},f.engine,context))!)
  assert.equal(replay.journalId,applied.journalId);assert.equal(replay.ok,true)
  const undone=JSON.parse((await tool('file_organize_undo',{journalId:applied.journalId},f.engine,context))!)
  assert.equal(undone.ok,true,JSON.stringify(undone));assert.equal(f.registry.find(d)!.id,id)
  f.db.exec("CREATE TRIGGER fail_object_move BEFORE UPDATE OF current_path ON objects WHEN NEW.current_path LIKE '%failure.md' BEGIN SELECT RAISE(ABORT,'injected move failure'); END")
  const failed=await handlers.get('document:move')!({}, {src:d,dest:join(f.root,'failure.md')})
  assert.equal(failed.success,false);assert.equal(readFileSync(d,'utf8'),'original');assert.equal(f.registry.find(d)!.id,id)
  assert.deepEqual(f.db.pragma('foreign_key_check'),[])
 }finally{f.close()}
})

for(const backend of ['native','chokidar'] as const)test(`C2 real ${backend} watcher delivers external mv into the settlement window`,{timeout:15000},async(t)=>{
  if (skipIfSqliteUnavailable(t, "Object identity watcher")) return

 const {createFileWatcher}=await import('../main/modules/search-engine/file-watcher')
 const {default:chokidar}=await import('chokidar')
 const f=fixture();let handle:Awaited<ReturnType<typeof createFileWatcher>>|undefined
 try{
  const a=join(f.root,'a.md'),b=join(f.root,'b.md');writeFileSync(a,'watched');const id=f.registry.register(a).id
  let settled!:()=>void;let failed!:(error:unknown)=>void
  const done=new Promise<void>((resolve,reject)=>{settled=resolve;failed=reject})
  const window=new ObjectEventWindow(f.registry,async()=>{if(f.registry.find(b)?.id===id)settled()})
  handle=await createFileWatcher({workspaceRoot:f.root,debounceMs:10,onChange:change=>window.add(change.filePath).catch(failed),...(backend==='chokidar'?{chokidarFactory:(paths:string|string[],options:import('chokidar').ChokidarOptions|undefined)=>Object.assign(chokidar.watch(paths,{...options,usePolling:true,interval:50}),{startupConfirmationRequired:true})}:{})})
  assert.equal('kind' in handle,false,JSON.stringify(handle))
  renameSync(a,b)
  await done
  assert.equal(f.registry.find(b)!.id,id)
 }finally{if(handle && !('kind' in handle))await handle.close();f.close()}
})

test('C2/C8 the event window settles known-file changes fast and keeps a split move together', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Object identity')) return
  const f=fixture()
  try {
    const path=join(f.root,'dated.md');writeFileSync(path,'---\ndate: 2026-11-01\n---\nA');f.registry.reconcile([path])
    const id=f.registry.find(path)!.id
    const settled:string[][]=[]
    const eventWindow=new ObjectEventWindow(f.registry,async paths=>{settled.push(paths)})
    writeFileSync(path,'---\ndate: 2026-11-02\n---\nA')
    const started=Date.now();await eventWindow.add(path)
    assert.ok(Date.now()-started<500,`a known file change settles fast (${Date.now()-started}ms)`)
    // The two halves of an external move arrive 400 ms apart: longer than the fast window, still one batch.
    const moved=join(f.root,'moved.md');renameSync(path,moved)
    const first=eventWindow.add(path);await new Promise(resolve=>setTimeout(resolve,400));const second=eventWindow.add(moved)
    await Promise.all([first,second])
    assert.deepEqual(settled.at(-1),[path,moved])
    assert.equal(f.registry.find(moved)!.id,id)
  } finally { f.close() }
})

test('C2 a caller resolving the new path before the watcher batch closes still keeps the moved identity', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Object identity')) return
  const f=fixture()
  try {
    const { subscribeObjectMoves } = await import('../main/modules/object-service/events')
    const a=join(f.root,'a.md'),b=join(f.root,'b.md');writeFileSync(a,'moved by another program');const id=f.registry.register(a).id
    const moves:Array<{objectId:string;to:string}>=[];const stop=subscribeObjectMoves(f.db,event=>moves.push(event))
    const eventWindow=new ObjectEventWindow(f.registry,async()=>{})
    renameSync(a,b)
    // The watcher has both halves queued (the batch waits for more events); the open tab asks for the new path first.
    const settled=Promise.all([eventWindow.add(a),eventWindow.add(b)])
    assert.equal(f.registry.register(b).id,id,'the new path keeps the object id')
    assert.deepEqual(moves.map(move=>[move.objectId,move.to]),[[id,b]],'the move is published once')
    await settled
    assert.equal(f.registry.find(b)!.id,id);assert.equal(moves.length,1)
    stop()
  } finally { f.close() }
})

test('C2 an external move is paired whichever path a caller resolves first, before any watcher event', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Object identity')) return
  const f=fixture()
  try {
    const { subscribeObjectMoves } = await import('../main/modules/object-service/events')
    const moves:Array<{objectId:string;from:string;to:string}>=[];const stop=subscribeObjectMoves(f.db,event=>moves.push(event))
    // New path first: the file tree refreshes before the identity watcher has queued anything.
    const a=join(f.root,'a.md'),b=join(f.root,'b.md');writeFileSync(a,'first');const first=f.registry.register(a).id
    renameSync(a,b)
    assert.equal(f.registry.register(b).id,first,'the new path is the moved object')
    assert.deepEqual(moves.map(move=>[move.objectId,move.from,move.to]),[[first,a,b]])
    // Vanished path first: a tab resolves the old path (the object goes missing), then the new path appears.
    const c=join(f.root,'c.md'),d=join(f.root,'d.md');writeFileSync(c,'second');const second=f.registry.register(c).id
    renameSync(c,d)
    assert.throws(()=>f.registry.register(c),/not present/)
    assert.equal(f.registry.register(d).id,second,'a missing object is found again by its file identity')
    assert.deepEqual(moves.at(-1) && [moves.at(-1)!.objectId,moves.at(-1)!.from,moves.at(-1)!.to],[second,c,d])
    // A pass that only reconciles what it walks (the page tree) announces the move too.
    const g=join(f.root,'g.md'),h=join(f.root,'h.md');writeFileSync(g,'walked');const walked=f.registry.register(g).id
    renameSync(g,h);f.registry.reconcile([h])
    assert.equal(f.registry.find(h)!.id,walked)
    assert.deepEqual(moves.at(-1) && [moves.at(-1)!.objectId,moves.at(-1)!.from,moves.at(-1)!.to],[walked,g,h])
    // Equal content alone never revives a missing object.
    const e=join(f.root,'e.md');writeFileSync(e,'third');const third=f.registry.register(e).id
    rmSync(e);assert.throws(()=>f.registry.register(e),/not present/)
    const copy=join(f.root,'copy.md');writeFileSync(copy,'third')
    assert.notEqual(f.registry.register(copy).id,third)
    stop()
  } finally { f.close() }
})

test('C2 path swaps, window boundaries and interrupted moves do not invent or steal identity', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Object identity')) return
 const f=fixture();try{
  const a=join(f.root,'a.md'),b=join(f.root,'b.md'),temp=join(f.root,'swap');writeFileSync(a,'---\nready_id: alpha\n---\nA');writeFileSync(b,'---\nready_id: beta\n---\nB');f.registry.reconcile([a,b])
  renameSync(a,temp);renameSync(b,a);renameSync(temp,b);f.registry.reconcile([a,b]);assert.equal(f.registry.find(a)!.id,'beta');assert.equal(f.registry.find(b)!.id,'alpha')
  const local=join(f.root,'local.md');writeFileSync(local,'same');const old=f.registry.register(local).id;rmSync(local);f.registry.reconcile([local]);const later=join(f.root,'later.md');writeFileSync(later,'same');f.registry.reconcile([later]);assert.notEqual(f.registry.find(later)!.id,old)
  const record=f.registry.find(later)!;const destination=join(f.root,'recovered.md')
  f.db.prepare("INSERT INTO object_move_operations VALUES (?,?,?,?,'file_published',?,NULL)").run('interrupted',record.id,record.current_path,destination,JSON.stringify([record]))
  renameSync(later,destination);new ObjectMutations(f.registry).recover()
  assert.equal(f.registry.find(destination)!.id,record.id);assert.equal(f.db.prepare("SELECT state FROM object_move_operations WHERE id='interrupted'").get<{state:string}>()?.state,'committed')
  assert.deepEqual(f.db.pragma('foreign_key_check'),[])
 }finally{f.close()}
})

test('C2 EXDEV uses a real verified copy and removes the source only after publication', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Object identity')) return
 // Moves use the async fs/promises rename, so the cross-device error is injected there.
 const {createRequire,syncBuiltinESMExports}=await import('node:module');const require=createRequire(import.meta.url)
 const fs=require('node:fs') as typeof import('node:fs');const fsp=require('node:fs/promises') as typeof import('node:fs/promises')
 const f=fixture();const original=fsp.rename
 try {
  const source=join(f.root,'source.md'),target=join(f.root,'target.md');writeFileSync(source,'cross-volume');const record=f.registry.register(source)
  let injected=false
  fsp.rename=async(from,to)=>{if(!injected && String(from)===record.current_path){injected=true;throw Object.assign(new Error('cross device'),{code:'EXDEV'})}return original(from,to)}
  syncBuiltinESMExports()
  await new ObjectMutations(f.registry).move(source,target)
  assert.equal(injected,true);assert.equal(readFileSync(target,'utf8'),'cross-volume');assert.equal(fs.existsSync(source),false);assert.equal(f.registry.find(target)!.id,record.id)
 }finally{fsp.rename=original;syncBuiltinESMExports();f.close()}
})
