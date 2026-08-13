import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { mkdtemp,writeFile,readFile,realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import type { DatabaseConnection } from '../main/modules/database'
import { runMigrations,type MigrationDatabase } from '../main/modules/migrations'
import { FileProjectIdentityRepository } from '../main/modules/repositories/file-project-identity-repository'
import { TagForgeRepository, tagOverlayId } from '../main/modules/repositories/tag-forge-repository'
import { loadTagForgePolicy } from '../main/modules/tag-forge/tag-forge-policy'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { buildSearchIndexContentHash } from '../main/modules/search-engine/adapters'
import { revisionOf } from '../main/modules/tag-forge/tag-forge-writer'
import { buildTagForgeCreationContent, validateTagForgeCreationProposals } from '../main/modules/tag-forge/tag-forge-creation-validation'
import { finalizeTagForgeCreation } from '../main/modules/tag-forge/tag-forge-creation-finalizer'
import { executeTagForgeApply } from '../main/modules/tag-forge/tag-forge-tool'
type Ctor=new(path:string)=>DatabaseConnection&MigrationDatabase;const require=createRequire(import.meta.url)
function openDb(){const m=require('better-sqlite3') as Ctor&{default?:Ctor};const C=m.default||m;const db=new C(':memory:');runMigrations(db);return db}

async function createFinalizeFixture(db:ReturnType<typeof openDb>,name:string,manualTags:string[]=[]){
  const rawRoot=await mkdtemp(join(tmpdir(),`tag-forge-finalize-${name}-`))
  const rawPath=join(rawRoot,`${name}.md`)
  const body='# CanvasKit API 技术参考资料\n\n这是 AI 工作流的 CanvasKit API 参考。'
  const source=manualTags.length?`---\ntags:\n${manualTags.map((tag)=>`  - ${tag}`).join('\n')}\n---\n${body}`:body
  const policy=loadTagForgePolicy()
  const validated=validateTagForgeCreationProposals(policy,[
    {facet:'form',label:'参考资料',evidenceCode:'form',evidenceExcerpt:'技术参考资料',confidence:.95},
    {facet:'domain',label:'AI工作流',evidenceCode:'domain',evidenceExcerpt:'AI 工作流',confidence:.95},
    {facet:'entity',label:'CanvasKit API',evidenceCode:'entity',evidenceExcerpt:'CanvasKit API',confidence:.8},
  ],source)
  assert.equal(validated.ok,true)
  if(!validated.ok)throw new Error('fixture validation failed')
  const content=buildTagForgeCreationContent(policy,source,validated.tags)
  await writeFile(rawPath,content)
  const root=await realpath(rawRoot)
  const path=await realpath(rawPath)
  const file=new FileProjectIdentityRepository(db).ensureFile({workspaceRoot:root,path})
  const repo=new TagForgeRepository(db)
  const runId=`run-${name}`
  const receiptId=repo.mintCreationReceipt({sourceRunId:runId,fileKey:file.fileKey})
  const preservedManualTagIds=validated.tags.filter((tag)=>manualTags.some((label)=>label.trim().toLocaleLowerCase()===tag.label.trim().toLocaleLowerCase())).map((tag)=>tag.tagId)
  repo.storeCreationValidation(receiptId,revisionOf(content),JSON.stringify({tags:validated.tags,admittedEntries:validated.admittedEntries,bodyRevision:validated.bodyRevision,preservedManualTagIds}))
  const searchEngine=new SearchEngine(db,{fts5Available:false})
  return{root,path,body,content,file,repo,runId,receiptId,searchEngine,payload:{receiptId,sourceRunId:runId,path,workspaceRoots:[root]}}
}

test('creation validation survives repository recreation and remains recoverable by trusted file identity', (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb();try{const file=new FileProjectIdentityRepository(db).ensureFile({workspaceRoot:'/w',path:'/w/recover.md'});let repo=new TagForgeRepository(db);const receipt=repo.mintCreationReceipt({sourceRunId:'run-before-restart',fileKey:file.fileKey});const validation=JSON.stringify({tags:[{tagId:'tutorial',facet:'form',label:'教程',confidence:.95,evidenceCode:'form',resolution:'exact'}],admittedEntries:[],bodyRevision:'body-hash'});repo.storeCreationValidation(receipt,'final-hash',validation);repo=new TagForgeRepository(db);const recovered=repo.findRecoverableCreationReceipt(file.fileKey);assert.equal(recovered?.receiptId,receipt);assert.equal(recovered?.finalSaveHash,'final-hash');assert.equal(recovered?.validationJson,validation);assert.equal(repo.findOpenCreationReceipt('run-before-restart',file.fileKey)?.receiptId,receipt)}finally{db.close()}})

test('a completed recovery supersedes the old receipt so later saves cannot revive it', (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb();try{const file=new FileProjectIdentityRepository(db).ensureFile({workspaceRoot:'/w',path:'/w/recovered.md'});const repo=new TagForgeRepository(db);const oldReceipt=repo.mintCreationReceipt({sourceRunId:'old-run',fileKey:file.fileKey});repo.storeCreationValidation(oldReceipt,'old-hash','{"tags":[],"admittedEntries":[],"bodyRevision":"body"}');const newReceipt=repo.mintCreationReceipt({sourceRunId:'new-run',fileKey:file.fileKey});repo.storeCreationValidation(newReceipt,'new-hash','{"tags":[],"admittedEntries":[],"bodyRevision":"body"}');repo.supersedeCreationReceipt(oldReceipt);repo.markReceipt(newReceipt,'completed');assert.equal(repo.getCreationReceipt(oldReceipt,'old-run')?.status,'failed_terminal');assert.equal(repo.findRecoverableCreationReceipt(file.fileKey),null)}finally{db.close()}})

test('creation finalize accepts an already-indexed skipped write while preserving manual ownership', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb();try{const fixture=await createFinalizeFixture(db,'skipped',['教程','AI工作流']);await fixture.searchEngine.indexDocument(fixture.root,fixture.path,fixture.content);let calls=0;fixture.searchEngine.indexDocument=async()=>{calls+=1;return{ok:true,documentId:1,skipped:true}};const output=await finalizeTagForgeCreation(fixture.payload,{db,searchEngine:fixture.searchEngine});const ownership=Object.fromEntries(fixture.repo.listAssignments(fixture.file.fileKey).map((item)=>[item.label,item.ownership]));assert.equal(output.success,true);assert.equal(calls,1);assert.equal(ownership['教程'],'manual');assert.equal(ownership['AI工作流'],'manual');assert.equal(ownership['参考资料'],undefined);assert.equal(ownership['CanvasKit API'],'automatic');assert.equal(fixture.repo.getCreationReceipt(fixture.receiptId,fixture.runId)?.status,'completed')}finally{db.close()}})

