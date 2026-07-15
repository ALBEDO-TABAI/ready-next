import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import type { DatabaseConnection } from '../main/modules/database'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { FileActivityRepository } from '../main/modules/repositories/file-activity-repository'
import { FileAttentionRepository } from '../main/modules/repositories/file-attention-repository'
import { FileProjectIdentityRepository } from '../main/modules/repositories/file-project-identity-repository'

type SqliteCtor=new(path:string)=>DatabaseConnection&MigrationDatabase
const require=createRequire(import.meta.url)
function openDb(){const mod=require('better-sqlite3') as SqliteCtor&{default?:SqliteCtor};const C=mod.default||mod;const db=new C(':memory:');runMigrations(db);return db}
const day=86_400_000

test('rollup backfill is idempotent, survives raw pruning, and follows stable file identity through a move',(t)=>{
  if(skipIfSqliteUnavailable(t,'file-attention-repository'))return
  const db=openDb();try{
    const now=200*day;const activity=new FileActivityRepository(db);const identities=new FileProjectIdentityRepository(db)
    activity.recordEvent({path:'/w/p/a.md',workspaceRoot:'/w',eventType:'open',source:'file_tree',createdAt:now-70*day})
    activity.recordEvent({path:'/w/p/a.md',workspaceRoot:'/w',eventType:'save',source:'document_write',createdAt:now-69*day})
    const file=identities.ensureFile({workspaceRoot:'/w',path:'/w/p/a.md',observedAt:now-70*day})
    const repo=new FileAttentionRepository(db);repo.backfill(['/w'],now);repo.backfill(['/w'],now)
    assert.equal(repo.list(['/w'])[0]?.openCount,1);assert.equal(repo.list(['/w'])[0]?.saveCount,1)
    activity.prune(now-30*day,10000);assert.equal(repo.list(['/w'])[0]?.saveCount,1)
    identities.recordInternalMove({workspaceRoot:'/w',oldPath:'/w/p/a.md',newPath:'/w/p/b.md',kind:'file',movedAt:now})
    assert.equal(repo.list(['/w'])[0]?.fileKey,file.fileKey)
  }finally{db.close()}
})

test('a live event recorded before first backfill does not hide older retained history or mark another root backfilled',(t)=>{
  if(skipIfSqliteUnavailable(t,'file-attention-repository'))return
  const db=openDb();try{
    const now=200*day;const activity=new FileActivityRepository(db);const identities=new FileProjectIdentityRepository(db);const repo=new FileAttentionRepository(db)
    activity.recordEvent({path:'/w/a.md',workspaceRoot:'/w',eventType:'open',source:'file_tree',createdAt:now-20*day})
    const file=identities.ensureFile({workspaceRoot:'/w',path:'/w/a.md',observedAt:now-20*day})
    activity.recordEvent({path:'/w/a.md',workspaceRoot:'/w',eventType:'save',source:'document_write',createdAt:now})
    repo.recordActivity(file.fileKey,'save',now)
    const other=identities.ensureFile({workspaceRoot:'/other',path:'/other/b.md',observedAt:now})
    repo.recordActivity(other.fileKey,'open',now)

    repo.backfill(['/w'],now)
    const rollup=repo.list(['/w'])[0]!
    assert.equal(rollup.openCount,1)
    assert.equal(rollup.saveCount,1)
    assert.equal(rollup.observedSince,now-20*day)
    assert.equal(db.prepare('SELECT backfilled_at AS at FROM file_attention_rollups WHERE file_key=?').get<{at:number|null}>(other.fileKey)?.at,null)
    repo.backfill(['/w'],now+1)
    assert.equal(repo.list(['/w'])[0]?.saveCount,1)
  }finally{db.close()}
})

test('intent lifecycle expires deterministically and snapshots contain keys rather than paths',(t)=>{
  if(skipIfSqliteUnavailable(t,'file-attention-repository'))return
  const db=openDb();try{
    const ids=new FileProjectIdentityRepository(db);const project=ids.createUserProjectForPath({workspaceRoot:'/w',path:'/w/a.md',displayName:'阅读项目',updatedAt:Date.now()})
    const file=ids.listProjectFiles(project.projectKey)[0]!;const repo=new FileAttentionRepository(db)
    const intent=repo.createIntent({projectKey:project.projectKey,fileKeys:[file.fileKey],kind:'read',source:'user_confirmed',notBefore:null,dueAt:null,expiresAt:Date.now()+day,evidenceCode:'user_continue',evidenceRef:null})
    assert.equal(repo.listActiveIntents([project.projectKey]).length,1)
    repo.setIntentStatus(intent.intentId,'completed');assert.equal(repo.listActiveIntents([project.projectKey]).length,0)
    repo.recordSnapshot([{projectKey:project.projectKey,bucket:'future',reasonCodes:['task'],rank:1,score:.8,machineName:false}],Date.now(),{workspaceRoots:['/w'],rejectionReasons:{not_qualified:2}})
    repo.recordSnapshot([],Date.now()+1,{workspaceRoots:['/w'],rejectionReasons:{not_qualified:3}})
    const raw=JSON.stringify(db.prepare('SELECT * FROM file_emergence_prediction_snapshots').all())
    assert.equal(raw.includes('/w/a.md'),false)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM file_emergence_snapshot_generations').get<{count:number}>()?.count,2,'empty generations must remain observable')
  }finally{db.close()}
})

test('active intent is durably cancelled when its project is hidden or a referenced file becomes missing or archived',(t)=>{
  if(skipIfSqliteUnavailable(t,'file-attention-repository'))return
  const db=openDb();try{
    const ids=new FileProjectIdentityRepository(db);const repo=new FileAttentionRepository(db);const now=Date.now()
    const project=ids.createUserProjectForPath({workspaceRoot:'/w',path:'/w/a.md',displayName:'项目',updatedAt:now})
    const file=ids.listProjectFiles(project.projectKey)[0]!
    repo.recordActivity(file.fileKey,'open',now)
    const create=(id:string)=>repo.createIntent({intentId:id,projectKey:project.projectKey,fileKeys:[file.fileKey],kind:'continue',source:'user_confirmed',notBefore:null,dueAt:null,expiresAt:now+day,evidenceCode:'continue',evidenceRef:null})

    create('missing-intent')
    db.prepare("UPDATE file_identities SET status='missing' WHERE file_key=?").run(file.fileKey)
    assert.equal(repo.listActiveIntents([project.projectKey],now).length,0)
    assert.equal(db.prepare("SELECT status FROM project_intent_facts WHERE intent_id='missing-intent'").get<{status:string}>()?.status,'cancelled')

    db.prepare("UPDATE file_identities SET status='present' WHERE file_key=?").run(file.fileKey)
    create('archived-intent')
    db.prepare("UPDATE file_attention_rollups SET exists_state='archived' WHERE file_key=?").run(file.fileKey)
    assert.equal(repo.listActiveIntents([project.projectKey],now).length,0)

    db.prepare("UPDATE file_attention_rollups SET exists_state='present' WHERE file_key=?").run(file.fileKey)
    create('hidden-intent')
    db.prepare("UPDATE project_identities SET status='hidden' WHERE project_key=?").run(project.projectKey)
    assert.equal(repo.listActiveIntents([project.projectKey],now).length,0)
    assert.deepEqual(db.prepare("SELECT status FROM project_intent_facts WHERE intent_id IN ('archived-intent','hidden-intent') ORDER BY intent_id").all<{status:string}>().map((row)=>row.status),['cancelled','cancelled'])
  }finally{db.close()}
})
