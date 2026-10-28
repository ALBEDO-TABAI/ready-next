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

test('CalendarListWindowSchema uses the frozen turn window when bounds are omitted', () => {
  assert.equal(
    CalendarListWindowSchema.safeParse({ start: '2026-04-22', end: '2026-04-23' }).success,
    true,
  )
  assert.equal(CalendarListWindowSchema.safeParse({ start: '2026-04-22' }).success, true)
  assert.equal(CalendarListWindowSchema.safeParse({}).success, true)
})

test('CalendarCreateEventSchema requires a title and a complete timed or all-day range', () => {
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
  assert.equal(CalendarCreateEventSchema.safeParse({title:'Day',allDay:true,startDate:'2026-10-28',endDate:'2026-10-29'}).success,true)
})

test('CalendarUpdateEventSchema can use the frozen event target when id is omitted', () => {
  assert.equal(CalendarUpdateEventSchema.safeParse({ id: 'e-1' }).success, true)
  assert.equal(CalendarUpdateEventSchema.safeParse({}).success, true)
  assert.equal(
    CalendarUpdateEventSchema.safeParse({ id: 'e-1', title: '新' }).success,
    true,
  )
})

test('CalendarDeleteEventSchema can use the frozen event target when id is omitted', () => {
  assert.equal(CalendarDeleteEventSchema.safeParse({ id: 'e-1' }).success, true)
  assert.equal(CalendarDeleteEventSchema.safeParse({}).success, true)
})

test('CalendarCaptureSessionSchema accepts empty object', () => {
  assert.equal(CalendarCaptureSessionSchema.safeParse({}).success, true)
})