test('completed creation finalize is a read-only idempotent success', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb();try{const fixture=await createFinalizeFixture(db,'repeat');const first=await finalizeTagForgeCreation(fixture.payload,{db,searchEngine:fixture.searchEngine});assert.equal(first.success,true);db.prepare(`UPDATE artifact_creation_receipts SET validation_json=NULL WHERE receipt_id=?`).run(fixture.receiptId);const before=db.prepare(`SELECT enrichment_status AS status,updated_at AS updatedAt FROM artifact_creation_receipts WHERE receipt_id=?`).get<{status:string;updatedAt:number}>(fixture.receiptId)!;let calls=0;fixture.searchEngine.indexDocument=async()=>{calls+=1;throw new Error('must not reindex')};const second=await finalizeTagForgeCreation(fixture.payload,{db,searchEngine:fixture.searchEngine});const after=db.prepare(`SELECT enrichment_status AS status,updated_at AS updatedAt FROM artifact_creation_receipts WHERE receipt_id=?`).get<{status:string;updatedAt:number}>(fixture.receiptId)!;assert.equal(second.success,true);assert.equal(calls,0);assert.deepEqual(after,before)}finally{db.close()}})

test('superseded creation receipts cannot be revived by a stale finalize', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb();try{const fixture=await createFinalizeFixture(db,'superseded');fixture.repo.supersedeCreationReceipt(fixture.receiptId);const output=await finalizeTagForgeCreation(fixture.payload,{db,searchEngine:fixture.searchEngine});assert.equal(output.success,false);assert.equal(fixture.repo.getCreationReceipt(fixture.receiptId,fixture.runId)?.status,'failed_terminal')}finally{db.close()}})

