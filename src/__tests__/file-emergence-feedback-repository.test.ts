import { newRepositoryFixture, prepareObjectFixtures, moveFixture } from './utils/object-repository-fixtures'
let fixtureRoot = ''
import type { DatabaseConnection } from '../main/modules/database/connection'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { FileEmergenceFeedbackRepository } from '../main/modules/repositories/file-emergence-feedback-repository'
import { FileProjectIdentityRepository } from '../main/modules/repositories/file-project-identity-repository'
import { FileActivityRepository } from '../main/modules/repositories/file-activity-repository'
import { FileAttentionRepository } from '../main/modules/repositories/file-attention-repository'
import { FileEmergenceEvaluationRepository } from '../main/modules/repositories/file-emergence-evaluation-repository'

type SqliteCtor = new(path:string) => DatabaseConnection & MigrationDatabase
const require = createRequire(import.meta.url)
function openDb(){const mod=require('better-sqlite3') as SqliteCtor&{default?:SqliteCtor};const C=mod.default||mod;const db=new C(':memory:');runMigrations(db);fixtureRoot=newRepositoryFixture();prepareObjectFixtures(db,[`${fixtureRoot}/w`],[`${fixtureRoot}/w/old.md`,`${fixtureRoot}/w/a.md`]);return db}

test('feedback survives reread, snooze expires, and hide remains attached to stable project identity', async (t) =>{
  if(skipIfSqliteUnavailable(t,'file-emergence-feedback-repository'))return
  const db=openDb();try{
    const identities=new FileProjectIdentityRepository(db)
    const project=identities.createUserProjectForPath({workspaceRoot:`${fixtureRoot}/w`,path:`${fixtureRoot}/w/a.md`,displayName:'原名称',updatedAt:100})
    const feedback=new FileEmergenceFeedbackRepository(db)
    feedback.record({projectKey:project.projectKey,action:'not_related',evidenceCutoff:200,createdAt:201})
    assert.equal(feedback.resolve(project.projectKey,200,202).reason,'not_related')
    assert.equal(feedback.resolve(project.projectKey,300,302).visible,true)
    assert.deepEqual(feedback.listSuppressedFilePaths([`${fixtureRoot}/w`],202),[`${fixtureRoot}/w/a.md`])
    const fileKey=identities.listProjectFiles(project.projectKey)[0]!.fileKey
    new FileAttentionRepository(db).recordActivity(fileKey,'open',300)
    assert.deepEqual(feedback.listSuppressedFilePaths([`${fixtureRoot}/w`],302),[],'new durable activity must release renderer suppression too')
    feedback.record({projectKey:project.projectKey,action:'snooze',snoozeUntil:500,createdAt:400})
    assert.equal(feedback.resolve(project.projectKey,450,450).reason,'snoozed')
    assert.equal(feedback.resolve(project.projectKey,450,501).visible,true)
    feedback.record({projectKey:project.projectKey,action:'hide',createdAt:600})
    identities.renameProject(project.projectKey,'新名称',601)
    const resolvedAgain=identities.resolveOrCreateProject({workspaceRoot:`${fixtureRoot}/w`,displayName:'自动名称',source:'fallback',confidence:.5,anchorPath:`${fixtureRoot}/w`,filePaths:[`${fixtureRoot}/w/a.md`],observedAt:650})
    assert.equal(resolvedAgain.projectKey,project.projectKey,'suppressed identity must not be recreated under a new key')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM project_identities').get<{count:number}>()?.count,1)
    assert.equal(feedback.resolve(project.projectKey,999,700).reason,'hidden')
    assert.deepEqual(feedback.listSuppressedFilePaths([`${fixtureRoot}/w`],700),[`${fixtureRoot}/w/a.md`])
    assert.deepEqual(feedback.listSuppressed([`${fixtureRoot}/w`],700).map((row)=>[row.projectKey,row.displayName,row.reason]),[[project.projectKey,'新名称','hidden']])
    feedback.record({projectKey:project.projectKey,action:'restore',createdAt:701})
    assert.equal(feedback.resolve(project.projectKey,999,702).visible,true)
    assert.equal(feedback.listSuppressed([`${fixtureRoot}/w`],702).length,0)
  }finally{db.close()}
})

