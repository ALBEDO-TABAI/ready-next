import { calendarEventReferenceId } from '../../../../shared/calendar-event-identity'
import { READY_REF_MIME, ReadyRefSchema, parseReadyUri, toReadyUri, type ReadyRef } from '../../../../shared/ready-ref'
import type { EventRef } from '../../../../shared/calendar-linkage'
export { READY_REF_MIME }
export function writeEventTransfer(data: Pick<DataTransfer, 'setData'>, ref: EventRef, title: string, allDay = false) {
  data.setData(READY_REF_MIME, JSON.stringify(ref))
  data.setData('text/uri-list', toReadyUri(ref))
  data.setData('text/plain', title)
  data.setData('application/x-ready-drag', JSON.stringify({ type: 'calendar-event', eventId: calendarEventReferenceId(ref), name: title, allDay }))
}
/**
 * A chip on the grid carries the event out (to a page, a board, the assistant) only on Alt-drag. A plain drag is the
 * calendar's own move gesture: letting the native drag start would swallow its pointer events, so it is cancelled.
 */
export function startChipTransfer(event: Pick<DragEvent, 'altKey' | 'preventDefault'> & { dataTransfer: Pick<DataTransfer, 'setData'> | null }, ref: EventRef, title: string, allDay = false): boolean {
  if (!event.altKey || !event.dataTransfer) { event.preventDefault(); return false }
  writeEventTransfer(event.dataTransfer, ref, title, allDay)
  return true
}
export function readEventTransfer(data: Pick<DataTransfer, 'getData'>): { ref: EventRef; title: string } | null {
  const raw = data.getData(READY_REF_MIME)
  let ref: ReadyRef
  if (raw) { const parsed = ReadyRefSchema.parse(JSON.parse(raw)); ref = parsed }
  else { const parsed = parseReadyUri(data.getData('text/uri-list')); if (!parsed.ok) return null; ref = parsed.ref }
  if (ref.kind !== 'event') return null
  return { ref, title: data.getData('text/plain') || '日程' }
}
