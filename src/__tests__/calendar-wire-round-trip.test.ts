/**
 * Behavior tests for the calendar IPC wire boundary.
 *
 * These guard against the original "1970 events on refresh" failure
 * mode: DB row with Unix seconds → IPC → renderer → `new Date(seconds)`
 * (treating seconds as ms) → 1970. The fix is `serializeEventToWire`
 * + `parseEventFromWire` as the single boundary helpers.
 *
 * Test contract:
 *   - Snake-case DB rows (with Unix-second times) round-trip to renderer
 *     Date objects whose epoch ms equals `seconds * 1000`.
 *   - Camel-case EventInstance (from rrule-engine) round-trips identically.
 *   - All optional fields normalize to null (not undefined) on the wire.
 *   - Reminders serialize either from a JSON string OR a Reminder[] array.
 *   - Recurrence + override + tz fields survive the round-trip with no
 *     silent loss.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  serializeEventToWire,
  parseEventFromWire,
  serializeSourceToWire,
  type CalendarEventWire,
} from '../shared/calendar-wire'

const T_2026_05_17_09_UTC = Math.floor(Date.UTC(2026, 4, 17, 9, 0, 0) / 1000)

test('DB row (snake_case + unix seconds) → wire → Date does NOT land in 1970', () => {
  // This is the failure mode that motivated the boundary refactor. Pre-fix,
  // `new Date(unixSeconds)` produced a Date around 1970-01-21. We assert
  // that the round-trip lands on the correct year (2026) AND the correct
  // wall-clock hour.
  const dbRow = {
    id: 'evt-1',
    calendar_id: 'cal-1',
    title: '团队周会',
    description: null,
    location: '会议室 A',
    start_time: T_2026_05_17_09_UTC,
    end_time: T_2026_05_17_09_UTC + 3600,
    all_day: 0,
    recurrence_rule: null,
    reminders: null,
    start_tz: 'Asia/Shanghai',
    end_tz: 'Asia/Shanghai',
    created_at: T_2026_05_17_09_UTC,
    updated_at: T_2026_05_17_09_UTC,
    ics_uid: null,
    source_id: null,
  }
  const wire = serializeEventToWire(dbRow)
  assert.equal(wire.startTime, T_2026_05_17_09_UTC, 'wire keeps Unix seconds')
  assert.equal(wire.calendarId, 'cal-1', 'snake_case calendar_id → camelCase calendarId')
  assert.equal(wire.location, '会议室 A')
  assert.equal(wire.startTz, 'Asia/Shanghai', 'snake start_tz → camel startTz')
  const parsed = parseEventFromWire(wire)
  assert.equal(parsed.startTime.getUTCFullYear(), 2026, 'parsed date is in 2026 (not 1970)')
  assert.equal(parsed.startTime.getUTCMonth(), 4, 'May (0-indexed)')
  assert.equal(parsed.startTime.getUTCDate(), 17)
  assert.equal(parsed.startTime.getUTCHours(), 9)
  assert.equal(parsed.startTime.getTime(), T_2026_05_17_09_UTC * 1000)
})

test('EventInstance (camelCase + instance fields) → wire → parsed retains instance shape', () => {
  // rrule-engine emits EventInstance with camelCase already; the boundary
  // serializer still routes them through the same `serializeEventToWire`
  // so the renderer gets ONE shape for both kinds of input.
  const instance = {
    id: 'evt-recurring#1779600000',
    calendar_id: 'cal-work',
    title: '每日站会',
    description: null,
    location: null,
    start_time: 1779600000,
    end_time: 1779601800,
    all_day: 0,
    recurrence_rule: 'FREQ=DAILY;COUNT=10',
    reminders: null,
    start_tz: null,
    end_tz: null,
    created_at: 1779494400,
    updated_at: 1779494400,
    instanceOf: 'evt-recurring',
    occurrenceStart: 1779600000,
    syntheticId: 'evt-recurring#1779600000',
    overrideKind: null as 'single' | 'cancelled' | null,
  }
  const wire = serializeEventToWire(instance)
  assert.equal(wire.instanceOf, 'evt-recurring')
  assert.equal(wire.syntheticId, 'evt-recurring#1779600000')
  assert.equal(wire.occurrenceStart, 1779600000)
  assert.equal(wire.overrideKind, null)
  const parsed = parseEventFromWire(wire)
  assert.ok(parsed.occurrenceStart instanceof Date)
  assert.equal(parsed.occurrenceStart.getTime(), 1779600000 * 1000)
})

test('non-recurring single event: instanceOf / syntheticId default to id', () => {
  const wire = serializeEventToWire({
    id: 'single-1',
    calendar_id: 'cal-1',
    title: '一次性',
    description: null,
    location: null,
    start_time: T_2026_05_17_09_UTC,
    end_time: T_2026_05_17_09_UTC + 3600,
    all_day: 0,
  })
  assert.equal(wire.instanceOf, 'single-1')
  assert.equal(wire.syntheticId, 'single-1')
  assert.equal(wire.occurrenceStart, T_2026_05_17_09_UTC)
})

test('reminders as JSON string in row is decoded to Reminder[]', () => {
  const wire = serializeEventToWire({
    id: 'evt-r',
    calendar_id: 'c',
    title: 't',
    description: null,
    location: null,
    start_time: T_2026_05_17_09_UTC,
    end_time: T_2026_05_17_09_UTC + 3600,
    all_day: 0,
    reminders: JSON.stringify([
      { offsetMinutes: -15, method: 'notification' },
      { offsetMinutes: -60, method: 'sound' },
    ]),
  })
  assert.ok(Array.isArray(wire.reminders))
  assert.equal(wire.reminders?.length, 2)
  assert.equal(wire.reminders?.[0].offsetMinutes, -15)
  assert.equal(wire.reminders?.[1].method, 'sound')
})

test('reminders already as array passes through untouched', () => {
  const wire = serializeEventToWire({
    id: 'e',
    calendar_id: 'c',
    title: 't',
    description: null,
    location: null,
    start_time: T_2026_05_17_09_UTC,
    end_time: T_2026_05_17_09_UTC + 3600,
    all_day: 0,
    reminders: [{ offsetMinutes: -30, method: 'notification' }],
  })
  assert.deepEqual(wire.reminders, [{ offsetMinutes: -30, method: 'notification' }])
})

test('reminders as malformed JSON string degrades to null (not throw)', () => {
  const wire = serializeEventToWire({
    id: 'e',
    calendar_id: 'c',
    title: 't',
    description: null,
    location: null,
    start_time: T_2026_05_17_09_UTC,
    end_time: T_2026_05_17_09_UTC + 3600,
    all_day: 0,
    reminders: '{not valid json',
  })
  assert.equal(wire.reminders, null)
})

test('missing description / location become null (not undefined)', () => {
  const wire = serializeEventToWire({
    id: 'e',
    calendar_id: 'c',
    title: 't',
    start_time: T_2026_05_17_09_UTC,
    end_time: T_2026_05_17_09_UTC + 3600,
    all_day: 0,
  })
  assert.equal(wire.description, null)
  assert.equal(wire.location, null)
  assert.equal(wire.startTz, null)
  assert.equal(wire.endTz, null)
  assert.equal(wire.icsUid, null)
  assert.equal(wire.sourceId, null)
  assert.equal(wire.recurrenceRule, null)
  assert.equal(wire.reminders, null)
})

test('source: snake_case sync_url / sync_interval round-trip to camelCase', () => {
  const sourceRow = {
    id: 'cal-ics',
    name: '订阅日历',
    color: '#34D399',
    type: 'external',
    sync_url: 'https://example.com/cal.ics',
    sync_interval: 30,
    enabled: 1,
    created_at: T_2026_05_17_09_UTC,
  }
  const wire = serializeSourceToWire(sourceRow)
  assert.equal(wire.syncUrl, 'https://example.com/cal.ics')
  assert.equal(wire.syncInterval, 30)
  assert.equal(wire.enabled, true)
  assert.equal(wire.createdAt, T_2026_05_17_09_UTC)
})

test('source: missing sync_url stays null', () => {
  const wire = serializeSourceToWire({
    id: 'cal-local',
    name: '本地',
    sync_url: null,
    sync_interval: 60,
    enabled: 1,
  })
  assert.equal(wire.syncUrl, null)
})

test('round-trip: 100-event batch keeps every event in correct year (no 1970 regression)', () => {
  // Stress test: a pre-fix bug would only show on real data when wired
  // through the IPC; here we simulate by pushing 100 rows through and
  // ensuring every parsed startTime year >= 2025. This is the gate that
  // would have caught the original bug if it had been in place.
  const baseYear = 2026
  const oneYearSeconds = 365 * 24 * 3600
  const wires: CalendarEventWire[] = []
  for (let i = 0; i < 100; i++) {
    wires.push(
      serializeEventToWire({
        id: `e-${i}`,
        calendar_id: 'c',
        title: `event ${i}`,
        description: null,
        location: null,
        start_time: T_2026_05_17_09_UTC + i * 3600,
        end_time: T_2026_05_17_09_UTC + i * 3600 + 1800,
        all_day: 0,
      }),
    )
  }
  for (const w of wires) {
    const parsed = parseEventFromWire(w)
    assert.ok(parsed.startTime.getUTCFullYear() >= baseYear,
      `event ${w.id} parsed startTime ${parsed.startTime.toISOString()} is before ${baseYear}`)
    assert.ok(parsed.startTime.getTime() > oneYearSeconds * 1000,
      `event ${w.id} parsed startTime ms is suspiciously close to epoch`)
  }
})
