import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { CalendarSource } from '../renderer/components/calendar/CalendarSources'
import { resolveEventColors } from '../renderer/components/calendar/schedule-x-utils'
import type { CalendarEvent } from '../renderer/components/calendar/schedule-x-utils'

const WORK_BLUE = '#5B8DEF'
const HOLIDAY_GREEN = '#34D399'

const sources: CalendarSource[] = [
  { id: 'work', name: '工作', color: WORK_BLUE, enabled: true },
  { id: 'holiday', name: '节假日', color: HOLIDAY_GREEN, enabled: true },
]

function makeEvent(overrides: Partial<CalendarEvent> & Pick<CalendarEvent, 'calendarId' | 'color'>): CalendarEvent {
  return {
    id: 'evt-1',
    title: '事件',
    startTime: new Date('2026-05-01T00:00:00.000Z'),
    endTime: new Date('2026-05-01T01:00:00.000Z'),
    ...overrides,
  }
}

describe('resolveEventColors · 日程颜色随分类派生', () => {
  it('agent 把事件改到节假日分类后，颜色立即变绿而无需手动重存', () => {
    // The event's category (calendarId) is already 'holiday' but its stored
    // color is the stale blue fallback — exactly the agent-recategorized case.
    const event = makeEvent({ calendarId: 'holiday', color: WORK_BLUE })
    const [resolved] = resolveEventColors([event], sources)
    assert.equal(resolved.color, HOLIDAY_GREEN)
  })

  it('颜色已与分类一致时保留同一对象引用，避免无谓重渲染', () => {
    const event = makeEvent({ calendarId: 'holiday', color: HOLIDAY_GREEN })
    const [resolved] = resolveEventColors([event], sources)
    assert.equal(resolved, event, '未变化的事件应保持引用相等')
  })

  it('calendarId 没有匹配来源时保留事件原有颜色', () => {
    const event = makeEvent({ calendarId: 'ghost', color: WORK_BLUE })
    const [resolved] = resolveEventColors([event], sources)
    assert.equal(resolved, event)
    assert.equal(resolved.color, WORK_BLUE)
  })

  it('来源尚未加载时（events 先于 sources）原样返回，不丢颜色', () => {
    const events = [makeEvent({ calendarId: 'holiday', color: WORK_BLUE })]
    const result = resolveEventColors(events, [])
    assert.equal(result, events, '空来源应原样返回同一数组')
  })
})
