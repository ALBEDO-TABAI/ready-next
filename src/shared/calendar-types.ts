/**
 * Single source of truth for calendar module TypeScript contracts (shared).
 *
 * Lives under `src/shared/` so both `src/main/` and `src/renderer/` can
 * import the same types without crossing the process boundary. Pure TS —
 * no electron / better-sqlite3 / zod / React imports allowed.
 *
 * Boundary note: `src/renderer/components/calendar/schedule-x-utils.ts`
 * intentionally maintains its OWN `CalendarEvent` shape (Date-based)
 * because the schedule-x runtime protocol requires Date objects. That
 * file is a renderer-only adapter; downstream teams writing IPC bridges
 * or main-process consumers MUST import from THIS file instead.
 */

export interface CalendarSource {
  id: string
  name: string
  color: string
  type: string
  /** External sync URL; null for purely-local sources. Wired by L4-B (ICS subscribe). */
  syncUrl: string | null
  /** Sync polling interval in minutes; ignored when syncUrl is null. */
  syncInterval: number
  enabled: boolean
  /** Unix seconds. */
  createdAt: number
}

export interface CalendarEvent {
  id: string
  calendarId: string
  title: string
  description: string | null
  location: string | null
  /** Unix seconds. */
  startTime: number
  /** Unix seconds. */
  endTime: number
  allDay: boolean
  /** RFC 5545 RRULE string; null for non-recurring events. Wired by L3. */
  recurrenceRule: string | null
  /** Reminder list; null when no reminders. Wired by L2. */
  reminders: Reminder[] | null
  /**
   * L4-A — IANA timezone identifier (e.g. 'Asia/Shanghai',
   * 'America/New_York', 'UTC'). null means "local timezone" (back-compat
   * for rows created before migration 039 landed).
   */
  startTz: string | null
  /** L4-A — IANA timezone identifier; null = local timezone. */
  endTz: string | null
  /** Unix seconds. */
  createdAt: number
  /** Unix seconds. */
  updatedAt: number
}

/**
 * A reminder is a relative offset off the event's start time.
 *
 * `offsetMinutes` is a NEGATIVE number for "before start" (the usual case).
 * Example: `{ offsetMinutes: -15, method: 'notification' }` = "notify me
 * 15 minutes before the event begins". Positive values are allowed for
 * after-event nudges but L2 default UI presets are all negative.
 */
export interface Reminder {
  offsetMinutes: number
  method: 'notification' | 'sound'
}

/**
 * Recurrence rule. First version uses a single RFC 5545 RRULE string;
 * L3-A may extend this into a structured form (freq, interval, byDay, …)
 * once concrete UI editor requirements land.
 */
export interface RecurrenceRule {
  rrule: string
}

/**
 * Payload pushed from main → renderer when a reminder fires (in-app
 * capsule subscribes to the `calendar:reminderFired` IPC channel). The
 * shape mirrors what the OS notification carries.
 *
 * Single source of truth — `src/main/modules/calendar-engine/reminder-scheduler.ts`
 * re-exports this type so both sides import from the same definition. Do
 * NOT duplicate the shape anywhere else.
 *
 * `offsetMinutes` is the originating reminder offset (negative = before
 * start, positive = after). `firedAt` is Unix seconds at fire time;
 * cold-start recoveries set this to the recovery instant, not the
 * original scheduled time.
 */
export interface ReminderFirePayload {
  eventId: string
  eventTitle: string
  /** Unix seconds. */
  eventStartTime: number
  offsetMinutes: number
  method: Reminder['method']
  /** Unix seconds. */
  firedAt: number
}
