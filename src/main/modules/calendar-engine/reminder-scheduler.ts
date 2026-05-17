/**
 * Reminder scheduler — main-process only.
 *
 * Responsibilities (and ONLY these):
 *   1. On `rescheduleAll()`, walk a forward window (default 24h) of upcoming
 *      reminders, compute each reminder's absolute trigger instant, and
 *      register a one-shot timer via the injected `scheduleAt`.
 *   2. On `onEventChanged(eventId)`, cancel all pending timers for that
 *      event and re-load it from the DB; if it still has reminders inside
 *      the window, re-register.
 *   3. On `stop()`, cancel every pending timer and become a no-op for any
 *      subsequent call (mutators turn into noops; rescheduleAll resolves
 *      immediately).
 *
 * Non-responsibilities (explicit):
 *   - No DB connection management — `getDb()` returns a thin reader.
 *   - No filesystem writes / log files — host wires console / metrics.
 *   - No fired-event de-dup persistence — scheduler is in-memory only.
 *     Cold-start recovery (`reminder-cold-start.ts`) handles the
 *     "missed while process was down" gap.
 *   - No agent / tool / model side-effects — `fire(payload)` is opaque.
 *
 * The 6h auto-resweep avoids two failure modes:
 *   (a) setTimeout drift on machines that sleep or hibernate — each sweep
 *       re-derives absolute trigger times from the wall clock.
 *   (b) Events created/edited via a path that didn't call onEventChanged
 *       (e.g. direct DB write by a future sync job) still get picked up.
 *
 * Pure-ish module: imports only the shared types. No electron / sqlite /
 * fs / zod imports here. The scheduler is the unit under test; deps are
 * injected so host-Node tests are trivially fast and deterministic.
 */

import type { Reminder, ReminderFirePayload } from '../../../shared/calendar-types'

/**
 * `ReminderFirePayload` SSOT lives in `src/shared/calendar-types.ts` so
 * renderer + preload can import the same shape without crossing the
 * process boundary. This re-export preserves the existing
 * `import { ReminderFirePayload } from './reminder-scheduler'` call
 * sites in main (notifier / cold-start / index.ts) without churn.
 */
export type { ReminderFirePayload }

/** A pending reminder timer's payload after expansion against `event.start_time`. */
export interface ScheduledReminder {
  eventId: string
  /** Event title — captured at scheduling time so we don't need a second DB
   *  lookup at fire time (title can change but a fired reminder snapshots
   *  the title that was scheduled — small inaccuracy, but acceptable). */
  eventTitle: string
  /** Unix seconds. */
  eventStartTime: number
  reminder: Reminder
  /** Computed absolute trigger instant. Unix seconds. */
  triggerAtSeconds: number
}

/** Opaque handle returned by `scheduleAt`; scheduler stores it for cancel. */
export interface SchedulerHandle {
  cancel(): void
}

/** A minimal DB read surface — keeps scheduler decoupled from DatabaseManager. */
export interface SchedulerDb {
  /**
   * Return all events whose `start_time` falls in [windowStartSeconds, windowEndSeconds]
   * AND that have at least one reminder. The scheduler then walks each
   * event's reminders[] and filters by absolute trigger time.
   *
   * Implementations should widen the start_time window by the largest
   * plausible reminder magnitude (call site does this).
   */
  getCalendarEventsWithReminders(
    windowStartSeconds: number,
    windowEndSeconds: number,
  ): Array<{
    id: string
    title: string
    start_time: number
    reminders: Reminder[] | null
  }>
}

export interface ReminderSchedulerDeps {
  getDb(): SchedulerDb
  /** Unix seconds — injectable so tests can pin wall clock. */
  now(): number
  /**
   * Register a one-shot timer to call `fn` at the given epoch instant
   * (Unix seconds). Returning handle must be safe to cancel even after
   * `fn` has already fired (cancel becomes a noop in that case).
   *
   * If `epochSec` is in the past, implementation must still fire `fn`
   * promptly (default `setTimeout` adapter uses `Math.max(delay, 0)`).
   */
  scheduleAt(epochSec: number, fn: () => void): SchedulerHandle
  /** Called when a timer fires. Host translates to Notification / IPC push. */
  fire(payload: ReminderFirePayload): void
  /**
   * How far ahead to schedule (default 24h). Re-swept by `resweepIntervalMs`.
   */
  windowSeconds?: number
  /**
   * Interval between full re-sweeps (default 6h). The first re-sweep is
   * scheduled `resweepIntervalMs` after the first `rescheduleAll()` call.
   */
  resweepIntervalMs?: number
  /**
   * Largest plausible reminder magnitude in minutes. Used to widen the SQL
   * window so a "1 day ahead" reminder on an event 25h from now is still
   * picked up (since we filter by event.start_time, not reminder trigger
   * time, at the SQL layer). Default 1440 (24h).
   */
  maxReminderOffsetMagnitudeMinutes?: number
  /**
   * Optional setInterval shim (returns a handle with .cancel()).
   * Default uses real `setInterval` wrapped to produce a SchedulerHandle.
   */
  setIntervalShim?: (fn: () => void, ms: number) => SchedulerHandle
}

