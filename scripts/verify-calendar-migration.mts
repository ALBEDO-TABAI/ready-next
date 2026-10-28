import { mkdirSync, copyFileSync, chmodSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { migrateCalendarUnion } from '../src/main/modules/calendar-engine/calendar-schema'
import { CalendarStore } from '../src/main/modules/database/calendar-store'

const checkpoint=resolve(process.argv[2]||'')
assert.ok(process.argv[2],'Pass the verified private checkpoint directory')
const source=join(checkpoint,'ready.before.sqlite'),directory=join(checkpoint,`calendar-migration-proof-${Date.now()}`)
mkdirSync(directory,{mode:0o700});const file=join(directory,'ready.sqlite');copyFileSync(source,file);chmodSync(file,0o600)
const db=new Database(file)
try{
  const old=db.prepare('SELECT * FROM calendar_events ORDER BY id').all() as any[]
  const exceptions=db.prepare('SELECT * FROM calendar_event_overrides ORDER BY id').all() as any[]
  const tables=(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[]).map(t=>t.name)
  const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"'
  const counts=Object.fromEntries(tables.map(name=>[name,(db.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get() as any).n]))
  for(const name of tables.filter(n=>n!=='calendar_event_overrides'))assert.ok(!(db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all() as any[]).some(f=>f.table==='calendar_events'),`Unexpected dependent table ${name}`)
  const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const settingsHash=digest(db.prepare('SELECT * FROM settings ORDER BY key').all())
  migrateCalendarUnion(db as never)
  const store=new CalendarStore(()=>db as never),snapshot=store.snapshot()
  assert.equal(snapshot.events.filter(e=>!e.recurringEventId).length,old.length)
  for(const previous of old){
    const current=snapshot.events.find(e=>e.id===previous.id)!
    assert.ok(current)
    for(const [sourceKey,targetKey]of [['calendar_id','calendarId'],['title','title'],['description','description'],['location','location']] as const)assert.equal(current[targetKey]??null,previous[sourceKey]??null)
    assert.equal(current.createdAt,previous.created_at*1000);assert.equal(current.updatedAt,previous.updated_at*1000)
    if(!previous.all_day){assert.equal(current.start,previous.start_time*1000);assert.equal(current.end,previous.end_time*1000)}
    else{
      // This checkpoint's documented all-day rows were authored at UTC+8 midnight.
      // Verify that observation before independently deriving the expected dates.
      assert.equal(previous.start_time%86400,16*3600)
      const day=(seconds:number)=>new Date(seconds*1000).toISOString().slice(0,10)
      const end=previous.end_time+8*3600
      assert.equal(current.start,day(previous.start_time+8*3600))
      assert.equal(current.end,day(end+(end%86400===0?0:86400)))
    }
  }
  assert.equal((db.prepare('SELECT count(*) AS n FROM calendar_event_overrides').get() as any).n,exceptions.length)
  for(const name of tables.filter(n=>!n.startsWith('calendar_')))assert.equal((db.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get() as any).n,counts[name],name)
  assert.equal(digest(db.prepare('SELECT * FROM settings ORDER BY key').all()),settingsHash)
  const beforeAgain=digest(snapshot);migrateCalendarUnion(db as never);assert.equal(digest(store.snapshot()),beforeAgain)
  assert.equal((db.prepare('PRAGMA integrity_check').get() as any).integrity_check,'ok')
  const foreignKeys=db.prepare('PRAGMA foreign_key_check').all() as any[]
  assert.ok(!foreignKeys.some(r=>r.table.startsWith('calendar_')))
  const result={sourceSha256:createHash('sha256').update(readFileSync(source)).digest('hex'),events:old.length,allDay:old.filter(e=>e.all_day).length,sources:snapshot.calendars.length,exceptions:exceptions.length,contentAndIdsPreserved:true,unrelatedTablesAndSettingsUnchanged:true,idempotent:true,integrity:'ok',calendarForeignKeyErrors:0,privateRestorationCopy:directory}
  writeFileSync(join(directory,'result.json'),JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result))
}finally{db.close()}
