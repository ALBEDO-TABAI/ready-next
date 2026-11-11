import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMainInvokeEvent } from 'electron'
import { registerCalendarLayersIPC } from '../main/modules/calendar-layers/ipc'

// Without a configured vault the calendar has no layer entries and no to-dos to show; reading them is not an
// error. Writing to a to-do still reports that the vault is missing.
test('calendar layer reads are empty without a vault; writes still report it', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>()
  const ipcMain = { handle: (channel: string, handler: never) => { handlers.set(channel, handler) }, removeHandler: (channel: string) => { handlers.delete(channel) } }
  registerCalendarLayersIPC(ipcMain as never, async () => { throw Object.assign(new Error('请先配置可用的资料库'), { code: 'no_vault' }) })
  const event = { sender: { send() {} } } as unknown as IpcMainInvokeEvent
  assert.deepEqual(await handlers.get('calendarLayers:query')!(event, { from: '2026-11-09', to: '2026-11-16', timeZone: 'Asia/Shanghai' }), { ok: true, value: [] })
  assert.deepEqual(await handlers.get('calendarLayers:listTodos')!(event), { ok: true, value: [] })
  const write = await handlers.get('calendarLayers:toggleTodo')!(event, { path: '/vault/计划.md', line: 3, revision: 'r1', checked: true }) as { ok: boolean; code?: string }
  assert.equal(write.ok, false)
  assert.equal(write.code, 'no_vault')
})

test('other failures still surface on reads', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>>()
  const ipcMain = { handle: (channel: string, handler: never) => { handlers.set(channel, handler) }, removeHandler: () => {} }
  registerCalendarLayersIPC(ipcMain as never, async () => { throw new Error('Document writer unavailable') })
  const reply = await handlers.get('calendarLayers:listTodos')!({} as IpcMainInvokeEvent) as { ok: boolean; message?: string }
  assert.equal(reply.ok, false)
  assert.match(reply.message!, /Document writer unavailable/)
})

test('这一天 keeps the day’s events without a vault and leaves out what lives in the vault', async () => {
  const { registerCalendarLinkageIPC } = await import('../main/modules/calendar-linkage/ipc')
  const handlers = new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>()
  const start = Date.parse('2026-11-12T07:00:00Z')
  const event = { id: 'e1', uid: 'e1@test', calendarId: 'c1', title: '和编辑对稿', allDay: false, start, end: start + 3600000, timeZone: 'Asia/Shanghai',
    status: 'confirmed', transparency: 'opaque', createdAt: start, updatedAt: start }
  registerCalendarLinkageIPC({ handle: (channel: string, handler: never) => { handlers.set(channel, handler) } } as never,
    async () => { throw Object.assign(new Error('请先配置可用的资料库'), { code: 'no_vault' }) },
    () => ({ snapshot: () => ({ events: [event] }) }) as never)
  const summary = await handlers.get('calendarLinkage:day')!({}, { date: '2026-11-12', timeZone: 'Asia/Shanghai' }) as { items: { kind: string; title: string }[] }
  assert.deepEqual(summary.items.map(item => [item.kind, item.title]), [['events', '和编辑对稿']])
})
