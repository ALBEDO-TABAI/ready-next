import assert from 'node:assert/strict'
import test from 'node:test'
import { Temporal as JsTemporal } from '@js-temporal/polyfill'
import { Temporal as ScheduleXTemporal } from 'temporal-polyfill'

import { dateToSXPlainDate } from '../renderer/components/calendar/schedule-x-utils'

test('calendar selected date uses the same Temporal constructor as Schedule-X runtime', () => {
  const previousTemporal = globalThis.Temporal
  try {
    globalThis.Temporal = ScheduleXTemporal
    const selectedDate = dateToSXPlainDate(new Date(2026, 5, 8, 10, 30))

    assert.equal(selectedDate.toString(), '2026-06-08')
    assert.equal(selectedDate instanceof ScheduleXTemporal.PlainDate, true)
    assert.equal(selectedDate instanceof JsTemporal.PlainDate, false)
  } finally {
    globalThis.Temporal = previousTemporal
  }
})
