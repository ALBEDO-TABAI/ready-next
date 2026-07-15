import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

import type { DatabaseConnection } from '../main/modules/database'
import {
  __getMigrationNamesForTests,
  __runMigrationForTests,
  runMigrations,
  type MigrationDatabase,
} from '../main/modules/migrations'

type SqliteConstructor = new(path:string)=>DatabaseConnection&MigrationDatabase
const require=createRequire(import.meta.url)

function openBefore075():DatabaseConnection&MigrationDatabase {
  const module=require('better-sqlite3') as SqliteConstructor&{default?:SqliteConstructor}
  const Constructor=module.default||module
  const db=new Constructor(':memory:')
  db.exec(`CREATE TABLE migrations (id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL)`)
  const names=__getMigrationNamesForTests()
  const targetIndex=names.indexOf('075_tag_forge_durable_creation_validation')
  assert.notEqual(targetIndex,-1)
  const markApplied=db.prepare(`INSERT INTO migrations(name,applied_at) VALUES(?,'test')`)
  for(const name of names.slice(targetIndex))markApplied.run(name)
  runMigrations(db)
  return db
}

test('migration 075 leaves ambiguous legacy package tag ownership untouched',(t)=>{
  if(skipIfSqliteUnavailable(t,'migration-075-tag-forge-creation-validation'))return
  const db=openBefore075()
  try{
    db.prepare(`INSERT INTO workspaces(root) VALUES('/workspace')`).run()
    const workspaceId=db.prepare(`SELECT id FROM workspaces WHERE root='/workspace'`).get<{id:number}>()!.id
    const legacyFrontmatter=JSON.stringify({tags:['待整理','参考资料','AI工作流']})
    db.prepare(`INSERT INTO documents(workspace_id,path,name,frontmatter_json,source_type) VALUES(?,'/workspace/legacy.md','legacy.md',?,'document')`).run(workspaceId,legacyFrontmatter)
    db.prepare(`INSERT INTO file_identities(file_key,workspace_root,current_path,status,observed_since,last_verified_at) VALUES('legacy-file','/workspace','/workspace/legacy.md','present',1,1)`).run()
    const insertAssignment=db.prepare(`INSERT INTO file_tag_assignments(file_key,tag_id,facet,label,source,ownership,suppressed,evidence_code,confidence,validated_at,written_at,readback_at,updated_at) VALUES('legacy-file',?,?,?,?,?,?,?,1,1000,1000,1000,1000)`)
    insertAssignment.run('inbox','state','待整理','user','manual',0,'frontmatter_reconcile')
    insertAssignment.run('reference-doc','form','参考资料','user','manual',0,'frontmatter_reconcile')
    insertAssignment.run('ai-workflow','domain','AI工作流','user','manual',0,'frontmatter_reconcile')
    const before=db.prepare(`SELECT tag_id AS tagId,facet,label,source,ownership,suppressed,evidence_code AS evidenceCode,updated_at AS updatedAt FROM file_tag_assignments WHERE file_key='legacy-file' ORDER BY tag_id`).all<Record<string,unknown>>()
    db.prepare(`INSERT INTO artifact_creation_receipts(receipt_id,source_run_id,file_key,created_in_this_run,created_at,enrichment_status,updated_at) VALUES('sparse','run-sparse','legacy-file',1,1,'completed_sparse',1),('complete','run-complete','legacy-file',1,1,'completed',1)`).run()

    __runMigrationForTests('075_tag_forge_durable_creation_validation',db)

    const after=db.prepare(`SELECT tag_id AS tagId,facet,label,source,ownership,suppressed,evidence_code AS evidenceCode,updated_at AS updatedAt FROM file_tag_assignments WHERE file_key='legacy-file' ORDER BY tag_id`).all<Record<string,unknown>>()
    assert.deepEqual(after,before)
    assert.deepEqual(JSON.parse(db.prepare(`SELECT frontmatter_json AS frontmatter FROM documents WHERE path='/workspace/legacy.md'`).get<{frontmatter:string}>()!.frontmatter),{tags:['待整理','参考资料','AI工作流']})
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('artifact_creation_receipts') WHERE name='validation_json'`).get<{count:number}>()?.count,1)
    assert.deepEqual(db.prepare(`SELECT enrichment_status AS status,retry_error_code AS errorCode,validation_json AS validation FROM artifact_creation_receipts WHERE receipt_id='sparse'`).get(),{status:'failed_retryable',errorCode:'legacy_sparse_result',validation:null})
    assert.deepEqual(db.prepare(`SELECT enrichment_status AS status,retry_error_code AS errorCode,validation_json AS validation FROM artifact_creation_receipts WHERE receipt_id='complete'`).get(),{status:'completed',errorCode:null,validation:null})
  }finally{db.close()}
})
