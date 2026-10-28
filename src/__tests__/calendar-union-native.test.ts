import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { migrateCalendarUnion } from '../main/modules/calendar-engine/calendar-schema'
import { CalendarStore } from '../main/modules/database/calendar-store'
import type { CalEvent } from '../shared/calendar/model'
import { rebaseCalendarHistory, type CalendarMutationReceipt } from '../shared/calendar/commands'
import { createProductionProductActionHandlers } from '../main/modules/agent-control/codex-runtime/codex-product-action-handlers'
import { runMigrations } from '../main/modules/migrations'
import { SearchEngine, probeFts5Availability } from '../main/modules/search-engine/indexer'
import { createCalendarWidgetFetcher } from '../renderer/modules/calendar/widget-data-provider'
import { serializeEventToWire } from '../shared/calendar-wire'
import { calendarEventToRecord } from '../main/modules/calendar-engine/calendar-row-codec'

const legacySchema = `CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE calendar_sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,color TEXT DEFAULT '#4CA8DF',type TEXT DEFAULT 'local',sync_url TEXT,sync_interval INTEGER DEFAULT 60,enabled INTEGER DEFAULT 1,created_at INTEGER DEFAULT (unixepoch()));
CREATE TABLE calendar_events(id TEXT PRIMARY KEY,calendar_id TEXT NOT NULL REFERENCES calendar_sources(id) ON DELETE CASCADE,title TEXT NOT NULL,description TEXT,location TEXT,start_time INTEGER NOT NULL,end_time INTEGER NOT NULL,all_day INTEGER DEFAULT 0,recurrence_rule TEXT,reminders TEXT,created_at INTEGER DEFAULT (unixepoch()),updated_at INTEGER DEFAULT (unixepoch()),start_tz TEXT,end_tz TEXT,ics_uid TEXT,source_id TEXT);
CREATE TABLE calendar_event_overrides(id TEXT PRIMARY KEY,parent_event_id TEXT NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,occurrence_start INTEGER NOT NULL,kind TEXT NOT NULL,patch_json TEXT,created_at INTEGER DEFAULT (unixepoch()),updated_at INTEGER DEFAULT (unixepoch()),UNIQUE(parent_event_id,occurrence_start));
INSERT INTO calendar_sources(id,name) VALUES ('local','Local');`
const sample = (id: string): CalEvent => ({ id, uid: `${id}@test`, calendarId: 'local', title: 'Native', start: Date.parse('2026-10-28T09:00:00Z'), end: Date.parse('2026-10-28T10:00:00Z'), allDay: false, timeZone: 'UTC', status: 'confirmed', transparency: 'opaque', createdAt: Date.now(), updatedAt: Date.now() })
function database(t: Parameters<typeof skipIfSqliteUnavailable>[0]) {
  if (skipIfSqliteUnavailable(t, 'Calendar union')) return null
  const db = new Database(':memory:'); db.exec(legacySchema)
  t.after(() => db.close()); return db
}
test('migration preserves IDs and normalizes legacy all-day dates without current-timezone drift', t => {
  const db = database(t); if (!db) return
  const start = Date.parse('2026-10-27T16:00:00Z') / 1000
  db.prepare('INSERT INTO calendar_events(id,calendar_id,title,start_time,end_time,all_day) VALUES (?,?,?,?,?,1)').run('day', 'local', 'Day', start, start + 86340)
  migrateCalendarUnion(db as never); migrateCalendarUnion(db as never)
  const store = new CalendarStore(() => db as never)
  const row = store.snapshot().events.find(e => e.id === 'day')!
  assert.equal(row.start, '2026-10-28'); assert.equal(row.end, '2026-10-29')
  assert.equal(db.prepare('PRAGMA integrity_check').get()['integrity_check'], 'ok')
})
test('fields round trip, stale writes fail, and undo is a confirmed database mutation', t => {
  const db = database(t); if (!db) return
  migrateCalendarUnion(db as never); const store = new CalendarStore(() => db as never)
  const created = store.mutate({ type: 'create', event: { ...sample('a'), conferenceUrl: 'https://example.test/room', attendees: [{ email: 'a@example.test', rsvp: 'tentative' }] } }, {})
  const e = store.snapshot().events[0]
  assert.equal(e.conferenceUrl, 'https://example.test/room'); assert.equal(e.attendees?.length, 1)
  assert.throws(() => store.mutate({ type: 'update', key: 'a', patch: { title: 'Stale' } }, { a: 0 }), /变化|版本/)
  store.restore(created.undo, created.versions)
  assert.equal(store.snapshot().events.length, 0)
})
test('batch validation failure leaves every row untouched', t => {
  const db = database(t); if (!db) return
  migrateCalendarUnion(db as never); const store = new CalendarStore(() => db as never)
  assert.throws(() => store.restore({ put: [sample('a'), { ...sample('b'), calendarId: 'missing' }], remove: [] }, { a: 0, b: 0 }), /日历/)
  assert.equal(store.snapshot().events.length, 0)
  db.exec("CREATE TRIGGER calendar_write_failure BEFORE INSERT ON calendar_events WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT, 'synthetic-disk-write-failure'); END")
  assert.throws(() => store.restore({put:[sample('a'),sample('b')],remove:[]},{a:0,b:0}), /synthetic-disk-write-failure/)
  assert.equal(store.snapshot().events.length,0,'the first SQL write rolls back when the second fails')
})

