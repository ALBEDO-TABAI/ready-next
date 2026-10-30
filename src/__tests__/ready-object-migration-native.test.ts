import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { __getMigrationNamesForTests, __runMigrationForTests, runMigrations } from '../main/modules/migrations'

test('C2 migrates UUIDs and dependent records once without retaining the old identity writer', () => {
  const db = new Database(':memory:')
  try {
    db.pragma('foreign_keys = OFF')
    for (const name of __getMigrationNamesForTests().filter(name => Number(name.slice(0, 3)) <= 135)) __runMigrationForTests(name, db)
    db.exec(`INSERT INTO file_identities VALUES ('stable-id','/fixture','/fixture/a.md','present',NULL,10,20);
      INSERT INTO file_activity_events VALUES ('event','/fixture/a.md','/fixture','open','document_mode',1,NULL,15);
      INSERT INTO file_tag_assignments(file_key,tag_id,facet,label,source,ownership,updated_at) VALUES ('stable-id','tag','form','note','user','manual',20);
      INSERT INTO project_identities VALUES ('project','/fixture','Project','user',1,'active',NULL,'[]','[]',10,20);
      INSERT INTO project_identity_members VALUES ('project','stable-id','user',1,10,20);
      INSERT INTO file_move_receipts VALUES ('move','stable-id','/fixture','/fixture/old.md','/fixture/a.md','file',12);
      INSERT INTO document_marks(id,kind,document_path,excerpt,sort_order,created_at,updated_at) VALUES ('mark','bookmark','/fixture/a.md','keep quote',42,'2026-10-30','2026-10-30');
      INSERT INTO document_reading_sessions(id,path,workspace_root,source,started_at,ended_at,active_ms,progress_end) VALUES ('reading','/fixture/old.md','/fixture','document_mode',10,11,60000,0.7);
      INSERT INTO file_attention_rollups(file_key,observed_since,history_coverage_start,history_coverage_end,updated_at) VALUES ('stable-id',10,10,20,20);
      INSERT INTO artifact_creation_receipts(receipt_id,source_run_id,file_key,created_in_this_run,created_at,enrichment_status,updated_at) VALUES ('receipt','run','stable-id',1,10,'pending',20);
      INSERT INTO file_emergence_prediction_snapshots(snapshot_id,project_key,bucket,reason_codes_json,generated_at,file_keys_json) VALUES ('snapshot','project','today','[]',20,'["stable-id"]');
      CREATE TABLE migrations (id INTEGER PRIMARY KEY,name TEXT UNIQUE,applied_at TEXT);`)
    const insert = db.prepare('INSERT INTO migrations(name,applied_at) VALUES (?,?)')
    for (const name of __getMigrationNamesForTests().filter(name => Number(name.slice(0, 3)) <= 135)) insert.run(name, 'fixture')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    assert.equal(db.prepare('SELECT id FROM objects').get<{ id: string }>()?.id, 'stable-id')
    assert.equal(db.prepare('SELECT object_id FROM file_activity_events').get<{ object_id: string }>()?.object_id, 'stable-id')
    assert.deepEqual(db.prepare('SELECT ownership,readback_at FROM file_tag_assignments').get(), { ownership: 'manual', readback_at: null })
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='file_identities'").get<{n:number}>()?.n, 0)
    for(const table of ['file_move_receipts','document_marks','document_reading_sessions','file_attention_rollups','artifact_creation_receipts','project_identity_members'])assert.equal(db.prepare(`SELECT object_id FROM ${table}`).get<{object_id:string}>()?.object_id,'stable-id')
    assert.deepEqual(db.prepare('SELECT excerpt,sort_order FROM document_marks').get(),{excerpt:'keep quote',sort_order:42})
    assert.deepEqual(db.prepare('SELECT path_at_event,progress_end FROM document_reading_sessions').get(),{path_at_event:'/fixture/old.md',progress_end:0.7})
    assert.equal(db.prepare('SELECT file_keys_json FROM file_emergence_prediction_snapshots').get<{file_keys_json:string}>()?.file_keys_json,'["stable-id"]')
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    const before = db.prepare('SELECT total_changes() AS n').get()
    runMigrations(db)
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before)
  } finally { db.close() }
})
