/**
 * Behavior tests for `ics-importer.ts`.
 *
 * Pure-logic tests — no DB / electron / network. Inline ICS fixtures
 * cover the contract scenarios in plan D.L4-B:
 *   - simple VEVENT (title / time / location / description)
 *   - ALLDAY event (DATE-only DTSTART)
 *   - timezone (DTSTART;TZID=...)
 *   - recurring (RRULE present)
 *   - malformed (no SUMMARY → skip+warn)
 *   - malformed (no DTSTART → skip+warn)
 *   - top-level malformed (missing BEGIN:VCALENDAR → throws)
 *
 * §6.17 behavior-test discipline: each test calls the real parser and
 * asserts on the structured result; no source-grep / no skip-as-pass.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { parseIcsString, type ImportedEvent } from '../main/modules/calendar-engine/ics-importer'

// ----- fixtures ----------------------------------------------------------

/**
 * Wrap a VEVENT block in the canonical VCALENDAR wrapper. Convenience
 * so each fixture stays compact and we don't repeat the boilerplate.
 */
function wrap(vevent: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ready//ICS Importer Test//EN',
    vevent,
    'END:VCALENDAR',
  ].join('\r\n')
}

const SIMPLE_VEVENT = wrap([
  'BEGIN:VEVENT',
  'UID:simple-evt-1@example.test',
  'SUMMARY:团队周会',
  'DESCRIPTION:每周进度同步',
  'LOCATION:北京办公室 3 楼会议室',
  'DTSTART:20260517T010000Z',
  'DTEND:20260517T020000Z',
  'END:VEVENT',
].join('\r\n'))

const ALLDAY_VEVENT = wrap([
  'BEGIN:VEVENT',
  'UID:allday-evt-1@example.test',
  'SUMMARY:周年纪念',
  'DTSTART;VALUE=DATE:20260517',
  'DTEND;VALUE=DATE:20260518',
  'END:VEVENT',
].join('\r\n'))

const TZID_VEVENT = wrap([
  // ical.js requires a VTIMEZONE block for TZID; provide one so the
  // event resolves a real zone instead of falling back to floating.
  'BEGIN:VTIMEZONE',
  'TZID:Asia/Shanghai',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0800',
  'TZOFFSETTO:+0800',
  'TZNAME:CST',
  'DTSTART:19700101T000000',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:tzid-evt-1@example.test',
  'SUMMARY:跨时区会议',
  'DTSTART;TZID=Asia/Shanghai:20260517T090000',
  'DTEND;TZID=Asia/Shanghai:20260517T100000',
  'END:VEVENT',
].join('\r\n'))

const RRULE_VEVENT = wrap([
  'BEGIN:VEVENT',
  'UID:rrule-evt-1@example.test',
  'SUMMARY:每周复盘',
  'DTSTART:20260517T010000Z',
  'DTEND:20260517T020000Z',
  'RRULE:FREQ=WEEKLY;COUNT=10',
  'END:VEVENT',
].join('\r\n'))

const NO_SUMMARY_VEVENT = wrap([
  'BEGIN:VEVENT',
  'UID:no-summary-evt-1@example.test',
  'DTSTART:20260517T010000Z',
  'DTEND:20260517T020000Z',
  'END:VEVENT',
].join('\r\n'))

const NO_DTSTART_VEVENT = wrap([
  'BEGIN:VEVENT',
  'UID:no-dtstart-evt-1@example.test',
  'SUMMARY:坏事件',
  'END:VEVENT',
].join('\r\n'))

const MIXED_VALID_INVALID = wrap([
  'BEGIN:VEVENT',
  'UID:mixed-good-1@example.test',
  'SUMMARY:有效事件',
  'DTSTART:20260517T010000Z',
  'DTEND:20260517T020000Z',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:mixed-bad-1@example.test',
  'DTSTART:20260518T010000Z',
  // no SUMMARY
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:mixed-good-2@example.test',
  'SUMMARY:第二个有效',
  'DTSTART:20260519T010000Z',
  'DTEND:20260519T020000Z',
  'END:VEVENT',
].join('\r\n'))

const MISSING_DTEND = wrap([
  'BEGIN:VEVENT',
  'UID:no-end-evt-1@example.test',
  'SUMMARY:瞬间事件',
  'DTSTART:20260517T010000Z',
  'END:VEVENT',
].join('\r\n'))

// 2026-05-17T01:00:00Z = unix 1778979600 (verify in REPL:
// new Date(1778979600 * 1000).toISOString())
const T_2026_05_17_0100_UTC = 1778979600

// ----- happy paths -------------------------------------------------------

test('parses a simple VEVENT with title / time / location / description', () => {
  const out = parseIcsString(SIMPLE_VEVENT)
  assert.equal(out.length, 1)
  const ev: ImportedEvent = out[0]
  assert.equal(ev.uid, 'simple-evt-1@example.test')
  assert.equal(ev.title, '团队周会')
  assert.equal(ev.description, '每周进度同步')
  assert.equal(ev.location, '北京办公室 3 楼会议室')
  assert.equal(ev.startTime, T_2026_05_17_0100_UTC)
  assert.equal(ev.endTime, T_2026_05_17_0100_UTC + 3600)
  assert.equal(ev.allDay, false)
  // ical.js returns 'UTC' as the IANA identifier for Z-suffixed times.
  // We preserve that verbatim — `null` is reserved for "no explicit
  // zone at all" (floating wall-clock), which is semantically different.
  assert.equal(ev.startTz, 'UTC')
  assert.equal(ev.endTz, 'UTC')
  assert.equal(ev.recurrenceRule, null)
})

