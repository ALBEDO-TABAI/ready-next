import assert from 'node:assert/strict'
import { readCalendarAttachmentDisplayRefs } from '../main/modules/calendar-engine/ready-ref-migration'
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

const migration = '143_calendar_attachment_ready_refs'
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

test('R3b closed history gets digest-bound display refs without changing protected messages, with atomic retry', t => {
  if (skipIfSqliteUnavailable(t, 'closed calendar display references')) return
  const { db, add } = fixture(); t.after(() => db.close())
  add('a', 'user', [{ id: 'second', name: 'Second', path: 'calendar-event://timed%231793350800', source: 'calendar-event' }])
  add('b', 'user', [{ id: 'missing', name: 'Gone', path: 'calendar-event://gone' }])
  add('tool', 'tool', [{ path: 'calendar-event://timed' }])
  db.prepare("UPDATE chat_conversations SET closed_at='closed' WHERE id='chat'").run()
  const before = db.prepare('SELECT * FROM chat_messages ORDER BY id').all()
  // Even a migration may not mutate these original records.
  db.exec("CREATE TRIGGER test_closed_immutable BEFORE UPDATE ON chat_messages BEGIN SELECT RAISE(ABORT,'immutable'); END")
  db.exec("CREATE TRIGGER interrupt_display_refs BEFORE INSERT ON calendar_attachment_display_refs WHEN NEW.message_id='b' BEGIN SELECT RAISE(ABORT,'interrupted'); END")
  assert.throws(() => __runMigrationForTests('144_calendar_attachment_display_refs', db), /interrupted/)
  assert.equal(db.prepare('SELECT count(*) n FROM calendar_attachment_display_refs').get<{n:number}>()!.n, 0)
  db.exec('DROP TRIGGER interrupt_display_refs')
  __runMigrationForTests('144_calendar_attachment_display_refs', db)
  assert.deepEqual(db.prepare('SELECT * FROM chat_messages ORDER BY id').all(), before)
  const refs = readCalendarAttachmentDisplayRefs(db, ['a', 'b', 'tool'])
  assert.deepEqual(refs.map(row => [row.messageId, row.attachmentIndex, row.target]), [
    ['a', 0, { status: 'resolved', ref: { kind: 'event', id: 'timed', occurrence: '1793350800000' } }],
    ['b', 0, { status: 'unlocatable', reason: '真实事件或原始实例不存在' }],
  ])
  const changes = db.prepare('SELECT total_changes() n').get()
  __runMigrationForTests('144_calendar_attachment_display_refs', db)
  assert.deepEqual(db.prepare('SELECT total_changes() n').get(), changes)
  // A stale or corrupted mapping must not attach to a different original value.
  db.prepare("UPDATE calendar_attachment_display_refs SET original_digest='wrong' WHERE message_id='a'").run()
  assert.throws(() => readCalendarAttachmentDisplayRefs(db, ['a']), /摘要/)
})