test('calendar preferences and default calendar use Ready settings timestamps and read back', t => {
  const db=database(t);if(!db)return
  migrateCalendarUnion(db as never);const store=new CalendarStore(()=>db as never)
  store.savePreferences({format24HourTime:true,locale:'zh-CN'})
  store.putCalendar({id:'second',accountId:'local',name:'Second',color:'#4488CC',visible:true,primary:true})
  store.savePreferences({format24HourTime:false})
  const restored=new CalendarStore(()=>db as never).snapshot()
  assert.equal(restored.prefs?.format24HourTime,false)
  assert.equal(restored.prefs?.locale,'zh-CN')
  assert.equal(restored.calendars.find(c=>c.primary)?.id,'second')
  assert.ok(db.prepare('SELECT updated_at FROM settings WHERE key=?').get('calendar_preferences_v1')['updated_at'])
})

test('global search indexes changed recurring instances and opens their exact saved content', async t => {
  if(skipIfSqliteUnavailable(t,'Calendar search'))return
  const db=new Database(':memory:');t.after(()=>db.close());runMigrations(db as never)
  const store=new CalendarStore(()=>db as never)
  store.putCalendar({id:'local',accountId:'local',name:'Local',color:'#4488CC',visible:true})
  const event={...sample('search-series'),title:'Original meeting',rrule:'FREQ=DAILY;COUNT=3'}
  store.mutate({type:'create',event},{})
  const original=Number(event.start)+86400000
  store.mutate({type:'update',key:`${event.id}|${original}`,scope:'this',patch:{title:'Unique changed meeting'}},{[event.id]:1})
  const engine=new SearchEngine(db as never,{fts5Available:probeFts5Availability(db as never)})
  await engine.reindexCalendar()
  const results=await engine.search('Unique changed meeting',{sources:['calendar']})
  const hit=results.items.find(item=>item.path===`calendar://${event.id}#${original/1000}`)
  assert.ok(hit,'the exception must be searchable by its changed title')
  assert.equal(store.getCalendarEventReference(hit.path.slice('calendar://'.length))?.title,'Unique changed meeting')
  store.mutate({type:'delete',keys:[`${event.id}|${original}`],scope:'this'},Object.fromEntries(store.snapshot().events.map(e=>[e.id,e.revision||1])))
  await engine.reindexCalendar()
  assert.equal((await engine.search('Unique changed meeting',{sources:['calendar']})).items.length,0)
})

