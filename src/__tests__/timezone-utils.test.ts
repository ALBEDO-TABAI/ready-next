/**
 * Behavior tests for `src/main/modules/calendar-engine/timezone-utils.ts`.
 *
 * The helpers are pure — no electron / better-sqlite3 / IPC. We only
 * exercise the wall-clock-arithmetic contracts written down in the
 * module's docblock:
 *   1. `moveWallClockBetweenZones` preserves wall-clock fields when
 *      crossing IANA zones, yielding a different Unix instant.
 *   2. DST transitions are honored automatically.
 *   3. `formatInTimezone` resolves zone-aware date/time fields.
 *   4. Bad IANA identifiers throw and propagate (no silent UTC fallback).
 *   5. UTC round-trips are no-ops.
 *
 * These tests assert behavior of the LIVE module, not a mock — the
 * `@js-temporal/polyfill` dependency is already loaded in normal Node
 * runtime (used elsewhere in the renderer entry).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Temporal } from '@js-temporal/polyfill'

import {
  moveWallClockBetweenZones,
  formatInTimezone,
  sameWallClockHour,
} from '../main/modules/calendar-engine/timezone-utils'

/**
 * Helper — produce the Unix seconds corresponding to a given wall-clock
 * in a given zone. Used by tests to phrase expectations in terms of
 * "what does 09:00-in-Shanghai mean as a Unix second" instead of having
 * to bake hard-coded numbers.
 */
function wallClockInZoneToUnixSec(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const zdt = Temporal.ZonedDateTime.from({
    timeZone: tz,
    year,
    month,
    day,
    hour,
    minute,
  })
  return Math.floor(zdt.epochMilliseconds / 1000)
}

test('moveWallClockBetweenZones: 09:00 Shanghai → 09:00 New York is NOT the same Unix instant', () => {
  // 2026-05-17 09:00 in Asia/Shanghai
  const shanghai9am = wallClockInZoneToUnixSec(2026, 5, 17, 9, 0, 'Asia/Shanghai')
  // After the conversion we expect a Unix instant whose wall-clock in
  // New York reads 09:00 on the same calendar date. Because NY is ~13h
  // behind Shanghai in May (EDT = UTC-4, Shanghai = UTC+8) the
  // resulting Unix instant is later (≈13 hours later) than the input.
  const ny9am = moveWallClockBetweenZones(shanghai9am, 'Asia/Shanghai', 'America/New_York')
  assert.notEqual(ny9am, shanghai9am, 'Unix instants must differ — they share wall-clock string, not absolute time')

  // Independently rebuild "2026-05-17 09:00 in NY" and check equality.
  const ny9amExpected = wallClockInZoneToUnixSec(2026, 5, 17, 9, 0, 'America/New_York')
  assert.equal(ny9am, ny9amExpected, 'output Unix must equal what 09:00-in-NY translates to')
})

test('moveWallClockBetweenZones: round-trip (A→B then B→A) lands back on the original wall-clock', () => {
  const start = wallClockInZoneToUnixSec(2026, 8, 1, 14, 30, 'Asia/Tokyo')
  const ny = moveWallClockBetweenZones(start, 'Asia/Tokyo', 'America/New_York')
  const back = moveWallClockBetweenZones(ny, 'America/New_York', 'Asia/Tokyo')
  assert.equal(back, start, 'wall-clock 14:30 Tokyo → NY → Tokyo round-trips')
})

test('moveWallClockBetweenZones: DST boundary (2026-03-08 → 03-09 in America/New_York)', () => {
  // 2026-03-08 02:00 doesn't exist in America/New_York (clocks jump
  // 02:00 → 03:00 EDT on the second Sunday in March). We deliberately
  // exercise 03:00 (which DOES exist post-spring-forward) and verify
  // the converted instant lands on the DST-shifted offset.
  const before = wallClockInZoneToUnixSec(2026, 3, 7, 23, 0, 'America/New_York') // EST = UTC-5
  const after = wallClockInZoneToUnixSec(2026, 3, 8, 3, 0, 'America/New_York') // EDT = UTC-4

  // Move the same wall-clock from Shanghai (no DST) to NY across DST
  // boundary — DST behavior should match the NY-native instant, not a
  // naive UTC offset.
  const shanghaiInstant = wallClockInZoneToUnixSec(2026, 3, 8, 3, 0, 'Asia/Shanghai')
  const ny = moveWallClockBetweenZones(shanghaiInstant, 'Asia/Shanghai', 'America/New_York')
  assert.equal(ny, after, 'DST: 03:00 wall-clock in NY uses EDT (UTC-4) on 2026-03-08')
  assert.notEqual(before, after, 'sanity: pre/post DST instants should differ in offset')
})

