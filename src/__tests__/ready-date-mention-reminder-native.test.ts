import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations } from '../main/modules/migrations'
import { CalendarStore } from '../main/modules/database/calendar-store'
import { DateMentionService } from '../main/modules/calendar-engine/date-mentions/service'
import { parseDateMentions } from '../shared/calendar/date-mentions'
import { startReminderScheduler } from '../main/modules/calendar-engine/reminder-scheduler'
import { recoverMissedRemindersSync } from '../main/modules/calendar-engine/reminder-cold-start'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const link = '[交稿](ready://calendar/day/2026-11-03?at=15:00&remind=10)'
const now = Date.parse('2026-11-03T15:00:00Z') / 1000

test('C9 parses only real body links, validates dates and retains distinct source ranges', t => {
  if (skipIfSqliteUnavailable(t, 'date mention native contract')) return
  const source = `---\ndate: '${link}'\n---\n\n${link}\n\n${link}\n\n\`${link}\`\n\n\`\`\`md\n${link}\n\`\`\`\n[坏日期](ready://calendar/day/2026-02-30?remind=0)`
  const mentions = parseDateMentions('doc', source)
  assert.equal(mentions.length, 2)
  assert.notEqual(mentions[0].start, mentions[1].start)
  assert.equal(mentions[0].ref.at, '15:00'); assert.equal(mentions[0].ref.remind, 10)
  for (const mention of mentions) assert.equal(source.slice(mention.start, mention.end), link)
})