test('widgets pass display timezone to the stored all-day occurrence query', async t => {
  const db=database(t);if(!db)return
  migrateCalendarUnion(db as never);const store=new CalendarStore(()=>db as never)
  store.mutate({type:'create',event:{...sample('all-day-zone'),allDay:true,start:'2026-10-28',end:'2026-10-29',timeZone:'Asia/Tokyo'}},{})
  const fetcher=createCalendarWidgetFetcher({calendar:{
    async getEvents(start,end,timeZone){
      assert.equal(timeZone,'America/New_York')
      return {success:true,data:store.listOccurrences(start.getTime()/1000,end.getTime()/1000,timeZone).map(o=>serializeEventToWire({...calendarEventToRecord(o.event),start_time:o.start/1000,end_time:o.end/1000}))}
    },
    async getSources(){return {success:true,data:[]}},
  }})
  const options={now:new Date('2026-10-28T16:00:00Z'),tz:'America/New_York'}
  assert.equal((await fetcher.fetchDaySchedule(options)).events.length,1)
  assert.deepEqual((await fetcher.fetchWeekSchedule(options)).days.map(day=>day.count),[0,0,1,0,0,0,0])
})

test('production calendar actions retain new fields and require an exact recurring scope', async t => {
  const db = database(t); if (!db) return
  migrateCalendarUnion(db as never); const store = new CalendarStore(() => db as never)
  let listed: readonly string[] = []
  let revisions: Record<string,number> = {}
  const handler = createProductionProductActionHandlers({ database: { calendar: store } as never, rss: {} as never, pet: {} as never, requestRendererToolAction: async () => ({ok:true}), sessionId:'s',runId:'r',codexThreadId:'t',codexTurnId:'u',codexCallId:'c',readyActionId:'a',actionIdentityDigest:'d',abortSignal:new AbortController().signal,recordListedCalendarEventIds:ids=>{listed=ids},listedCalendarEventIds:()=>listed,recordListedCalendarRevisions:value=>{revisions=value},listedCalendarRevisions:()=>revisions })
  const created = await handler.dispatch('calendar.createEvent', { title:'Meeting',calendarId:'local',startTime:'2026-10-28T09:00:00Z',endTime:'2026-10-28T10:00:00Z',startTz:'UTC',recurrenceRule:'FREQ=DAILY;COUNT=3',conferenceUrl:'https://example.test/room' })
  assert.equal(store.snapshot().events[0].conferenceUrl,'https://example.test/room')
  const result = await handler.dispatch('calendar.listWindow',{start:'2026-10-28',end:'2026-11-02'})
  const events = result.events as Array<{instanceId:string;conferenceUrl:string}>
  assert.equal(events.length,3);assert.equal(events[0].conferenceUrl,'https://example.test/room')
  await assert.rejects(()=>handler.dispatch('calendar.updateEvent',{id:created.eventId,title:'No scope'}),/scope|范围/)
  const single = await handler.dispatch('calendar.updateEvent',{id:events[1].instanceId,title:'Only once',scope:'this'})
  assert.equal(single.eventId,events[1].instanceId)
  assert.equal(single.summary,'事件已更新：Only once')
  assert.equal(store.snapshot().events.filter(e=>e.title==='Only once').length,1)
  assert.equal(store.snapshot().events.find(e=>e.id===created.eventId)?.title,'Meeting')
  await handler.dispatch('calendar.listWindow',{start:'2026-10-28',end:'2026-11-02'})
  const following = await handler.dispatch('calendar.updateEvent',{id:events[1].instanceId,title:'Following',scope:'following'})
  assert.notEqual(following.eventId,created.eventId)
  assert.equal(following.summary,'事件已更新：Following')
  assert.equal(store.getCalendarEventById(String(following.eventId))?.title,'Following')
  assert.equal(store.snapshot().events.find(e=>e.id===created.eventId)?.title,'Meeting')
  await handler.dispatch('calendar.listWindow',{start:'2026-10-28',end:'2026-11-02'})
  const cancelled=await handler.dispatch('calendar.updateEvent',{id:events[0].instanceId,status:'cancelled',scope:'this'})
  assert.equal(cancelled.ok,true)
  assert.equal(cancelled.eventId,events[0].instanceId)
})

