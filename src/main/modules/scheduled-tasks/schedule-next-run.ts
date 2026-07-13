import { Temporal } from '@js-temporal/polyfill'
import type { ScheduleSpecV1 } from '../../../shared/scheduled-tasks'
import { assertValidScheduleSpec, ScheduleSpecError } from './schedule-spec'

const MAX_CALENDAR_SEARCH_DAYS = 366 * 20

function localParts(localTime: string): { hour: number; minute: number } {
  const [hour, minute] = localTime.split(':').map(Number)
  return { hour, minute }
}

function zonedInstant(date: Temporal.PlainDate, localTime: string, timezone: string): Temporal.Instant {
  const { hour, minute } = localParts(localTime)
  const desired = date.toPlainDateTime({ hour, minute })
  let candidate = Temporal.ZonedDateTime.from({
    timeZone: timezone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour,
    minute,
  }, { disambiguation: 'compatible' })

  // `compatible` preserves the minute within a DST gap (02:30 becomes 03:30),
  // while the product contract requires the first valid local minute instead.
  // Walk back only for nonexistent local times; normal and repeated times retain
  // Temporal's earlier-occurrence behavior.
  if (Temporal.PlainDateTime.compare(candidate.toPlainDateTime(), desired) > 0) {
    while (Temporal.PlainDateTime.compare(candidate.subtract({ minutes: 1 }).toPlainDateTime(), desired) >= 0) {
      candidate = candidate.subtract({ minutes: 1 })
    }
  }
  return candidate.toInstant()
}

function calendarDateMatches(spec: Extract<ScheduleSpecV1, { kind: 'calendar' }>, date: Temporal.PlainDate): boolean {
  if (spec.months?.length && !spec.months.includes(date.month)) return false
  if (spec.weekdays?.length && !spec.weekdays.includes(date.dayOfWeek)) return false
  if (spec.lastDayOfMonth && date.day !== date.daysInMonth) return false
  if (spec.dayOfMonth !== undefined && date.day !== spec.dayOfMonth) return false

  if (spec.frequency === 'weekly') return Boolean(spec.weekdays?.includes(date.dayOfWeek))
  if (spec.frequency === 'monthly') return spec.lastDayOfMonth
    ? date.day === date.daysInMonth
    : date.day === spec.dayOfMonth
  if (spec.frequency === 'yearly') {
    return Boolean(spec.months?.includes(date.month)) && date.day === spec.dayOfMonth
  }
  return true
}

function intervalRuns(
  spec: Extract<ScheduleSpecV1, { kind: 'interval' }>,
  after: Temporal.Instant,
  count: number,
): string[] {
  const anchorMs = Temporal.Instant.from(spec.anchorAt).epochMilliseconds
  const unitMs = spec.unit === 'minute' ? 60_000 : spec.unit === 'hour' ? 3_600_000 : 86_400_000
  const stepMs = unitMs * spec.every
  const afterMs = after.epochMilliseconds
  const elapsed = afterMs - anchorMs
  const firstStep = elapsed < 0 ? 0 : Math.floor(elapsed / stepMs) + 1
  return Array.from({ length: count }, (_, index) => (
    Temporal.Instant.fromEpochMilliseconds(anchorMs + (firstStep + index) * stepMs).toString()
  ))
}

export function getNextScheduleRuns(input: {
  spec: ScheduleSpecV1
  timezone: string
  after: string
  count?: number
}): string[] {
  const count = input.count ?? 3
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new ScheduleSpecError('invalid_schedule', 'Preview count must be between 1 and 100')
  }
  assertValidScheduleSpec(input.spec, input.timezone)
  const after = Temporal.Instant.from(input.after)

  if (input.spec.kind === 'interval') return intervalRuns(input.spec, after, count)

  if (input.spec.kind === 'once') {
    const instant = zonedInstant(
      Temporal.PlainDate.from(input.spec.localDate),
      input.spec.localTime,
      input.timezone,
    )
    return Temporal.Instant.compare(instant, after) > 0 ? [instant.toString()] : []
  }

  const afterLocal = after.toZonedDateTimeISO(input.timezone)
  let date = afterLocal.toPlainDate()
  const endDate = input.spec.until ? Temporal.PlainDate.from(input.spec.until) : null
  const runs: string[] = []
  for (let scanned = 0; scanned <= MAX_CALENDAR_SEARCH_DAYS && runs.length < count; scanned += 1) {
    if (endDate && Temporal.PlainDate.compare(date, endDate) > 0) break
    if (calendarDateMatches(input.spec, date)) {
      const instant = zonedInstant(date, input.spec.localTime, input.timezone)
      if (Temporal.Instant.compare(instant, after) > 0) runs.push(instant.toString())
    }
    date = date.add({ days: 1 })
  }
  if (!runs.length) {
    throw new ScheduleSpecError('invalid_schedule', 'Schedule does not produce a future time')
  }
  return input.spec.count === undefined ? runs : runs.slice(0, input.spec.count)
}

export function getNextScheduleRun(input: {
  spec: ScheduleSpecV1
  timezone: string
  after: string
}): string | null {
  try {
    return getNextScheduleRuns({ ...input, count: 1 })[0] ?? null
  } catch (error) {
    if (error instanceof ScheduleSpecError && error.message === 'Schedule does not produce a future time') {
      return null
    }
    throw error
  }
}
