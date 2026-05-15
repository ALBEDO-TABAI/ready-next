import assert from 'node:assert/strict'
import test from 'node:test'

import { createCalendarAgentHandler } from '../renderer/modules/calendar/calendar-agent-handler'
import type { CalendarEvent } from '../renderer/components/calendar/schedule-x-utils'

const visibleRange = {
  start: new Date('2026-05-18T00:00:00+08:00'),
  end: new Date('2026-05-25T00:00:00+08:00'),
}

function makeEvent(id: string, title: string, startTime: string, endTime: string): CalendarEvent {
  return {
    id,
    title,
    startTime: new Date(startTime),
    endTime: new Date(endTime),
    calendarId: 'work',
    color: '#5B8DEF',
  }
}

test('calendar capture session includes loaded and visible events for agent reads', async () => {
  const handler = createCalendarAgentHandler({
    currentDate: new Date('2026-05-19T12:00:00+08:00'),
    viewType: 'week',
    editingEvent: null,
    sources: [{ id: 'work', name: '工作日程', color: '#5B8DEF', type: 'local', enabled: true }],
    getEvents: () => [
      makeEvent('event-1', '123', '2026-05-19T06:00:00+08:00', '2026-05-19T11:00:00+08:00'),
      makeEvent('event-2', '六月安排', '2026-06-02T09:00:00+08:00', '2026-06-02T10:00:00+08:00'),
    ],
    loadCalendarData: async () => {},
    setConflictState: () => {},
    markSessionMutation: () => {},
    getDateRange: () => visibleRange,
    calendarApi: undefined,
  })

  const payload = await handler({
    module: 'calendar',
    action: 'calendar.captureSession',
    args: {},
  }) as Record<string, unknown>

  assert.equal(payload.totalEvents, 2)
  assert.equal(payload.visibleEventCount, 1)
  assert.match(String(payload.summary), /已加载 2 个事件/)

  const events = payload.events as Array<Record<string, unknown>>
  const visibleEvents = payload.visibleEvents as Array<Record<string, unknown>>
  assert.deepEqual(events.map((event) => event.title), ['123', '六月安排'])
  assert.deepEqual(visibleEvents.map((event) => event.title), ['123'])
})
