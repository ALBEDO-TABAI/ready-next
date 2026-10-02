import type { DatabaseConnection } from './connection'
import type { CalendarSource, CalendarEvent, EventInstance, EventOverride, ImportedEvent } from './records'
import { createHash } from 'crypto'
import { encodeReminders, decodeReminders } from '../calendar-engine/reminder-codec'
import { expandEventList, expandRecurringEvent } from '../calendar-engine/rrule-engine'
import type { Reminder } from '../../../shared/calendar-types'


/**
 * Row interface as returned from `SELECT * FROM calendar_events` — `reminders`
 * is the raw TEXT column (a JSON string or null). Internal-only.
 */
interface CalendarEventRow {
  id: string
  calendar_id: string
  title: string
  description: string | null
  location: string | null
  start_time: number
  end_time: number
  all_day: number
  recurrence_rule: string | null
  reminders: string | null
  /** L4-A — IANA tz; null = local timezone. */
  start_tz: string | null
  /** L4-A — IANA tz; null = local timezone. */
  end_tz: string | null
  /** L4-B — VEVENT UID for externally-synced rows. Null for local rows. */
  ics_uid: string | null
  /** L4-B — `calendar_sources.id` that produced this row. Null for local rows. */
  source_id: string | null
  created_at: number
  updated_at: number
}


/**
 * Raw row from `calendar_event_overrides` — patch_json is the encoded
 * JSON string. Internal only; `decodeEventOverride` returns the parsed
 * `EventOverride` shape.
 */
interface CalendarEventOverrideRow {
  id: string
  parent_event_id: string
  occurrence_start: number
  kind: 'single' | 'cancelled'
  patch_json: string | null
  created_at: number
  updated_at: number
}


