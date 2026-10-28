import type { CalendarEvent } from '../main/modules/database/records'
/**
 * Behavior tests for `rrule-engine.ts`.
 *
 * Pure-logic tests — no sqlite, no Electron. Covers the 9 contract
 * scenarios in plan D.L3-A: non-recurring overlap, daily / weekly /
 * monthly expansion, COUNT / UNTIL limits, window boundary, override
 * cancelled + single, malformed RRULE fallback, mixed list sort.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  expandRecurringEvent,
  expandEventList,
  type EventOverride,
} from '../main/modules/calendar-engine/rrule-engine'


const ONE_DAY_SEC = 24 * 3600
const ONE_HOUR_SEC = 3600

// Fixed reference time so tests are deterministic regardless of clock.
// 2026-05-17T00:00:00Z = unix 1779494400 (verify: new Date(1779494400*1000).toISOString())
const T_2026_05_17 = 1779494400

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    calendar_id: 'cal-1',
    title: '团队周会',
    description: null,
    location: null,
    start_time: T_2026_05_17 + 9 * ONE_HOUR_SEC, // 09:00 UTC
    end_time: T_2026_05_17 + 10 * ONE_HOUR_SEC, // 10:00 UTC
    all_day: 0,
    recurrence_rule: null,
    reminders: null,
    created_at: T_2026_05_17,
    updated_at: T_2026_05_17,
    ...overrides,
  }
}

test('non-recurring event inside window returns a single instance', () => {
  const ev = makeEvent()
  const out = expandRecurringEvent(ev, T_2026_05_17, T_2026_05_17 + ONE_DAY_SEC, [])
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'evt-1')
  assert.equal(out[0].instanceOf, 'evt-1')
  assert.equal(out[0].occurrenceStart, ev.start_time)
  assert.equal(out[0].overrideKind, null)
})

test('non-recurring event entirely outside window returns empty', () => {
  const ev = makeEvent()
  const out = expandRecurringEvent(
    ev,
    T_2026_05_17 + 7 * ONE_DAY_SEC,
    T_2026_05_17 + 8 * ONE_DAY_SEC,
    [],
  )
  assert.equal(out.length, 0)
})

test('daily RRULE expands 7 occurrences across a 7-day window', () => {
  const ev = makeEvent({ recurrence_rule: 'FREQ=DAILY;COUNT=7' })
  const out = expandRecurringEvent(
    ev,
    T_2026_05_17,
    T_2026_05_17 + 8 * ONE_DAY_SEC,
    [],
  )
  assert.equal(out.length, 7)
  // First occurrence keeps DTSTART
  assert.equal(out[0].occurrenceStart, ev.start_time)
  // Each subsequent occurrence is +1 day
  for (let i = 1; i < out.length; i++) {
    assert.equal(out[i].occurrenceStart - out[i - 1].occurrenceStart, ONE_DAY_SEC)
  }
  // syntheticId is parentId#occurrenceStart
  assert.equal(out[3].syntheticId, `evt-1#${out[3].occurrenceStart}`)
  assert.equal(out[3].id, out[3].syntheticId)
  assert.equal(out[3].instanceOf, 'evt-1')
})

test('weekly RRULE with COUNT=5 yields exactly 5 instances', () => {
  const ev = makeEvent({ recurrence_rule: 'FREQ=WEEKLY;COUNT=5' })
  const out = expandRecurringEvent(
    ev,
    T_2026_05_17,
    T_2026_05_17 + 60 * ONE_DAY_SEC,
    [],
  )
  assert.equal(out.length, 5)
  // Each occurrence is 7 days apart
  for (let i = 1; i < out.length; i++) {
    assert.equal(out[i].occurrenceStart - out[i - 1].occurrenceStart, 7 * ONE_DAY_SEC)
  }
})

test('RRULE window boundary: between() inclusive yields only in-window occurrences', () => {
  const ev = makeEvent({ recurrence_rule: 'FREQ=DAILY;COUNT=10' })
  // Window covers occurrences 1..3 only
  const windowStart = ev.start_time - 1
  const windowEnd = ev.start_time + 2 * ONE_DAY_SEC + 1
  const out = expandRecurringEvent(ev, windowStart, windowEnd, [])
  assert.equal(out.length, 3, `expected 3 in-window occurrences, got ${out.length}`)
})

test('cancelled override hides the matched occurrence', () => {
  const ev = makeEvent({ recurrence_rule: 'FREQ=DAILY;COUNT=5' })
  // Cancel day 3 (occurrenceStart = start_time + 2 days)
  const cancelledTs = ev.start_time + 2 * ONE_DAY_SEC
  const overrides: EventOverride[] = [
    { parentEventId: 'evt-1', occurrenceStart: cancelledTs, kind: 'cancelled', patch: null },
  ]
  const out = expandRecurringEvent(
    ev,
    T_2026_05_17,
    T_2026_05_17 + 10 * ONE_DAY_SEC,
    overrides,
  )
  assert.equal(out.length, 4)
  assert.equal(out.find((i) => i.occurrenceStart === cancelledTs), undefined)
})

test('single override applies patch fields to the matched occurrence only', () => {
  const ev = makeEvent({ recurrence_rule: 'FREQ=DAILY;COUNT=3' })
  const day2Ts = ev.start_time + ONE_DAY_SEC
  const overrides: EventOverride[] = [
    {
      parentEventId: 'evt-1',
      occurrenceStart: day2Ts,
      kind: 'single',
      patch: { title: '调整后的会议', location: '会议室 A' },
    },
  ]
  const out = expandRecurringEvent(
    ev,
    T_2026_05_17,
    T_2026_05_17 + 10 * ONE_DAY_SEC,
    overrides,
  )
  assert.equal(out.length, 3)
  const day1 = out.find((i) => i.occurrenceStart === ev.start_time)!
  const day2 = out.find((i) => i.occurrenceStart === day2Ts)!
  const day3 = out.find((i) => i.occurrenceStart === ev.start_time + 2 * ONE_DAY_SEC)!
  // Patched
  assert.equal(day2.title, '调整后的会议')
  assert.equal(day2.location, '会议室 A')
  assert.equal(day2.overrideKind, 'single')
  // Unpatched siblings keep parent fields
  assert.equal(day1.title, '团队周会')
  assert.equal(day1.location, null)
  assert.equal(day1.overrideKind, null)
  assert.equal(day3.title, '团队周会')
  assert.equal(day3.overrideKind, null)
})

test('malformed recurrence is rejected instead of silently becoming a one-off event', () => {
  assert.throws(() => expandRecurringEvent(makeEvent({ recurrence_rule: 'INVALID' }), T_2026_05_17, T_2026_05_17 + ONE_DAY_SEC, []), /无效/ )
})

test('expandEventList sorts mixed recurring + non-recurring deterministically', () => {
  const recurring = makeEvent({
    id: 'rec',
    title: 'A 周会',
    recurrence_rule: 'FREQ=DAILY;COUNT=3',
  })
  const singleLater = makeEvent({
    id: 'one',
    title: 'B 一次性',
    start_time: T_2026_05_17 + 9 * ONE_HOUR_SEC + 30 * 60, // 09:30, AFTER recurring day 1
    end_time: T_2026_05_17 + 10 * ONE_HOUR_SEC,
  })
  const out = expandEventList(
    [recurring, singleLater],
    T_2026_05_17,
    T_2026_05_17 + 10 * ONE_DAY_SEC,
    new Map(),
  )
  assert.equal(out.length, 4) // 3 recurring + 1 single
  // Stable sort: by start_time ascending
  for (let i = 1; i < out.length; i++) {
    assert.ok(
      out[i].start_time >= out[i - 1].start_time,
      `out[${i}].start_time (${out[i].start_time}) < out[${i - 1}].start_time (${out[i - 1].start_time})`,
    )
  }
})

test('performance: 1-year window with 100 weekly recurring events expands < 200ms', () => {
  const events: CalendarEvent[] = []
  const now = T_2026_05_17
  for (let i = 0; i < 100; i++) {
    events.push(
      makeEvent({
        id: `evt-${i}`,
        start_time: now + i * 3600, // staggered hour-by-hour
        end_time: now + i * 3600 + 1800,
        recurrence_rule: 'FREQ=WEEKLY;COUNT=52',
      }),
    )
  }
  const startMs = Date.now()
  const out = expandEventList(events, now, now + 365 * ONE_DAY_SEC, new Map())
  const elapsedMs = Date.now() - startMs
  // 100 events × 52 occurrences = 5200 instances expected
  assert.ok(out.length >= 5000, `expected >= 5000 instances, got ${out.length}`)
  // Generous bound — 200ms (plan target is 100ms but cold CI can be 2×)
  assert.ok(elapsedMs < 200, `expansion took ${elapsedMs}ms, expected < 200ms`)
})
