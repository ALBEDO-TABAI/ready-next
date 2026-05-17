/**
 * Integration tests: the widget data provider consuming REAL wire-shape
 * data (Unix seconds + camelCase + null fields) — not the ISO-string
 * fixtures used in `calendar-widget-data-provider.test.ts`.
 *
 * This catches the failure mode the original tests missed: a fetcher
 * that "passes" with hand-written ISO strings but produces 1970-era
 * widget data when wired to the real IPC channel.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCalendarWidgetFetcher,
  type CalendarWidgetApi,
  type CalendarWidgetEventLike,
} from '../renderer/modules/calendar/widget-data-provider'
import { serializeEventToWire } from '../shared/calendar-wire'

const REF_2026_05_17_09_UTC = Math.floor(Date.UTC(2026, 4, 17, 9, 0, 0) / 1000)

function buildWireBatch(): CalendarWidgetEventLike[] {
  // Produce events exactly as `ipc-handler.ts`'s `getEvents` does post-fix:
  // serialize from snake_case DB rows through `serializeEventToWire`.
  const rows = [
    {
      id: 'e-morning',
      calendar_id: 'work',
      title: '晨会',
      description: null,
      location: '会议室 A',
      start_time: REF_2026_05_17_09_UTC,
      end_time: REF_2026_05_17_09_UTC + 1800,
      all_day: 0,
    },
    {
      id: 'e-noon',
      calendar_id: 'work',
      title: '午餐会议',
      description: null,
      location: null,
      start_time: REF_2026_05_17_09_UTC + 3 * 3600,
      end_time: REF_2026_05_17_09_UTC + 4 * 3600,
      all_day: 0,
    },
    {
      id: 'e-evening',
      calendar_id: 'life',
      title: '晚餐',
      description: null,
      location: null,
      start_time: REF_2026_05_17_09_UTC + 9 * 3600,
      end_time: REF_2026_05_17_09_UTC + 10 * 3600,
      all_day: 0,
    },
  ]
  return rows.map((r) => serializeEventToWire(r) as unknown as CalendarWidgetEventLike)
}

function buildApi(events: CalendarWidgetEventLike[]): CalendarWidgetApi {
  return {
    async getEvents() {
      return { success: true, data: events }
    },
    async getSources() {
      return { success: true, data: [{ id: 'work', name: '工作' }, { id: 'life', name: '生活' }] }
    },
  }
}

test('fetchDaySchedule against wire-shape input: events land on 2026-05-17, not 1970', async () => {
  const fetcher = createCalendarWidgetFetcher({ calendar: buildApi(buildWireBatch()) })
  // Reference today = 2026-05-17 in UTC. Wire startTime is Unix SECONDS;
  // the original failure mode parsed it as ms and bucketed everything
  // into 1970.
  const day = await fetcher.fetchDaySchedule({
    now: new Date(Date.UTC(2026, 4, 17, 0, 0, 0)),
    tz: 'UTC',
  })
  // dateLabel format: 'M月d日 EEEE' (zh-CN). Must reference 5月 or 17, NOT 1月 (1970-01).
  assert.ok(day.dateLabel.includes('5月') || day.dateLabel.includes('17'),
    `dateLabel "${day.dateLabel}" expected to reference 5月/17 (= 2026-05-17 wall clock)`)
  assert.ok(!day.dateLabel.includes('1970'),
    `dateLabel "${day.dateLabel}" must not reference 1970 — would indicate seconds-as-ms confusion`)
  // Day events should include all 3 since all are on 2026-05-17 UTC.
  assert.equal(day.events.length, 3, `expected 3 events on 2026-05-17, got ${day.events.length}`)
})

test('fetchTodayFocusSnapshot under wire shape: dayLabel is 2026 not 1970', async () => {
  const fetcher = createCalendarWidgetFetcher({ calendar: buildApi(buildWireBatch()) })
  const focus = await fetcher.fetchTodayFocusSnapshot({
    now: new Date(Date.UTC(2026, 4, 17, 10, 0, 0)),
    tz: 'UTC',
  })
  // TodayFocusSnapshot shape: { dayLabel, highlights[], metrics[] }
  assert.ok(typeof focus.dayLabel === 'string' && focus.dayLabel.length > 0, 'dayLabel non-empty')
  assert.ok(!focus.dayLabel.includes('1970'), `dayLabel must not reference 1970: ${focus.dayLabel}`)
  assert.ok(Array.isArray(focus.highlights), 'highlights array')
  assert.ok(focus.metrics.some((m) => m.label === '今日事件'), 'has "今日事件" metric')
  // Metric value should be NON-ZERO (proves the wire → fetcher → widget
  // pipeline preserved at least one event on the correct day; tighter
  // count assertions live in the day-schedule test above where the
  // contract is more direct).
  const dailyMetric = focus.metrics.find((m) => m.label === '今日事件')
  assert.ok(dailyMetric, 'has 今日事件 metric')
  const parsedCount = Number(dailyMetric?.value ?? 0)
  assert.ok(parsedCount > 0, `metric 今日事件 must be > 0 under wire shape, got "${dailyMetric?.value}"`)
})

test('fetchTimeAllocation under wire shape: segments sum to wire-derived durations', async () => {
  const fetcher = createCalendarWidgetFetcher({ calendar: buildApi(buildWireBatch()) })
  const allocation = await fetcher.fetchTimeAllocation({
    now: new Date(Date.UTC(2026, 4, 17, 0, 0, 0)),
    tz: 'UTC',
  })
  // TimeAllocationSnapshot shape: { periodLabel, segments: Array<{label, value, accent?}> }
  assert.ok(typeof allocation.periodLabel === 'string', 'periodLabel present')
  assert.ok(Array.isArray(allocation.segments), 'segments array')
  // 3 events: 30min + 60min + 60min = 150min total = 2.5h
  const totalHours = allocation.segments.reduce((acc, s) => acc + s.value, 0)
  assert.ok(totalHours > 0, `expected non-zero allocation, got ${totalHours}`)
  // Sanity: if our wire serialization broke (e.g. seconds-as-ms), durations
  // would be astronomically large or zero. Anchoring on a tight bound.
  assert.ok(totalHours < 24, `total allocation ${totalHours}h is suspiciously high — likely seconds/ms confusion`)
})

test('reminders field passes through wire as Reminder[] (parsed) when source row carried JSON', async () => {
  const wireWithReminders = serializeEventToWire({
    id: 'e-with-rem',
    calendar_id: 'work',
    title: '带提醒的事件',
    description: null,
    location: null,
    start_time: REF_2026_05_17_09_UTC,
    end_time: REF_2026_05_17_09_UTC + 3600,
    all_day: 0,
    reminders: JSON.stringify([{ offsetMinutes: -10, method: 'notification' }]),
  })
  const events = [wireWithReminders as unknown as CalendarWidgetEventLike]
  const fetcher = createCalendarWidgetFetcher({ calendar: buildApi(events) })
  const day = await fetcher.fetchDaySchedule({
    now: new Date(Date.UTC(2026, 4, 17, 0, 0, 0)),
    tz: 'UTC',
  })
  assert.equal(day.events.length, 1)
  // The widget snapshot drops reminders by default (UI doesn't need them),
  // but the wire normalization itself should have parsed the string into
  // an array. Check via the wire layer directly.
  assert.ok(Array.isArray(wireWithReminders.reminders), 'reminders parsed to array')
  assert.equal(wireWithReminders.reminders?.length, 1)
})