test('creation finalize restores the index to an external post-index disk edit', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb();try{const fixture=await createFinalizeFixture(db,'external');const external='# 外部修改\n\n用户同时改写了文档。';const realIndex=fixture.searchEngine.indexDocument.bind(fixture.searchEngine);let calls=0;fixture.searchEngine.indexDocument=async(root,path,content)=>{calls+=1;const result=await realIndex(root,path,content);if(calls===1)await writeFile(fixture.path,external);return result};const output=await finalizeTagForgeCreation(fixture.payload,{db,searchEngine:fixture.searchEngine});assert.equal(output.success,false);assert.equal(output.error,'post_index_disk_mismatch');assert.equal(calls,2);assert.equal(await readFile(fixture.path,'utf8'),external);const indexed=db.prepare(`SELECT d.content_hash AS contentHash FROM documents d JOIN workspaces w ON w.id=d.workspace_id WHERE w.root=? AND d.path=?`).get<{contentHash:string}>(fixture.root,fixture.path);assert.equal(indexed?.contentHash,buildSearchIndexContentHash(external))}finally{db.close()}})

test('concurrent finalize calls share one commit and preserve the admitted overlay', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb();try{const fixture=await createFinalizeFixture(db,'concurrent');const realIndex=fixture.searchEngine.indexDocument.bind(fixture.searchEngine);let release!:()=>void;const gate=new Promise<void>((resolve)=>{release=resolve});let started!:()=>void;const firstIndexStarted=new Promise<void>((resolve)=>{started=resolve});let calls=0;fixture.searchEngine.indexDocument=async(...args)=>{calls+=1;if(calls===1)started();await gate;return realIndex(...args)};const pending=Promise.all([finalizeTagForgeCreation(fixture.payload,{db,searchEngine:fixture.searchEngine}),finalizeTagForgeCreation(fixture.payload,{db,searchEngine:fixture.searchEngine})]);await firstIndexStarted;await new Promise<void>((resolve)=>setImmediate(resolve));const observedCalls=calls;release();const results=await pending;assert.equal(observedCalls,1);assert.equal(results.every((item)=>item.success),true);assert.equal(fixture.repo.listOverlay().some((entry)=>entry.label==='CanvasKit API'),true);assert.equal(fixture.repo.getCreationReceipt(fixture.receiptId,fixture.runId)?.status,'completed')}finally{db.close()}})

test('overlay rollback cannot remove an entry assigned to another file', (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb();try{const file=new FileProjectIdentityRepository(db).ensureFile({workspaceRoot:'/w',path:'/w/kept.md'});const repo=new TagForgeRepository(db);const tagId=tagOverlayId('entity','CanvasKit API');repo.upsertOverlay({id:tagId,facet:'entity',label:'CanvasKit API',aliases:[]});repo.replaceAutomaticAssignments(file.fileKey,[{tagId,facet:'entity',label:'CanvasKit API',confidence:.9,evidenceCode:'entity',resolution:'exact'}],'tag_forge_auto','test');repo.removeOverlayIfUnassigned(tagId);assert.equal(repo.listOverlay().some((entry)=>entry.id===tagId),true)}finally{db.close()}})