test('parses an ALL-DAY VEVENT (DATE-only DTSTART) and sets allDay=true', () => {
  const out = parseIcsString(ALLDAY_VEVENT)
  assert.equal(out.length, 1)
  const ev = out[0]
  assert.equal(ev.allDay, true)
  assert.equal(ev.title, '周年纪念')
  // For DATE-only values ical.js returns midnight UTC of the date;
  // the exact second is implementation-defined but we can assert that
  // start <= end and both fall on May 17 / 18 2026 in UTC.
  assert.ok(Number.isFinite(ev.startTime), 'startTime is finite')
  assert.ok(Number.isFinite(ev.endTime), 'endTime is finite')
  assert.ok(ev.endTime > ev.startTime, 'endTime > startTime')
})

test('parses a TZID VEVENT and preserves the IANA zone in startTz / endTz', () => {
  const out = parseIcsString(TZID_VEVENT)
  assert.equal(out.length, 1)
  const ev = out[0]
  assert.equal(ev.title, '跨时区会议')
  assert.equal(ev.startTz, 'Asia/Shanghai')
  assert.equal(ev.endTz, 'Asia/Shanghai')
  // The wall-clock is 2026-05-17 09:00 Shanghai = 2026-05-17 01:00 UTC.
  assert.equal(ev.startTime, T_2026_05_17_0100_UTC)
  assert.equal(ev.endTime, T_2026_05_17_0100_UTC + 3600)
})

test('parses a recurring VEVENT and preserves the RRULE body without prefix', () => {
  const out = parseIcsString(RRULE_VEVENT)
  assert.equal(out.length, 1)
  const ev = out[0]
  assert.equal(ev.title, '每周复盘')
  assert.ok(ev.recurrenceRule, 'recurrenceRule is non-null')
  // Body must not contain the leading `RRULE:` prefix and must
  // include the documented FREQ=WEEKLY clause.
  assert.ok(!/^RRULE:/i.test(ev.recurrenceRule!), 'no RRULE: prefix')
  assert.ok(/FREQ=WEEKLY/i.test(ev.recurrenceRule!), 'FREQ=WEEKLY present')
  assert.ok(/COUNT=10/i.test(ev.recurrenceRule!), 'COUNT=10 present')
})

test('falls back to startTime when VEVENT has no DTEND', () => {
  const out = parseIcsString(MISSING_DTEND)
  assert.equal(out.length, 1)
  const ev = out[0]
  assert.equal(ev.startTime, T_2026_05_17_0100_UTC)
  assert.equal(ev.endTime, T_2026_05_17_0100_UTC)
})

// ----- malformed / partial -----------------------------------------------

test('skips VEVENT with empty SUMMARY and logs a warning', () => {
  const originalWarn = console.warn
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    const out = parseIcsString(NO_SUMMARY_VEVENT)
    assert.equal(out.length, 0, 'no events returned')
    assert.ok(
      warnings.some((w) => /empty SUMMARY/i.test(w)),
      'warning mentions empty SUMMARY',
    )
  } finally {
    console.warn = originalWarn
  }
})

test('skips VEVENT with missing DTSTART and logs a warning', () => {
  const originalWarn = console.warn
  const warnings: string[] = []
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    const out = parseIcsString(NO_DTSTART_VEVENT)
    assert.equal(out.length, 0)
    assert.ok(
      warnings.some((w) => /DTSTART/i.test(w)),
      'warning mentions DTSTART',
    )
  } finally {
    console.warn = originalWarn
  }
})

test('partial import: keeps valid events even when one in the middle is broken', () => {
  const originalWarn = console.warn
  console.warn = () => { /* mute during this test */ }
  try {
    const out = parseIcsString(MIXED_VALID_INVALID)
    assert.equal(out.length, 2, 'two valid events surface')
    const uids = out.map((e) => e.uid).sort()
    assert.deepEqual(uids, ['mixed-good-1@example.test', 'mixed-good-2@example.test'])
  } finally {
    console.warn = originalWarn
  }
})

// ----- top-level malformed ----------------------------------------------

test('throws on missing BEGIN:VCALENDAR wrapper', () => {
  assert.throws(
    () => parseIcsString('BEGIN:VEVENT\r\nUID:x\r\nSUMMARY:y\r\nEND:VEVENT\r\n'),
    /Invalid ICS/,
  )
})

test('throws on missing END:VCALENDAR wrapper', () => {
  assert.throws(
    () => parseIcsString('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:y\r\nDTSTART:20260517T010000Z\r\nEND:VEVENT\r\n'),
    /Invalid ICS/,
  )
})

test('throws on empty input', () => {
  assert.throws(() => parseIcsString(''), /non-empty/i)
})

test('empty VCALENDAR (no VEVENTs) returns empty array, not error', () => {
  const empty = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n'
  const out = parseIcsString(empty)
  assert.deepEqual(out, [])
})