test('C9 durable identity, updates, cancelled late callbacks, cold start and restart use one ledger', async t => {
  if (skipIfSqliteUnavailable(t, 'date mention reminders')) return
  const root = mkdtempSync(join(tmpdir(), 'ready-date-mention-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'test.db')
  let db = new Database(file); runMigrations(db)
  t.after(() => db.close())
  let calendar = new CalendarStore(() => db)
  let service = new DateMentionService(db, calendar)
  const sync = (content: string) => service.sync('doc', content, 'UTC')
  sync(link + '\n\n' + link)
  const first = service.list()
  assert.equal(first.length, 2); assert.notEqual(first[0].id, first[1].id)
  sync('前言\n\n' + link + '\n\n' + link)
  assert.deepEqual(service.list().map(row => row.id), first.map(row => row.id))
  const callbacks: Array<() => void> = [], fired: string[] = []
  let clock = now - 1200
  const fire = (payload: Parameters<DateMentionService['claim']>[0]) => { if (service.claim(payload)) fired.push(payload.eventId) }
  const scheduler = startReminderScheduler({ getDb: () => calendar, mentions: service, now: () => clock, fire,
    scheduleAt: (_at, callback) => { callbacks.push(callback); return { cancel() {} } }, setIntervalShim: () => ({ cancel() {} }) })
  t.after(() => scheduler.stop())
  await scheduler.rescheduleAll()
  assert.equal(callbacks.length, 2)
  sync('前言\n\n' + link.replace('15:00', '16:00'))
  clock = now
  callbacks.forEach(callback => callback())
  assert.deepEqual(fired, [], 'superseded and removed callbacks cannot deliver')
  sync(link)
  recoverMissedRemindersSync({ getDb: () => calendar, mentions: service, now: () => now + 86400, fire })
  recoverMissedRemindersSync({ getDb: () => calendar, mentions: service, now: () => now + 86400, fire })
  assert.equal(fired.length, 1)
  assert.equal(db.prepare('SELECT count(*) n FROM calendar_reminder_deliveries').get<{ n: number }>()!.n, 1)
  assert.equal(service.list()[0].deliveredAt, now + 86400)
  db.close(); db = new Database(file); calendar = new CalendarStore(() => db); service = new DateMentionService(db, calendar)
  sync(link)
  recoverMissedRemindersSync({ getDb: () => calendar, mentions: service, now: () => now + 172800, fire })
  assert.equal(fired.length, 1); assert.equal(service.list()[0].deliveredAt, now + 86400)
  sync('删除提及'); assert.deepEqual(service.list(), [])
  assert.equal(db.prepare('SELECT count(*) n FROM calendar_reminder_deliveries').get<{ n: number }>()!.n, 1)
})

test('C9 timezone is frozen and DST conversion follows the calendar', t => {
  if (skipIfSqliteUnavailable(t, 'date mention timezone')) return
  const db = new Database(':memory:'); runMigrations(db); t.after(() => db.close())
  const service = new DateMentionService(db, new CalendarStore(() => db))
  service.sync('spring', '[日](ready://calendar/day/2026-03-08?at=02:30&remind=0)', 'America/New_York')
  service.sync('fall', '[日](ready://calendar/day/2026-11-01?at=01:30&remind=0)', 'America/New_York')
  const rows = service.list()
  assert.equal(rows.find(row => row.objectId === 'spring')!.startTime, Date.parse('2026-03-08T07:30:00Z') / 1000)
  assert.equal(rows.find(row => row.objectId === 'fall')!.startTime, Date.parse('2026-11-01T05:30:00Z') / 1000)
  service.sync('fall', '[日](ready://calendar/day/2026-11-01?at=01:30&remind=0)', 'Asia/Tokyo')
  assert.equal(service.list().find(row => row.objectId === 'fall')!.timeZone, 'America/New_York')
})

test('C3/C9 saved bytes, external changes and index rebuild synchronize the same document identity', async t => {
  if (skipIfSqliteUnavailable(t, 'date mention document synchronization')) return
  const { writeFileSync } = await import('node:fs')
  const { ObjectRegistry } = await import('../main/modules/object-service/registry')
  const { ObjectEventWindow } = await import('../main/modules/object-service/event-window')
  const { DateMentionDocuments } = await import('../main/modules/calendar-engine/date-mentions/documents')
  const { commitDocumentOperation } = await import('../main/modules/document-engine/document-write-service')
  const { SearchEngine } = await import('../main/modules/search-engine/indexer')
  const root = mkdtempSync(join(tmpdir(), 'ready-date-source-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'note.md'); writeFileSync(path, '原文')
  const db = new Database(':memory:'); runMigrations(db); t.after(() => db.close())
  const registry = new ObjectRegistry(db), object = registry.register(path)
  const engine = new SearchEngine(db, { fts5Available: true }); t.after(() => engine.cancelPendingWorkspaceResolves())
  await engine.indexDocument(root, path)
  const service = new DateMentionService(db, new CalendarStore(() => db)), documents = new DateMentionDocuments(registry, service, () => 'UTC')
  await commitDocumentOperation({ path, operation: { type: 'replaceRange', start: 0, end: 2, expectedText: '原文', replacement: link }, origin: 'date-mention-test' }, {
    index: async (path, content) => { const result = await engine.indexDocument(root, path, content); assert.equal(result.ok, true); documents.changed([path]) },
  })
  const id = service.list()[0].id; assert.equal(service.list()[0].objectId, object.id)
  const events = new ObjectEventWindow(registry, async paths => {
    for (const path of paths) { const result = await engine.indexDocument(root, path); assert.equal(result.ok, true) }
    documents.changed(paths)
  })
  writeFileSync(path, '前言\n\n' + link.replace('15:00', '16:00'))
  const pending = events.add(path); await events.drain(); await pending
  assert.equal(service.list()[0].id, id)
  assert.equal(service.list()[0].startTime, now + 3600)
  documents.rebuild(); assert.equal(service.list()[0].id, id)
  const old = service.pending(now + 86400, now + 86400)[0]
  writeFileSync(path, '已删除')
  assert.equal(documents.claim(old), false, 'fire-time disk check revokes before the watcher batch runs')
  assert.deepEqual(service.list(), [])
})

test('C9 ledger-first crash gap keeps a visible reminder without a second popup attempt', async t => {
  if (skipIfSqliteUnavailable(t, 'date mention crash gap')) return
  const { createReminderNotifier } = await import('../main/modules/calendar-engine/reminder-notifier')
  const db = new Database(':memory:'); runMigrations(db); t.after(() => db.close())
  const calendar = new CalendarStore(() => db)
  let service = new DateMentionService(db, calendar), popups = 0
  const notifier = createReminderNotifier({ getMainWindow: () => null, now: () => now,
    notificationCtor: class { show() { popups++ } on() {} },
  })
  service.sync('doc', link, 'UTC')
  const payload = service.pending(now, now)[0]
  assert.equal(service.claim(payload), true)
  // Exit between the successful claim and calling the OS: do not call notifier.
  service = new DateMentionService(db, calendar)
  assert.equal(service.list()[0].deliveredAt, now)
  assert.equal(service.claim(payload), false)
  assert.equal(popups, 0)
  service.sync('second', link, 'UTC')
  const second = service.pending(now, now)[0]
  for (let i = 0; i < 3; i++) if (service.claim(second)) notifier.fire(second)
  assert.equal(popups, 1)
})

test('C9 ambiguous identical-link relocation fails explicitly instead of re-arming delivered reminders', t => {
  if (skipIfSqliteUnavailable(t, 'date mention ambiguous ranges')) return
  const db = new Database(':memory:'); runMigrations(db); t.after(() => db.close())
  const service = new DateMentionService(db, new CalendarStore(() => db))
  service.sync('doc', '甲' + link + '\n\n乙' + link + '丙', 'UTC')
  for (const payload of service.pending(now, now)) assert.equal(service.claim(payload), true)
  assert.throws(() => service.sync('doc', '改前' + link + '\n\n改后' + link + '尾', 'UTC'), /无法唯一迁移/)
  assert.equal(service.list().length, 2)
  assert.equal(service.pending(now, now).length, 0)
})

test('C9 production index entry covers writer, watcher, rebuild, vault isolation and notification reference', async t => {
  if (skipIfSqliteUnavailable(t, 'date mention production wiring')) return
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { ObjectRegistry } = await import('../main/modules/object-service/registry')
  const { SearchEngine } = await import('../main/modules/search-engine/indexer')
  const { ObjectEventWindow } = await import('../main/modules/object-service/event-window')
  const { commitDocumentOperation } = await import('../main/modules/document-engine/document-write-service')
  const { DateMentionController, withDateMentionIndex } = await import('../main/modules/calendar-engine/date-mentions/controller')
  const { configureDateMentionIndex } = await import('../main/modules/calendar-engine/date-mentions/index-events')
  const { publishDocumentIndexChanged } = await import('../main/modules/search-engine/ipc/document-index-events')
  const root = mkdtempSync(join(tmpdir(), 'ready-mention-wiring-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const a = join(root, 'a'), b = join(root, 'b'); mkdirSync(a); mkdirSync(b)
  let active = a
  const path = join(a, 'note.md'); writeFileSync(path, '原文')
  const db = new Database(':memory:'); runMigrations(db); t.after(() => db.close())
  const registry = new ObjectRegistry(db), object = registry.register(path)
  const engine = new SearchEngine(db, { fts5Available: true }); t.after(() => engine.cancelPendingWorkspaceResolves())
  await engine.indexDocument(a, path)
  const service = new DateMentionService(db, new CalendarStore(() => db))
  const controller = new DateMentionController(registry, service, () => active, () => 'UTC')
  configureDateMentionIndex(event => controller.indexed(event)); t.after(() => configureDateMentionIndex(null))
  const sender = { isDestroyed: () => false, send() {} }
  const writer = withDateMentionIndex({ index: async (path, content) => {
    const result = await engine.indexDocument(a, path, content); assert.equal(result.ok, true)
  } }, () => active, event => publishDocumentIndexChanged(sender, event))
  await commitDocumentOperation({ path, operation: { type: 'replaceRange', start: 0, end: 2, expectedText: '原文', replacement: link }, origin: 'test' }, writer)
  await controller.settled()
  const first = controller.list()[0]; assert.equal(first.objectId, object.id)
  const events = new ObjectEventWindow(registry, async (paths, removed) => {
    for (const path of paths) assert.equal((await engine.indexDocument(a, path)).ok, true)
    publishDocumentIndexChanged(sender, { workspaceRoot: a, reason: 'incremental', changedPaths: [...paths, ...removed] })
  })
  writeFileSync(path, '前言\n\n' + link.replace('15:00', '16:00'))
  const pending = events.add(path); await events.drain(); await pending; await controller.settled()
  assert.equal(controller.list()[0].id, first.id)
  assert.equal(controller.list()[0].startTime, now + 3600)
  publishDocumentIndexChanged(sender, { workspaceRoot: a, reason: 'rebuild', changedPaths: [] })
  await controller.settled()
  assert.equal(controller.list()[0].id, first.id)
  const payload = controller.pending(now + 7200, now + 7200)[0]
  const ref = controller.reference(payload.eventId)
  const target = controller.locate(ref)
  assert.equal(target.path, object.current_path); assert.equal(target.content.slice(target.start, target.end), link.replace('15:00', '16:00'))
  active = b
  publishDocumentIndexChanged(sender, { workspaceRoot: a, reason: 'rebuild', changedPaths: [] })
  await controller.settled()
  assert.deepEqual(controller.list(), []); assert.equal(controller.claim(payload), false)
  assert.throws(() => controller.locate(ref), /资料库/)
  assert.equal(service.list()[0].id, first.id, 'switching preserves the other vault ledger')
  active = a
  const { createDateMentionNotifier } = await import('../main/modules/calendar-engine/date-mentions/notifier')
  let click = () => {}, shown = 0
  const opened: import('../shared/ready-ref').ReadyRef[] = []
  const fire = createDateMentionNotifier({ controller, changed() {}, preferences: () => ({}),
    notification: () => class { show() { shown++ } on(_event: 'click', listener: () => void) { click = listener } },
    open: ref => { opened.push(ref) },
  })
  fire(payload); fire(payload); assert.equal(shown, 1)
  writeFileSync(path, '再加前言\n\n前言\n\n' + link.replace('15:00', '16:00'))
  click(); assert.deepEqual(opened, [ref]); assert.equal(controller.locate(opened[0]).start, '再加前言\n\n前言\n\n'.length)
  const rollbackText = (await import('node:fs')).readFileSync(path, 'utf8')
  await assert.rejects(commitDocumentOperation({ path, origin: 'test', operation: { type: 'replaceRange', start: 0,
    end: rollbackText.length, expectedText: rollbackText, replacement: link.replace('交稿', '不得送达') } }, writer,
    { indexed: async () => { throw new Error('receipt rejected') } }), /receipt rejected/)
  await controller.settled()
  assert.equal(controller.list()[0].title, '交稿', 'failed saves never publish their intermediate reminder')
  writeFileSync(path, '已删除')
  const removed = events.add(path); await events.drain(); await removed; await controller.settled()
  assert.deepEqual(controller.list(), []); assert.throws(() => controller.locate(ref), /不存在/)
})