test('overlay is independent, pending dedupes, and manual deletion suppresses automatic restoration', (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb();try{const ids=new FileProjectIdentityRepository(db);const file=ids.ensureFile({workspaceRoot:'/w',path:'/w/new.md'});const repo=new TagForgeRepository(db);repo.upsertOverlay({id:'ready',facet:'entity',label:'Ready',aliases:['Ready App']});assert.equal(repo.listOverlay()[0]?.label,'Ready');repo.addPending([{facet:'entity',label:'新实体',evidenceCode:'entity',confidence:.8}],null);repo.addPending([{facet:'entity',label:'新实体',evidenceCode:'entity2',confidence:.9}],null);assert.equal(repo.listPending().length,1);repo.replaceAutomaticAssignments(file.fileKey,[{tagId:'ai-workflow',facet:'domain',label:'AI工作流',confidence:.8,evidenceCode:'domain',resolution:'exact'}],'tag_forge_auto','0.1');repo.reconcileAssignments({fileKey:file.fileKey,frontmatterTags:[],knownEntries:loadTagForgePolicy().entries});assert.equal(repo.listAssignments(file.fileKey)[0]?.suppressed,true)}finally{db.close()}})

test('pending proposals with the same label stay isolated by batch item', (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb();try{const repo=new TagForgeRepository(db);const proposal=[{facet:'domain' as const,label:'浏览器技术',evidenceCode:'topic',evidenceExcerpt:'浏览器技术',confidence:.8}];const first={sourceRunId:'run-1',batchId:'batch-1',itemId:'item-1',scopeId:'scope-1'};const second={sourceRunId:'run-2',batchId:'batch-2',itemId:'item-2',scopeId:'scope-2'};const firstRows=repo.addPending(proposal,first);const secondRows=repo.addPending(proposal,second);assert.equal(repo.listPending().length,2);assert.notEqual(firstRows[0].proposalId,secondRows[0].proposalId);repo.reviewPending(firstRows[0].proposalId,'dismiss');assert.equal(repo.listRejected(first).some((item)=>item.label==='浏览器技术'),true);assert.equal(repo.listRejected(second).some((item)=>item.label==='浏览器技术'),false);assert.equal(repo.listPending(second).length,1)}finally{db.close()}})

test('a scoped dismissal remains effective when the host has no run id', (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb();try{const repo=new TagForgeRepository(db);const identity={sourceRunId:null,batchId:'batch-no-run',itemId:'item-no-run',scopeId:'scope-no-run'};const [pending]=repo.addPending([{facet:'domain',label:'未采用候选',evidenceCode:'topic',evidenceExcerpt:'未采用候选',confidence:.8}],identity);repo.reviewPending(pending.proposalId,'dismiss');assert.deepEqual(repo.listRejected(identity),[{facet:'domain',label:'未采用候选'}]);assert.deepEqual(repo.listRejected(),[])}finally{db.close()}})

test('automatic replacement never takes ownership away from a manual tag', (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb();try{const ids=new FileProjectIdentityRepository(db);const file=ids.ensureFile({workspaceRoot:'/w',path:'/w/manual.md'});const repo=new TagForgeRepository(db);const entry=loadTagForgePolicy().entries.find((item)=>item.id==='ai-workflow')!;repo.reconcileAssignments({fileKey:file.fileKey,frontmatterTags:['AI工作流'],knownEntries:[entry]});repo.replaceAutomaticAssignments(file.fileKey,[{tagId:entry.id,facet:entry.facet,label:entry.label,confidence:.9,evidenceCode:'auto',resolution:'exact'}],'tag_forge_explicit','0.2');assert.equal(repo.listAssignments(file.fileKey)[0]?.ownership,'manual')}finally{db.close()}})

