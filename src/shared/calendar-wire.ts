/**
 * Single source of truth for the calendar IPC wire shape.
 *
 * Background — why this file exists:
 * The DB row uses snake_case + Unix seconds. The renderer historically
 * pulled events through `??` fallbacks (`event.startTime ?? event.start_time`)
 * and constructed `new Date(unixSeconds)` directly — which treats Unix
 * seconds as Unix milliseconds and lands every event around 1970. The
 * renderer also assumed `string | Date | number` for time fields while
 * the real IPC handed back raw integers. Result: tests with hand-written
 * camelCase + ISO strings passed, but a real round-trip (create → store →
 * read) silently produced bogus times.
 *
 * Contract:
 *   - Wire-side: camelCase keys, Unix **seconds** (NOT milliseconds), null
 *     for missing optional fields, plain JSON-safe primitives.
 *   - Time conversion to JS `Date` happens EXCLUSIVELY in `parseEventFromWire`;
 *     no caller should construct `new Date(wireValue)` directly.
 *   - Reminders / recurrence / overrides are full-shape (not strings) on the
 *     wire so renderer code does not need to know about JSON encoding.
 *
 * Two boundary helpers — exactly one in main, one in renderer:
 *   - `serializeEventToWire(rowOrInstance) -> CalendarEventWire` (main process)
 *   - `parseEventFromWire(wire) -> CalendarEventParsed`            (renderer)
 *
 * Pure module — no electron / better-sqlite3 / React imports.
 */

import type { Reminder } from './calendar-types'
import type { CalEvent } from './calendar/model'

/**
 * Wire shape for a single calendar event crossing the IPC boundary.
 *
 * Carries enough fields for renderer rendering AND scheduler hand-off AND
 * RRULE expansion / override application. For non-recurring events the
 * instance-specific fields (`instanceOf`, `occurrenceStart`, `syntheticId`,
 * `overrideKind`) repeat the base event identity so downstream code can
 * uniformly treat every payload as an "instance".
 */
export interface CalendarEventWire {
  color?: string | null
  status?: CalEvent['status']
  transparency?: CalEvent['transparency']
  attendees?: CalEvent['attendees']
  id: string
  calendarId: string
  title: string
  description: string | null
  location: string | null
  /** Unix SECONDS — convert to ms before passing to `new Date(...)`. */
  startTime: number
  /** Unix seconds. */
  endTime: number
  allDay: boolean
  recurrenceRule: string | null
  reminders: Reminder[] | null
  startTz: string | null
  endTz: string | null
  /** Unix seconds. */
  createdAt: number
  /** Unix seconds. */
  updatedAt: number
  /** Parent event id; equals `id` for non-recurring single events. */
  instanceOf: string
  /** Unix seconds of the ORIGINAL recurrence start (pre-override). For
   *  non-recurring events this equals `startTime`. */
  occurrenceStart: number
  /** Renderer key. Equals `id` for non-recurring; `${parentId}#${occ}` for
   *  recurring instances. */
  syntheticId: string
  /** Non-null when this instance came from an override row. */
  overrideKind: 'single' | 'cancelled' | null
  /** L4-B: external ICS UID (set by ICS importer); null for local events. */
  icsUid: string | null
  /** L4-B: calendar_sources.id when sourced from an external sync; null for local. */
  sourceId: string | null
}

/**
 * Parsed shape for renderer consumption.
 *
 * Time fields are JS `Date` objects (already ×1000 from seconds). Identity
 * + camelCase + nullables are preserved. UI code uses this exclusively —
 * the wire shape never escapes the boundary helper.
 */
export interface CalendarEventParsed {
  color?: string | null
  status?: CalEvent['status']
  transparency?: CalEvent['transparency']
  attendees?: CalEvent['attendees']
  id: string
  calendarId: string
  title: string
  description: string | null
  location: string | null
  startTime: Date
  endTime: Date
  allDay: boolean
  recurrenceRule: string | null
  reminders: Reminder[] | null
  startTz: string | null
  endTz: string | null
  createdAt: Date
  updatedAt: Date
  instanceOf: string
  occurrenceStart: Date
  syntheticId: string
  overrideKind: 'single' | 'cancelled' | null
  icsUid: string | null
  sourceId: string | null
}