test('not-related projects remain recoverable until replaced by later feedback', async (t) =>{
  if(skipIfSqliteUnavailable(t,'file-emergence-feedback-repository'))return
  const db=openDb();try{
    const project=new FileProjectIdentityRepository(db).createUserProjectForPath({workspaceRoot:`${fixtureRoot}/w`,path:`${fixtureRoot}/w/a.md`,displayName:'项目',updatedAt:100})
    const feedback=new FileEmergenceFeedbackRepository(db)
    assert.throws(()=>feedback.record({projectKey:project.projectKey,action:'not_related',createdAt:100}),/evidenceCutoff/)
    feedback.record({projectKey:project.projectKey,action:'not_related',evidenceCutoff:100,createdAt:101})
    assert.equal(feedback.listSuppressed([`${fixtureRoot}/w`],102)[0]?.reason,'not_related')
    feedback.record({projectKey:project.projectKey,action:'restore',createdAt:103})
    assert.equal(feedback.listSuppressed([`${fixtureRoot}/w`],104).length,0)
  }finally{db.close()}
})

test('local evaluation repository reads history and immutable prediction snapshots without upload', async (t) =>{
  if(skipIfSqliteUnavailable(t,'file-emergence-feedback-repository'))return
  const db=openDb();try{
    const identities=new FileProjectIdentityRepository(db)
    const project=identities.createUserProjectForPath({workspaceRoot:`${fixtureRoot}/w`,path:`${fixtureRoot}/w/a.md`,displayName:'项目',updatedAt:1})
    const activity=new FileActivityRepository(db)
    activity.recordEvent({workspaceRoot:`${fixtureRoot}/w`,path:`${fixtureRoot}/w/a.md`,eventType:'open',source:'file_tree',createdAt:10})
    const fileKey=identities.listProjectFiles(project.projectKey)[0]!.fileKey
    new FileAttentionRepository(db).recordSnapshot([{projectKey:project.projectKey,fileKeys:[fileKey],bucket:'future',reasonCodes:['test'],rank:1,score:.8,machineName:false}],20,{workspaceRoots:[`${fixtureRoot}/w`],rejectionReasons:{not_qualified:2}})
    activity.recordEvent({workspaceRoot:`${fixtureRoot}/w`,path:`${fixtureRoot}/w/a.md`,eventType:'open',source:'file_tree',createdAt:30})
    const report=new FileEmergenceEvaluationRepository(db).buildReport([`${fixtureRoot}/w`],40)
    assert.equal(report.postlaunchOutcomes.available,true)
    assert.equal(report.postlaunchOutcomes.top1NextUseHitRate,1)
    assert.equal(report.postlaunchOutcomes.bucketCoverage.includes('future'),true)
    assert.deepEqual(report.postlaunchOutcomes.rejectionReasonDistribution,{not_qualified:2})
  }finally{db.close()}
})

test('postlaunch outcomes use immutable snapshot file membership across a later internal move', async (t) =>{
  if(skipIfSqliteUnavailable(t,'file-emergence-feedback-repository'))return
  const db=openDb();try{
    const identities=new FileProjectIdentityRepository(db);const activity=new FileActivityRepository(db);const attention=new FileAttentionRepository(db)
    const project=identities.createUserProjectForPath({workspaceRoot:`${fixtureRoot}/w`,path:`${fixtureRoot}/w/old.md`,displayName:'项目',updatedAt:1});const file=identities.listProjectFiles(project.projectKey)[0]!
    activity.recordEvent({workspaceRoot:`${fixtureRoot}/w`,path:`${fixtureRoot}/w/old.md`,eventType:'open',source:'file_tree',createdAt:10})
    attention.recordSnapshot([{projectKey:project.projectKey,fileKeys:[file.fileKey],bucket:'future',reasonCodes:['intent'],rank:1,score:.8,machineName:false}],20,{workspaceRoots:[`${fixtureRoot}/w`],rejectionReasons:{}})
    await moveFixture(db,{workspaceRoot:`${fixtureRoot}/w`,oldPath:`${fixtureRoot}/w/old.md`,newPath:`${fixtureRoot}/w/new.md`,kind:'file',movedAt:25})
    activity.recordEvent({workspaceRoot:`${fixtureRoot}/w`,path:`${fixtureRoot}/w/new.md`,eventType:'open',source:'file_tree',createdAt:30})
    const report=new FileEmergenceEvaluationRepository(db).buildReport([`${fixtureRoot}/w`],40)
    assert.equal(report.postlaunchOutcomes.top1NextUseHitRate,1)
  }finally{db.close()}
})