test('single-file reindex reconciles ready_state changes into tag assignments', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db = openDb()
  try {
    const rawRoot = await mkdtemp(join(tmpdir(), 'tag-forge-single-file-state-'))
    const rawPath = join(rawRoot, 'state.md')
    const firstContent = '---\ntags: [AI工作流]\nready_state: 待整理\n---\n# Ready 工作流\n'
    await writeFile(rawPath, firstContent)
    const root = await realpath(rawRoot)
    const path = await realpath(rawPath)
    const engine = new SearchEngine(db, { fts5Available: false })

    const first = await engine.indexDocument(root, path)
    assert.equal(first.ok, true)
    assert.equal(first.skipped, false)

    const file = new FileProjectIdentityRepository(db).ensureFile({ workspaceRoot: root, path })
    const repo = new TagForgeRepository(db)
    assert.deepEqual(
      repo.listAssignments(file.fileKey)
        .filter((item) => item.facet === 'state')
        .map((item) => ({ label: item.label, ownership: item.ownership, suppressed: item.suppressed })),
      [{ label: '待整理', ownership: 'manual', suppressed: false }],
    )

    const updatedContent = firstContent.replace('ready_state: 待整理', 'ready_state: 精选')
    await writeFile(path, updatedContent)
    const updated = await engine.indexDocument(root, path)
    assert.equal(updated.ok, true)
    assert.equal(updated.skipped, false)
    assert.deepEqual(
      repo.listAssignments(file.fileKey)
        .filter((item) => item.facet === 'state')
        .map((item) => ({ label: item.label, ownership: item.ownership, suppressed: item.suppressed })),
      [{ label: '精选', ownership: 'manual', suppressed: false }],
    )
  } finally {
    db.close()
  }
})

test('tag forge stages automatic ownership before indexing while preserving manual ownership', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb()
  try{
    const root=await mkdtemp(join(tmpdir(),'tag-forge-ownership-'))
    const path=join(root,'manual.md')
    const content='---\ntags: [AI工作流, 参考资料]\n---\n# 教程\n\n这是 AI 工作流教程，用于团队分享。'
    await writeFile(path,content)
    const file=new FileProjectIdentityRepository(db).ensureFile({workspaceRoot:root,path})
    const repo=new TagForgeRepository(db)
    const policy=loadTagForgePolicy()
    repo.reconcileAssignments({fileKey:file.fileKey,frontmatterTags:['AI工作流','参考资料'],knownEntries:policy.entries})
    const engine=new SearchEngine(db,{fts5Available:false})
    const realIndex=engine.indexDocument.bind(engine)
    let observedDuringIndex:ReturnType<TagForgeRepository['listAssignments']>=[]
    engine.indexDocument=async(workspaceRoot,filePath,indexContent)=>{
      observedDuringIndex=repo.listAssignments(file.fileKey)
      return realIndex(workspaceRoot,filePath,indexContent)
    }
    const output=JSON.parse(await executeTagForgeApply({
      path,expectedRevision:revisionOf(content),
      proposals:[
        {facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'教程',confidence:.95},
        {facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.95},
        {facet:'use',label:'团队分享',evidenceCode:'use',evidenceExcerpt:'团队分享',confidence:.95},
      ],
    },engine,{workspaceRoots:[root],runId:'run-ownership'}))
    assert.equal(output.status,'completed')
    assert.equal(observedDuringIndex.find((item)=>item.label==='教程'),undefined)
    assert.equal(observedDuringIndex.find((item)=>item.label==='团队分享')?.ownership,'automatic')
    assert.equal(repo.listAssignments(file.fileKey).find((item)=>item.label==='AI工作流')?.ownership,'manual')
    assert.equal(repo.listAssignments(file.fileKey).find((item)=>item.label==='参考资料')?.ownership,'manual')
    assert.match(await readFile(path,'utf8'),/tags:\n {2}- AI工作流\n {2}- 参考资料\n {2}- 团队分享/)
  }finally{db.close()}
})

