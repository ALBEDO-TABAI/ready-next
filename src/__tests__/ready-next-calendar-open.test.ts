import assert from 'node:assert/strict'
import test from 'node:test'
import { captureCalendarOpen, consumeCalendarOpens, type CalendarOpenIntent } from '../main/calendar-open-intents'
import { parseCalendarDeepLink } from '../shared/calendar/desktop'

test('OS calendar links are normalized for both queued and live delivery', () => {
  const received: CalendarOpenIntent[] = []
  assert.equal(captureCalendarOpen({ kind: 'url', value: 'ready-next://calendar/day/2026-11-03' }), true)
  const stop = consumeCalendarOpens(intent => received.push(intent))
  try {
    assert.equal(captureCalendarOpen({ kind: 'url', value: 'ready-next://calendar/event/x' }), true)
    assert.deepEqual(received.map(intent => parseCalendarDeepLink(intent.value)), [
      { kind: 'day', date: '2026-11-03' }, { kind: 'event', eventId: 'x' },
    ])
    for (const scheme of ['ready', 'https', 'other']) {
      assert.equal(captureCalendarOpen({ kind: 'url', value: `${scheme}://calendar/event/x` }), false)
    }
    assert.equal(captureCalendarOpen({ kind: 'url', value: 'ready-next://other/event/x' }), false)
    assert.equal(received.length, 2)
    assert.equal(captureCalendarOpen({ kind: 'file', value: '/tmp/calendar.ics' }), true)
    assert.deepEqual(received[2], { kind: 'file', value: '/tmp/calendar.ics' })
  } finally {
    stop()
  }
})
