/**
 * ICS (RFC 5545) parser — main-process only.
 *
 * Wired by team L4-B (External-Sync). Takes a raw ICS body string and
 * returns a list of `ImportedEvent` records, one per VEVENT. Time is
 * normalized to Unix seconds (`startTime` / `endTime`); the original TZID
 * is preserved as `startTz / endTz` (IANA identifier or null when the
 * VEVENT used a floating time / DATE-only value with no zone).
 *
 * The parser is intentionally tolerant:
 *   - Missing `BEGIN:VCALENDAR` / `END:VCALENDAR` → throws so callers can
 *     reject the whole file (the renderer surfaces this as "this isn't an
 *     ICS file").
 *   - Malformed VEVENT (no SUMMARY, no DTSTART, etc.) → `console.warn` +
 *     skip. Partial import is preferred over total failure.
 *   - VEVENT with no DTEND → fall back to DTSTART (matches the iCal
 *     "instantaneous event" convention; the synthetic end equals start
 *     so the event still renders).
 *   - RRULE is preserved verbatim as the rule body without any leading
 *     `RRULE:` prefix, so it can be passed straight to `rrule-engine`'s
 *     `expandRecurringEvent` which auto-prepends DTSTART internally.
 *
 * Pure module: no DB / fs / electron / IPC imports. Inputs are strings,
 * outputs are structured values. Errors throw via `Error` only on
 * top-level malformed wrappers; field-level problems become warnings.
 */

// ical.js@2.2.1 is real ESM (`"type": "module"` in package.json) with a
// default export carrying the {parse, Component, Event, ...} bag. Real-ESM
// + Node22 interop: `import ICAL from 'ical.js'` is the canonical form and
// gives us the typed default. We accept the cast because the upstream
// types declare `_default` as a namespace, which TypeScript can't model
// as a regular default-export interface.
import icalPkg from 'ical.js'

interface IcalDefault {
  parse: (raw: string) => unknown
  Component: new (jcal: unknown) => IcalComponent
  Event: new (component: IcalComponent) => IcalEvent
}

interface IcalComponent {
  getAllSubcomponents(name: string): IcalComponent[]
  getFirstPropertyValue(name: string): unknown
}

interface IcalTimeLike {
  toJSDate(): Date
  isDate?: boolean
  zone?: { tzid?: string } | null
}

interface IcalEvent {
  uid?: string
  summary?: string
  description?: string
  location?: string
  startDate: IcalTimeLike | null
  endDate: IcalTimeLike | null
}

const ICAL = icalPkg as unknown as IcalDefault

export interface ImportedEvent {
  /** VEVENT UID — dedupe key across syncs and across calendars. */
  uid: string
  title: string
  description: string | null
  location: string | null
  /** Unix seconds. */
  startTime: number
  /** Unix seconds. Falls back to startTime when the source VEVENT has no DTEND. */
  endTime: number
  allDay: boolean
  /** IANA tz from DTSTART;TZID=... ; null for floating / DATE-only. */
  startTz: string | null
  /** IANA tz from DTEND;TZID=... ; null for floating / DATE-only / no DTEND. */
  endTz: string | null
  /**
   * RRULE BODY only (e.g. `FREQ=WEEKLY;COUNT=10`) — no `RRULE:` prefix.
   * The rrule engine auto-prepends DTSTART + `RRULE:` as needed, so the
   * body is what we want to persist into `calendar_events.recurrence_rule`.
   * Null when the VEVENT has no RRULE property.
   */
  recurrenceRule: string | null
}

/**
 * Reserved tz identifiers that ical.js emits for "no zone" markers. We
 * normalize these to null so downstream code never has to special-case
 * the floating-time sentinel.
 */
const FLOATING_TZ_SENTINELS = new Set<string>(['floating', 'Z'])

function normalizeTzId(zone: { tzid?: string } | null | undefined): string | null {
  if (!zone) return null
  const tzid = zone.tzid
  if (typeof tzid !== 'string' || tzid.length === 0) return null
  if (FLOATING_TZ_SENTINELS.has(tzid)) return null
  return tzid
}

function unixSecondsFrom(time: IcalTimeLike | null | undefined): number | null {
  if (!time) return null
  const jsDate = time.toJSDate()
  if (!(jsDate instanceof Date) || Number.isNaN(jsDate.getTime())) return null
  return Math.floor(jsDate.getTime() / 1000)
}