export interface ReminderScheduler {
  rescheduleAll(): Promise<void>
  onEventChanged(eventId: string): void
  /** Cancel all timers + the resweep interval. Subsequent calls are no-ops. */
  stop(): void
}

const DEFAULT_WINDOW_SECONDS = 24 * 60 * 60
const DEFAULT_RESWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000
const DEFAULT_MAX_OFFSET_MAGNITUDE_MINUTES = 24 * 60

/**
 * Default `scheduleAt` implementation using `setTimeout`. setTimeout's
 * delay argument is a 32-bit signed int (max ~24.8 days). We cap delays
 * at 23 hours so any too-distant reminder gets re-picked at the next
 * resweep — much smaller than the 24.8d wrap point so safe by a wide
 * margin.
 */
const SETTIMEOUT_MAX_DELAY_MS = 23 * 60 * 60 * 1000

export function defaultScheduleAt(epochSec: number, fn: () => void): SchedulerHandle {
  const targetMs = epochSec * 1000
  const delayMs = Math.max(0, Math.min(targetMs - Date.now(), SETTIMEOUT_MAX_DELAY_MS))
  let fired = false
  const handle = setTimeout(() => {
    fired = true
    fn()
  }, delayMs)
  return {
    cancel() {
      if (!fired) clearTimeout(handle)
    },
  }
}

function defaultSetIntervalShim(fn: () => void, ms: number): SchedulerHandle {
  const handle = setInterval(fn, ms)
  return {
    cancel() {
      clearInterval(handle)
    },
  }
}

/**
 * Expand an event + its reminders into ScheduledReminder rows whose absolute
 * trigger instant falls inside [windowStartSeconds, windowEndSeconds].
 *
 * Exported for direct unit testing.
 */
export function expandReminders(
  event: { id: string; title: string; start_time: number; reminders: Reminder[] | null },
  windowStartSeconds: number,
  windowEndSeconds: number,
): ScheduledReminder[] {
  if (!event.reminders || event.reminders.length === 0) return []
  const out: ScheduledReminder[] = []
  for (const reminder of event.reminders) {
    if (!Number.isFinite(reminder.offsetMinutes)) continue
    const triggerAtSeconds = event.start_time + Math.round(reminder.offsetMinutes * 60)
    if (triggerAtSeconds < windowStartSeconds) continue
    if (triggerAtSeconds > windowEndSeconds) continue
    out.push({
      eventId: event.id,
      eventTitle: event.title,
      eventStartTime: event.start_time,
      reminder,
      triggerAtSeconds,
    })
  }
  return out
}

