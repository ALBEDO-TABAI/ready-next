import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { CalendarLayersService } from '../main/modules/calendar-layers/service'
import { createCalendarLayersResolver } from '../main/modules/calendar-layers/runtime'
import { registerCalendarLayersIPC } from '../main/modules/calendar-layers/ipc'
import { LibrarySessions } from '../main/modules/calendar-layers/reading'
import { createDocumentOperationSync } from '../renderer/modules/document/documentOperationSync'
import { parseTodos, type LayerReply, type TodoEntry, type TodoWriteReceipt } from '../shared/calendar-layers'
import { todoFixture } from './utils/calendar-todos-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const range = { from: '2026-11-01', to: '2026-12-01', timeZone: 'Asia/Tokyo' }
test('todo toggle changes only the checkbox bytes, unchecks and rejects stale versions without changing disk', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar todos')) return
  const f = todoFixture(); t.after(() => f.close())
  const original = '\uFEFF---\r\ntitle: 页面😀\r\n---\r\n# 分组\r\n- [ ] 待办😀\r\n- [x] 完成\r\n'
  const object = f.add('page.md', original), todo = f.service.listTodos()[0]
  assert.deepEqual(todo.page, { objectId: object.id, title: '页面😀', ref: { kind: 'page', id: object.id } })
  assert.equal(todo.heading, '分组'); assert.equal(todo.date, null)
  const marker = parseTodos(original)[0].checkbox, expected = Buffer.from(original)
  expected.write('[x]', marker.byteStart, 'utf8')
  assert.deepEqual(await f.service.toggleTodo({ id: todo.id, expectedVersion: todo.version, checked: true }), { state: 'saved' })
  assert.deepEqual(readFileSync(object.current_path!), expected)
  assert.equal(f.service.listTodos().length, 0)
  await assert.rejects(f.service.toggleTodo({ id: todo.id, expectedVersion: todo.version, checked: false }), { code: 'version_conflict' })
  assert.deepEqual(readFileSync(object.current_path!), expected)
  await f.service.toggleTodo({ id: todo.id, expectedVersion: f.registry.get(object.id)!.content_hash!, checked: false })
  assert.deepEqual(readFileSync(object.current_path!), Buffer.from(original))
  assert.equal(f.service.listTodos().length, 1)
})

test('todo scheduling appends on first line, reads back in both queries, then uses existing move semantics', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar todo schedule')) return
  const f = todoFixture(); t.after(() => f.close())
  const original = '# 页面\r\n- [ ] 第一项😀\r\n  第二行\r\n- [ ] 后一项'
  const object = f.add('page.md', original), todo = f.service.listTodos()[0]
  assert.deepEqual(await f.service.scheduleTodo({ id: todo.id, expectedVersion: todo.version, date: '2026-11-12' }), { state: 'saved' })
  const expected = original.replace('第一项😀', '第一项😀 [2026-11-12](ready://calendar/day/2026-11-12)')
  assert.deepEqual(readFileSync(object.current_path!), Buffer.from(expected))
  const entry = f.service.query(range).find(e => e.id === todo.id)!
  assert.equal(entry.date, '2026-11-12'); assert.equal(f.service.listTodos()[0].dateSource, 'ready')
  await assert.rejects(f.service.scheduleTodo({ id: todo.id, expectedVersion: todo.version, date: '2026-11-13' }), { code: 'version_conflict' })
  assert.deepEqual(readFileSync(object.current_path!), Buffer.from(expected))
  await f.service.move({ range, id: entry.id, expectedVersion: entry.version!, date: '2026-11-13' })
  // The label Ready wrote is the date itself: it moves with the date instead of showing the old one.
  assert.equal(readFileSync(object.current_path!, 'utf8'), expected.replace('[2026-11-12](ready://calendar/day/2026-11-12)', '[2026-11-13](ready://calendar/day/2026-11-13)'))
  assert.equal(f.service.listTodos()[0].date, '2026-11-13')
  // A disk change before its index event must still invalidate the cached source and reject the old write.
  const current = f.service.listTodos()[0]
  writeFileSync(object.current_path!, '- [ ] externally replaced\n')
  await assert.rejects(f.service.toggleTodo({ id: current.id, expectedVersion: current.version, checked: true }), { code: 'version_conflict' })
  assert.equal(readFileSync(object.current_path!, 'utf8'), '- [ ] externally replaced\n')
})

