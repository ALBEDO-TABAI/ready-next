import { z } from 'zod'
import { ReadyRefSchema, toReadyUri, type ReadyRef } from './ready-ref'
import { CanvasIdSchema, Sha256Schema, type CanvasNode } from './ready-canvas'
import { findCalendarOccurrence, type CalendarSnapshot } from './calendar/commands'
import { type Occurrence } from './calendar/model'
import { calendarDate, LayerRangeSchema } from './calendar-layers'

export const DayInputSchema = z.strictObject({ date: calendarDate, timeZone: LayerRangeSchema.shape.timeZone })
export type DayInput = z.infer<typeof DayInputSchema>
export const ScheduleCardSchema = z.strictObject({ operationId: CanvasIdSchema, objectId: CanvasIdSchema, nodeId: CanvasIdSchema,
  expectedVersion: Sha256Schema, calendarId: z.string().min(1), title: z.string().trim().min(1), start: z.number().int(), end: z.number().int(), timeZone: LayerRangeSchema.shape.timeZone,
}).refine(x => x.end > x.start && x.start % 1000 === 0 && x.end % 1000 === 0, 'Invalid event interval')
export type ScheduleCard = z.infer<typeof ScheduleCardSchema>
export type EventRef = Extract<ReadyRef, { kind: 'event' }>
export interface DayItem { id: string; kind: 'events' | 'documents' | 'tasks' | 'reminders' | 'footprints' | 'activity'; title: string; ref: ReadyRef; detail?: string }
export interface DaySummary extends DayInput { items: DayItem[] }
export interface CalendarLinkageAPI {
  day(input: DayInput): Promise<DaySummary>
  schedule(input: ScheduleCard): Promise<EventRef>
}
export function occurrenceRef(o: Occurrence): EventRef {
  const separator = o.key.indexOf('|')
  return { kind: 'event', id: o.seriesId || o.event.id, ...(separator < 0 ? {} : { occurrence: o.key.slice(separator + 1) }) }
}
export function eventView(snapshot: CalendarSnapshot, ref: EventRef) {
  const o = findCalendarOccurrence(snapshot.events, ref.occurrence === undefined ? ref.id : `${ref.id}|${ref.occurrence}`)
  return o ? { title: o.event.title, start: o.start, end: o.end, allDay: o.allDay, location: o.event.location, timeZone: o.event.timeZone || 'UTC' } : null
}
export function eventCard(input: EventRef, geometry: { id: string; x: number; y: number }): CanvasNode {
  const ref = ReadyRefSchema.parse(input)
  if (ref.kind !== 'event') throw new Error('Expected event reference')
  return { ...geometry, width: 300, height: 180, type: 'link', url: toReadyUri(ref), ready: { kind: 'link', ref } }
}
