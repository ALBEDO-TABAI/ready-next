import { getDatabase } from '../database'

/** Read adapter for file-emergence calendar context; writes belong to CalendarStore commands. */
export class CalendarRepository {
  getEvents(start: number, end: number) {
    return getDatabase().calendar.getNonRecurringEventsInWindow(start, end)
  }
  getRecurringEventsAndOverrides(start: number, end: number) {
    return getDatabase().calendar.getRecurringEventsAndOverrides(start, end)
  }
}