test('rescheduling keeps a custom link label and rewrites only the date in the address', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar todo custom label')) return
  const f = todoFixture(); t.after(() => f.close())
  const original = '- [ ] 写周报 [明天](ready://calendar/day/2026-11-12)\n'
  const object = f.add('page.md', original), todo = f.service.listTodos()[0]
  assert.equal(todo.date, '2026-11-12')
  assert.deepEqual(await f.service.scheduleTodo({ id: todo.id, expectedVersion: todo.version, date: '2026-11-14' }), { state: 'saved' })
  assert.equal(readFileSync(object.current_path!, 'utf8'), '- [ ] 写周报 [明天](ready://calendar/day/2026-11-14)\n')
})

test('Obsidian dates are read-only until explicit consent, then only the date token is rewritten', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar Obsidian dates')) return
  const f = todoFixture(); t.after(() => f.close())
  const original = '- [ ] 提交 📅 2026-11-11 #工作\n', object = f.add('tasks.md', original)
  const todo = f.service.listTodos()[0]
  assert.equal(todo.dateSource, 'obsidian'); assert.equal(todo.date, '2026-11-11')
  assert.equal(f.service.query(range)[0].readOnlyReason, 'obsidian_date_needs_consent')
  await assert.rejects(f.service.scheduleTodo({ id: todo.id, expectedVersion: todo.version, date: '2026-11-12' }), { code: 'obsidian_date_needs_consent' })
  assert.equal(readFileSync(object.current_path!, 'utf8'), original)
  await f.service.scheduleTodo({ id: todo.id, expectedVersion: todo.version, date: '2026-11-12', rewriteObsidianDate: true })
  assert.equal(readFileSync(object.current_path!, 'utf8'), original.replace('📅 2026-11-11', '[2026-11-12](ready://calendar/day/2026-11-12)'))
  assert.equal(f.service.listTodos()[0].dateSource, 'ready')
})

test('todo writes merge dirty buffers without saving; changed target text or shifted markers conflict', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar dirty todos')) return
  const f = todoFixture(); t.after(() => f.close())
  const original = '- [ ] aaa\n- [ ] bbb\n', object = f.add('dirty.md', original)
  let tab = { id: 'tab', path: object.current_path!, content: original + '未保存\n', isDirty: true }
  const tabs = createDocumentOperationSync({ tabs: () => [tab], replace: next => { tab = next } })
  const service = new CalendarLayersService(f.root, f.registry, f.database, { ...f.writer, tabs }, f.pages)
  const todo = service.listTodos()[0], request = { id: todo.id, expectedVersion: todo.version }
  assert.deepEqual(await service.toggleTodo({ ...request, checked: true }), { state: 'unsaved' })
  assert.equal(tab.content, original.replace('[ ]', '[x]') + '未保存\n')
  assert.equal(readFileSync(object.current_path!, 'utf8'), original)
  tab.content = original + '未保存\n'
  assert.deepEqual(await service.scheduleTodo({ ...request, date: '2026-11-12' }), { state: 'unsaved' })
  assert.equal(tab.content, original.replace('aaa', 'aaa [2026-11-12](ready://calendar/day/2026-11-12)') + '未保存\n')
  assert.equal(tab.isDirty, true); assert.equal(readFileSync(object.current_path!, 'utf8'), original)
  for (const changed of ['- [ ] bbb\n- [ ] aaa\n', original.replace('aaa', 'xyz')]) {
    tab.content = changed
    await assert.rejects(service.toggleTodo({ ...request, checked: true }), { code: 'dirty_conflict' })
    await assert.rejects(service.scheduleTodo({ ...request, date: '2026-11-12' }), { code: 'dirty_conflict' })
    assert.equal(tab.content, changed); assert.equal(readFileSync(object.current_path!, 'utf8'), original)
  }
})

