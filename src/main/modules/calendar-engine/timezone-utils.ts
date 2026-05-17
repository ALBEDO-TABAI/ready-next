/**
 * Calendar L4-A-Timezone — pure helpers for Unix-seconds ↔ IANA-zone
 * arithmetic.
 *
 * Placement note: this module lives in `src/main/` because the rrule
 * engine, the reminder scheduler, and the IPC handler all run in the
 * main process and are the primary consumers of these helpers. The
 * renderer's schedule-x integration consumes timezone IDs through the
 * `useCalendarSession.displayTimezone` zustand field and lets
 * schedule-x do its own internal conversion — the renderer does not
 * need to call any of these functions directly today. If a future
 * renderer-only consumer appears, lift this file into `src/shared/` and
 * remove the relative-path imports.
 *
 * Pure module: no electron / sqlite / IPC. Inputs are primitive
 * numbers + IANA tz strings; outputs are primitive numbers or plain
 * `{ date, time }` records. Errors throw — callers decide whether to
 * catch and degrade or to bubble.
 *
 * Implementation choice: uses `@js-temporal/polyfill` (already present
 * in `package.json` and used by `schedule-x-utils.ts` /
 * `useScheduleXCalendar.ts`). Not luxon, not date-fns-tz — keeping a
 * single tz library in the repo per §6.0.1.11 ("遵守本仓惯例").
 *
 * Behavior contract:
 *   - All time arguments are Unix SECONDS, not milliseconds.
 *   - All timezone arguments are IANA identifiers (e.g. 'Asia/Shanghai',
 *     'America/New_York', 'UTC'). Bad identifiers throw at the first
 *     Temporal call site; we deliberately do NOT silently fall back to
 *     UTC because L4-A's "null = local timezone" sentinel means callers
 *     should never reach this module with a malformed non-null value.
 *   - DST is honored automatically by Temporal (DST jumps are visible
 *     through `ZonedDateTime` epoch arithmetic).
 */

import { Temporal } from '@js-temporal/polyfill'

/**
 * Reinterpret a Unix-seconds timestamp's wall-clock from `fromTz` to
 * `toTz`. Returns the Unix seconds whose wall-clock in `toTz` matches
 * the wall-clock that the input would render under `fromTz`.
 *
 * Example: input = 1779494400 - 8*3600 (i.e. '2026-05-17T09:00 in
 * Asia/Shanghai'), fromTz='Asia/Shanghai', toTz='America/New_York'
 * → output = some other Unix seconds whose wall-clock in
 * America/New_York is '2026-05-17T09:00'. The two Unix seconds are
 * NOT equal — they're different absolute instants that happen to
 * share the same local wall-clock string in their respective zones.
 *
 * Use case: a user creates an event "2026-05-17 09:00 Shanghai
 * meeting" stored as Unix `start_time` + `start_tz='Asia/Shanghai'`;
 * a different user viewing the same row in NY wants to know what time
 * the same SCHEDULED wall-clock would be in their zone (this is the
 * "fake timezone" view, not the "literal moment" view — for the
 * latter just call `formatInTimezone` directly).
 *
 * Throws on invalid IANA identifiers.
 */
export function moveWallClockBetweenZones(
  unixSeconds: number,
  fromTz: string,
  toTz: string,
): number {
  // Build the source ZonedDateTime so we can extract the calendar
  // fields as they render in `fromTz`.
  const sourceInstant = Temporal.Instant.fromEpochMilliseconds(unixSeconds * 1000)
  const sourceZdt = sourceInstant.toZonedDateTimeISO(fromTz)
  // Reconstruct the SAME wall-clock fields in `toTz`. This forces
  // Temporal to pick the matching instant under DST rules of toTz.
  const targetZdt = Temporal.ZonedDateTime.from({
    timeZone: toTz,
    year: sourceZdt.year,
    month: sourceZdt.month,
    day: sourceZdt.day,
    hour: sourceZdt.hour,
    minute: sourceZdt.minute,
    second: sourceZdt.second,
    millisecond: sourceZdt.millisecond,
    microsecond: sourceZdt.microsecond,
    nanosecond: sourceZdt.nanosecond,
  })
  // Round down — Unix seconds is the canonical resolution for our DB
  // columns (CalendarEvent.start_time / end_time are integers).
  return Math.floor(targetZdt.epochMilliseconds / 1000)
}

/**
 * Format a Unix-seconds timestamp as a wall-clock `{ date, time }`
 * pair in the given IANA timezone.
 *
 * `date` is `YYYY-MM-DD`; `time` is `HH:mm` (24-hour) or `h:mm AM/PM`
 * when `hour12: true`. We intentionally keep the shape minimal — the
 * renderer composes display strings; this helper just resolves the
 * tz-aware fields.
 *
 * Throws on invalid IANA identifiers.
 */
export function formatInTimezone(
  unixSeconds: number,
  tz: string,
  options?: { hour12?: boolean },
): { date: string; time: string } {
  const zdt = Temporal.Instant.fromEpochMilliseconds(unixSeconds * 1000).toZonedDateTimeISO(tz)
  const pad = (n: number): string => (n < 10 ? '0' + n : String(n))
  const date = `${zdt.year}-${pad(zdt.month)}-${pad(zdt.day)}`
  let time: string
  if (options?.hour12) {
    const hour12 = zdt.hour === 0 ? 12 : zdt.hour > 12 ? zdt.hour - 12 : zdt.hour
    const ampm = zdt.hour >= 12 ? 'PM' : 'AM'
    time = `${hour12}:${pad(zdt.minute)} ${ampm}`
  } else {
    time = `${pad(zdt.hour)}:${pad(zdt.minute)}`
  }
  return { date, time }
}

/**
 * Returns whether two Unix-seconds timestamps fall on the same
 * wall-clock hour-of-day under their respective timezones.
 *
 * Example: 09:30 in Shanghai and 09:45 in New York share hour-of-day
 * 9 even though they're 13 hours apart in absolute time. The reminder
 * scheduler uses this to decide whether to bucket two reminders into
 * the same UI "morning slot" regardless of zone.
 *
 * DST safety: hour-of-day is read from `ZonedDateTime`, so spring-
 * forward / fall-back transitions are reflected correctly (e.g. a
 * fall-back day has two 1AM hours — both render as hour=1, which is
 * what users perceive).
 *
 * Throws on invalid IANA identifiers.
 */
export function sameWallClockHour(
  a: number,
  aTz: string,
  b: number,
  bTz: string,
): boolean {
  const aZdt = Temporal.Instant.fromEpochMilliseconds(a * 1000).toZonedDateTimeISO(aTz)
  const bZdt = Temporal.Instant.fromEpochMilliseconds(b * 1000).toZonedDateTimeISO(bTz)
  return aZdt.hour === bZdt.hour
}
