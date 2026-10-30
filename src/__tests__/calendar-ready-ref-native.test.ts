import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { runMigrations, __runMigrationForTests } from '../main/modules/migrations'
import { CalendarStore } from '../main/modules/database/calendar-store'
import type { DatabaseConnection } from '../main/modules/database/connection'
import type { CalEvent } from '../shared/calendar/model'
import { originalToSeconds } from '../main/modules/calendar-engine/calendar-row-codec'
import { trustedCalendarReferenceInput } from '../main/modules/agent-control/codex-runtime/codex-product-surface-ingress'
import { resolveCodexExplicitResources } from '../main/modules/agent-control/codex-runtime/codex-explicit-resources'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const migration = '141_calendar_attachment_ready_refs'
function fixture() {
  const db: DatabaseConnection = new Database(':memory:')
  runMigrations(db)
  const calendar = new CalendarStore(() => db)
  calendar.putCalendar({ id: 'local', accountId: 'local', name: 'Local', color: '#4488CC', visible: true })
  const base = { uid: 'series@test', calendarId: 'local', title: 'Series', timeZone: 'UTC', status: 'confirmed', transparency: 'opaque', createdAt: 1, updatedAt: 1, rrule: 'FREQ=DAILY;COUNT=3' } as const
  const timed: CalEvent = { ...base, id: 'timed', allDay: false, start: Date.parse('2026-10-29T09:00:00Z'), end: Date.parse('2026-10-29T10:00:00Z') }
  calendar.mutate({ type: 'create', event: timed }, {})
  calendar.mutate({ type: 'create', event: { ...base, id: 'day', allDay: true, start: '2026-10-29', end: '2026-10-30' } }, {})
  db.prepare("INSERT INTO chat_conversations(id,agent,title,created_at,updated_at) VALUES ('chat','butler','Test','now','now')").run()
  const add = (id: string, role: string, attachments: unknown[]) => db.prepare('INSERT INTO chat_messages(id,conversation_id,role,content,timestamp,meta_json,message_visibility_epoch) VALUES (?,\'chat\',?,\'unchanged calendar-event://text\',\'now\',?,0)')
    .run(id, role, JSON.stringify({ attachments, receipt: { original: 'calendar-event://unchanged' } }))
  return { db, calendar, timed, add }
}

test('C1 migration restores ordinary, all-day and instance attachments, preserves receipts, and is idempotent', t => {
  if (skipIfSqliteUnavailable(t, 'calendar ReadyRef migration')) return
  const { db, add } = fixture(); t.after(() => db.close())
  const attachment = (id: string, eventId?: string) => ({ id, name: id, path: `calendar-event://${id}`, source: 'calendar-event', eventId, type: 'text' })
  add('user', 'user', [attachment('one', 'timed'), attachment('two', 'timed#1793350800'), attachment('three', 'day#1793318400'), attachment('1793318400000'), attachment('missing', 'gone')])
  add('tool', 'tool', [attachment('receipt', 'timed')])
  const beforeTool = db.prepare("SELECT * FROM chat_messages WHERE id='tool'").get()
  __runMigrationForTests(migration, db)
  const row = db.prepare("SELECT * FROM chat_messages WHERE id='user'").get<{meta_json:string;content:string}>()!
  const meta = JSON.parse(row.meta_json)
  assert.deepEqual(meta.attachments.slice(0, 3).map((a: {path:string}) => a.path), ['ready://calendar/event/timed', 'ready://calendar/event/timed#occurrence=1793350800000', 'ready://calendar/event/day#occurrence=2026-10-30'])
  for (const a of meta.attachments.slice(3)) { assert.equal(a.path, ''); assert.equal(a.eventId, undefined); assert.match(a.description, /无法定位/); assert.ok(a.calendarReferenceMigration.reason) }
  assert.equal(meta.receipt.original, 'calendar-event://unchanged')
  assert.equal(row.content, 'unchanged calendar-event://text')
  assert.deepEqual(db.prepare("SELECT * FROM chat_messages WHERE id='tool'").get(), beforeTool)
  assert.equal(db.prepare("SELECT count(*) n FROM session_recall_attachment_index WHERE source_message_id='user'").get<{n:number}>()!.n, 5)
  assert.equal(db.prepare("SELECT count(*) n FROM session_recall_attachment_index WHERE path LIKE 'calendar-event://%'").get<{n:number}>()!.n, 0)
  assert.equal(db.prepare("SELECT content FROM chat_messages_fts WHERE message_id='user'").get<{content:string}>()!.content, row.content)
  const changes = db.prepare('SELECT total_changes() n').get()
  __runMigrationForTests(migration, db)
  assert.deepEqual(db.prepare('SELECT total_changes() n').get(), changes)
})