test('formatInTimezone: same Unix second renders different wall-clocks across zones', () => {
  // Pick a fixed instant — formatting should reflect its rendering in
  // each requested zone.
  const t = 1779000000 // arbitrary 2026 instant
  const shanghai = formatInTimezone(t, 'Asia/Shanghai')
  const ny = formatInTimezone(t, 'America/New_York')
  const utc = formatInTimezone(t, 'UTC')

  // The three should differ on at least one of date or time. They
  // CAN coincidentally share `date` if the instant straddles
  // midnight in some zone; rather than over-constrain, we just check
  // not-all-equal.
  const triples = [
    `${shanghai.date} ${shanghai.time}`,
    `${ny.date} ${ny.time}`,
    `${utc.date} ${utc.time}`,
  ]
  assert.notEqual(triples[0], triples[1], 'Shanghai vs NY render must differ')
  assert.notEqual(triples[0], triples[2], 'Shanghai vs UTC render must differ')
})

test('formatInTimezone: hour12 option produces AM/PM format', () => {
  // 2026-05-17 14:30 in UTC
  const t = wallClockInZoneToUnixSec(2026, 5, 17, 14, 30, 'UTC')
  const { date, time } = formatInTimezone(t, 'UTC', { hour12: true })
  assert.equal(date, '2026-05-17')
  // 14:30 → 2:30 PM
  assert.equal(time, '2:30 PM')

  // Midnight edge — 00:30 should render as 12:30 AM in hour12.
  const midnight = wallClockInZoneToUnixSec(2026, 5, 17, 0, 30, 'UTC')
  const midnightFmt = formatInTimezone(midnight, 'UTC', { hour12: true })
  assert.equal(midnightFmt.time, '12:30 AM')

  // Noon edge — 12:30 should render as 12:30 PM in hour12.
  const noon = wallClockInZoneToUnixSec(2026, 5, 17, 12, 30, 'UTC')
  const noonFmt = formatInTimezone(noon, 'UTC', { hour12: true })
  assert.equal(noonFmt.time, '12:30 PM')
})

test('formatInTimezone: UTC round-trip preserves wall-clock fields', () => {
  const t = wallClockInZoneToUnixSec(2026, 12, 31, 23, 45, 'UTC')
  const { date, time } = formatInTimezone(t, 'UTC')
  assert.equal(date, '2026-12-31')
  assert.equal(time, '23:45')
})

test('moveWallClockBetweenZones + formatInTimezone: UTC → UTC is identity', () => {
  const t = wallClockInZoneToUnixSec(2026, 1, 1, 0, 0, 'UTC')
  const moved = moveWallClockBetweenZones(t, 'UTC', 'UTC')
  assert.equal(moved, t)
  const fmt = formatInTimezone(moved, 'UTC')
  assert.equal(fmt.date, '2026-01-01')
  assert.equal(fmt.time, '00:00')
})

test('invalid IANA timezone identifier throws (no silent UTC fallback)', () => {
  // Both helpers should bubble Temporal's own error rather than
  // pretending the bad zone resolved to UTC. Catching this in product
  // code is the caller's responsibility.
  assert.throws(
    () => moveWallClockBetweenZones(1779000000, 'Foo/Bar', 'UTC'),
    /Foo\/Bar|invalid|time zone/i,
  )
  assert.throws(
    () => formatInTimezone(1779000000, 'Not_A/Zone'),
    /Not_A\/Zone|invalid|time zone/i,
  )
  assert.throws(
    () => sameWallClockHour(1779000000, 'UTC', 1779000000, 'Also/Bad'),
    /Also\/Bad|invalid|time zone/i,
  )
})

test('sameWallClockHour: returns true when hour-of-day matches across zones', () => {
  // 09:30 in Shanghai (UTC+8) and 09:45 in New York (UTC-4 in May)
  // are 13:15h apart absolute time but share hour-of-day 9.
  const shanghai930 = wallClockInZoneToUnixSec(2026, 5, 17, 9, 30, 'Asia/Shanghai')
  const ny945 = wallClockInZoneToUnixSec(2026, 5, 17, 9, 45, 'America/New_York')
  assert.equal(
    sameWallClockHour(shanghai930, 'Asia/Shanghai', ny945, 'America/New_York'),
    true,
    'both render at hour=9 in their respective zones',
  )

  // 09:00 vs 10:00 — different hour-of-day.
  const ny1000 = wallClockInZoneToUnixSec(2026, 5, 17, 10, 0, 'America/New_York')
  assert.equal(
    sameWallClockHour(shanghai930, 'Asia/Shanghai', ny1000, 'America/New_York'),
    false,
  )
})
