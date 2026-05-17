import type { CalendarSource } from './CalendarSources'
import type { Reminder } from '../../../shared/calendar-types'
import { Temporal } from '@js-temporal/polyfill'

// Boundary note (L1.5): 本文件的 CalendarEvent 是渲染端给 schedule-x runtime
// 使用的视图类型，故意保留 Date 表达 + UI-only 字段（color / contentType /
// platform / publishStatus 等）。SSOT 数据契约在 `src/shared/calendar-types.ts`
// (Unix seconds + 数据字段)。两侧 boundary 转换在下游团队真的需要 IPC 直传时
// 再补 helper（fromContract / toContract），当前无消费者所以不强制。
export interface CalendarEvent {
  id: string
  title: string
  startTime: Date
  endTime: Date
  calendarId: string
  color: string
  description?: string
  location?: string
  allDay?: boolean
  contentType?: 'video' | 'image' | 'article' | 'story' | 'live'
  platform?: string[]
  publishStatus?: 'draft' | 'scheduled' | 'published' | 'failed'
  /**
   * L2-B-Reminder-UI — propagated through the renderer view type so the
   * EventModal can seed its editor from `event.reminders` and pass any
   * edits back to IPC. The wire shape is the shared `Reminder` (Unix
   * seconds + minutes offset); no Date conversion needed here because
   * the offset is relative to event.startTime, not an absolute instant.
   */
  reminders?: Reminder[] | null
  /**
   * L3-B-RRULE-UI — RFC 5545 RRULE body or null for non-recurring.
   * Returned by the IPC layer on the parent row and also propagated to
   * expanded EventInstance rows so the renderer can detect "this row
   * is part of a series" without keeping a separate parent map.
   */
  recurrenceRule?: string | null
  /**
   * L3-B — on EventInstance rows, the parent event id (without
   * `#<occurrenceStart>` suffix). For non-recurring single events this
   * equals `id`. Renderer uses `instanceOf !== id` (or the equivalent
   * `id` contains `'#'`) to switch the "modify this / future / all"
   * dialog on edit.
   */
  instanceOf?: string
  /**
   * L3-B — Unix seconds of the ORIGINAL (pre-patch) occurrence start.
   * This is the key used by `upsertEventOverride / deleteEventOverride`
   * IPC payloads — even after a `single` override moved the row's
   * `startTime`, the override row is still keyed by this original
   * timestamp.
   */
  occurrenceStart?: number
  /**
   * L3-B — `'single' | 'cancelled' | null`. Reflects the kind of
   * override applied to this instance (or null if none). Renderers
   * can show a subtle badge when this is non-null so the user knows
   * the instance has been customized.
   */
  overrideKind?: 'single' | 'cancelled' | null
}

// Schedule-X event shape (runtime accepts string dates despite Temporal types)
export interface SXEvent {
  id: string | number
  start: Temporal.ZonedDateTime | Temporal.PlainDate
  end: Temporal.ZonedDateTime | Temporal.PlainDate
  title?: string
  calendarId?: string
  description?: string
  location?: string
  // Custom fields stored directly — SX preserves arbitrary keys via [key: string]: any
  contentType?: string
  platform?: string
  publishStatus?: string
  color?: string
  [key: string]: unknown
}

/**
 * Convert a JS Date to Schedule-X string format 'YYYY-MM-DD HH:mm'
 */
