import type { CalendarSnapshot } from '../../../shared/calendar/commands'

/** Apply system defaults only to the response; unrelated preference patches must not persist them. */
export function withSystemTimeFormat(snapshot: CalendarSnapshot, system24Hour: () => boolean) {
  return { ...snapshot, prefs: { ...snapshot.prefs, format24HourTime: typeof snapshot.prefs?.format24HourTime === 'boolean'
    ? snapshot.prefs.format24HourTime : system24Hour() } }
}
