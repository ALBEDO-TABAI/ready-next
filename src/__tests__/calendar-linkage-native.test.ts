import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import assert from 'node:assert/strict'
import test from 'node:test'
import { CanvasService } from '../main/modules/board-engine/canvas-service'
import { CalendarStore } from '../main/modules/database/calendar-store'
import { CalendarLinkageService } from '../main/modules/calendar-linkage/service'
import { eventCard, eventView } from '../shared/calendar-linkage'
import { canvasFixture, textNode } from './utils/canvas-fixture'
import { ObjectLinkRepository } from '../main/modules/search-engine/object-links'

const start = Date.parse('2026-10-31T09:00:00Z')
test('M6-D C8/C12 event card persists via handle; schedule and backlink are atomic, retry safe, live and restart readable', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar linkage')) return
  const f = canvasFixture()
  try {
    const calendar = new CalendarStore(() => f.db)
    calendar.putCalendar({ id: 'local', accountId: 'local', name: '日历', color: '#4488CC', visible: true })
    let opened = await f.service.create({ path: 'board.canvas', operationId: 'create', canvas: { ready: { id: 'board', schemaVersion: 1 }, nodes: [textNode('card')], edges: [] } })
    const service = new CalendarLinkageService(f.registry, f.root, calendar)
    const input = { operationId: 'schedule', objectId: 'board', nodeId: 'card', expectedVersion: opened.version, calendarId: 'local', title: '开会', start, end: start + 3600000, timeZone: 'UTC' }
    f.db.exec("CREATE TRIGGER fail_link BEFORE INSERT ON calendar_event_links BEGIN SELECT RAISE(ABORT,'link interrupted'); END")
    assert.throws(() => service.schedule(input), /link interrupted/)
    assert.equal(calendar.snapshot().events.length, 0)
    assert.equal(f.db.prepare('SELECT state FROM calendar_card_schedules').get<{ state: string }>()!.state, 'pending')
    f.db.exec('DROP TRIGGER fail_link')
    const ref = service.schedule(input)
    assert.equal(f.db.prepare('SELECT state FROM calendar_card_schedules').get<{ state: string }>()!.state, 'completed')
    assert.deepEqual(service.schedule(input), ref)
    assert.equal(calendar.snapshot().events.length, 1)
    const target = { kind: 'canvas', id: 'board', node: 'card' } as const
    assert.deepEqual(calendar.snapshot().links![0].target, target)
    assert.equal(new ObjectLinkRepository(f.db).incoming({ ref: target }).length, 1)
    assert.equal(new ObjectLinkRepository(f.db).outgoing({ ref }).length, 1)
    const node = eventCard(ref, { id: 'event-card', x: 5, y: 7 })
    assert.equal((await f.service.write({ objectId: 'board', handleId: opened.handleId, expectedVersion: opened.version, operationId: 'drop', commands: [{ type: 'addNode', node }] })).state, 'completed')
    calendar.mutate({ type: 'update', key: ref.id, patch: { title: '更新', location: '会议室' } }, { [ref.id]: calendar.snapshot().events[0].revision! })
    assert.equal(eventView(calendar.snapshot(), ref)?.title, '更新')
    assert.equal(eventView(calendar.snapshot(), ref)?.location, '会议室')
    const restarted = new CanvasService(f.registry, f.root); await restarted.recover()
    opened = await restarted.open('board')
    assert.deepEqual(opened.canvas.nodes.find(n => n.id === 'event-card')?.ready.ref, ref)
    assert.deepEqual(new CalendarLinkageService(f.registry, f.root, new CalendarStore(() => f.db)).schedule(input), ref)
    assert.throws(() => service.schedule({ ...input, title: '另一条' }), /operation_id_reused/)
    calendar.mutate({ type: 'delete', keys: [ref.id] }, { [ref.id]: calendar.snapshot().events[0].revision! })
    assert.equal(eventView(calendar.snapshot(), ref), null)
    assert.throws(() => service.schedule(input), /已删除/)
    assert.equal(calendar.snapshot().events.length, 0)
  } finally { f.close() }
})