/**
 * Wire shape for `CalendarSource`. Already camelCase since `getSources`
 * never returned snake_case to the renderer, but we lock the shape here
 * so future fields stay consistent.
 */
export interface CalendarSourceWire {
  id: string
  name: string
  color: string
  type: string
  syncUrl: string | null
  syncInterval: number
  enabled: boolean
  /** Unix seconds. */
  createdAt: number
}

/**
 * Input shape accepted by `serializeEventToWire`. Mirrors the union of:
 *   - DB row (`snake_case`, all primitive)
 *   - `EventInstance` from rrule-engine (snake_case + instance fields)
 *   - Sufficiently-typed plain object (lets the helper accept partial
 *     shapes during construction).
 *
 * Using `Record<string, unknown>` would lose too much information; we use
 * a discriminated structural shape that accepts either casing.
 */
export interface SerializableEventInput {
  color?: string | null
  status?: CalEvent['status']
  transparency?: CalEvent['transparency']
  attendees?: CalEvent['attendees']
  id?: string
  // Snake-case DB shape
  calendar_id?: string
  start_time?: number
  end_time?: number
  all_day?: number | boolean
  recurrence_rule?: string | null
  reminders?: Reminder[] | string | null
  start_tz?: string | null
  end_tz?: string | null
  created_at?: number
  updated_at?: number
  ics_uid?: string | null
  source_id?: string | null
  // Camel-case (already-converted) fallbacks
  calendarId?: string
  startTime?: number
  endTime?: number
  allDay?: boolean
  recurrenceRule?: string | null
  startTz?: string | null
  endTz?: string | null
  createdAt?: number
  updatedAt?: number
  icsUid?: string | null
  sourceId?: string | null
  // Common
  title?: string
  description?: string | null
  location?: string | null
  // EventInstance fields (snake or camel; rrule-engine emits camel)
  instanceOf?: string
  occurrenceStart?: number
  syntheticId?: string
  overrideKind?: 'single' | 'cancelled' | null
}

/**
 * Convert an `EventInstance` or raw DB row into wire shape.
 *
 * Tolerates both snake_case (DB row) and camelCase (EventInstance from
 * rrule-engine) input by checking both. Time fields are ALWAYS Unix
 * seconds on output. Null normalization: missing optional fields become
 * `null`, not `undefined`, so renderer code never sees both shapes.
 */
export function serializeEventToWire(input: SerializableEventInput): CalendarEventWire {
  const id = String(input.id ?? '')
  const calendarId = String(input.calendarId ?? input.calendar_id ?? '')
  const startTime = numFirst(input.startTime, input.start_time, 0)
  const endTime = numFirst(input.endTime, input.end_time, startTime)
  const allDay = boolFirst(input.allDay, input.all_day, false)
  const recurrenceRule = strOrNullFirst(input.recurrenceRule, input.recurrence_rule)
  const startTz = strOrNullFirst(input.startTz, input.start_tz)
  const endTz = strOrNullFirst(input.endTz, input.end_tz)
  const createdAt = numFirst(input.createdAt, input.created_at, 0)
  const updatedAt = numFirst(input.updatedAt, input.updated_at, createdAt)
  const icsUid = strOrNullFirst(input.icsUid, input.ics_uid)
  const sourceId = strOrNullFirst(input.sourceId, input.source_id)
  const remindersRaw = input.reminders
  // Reminders may already be parsed (Reminder[] | null) when coming from
  // a getter that decoded JSON; OR a raw string when reading a row that
  // bypassed the decoder. Defensive: only emit a clean array or null.
  let reminders: Reminder[] | null = null
  if (Array.isArray(remindersRaw)) {
    reminders = remindersRaw
  } else if (typeof remindersRaw === 'string' && remindersRaw.trim().length > 0) {
    try {
      const parsed = JSON.parse(remindersRaw)
      if (Array.isArray(parsed)) reminders = parsed as Reminder[]
    } catch {
      reminders = null
    }
  }
  const instanceOf = String(input.instanceOf ?? id)
  const occurrenceStart = typeof input.occurrenceStart === 'number'
    ? input.occurrenceStart
    : startTime
  const syntheticId = String(input.syntheticId ?? id)
  const overrideKind = input.overrideKind ?? null
  return {
    id,
    color: input.color || null,
    status: input.status || 'confirmed',
    transparency: input.transparency || 'opaque',
    attendees: input.attendees || [],
    calendarId,
    title: String(input.title ?? ''),
    description: strOrNull(input.description),
    location: strOrNull(input.location),
    startTime,
    endTime,
    allDay,
    recurrenceRule,
    reminders,
    startTz,
    endTz,
    createdAt,
    updatedAt,
    instanceOf,
    occurrenceStart,
    syntheticId,
    overrideKind,
    icsUid,
    sourceId,
  }
}

