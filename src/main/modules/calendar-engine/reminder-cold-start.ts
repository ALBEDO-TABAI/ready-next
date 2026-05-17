/**
 * Reminder cold-start recovery — main-process only.
 *
 * Goal: when the app starts (or wakes from sleep), surface a single
 * aggregated notification per event whose reminders were supposed to fire
 * during a `graceWindowSeconds` lookback window. Without this, an event
 * scheduled for "10 minutes before start" silently slips by every time the
 * user wasn't running Ready for >10 minutes before the event.
 *
 * Design choices:
 *   - Per-event aggregation: if event X had reminders at T-30, T-15, T-5,
 *     and the app started at T-2, we fire ONE notification for X (body
 *     mentions count = 3), not three.
 *   - We DROP `method='sound'` missed reminders (no toast = no sound for
 *     past events; the OS notification body still names the event so the
 *     user sees it).
 *   - We DROP reminders outside the grace window. A 2h default keeps the
 *     UX bounded; opening the app at 5pm shouldn't blast notifications
 *     for an 8am event that fired at T-15m = 7:45am.
 *   - Pure-deps + no I/O of its own: the caller passes `fire(payload)`
 *     which is typically the notifier's `fire` directly.
 *
 * NOTE: We do NOT persist a "last seen" timestamp anywhere — that would
 * be the only way to know exactly how long the app was down. Two hours
 * is a chosen heuristic that's "useful but not annoying". Future work
 * could thread an `appLastSeenAt` from settings table if needed.
 */

import type { Reminder } from '../../../shared/calendar-types'
import { expandReminders, type ReminderFirePayload } from './reminder-scheduler'

export interface ColdStartDb {
  /**
   * Return all events whose `start_time` falls in the SQL window AND that
   * have at least one reminder. Caller widens the SQL window by the max
   * offset magnitude.
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

export interface RecoverMissedRemindersDeps {
  getDb(): ColdStartDb
  /** Unix seconds — injectable for tests. */
  now(): number
  /**
   * Called once per recovered (event, aggregated reminder) pair. Typically
   * the notifier's `fire` method.
   */
  fire(payload: ReminderFirePayload): void
  /**
   * Lookback window in seconds — reminders whose triggerAtSeconds falls
   * inside `[now - graceWindowSeconds, now)` are eligible. Default 2h.
   */
  graceWindowSeconds?: number
  /**
   * Max plausible reminder offset (minutes) — used to widen the SQL window.
   * Default 1440 (24h, matches scheduler default).
   */
  maxReminderOffsetMagnitudeMinutes?: number
}

export interface MissedReminderSummary {
  /** Number of fire() calls emitted (one per event with ≥1 eligible reminder). */
  recovered: number
  /**
   * Reminders inside the window but dropped: `method='sound'` past-fires
   * (we don't replay sound for missed events).
   */
  suppressed: number
  /**
   * Reminders outside the grace window (older than `graceWindowSeconds`).
   * Also counts duplicates within an event (only one fire per event).
   */
  skipped: number
}

const DEFAULT_GRACE_WINDOW_SECONDS = 2 * 60 * 60
const DEFAULT_MAX_OFFSET_MAGNITUDE_MINUTES = 24 * 60

/**
 * Synchronous core — exported for direct unit testing without async noise.
 */
export function recoverMissedRemindersSync(deps: RecoverMissedRemindersDeps): MissedReminderSummary {
  const grace = deps.graceWindowSeconds ?? DEFAULT_GRACE_WINDOW_SECONDS
  const maxOffsetMagnitudeMinutes =
    deps.maxReminderOffsetMagnitudeMinutes ?? DEFAULT_MAX_OFFSET_MAGNITUDE_MINUTES
  const offsetWidenSeconds = maxOffsetMagnitudeMinutes * 60

  const now = deps.now()
  const windowStart = now - grace
  // Exclusive upper bound: we don't replay reminders whose trigger is
  // exactly == now — those belong to the live scheduler.
  const windowEnd = now

  const sqlStart = windowStart - offsetWidenSeconds
  const sqlEnd = windowEnd + offsetWidenSeconds

  let rows: ReturnType<ColdStartDb['getCalendarEventsWithReminders']>
  try {
    rows = deps.getDb().getCalendarEventsWithReminders(sqlStart, sqlEnd)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn('[reminder-cold-start] DB read failed:', message)
    return { recovered: 0, suppressed: 0, skipped: 0 }
  }

  let recovered = 0
  let suppressed = 0
  let skipped = 0

  for (const row of rows) {
    // Use expandReminders with a wide window so we see every reminder; we
    // then partition them ourselves.
    const eligibleNotification: ReminderFirePayload[] = []
    if (!row.reminders) continue
    for (const reminder of row.reminders) {
      if (!Number.isFinite(reminder.offsetMinutes)) {
        skipped += 1
        continue
      }
      const triggerAt = row.start_time + Math.round(reminder.offsetMinutes * 60)
      // Strictly in (windowStart, windowEnd) — past, but not too far past.
      if (triggerAt <= windowStart || triggerAt >= windowEnd) {
        skipped += 1
        continue
      }
      if (reminder.method === 'sound') {
        suppressed += 1
        continue
      }
      eligibleNotification.push({
        eventId: row.id,
        eventTitle: row.title,
        eventStartTime: row.start_time,
        offsetMinutes: reminder.offsetMinutes,
        method: 'notification',
        firedAt: now,
      })
    }

    if (eligibleNotification.length === 0) continue
    // Aggregate: fire ONE payload per event, with offsetMinutes set to the
    // most-recent (closest-to-now) reminder so the body says e.g. "已开始 N
    // 分钟" derived from the latest missed trigger. The notifier's body
    // builder uses (now - eventStartTime) so the count of missed reminders
    // is best surfaced via the title prefix.
    eligibleNotification.sort((a, b) => {
      const triggerA = a.eventStartTime + a.offsetMinutes * 60
      const triggerB = b.eventStartTime + b.offsetMinutes * 60
      return triggerB - triggerA
    })
    const winner = eligibleNotification[0]
    const missedCount = eligibleNotification.length
    const aggregatedTitle = missedCount > 1
      ? `${winner.eventTitle}（错过 ${missedCount} 个提醒）`
      : winner.eventTitle
    try {
      deps.fire({ ...winner, eventTitle: aggregatedTitle })
      recovered += 1
      if (missedCount > 1) skipped += missedCount - 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[reminder-cold-start] fire() threw for event ${row.id}:`, message)
    }
  }

  // Reference the param so expandReminders stays linked at compile time;
  // it's a useful helper for tests that want to exercise the same window
  // math as the live scheduler.
  void expandReminders

  return { recovered, suppressed, skipped }
}

/**
 * Async wrapper to match the task contract (returns a Promise<Summary>).
 * Currently the work is sync — the wrapper lets us swap to async DB
 * later without changing call sites.
 */
export async function recoverMissedReminders(
  deps: RecoverMissedRemindersDeps,
): Promise<MissedReminderSummary> {
  return recoverMissedRemindersSync(deps)
}
