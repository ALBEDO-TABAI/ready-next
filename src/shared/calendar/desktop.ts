import { parseReadyUri } from '../ready-ref'
import { calendarEventReferenceId } from '../calendar-event-identity'
export type CalendarNavigation =
  | { kind:'event'; eventId:string }
  | { kind:'day'; date:string }
  | { kind:'command'; command:'create'|'settings'|'search'|'day'|'week'|'month' }
export interface CalendarNavigationRequest { id:string; target:CalendarNavigation }
export function parseCalendarDeepLink(raw:string):CalendarNavigation|null {
  const parsed = parseReadyUri(raw)
  if (!parsed.ok) return null
  if (parsed.ref.kind === 'day') return { kind: 'day', date: parsed.ref.date }
  if (parsed.ref.kind !== 'event') return null
  try { return { kind: 'event', eventId: calendarEventReferenceId(parsed.ref) } }
  catch { return null }
}
