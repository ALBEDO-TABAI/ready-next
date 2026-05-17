import type {
  CalendarEvent,
  CalendarSource,
  EventOverride,
  ImportedEvent,
} from '../database'
import { getDatabase } from '../database'
import type { Reminder } from '../../../shared/calendar-types'

/**
 * L4-B — re-export so the IPC handler can import a single canonical
 * shape from this module (mirrors how `EventOverride` is re-exported).
 */
export type { ImportedEvent }

export interface CalendarEventCreateInput {
  calendar_id: string
  title: string
  description: string | null
  location: string | null
  start_time: number
  end_time: number
  all_day: number
  reminders?: Reminder[] | null
  /**
   * L3-B — RFC 5545 RRULE body or null. When non-null this row will be
   * picked up by `getRecurringEventsAndOverrides` and expanded by the
   * rrule engine; when null it remains a single non-recurring event.
   * Empty string is treated as null by `createCalendarEvent`.
   */
  recurrence_rule?: string | null
  /**
   * L4-A — IANA timezone identifier or null. null preserves the
   * existing "local timezone" back-compat for rows created before
   * migration 039. Empty string is normalized to null.
   */
  start_tz?: string | null
  /** L4-A — IANA timezone identifier or null. */
  end_tz?: string | null
}

export type CalendarEventUpdateInput = Partial<{
  title: string
  description: string | null
  location: string | null
  calendar_id: string
  all_day: number
  start_time: number
  end_time: number
  reminders: Reminder[] | null
  /** L3-B — set / clear the RRULE on an existing event. */
  recurrence_rule: string | null
  /** L4-A — set / clear the IANA tz for start. null = local. */
  start_tz: string | null
  /** L4-A — set / clear the IANA tz for end. null = local. */
  end_tz: string | null
}>

export class CalendarRepository {
  getSources(): CalendarSource[] {
    return getDatabase().getCalendarSources()
  }

  getEvents(startTime: number, endTime: number): CalendarEvent[] {
    return getDatabase().getCalendarEvents(startTime, endTime)
  }

  /** L3-B — single-row read used by splitRecurringSeries transaction. */
  getEventById(id: string): CalendarEvent | null {
    return getDatabase().getCalendarEventById(id)
  }

  getRecurringEventsAndOverrides(
    startTime: number,
    endTime: number,
  ): { events: CalendarEvent[]; overridesByParent: Map<string, EventOverride[]> } {
    return getDatabase().getRecurringEventsAndOverrides(startTime, endTime)
  }

  createEvent(event: CalendarEventCreateInput): string {
    return getDatabase().createCalendarEvent(event)
  }

  updateEvent(id: string, updates: CalendarEventUpdateInput): void {
    getDatabase().updateCalendarEvent(id, updates)
  }

  deleteEvent(id: string): void {
    getDatabase().deleteCalendarEvent(id)
  }

  /**
   * L3-B — forward override upsert / delete to the underlying DB. The
   * IPC layer routes through here so the repository stays the canonical
   * data-access seam (mock-friendly + future per-tenant routing).
   */
  upsertEventOverride(override: {
    parentEventId: string
    occurrenceStart: number
    kind: 'single' | 'cancelled'
    patch: EventOverride['patch']
  }): { id: string } {
    return getDatabase().upsertEventOverride(override)
  }

  deleteEventOverride(parentEventId: string, occurrenceStart: number): { deleted: boolean } {
    return getDatabase().deleteEventOverride(parentEventId, occurrenceStart)
  }

  /**
   * L3-B — expose the raw db handle for the IPC layer's
   * `splitRecurringSeries` transaction. The split operation is two
   * mutations on `calendar_events` (truncate parent + insert new
   * series) plus an idempotent `getCalendarEvent` lookup, all of which
   * must commit atomically. Repository owns the DB connection so this
   * is the right level to expose `exec()` to the IPC layer rather than
   * leaking through CalendarRepository at every call site.
   */
  withTransaction<T>(fn: () => T): T {
    const db = getDatabase().getRawDb()
    if (!db) throw new Error('Database not available')
    db.exec('BEGIN')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* swallow rollback errors */ }
      throw error
    }
  }

  // ============== L4-B-External-Sync helpers ===============

  /**
   * L4-B — upsert an externally-synced event row into the given
   * source. Repository forwards to DB so future per-tenant routing /
   * caching can hook here. See `database.upsertImportedEvent` for the
   * identity & contract notes.
   */
  upsertImportedEvent(
    sourceId: string,
    ev: ImportedEvent,
  ): { id: string; action: 'created' | 'updated' } {
    return getDatabase().upsertImportedEvent(sourceId, ev)
  }

  /** L4-B — delete an externally-synced row by `(sourceId, uid)`. */
  deleteImportedEvent(sourceId: string, uid: string): void {
    getDatabase().deleteImportedEvent(sourceId, uid)
  }

  /**
   * L4-B — list externally-synced rows owned by `sourceId`. Each tuple
   * is `(uid, id)` so the sync scheduler can diff against the latest
   * fetch.
   */
  listImportedEventsForSource(sourceId: string): Array<{ uid: string; id: string }> {
    return getDatabase().listImportedEventsForSource(sourceId)
  }

  /**
   * L4-B — create or update a `calendar_sources` row. See
   * `database.upsertCalendarSource` for the field semantics.
   */
  upsertCalendarSource(source: {
    id: string
    name: string
    color?: string
    type?: string
    syncUrl?: string | null
    syncInterval?: number
    enabled?: boolean
  }): { id: string; action: 'created' | 'updated' } {
    return getDatabase().upsertCalendarSource(source)
  }

  /** L4-B — read one source row. Returns null when missing. */
  getCalendarSourceById(id: string): CalendarSource | null {
    return getDatabase().getCalendarSourceById(id)
  }

  /**
   * L4-B — delete a source row. FK CASCADE drops every event whose
   * `calendar_id` equals this id (incl. externally-synced ones since
   * those rows write the source id into both `calendar_id` and
   * `source_id`).
   */
  deleteCalendarSource(id: string): { deleted: boolean } {
    return getDatabase().deleteCalendarSource(id)
  }
}