test('retiming stored exceptions keeps stable IDs and preserves EXDATE plus replacement', t => {
  const db=database(t);if(!db)return
  migrateCalendarUnion(db as never);const store=new CalendarStore(()=>db as never)
  const start=Number(sample('a').start)
  store.mutate({type:'create',event:{...sample('a'),rrule:'FREQ=DAILY;COUNT=3'}},{})
  let versions=Object.fromEntries(store.snapshot().events.map(e=>[e.id,e.revision||1]))
  store.mutate({type:'update',key:`a|${start+86400000}`,scope:'this',patch:{title:'Exception'}},versions)
  const exception=store.snapshot().events.find(e=>e.recurringEventId==='a')!
  versions=Object.fromEntries(store.snapshot().events.map(e=>[e.id,e.revision||1]))
  store.mutate({type:'update',key:`a|${start}`,scope:'all',patch:{start:start+3600000,end:start+7200000}},versions)
  assert.equal(store.snapshot().events.find(e=>e.id===exception.id)?.originalStart,start+86400000+3600000)
  const raw=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:replaced@test','DTSTART:20261028T090000Z','DTEND:20261028T100000Z','RRULE:FREQ=DAILY;COUNT=2','EXDATE:20261029T090000Z','SUMMARY:Master','END:VEVENT','BEGIN:VEVENT','UID:replaced@test','RECURRENCE-ID:20261029T090000Z','DTSTART:20261030T110000Z','DTEND:20261030T120000Z','SUMMARY:Moved','END:VEVENT','END:VCALENDAR'].join('\r\n')
  const imported=store.importCalendar(raw)
  const records=store.snapshot().events.filter(e=>e.calendarId===imported.sourceId)
  assert.equal(records.length,2);assert.equal(records.find(e=>!e.recurringEventId)?.exdates?.length,1)
  assert.match(store.exportCalendar(imported.sourceId),/EXDATE/)
})


test('successive recurring-instance undo uses saved content while rejecting external edits', t => {
  const db=database(t);if(!db)return
  migrateCalendarUnion(db as never);const store=new CalendarStore(()=>db as never)
  const event={...sample('undo-series'),rrule:'FREQ=DAILY;COUNT=3'}
  store.mutate({type:'create',event},{})
  const versions=()=>Object.fromEntries(store.snapshot().events.map(e=>[e.id,e.revision||1]))
  const edit=(day:number,title:string)=>store.mutate({type:'update',key:`${event.id}|${Number(event.start)+day*86400000}`,scope:'this',patch:{title}},versions())
  const history=(receipt:CalendarMutationReceipt):CalendarMutationReceipt=>({...receipt,snapshot:{...receipt.snapshot,events:receipt.snapshot.events.filter(e=>receipt.changedIds.includes(e.id))},versions:Object.fromEntries(receipt.changedIds.map(id=>[id,receipt.versions[id]||0]))})
  const first=history(edit(0,'First')),second=history(edit(1,'Second'))
  const undoneSecond=store.restore(second.undo,second.versions)
  rebaseCalendarHistory([first],undoneSecond)
  store.restore(first.undo,first.versions)
  assert.deepEqual(store.snapshot().events.map(e=>e.title),['Native'])
  const mine=history(edit(0,'Mine'))
  edit(0,'External')
  assert.throws(()=>store.restore(mine.undo,mine.versions),/版本/)
  assert.ok(store.snapshot().events.some(e=>e.title==='External'))
})

test('file import is repeatable, explicit source updates preserve identity, subscriptions stay read-only', t => {
  const db=database(t);if(!db)return
  migrateCalendarUnion(db as never);const store=new CalendarStore(()=>db as never)
  const raw=['BEGIN:VCALENDAR','VERSION:2.0','BEGIN:VEVENT','UID:stable-import@test','DTSTART:20261028T090000Z','DTEND:20261028T100000Z','SUMMARY:Original','END:VEVENT','END:VCALENDAR'].join('\r\n')
  const first=store.importCalendar(raw),repeated=store.importCalendar(raw)
  assert.equal(first.sourceId,repeated.sourceId)
  assert.equal(store.snapshot().events.length,1)
  const id=store.snapshot().events[0].id
  store.importCalendar(raw.replace('SUMMARY:Original','SUMMARY:Updated'),first.sourceId)
  assert.equal(store.snapshot().events.length,1)
  assert.equal(store.snapshot().events[0].id,id)
  assert.equal(store.snapshot().events[0].title,'Updated')
  store.upsertCalendarSource({id:'subscription',name:'Subscription',syncUrl:'https://example.test/calendar.ics'})
  assert.throws(()=>store.importCalendar(raw,'subscription'),/只读/)
  assert.equal(store.snapshot().events.length,1)
})