test('C1 interrupted migration rolls back and resumes without duplicate attachment keys', t => {
  if (skipIfSqliteUnavailable(t, 'calendar ReadyRef restart')) return
  const { db, add } = fixture(); t.after(() => db.close())
  for (const id of ['a', 'b']) add(id, 'user', [{ id, name: id, path: 'calendar-event://timed', eventId: 'timed', source: 'calendar-event' }])
  const before = db.prepare('SELECT * FROM chat_messages ORDER BY id').all()
  db.exec("CREATE TRIGGER interrupt_migration BEFORE UPDATE ON chat_messages WHEN OLD.id='b' BEGIN SELECT RAISE(ABORT,'interrupted'); END")
  assert.throws(() => __runMigrationForTests(migration, db), /interrupted/)
  assert.deepEqual(db.prepare('SELECT * FROM chat_messages ORDER BY id').all(), before)
  db.exec('DROP TRIGGER interrupt_migration')
  __runMigrationForTests(migration, db)
  assert.equal(db.prepare('SELECT count(*) n FROM session_recall_attachment_index').get<{n:number}>()!.n, 2)
})

test('C1 Main reads the selected exception and all-day occurrence, binds versions per instance, and grants no file authority', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar ReadyRef ingress')) return
  const { db, calendar, timed } = fixture(); t.after(() => db.close())
  const second = Number(timed.start) + 86400000
  calendar.mutate({ type: 'update', key: `timed|${second}`, scope: 'this', patch: { title: 'Second only', location: 'Room 2', start: second + 3600000, end: second + 7200000 } }, { timed: 1 })
  const resolve = (eventId: string) => {
    const event = calendar.getCalendarEventReference(eventId)
    return event ? trustedCalendarReferenceInput(event) : null
  }
  const id = `timed#${originalToSeconds(second)}`
  const result = await resolveCodexExplicitResources({ selections: [{ kind: 'calendar_event', id: 'a', name: 'forged', eventId: id }, { kind: 'calendar_event', id: 'b', name: 'day', eventId: 'day#1793318400' }], resolveSkill: () => null, resolveCalendar: selection => resolve(selection.eventId) })
  assert.match(JSON.stringify(result.input), /Second only/)
  assert.match(JSON.stringify(result.input), /Room 2/)
  assert.match(JSON.stringify(result.input), /2026-10-30T10:00:00.000Z/)
  assert.match(JSON.stringify(result.input), /开始：2026-10-30/)
  assert.match(JSON.stringify(result.input), /结束：2026-10-31/)
  assert.equal(result.authorities.length, 0)
  assert.equal(result.requestResources.every(r => !r.canWrite), true)
  assert.notEqual(resolve(id)!.digest, resolve('timed')!.digest)
  assert.notEqual(resolve('day#1793318400')!.digest, resolve('day#1793404800')!.digest)
  await assert.rejects(() => resolveCodexExplicitResources({ selections: [{ kind: 'calendar_event', id: 'x', name: 'missing', eventId: 'timed#1' }], resolveSkill: () => null, resolveCalendar: selection => resolve(selection.eventId) }), /unavailable/)
})
