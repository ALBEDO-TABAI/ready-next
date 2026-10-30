import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './utils/ready-object-fixture'
import { ensurePortableIdentity } from '../main/modules/object-service/portable'
import { documentWriteError } from '../main/modules/document-engine/document-write-service'
import { publishFileAtomically } from '../main/modules/document-engine/atomic-file-publish'
import { DocumentMarksRepository } from '../main/modules/document-engine/document-marks-repository'

test('C2 portable identity uses structured writing, preserves bytes, and reports each failure without losing local marks',async()=>{
 const f=fixture();try{
  const path=join(f.root,'note.md');const original='\uFEFF---\r\n# comment\r\ntitle: "Keep me" # inline\r\nlist: [one, two]\r\n---\r\n正文\r\n';writeFileSync(path,original)
  const id=f.registry.register(path).id;const mark=new DocumentMarksRepository(f.db).create({documentPath:path,kind:'note',noteText:'local'})
  const index=async(p:string,c:string)=>{const result=await f.engine.indexDocument(f.root,p,c);if(!result.ok)throw new Error(result.error)}
  const dirty=await ensurePortableIdentity(f.registry,id,{index,tabs:async request=>request.phase==='prepare'?{ok:true,tabs:[{id:'tab',path,content:original+'dirty',isDirty:true}]}:{ok:true,tabs:[]}})
  assert.equal(dirty.ok,false);if(!dirty.ok)assert.equal(dirty.code,'dirty_conflict');assert.equal(readFileSync(path,'utf8'),original)
  for(const code of ['version_conflict','operation_failed','write_failed','readback_mismatch'] as const){
    const result=await ensurePortableIdentity(f.registry,id,{index,tabs:async request=>{if(request.phase==='prepare')throw documentWriteError(code,'injected');return {ok:true,tabs:[]}}})
    assert.equal(result.ok,false);if(!result.ok)assert.equal(result.code,code);assert.equal(readFileSync(path,'utf8'),original)
  }
  const failed=await ensurePortableIdentity(f.registry,id,{index:async()=>{throw documentWriteError('readback_mismatch','index failure')}})
  assert.equal(failed.ok,false);assert.equal(readFileSync(path,'utf8'),original);assert.equal(f.registry.find(path)!.identity_state,'local')
  chmodSync(path,0o444)
  const denied=await ensurePortableIdentity(f.registry,id,{index})
  assert.equal(denied.ok,false);chmodSync(path,0o644)
  const result=await ensurePortableIdentity(f.registry,id,{index})
  assert.deepEqual(result,{ok:true,objectId:id,portable:true})
  const written=readFileSync(path,'utf8');assert.equal(written.replace(`ready_id: ${id}\r\n`,''),original)
  let publishes=0;assert.equal((await ensurePortableIdentity(f.registry,id,{index,publish:async(p,c)=>{publishes++;await publishFileAtomically(p,c)}})).ok,true);assert.equal(publishes,0)
  assert.equal(new DocumentMarksRepository(f.db).get(mark.id)!.noteText,'local')
  assert.deepEqual(f.db.pragma('foreign_key_check'),[])
 }finally{f.close()}
})

test('C2 link writeback uses the write service and retains unresolved work for dirty sources',async()=>{
 const {configureDocumentWriteService,getDocumentWriteDependencies}=await import('../main/modules/document-engine/document-write-service')
 const {ObjectMutations}=await import('../main/modules/object-service/mutations')
 const f=fixture();const prior=getDocumentWriteDependencies()
 try {
  const target=join(f.root,'target.md'),source=join(f.root,'source.md');writeFileSync(target,'target');writeFileSync(source,'[[target]]\n[target](target.md)\n`[[target]]`\n')
  assert.equal((await f.engine.reindexWorkspace({root:f.root})).ok,true)
  const index=async(p:string,c:string)=>{const result=await f.engine.indexDocument(f.root,p,c);if(!result.ok)throw new Error(result.error)}
  configureDocumentWriteService({index})
  await new ObjectMutations(f.registry).move(target,join(f.root,'renamed.md'))
  assert.equal(readFileSync(source,'utf8'),'[[renamed]]\n[target](renamed.md)\n`[[target]]`\n')
  configureDocumentWriteService({index,tabs:async()=>({ok:false,code:'dirty_conflict',message:'unsaved'})})
  // External rename does not require locking the target editor. Source writeback is rejected safely.
  const {renameSync}=await import('node:fs');const {repairObjectLinks}=await import('../main/modules/object-service/link-repair')
  renameSync(join(f.root,'renamed.md'),join(f.root,'again.md'));f.registry.reconcile([join(f.root,'renamed.md'),join(f.root,'again.md')]);await repairObjectLinks(f.registry)
  assert.match(readFileSync(source,'utf8'),/\[\[renamed\]\]/)
  assert.ok(f.db.prepare("SELECT * FROM object_link_targets WHERE state='pending'").all().length)
  assert.ok(f.db.prepare('SELECT * FROM doc_links WHERE resolved=1').all().length>=2)
 }finally{configureDocumentWriteService(prior);f.close()}
})