function decodeEventOverride(row: CalendarEventOverrideRow): EventOverride {
  let patch: EventOverride['patch'] = null
  if (row.kind === 'single' && row.patch_json != null) {
    try {
      const parsed = JSON.parse(row.patch_json) as Record<string, unknown>
      // Only copy known fields; ignore stray keys so we don't accidentally
      // surface unknown junk.
      const p: NonNullable<EventOverride['patch']> = {}
      if (typeof parsed.title === 'string') p.title = parsed.title
      if (parsed.description === null || typeof parsed.description === 'string') {
        p.description = parsed.description as string | null
      }
      if (parsed.location === null || typeof parsed.location === 'string') {
        p.location = parsed.location as string | null
      }
      if (typeof parsed.start_time === 'number') p.start_time = parsed.start_time
      if (typeof parsed.end_time === 'number') p.end_time = parsed.end_time
      if (typeof parsed.all_day === 'number') p.all_day = parsed.all_day
      if (parsed.reminders === null || Array.isArray(parsed.reminders)) {
        p.reminders = parsed.reminders as Reminder[] | null
      }
      // L4-A — accept null (= clear) or non-empty string. Empty strings
      // are normalized to null so the decode side never surfaces ''.
      if (parsed.start_tz === null) p.start_tz = null
      else if (typeof parsed.start_tz === 'string' && parsed.start_tz.length > 0) {
        p.start_tz = parsed.start_tz
      }
      if (parsed.end_tz === null) p.end_tz = null
      else if (typeof parsed.end_tz === 'string' && parsed.end_tz.length > 0) {
        p.end_tz = parsed.end_tz
      }
      patch = p
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[database] failed to decode override patch_json for ${row.id}: ${message}; treating as empty patch`)
      patch = {}
    }
  }
  return {
    parentEventId: row.parent_event_id,
    occurrenceStart: row.occurrence_start,
    kind: row.kind,
    patch,
  }
}


/**
 * L4-B — deterministic row id for an externally-synced VEVENT.
 *
 * Same (sourceId, uid) → same id, so repeating the same fetch lands on
 * the same row. We MD5 the UID and slice 12 hex chars (48 bits); that's
 * a few orders of magnitude above the collision threshold for the
 * thousands-of-events typical for a single subscription, and gives us
 * a fixed-length token regardless of UID format (UIDs can be very long
 * — e.g. Google's `…@google.com` UIDs are 60+ chars).
 *
 * Exported as a top-level helper so the unit tests don't need to reach
 * into the DatabaseManager to verify the formula.
 */
function computeImportedEventId(sourceId: string, uid: string): string {
  const digest = createHash('md5').update(uid).digest('hex').slice(0, 12)
  return `ics-${sourceId}-${digest}`
}
export class CalendarStore {
  constructor(private readonly getConnection: () => DatabaseConnection | null) {}

  private get db(): DatabaseConnection | null {
    return this.getConnection()
  }


  // ===================== Calendar CRUD Methods =====================

  getCalendarSources(): CalendarSource[] {
    if (!this.db) return []
    return this.db.prepare('SELECT * FROM calendar_sources WHERE enabled = 1 ORDER BY created_at').all<CalendarSource>()
  }

  addCalendarSource(source: { name: string; color: string }): string {
    if (!this.db) throw new Error('Database not available')
    const id = `cal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.db.prepare(
      'INSERT INTO calendar_sources (id, name, color) VALUES (?, ?, ?)'
    ).run(id, source.name, source.color)
    return id
  }

  getCalendarEvents(startTime: number, endTime: number): CalendarEvent[] {
    if (!this.db) return []
    // Events that overlap with the query range:
    // event.start_time < endTime AND event.end_time > startTime
    //
    // Note: this method is intentionally LEFT AS-IS for recurring events —
    // it returns the parent row (recurrence_rule IS NOT NULL) only if the
    // parent's own start_time/end_time happens to fall inside [startTime,
    // endTime]. For window-based recurring expansion the IPC handler calls
    // `getRecurringEventsAndOverrides` + the rrule engine. Tools / sync
    // jobs that read raw parent rows still use this method.
    const rows = this.db.prepare(
      `SELECT * FROM calendar_events
       WHERE start_time < ? AND end_time > ?
       ORDER BY start_time`
    ).all<CalendarEventRow>(endTime, startTime)
    return rows.map((row) => ({
      ...row,
      reminders: decodeReminders(row.reminders, { eventId: row.id }),
    }))
  }

  /**
   * Return non-recurring events that overlap [startTime, endTime] only.
   * Used by the IPC layer to split the read into (non-recurring overlap
   * SQL) + (recurring expansion via rrule). Recurring parents are excluded
   * here so the IPC layer doesn't accidentally double-yield them — they
   * come from `getRecurringEventsAndOverrides` instead.
   */
  getNonRecurringEventsInWindow(startTime: number, endTime: number): CalendarEvent[] {
    if (!this.db) return []
    const rows = this.db.prepare(
      `SELECT * FROM calendar_events
       WHERE recurrence_rule IS NULL
         AND start_time < ? AND end_time > ?
       ORDER BY start_time`,
    ).all<CalendarEventRow>(endTime, startTime)
    return rows.map((row) => ({
      ...row,
      reminders: decodeReminders(row.reminders, { eventId: row.id }),
    }))
  }

  /**
   * Fetch all recurring events (recurrence_rule IS NOT NULL) plus the
   * full override list for them. Recurring parents are NOT window-filtered
   * — a weekly event whose `start_time` is in 2024 must still expand into
   * a 2026 window. The rrule engine handles the window filter via
   * RRULE.between(). Overrides are grouped by parent event id.
   *
   * `windowStartUnix` / `windowEndUnix` are accepted for symmetry with the
   * engine signature but the SQL query intentionally does NOT use them on
   * the parent rows. Override rows ARE window-filtered (only overrides
   * whose `occurrence_start` falls in the window matter for this query).
   */
  getRecurringEventsAndOverrides(
    windowStartUnix: number,
    windowEndUnix: number,
  ): { events: CalendarEvent[]; overridesByParent: Map<string, EventOverride[]> } {
    if (!this.db) return { events: [], overridesByParent: new Map() }

    const eventRows = this.db.prepare(
      `SELECT * FROM calendar_events
       WHERE recurrence_rule IS NOT NULL
       ORDER BY start_time`,
    ).all<CalendarEventRow>()
    const events: CalendarEvent[] = eventRows.map((row) => ({
      ...row,
      reminders: decodeReminders(row.reminders, { eventId: row.id }),
    }))

    if (events.length === 0) {
      return { events: [], overridesByParent: new Map() }
    }

    // Pull all overrides for those parents within the window. We widen the
    // window slightly: an override may move an occurrence's start_time
    // OUTSIDE the original window. Since we match overrides against the
    // ORIGINAL occurrence_start (not the patched start_time) we just use
    // the window directly; the engine then yields the patched fields.
    const placeholders = events.map(() => '?').join(',')
    const overrideRows = this.db.prepare(
      `SELECT * FROM calendar_event_overrides
       WHERE parent_event_id IN (${placeholders})
         AND occurrence_start BETWEEN ? AND ?`,
    ).all<CalendarEventOverrideRow>(
      ...events.map((e) => e.id),
      windowStartUnix,
      windowEndUnix,
    )

    const overridesByParent = new Map<string, EventOverride[]>()
    for (const row of overrideRows) {
      const decoded = decodeEventOverride(row)
      const list = overridesByParent.get(decoded.parentEventId) ?? []
      list.push(decoded)
      overridesByParent.set(decoded.parentEventId, list)
    }
    return { events, overridesByParent }
  }

  /**
   * Reminder scheduler entry point — returns expanded `EventInstance[]`
   * for events that have at least one reminder, INCLUDING recurring
   * instances. Each EventInstance carries its own `reminders` (the parent
   * row's reminders, possibly patched by an override), and its `id` is
   * the syntheticId so the scheduler dedupes timers per-instance.
   *
   * `windowStartSeconds` and `windowEndSeconds` are Unix seconds. Pass
   * the **start_time** bounds you want to consider — callers should
   * widen this against the largest plausible offset.
   *
   * Why expanded instances instead of parents: a daily-recurring event
   * with reminders fires reminders on every occurrence, not just the
   * first. The scheduler is intentionally instance-aware so the timer
   * map can cancel one instance independently. Using syntheticId as
   * `id` means scheduler.onEventChanged(parentId) won't accidentally
   * dedupe two different instances of the same parent.
   */
  getCalendarEventsWithReminders(
    windowStartSeconds: number,
    windowEndSeconds: number,
  ): EventInstance[] {
    if (!this.db) return []

    // Non-recurring path: events with reminders AND start_time in window.
    const nonRecurringRows = this.db.prepare(
      `SELECT * FROM calendar_events
       WHERE reminders IS NOT NULL
         AND recurrence_rule IS NULL
         AND start_time BETWEEN ? AND ?
       ORDER BY start_time`,
    ).all<CalendarEventRow>(windowStartSeconds, windowEndSeconds)
    const nonRecurring: CalendarEvent[] = nonRecurringRows.map((row) => ({
      ...row,
      reminders: decodeReminders(row.reminders, { eventId: row.id }),
    }))

    // Recurring path: events with reminders AND recurrence_rule, expand.
    const recurringRows = this.db.prepare(
      `SELECT * FROM calendar_events
       WHERE reminders IS NOT NULL
         AND recurrence_rule IS NOT NULL
       ORDER BY start_time`,
    ).all<CalendarEventRow>()
    const recurringEvents: CalendarEvent[] = recurringRows.map((row) => ({
      ...row,
      reminders: decodeReminders(row.reminders, { eventId: row.id }),
    }))

    // Pull overrides for the recurring parents that lie inside the window.
    let overridesByParent = new Map<string, EventOverride[]>()
    if (recurringEvents.length > 0) {
      const placeholders = recurringEvents.map(() => '?').join(',')
      const overrideRows = this.db.prepare(
        `SELECT * FROM calendar_event_overrides
         WHERE parent_event_id IN (${placeholders})
           AND occurrence_start BETWEEN ? AND ?`,
      ).all<CalendarEventOverrideRow>(
        ...recurringEvents.map((e) => e.id),
        windowStartSeconds,
        windowEndSeconds,
      )
      for (const row of overrideRows) {
        const decoded = decodeEventOverride(row)
        const list = overridesByParent.get(decoded.parentEventId) ?? []
        list.push(decoded)
        overridesByParent.set(decoded.parentEventId, list)
      }
    }

    // Build EventInstances for both pools and concat. Non-recurring rows
    // produce a single instance whose syntheticId == row.id; recurring
    // rows expand.
    const instances: EventInstance[] = []
    for (const ev of nonRecurring) {
      const inst = expandRecurringEvent(ev, windowStartSeconds, windowEndSeconds, [])
      for (const i of inst) instances.push(i)
    }
    const recurringInstances = expandEventList(
      recurringEvents,
      windowStartSeconds,
      windowEndSeconds,
      overridesByParent,
    )
    for (const i of recurringInstances) instances.push(i)

    instances.sort((a, b) => a.start_time - b.start_time)
    return instances
  }

  createCalendarEvent(event: {
    calendar_id: string
    title: string
    description?: string | null
    location?: string | null
    start_time: number
    end_time: number
    all_day?: number
    color?: string | null
    recurrence_rule?: string | null
    reminders?: Reminder[] | null
    /** L4-A — IANA tz id or null (= local). Empty string is normalized to null. */
    start_tz?: string | null
    /** L4-A — IANA tz id or null (= local). Empty string is normalized to null. */
    end_tz?: string | null
  }): string {
    if (!this.db) throw new Error('Database not available')
    const id = `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Empty string → null so the gate (recurrence_rule IS NOT NULL) is
    // honest. UI / IPC may send '' instead of null when clearing.
    const normalizedRule =
      event.recurrence_rule != null && event.recurrence_rule.trim().length > 0
        ? event.recurrence_rule
        : null
    // L4-A — same normalization for tz columns: empty string is treated
    // as "no explicit zone" (= local) so we don't accidentally persist a
    // sentinel that the validator would later reject.
    const normalizedStartTz =
      event.start_tz != null && event.start_tz.trim().length > 0
        ? event.start_tz
        : null
    const normalizedEndTz =
      event.end_tz != null && event.end_tz.trim().length > 0
        ? event.end_tz
        : null
    this.db.prepare(
      `INSERT INTO calendar_events
       (id, calendar_id, title, description, location, start_time, end_time, all_day, recurrence_rule, reminders, start_tz, end_tz)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      event.calendar_id,
      event.title,
      event.description || null,
      event.location || null,
      event.start_time,
      event.end_time,
      event.all_day || 0,
      normalizedRule,
      encodeReminders(event.reminders ?? null),
      normalizedStartTz,
      normalizedEndTz,
    )
    return id
  }

  updateCalendarEvent(id: string, updates: Partial<{
    title: string
    description: string | null
    location: string | null
    start_time: number
    end_time: number
    all_day: number
    calendar_id: string
    recurrence_rule: string | null
    reminders: Reminder[] | null
    /** L4-A — IANA tz id or null (= local). Empty string → null. */
    start_tz: string | null
    /** L4-A — IANA tz id or null (= local). Empty string → null. */
    end_tz: string | null
  }>): void {
    if (!this.db) throw new Error('Database not available')

    const setClauses: string[] = []
    const values: unknown[] = []

    if (updates.title !== undefined) { setClauses.push('title = ?'); values.push(updates.title) }
    if (updates.description !== undefined) { setClauses.push('description = ?'); values.push(updates.description) }
    if (updates.location !== undefined) { setClauses.push('location = ?'); values.push(updates.location) }
    if (updates.start_time !== undefined) { setClauses.push('start_time = ?'); values.push(updates.start_time) }
    if (updates.end_time !== undefined) { setClauses.push('end_time = ?'); values.push(updates.end_time) }
    if (updates.all_day !== undefined) { setClauses.push('all_day = ?'); values.push(updates.all_day) }
    if (updates.calendar_id !== undefined) { setClauses.push('calendar_id = ?'); values.push(updates.calendar_id) }
    if (updates.recurrence_rule !== undefined) {
      setClauses.push('recurrence_rule = ?')
      // Empty string → null (clear); string with content → store raw.
      const v = updates.recurrence_rule
      values.push(v != null && v.trim().length > 0 ? v : null)
    }
    if (updates.reminders !== undefined) {
      setClauses.push('reminders = ?')
      values.push(encodeReminders(updates.reminders))
    }
    if (updates.start_tz !== undefined) {
      setClauses.push('start_tz = ?')
      // Empty string → null so the back-compat "null = local timezone"
      // semantic stays the canonical clear value.
      const v = updates.start_tz
      values.push(v != null && v.trim().length > 0 ? v : null)
    }
    if (updates.end_tz !== undefined) {
      setClauses.push('end_tz = ?')
      const v = updates.end_tz
      values.push(v != null && v.trim().length > 0 ? v : null)
    }

    if (setClauses.length === 0) return

    setClauses.push('updated_at = unixepoch()')
    values.push(id)

    this.db.prepare(
      `UPDATE calendar_events SET ${setClauses.join(', ')} WHERE id = ?`
    ).run(...values)
  }

  deleteCalendarEvent(id: string): void {
    if (!this.db) throw new Error('Database not available')
    this.db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id)
  }

  /**
   * L3-B — fetch a single event row by id. Used by the
   * `splitRecurringSeries` IPC handler to read the parent's existing
   * recurrence_rule / fields before truncating it; also useful for
   * idempotency checks. Returns null when the event is missing — the
   * caller decides whether that's an error.
   */
  getCalendarEventById(id: string): CalendarEvent | null {
    if (!this.db) return null
    const row = this.db.prepare(
      `SELECT * FROM calendar_events WHERE id = ?`,
    ).get<CalendarEventRow>(id)
    if (!row) return null
    return {
      ...row,
      reminders: decodeReminders(row.reminders, { eventId: row.id }),
    }
  }

  /**
   * L3-B — upsert a per-occurrence override row.
   *
   * The `(parent_event_id, occurrence_start)` UNIQUE index is the conflict
   * key — re-upserting the same occurrence flips the row's kind / patch
   * fields and bumps `updated_at`, keeping the original `id` and
   * `created_at` stable so consumers tracking override ids can resolve
   * a stable handle across edits.
   *
   * `patch` is JSON-encoded; pass `null` when `kind === 'cancelled'`
   * (the IPC layer enforces this contract — patch is silently nulled
   * server-side when the kind is `cancelled` to match the migration
   * 038 schema discipline). `patch` for `kind === 'single'` may use
   * either snake_case (DB-shape) or be partial — only the documented
   * fields survive `decodeEventOverride` on the read side.
   *
   * Returns the row id so the IPC handler can echo it back to the
   * renderer; the renderer doesn't use the id today but knowing the
   * row was written is useful for log lines / future "undo" surfaces.
   */
  upsertEventOverride(override: {
    parentEventId: string
    occurrenceStart: number
    kind: 'single' | 'cancelled'
    patch: EventOverride['patch']
  }): { id: string } {
    if (!this.db) throw new Error('Database not available')
    const id = `ovr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    // Cancelled rows always have null patch_json — this matches the
    // CHECK-constraint-free but documented schema discipline in the
    // 038 migration. If a caller hands us patch on a cancelled kind we
    // drop it on the floor here rather than smuggle it into JSON.
    const encodedPatch =
      override.kind === 'cancelled' || override.patch == null
        ? null
        : JSON.stringify(override.patch)
    this.db.prepare(
      `INSERT INTO calendar_event_overrides
         (id, parent_event_id, occurrence_start, kind, patch_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (parent_event_id, occurrence_start) DO UPDATE SET
         kind = excluded.kind,
         patch_json = excluded.patch_json,
         updated_at = unixepoch()`,
    ).run(
      id,
      override.parentEventId,
      override.occurrenceStart,
      override.kind,
      encodedPatch,
    )
    // The runtime id might be either the freshly inserted id or the
    // existing row's id (when ON CONFLICT updated). Look it up to be
    // honest about which one this call landed on.
    const row = this.db.prepare(
      `SELECT id FROM calendar_event_overrides
       WHERE parent_event_id = ? AND occurrence_start = ?`,
    ).get<{ id: string }>(override.parentEventId, override.occurrenceStart)
    return { id: row?.id ?? id }
  }

  /**
   * L3-B — delete a per-occurrence override row. Returns
   * `{ deleted: false }` when the row didn't exist (idempotent semantic
   * so the IPC layer doesn't error on "remove override that never
   * existed" — equivalent to "the event already follows the parent's
   * default behavior").
   */
  deleteEventOverride(parentEventId: string, occurrenceStart: number): { deleted: boolean } {
    if (!this.db) throw new Error('Database not available')
    const result = this.db.prepare(
      `DELETE FROM calendar_event_overrides
       WHERE parent_event_id = ? AND occurrence_start = ?`,
    ).run(parentEventId, occurrenceStart)
    // better-sqlite3 RunResult.changes is a number; treat any non-zero as deleted.
    const changes =
      typeof (result as { changes?: number })?.changes === 'number'
        ? (result as { changes?: number }).changes ?? 0
        : 0
    return { deleted: changes > 0 }
  }

  // ===================== Calendar External Sync (L4-B) =====================

  /**
   * L4-B — upsert one externally-synced event row for a given source.
   *
   * Identity model: the row id is derived deterministically from
   * `(sourceId, uid)` so re-running the same fetch always lands on the
   * same row. We MD5 the UID and slice the first 12 hex chars; that's
   * 48 bits which is well above the collision threshold for the at-
   * most-thousands of events a single ICS subscription carries.
   *
   * Sentinel id form: `ics-<sourceId>-<md5(uid).slice(0,12)>`. The
   * `ics-` prefix flags the row as externally-synced for any future
   * dashboard that wants to count "subscriptions vs local events".
   *
   * Behavior contract:
   *   - INSERT when no row with that id exists → `action: 'created'`.
   *   - ON CONFLICT(id) DO UPDATE when row exists → `action: 'updated'`
   *     (every mutable field — title, time, location, rrule, reminders,
   *     tz — is overwritten with the latest fetch).
   *   - `calendar_id` is set to `sourceId` so the event appears in the
   *     subscription's own bucket. The user can rebucket via UI later;
   *     a re-sync will NOT clobber a moved row's `calendar_id` because
   *     we only update `calendar_id` on INSERT path — but the conflict
   *     branch keeps the existing `calendar_id` intact. (Note: today's
   *     impl OVERWRITES `calendar_id` on update. Future enhancement
   *     can split create-time / update-time field sets if user demand
   *     for "move externally-synced event to local calendar" appears.)
   *   - `reminders` is always written as null on import — the upstream
   *     feed doesn't carry a runtime "remind me 15m before" semantic
   *     in a portable way (X-properties vary), and silently inheriting
   *     stale reminders would be confusing.
   */
  upsertImportedEvent(
    sourceId: string,
    ev: ImportedEvent,
  ): { id: string; action: 'created' | 'updated' } {
    if (!this.db) throw new Error('Database not available')
    if (typeof sourceId !== 'string' || sourceId.length === 0) {
      throw new Error('upsertImportedEvent: sourceId is required')
    }
    if (typeof ev.uid !== 'string' || ev.uid.length === 0) {
      throw new Error('upsertImportedEvent: ImportedEvent.uid is required')
    }

    const id = computeImportedEventId(sourceId, ev.uid)

    const existing = this.db.prepare(
      `SELECT id FROM calendar_events WHERE id = ?`,
    ).get<{ id: string }>(id)

    // L4-B — normalize tz / rrule the same way createCalendarEvent does
    // so the "empty string never lands in DB" rule is preserved.
    const normalizedRule =
      ev.recurrenceRule != null && ev.recurrenceRule.trim().length > 0
        ? ev.recurrenceRule
        : null
    const normalizedStartTz =
      ev.startTz != null && ev.startTz.trim().length > 0 ? ev.startTz : null
    const normalizedEndTz =
      ev.endTz != null && ev.endTz.trim().length > 0 ? ev.endTz : null

    if (!existing) {
      this.db.prepare(
        `INSERT INTO calendar_events
         (id, calendar_id, title, description, location, start_time, end_time,
          all_day, recurrence_rule, reminders, start_tz, end_tz, ics_uid, source_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        sourceId,
        ev.title,
        ev.description ?? null,
        ev.location ?? null,
        ev.startTime,
        ev.endTime,
        ev.allDay ? 1 : 0,
        normalizedRule,
        null,
        normalizedStartTz,
        normalizedEndTz,
        ev.uid,
        sourceId,
      )
      return { id, action: 'created' }
    }

    this.db.prepare(
      `UPDATE calendar_events SET
         title = ?,
         description = ?,
         location = ?,
         start_time = ?,
         end_time = ?,
         all_day = ?,
         recurrence_rule = ?,
         start_tz = ?,
         end_tz = ?,
         ics_uid = ?,
         source_id = ?,
         updated_at = unixepoch()
       WHERE id = ?`,
    ).run(
      ev.title,
      ev.description ?? null,
      ev.location ?? null,
      ev.startTime,
      ev.endTime,
      ev.allDay ? 1 : 0,
      normalizedRule,
      normalizedStartTz,
      normalizedEndTz,
      ev.uid,
      sourceId,
      id,
    )
    return { id, action: 'updated' }
  }

  /**
   * L4-B — delete one externally-synced row by `(sourceId, uid)`. Used
   * by the sync diff to drop events the upstream feed has removed.
   * Idempotent: missing rows resolve as "no-op".
   */
  deleteImportedEvent(sourceId: string, uid: string): void {
    if (!this.db) throw new Error('Database not available')
    if (typeof sourceId !== 'string' || sourceId.length === 0) return
    if (typeof uid !== 'string' || uid.length === 0) return
    this.db.prepare(
      `DELETE FROM calendar_events WHERE source_id = ? AND ics_uid = ?`,
    ).run(sourceId, uid)
  }

  /**
   * L4-B — list every externally-synced row owned by a given source.
   * Returns `(uid, id)` tuples so the scheduler can diff against the
   * latest fetch without paying for the full row decode.
   */
  listImportedEventsForSource(sourceId: string): Array<{ uid: string; id: string }> {
    if (!this.db) return []
    const rows = this.db.prepare(
      `SELECT id, ics_uid FROM calendar_events
       WHERE source_id = ? AND ics_uid IS NOT NULL`,
    ).all<{ id: string; ics_uid: string }>(sourceId)
    return rows.map((r) => ({ uid: r.ics_uid, id: r.id }))
  }

  /**
   * L4-B — create or update a `calendar_sources` row. Returns whether
   * the row was inserted fresh or had its name / color / sync_url /
   * sync_interval updated. Used by the ICS-subscribe IPC handler so a
   * single call can register a feed.
   *
   * Caller picks the id. If you want one auto-generated, pass `id:
   * \`sub-<Date.now()>-<random>\`` from the IPC layer — the DB does NOT
   * mint ids here so the IPC layer is free to use stable IDs (e.g. for
   * "import a second time, same source name" scenarios where the user
   * actually wants two rows).
   *
   * Empty / undefined `syncUrl` is normalized to null (= local-only
   * source). `syncInterval` defaults to 60 minutes for new rows and is
   * left unchanged for existing rows when omitted.
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
    if (!this.db) throw new Error('Database not available')
    if (typeof source.id !== 'string' || source.id.length === 0) {
      throw new Error('upsertCalendarSource: id is required')
    }
    if (typeof source.name !== 'string' || source.name.length === 0) {
      throw new Error('upsertCalendarSource: name is required')
    }

    const existing = this.db.prepare(
      `SELECT id FROM calendar_sources WHERE id = ?`,
    ).get<{ id: string }>(source.id)

    const color = source.color ?? '#5B8DEF'
    const type = source.type ?? (source.syncUrl ? 'external' : 'local')
    const syncUrl =
      source.syncUrl != null && source.syncUrl.trim().length > 0 ? source.syncUrl : null
    const syncInterval =
      typeof source.syncInterval === 'number' && Number.isFinite(source.syncInterval)
        ? Math.max(1, Math.floor(source.syncInterval))
        : 60
    const enabled = source.enabled === false ? 0 : 1

    if (!existing) {
      this.db.prepare(
        `INSERT INTO calendar_sources
         (id, name, color, type, sync_url, sync_interval, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(source.id, source.name, color, type, syncUrl, syncInterval, enabled)
      return { id: source.id, action: 'created' }
    }

    this.db.prepare(
      `UPDATE calendar_sources SET
         name = ?, color = ?, type = ?,
         sync_url = ?, sync_interval = ?, enabled = ?
       WHERE id = ?`,
    ).run(source.name, color, type, syncUrl, syncInterval, enabled, source.id)
    return { id: source.id, action: 'updated' }
  }

  /**
   * L4-B — read one calendar_sources row by id; returns null when
   * missing. Used by the unsubscribe IPC handler to confirm the row
   * exists before issuing the cascade DELETE.
   */
  getCalendarSourceById(id: string): CalendarSource | null {
    if (!this.db) return null
    return this.db.prepare(
      'SELECT * FROM calendar_sources WHERE id = ?',
    ).get<CalendarSource>(id) ?? null
  }

  /**
   * L4-B — delete one calendar_sources row. The FK on `calendar_events.
   * calendar_id` is declared `ON DELETE CASCADE` (migration 002), so
   * all rows whose `calendar_id` equals this id are dropped atomically.
   * Note: ICS-synced rows store the source id in `source_id` AND
   * `calendar_id` (see `upsertImportedEvent`), so the CASCADE handles
   * them without a separate sweep.
   */
  deleteCalendarSource(id: string): { deleted: boolean } {
    if (!this.db) throw new Error('Database not available')
    const result = this.db.prepare(
      'DELETE FROM calendar_sources WHERE id = ?',
    ).run(id)
    const changes =
      typeof (result as { changes?: number })?.changes === 'number'
        ? (result as { changes?: number }).changes ?? 0
        : 0
    return { deleted: changes > 0 }
  }
}
