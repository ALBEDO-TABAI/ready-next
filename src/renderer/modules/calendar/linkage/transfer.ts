import { READY_REF_MIME, readReadyRefTransfer, writeReadyRefTransfer } from '../../../../shared/ready-ref'
import type { EventRef } from '../../../../shared/calendar-linkage'
export { READY_REF_MIME }
export function writeEventTransfer(data: Pick<DataTransfer, 'setData'>, ref: EventRef, title: string, _allDay = false) {
  writeReadyRefTransfer(data, ref, title)
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
  const dropped = readReadyRefTransfer(data)
  return dropped?.ref.kind === 'event' ? { ref: dropped.ref, title: dropped.title || '日程' } : null
}
