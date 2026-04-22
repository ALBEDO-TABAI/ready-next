/**
 * Shape tests for the calendar domain Zod schemas (Phase 2.5 PR 4).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CalendarListWindowSchema,
  CalendarCreateEventSchema,
  CalendarUpdateEventSchema,
  CalendarDeleteEventSchema,
  CalendarCaptureSessionSchema,
} from '../main/modules/tools/schemas/calendar-schemas'

test('CalendarListWindowSchema requires start + end', () => {
  assert.equal(
    CalendarListWindowSchema.safeParse({ start: '2026-04-22', end: '2026-04-23' }).success,
    true,
  )
  assert.equal(CalendarListWindowSchema.safeParse({ start: '2026-04-22' }).success, false)
  assert.equal(CalendarListWindowSchema.safeParse({}).success, false)
})

test('CalendarCreateEventSchema requires title + startTime + endTime, others optional', () => {
  assert.equal(
    CalendarCreateEventSchema.safeParse({
      title: '会议',
      startTime: '2026-04-22T09:00:00Z',
      endTime: '2026-04-22T10:00:00Z',
    }).success,
    true,
  )
  assert.equal(
    CalendarCreateEventSchema.safeParse({
      title: '会议',
      startTime: '2026-04-22T09:00:00Z',
      endTime: '2026-04-22T10:00:00Z',
      calendarId: 'cal-1',
      description: '描述',
    }).success,
    true,
  )
  assert.equal(CalendarCreateEventSchema.safeParse({ title: 't' }).success, false)
})

test('CalendarUpdateEventSchema requires id; all other fields optional', () => {
  assert.equal(CalendarUpdateEventSchema.safeParse({ id: 'e-1' }).success, true)
  assert.equal(CalendarUpdateEventSchema.safeParse({}).success, false)
  assert.equal(
    CalendarUpdateEventSchema.safeParse({ id: 'e-1', title: '新' }).success,
    true,
  )
})

test('CalendarDeleteEventSchema requires id', () => {
  assert.equal(CalendarDeleteEventSchema.safeParse({ id: 'e-1' }).success, true)
  assert.equal(CalendarDeleteEventSchema.safeParse({}).success, false)
})

test('CalendarCaptureSessionSchema accepts empty object', () => {
  assert.equal(CalendarCaptureSessionSchema.safeParse({}).success, true)
})
