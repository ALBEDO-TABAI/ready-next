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
