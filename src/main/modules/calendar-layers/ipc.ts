import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { CalendarLayersService } from './service'
import type { LibrarySessions } from './reading'
import { LayerRangeSchema, LayerMoveSchema, ToggleTodoSchema, ScheduleTodoSchema, ReadingBeginSchema, ReadingEndSchema, type LayerReply } from '../../../shared/calendar-layers'

/** Startup owner supplies the active, authorized vault after recovery; no client-selected paths. */
export function registerCalendarLayersIPC(ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>,
  resolve: (event: IpcMainInvokeEvent) => Promise<{ layers: CalendarLayersService; reading: LibrarySessions }>) {
  async function reply<T>(work: () => T | Promise<T>): Promise<LayerReply<T>> {
    try { return { ok: true, value: await work() } } catch (error) { return { ok: false, message: String(error), ...(error instanceof Error && 'code' in error && typeof error.code === 'string' ? { code: error.code } : {}) } }
  }
  // Reads with no vault configured have nothing to show: no layer entries, no to-dos. Writes still report it.
  async function whenVault<T>(event: IpcMainInvokeEvent, read: (layers: CalendarLayersService) => T | Promise<T>, empty: T): Promise<T> {
    try { return await read((await resolve(event)).layers) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'no_vault') return empty
      throw error
    }
  }
  ipcMain.handle('calendarLayers:listTodos', event => reply(() => whenVault(event, layers => layers.listTodos(), [])))
  ipcMain.handle('calendarLayers:toggleTodo', (event, input: unknown) => reply(async () => {
    const result = await (await resolve(event)).layers.toggleTodo(ToggleTodoSchema.parse(input))
    event.sender.send('calendarLayers:changed'); return result
  }))
  ipcMain.handle('calendarLayers:scheduleTodo', (event, input: unknown) => reply(async () => {
    const result = await (await resolve(event)).layers.scheduleTodo(ScheduleTodoSchema.parse(input))
    event.sender.send('calendarLayers:changed'); return result
  }))
  ipcMain.handle('calendarLayers:query', (event, input: unknown) => reply(() => { const range = LayerRangeSchema.parse(input); return whenVault(event, layers => layers.query(range), []) }))
  ipcMain.handle('calendarLayers:move', (event, input: unknown) => reply(async () => {
    const result = await (await resolve(event)).layers.move(LayerMoveSchema.parse(input))
    event.sender.send('calendarLayers:changed'); return result
  }))
  ipcMain.handle('calendarLayers:beginReading', (event, input: unknown) => reply(async () => {
    (await resolve(event)).reading.begin(ReadingBeginSchema.parse(input))
  }))
  ipcMain.handle('calendarLayers:endReading', (event, input: unknown) => reply(async () => {
    (await resolve(event)).reading.end(ReadingEndSchema.parse(input)); event.sender.send('calendarLayers:changed')
  }))
  return () => {
    ipcMain.removeHandler('calendarLayers:listTodos'); ipcMain.removeHandler('calendarLayers:toggleTodo'); ipcMain.removeHandler('calendarLayers:scheduleTodo')
    ipcMain.removeHandler('calendarLayers:query'); ipcMain.removeHandler('calendarLayers:move')
    ipcMain.removeHandler('calendarLayers:beginReading'); ipcMain.removeHandler('calendarLayers:endReading')
  }
}
