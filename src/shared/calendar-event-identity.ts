import { originalFromSeconds, originalToSeconds } from '../main/modules/calendar-engine/calendar-row-codec'
import { ReadyRefSchema, type ReadyRef } from './ready-ref'

export function persistableCalendarEventId(id: string | null | undefined): string | null {
  const raw = String(id || '').trim()
  if (!raw) return null
  const hash = raw.indexOf('#')
  const persistable = hash === -1 ? raw : raw.slice(0, hash)
  return persistable.trim() || null
}

/** Convert the calendar wire identity (seconds) without losing an occurrence. */
export function calendarEventReadyRef(id: string | null | undefined, allDay?: boolean): Extract<ReadyRef, { kind: 'event' }> | null {
  if (!id?.trim()) return null
  const [seriesId, seconds, extra] = id.trim().split('#')
  if (!seriesId || extra !== undefined) return null
  if (seconds === undefined) return { kind: 'event', id: seriesId }
  if (allDay === undefined || !/^-?\d+$/.test(seconds)) return null
  const value = Number(seconds)
  if (!Number.isSafeInteger(value * 1000) || !Number.isFinite(new Date(value * 1000).getTime()) || (allDay && value % 86400 !== 0)) return null
  const occurrence = String(originalFromSeconds(value, allDay))
  if (allDay && !ReadyRefSchema.safeParse({ kind: 'day', date: occurrence }).success) return null
  return { kind: 'event', id: seriesId, occurrence }
}

/** The calendar store owns instance lookup; ReadyRef does not grant access. */
export function calendarEventReferenceId(ref: Extract<ReadyRef, { kind: 'event' }>): string {
  if (ref.occurrence === undefined) return ref.id
  const original = /^-?\d+$/.test(ref.occurrence) ? Number(ref.occurrence) : ref.occurrence
  if (typeof original === 'string') ReadyRefSchema.parse({ kind: 'day', date: original })
  else if (!Number.isSafeInteger(original) || original % 1000 !== 0) throw new Error('日程实例无效')
  return `${ref.id}#${originalToSeconds(original)}`
}