test('an unchanged generic apply indexes an unindexed document on the first run', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb()
  try{
    const root=await mkdtemp(join(tmpdir(),'tag-forge-noop-index-'))
    const path=join(root,'ready.md')
    const body='# AI 工作流教程\n\n这是 AI 工作流教程。'
    const policy=loadTagForgePolicy()
    const validated=validateTagForgeCreationProposals(policy,[
      {facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'教程',confidence:.99},
      {facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.99},
    ],body)
    assert.equal(validated.ok,true)
    if(!validated.ok)return
    const content=buildTagForgeCreationContent(policy,body,validated.tags)
    await writeFile(path,content)
    const engine=new SearchEngine(db,{fts5Available:false})
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM documents`).get<{count:number}>()?.count,0)
    const output=JSON.parse(await executeTagForgeApply({
      path,expectedRevision:revisionOf(content),proposals:[
        {facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'教程',confidence:.99},
        {facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.99},
      ],
    },engine,{workspaceRoots:[root],runId:'run-noop-index'}))
    assert.equal(output.status,'completed')
    assert.equal(await readFile(path,'utf8'),content)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM documents`).get<{count:number}>()?.count,1)
  }finally{db.close()}
})

test('skipped indexing succeeds when strict readback already matches', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb()
  try{
    const root=await mkdtemp(join(tmpdir(),'tag-forge-skipped-'))
    const path=join(root,'skipped.md')
    const content='---\ntags: [Claude]\n---\n# 教程\n\nAI 工作流教程。'
    await writeFile(path,content)
    const file=new FileProjectIdentityRepository(db).ensureFile({workspaceRoot:root,path})
    const repo=new TagForgeRepository(db)
    const claude=loadTagForgePolicy().entries.find((entry)=>entry.id==='claude')!
    repo.replaceAutomaticAssignments(file.fileKey,[{tagId:claude.id,facet:claude.facet,label:claude.label,confidence:.9,evidenceCode:'existing',resolution:'exact'}],'tag_forge_auto','0.2')
    const engine=new SearchEngine(db,{fts5Available:false})
    const realIndex=engine.indexDocument.bind(engine)
    let first=true
    engine.indexDocument=async(workspaceRoot,filePath,indexContent)=>{
      if(first){
        first=false
        const indexed=await realIndex(workspaceRoot,filePath,indexContent)
        assert.equal(indexed.ok,true)
        return{ok:true,skipped:true}
      }
      return realIndex(workspaceRoot,filePath,indexContent)
    }
    const output=JSON.parse(await executeTagForgeApply({
      path,expectedRevision:revisionOf(content),
      proposals:[
        {facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'教程',confidence:.95},
        {facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.95},
      ],
    },engine,{workspaceRoots:[root],runId:'run-skipped'}))
    assert.equal(output.status,'completed')
    assert.match(await readFile(path,'utf8'),/tags:\n {2}- 教程\n {2}- AI工作流/)
    assert.deepEqual(repo.listAssignments(file.fileKey).filter((item)=>item.facet!=='state').map((item)=>({label:item.label,ownership:item.ownership,suppressed:item.suppressed})),[
      {label:'AI工作流',ownership:'automatic',suppressed:false},
      {label:'教程',ownership:'automatic',suppressed:false},
    ])
  }finally{db.close()}
})

test('an unindexed manual tag stays manual across repeated explicit retagging', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb()
  try{
    const root=await mkdtemp(join(tmpdir(),'tag-forge-unindexed-manual-'))
    const path=join(root,'manual.md')
    const original='---\ntags: [AI工作流]\n---\n# Claude 教程\n\nAI 工作流与 Claude 教程。'
    await writeFile(path,original)
    const engine=new SearchEngine(db,{fts5Available:false})
    const first=JSON.parse(await executeTagForgeApply({
      path,expectedRevision:revisionOf(original),proposals:[
        {facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'教程',confidence:.99},
        {facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.99},
      ],
    },engine,{workspaceRoots:[root],runId:'run-unindexed-manual-1'}))
    assert.equal(first.status,'completed')
    const file=new FileProjectIdentityRepository(db).ensureFile({workspaceRoot:root,path})
    const repo=new TagForgeRepository(db)
    assert.equal(repo.listAssignments(file.fileKey).find((item)=>item.label==='AI工作流')?.ownership,'manual')

    const second=JSON.parse(await executeTagForgeApply({
      path,expectedRevision:first.revision,proposals:[
        {facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'教程',confidence:.99},
        {facet:'entity',label:'Claude',evidenceCode:'entity',evidenceExcerpt:'Claude',confidence:.99},
      ],
    },engine,{workspaceRoots:[root],runId:'run-unindexed-manual-2'}))
    assert.equal(second.status,'completed')
    assert.match(await readFile(path,'utf8'),/AI工作流/)
    assert.equal(repo.listAssignments(file.fileKey).find((item)=>item.label==='AI工作流')?.ownership,'manual')
  }finally{db.close()}
})

