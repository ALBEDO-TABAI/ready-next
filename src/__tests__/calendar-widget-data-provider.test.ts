/**
 * L5-A — Behavior tests for the calendar widget data provider.
 *
 * Verifies the DI-form fetcher against fake `CalendarWidgetApi` /
 * `ScheduleRuntimeApi` implementations. No window globals are touched
 * — the global default adapter is exercised only by the dedicated
 * "default adapter no-op" test below.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  createCalendarWidgetFetcher,
  getDefaultCalendarWidgetFetcher,
  type CalendarWidgetApi,
  type CalendarWidgetEventLike,
  type CalendarWidgetSourceLike,
  type ScheduleRuntimeApi,
} from '../renderer/modules/calendar/widget-data-provider'

/* ------------------------------------------------------------------ */
/* Fake helpers                                                       */
/* ------------------------------------------------------------------ */

function makeApi(events: CalendarWidgetEventLike[], sources: CalendarWidgetSourceLike[] = []): CalendarWidgetApi {
  return {
    async getEvents(_start: Date, _end: Date) {
      return { success: true, data: events }
    },
    async getSources() {
      return { success: true, data: sources }
    },
  }
}

function isoAt(year: number, month: number, day: number, hour: number, minute: number, tz = 'UTC'): string {
  // Build an ISO instant that, when read in `tz`, lands on the given
  // wall-clock. We approximate by constructing a Date with explicit
  // UTC components for tz='UTC', or by trusting Date string parsing
  // otherwise. Tests below pick UTC unless they specifically want
  // tz-shift behavior.
  if (tz === 'UTC') {
    return new Date(Date.UTC(year, month - 1, day, hour, minute, 0)).toISOString()
  }
  // For non-UTC test cases, the caller is expected to provide the
  // already-resolved UTC instant. Returning a plain ISO from local
  // components would be ambiguous.
  return new Date(year, month - 1, day, hour, minute, 0).toISOString()
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe('calendar widget data provider — fetchDaySchedule', () => {
  it('filters events to the wall-clock day in the chosen timezone', async () => {
    // Reference instant: 2026-05-17 12:00:00 UTC.
    const now = new Date(Date.UTC(2026, 4, 17, 12, 0, 0))
    const events: CalendarWidgetEventLike[] = [
      // Yesterday in UTC, but actually 2026-05-17 in Asia/Shanghai (UTC+8).
      { id: 'a', title: '早会', startTime: isoAt(2026, 5, 16, 23, 30), endTime: isoAt(2026, 5, 17, 0, 30), calendarId: 'work' },
      // Today UTC, today Shanghai.
      { id: 'b', title: '午餐', startTime: isoAt(2026, 5, 17, 4, 0), endTime: isoAt(2026, 5, 17, 5, 0), calendarId: 'life' },
      // Tomorrow UTC, tomorrow Shanghai.
      { id: 'c', title: '明日复盘', startTime: isoAt(2026, 5, 18, 10, 0), endTime: isoAt(2026, 5, 18, 11, 0), calendarId: 'work' },
    ]
    const sources: CalendarWidgetSourceLike[] = [
      { id: 'work', name: '工作', color: '#5B8DEF', enabled: true },
      { id: 'life', name: '生活', color: '#34D399', enabled: true },
    ]
    const fetcher = createCalendarWidgetFetcher({ calendar: makeApi(events, sources) })
    const snapshot = await fetcher.fetchDaySchedule({ now, tz: 'Asia/Shanghai' })

    // Both '早会' and '午餐' should appear (they fall on 2026-05-17 in
    // Asia/Shanghai). '明日复盘' is filtered out.
    const titles = snapshot.events.map((event) => event.title)
    assert.ok(titles.includes('早会'), `expected 早会 in ${titles.join(',')}`)
    assert.ok(titles.includes('午餐'), `expected 午餐 in ${titles.join(',')}`)
    assert.ok(!titles.includes('明日复盘'), `expected 明日复盘 not in ${titles.join(',')}`)
    // Source name metadata wired in.
    assert.equal(snapshot.events.find((event) => event.title === '工作' || event.title === '早会')?.meta, '工作')
  })

  it('sorts events ascending by start time', async () => {
    const now = new Date(Date.UTC(2026, 4, 17, 12, 0, 0))
    const events: CalendarWidgetEventLike[] = [
      { id: 'late', title: '下午茶', startTime: isoAt(2026, 5, 17, 6, 0), endTime: isoAt(2026, 5, 17, 7, 0), calendarId: 'life' },
      { id: 'early', title: '晨练', startTime: isoAt(2026, 5, 17, 1, 0), endTime: isoAt(2026, 5, 17, 2, 0), calendarId: 'life' },
    ]
    const fetcher = createCalendarWidgetFetcher({ calendar: makeApi(events) })
    const snapshot = await fetcher.fetchDaySchedule({ now, tz: 'UTC' })
    assert.deepEqual(snapshot.events.map((e) => e.title), ['晨练', '下午茶'])
  })

  it('renders timezone-affected date labels', async () => {
    // Reference instant: 2026-05-17 00:30 UTC.
    // - Asia/Shanghai (UTC+8): 2026-05-17 08:30 -> dateLabel for 17日.
    // - America/New_York (UTC-4 in May): 2026-05-16 20:30 -> dateLabel for 16日.
    const now = new Date(Date.UTC(2026, 4, 17, 0, 30, 0))
    const fetcher = createCalendarWidgetFetcher({ calendar: makeApi([]) })

    const sh = await fetcher.fetchDaySchedule({ now, tz: 'Asia/Shanghai' })
    const ny = await fetcher.fetchDaySchedule({ now, tz: 'America/New_York' })

    assert.match(sh.dateLabel, /5月17日/, `expected '5月17日...' in '${sh.dateLabel}'`)
    assert.match(ny.dateLabel, /5月16日/, `expected '5月16日...' in '${ny.dateLabel}'`)
  })
})

describe('calendar widget data provider — fetchWeekSchedule', () => {
  it('aggregates 7 day buckets anchored Monday', async () => {
    // 2026-05-17 = Sunday.  Monday = 2026-05-11.
    const now = new Date(Date.UTC(2026, 4, 17, 6, 0, 0))
    const events: CalendarWidgetEventLike[] = [
      { id: '1', title: '周一会', startTime: isoAt(2026, 5, 11, 2, 0), endTime: isoAt(2026, 5, 11, 3, 0), calendarId: 'work' },
      { id: '2', title: '周一会2', startTime: isoAt(2026, 5, 11, 5, 0), endTime: isoAt(2026, 5, 11, 6, 0), calendarId: 'work' },
      { id: '3', title: '周三事件', startTime: isoAt(2026, 5, 13, 2, 0), endTime: isoAt(2026, 5, 13, 3, 0), calendarId: 'life' },
      { id: '4', title: '周日事件', startTime: isoAt(2026, 5, 17, 2, 0), endTime: isoAt(2026, 5, 17, 3, 0), calendarId: 'life' },
    ]
    const fetcher = createCalendarWidgetFetcher({ calendar: makeApi(events) })
    const snapshot = await fetcher.fetchWeekSchedule({ now, tz: 'UTC' })

    assert.equal(snapshot.days.length, 7)
    // Monday should have count=2.
    assert.equal(snapshot.days[0].count, 2, `Monday count=${snapshot.days[0].count}`)
    // Wednesday should have count=1.
    assert.equal(snapshot.days[2].count, 1, `Wed count=${snapshot.days[2].count}`)
    // Sunday should have count=1.
    assert.equal(snapshot.days[6].count, 1, `Sun count=${snapshot.days[6].count}`)
    // Days without events should have count=0.
    assert.equal(snapshot.days[1].count, 0)
    assert.equal(snapshot.days[3].count, 0)
    // Highlights capped at 3 per day (already the case in the impl).
    assert.ok(snapshot.days[0].highlights.length <= 3)
    // Highlights include both Monday titles.
    assert.deepEqual(snapshot.days[0].highlights.slice().sort(), ['周一会', '周一会2'])
    // Week label has both endpoints.
    assert.match(snapshot.weekLabel, /5月11日.*5月17日/)
  })
})

describe('calendar widget data provider — fetchTimeAllocation', () => {
  it('groups durations by calendarId and ranks descending', async () => {
    const now = new Date(Date.UTC(2026, 4, 17, 12, 0, 0))
    const events: CalendarWidgetEventLike[] = [
      // work: 3 hours
      { id: '1', title: 'w1', startTime: isoAt(2026, 5, 12, 1, 0), endTime: isoAt(2026, 5, 12, 4, 0), calendarId: 'work' },
      // life: 1 hour
      { id: '2', title: 'l1', startTime: isoAt(2026, 5, 13, 8, 0), endTime: isoAt(2026, 5, 13, 9, 0), calendarId: 'life' },
      // work: 1.5 hours -> work total 4.5
      { id: '3', title: 'w2', startTime: isoAt(2026, 5, 14, 5, 0), endTime: isoAt(2026, 5, 14, 6, 30), calendarId: 'work' },
      // Zero / negative duration is dropped.
      { id: '4', title: 'bad', startTime: isoAt(2026, 5, 14, 10, 0), endTime: isoAt(2026, 5, 14, 10, 0), calendarId: 'work' },
    ]
    const sources: CalendarWidgetSourceLike[] = [
      { id: 'work', name: '工作', enabled: true },
      { id: 'life', name: '生活', enabled: true },
    ]
    const fetcher = createCalendarWidgetFetcher({ calendar: makeApi(events, sources) })
    const snapshot = await fetcher.fetchTimeAllocation({ now, tz: 'UTC' })

    assert.equal(snapshot.segments.length, 2)
    // Sorted descending by value.
    assert.equal(snapshot.segments[0].label, '工作')
    assert.equal(snapshot.segments[1].label, '生活')
    // 1+3 = 4, plus 1.5 = 4.5
    assert.equal(snapshot.segments[0].value, 4.5)
    assert.equal(snapshot.segments[1].value, 1)
    // Period label is wired.
    assert.equal(snapshot.periodLabel, '本周时间分配')
  })

  it('returns a placeholder segment when no events fall in the week', async () => {
    const now = new Date(Date.UTC(2026, 4, 17, 12, 0, 0))
    const fetcher = createCalendarWidgetFetcher({ calendar: makeApi([]) })
    const snapshot = await fetcher.fetchTimeAllocation({ now, tz: 'UTC' })
    assert.equal(snapshot.segments.length, 1)
    assert.match(snapshot.segments[0].label, /暂无可统计/)
  })
})

describe('calendar widget data provider — fetchTodayFocusSnapshot', () => {
  it('picks the next upcoming event strictly after now', async () => {
    // Now: 2026-05-17 08:00 UTC.
    const now = new Date(Date.UTC(2026, 4, 17, 8, 0, 0))
    const events: CalendarWidgetEventLike[] = [
      // Past event today.
      { id: 'past', title: '已结束', startTime: isoAt(2026, 5, 17, 6, 0), endTime: isoAt(2026, 5, 17, 7, 0), calendarId: 'w' },
      // Upcoming event today.
      { id: 'next', title: '下一项', startTime: isoAt(2026, 5, 17, 10, 0), endTime: isoAt(2026, 5, 17, 11, 0), calendarId: 'w' },
      // Even later today.
      { id: 'later', title: '再后一项', startTime: isoAt(2026, 5, 17, 14, 0), endTime: isoAt(2026, 5, 17, 15, 0), calendarId: 'w' },
    ]
    const fetcher = createCalendarWidgetFetcher({ calendar: makeApi(events) })
    const snapshot = await fetcher.fetchTodayFocusSnapshot({ now, tz: 'UTC' })

    // The first highlight string is "下一项安排：<title>" for the
    // next upcoming event.
    assert.match(snapshot.highlights[0], /下一项/)
    // Metrics reflect today's count = 3.
    const today = snapshot.metrics.find((metric) => metric.label === '今日事件')
    assert.equal(today?.value, '3')
  })

  it('falls back to "今天还没有安排事件" when no events on the day', async () => {
    const now = new Date(Date.UTC(2026, 4, 17, 8, 0, 0))
    const fetcher = createCalendarWidgetFetcher({ calendar: makeApi([]) })
    const snapshot = await fetcher.fetchTodayFocusSnapshot({ now, tz: 'UTC' })
    assert.match(snapshot.highlights[0], /还没有安排事件/)
    const today = snapshot.metrics.find((metric) => metric.label === '今日事件')
    assert.equal(today?.value, '0')
  })
})

describe('calendar widget data provider — fetchScheduleRuntime', () => {
  it('maps schedule rows into job entries', async () => {
    const schedule: ScheduleRuntimeApi = {
      async list() {
        return {
          success: true,
          data: [
            { name: '每日总结', enabled: true, nextRunAt: '2026-05-17T18:00:00Z', lastOccurrenceAt: '2026-05-16T18:00:00Z' },
            { name: '关闭中', enabled: false },
          ],
        }
      },
    }
    const fetcher = createCalendarWidgetFetcher({ calendar: makeApi([]), schedule })
    const snapshot = await fetcher.fetchScheduleRuntime()
    assert.equal(snapshot.jobs.length, 2)
    assert.equal(snapshot.jobs[0].name, '每日总结')
    assert.equal(snapshot.jobs[0].status, 'enabled')
    assert.equal(snapshot.jobs[1].status, 'paused')
  })

  it('emits a placeholder job when no schedule API is wired', async () => {
    const fetcher = createCalendarWidgetFetcher({ calendar: makeApi([]) })
    const snapshot = await fetcher.fetchScheduleRuntime()
    assert.equal(snapshot.jobs.length, 1)
    assert.equal(snapshot.jobs[0].status, 'paused')
    assert.match(snapshot.jobs[0].name, /没有自动计划/)
  })
})

describe('compileDocumentWidgetComponentSpec — auto-fetch promotion', () => {
  it('auto-fetches a calendar widget when the LLM omits both props and dataSource', async () => {
    const events: CalendarWidgetEventLike[] = [
      { id: 'a', title: '注入成功', startTime: isoAt(2026, 5, 17, 4, 0), endTime: isoAt(2026, 5, 17, 5, 0), calendarId: 'work' },
    ]
    const fakeFetcher = createCalendarWidgetFetcher({ calendar: makeApi(events) })
    // Import here to keep the test isolated from the document spec
    // schema validation issues at top-level.
    const mod = await import('../renderer/modules/agent/documentWidgetOpenUI')
    const compiled = await mod.compileDocumentWidgetComponentSpec(
      // Note: no `dataSource`, no `props` — purely a name. This is the
      // L5-A regression we are guarding against.
      { component: 'day_schedule_card' } as never,
      {
        fetcher: fakeFetcher,
        fetchOptions: { now: new Date(Date.UTC(2026, 4, 17, 6, 0, 0)), tz: 'UTC' },
      },
    )
    assert.equal(compiled.component, 'day_schedule_card')
    assert.match(compiled.widgetCode, /注入成功/)
  })

  it('honors the LLM-supplied static props when present (no auto-promotion)', async () => {
    // If `props` is supplied, we should NOT auto-fetch. The widget
    // should render the LLM's content as-is.
    const fakeFetcher = createCalendarWidgetFetcher({
      calendar: {
        async getEvents() { throw new Error('fetcher should not be called') },
        async getSources() { throw new Error('fetcher should not be called') },
      },
    })
    const mod = await import('../renderer/modules/agent/documentWidgetOpenUI')
    const compiled = await mod.compileDocumentWidgetComponentSpec(
      {
        component: 'day_schedule_card',
        props: {
          dateLabel: '今天',
          events: [
            { title: 'LLM静态内容', timeLabel: '09:00 - 10:00' },
          ],
        },
      } as never,
      { fetcher: fakeFetcher },
    )
    assert.match(compiled.widgetCode, /LLM静态内容/)
  })
})

describe('calendar widget data provider — resilience', () => {
  it('survives an IPC failure by emitting empty snapshots', async () => {
    const broken: CalendarWidgetApi = {
      async getEvents() { throw new Error('ipc fail') },
      async getSources() { throw new Error('ipc fail') },
    }
    const fetcher = createCalendarWidgetFetcher({ calendar: broken })
    const day = await fetcher.fetchDaySchedule({
      now: new Date(Date.UTC(2026, 4, 17, 0, 0, 0)),
      tz: 'UTC',
    })
    assert.equal(day.events.length, 0)
    assert.ok(typeof day.dateLabel === 'string' && day.dateLabel.length > 0)
  })

  it('default adapter returns an inert fetcher when no electronAPI is present', async () => {
    // We are running in node; window/electronAPI is absent. The default
    // adapter must not crash.
    const fetcher = getDefaultCalendarWidgetFetcher()
    const day = await fetcher.fetchDaySchedule({
      now: new Date(Date.UTC(2026, 4, 17, 0, 0, 0)),
      tz: 'UTC',
    })
    assert.equal(day.events.length, 0)
  })
})
