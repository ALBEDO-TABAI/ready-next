import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import type { CalendarLayersService } from './service'
import type { LibrarySessions } from './reading'
import { LayerRangeSchema, LayerMoveSchema, ReadingBeginSchema, ReadingEndSchema, type LayerReply } from '../../../shared/calendar-layers'

/** Startup owner supplies the active, authorized vault after recovery; no client-selected paths. */
export function registerCalendarLayersIPC(ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>,
  resolve: (event: IpcMainInvokeEvent) => Promise<{ layers: CalendarLayersService; reading: LibrarySessions }>) {
  async function reply<T>(work: () => T | Promise<T>): Promise<LayerReply<T>> {
    try { return { ok: true, value: await work() } } catch (error) { return { ok: false, message: String(error) } }
  }
  ipcMain.handle('calendarLayers:query', (event, input: unknown) => reply(async () => (await resolve(event)).layers.query(LayerRangeSchema.parse(input))))
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
    ipcMain.removeHandler('calendarLayers:query'); ipcMain.removeHandler('calendarLayers:move')
    ipcMain.removeHandler('calendarLayers:beginReading'); ipcMain.removeHandler('calendarLayers:endReading')
  }
}