/**
 * Convert a wire-shape event back into renderer-ready form. Unix seconds
 * become real `Date` objects; null normalization is preserved.
 *
 * THIS IS THE ONLY PLACE in the renderer that should call `new Date(...)`
 * against an event timestamp. Adding more sites of conversion is exactly
 * how we ended up at "1970-era events on refresh" — keep the conversion
 * centralized.
 */
export function parseEventFromWire(wire: CalendarEventWire): CalendarEventParsed {
  return {
    id: wire.id,
    color: wire.color,
    status: wire.status,
    transparency: wire.transparency,
    attendees: wire.attendees,
    calendarId: wire.calendarId,
    title: wire.title,
    description: wire.description,
    location: wire.location,
    startTime: new Date(wire.startTime * 1000),
    endTime: new Date(wire.endTime * 1000),
    allDay: wire.allDay,
    recurrenceRule: wire.recurrenceRule,
    reminders: wire.reminders,
    startTz: wire.startTz,
    endTz: wire.endTz,
    createdAt: new Date(wire.createdAt * 1000),
    updatedAt: new Date(wire.updatedAt * 1000),
    instanceOf: wire.instanceOf,
    occurrenceStart: new Date(wire.occurrenceStart * 1000),
    syntheticId: wire.syntheticId,
    overrideKind: wire.overrideKind,
    icsUid: wire.icsUid,
    sourceId: wire.sourceId,
  }
}

/**
 * Convert a `CalendarSource` (snake or camel) into wire shape. Sources
 * don't have a Date-mismatch hazard (they only carry one `created_at`),
 * but normalizing here ensures the same single-source pattern.
 */
export interface SerializableSourceInput {
  id?: string
  name?: string
  color?: string
  type?: string
  sync_url?: string | null
  syncUrl?: string | null
  sync_interval?: number
  syncInterval?: number
  enabled?: number | boolean
  created_at?: number
  createdAt?: number
}

export function serializeSourceToWire(input: SerializableSourceInput): CalendarSourceWire {
  return {
    id: String(input.id ?? ''),
    name: String(input.name ?? ''),
    color: String(input.color ?? '#5B8DEF'),
    type: String(input.type ?? 'local'),
    syncUrl: strOrNullFirst(input.syncUrl, input.sync_url),
    syncInterval: numFirst(input.syncInterval, input.sync_interval, 60),
    enabled: boolFirst(input.enabled, undefined, true),
    createdAt: numFirst(input.createdAt, input.created_at, 0),
  }
}

// --- Internal helpers ---------------------------------------------------

function numFirst(a: number | undefined, b: number | undefined, fallback: number): number {
  if (typeof a === 'number' && Number.isFinite(a)) return a
  if (typeof b === 'number' && Number.isFinite(b)) return b
  return fallback
}

function boolFirst(
  a: boolean | number | undefined,
  b: boolean | number | undefined,
  fallback: boolean,
): boolean {
  if (typeof a === 'boolean') return a
  if (typeof a === 'number') return a !== 0
  if (typeof b === 'boolean') return b
  if (typeof b === 'number') return b !== 0
  return fallback
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null
  return v.length === 0 ? null : v
}

function strOrNullFirst(a: unknown, b: unknown): string | null {
  const av = strOrNull(a)
  if (av !== null) return av
  return strOrNull(b)
}
