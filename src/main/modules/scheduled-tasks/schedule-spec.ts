import { Temporal } from '@js-temporal/polyfill'
import type { ScheduleSpecV1 } from '../../../shared/scheduled-tasks'

const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/

export class ScheduleSpecError extends Error {
  constructor(
    readonly kind: 'invalid_schedule' | 'invalid_timezone',
    message: string,
  ) {
    super(message)
    this.name = 'ScheduleSpecError'
  }
}
export function assertValidTimezone(timezone: string): void {
  try {
    Temporal.ZonedDateTime.from({
      timeZone: timezone,
      year: 2026,
      month: 1,
      day: 1,
      hour: 0,
    })
  } catch {
    throw new ScheduleSpecError('invalid_timezone', `Invalid IANA timezone: ${timezone}`)
  }
}

function assertLocalTime(value: string): void {
  if (!LOCAL_TIME.test(value)) {
    throw new ScheduleSpecError('invalid_schedule', 'Time must use HH:mm precision')
  }
}

function assertIntegerRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ScheduleSpecError('invalid_schedule', `${label} must be between ${min} and ${max}`)
  }
}

function assertUniqueRanges(values: number[] | undefined, min: number, max: number, label: string): void {
  if (!values?.length) return
  for (const value of values) assertIntegerRange(value, min, max, label)
  if (new Set(values).size !== values.length) {
    throw new ScheduleSpecError('invalid_schedule', `${label} values must be unique`)
  }
}

export function assertValidScheduleSpec(spec: ScheduleSpecV1, timezone: string): void {
  assertValidTimezone(timezone)

  if (spec.kind === 'once') {
    assertLocalTime(spec.localTime)
    if (!LOCAL_DATE.test(spec.localDate)) {
      throw new ScheduleSpecError('invalid_schedule', 'Date must use YYYY-MM-DD')
    }
    try {
      Temporal.PlainDate.from(spec.localDate)
    } catch {
      throw new ScheduleSpecError('invalid_schedule', 'Date is not valid')
    }
    return
  }

  if (spec.kind === 'interval') {
    if (!Number.isInteger(spec.every) || spec.every < 1) {
      throw new ScheduleSpecError('invalid_schedule', 'Interval must be a positive integer')
    }
    if (spec.unit === 'minute' && spec.every < 5) {
      throw new ScheduleSpecError('invalid_schedule', 'Interval must be at least 5 minutes')
    }
    try {
      Temporal.Instant.from(spec.anchorAt)
    } catch {
      throw new ScheduleSpecError('invalid_schedule', 'Interval anchor must be an ISO instant')
    }
    return
  }

  assertLocalTime(spec.localTime)
  assertUniqueRanges(spec.weekdays, 1, 7, 'Weekday')
  assertUniqueRanges(spec.months, 1, 12, 'Month')
  if (spec.dayOfMonth !== undefined) assertIntegerRange(spec.dayOfMonth, 1, 31, 'Day of month')
  if (spec.count !== undefined) assertIntegerRange(spec.count, 1, 10_000, 'Count')
  if (spec.until !== undefined) {
    if (!LOCAL_DATE.test(spec.until)) {
      throw new ScheduleSpecError('invalid_schedule', 'End date must use YYYY-MM-DD')
    }
    try {
      Temporal.PlainDate.from(spec.until)
    } catch {
      throw new ScheduleSpecError('invalid_schedule', 'End date is not valid')
    }
  }
  if (spec.frequency === 'weekly' && !spec.weekdays?.length) {
    throw new ScheduleSpecError('invalid_schedule', 'Weekly schedules require at least one weekday')
  }
  if (spec.frequency === 'monthly' && spec.dayOfMonth === undefined && !spec.lastDayOfMonth) {
    throw new ScheduleSpecError('invalid_schedule', 'Monthly schedules require a day of month')
  }
  if (spec.frequency === 'yearly' && (!spec.months?.length || spec.dayOfMonth === undefined)) {
    throw new ScheduleSpecError('invalid_schedule', 'Yearly schedules require month and day')
  }
  if (spec.lastDayOfMonth && spec.dayOfMonth !== undefined) {
    throw new ScheduleSpecError('invalid_schedule', 'Choose a day of month or the last day, not both')
  }
}