test('M6-D C8/C9 complete day includes dates, tasks, reminders, reading and actual object writes; SQLite reopen preserves it', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar linkage day')) return
  const { default: Database } = await import('better-sqlite3')
  const { mkdtempSync, realpathSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { runMigrations } = await import('../main/modules/migrations')
  const { ObjectRegistry } = await import('../main/modules/object-service/registry')
  const { DocumentPageService } = await import('../main/modules/document-pages/service')
  const { DocumentDatabaseService } = await import('../main/modules/document-database/service')
  const { CalendarLayersService } = await import('../main/modules/calendar-layers/service')
  const { LibrarySessions } = await import('../main/modules/calendar-layers/reading')
  const { DateMentionService } = await import('../main/modules/calendar-engine/date-mentions/service')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ready-linkage-day-'))), dbPath = join(root, 'test.db')
  let db = new Database(dbPath); runMigrations(db)
  try {
    db.prepare('INSERT INTO workspaces(root) VALUES(?)').run(root)
    const date = new Date().toISOString().slice(0, 10), midnight = Date.parse(`${date}T00:00:00Z`)
    const next = new Date(midnight + 86400000).toISOString().slice(0, 10)
    const registry = new ObjectRegistry(db), calendar = new CalendarStore(() => db)
    calendar.putCalendar({ id: 'local', accountId: 'local', name: '日历', color: '#4488CC', visible: true })
    calendar.mutate({ type: 'create', event: { id: 'today', uid: 'today@local', calendarId: 'local', title: '当天事件', allDay: false, start: midnight + 3600000, end: midnight + 7200000, status: 'confirmed', transparency: 'opaque', createdAt: 1, updatedAt: 1 } }, {})
    const body = `---\ndate: ${date}\n---\n# 页面\n- [ ] 任务 [日期](ready://calendar/day/${date})\n[提醒](ready://calendar/day/${date}?at=10:00&remind=0)\n`
    const file = join(root, '页面.md'); writeFileSync(file, body); const page = registry.register(file)
    const mentions = new DateMentionService(db, calendar); mentions.sync(page.id, body, 'UTC')
    const reader = new LibrarySessions(root, registry)
    reader.begin({ id: 'read', objectId: page.id, bookId: 'book', loc: 'c0:0+1', startedAt: midnight + 1000 }); reader.end({ id: 'read', endedAt: midnight + 2000 })
    const canvas = new CanvasService(registry, root)
    const opened = await canvas.create({ path: '今天.canvas', operationId: 'canvas', canvas: { ready: { id: 'board', schemaVersion: 1 }, nodes: [textNode('card')], edges: [] } })
    const linkage = new CalendarLinkageService(registry, root, calendar)
    const scheduled = linkage.schedule({ operationId: 'card-day', objectId: 'board', nodeId: 'card', expectedVersion: opened.version, calendarId: 'local', title: '卡片日程', start: midnight + 3600000, end: midnight + 7200000, timeZone: 'UTC' })
    assert.equal((await canvas.write({ objectId: 'board', handleId: opened.handleId, expectedVersion: opened.version, operationId: 'drop-day', commands: [{ type: 'addNode', node: eventCard(scheduled, { id: 'event-card', x: 10, y: 20 }) }] })).state, 'completed')
    const query = () => {
      const registry = new ObjectRegistry(db), calendar = new CalendarStore(() => db)
      // Read-only projection: any accidental write fails, rather than mocking persistence.
      const writer = { index: async () => { throw new Error('Unexpected write during day query') } }
      const pages = new DocumentPageService(registry, writer), database = new DocumentDatabaseService(root, registry, pages, writer)
      const layers = new CalendarLayersService(root, registry, database, writer, pages)
      return new CalendarLinkageService(registry, root, calendar).day({ date, timeZone: 'UTC' }, layers.query({ from: date, to: next, timeZone: 'UTC' }), new DateMentionService(db, calendar).list())
    }
    const before = query()
    for (const kind of ['events', 'documents', 'tasks', 'reminders', 'footprints', 'activity']) assert.ok(before.items.some(item => item.kind === kind), kind)
    assert.ok(before.items.some(item => item.kind === 'activity' && item.ref.kind === 'canvas' && item.ref.id === 'board'))
    assert.ok(before.items.some(item => item.kind === 'activity' && item.ref.kind === 'page' && item.ref.id === page.id))
    const other = new CalendarLinkageService(registry, root, calendar).day({ date: next, timeZone: 'UTC' }, [], mentions.list())
    assert.equal(other.items.length, 0)
    db.close(); db = new Database(dbPath); runMigrations(db)
    assert.deepEqual(query(), before)
    const restarted = new CanvasService(new ObjectRegistry(db), root); await restarted.recover()
    assert.equal((await restarted.open('board')).canvas.nodes[0].id, 'card')
    assert.deepEqual((await restarted.open('board')).canvas.nodes[1].ready.ref, scheduled)
    assert.equal(new CalendarStore(() => db).snapshot().links!.find(link => link.eventId === scheduled.id)?.target.kind, 'canvas')
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})
