import { endOfDay, endOfWeek, format, startOfDay, startOfWeek } from 'date-fns'
import { zhCN } from 'date-fns/locale'

import {
  compileDocumentWidgetSpec,
  type DayScheduleSnapshot,
  type DocumentWidgetComponentSpec,
  type DocumentWidgetCompileContext,
  type ScheduleRuntimeSnapshot,
  type TimeAllocationSnapshot,
  type TodayFocusSnapshot,
  type WeekScheduleSnapshot,
} from '../../../shared/document-widget-openui'

interface CalendarEventLike {
  id?: string
  title?: string
  startTime?: string | Date
  endTime?: string | Date
  calendarId?: string
  color?: string
  allDay?: boolean
  description?: string
}

interface CalendarSourceLike {
  id: string
  name: string
  color?: string
}

function normalizeDate(value: string | Date | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function buildTimeLabel(event: CalendarEventLike): string {
  if (event.allDay) return '全天'
  const start = normalizeDate(event.startTime)
  const end = normalizeDate(event.endTime)
  if (!start) return '未定时间'
  if (!end) return format(start, 'HH:mm')
  return `${format(start, 'HH:mm')} - ${format(end, 'HH:mm')}`
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
}

async function loadCalendarEvents(start: Date, end: Date): Promise<CalendarEventLike[]> {
  const result = await window.electronAPI.calendar.getEvents(start, end).catch(() => null)
  if (!result?.success || !Array.isArray(result.data)) return []
  return result.data as CalendarEventLike[]
}

async function loadCalendarSources(): Promise<CalendarSourceLike[]> {
  const result = await window.electronAPI.calendar.getSources().catch(() => null)
  if (!result?.success || !Array.isArray(result.data)) return []
  return result.data as CalendarSourceLike[]
}

function mapSourceNames(sources: CalendarSourceLike[]): Map<string, string> {
  return new Map(sources.map((source) => [source.id, source.name]))
}

async function buildDayScheduleSnapshot(date = new Date()): Promise<DayScheduleSnapshot> {
  const [events, sources] = await Promise.all([
    loadCalendarEvents(startOfDay(date), endOfDay(date)),
    loadCalendarSources(),
  ])
  const sourceNames = mapSourceNames(sources)
  const filtered = events.filter((event) => {
    const start = normalizeDate(event.startTime)
    return start ? sameDay(start, date) : false
  })

  return {
    dateLabel: format(date, 'M月d日 EEEE', { locale: zhCN }),
    events: filtered
      .sort((left, right) => {
        const leftStart = normalizeDate(left.startTime)?.getTime() || 0
        const rightStart = normalizeDate(right.startTime)?.getTime() || 0
        return leftStart - rightStart
      })
      .map((event) => ({
        title: String(event.title || '未命名事件'),
        timeLabel: buildTimeLabel(event),
        accent: event.color || '#5B8DEF',
        meta: sourceNames.get(String(event.calendarId || '')) || undefined,
      })),
  }
}

async function buildWeekScheduleSnapshot(date = new Date()): Promise<WeekScheduleSnapshot> {
  const weekStart = startOfWeek(date, { locale: zhCN })
  const weekEnd = endOfWeek(date, { locale: zhCN })
  const events = await loadCalendarEvents(weekStart, weekEnd)
  const days = Array.from({ length: 7 }, (_, index) => {
    const current = new Date(weekStart)
    current.setDate(weekStart.getDate() + index)
    const dayEvents = events.filter((event) => {
      const start = normalizeDate(event.startTime)
      return start ? sameDay(start, current) : false
    })

    return {
      label: format(current, 'EEE', { locale: zhCN }),
      count: dayEvents.length,
      highlights: dayEvents.slice(0, 3).map((event) => String(event.title || '未命名事件')),
    }
  })

  return {
    weekLabel: `${format(weekStart, 'M月d日', { locale: zhCN })} - ${format(weekEnd, 'M月d日', { locale: zhCN })}`,
    days,
  }
}

async function buildTimeAllocationSnapshot(date = new Date()): Promise<TimeAllocationSnapshot> {
  const weekStart = startOfWeek(date, { locale: zhCN })
  const weekEnd = endOfWeek(date, { locale: zhCN })
  const [events, sources] = await Promise.all([
    loadCalendarEvents(weekStart, weekEnd),
    loadCalendarSources(),
  ])
  const sourceNames = mapSourceNames(sources)
  const buckets = new Map<string, { label: string; value: number; accent?: string }>()

  for (const event of events) {
    const start = normalizeDate(event.startTime)
    const end = normalizeDate(event.endTime)
    if (!start || !end) continue
    const durationHours = Math.max(0.5, (end.getTime() - start.getTime()) / (60 * 60 * 1000))
    const key = String(event.calendarId || 'unknown')
    const existing = buckets.get(key) || {
      label: sourceNames.get(key) || '其他',
      value: 0,
      accent: event.color || '#5B8DEF',
    }
    existing.value += Number(durationHours.toFixed(1))
    buckets.set(key, existing)
  }

  return {
    periodLabel: '本周时间分配',
    segments: Array.from(buckets.values()).sort((left, right) => right.value - left.value).slice(0, 6),
  }
}

async function buildScheduleRuntimeSnapshot(): Promise<ScheduleRuntimeSnapshot> {
  const result = await window.electronAPI.agent.listSchedules().catch(() => null)
  const rows = result?.success && Array.isArray(result.data) ? result.data : []
  const jobs: ScheduleRuntimeSnapshot['jobs'] = rows.slice(0, 6).map((row) => ({
    name: String(row.name || '未命名计划'),
    status: row.enabled ? 'enabled' : 'paused',
    nextRun: typeof row.nextRunAt === 'string' ? row.nextRunAt : undefined,
    lastRun: typeof row.lastRunAt === 'string' ? row.lastRunAt : undefined,
  }))

  return {
    heading: '自动计划',
    jobs: jobs.length > 0 ? jobs : [{
      name: '当前没有自动计划',
      status: 'paused',
      nextRun: undefined,
      lastRun: undefined,
    }],
  }
}

async function buildTodayFocusSnapshot(date = new Date()): Promise<TodayFocusSnapshot> {
  const [calendar, schedule] = await Promise.all([
    buildDayScheduleSnapshot(date),
    buildScheduleRuntimeSnapshot(),
  ])
  const nextEvent = calendar.events[0]
  const enabledCount = schedule.jobs.filter((job) => job.status === 'enabled').length

  return {
    dayLabel: format(date, '今天 · M月d日', { locale: zhCN }),
    highlights: [
      nextEvent ? `下一项安排：${nextEvent.title}` : '今天还没有安排事件',
      enabledCount > 0 ? `已启用 ${enabledCount} 个自动计划` : '当前没有启用中的自动计划',
    ],
    metrics: [
      { label: '今日事件', value: String(calendar.events.length) },
      { label: '启用计划', value: String(enabledCount) },
    ],
  }
}

async function buildCompileContext(spec: DocumentWidgetComponentSpec): Promise<DocumentWidgetCompileContext> {
  switch (spec.component) {
    case 'day_schedule_card':
      return { calendar: await buildDayScheduleSnapshot() }
    case 'week_schedule_card':
      return { calendarWeek: await buildWeekScheduleSnapshot() }
    case 'time_allocation_chart':
      return { timeAllocation: await buildTimeAllocationSnapshot() }
    case 'schedule_runtime_card':
      return { schedule: await buildScheduleRuntimeSnapshot() }
    case 'today_focus_snapshot':
      return { todayFocus: await buildTodayFocusSnapshot() }
    default:
      return {}
  }
}

export async function compileDocumentWidgetComponentSpec(spec: DocumentWidgetComponentSpec): Promise<{
  component: string
  widgetCode: string
}> {
  const context = spec.dataSource ? await buildCompileContext(spec) : undefined
  return compileDocumentWidgetSpec(spec, context)
}
