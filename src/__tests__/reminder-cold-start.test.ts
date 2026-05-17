/**
 * Behavior tests for `reminder-cold-start.ts`.
 *
 * Pure-deps + injected fire() so we can observe payloads directly. Verifies:
 *   - missed reminders in (now - grace, now) trigger one aggregated fire().
 *   - method='sound' missed reminders are suppressed (no fire), counted.
 *   - reminders outside the grace window are skipped, counted.
 *   - reminders with non-finite offsets are skipped, counted.
 *   - aggregated title contains the count when >1 reminder missed for one event.
 *   - DB read failure returns a zeroed summary.
 *   - empty result returns zeros.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  recoverMissedRemindersSync,
  type ColdStartDb,
} from '../main/modules/calendar-engine/reminder-cold-start'
import type { ReminderFirePayload } from '../main/modules/calendar-engine/reminder-scheduler'
import type { Reminder } from '../shared/calendar-types'

function makeDb(events: Array<{
  id: string
  title: string
  start_time: number
  reminders: Reminder[] | null
}>): ColdStartDb {
  return {
    getCalendarEventsWithReminders(start, end) {
      return events.filter((e) => e.start_time >= start && e.start_time <= end)
    },
  }
}

test('aggregates multiple missed notification reminders for the same event into one fire', () => {
  const fired: ReminderFirePayload[] = []
  const now = 10_000
  // Three reminders missed at T-30m=10000, T-15m=10000, T-5m=10000 against
  // an event that started at T-1m. All inside the 2h grace window.
  const events = [
    {
      id: 'evt1',
      title: 'Standup',
      start_time: now - 60,  // event started 1m ago
      reminders: [
        { offsetMinutes: -30, method: 'notification' as const },  // trigger 30m+1m before = now-1860
        { offsetMinutes: -15, method: 'notification' as const },  // trigger 15m+1m before = now-960
        { offsetMinutes: -5, method: 'notification' as const },   // trigger 5m+1m before = now-360
      ],
    },
  ]
  const summary = recoverMissedRemindersSync({
    getDb: () => makeDb(events),
    now: () => now,
    fire: (p) => fired.push(p),
  })
  assert.equal(summary.recovered, 1)
  assert.equal(summary.suppressed, 0)
  // skipped includes the (count-1) extra reminders folded into the
  // aggregated fire, since only one fire is emitted.
  assert.equal(summary.skipped, 2)
  assert.equal(fired.length, 1)
  assert.match(fired[0].eventTitle, /Standup.*错过 3 个提醒/)
  // The fired payload uses the most-recent (closest-to-now) trigger.
  // Triggers were -30/-15/-5 minutes from start; closest = -5m offset.
  assert.equal(fired[0].offsetMinutes, -5)
})

test('suppresses missed reminders with method=sound but counts them', () => {
  const fired: ReminderFirePayload[] = []
  const now = 10_000
  const events = [
    {
      id: 'evt1',
      title: 'Music',
      start_time: now - 60,
      reminders: [
        { offsetMinutes: -10, method: 'sound' as const },
        { offsetMinutes: -5, method: 'sound' as const },
      ],
    },
  ]
  const summary = recoverMissedRemindersSync({
    getDb: () => makeDb(events),
    now: () => now,
    fire: (p) => fired.push(p),
  })
  assert.equal(summary.recovered, 0, 'no fire for sound-only event')
  assert.equal(summary.suppressed, 2)
  assert.equal(summary.skipped, 0)
  assert.equal(fired.length, 0)
})

test('mixed sound+notification: fires once, counts suppressed correctly', () => {
  const fired: ReminderFirePayload[] = []
  const now = 10_000
  const events = [
    {
      id: 'evt1',
      title: 'Meeting',
      start_time: now - 60,
      reminders: [
        { offsetMinutes: -10, method: 'sound' as const },
        { offsetMinutes: -5, method: 'notification' as const },
        { offsetMinutes: -2, method: 'notification' as const },
      ],
    },
  ]
  const summary = recoverMissedRemindersSync({
    getDb: () => makeDb(events),
    now: () => now,
    fire: (p) => fired.push(p),
  })
  assert.equal(summary.recovered, 1)
  assert.equal(summary.suppressed, 1)
  // 2 notification reminders, 1 gets aggregated into the fire, 1 counted as skipped.
  assert.equal(summary.skipped, 1)
  assert.equal(fired.length, 1)
  assert.match(fired[0].eventTitle, /Meeting.*错过 2 个提醒/)
})

test('skips reminders whose trigger is older than the grace window', () => {
  const fired: ReminderFirePayload[] = []
  const now = 10_000
  // Event start_time = 9000, reminder at -10m → trigger at 8400.
  // With graceWindowSeconds=1000, window = (now-1000, now) = (9000, 10000).
  // Trigger 8400 < 9000 → skipped.
  const events = [
    {
      id: 'evt1',
      title: 'Old',
      start_time: 9000,
      reminders: [{ offsetMinutes: -10, method: 'notification' as const }],
    },
  ]
  const summary = recoverMissedRemindersSync({
    getDb: () => makeDb(events),
    now: () => now,
    fire: (p) => fired.push(p),
    graceWindowSeconds: 1000,
  })
  assert.equal(summary.recovered, 0)
  assert.equal(summary.skipped, 1)
  assert.equal(fired.length, 0)
})

test('does not replay reminders whose trigger >= now (those belong to live scheduler)', () => {
  const fired: ReminderFirePayload[] = []
  const now = 10_000
  // Event at T+1000. Reminder at -5m → trigger at T+700 = future. Must be
  // skipped — cold-start does not fire reminders for events that haven't
  // happened yet; live scheduler owns the future.
  const events = [
    {
      id: 'evt1',
      title: 'Future',
      start_time: now + 1000,
      reminders: [{ offsetMinutes: -5, method: 'notification' as const }],
    },
  ]
  const summary = recoverMissedRemindersSync({
    getDb: () => makeDb(events),
    now: () => now,
    fire: (p) => fired.push(p),
  })
  assert.equal(summary.recovered, 0)
  assert.equal(summary.skipped, 1)
  assert.equal(fired.length, 0)
})

test('does not replay reminders whose trigger exactly equals now', () => {
  // Edge: trigger == now is excluded from the lookback window (strict <).
  // This avoids double-firing for the live scheduler.
  const fired: ReminderFirePayload[] = []
  const now = 10_000
  const events = [
    {
      id: 'evt1',
      title: 'Edge',
      start_time: now + 300,
      reminders: [{ offsetMinutes: -5, method: 'notification' as const }],
    },
  ]
  const summary = recoverMissedRemindersSync({
    getDb: () => makeDb(events),
    now: () => now,
    fire: (p) => fired.push(p),
  })
  assert.equal(summary.recovered, 0)
  assert.equal(summary.skipped, 1)
  assert.equal(fired.length, 0)
})

test('non-finite offsetMinutes is skipped and counted', () => {
  const fired: ReminderFirePayload[] = []
  const events = [
    {
      id: 'evt1',
      title: 'Garbage',
      start_time: 9990,
      reminders: [
        { offsetMinutes: Number.POSITIVE_INFINITY, method: 'notification' as const },
        { offsetMinutes: Number.NaN, method: 'notification' as const },
      ],
    },
  ]
  const summary = recoverMissedRemindersSync({
    getDb: () => makeDb(events),
    now: () => 10_000,
    fire: (p) => fired.push(p),
  })
  assert.equal(summary.skipped, 2)
  assert.equal(summary.recovered, 0)
})

test('single missed notification reminder fires without aggregation suffix', () => {
  const fired: ReminderFirePayload[] = []
  const now = 10_000
  const events = [
    {
      id: 'evt1',
      title: 'Solo',
      start_time: now - 60,
      reminders: [{ offsetMinutes: -1, method: 'notification' as const }],
    },
  ]
  const summary = recoverMissedRemindersSync({
    getDb: () => makeDb(events),
    now: () => now,
    fire: (p) => fired.push(p),
  })
  assert.equal(summary.recovered, 1)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].eventTitle, 'Solo', 'no count suffix when only 1 missed')
})

test('multiple events each get their own aggregated fire', () => {
  const fired: ReminderFirePayload[] = []
  const now = 10_000
  const events = [
    {
      id: 'evt1',
      title: 'A',
      start_time: now - 60,
      reminders: [{ offsetMinutes: -1, method: 'notification' as const }],
    },
    {
      id: 'evt2',
      title: 'B',
      start_time: now - 90,
      reminders: [
        { offsetMinutes: -2, method: 'notification' as const },
        { offsetMinutes: -1, method: 'notification' as const },
      ],
    },
  ]
  const summary = recoverMissedRemindersSync({
    getDb: () => makeDb(events),
    now: () => now,
    fire: (p) => fired.push(p),
  })
  assert.equal(summary.recovered, 2)
  assert.equal(fired.length, 2)
  assert.deepEqual(fired.map((f) => f.eventId).sort(), ['evt1', 'evt2'])
})

test('DB read failure returns a zeroed summary and does not throw', () => {
  const originalWarn = console.warn
  const warns: string[] = []
  console.warn = ((...args: unknown[]) => { warns.push(args.map(String).join(' ')) }) as typeof console.warn
  try {
    const summary = recoverMissedRemindersSync({
      getDb: () => ({
        getCalendarEventsWithReminders() { throw new Error('db gone') },
      }),
      now: () => 0,
      fire: () => undefined,
    })
    assert.deepEqual(summary, { recovered: 0, suppressed: 0, skipped: 0 })
    assert.equal(warns.some((w) => w.includes('db gone')), true)
  } finally {
    console.warn = originalWarn
  }
})

test('empty event list returns zeros', () => {
  const summary = recoverMissedRemindersSync({
    getDb: () => makeDb([]),
    now: () => 0,
    fire: () => undefined,
  })
  assert.deepEqual(summary, { recovered: 0, suppressed: 0, skipped: 0 })
})

test('fire() exception is swallowed; one bad event does not block subsequent ones', () => {
  const fired: ReminderFirePayload[] = []
  const originalWarn = console.warn
  const warns: string[] = []
  console.warn = ((...args: unknown[]) => { warns.push(args.map(String).join(' ')) }) as typeof console.warn
  const now = 10_000
  const events = [
    {
      id: 'evt-bad',
      title: 'Bad',
      start_time: now - 60,
      reminders: [{ offsetMinutes: -1, method: 'notification' as const }],
    },
    {
      id: 'evt-good',
      title: 'Good',
      start_time: now - 60,
      reminders: [{ offsetMinutes: -1, method: 'notification' as const }],
    },
  ]
  try {
    const summary = recoverMissedRemindersSync({
      getDb: () => makeDb(events),
      now: () => now,
      fire: (p) => {
        if (p.eventId === 'evt-bad') throw new Error('notif boom')
        fired.push(p)
      },
    })
    // Only the good one counted as recovered (recovered++ runs AFTER fire()).
    assert.equal(summary.recovered, 1)
    assert.equal(fired.length, 1)
    assert.equal(fired[0].eventId, 'evt-good')
    assert.equal(warns.some((w) => w.includes('notif boom')), true)
  } finally {
    console.warn = originalWarn
  }
})

test('custom graceWindowSeconds shrinks the lookback', () => {
  const fired: ReminderFirePayload[] = []
  const now = 10_000
  // Reminder triggers at exactly now - 1800 (30m ago).
  const events = [
    {
      id: 'evt1',
      title: 'A',
      start_time: now - 60,
      reminders: [{ offsetMinutes: -29, method: 'notification' as const }],  // -29m + -1m start = -30m
    },
  ]
  // With grace=900s (15m), the -30m trigger is OUTSIDE → skipped.
  const summary1 = recoverMissedRemindersSync({
    getDb: () => makeDb(events),
    now: () => now,
    fire: (p) => fired.push(p),
    graceWindowSeconds: 900,
  })
  assert.equal(summary1.recovered, 0)
  assert.equal(summary1.skipped, 1)

  // With default grace=7200s (2h), it IS inside.
  fired.length = 0
  const summary2 = recoverMissedRemindersSync({
    getDb: () => makeDb(events),
    now: () => now,
    fire: (p) => fired.push(p),
  })
  assert.equal(summary2.recovered, 1)
  assert.equal(fired.length, 1)
})