test('R3c registered display IPC returns verified mappings and reports invalid input or stale originals', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar display IPC')) return
  const { registerHooks } = await import('node:module')
  const { db, calendar, add } = fixture(); t.after(() => db.close())
  add('ipc-message', 'user', [{ path: 'calendar-event://timed%231793350800' }])
  db.prepare("UPDATE chat_conversations SET closed_at='closed' WHERE id='chat'").run()
  __runMigrationForTests('144_calendar_attachment_display_refs', db)
  const electronStub = 'data:text/javascript,' + encodeURIComponent(`
    export const handlers = new Map();
    export const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
    export const BrowserWindow = { getAllWindows: () => [] };
    export const app = {}, dialog = {}, shell = {};
    export const systemPreferences = { getUserDefault: (key, type) => { if(key !== 'AppleICUForce24HourTime' || type !== 'boolean') throw new Error('Unexpected system preference'); return true; } };
  `)
  const databaseStub = 'data:text/javascript,' + encodeURIComponent(`
    let db, calendar; export const setDb = (value, store) => { db = value; calendar = store };
    export const getDatabase = () => ({ getRawDb: () => db, calendar });
  `)
  const hook = registerHooks({ resolve(specifier, context, next) {
    const url = specifier === 'electron' ? electronStub
      : specifier === '../database' && context.parentURL?.includes('/calendar-engine/') ? databaseStub : null
    return url ? { url, shortCircuit: true } : next(specifier, context)
  } })
  t.after(() => hook.deregister())
  const stub = await import(databaseStub); stub.setDb(db, calendar)
  const { setupCalendarWorkbenchIPC } = await import('../main/modules/calendar-engine/workbench-ipc')
  setupCalendarWorkbenchIPC()
  const { handlers } = await import(electronStub)
  await t.test('system time default survives edits, undo and unrelated preferences without being saved', async () => {
    const system24 = process.platform === 'darwin' || ['h23', 'h24'].includes(new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle!)
    const snapshot = await handlers.get('calendar:snapshot')({})
    assert.equal(snapshot.data.prefs.format24HourTime, system24)
    const changed = await handlers.get('calendar:mutate')({}, { type: 'update', key: 'timed', scope: 'all', patch: { title: 'Changed' } }, { timed: calendar.snapshot().events.find(e => e.id === 'timed')!.revision })
    assert.equal(changed.success, true); assert.equal(changed.data.snapshot.prefs.format24HourTime, system24)
    const restored = await handlers.get('calendar:restore')({}, changed.data.undo, changed.data.versions)
    assert.equal(restored.success, true); assert.equal(restored.data.snapshot.prefs.format24HourTime, system24)
    const unrelated = await handlers.get('calendar:putPreferences')({}, { showWeekends: false })
    assert.equal(unrelated.data.prefs.format24HourTime, system24)
    assert.equal(calendar.snapshot().prefs?.format24HourTime, undefined)
    for (const chosen of [false, true]) {
      const saved = await handlers.get('calendar:putPreferences')({}, { format24HourTime: chosen })
      assert.equal(saved.data.prefs.format24HourTime, chosen)
      assert.equal(new CalendarStore(() => db).snapshot().prefs?.format24HourTime, chosen)
    }
  })
  const invoke = handlers.get('calendar:getAttachmentDisplayRefs')
  assert.equal(typeof invoke, 'function')
  assert.deepEqual(await invoke({}, ['ipc-message', 'ipc-message', 'missing']), {
    success: true, mock: false, data: [{ messageId: 'ipc-message', attachmentIndex: 0,
      target: { status: 'resolved', ref: { kind: 'event', id: 'timed', occurrence: '1793350800000' } } }],
  })
  for (const input of [null, 'ipc-message', [42], [''], [' a ']]) {
    const result = await invoke({}, input)
    assert.equal(result.success, false); assert.match(result.error, /消息/)
  }
  db.prepare("UPDATE calendar_attachment_display_refs SET original_digest='wrong'").run()
  const stale = await invoke({}, ['ipc-message'])
  assert.equal(stale.success, false); assert.match(stale.error, /摘要/)
})

export const __breaksInvariants = ['isolated-ipc-registration-replaces-electron-and-database-singletons'] as const

test('R3c smoke fixture persists real history and creates closed mappings on the next database boot', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar saved history restart')) return
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { ChatStore } = await import('../main/modules/database/chat-store')
  const script = new URL('../../scripts/verify-ready-next-smoke-electron.cjs', import.meta.url).href
  const { seedCalendarHistory } = await import(script)
  const root = mkdtempSync(join(tmpdir(), 'ready-next-smoke-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { db } = fixture()
  db.exec(`VACUUM INTO '${join(root, 'ready.db').replaceAll("'", "''")}'`)
  db.close()
  const history = await seedCalendarHistory(root, { title: 'Second', seriesId: 'timed', second: 1793350800000, eventId: 'timed#1793350800' })
  const reopened = new Database(join(root, 'ready.db')); t.after(() => reopened.close())
  const original = reopened.prepare('SELECT * FROM chat_messages WHERE id=?').get(history.closedMessageId)
  runMigrations(reopened)
  const chat = new ChatStore(() => reopened)
  const message = chat.getChatMessages(history.scopeId).find(row => row.id === history.messageId)!
  assert.equal(JSON.parse(message.meta_json!).attachments[0].path, 'ready://calendar/event/timed#occurrence=1793350800000')
  assert.deepEqual(chat.getChatMessages(history.closedId), [], 'a closed scope is deliberately unavailable to the history UI')
  assert.deepEqual(reopened.prepare('SELECT * FROM chat_messages WHERE id=?').get(history.closedMessageId), original)
  const refs = readCalendarAttachmentDisplayRefs(reopened, [history.closedMessageId])
  assert.deepEqual(refs.map(row => row.target), [
    { status: 'resolved', ref: { kind: 'event', id: 'timed', occurrence: '1793350800000' } },
    { status: 'unlocatable', reason: '真实事件或原始实例不存在' },
  ])
})
