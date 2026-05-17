/**
 * Main-process re-export of calendar shared contracts.
 *
 * The single source of truth lives at `src/shared/calendar-types.ts` so
 * renderer + main both import the same types. This file is preserved as
 * an import alias for any main-process consumer that pre-dates the
 * shared types layer; new code should prefer importing directly from
 * `src/shared/calendar-types`.
 */

export type {
  CalendarSource,
  CalendarEvent,
  Reminder,
  RecurrenceRule,
} from '../../../shared/calendar-types'