export function startReminderScheduler(deps: ReminderSchedulerDeps): ReminderScheduler {
  const windowSeconds = deps.windowSeconds ?? DEFAULT_WINDOW_SECONDS
  const resweepIntervalMs = deps.resweepIntervalMs ?? DEFAULT_RESWEEP_INTERVAL_MS
  const maxOffsetMagnitudeMinutes =
    deps.maxReminderOffsetMagnitudeMinutes ?? DEFAULT_MAX_OFFSET_MAGNITUDE_MINUTES
  const intervalShim = deps.setIntervalShim ?? defaultSetIntervalShim

  // eventId → list of handles for not-yet-fired timers belonging to that event.
  const handles = new Map<string, SchedulerHandle[]>()
  let resweepHandle: SchedulerHandle | null = null
  let stopped = false

  /**
   * Internal: cancel + clear the handle list for one event.
   *
   * Handles both shapes:
   *   - Non-recurring event id `evt-123` cancels the single bucket.
   *   - Parent id `evt-123` of a recurring series cancels ALL instance
   *     buckets `evt-123#<occurrence>` (the wire scheduler stores each
   *     expanded instance under its synthetic id `${parent}#${occ}`).
   *     Without this prefix sweep, an IPC mutation on the parent leaves
   *     stale timers in memory until the 6h resweep eventually rebuilds
   *     them — which is exactly the regression flagged in the audit.
   */
  function cancelEvent(eventId: string): void {
    // Exact-id bucket (covers non-recurring events).
    const direct = handles.get(eventId)
    if (direct) {
      for (const h of direct) {
        try { h.cancel() } catch { /* swallow per-handle */ }
      }
      handles.delete(eventId)
    }
    // Recurring: sweep every bucket keyed `${eventId}#...`.
    const prefix = eventId + '#'
    const keysToDelete: string[] = []
    for (const key of handles.keys()) {
      if (key.startsWith(prefix)) keysToDelete.push(key)
    }
    for (const key of keysToDelete) {
      const list = handles.get(key)
      if (list) {
        for (const h of list) {
          try { h.cancel() } catch { /* swallow per-handle */ }
        }
      }
      handles.delete(key)
    }
  }

  function cancelAll(): void {
    for (const list of handles.values()) {
      for (const h of list) {
        try { h.cancel() } catch { /* swallow per-handle */ }
      }
    }
    handles.clear()
  }

  function scheduleOne(row: ScheduledReminder): void {
    const handle = deps.scheduleAt(row.triggerAtSeconds, () => {
      // On fire: remove this handle from the bucket (best-effort — if cancel
      // races with fire we may still call fire, that's fine).
      const list = handles.get(row.eventId)
      if (list) {
        // Remove by reference — we re-find the slot since we don't know the
        // index yet. Use a fresh array without this entry.
        const next = list.filter((h) => h !== handle)
        if (next.length === 0) handles.delete(row.eventId)
        else handles.set(row.eventId, next)
      }
      try {
        deps.fire({
          eventId: row.eventId,
          eventTitle: row.eventTitle,
          eventStartTime: row.eventStartTime,
          offsetMinutes: row.reminder.offsetMinutes,
          method: row.reminder.method,
          firedAt: deps.now(),
        })
      } catch (error) {
        // fire() crashing must not break the scheduler. Log to console.
        const message = error instanceof Error ? error.message : String(error)
        console.warn(`[reminder-scheduler] fire() threw for event ${row.eventId}:`, message)
      }
    })
    const list = handles.get(row.eventId) ?? []
    list.push(handle)
    handles.set(row.eventId, list)
  }

  function loadAndScheduleEvent(eventId: string): void {
    if (stopped) return
    const now = deps.now()
    const windowEnd = now + windowSeconds
    const offsetWidenSeconds = maxOffsetMagnitudeMinutes * 60
    // Widen the SQL window by the largest plausible offset so we don't miss
    // an event whose start_time is just outside [now, now+24h] but whose
    // reminder fires inside it.
    const sqlStart = now - offsetWidenSeconds
    const sqlEnd = windowEnd + offsetWidenSeconds
    let rows: Array<{ id: string; title: string; start_time: number; reminders: Reminder[] | null }>
    try {
      rows = deps.getDb().getCalendarEventsWithReminders(sqlStart, sqlEnd)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[reminder-scheduler] DB read failed during onEventChanged(${eventId}):`, message)
      return
    }
    // The wire scheduler stores recurring events as expanded instances
    // (`${parent}#${occurrence}`), so a parent-id lookup must scan both
    // an exact match AND any instance whose id starts with `${parent}#`.
    // Non-recurring single events fall out of the prefix sweep naturally.
    const prefix = eventId + '#'
    const matchingRows = rows.filter(
      (r) => r.id === eventId || r.id.startsWith(prefix),
    )
    if (matchingRows.length === 0) return // deleted / no reminders / outside window
    for (const row of matchingRows) {
      for (const expanded of expandReminders(row, now, windowEnd)) {
        scheduleOne(expanded)
      }
    }
  }

  async function rescheduleAll(): Promise<void> {
    if (stopped) return
    cancelAll()
    const now = deps.now()
    const windowEnd = now + windowSeconds
    const offsetWidenSeconds = maxOffsetMagnitudeMinutes * 60
    const sqlStart = now - offsetWidenSeconds
    const sqlEnd = windowEnd + offsetWidenSeconds
    let rows: Array<{ id: string; title: string; start_time: number; reminders: Reminder[] | null }>
    try {
      rows = deps.getDb().getCalendarEventsWithReminders(sqlStart, sqlEnd)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('[reminder-scheduler] DB read failed during rescheduleAll:', message)
      return
    }
    for (const row of rows) {
      for (const expanded of expandReminders(row, now, windowEnd)) {
        scheduleOne(expanded)
      }
    }
  }

  function onEventChanged(eventId: string): void {
    if (stopped) return
    cancelEvent(eventId)
    loadAndScheduleEvent(eventId)
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    cancelAll()
    if (resweepHandle) {
      try { resweepHandle.cancel() } catch { /* swallow */ }
      resweepHandle = null
    }
  }

  // Kick off the 6h auto-resweep. We don't pre-resweep here — the host calls
  // `rescheduleAll()` once at boot. The interval timer keeps long-running
  // sessions honest.
  resweepHandle = intervalShim(() => {
    if (stopped) return
    void rescheduleAll()
  }, resweepIntervalMs)

  return { rescheduleAll, onEventChanged, stop }
}
