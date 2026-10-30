import { z } from 'zod'
import { ReadyRefSchema, toReadyUri, type ReadyRef } from '../ready-ref'
import { DraftFinalizeInputSchema } from '../document-drafts'
import type { CalendarMutationReceipt } from './commands'

export const CalendarLinkTargetSchema = ReadyRefSchema.refine(ref =>
  ['file', 'page', 'canvas', 'web', 'book-location'].includes(ref.kind), '不支持的日程关联类型')
export const CalendarEventLinkSchema = z.strictObject({
  id: z.string().min(1), eventId: z.string().min(1),
  originalStart: z.union([z.number().int(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional(),
  target: CalendarLinkTargetSchema, purpose: z.enum(['related', 'meeting-note']),
}).refine(link => link.purpose !== 'meeting-note' || link.target.kind === 'page', '会议笔记必须是页面')
export type CalendarEventLink = z.infer<typeof CalendarEventLinkSchema>
export interface CalendarLinkReplacement { eventId: string; links: CalendarEventLink[] }
export const MeetingNoteInputSchema = z.strictObject({
  key: z.string().min(1), expected: z.record(z.string(), z.number().int().nonnegative()), destination: DraftFinalizeInputSchema,
})
export type MeetingNoteInput = z.infer<typeof MeetingNoteInputSchema>
export interface MeetingNoteReceipt { ref: Extract<ReadyRef, { kind: 'page' }>; mutation: CalendarMutationReceipt }
export function calendarLinkSource(link: Pick<CalendarEventLink, 'eventId' | 'originalStart'>): Extract<ReadyRef, { kind: 'event' }> {
  return { kind: 'event', id: link.eventId, ...(link.originalStart === undefined ? {} : { occurrence: String(link.originalStart) }) }
}
export function sameCalendarLink(a: CalendarEventLink, b: CalendarEventLink): boolean {
  return a.eventId === b.eventId && a.originalStart === b.originalStart && a.purpose === b.purpose && toReadyUri(a.target) === toReadyUri(b.target)
}
