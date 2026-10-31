import type { IpcMain } from 'electron'
import { DayInputSchema, ScheduleCardSchema } from '../../../shared/calendar-linkage'
import { isoDate, parseIsoDate } from '../../../shared/calendar/dates'
import { CalendarLinkageService } from './service'
import type { CalendarStore } from '../database/calendar-store'
import type { CalendarLayersService } from '../calendar-layers/service'
import { DateMentionService } from '../calendar-engine/date-mentions/service'

export function registerCalendarLinkageIPC(ipcMain: Pick<IpcMain, 'handle'>, resolve: () => Promise<{ layers: CalendarLayersService }>, calendar: () => CalendarStore) {
  ipcMain.handle('calendarLinkage:day', async (_event, raw: unknown) => {
    const input = DayInputSchema.parse(raw), { layers } = await resolve(), store = calendar()
    const range = { from: input.date, to: isoDate(parseIsoDate(input.date) + 1), timeZone: input.timeZone }
    return new CalendarLinkageService(layers.registry, layers.root, store).day(input, layers.query(range), new DateMentionService(layers.registry.db, store).list())
  })
  ipcMain.handle('calendarLinkage:schedule', async (_event, raw: unknown) => {
    const input = ScheduleCardSchema.parse(raw), { layers } = await resolve()
    return new CalendarLinkageService(layers.registry, layers.root, calendar()).schedule(input)
  })
}
