/**
 * Behavior tests for `reminder-scheduler.ts`.
 *
 * These are pure-logic tests — they inject `now`, `scheduleAt`, `fire`, and
 * the DB reader so we never touch sqlite, the Notification API, or
 * setTimeout. Following §6.17 (testing conventions) these are behavior
 * tests, not source-greps.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  startReminderScheduler,
  expandReminders,
  type ReminderFirePayload,
  type SchedulerDb,
  type SchedulerHandle,
} from '../main/modules/calendar-engine/reminder-scheduler'
import type { Reminder } from '../shared/calendar-types'

// ----- fixtures + helpers ------------------------------------------------

interface ScheduledCall {
  epochSec: number
  fn: () => void
  cancelled: boolean
}

function makeFakeClock(nowSeconds: number) {
  return {
    get(): number { return nowSeconds },
    set(value: number): void { nowSeconds = value },
  }
}

function makeFakeScheduleAt(calls: ScheduledCall[]) {
  return (epochSec: number, fn: () => void): SchedulerHandle => {
    const entry: ScheduledCall = { epochSec, fn, cancelled: false }
    calls.push(entry)
    return { cancel() { entry.cancelled = true } }
  }
}

function makeFakeIntervalShim() {
  const calls: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const shim = (fn: () => void, ms: number): SchedulerHandle => {
    const entry = { fn, ms, cancelled: false }
    calls.push(entry)
    return { cancel() { entry.cancelled = true } }
  }
  return { shim, calls }
}

function makeFakeDb(events: Array<{
  id: string
  title: string
  start_time: number
  reminders: Reminder[] | null
}>): SchedulerDb {
  return {
    getCalendarEventsWithReminders(start, end) {
      return events.filter((e) => e.start_time >= start && e.start_time <= end)
    },
  }
}

// ----- expandReminders --------------------------------------------------

test('expandReminders includes reminders whose trigger time is inside the window', () => {
  // Event at T+1000. Reminders at -15m and -5m and +5m.
  const event = {
    id: 'evt1',
    title: 'X',
    start_time: 10_000,
    reminders: [
      { offsetMinutes: -15, method: 'notification' as const },
      { offsetMinutes: -5, method: 'sound' as const },
      { offsetMinutes: 5, method: 'notification' as const },
    ],
  }
  // Window: [9000, 11000] = 2000 sec wide.
  const out = expandReminders(event, 9000, 11000)
  // -15m offset = T + (-900) = 9100 → in window
  // -5m offset = T + (-300) = 9700 → in window
  // +5m offset = T + 300 = 10300 → in window
  assert.equal(out.length, 3)
  assert.deepEqual(out.map((r) => r.triggerAtSeconds).sort((a, b) => a - b), [9100, 9700, 10300])
})

test('expandReminders drops reminders outside the window', () => {
  const event = {
    id: 'evt2',
    title: 'Y',
    start_time: 10_000,
    reminders: [
      { offsetMinutes: -60, method: 'notification' as const },  // 6400 — too early
      { offsetMinutes: 60, method: 'notification' as const },   // 13600 — too late
    ],
  }
  const out = expandReminders(event, 9000, 11000)
  assert.equal(out.length, 0)
})

test('expandReminders skips reminders with non-finite offsets', () => {
  const event = {
    id: 'evt3',
    title: 'Z',
    start_time: 10_000,
    reminders: [
      { offsetMinutes: Number.NaN, method: 'notification' as const },
      { offsetMinutes: -10, method: 'notification' as const },
    ],
  }
  const out = expandReminders(event, 9000, 11000)
  assert.equal(out.length, 1)
  assert.equal(out[0].reminder.offsetMinutes, -10)
})

// ----- scheduler behavior -----------------------------------------------

test('rescheduleAll schedules every in-window reminder via scheduleAt', async () => {
  const clock = makeFakeClock(10_000)
  const calls: ScheduledCall[] = []
  const fired: ReminderFirePayload[] = []
  const intervalShim = makeFakeIntervalShim()

  // Two events: one at T+1000 with two reminders inside the 24h window,
  // one at T+200000 (over 2 days out) — well past 24h, should be ignored.
  const db = makeFakeDb([
    {
      id: 'in-window',
      title: 'Soon',
      start_time: 11_000,
      reminders: [
        { offsetMinutes: -10, method: 'notification' },
        { offsetMinutes: -1, method: 'sound' },
      ],
    },
    {
      id: 'out-of-window',
      title: 'Later',
      start_time: 100_000,  // T+90000 > 24h
      reminders: [{ offsetMinutes: -10, method: 'notification' }],
    },
  ])

  const scheduler = startReminderScheduler({
    getDb: () => db,
    now: clock.get,
    scheduleAt: makeFakeScheduleAt(calls),
    fire: (p) => fired.push(p),
    setIntervalShim: intervalShim.shim,
  })

  await scheduler.rescheduleAll()

  assert.equal(calls.length, 2, 'only the in-window event reminders are scheduled')
  // Reminder -10m off T=11000 → 10400; -1m → 10940
  assert.deepEqual(calls.map((c) => c.epochSec).sort((a, b) => a - b), [10_400, 10_940])

  // Fire the first timer manually — payload should describe the event.
  calls[0].fn()
  assert.equal(fired.length, 1)
  assert.equal(fired[0].eventId, 'in-window')
  assert.equal(fired[0].eventTitle, 'Soon')
  scheduler.stop()
})

test('rescheduleAll respects a custom window', async () => {
  const clock = makeFakeClock(0)
  const calls: ScheduledCall[] = []
  const db = makeFakeDb([
    {
      id: 'evt',
      title: 't',
      start_time: 4000,
      reminders: [{ offsetMinutes: 0, method: 'notification' }],
    },
  ])
  // Window = 3600s = 1h. Event at 4000 → outside window, no schedule.
  const scheduler = startReminderScheduler({
    getDb: () => db,
    now: clock.get,
    scheduleAt: makeFakeScheduleAt(calls),
    fire: () => undefined,
    setIntervalShim: makeFakeIntervalShim().shim,
    windowSeconds: 3600,
  })
  await scheduler.rescheduleAll()
  assert.equal(calls.length, 0)
  scheduler.stop()
})

test('onEventChanged cancels old timers for that event and re-registers', () => {
  const clock = makeFakeClock(10_000)
  const calls: ScheduledCall[] = []
  // Mutable event list so we can swap reminders mid-test.
  const events: Array<{ id: string; title: string; start_time: number; reminders: Reminder[] | null }> = [
    {
      id: 'evt',
      title: 'A',
      start_time: 11_000,
      reminders: [{ offsetMinutes: -5, method: 'notification' }],
    },
  ]
  const scheduler = startReminderScheduler({
    getDb: () => makeFakeDb(events),
    now: clock.get,
    scheduleAt: makeFakeScheduleAt(calls),
    fire: () => undefined,
    setIntervalShim: makeFakeIntervalShim().shim,
  })
  // Pre-load via onEventChanged (faster than rescheduleAll for one event).
  scheduler.onEventChanged('evt')
  assert.equal(calls.length, 1)
  const first = calls[0]
  // Now mutate: replace reminders with a new offset.
  events[0] = { ...events[0], reminders: [{ offsetMinutes: -2, method: 'notification' }] }
  scheduler.onEventChanged('evt')
  // Old handle cancelled; new one registered.
  assert.equal(first.cancelled, true)
  assert.equal(calls.length, 2)
  // -2m off T=11000 = 10880.
  assert.equal(calls[1].epochSec, 10880)
  scheduler.stop()
})

test('onEventChanged on a deleted event cancels all its timers and adds none', () => {
  const clock = makeFakeClock(10_000)
  const calls: ScheduledCall[] = []
  const events: Array<{ id: string; title: string; start_time: number; reminders: Reminder[] | null }> = [
    {
      id: 'evt',
      title: 'A',
      start_time: 11_000,
      reminders: [{ offsetMinutes: -5, method: 'notification' }],
    },
  ]
  const scheduler = startReminderScheduler({
    getDb: () => makeFakeDb(events),
    now: clock.get,
    scheduleAt: makeFakeScheduleAt(calls),
    fire: () => undefined,
    setIntervalShim: makeFakeIntervalShim().shim,
  })
  scheduler.onEventChanged('evt')
  assert.equal(calls.length, 1)
  // Simulate delete:
  events.length = 0
  scheduler.onEventChanged('evt')
  assert.equal(calls[0].cancelled, true)
  assert.equal(calls.length, 1, 'no new timer registered for deleted event')
  scheduler.stop()
})

test('stop() cancels every pending timer and turns mutators into no-ops', async () => {
  const clock = makeFakeClock(10_000)
  const calls: ScheduledCall[] = []
  const intervalShim = makeFakeIntervalShim()
  const fired: ReminderFirePayload[] = []
  const events = [
    {
      id: 'evt',
      title: 'A',
      start_time: 11_000,
      reminders: [
        { offsetMinutes: -5, method: 'notification' as const },
        { offsetMinutes: -1, method: 'notification' as const },
      ],
    },
  ]
  const scheduler = startReminderScheduler({
    getDb: () => makeFakeDb(events),
    now: clock.get,
    scheduleAt: makeFakeScheduleAt(calls),
    fire: (p) => fired.push(p),
    setIntervalShim: intervalShim.shim,
  })
  await scheduler.rescheduleAll()
  assert.equal(calls.length, 2)
  scheduler.stop()
  for (const c of calls) assert.equal(c.cancelled, true)
  assert.equal(intervalShim.calls[0].cancelled, true, 'resweep interval cancelled')

  // Post-stop calls should be silent.
  scheduler.onEventChanged('evt')
  await scheduler.rescheduleAll()
  assert.equal(calls.length, 2, 'no new schedule after stop')
  assert.equal(fired.length, 0)
})

test('scheduler cancels duplicate timers when onEventChanged is called twice in a row', () => {
  const clock = makeFakeClock(0)
  const calls: ScheduledCall[] = []
  const events = [
    {
      id: 'evt',
      title: 'A',
      start_time: 1000,
      reminders: [{ offsetMinutes: -5, method: 'notification' as const }],
    },
  ]
  const scheduler = startReminderScheduler({
    getDb: () => makeFakeDb(events),
    now: clock.get,
    scheduleAt: makeFakeScheduleAt(calls),
    fire: () => undefined,
    setIntervalShim: makeFakeIntervalShim().shim,
  })
  scheduler.onEventChanged('evt')
  scheduler.onEventChanged('evt')
  scheduler.onEventChanged('evt')
  // First two should be cancelled; only the third is active.
  assert.equal(calls.length, 3)
  assert.equal(calls[0].cancelled, true)
  assert.equal(calls[1].cancelled, true)
  assert.equal(calls[2].cancelled, false)
  scheduler.stop()
})

test('rescheduleAll re-derives absolute trigger times against the current clock', async () => {
  const clock = makeFakeClock(0)
  const calls: ScheduledCall[] = []
  const events = [
    {
      id: 'evt',
      title: 'A',
      start_time: 1000,
      reminders: [{ offsetMinutes: 0, method: 'notification' as const }],
    },
  ]
  const scheduler = startReminderScheduler({
    getDb: () => makeFakeDb(events),
    now: clock.get,
    scheduleAt: makeFakeScheduleAt(calls),
    fire: () => undefined,
    setIntervalShim: makeFakeIntervalShim().shim,
  })
  await scheduler.rescheduleAll()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].epochSec, 1000)

  // Advance the clock — event is now ALREADY past the window.
  clock.set(2000)
  events[0] = { ...events[0], start_time: 3000 }  // re-anchor for second sweep
  await scheduler.rescheduleAll()
  // Old timer is cancelled, new one registered against new start.
  assert.equal(calls[0].cancelled, true)
  assert.equal(calls[1].epochSec, 3000)
  scheduler.stop()
})

test('fire() exception inside scheduler does not destabilize the scheduler', () => {
  const clock = makeFakeClock(0)
  const calls: ScheduledCall[] = []
  const events = [
    {
      id: 'evt',
      title: 'A',
      start_time: 100,
      reminders: [{ offsetMinutes: 0, method: 'notification' as const }],
    },
  ]
  const originalWarn = console.warn
  const warns: string[] = []
  console.warn = ((...args: unknown[]) => { warns.push(args.map(String).join(' ')) }) as typeof console.warn
  try {
    const scheduler = startReminderScheduler({
      getDb: () => makeFakeDb(events),
      now: clock.get,
      scheduleAt: makeFakeScheduleAt(calls),
      fire: () => { throw new Error('boom') },
      setIntervalShim: makeFakeIntervalShim().shim,
    })
    scheduler.onEventChanged('evt')
    assert.equal(calls.length, 1)
    // Fire the timer — exception is swallowed, warn logged.
    calls[0].fn()
    assert.equal(warns.some((w) => w.includes('boom')), true)
    // Subsequent onEventChanged still works.
    scheduler.onEventChanged('evt')
    assert.equal(calls.length, 2)
    scheduler.stop()
  } finally {
    console.warn = originalWarn
  }
})

test('scheduler widens the SQL window by maxReminderOffsetMagnitudeMinutes', async () => {
  // Verify that an event whose start_time is past `now + windowSeconds`,
  // but whose negative-offset reminder fires INSIDE the window, is still
  // picked up.
  const clock = makeFakeClock(0)
  const calls: ScheduledCall[] = []
  const sqlWindowsSeen: Array<{ start: number; end: number }> = []
  const db: SchedulerDb = {
    getCalendarEventsWithReminders(start, end) {
      sqlWindowsSeen.push({ start, end })
      // Event start is at 100000 (way past now+windowSeconds=86400),
      // but reminder offsetMinutes=-1500 (-25h) → trigger at 100000-90000 = 10000,
      // which IS inside our 24h window. With widen=24h SQL upper bound is
      // 86400+86400=172800, so event with start_time=100000 IS visible.
      return [
        {
          id: 'evt',
          title: 'A',
          start_time: 100_000,
          reminders: [{ offsetMinutes: -1500, method: 'notification' }],
        },
      ].filter((e) => e.start_time >= start && e.start_time <= end)
    },
  }
  const scheduler = startReminderScheduler({
    getDb: () => db,
    now: clock.get,
    scheduleAt: makeFakeScheduleAt(calls),
    fire: () => undefined,
    setIntervalShim: makeFakeIntervalShim().shim,
    maxReminderOffsetMagnitudeMinutes: 1440,  // 24h widening
  })
  await scheduler.rescheduleAll()
  // SQL window upper bound should be at least 172800 (now + 86400 + 86400).
  assert.ok(sqlWindowsSeen[0].end >= 172_800)
  // Event is found, reminder trigger 10000 is inside [0, 86400] → scheduled.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].epochSec, 10_000)
  scheduler.stop()
})

test('scheduler 6h resweep is registered via setIntervalShim', () => {
  const intervalShim = makeFakeIntervalShim()
  const scheduler = startReminderScheduler({
    getDb: () => makeFakeDb([]),
    now: () => 0,
    scheduleAt: makeFakeScheduleAt([]),
    fire: () => undefined,
    setIntervalShim: intervalShim.shim,
  })
  assert.equal(intervalShim.calls.length, 1)
  // Default = 6h = 21600000 ms
  assert.equal(intervalShim.calls[0].ms, 6 * 60 * 60 * 1000)
  scheduler.stop()
})

test('resweep interval respects custom value', () => {
  const intervalShim = makeFakeIntervalShim()
  const scheduler = startReminderScheduler({
    getDb: () => makeFakeDb([]),
    now: () => 0,
    scheduleAt: makeFakeScheduleAt([]),
    fire: () => undefined,
    setIntervalShim: intervalShim.shim,
    resweepIntervalMs: 1000,
  })
  assert.equal(intervalShim.calls[0].ms, 1000)
  scheduler.stop()
})

test('DB read failure during rescheduleAll is swallowed and logged', async () => {
  const calls: ScheduledCall[] = []
  const failingDb: SchedulerDb = {
    getCalendarEventsWithReminders() { throw new Error('disk full') },
  }
  const originalWarn = console.warn
  const warns: string[] = []
  console.warn = ((...args: unknown[]) => { warns.push(args.map(String).join(' ')) }) as typeof console.warn
  try {
    const scheduler = startReminderScheduler({
      getDb: () => failingDb,
      now: () => 0,
      scheduleAt: makeFakeScheduleAt(calls),
      fire: () => undefined,
      setIntervalShim: makeFakeIntervalShim().shim,
    })
    await scheduler.rescheduleAll()
    assert.equal(calls.length, 0)
    assert.equal(warns.some((w) => w.includes('disk full')), true)
    scheduler.stop()
  } finally {
    console.warn = originalWarn
  }
})

test('default timer does not deliver a 24-hour reminder at its 23-hour timeout cap', async t => {
  const { defaultScheduleAt } = await import('../main/modules/calendar-engine/reminder-scheduler')
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let count = 0
  const handle = defaultScheduleAt(86400, () => { count++ })
  t.mock.timers.tick(23 * 3600000)
  assert.equal(count, 0)
  t.mock.timers.tick(3600000)
  assert.equal(count, 1)
  handle.cancel()
})