test('a post-index external edit is preserved and becomes the indexed truth', async (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb()
  try{
    const root=await mkdtemp(join(tmpdir(),'tag-forge-race-'))
    const path=join(root,'race.md')
    const content='# 教程\n\nAI 工作流教程。'
    const external='# 外部修改\n\n这份内容由用户同时修改。'
    await writeFile(path,content)
    const file=new FileProjectIdentityRepository(db).ensureFile({workspaceRoot:root,path})
    const repo=new TagForgeRepository(db)
    const engine=new SearchEngine(db,{fts5Available:false})
    const realIndex=engine.indexDocument.bind(engine)
    let first=true
    engine.indexDocument=async(workspaceRoot,filePath,indexContent)=>{
      const result=await realIndex(workspaceRoot,filePath,indexContent)
      if(first){first=false;await writeFile(path,external)}
      return result
    }
    const synced:string[]=[]
    const output=JSON.parse(await executeTagForgeApply({
      path,expectedRevision:revisionOf(content),
      proposals:[
        {facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'教程',confidence:.95},
        {facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.95},
      ],
    },engine,{
      workspaceRoots:[root],runId:'run-race',
      requestModuleToolAction:async(tool,args)=>{
        if(tool==='tagForge.applyContent')synced.push(String(args.content||''))
        return{ok:true}
      },
    }))
    assert.equal(output.errorKind,'post_index_revision_conflict')
    assert.equal(await readFile(path,'utf8'),external)
    const indexed=db.prepare(`SELECT d.content_hash AS contentHash FROM documents d JOIN workspaces w ON w.id=d.workspace_id WHERE w.root=? AND d.path=?`).get<{contentHash:string}>(root,path)
    assert.equal(indexed?.contentHash,buildSearchIndexContentHash(external))
    assert.deepEqual(repo.listAssignments(file.fileKey),[])
    assert.equal(synced.at(-1),external)
  }finally{db.close()}
})

test('overlay ids use the full stable hash and reject a conflicting legacy id', (t) => {
  if (skipIfSqliteUnavailable(t, 'tag-forge-repository')) return
  const db=openDb()
  try{
    const shared='这是一个非常长且前缀完全相同的用户标签-'
    const first=tagOverlayId('entity',`${shared}甲`)
    const second=tagOverlayId('entity',`${shared}乙`)
    assert.equal(first.length,69)
    assert.notEqual(first,second)
    assert.equal(tagOverlayId('entity',' Ready '),tagOverlayId('entity','ready'))
    db.prepare(`INSERT INTO tag_lexicon_overlays(tag_id,facet,label,aliases_json,definition,status,created_at,updated_at) VALUES('user-legacy','entity','旧词条','[]','','active',1,1)`).run()
    const repo=new TagForgeRepository(db)
    assert.equal(repo.listOverlay().some((entry)=>entry.id==='user-legacy'),true)
    assert.throws(()=>repo.upsertOverlay({id:tagOverlayId('entity','旧词条'),facet:'entity',label:'旧词条',aliases:[]}),/legacy overlay id requires migration/)
  }finally{db.close()}
})
