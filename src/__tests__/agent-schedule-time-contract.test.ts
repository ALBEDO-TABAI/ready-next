import assert from 'node:assert/strict'
import test from 'node:test'

import { getNextScheduleRuns } from '../main/modules/scheduled-tasks/schedule-next-run'
import { ScheduleSpecError } from '../main/modules/scheduled-tasks/schedule-spec'
import {
  assertOccurrenceTransition,
  createScheduledOccurrenceId,
  reconcileMissedOccurrences,
} from '../main/modules/scheduled-tasks/schedule-occurrence-state'

test('previews once, daily, workday, weekly, monthly, yearly, interval, and custom calendar rules', () => {
  const after = '2026-07-13T00:00:00Z'
  const timezone = 'Asia/Singapore'
  assert.deepEqual(getNextScheduleRuns({ spec: { kind: 'once', localDate: '2026-07-14', localTime: '09:00' }, timezone, after }), ['2026-07-14T01:00:00Z'])
  assert.equal(getNextScheduleRuns({ spec: { kind: 'calendar', frequency: 'daily', localTime: '09:00' }, timezone, after })[0], '2026-07-13T01:00:00Z')
  assert.deepEqual(getNextScheduleRuns({ spec: { kind: 'calendar', frequency: 'daily', localTime: '09:00', weekdays: [1, 2, 3, 4, 5] }, timezone, after }), ['2026-07-13T01:00:00Z', '2026-07-14T01:00:00Z', '2026-07-15T01:00:00Z'])
  assert.deepEqual(getNextScheduleRuns({ spec: { kind: 'calendar', frequency: 'weekly', localTime: '10:30', weekdays: [1, 3] }, timezone, after }), ['2026-07-13T02:30:00Z', '2026-07-15T02:30:00Z', '2026-07-20T02:30:00Z'])
  assert.equal(getNextScheduleRuns({ spec: { kind: 'calendar', frequency: 'monthly', localTime: '08:00', dayOfMonth: 31 }, timezone, after })[0], '2026-07-31T00:00:00Z')
  assert.equal(getNextScheduleRuns({ spec: { kind: 'calendar', frequency: 'yearly', localTime: '08:00', months: [12], dayOfMonth: 25 }, timezone, after })[0], '2026-12-25T00:00:00Z')
  assert.deepEqual(getNextScheduleRuns({ spec: { kind: 'interval', every: 5, unit: 'minute', anchorAt: '2026-07-13T00:00:00Z' }, timezone, after }), ['2026-07-13T00:05:00Z', '2026-07-13T00:10:00Z', '2026-07-13T00:15:00Z'])
  assert.equal(getNextScheduleRuns({ spec: { kind: 'calendar', frequency: 'daily', localTime: '12:00', weekdays: [2, 4], months: [8] }, timezone, after })[0], '2026-08-04T04:00:00Z')
})

test('uses IANA zones across date boundaries and non-integer offsets', () => {
  assert.equal(getNextScheduleRuns({ spec: { kind: 'calendar', frequency: 'daily', localTime: '00:15' }, timezone: 'Asia/Kathmandu', after: '2026-07-13T18:20:00Z', count: 1 })[0], '2026-07-13T18:30:00Z')
})

test('moves a nonexistent spring time forward and emits a repeated fall time once', () => {
  assert.equal(getNextScheduleRuns({ spec: { kind: 'once', localDate: '2026-03-08', localTime: '02:30' }, timezone: 'America/New_York', after: '2026-03-08T00:00:00Z' })[0], '2026-03-08T07:00:00Z')
  assert.deepEqual(getNextScheduleRuns({ spec: { kind: 'once', localDate: '2026-11-01', localTime: '01:30' }, timezone: 'America/New_York', after: '2026-11-01T00:00:00Z' }), ['2026-11-01T05:30:00Z'])
})

test('skips months that do not contain the requested day', () => {
  assert.deepEqual(getNextScheduleRuns({ spec: { kind: 'calendar', frequency: 'monthly', localTime: '09:00', dayOfMonth: 31 }, timezone: 'UTC', after: '2026-04-01T00:00:00Z', count: 3 }), ['2026-05-31T09:00:00Z', '2026-07-31T09:00:00Z', '2026-08-31T09:00:00Z'])
})

test('rejects seconds, short intervals, invalid dates, and exhausted rules', () => {
  const cases = [
    () => getNextScheduleRuns({ spec: { kind: 'calendar', frequency: 'daily', localTime: '09:00:30' }, timezone: 'UTC', after: '2026-01-01T00:00:00Z' }),
    () => getNextScheduleRuns({ spec: { kind: 'interval', every: 4, unit: 'minute', anchorAt: '2026-01-01T00:00:00Z' }, timezone: 'UTC', after: '2026-01-01T00:00:00Z' }),
    () => getNextScheduleRuns({ spec: { kind: 'once', localDate: '2026-02-30', localTime: '09:00' }, timezone: 'UTC', after: '2026-01-01T00:00:00Z' }),
    () => getNextScheduleRuns({ spec: { kind: 'calendar', frequency: 'daily', localTime: '09:00', until: '2025-12-31' }, timezone: 'UTC', after: '2026-01-01T00:00:00Z' }),
  ]
  for (const run of cases) assert.throws(run, ScheduleSpecError)
})

test('coalesces recurring missed times, preserves once, and supports skip policy', () => {
  const now = '2026-07-13T12:00:00Z'
  assert.deepEqual(reconcileMissedOccurrences({ dueScheduledFor: ['2026-07-13T10:00:00Z'], now, recurring: false, policy: 'coalesce_latest' }).map((item) => item.status), ['queued'])
  assert.deepEqual(reconcileMissedOccurrences({ dueScheduledFor: ['2026-07-13T08:00:00Z', '2026-07-13T09:00:00Z', '2026-07-13T10:00:00Z'], now, recurring: true, policy: 'coalesce_latest' }).map((item) => item.status), ['skipped_coalesced', 'skipped_coalesced', 'queued'])
  assert.deepEqual(reconcileMissedOccurrences({ dueScheduledFor: ['2026-07-10T10:00:00Z'], now, recurring: true, policy: 'coalesce_latest' }).map((item) => item.status), ['skipped_missed'])
  assert.deepEqual(reconcileMissedOccurrences({ dueScheduledFor: ['2026-07-13T10:00:00Z'], now, recurring: false, policy: 'skip' }).map((item) => item.status), ['skipped_missed'])
})

test('occurrence identity is stable and state transitions reject terminal replay', () => {
  const input = { scheduleId: 'schedule-1', scheduledFor: '2026-07-13T10:00:00Z', triggerSource: 'startup' as const }
  assert.equal(createScheduledOccurrenceId(input), createScheduledOccurrenceId({ ...input, triggerSource: 'resume' }))
  assert.doesNotThrow(() => assertOccurrenceTransition('queued', 'dispatching'))
  assert.throws(() => assertOccurrenceTransition('dispatched', 'dispatching'))
})