test('registered todo IPC validates requests, returns error codes and notifies only successful writes', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar todo IPC')) return
  const f = todoFixture(); t.after(() => f.close())
  f.add('tasks.md', '- [ ] task 📅 2026-11-11\n')
  type Handler = (event: import('electron').IpcMainInvokeEvent, input?: unknown) => unknown
  const handlers = new Map<string, Handler>(), pushes: string[] = []
  const dispose = registerCalendarLayersIPC({ handle: (name, handler) => { handlers.set(name, handler) }, removeHandler: name => { handlers.delete(name) } }, async () => ({ layers: f.service, reading: new LibrarySessions(f.root, f.registry) }))
  t.after(dispose)
  const event = { sender: { send: (channel: string) => pushes.push(channel) } } as unknown as import('electron').IpcMainInvokeEvent
  const list = await handlers.get('calendarLayers:listTodos')!(event) as LayerReply<TodoEntry[]>
  assert.ok(list.ok)
  const todo = list.value[0], input = { id: todo.id, expectedVersion: todo.version, date: '2026-11-12' }
  const rejected = await handlers.get('calendarLayers:scheduleTodo')!(event, input) as LayerReply<TodoWriteReceipt>
  assert.ok(!rejected.ok); assert.equal(rejected.code, 'obsidian_date_needs_consent'); assert.deepEqual(pushes, [])
  assert.deepEqual(await handlers.get('calendarLayers:scheduleTodo')!(event, { ...input, rewriteObsidianDate: true }), { ok: true, value: { state: 'saved' } })
  assert.deepEqual(pushes, ['calendarLayers:changed'])
  const current = f.service.listTodos()[0]
  const invalid = await handlers.get('calendarLayers:toggleTodo')!(event, { id: current.id, expectedVersion: current.version, checked: 'yes' }) as LayerReply<TodoWriteReceipt>
  assert.ok(!invalid.ok); assert.equal(pushes.length, 1)
  assert.deepEqual(await handlers.get('calendarLayers:toggleTodo')!(event, { id: current.id, expectedVersion: current.version, checked: true }), { ok: true, value: { state: 'saved' } })
  assert.equal(pushes.length, 2)
  dispose(); assert.equal(handlers.size, 0)
})

test('production resolver retains the cache owner and replaces it when the active vault changes', async t => {
  if (skipIfSqliteUnavailable(t, 'calendar todo cache owner')) return
  const f = todoFixture(), other = todoFixture(); t.after(() => { f.close(); other.close() })
  f.add('a.md', '- [ ] original\n'); other.add('b.md', '- [ ] other\n')
  const { createDocumentDatabaseResolver } = await import('../main/modules/document-database/runtime')
  let root = f.root
  const database = createDocumentDatabaseResolver({ pages: f.pages, ready: Promise.resolve(), writer: () => f.writer,
    vault: { get: () => ({ status: 'ready', root, defaultSuggestion: f.root }) } })
  const resolve = createCalendarLayersResolver({ pages: f.pages, writer: () => f.writer, database })
  const first = (await resolve()).layers
  assert.equal((await resolve()).layers, first)
  const todo = first.listTodos()[0]
  root = other.root; f.registry.scan(root)
  const second = (await resolve()).layers
  assert.notEqual(second, first); assert.equal(second.listTodos()[0].title, 'other')
  await assert.rejects(second.toggleTodo({ id: todo.id, expectedVersion: todo.version, checked: true }), { code: 'version_conflict' })
})