/**
 * Coerce ical.js's RRULE return value to a body string.
 *
 * `getFirstPropertyValue('rrule')` returns an `ICAL.Recur` object whose
 * `.toString()` already strips the `RRULE:` prefix and emits a canonical
 * `FREQ=...;...` form. We use `.toString()` rather than `.toICALString()`
 * (which sometimes re-adds prefixes) so the body lands in the same shape
 * the rrule engine ingests.
 *
 * Null is returned for `null / undefined / empty` so callers can store
 * NULL into `calendar_events.recurrence_rule`.
 */
function extractRruleBody(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/^RRULE:/i, '')
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof value === 'object' && value !== null && typeof (value as { toString?: () => string }).toString === 'function') {
    const str = (value as { toString: () => string }).toString().trim().replace(/^RRULE:/i, '')
    return str.length > 0 ? str : null
  }
  return null
}

/**
 * Parse a raw ICS calendar source string into a list of VEVENT records.
 *
 * Throws on malformed top-level wrappers (missing BEGIN:VCALENDAR /
 * END:VCALENDAR — the underlying ical.js parser surfaces this as a
 * SyntaxError-like throw which we re-emit as a generic `Error`).
 *
 * Skips individual invalid VEVENTs with `console.warn` rather than
 * failing the whole import: a hand-edited .ics file frequently has
 * one or two broken events, and rejecting the entire file would be
 * worse UX than dropping the bad rows.
 */
export function parseIcsString(raw: string): ImportedEvent[] {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('parseIcsString: input must be a non-empty string')
  }

  // Cheap structural gate. ical.js itself does check for BEGIN/END
  // VCALENDAR but emits an arcane "invalid line" error — we do a fast
  // upfront sanity check so the IPC layer can surface a friendly message.
  if (!/BEGIN:VCALENDAR/i.test(raw) || !/END:VCALENDAR/i.test(raw)) {
    throw new Error('Invalid ICS: missing BEGIN:VCALENDAR / END:VCALENDAR')
  }

  let jcal: unknown
  try {
    jcal = ICAL.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid ICS: parse failed (${message})`)
  }

  let vcal: IcalComponent
  try {
    vcal = new ICAL.Component(jcal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid ICS: top-level component construction failed (${message})`)
  }

  const vevents = vcal.getAllSubcomponents('vevent') ?? []
  const out: ImportedEvent[] = []

  for (const veventComp of vevents) {
    try {
      const event = new ICAL.Event(veventComp)

      const uid = typeof event.uid === 'string' ? event.uid.trim() : ''
      if (uid.length === 0) {
        console.warn('[ics-importer] skipping VEVENT with empty UID')
        continue
      }

      const title = typeof event.summary === 'string' ? event.summary.trim() : ''
      if (title.length === 0) {
        console.warn(`[ics-importer] skipping VEVENT ${uid} with empty SUMMARY`)
        continue
      }

      const startTime = unixSecondsFrom(event.startDate)
      if (startTime == null) {
        console.warn(`[ics-importer] skipping VEVENT ${uid} with missing / invalid DTSTART`)
        continue
      }

      // DTEND is optional. ical.js's Event.endDate is null when the VEVENT
      // had no DTEND nor DURATION; we treat that as "instantaneous" and
      // set endTime = startTime so downstream renderer still draws a
      // single point on the timeline.
      const endTimeRaw = unixSecondsFrom(event.endDate)
      const endTime = endTimeRaw ?? startTime

      const startTz = normalizeTzId(event.startDate?.zone)
      const endTz = normalizeTzId(event.endDate?.zone)

      const allDay = Boolean(event.startDate && event.startDate.isDate === true)

      const description =
        typeof event.description === 'string' && event.description.trim().length > 0
          ? event.description.trim()
          : null
      const location =
        typeof event.location === 'string' && event.location.trim().length > 0
          ? event.location.trim()
          : null

      const recurrenceRule = extractRruleBody(veventComp.getFirstPropertyValue('rrule'))

      out.push({
        uid,
        title,
        description,
        location,
        startTime,
        endTime,
        allDay,
        startTz,
        endTz,
        recurrenceRule,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[ics-importer] skipping malformed VEVENT (${message})`)
    }
  }

  return out
}