export function dateToSXString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${d} ${h}:${min}`
}

function dateToTemporalPlainDate(date: Date): Temporal.PlainDate {
  return Temporal.PlainDate.from({
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  })
}

function dateToTemporalZonedDateTime(date: Date): Temporal.ZonedDateTime {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  return Temporal.ZonedDateTime.from({
    timeZone,
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
    second: date.getSeconds(),
    millisecond: date.getMilliseconds(),
  })
}

/**
 * Extract 'YYYY-MM-DD' from a Date
 */
export function dateToSXDateString(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Convert Schedule-X string 'YYYY-MM-DD HH:mm' or 'YYYY-MM-DD' back to JS Date
 */
export function sxStringToDate(str: string): Date {
  if (str.length > 10) {
    const [datePart, timePart] = str.split(' ')
    const [y, mo, d] = datePart.split('-').map(Number)
    const [h, min] = timePart.split(':').map(Number)
    return new Date(y, mo - 1, d, h, min)
  }
  const [y, mo, d] = str.split('-').map(Number)
  return new Date(y, mo - 1, d)
}

/**
 * Convert Temporal-like object or string to JS Date.
 * Handles: string, Temporal.ZonedDateTime, Temporal.PlainDate, Temporal.PlainDateTime
 */
export function temporalToDate(val: unknown): Date {
  if (val instanceof Date) return val
  if (typeof val === 'string') return sxStringToDate(val)
  // Temporal.ZonedDateTime / PlainDateTime have epochMilliseconds or toPlainDate()
  const obj = val as Record<string, unknown>
  if (typeof obj?.epochMilliseconds === 'number') {
    return new Date(obj.epochMilliseconds as number)
  }
  // Temporal.PlainDate — has year/month/day but no time
  if (typeof obj?.year === 'number' && typeof obj?.month === 'number' && typeof obj?.day === 'number') {
    const hour = typeof obj.hour === 'number' ? obj.hour : 0
    const minute = typeof obj.minute === 'number' ? obj.minute : 0
    return new Date(obj.year as number, (obj.month as number) - 1, obj.day as number, hour as number, minute as number)
  }
  // Fallback: toString
  return sxStringToDate(String(val))
}

/**
 * Convert our CalendarEvent to Schedule-X event format
 */
export function eventToSX(event: CalendarEvent): SXEvent {
  const sxEvent: SXEvent = {
    id: event.id,
    start: event.allDay
      ? dateToTemporalPlainDate(event.startTime)
      : dateToTemporalZonedDateTime(event.startTime),
    end: event.allDay
      ? dateToTemporalPlainDate(event.endTime)
      : dateToTemporalZonedDateTime(event.endTime),
    title: event.title,
    calendarId: event.calendarId,
    description: event.description,
    location: event.location,
    color: event.color,
  }

  if (event.contentType) sxEvent.contentType = event.contentType
  if (event.platform) sxEvent.platform = JSON.stringify(event.platform)
  if (event.publishStatus) sxEvent.publishStatus = event.publishStatus

  // L3-B — propagate recurrence fields. We attach them as passthrough
  // custom fields on the SX event so an SX round-trip via
  // `sxEventToEvent` preserves them. None of these influence SX's own
  // rendering; they're consumed only by EventModal's "modify this /
  // future / all" dialog and by the agent adapter.
  if (event.recurrenceRule !== undefined) sxEvent.recurrenceRule = event.recurrenceRule
  if (event.instanceOf !== undefined) sxEvent.instanceOf = event.instanceOf
  if (event.occurrenceStart !== undefined) sxEvent.occurrenceStart = event.occurrenceStart
  if (event.overrideKind !== undefined) sxEvent.overrideKind = event.overrideKind

  return sxEvent
}

/**
 * Convert Schedule-X event back to our CalendarEvent (partial).
 * Handles both string dates and Temporal objects from SX callbacks.
 */
export function sxEventToEvent(sxEvent: Record<string, unknown>): Partial<CalendarEvent> {
  const result: Partial<CalendarEvent> = {
    id: String(sxEvent.id),
    title: (sxEvent.title as string) || '',
    calendarId: sxEvent.calendarId as string | undefined,
    description: sxEvent.description as string | undefined,
    location: sxEvent.location as string | undefined,
    color: sxEvent.color as string | undefined,
  }

  // L2-B — preserve reminders if SX kept them as a passthrough custom
  // field. We only accept an array shape (Reminder[]) or null; anything
  // else is dropped silently so a malformed SX side effect cannot crash
  // the editor.
  if (sxEvent.reminders === null) {
    result.reminders = null
  } else if (Array.isArray(sxEvent.reminders)) {
    result.reminders = sxEvent.reminders as Reminder[]
  }

  result.startTime = temporalToDate(sxEvent.start)
  result.endTime = temporalToDate(sxEvent.end)

  // All-day detection: date-only string has length <= 10
  if (typeof sxEvent.start === 'string') {
    result.allDay = sxEvent.start.length <= 10
  } else if (
    sxEvent.start &&
    typeof sxEvent.start === 'object' &&
    typeof (sxEvent.start as Record<string, unknown>).year === 'number' &&
    typeof (sxEvent.start as Record<string, unknown>).month === 'number' &&
    typeof (sxEvent.start as Record<string, unknown>).day === 'number' &&
    typeof (sxEvent.start as Record<string, unknown>).hour !== 'number'
  ) {
    result.allDay = true
  }

  // Extract custom fields
  if (sxEvent.contentType) {
    result.contentType = sxEvent.contentType as CalendarEvent['contentType']
  }
  if (sxEvent.platform) {
    try {
      result.platform = typeof sxEvent.platform === 'string'
        ? JSON.parse(sxEvent.platform)
        : sxEvent.platform as string[]
    } catch {
      result.platform = undefined
    }
  }
  if (sxEvent.publishStatus) {
    result.publishStatus = sxEvent.publishStatus as CalendarEvent['publishStatus']
  }

  // L3-B — recover recurrence fields from passthrough. Same defensive
  // shape-check as reminders above: only the documented types survive,
  // unknown shapes are dropped silently.
  if (sxEvent.recurrenceRule === null) {
    result.recurrenceRule = null
  } else if (typeof sxEvent.recurrenceRule === 'string') {
    result.recurrenceRule = sxEvent.recurrenceRule
  }
  if (typeof sxEvent.instanceOf === 'string') {
    result.instanceOf = sxEvent.instanceOf
  }
  if (typeof sxEvent.occurrenceStart === 'number') {
    result.occurrenceStart = sxEvent.occurrenceStart
  }
  if (sxEvent.overrideKind === null) {
    result.overrideKind = null
  } else if (sxEvent.overrideKind === 'single' || sxEvent.overrideKind === 'cancelled') {
    result.overrideKind = sxEvent.overrideKind
  }

  return result
}

/**
 * Convert hex color (#RRGGBB) to rgba string
 */
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  if (isNaN(r) || isNaN(g) || isNaN(b)) return `rgba(100,100,100,${alpha})`
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Convert CalendarSources to Schedule-X calendars config.
 * Each source maps to a CalendarType with lightColors/darkColors derived from source.color.
 */
export function sourcesToCalendars(
  sources: CalendarSource[]
): Record<string, {
  colorName: string
  label?: string
  lightColors?: { main: string; container: string; onContainer: string }
  darkColors?: { main: string; container: string; onContainer: string }
}> {
  const calendars: Record<string, {
    colorName: string
    label?: string
    lightColors: { main: string; container: string; onContainer: string }
    darkColors: { main: string; container: string; onContainer: string }
  }> = {}

  for (const source of sources) {
    calendars[source.id] = {
      colorName: source.id,
      label: source.name,
      lightColors: {
        main: source.color,
        container: hexToRgba(source.color, 0.08),
        onContainer: source.color,
      },
      darkColors: {
        main: source.color,
        container: hexToRgba(source.color, 0.15),
        onContainer: source.color,
      },
    }
  }

  return calendars
}

/**
 * View type mapping between our app and Schedule-X.
 * Our 'month' maps to SX's 'month-grid'.
 */
export type ViewType = 'day' | 'week' | 'month'

export const SX_VIEW_NAMES: Record<ViewType, string> = {
  week: 'week',
  day: 'day',
  month: 'month-grid',
}

export const REVERSE_VIEW_MAP: Record<string, ViewType> = {
  week: 'week',
  day: 'day',
  'month-grid': 'month',
}
