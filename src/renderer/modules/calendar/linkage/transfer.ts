import { calendarEventReferenceId } from '../../../../shared/calendar-event-identity'
import { ReadyRefSchema, parseReadyUri, toReadyUri, type ReadyRef } from '../../../../shared/ready-ref'
import type { EventRef } from '../../../../shared/calendar-linkage'
export const READY_REF_MIME = 'application/x-ready-ref'
export function writeEventTransfer(data: Pick<DataTransfer, 'setData'>, ref: EventRef, title: string, allDay = false) {
  data.setData(READY_REF_MIME, JSON.stringify(ref))
  data.setData('text/uri-list', toReadyUri(ref))
  data.setData('text/plain', title)
  data.setData('application/x-ready-drag', JSON.stringify({ type: 'calendar-event', eventId: calendarEventReferenceId(ref), name: title, allDay }))
}
export function readEventTransfer(data: Pick<DataTransfer, 'getData'>): { ref: EventRef; title: string } | null {
  const raw = data.getData(READY_REF_MIME)
  let ref: ReadyRef
  if (raw) { const parsed = ReadyRefSchema.parse(JSON.parse(raw)); ref = parsed }
  else { const parsed = parseReadyUri(data.getData('text/uri-list')); if (!parsed.ok) return null; ref = parsed.ref }
  if (ref.kind !== 'event') return null
  return { ref, title: data.getData('text/plain') || '日程' }
}
