/**
 * L5-A — Calendar widget data provider.
 *
 * Dependency-injected fetchers that turn `window.electronAPI.calendar`
 * IPC calls into widget-ready snapshot shapes. The renderer
 * compilation entrypoint (`documentWidgetOpenUI.ts`) wraps these into
 * a `DocumentWidgetCompileContext`; tests inject fake `CalendarApi`
 * implementations directly.
 *
 * Boundary notes (CLAUDE §6.8.1 + §6.9):
 *   - This module is renderer-only and never touches main IPC pre-load
 *     glue directly. The only contact surface is the abstract
 *     `CalendarApi` interface plus a thin default adapter at the bottom.
 *   - Widget rendering must NOT trigger `live-info-intent` or
 *     `arbitrateSkeletonForUserText`. We stay strictly inside the
 *     compile-context pipeline; we never emit user instructions.
 *
 * Time semantics:
 *   - Wall-clock day boundaries are computed in the user's chosen
 *     display timezone (CLAUDE §6.8.1 / L4-A) via Temporal. Events
 *     keep their authored `startTz` / `endTz`; we only translate the
 *     visible window endpoints into UTC seconds for IPC filtering.
 *   - All numeric times exposed by snapshots are Unix-seconds-aligned
 *     either implicitly (via Date.parse) or by date-fns formatting in
 *     the labeled fields. We never invent times the IPC didn't carry.
 */

import { format, startOfDay as dfStartOfDay, endOfDay as dfEndOfDay } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { Temporal } from '@js-temporal/polyfill'

import type {
  DayScheduleSnapshot,
  ScheduleRuntimeSnapshot,
  TimeAllocationSnapshot,
  TodayFocusSnapshot,
  WeekScheduleSnapshot,
} from '../../../shared/document-widget-openui'

/* ------------------------------------------------------------------ */
/* Public DI surface                                                  */
/* ------------------------------------------------------------------ */

/**
 * Minimal calendar IPC surface this provider needs. Kept narrower than
 * `ElectronCalendarAPI` deliberately so tests can build a fake without
 * stubbing every event-CRUD endpoint.
 */
export interface CalendarWidgetApi {
  getEvents(start: Date, end: Date): Promise<CalendarWidgetIpcResponse<CalendarWidgetEventLike[]>>
  getSources(): Promise<CalendarWidgetIpcResponse<CalendarWidgetSourceLike[]>>
}

export interface CalendarWidgetIpcResponse<T> {
  success: boolean
  data?: T
  error?: string
}

/** Subset of `CalendarEventData` we actually consume. */
export interface CalendarWidgetEventLike {
  id?: string
  calendarId?: string
  title?: string
  description?: string | null
  location?: string | null
  startTime?: string | number | Date
  endTime?: string | number | Date
  allDay?: boolean | number
  startTz?: string | null
  endTz?: string | null
  /** Some IPC paths surface a per-event color directly. */
  color?: string
}

/** Subset of `CalendarSourceData` we actually consume. */
export interface CalendarWidgetSourceLike {
  id: string
  name: string
  color?: string
  enabled?: boolean
}

/**
 * Optional schedule runtime fetcher; threaded in by callers that want
 * the `schedule_runtime_card` to show real automation jobs. The
 * default adapter wires this to `window.electronAPI.agent.listSchedules`.
 */
export interface ScheduleRuntimeApi {
  listSchedules(): Promise<CalendarWidgetIpcResponse<ReadonlyArray<{
    name?: string
    enabled?: boolean
    nextRunAt?: string
    lastRunAt?: string
  }>>>
}

export interface WidgetFetchOptions {
  /**
   * IANA tz id used to compute the visible day / week window. Defaults
   * to whatever `Intl.DateTimeFormat().resolvedOptions().timeZone`
   * resolves to (typically the host OS local zone).
   */
  tz?: string
  /**
   * Reference instant. Defaults to `new Date()`. Useful for tests that
   * want a deterministic "today".
   */
  now?: Date
  /**
   * Optional locale for date-fns label formatting. Defaults to zhCN to
   * match the existing widget copy ("M月d日 EEEE", "今天 · M月d日").
   */
  locale?: typeof zhCN
}

/* ------------------------------------------------------------------ */
/* Time helpers                                                       */
/* ------------------------------------------------------------------ */

function resolveTimezone(input: string | undefined): string {
  if (input && input.length > 0) return input
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return tz && tz.length > 0 ? tz : 'UTC'
  } catch {
    return 'UTC'
  }
}

function dateToZdt(date: Date, tz: string): Temporal.ZonedDateTime {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO(tz)
}

/**
 * Returns the [startOfDay, endOfDay] pair (as Date) in the chosen tz.
 * The Dates we return are absolute instants that, when displayed in
 * `tz`, fall at 00:00:00 and 23:59:59.999 respectively.
 */
function dayWindow(now: Date, tz: string): { start: Date; end: Date } {
  const zdt = dateToZdt(now, tz)
  const startZdt = zdt.with({ hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 })
  const endZdt = zdt.with({ hour: 23, minute: 59, second: 59, millisecond: 999, microsecond: 0, nanosecond: 0 })
  return {
    start: new Date(startZdt.epochMilliseconds),
    end: new Date(endZdt.epochMilliseconds),
  }
}

/**
 * Returns the Monday-anchored week window [startOfMonday, endOfSunday]
 * in the chosen tz. We use Monday as the week start to match the
 * existing renderer locale (zhCN / date-fns).
 */
function weekWindow(now: Date, tz: string): { start: Date; end: Date; mondayInstant: Date } {
  const zdt = dateToZdt(now, tz)
  // Temporal dayOfWeek: Mon=1 ... Sun=7
  const offsetToMonday = (zdt.dayOfWeek + 6) % 7 // Mon -> 0, Sun -> 6
  const monday = zdt
    .with({ hour: 0, minute: 0, second: 0, millisecond: 0, microsecond: 0, nanosecond: 0 })
    .subtract({ days: offsetToMonday })
  const sunday = monday
    .add({ days: 6 })
    .with({ hour: 23, minute: 59, second: 59, millisecond: 999, microsecond: 0, nanosecond: 0 })
  return {
    start: new Date(monday.epochMilliseconds),
    end: new Date(sunday.epochMilliseconds),
    mondayInstant: new Date(monday.epochMilliseconds),
  }
}

function eventDateInTz(value: string | number | Date | undefined, tz: string): Temporal.ZonedDateTime | null {
  if (value === undefined || value === null) return null
  let ms: number
  if (value instanceof Date) {
    ms = value.getTime()
  } else if (typeof value === 'number') {
    // Treat as unix seconds when small, ms when large. The IPC currently
    // emits ISO strings but we tolerate both forms because tests might
    // construct number-based fixtures.
    ms = value < 10_000_000_000 ? value * 1000 : value
  } else {
    const parsed = Date.parse(value)
    if (Number.isNaN(parsed)) return null
    ms = parsed
  }
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(tz)
}

function sameWallDay(a: Temporal.ZonedDateTime, b: Temporal.ZonedDateTime): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day
}

function buildTimeLabel(event: CalendarWidgetEventLike, tz: string): string {
  if (event.allDay) return '全天'
  const start = eventDateInTz(event.startTime, tz)
  if (!start) return '未定时间'
  const startLabel = start.toPlainTime().toString({ smallestUnit: 'minute' }).slice(0, 5)
  const end = eventDateInTz(event.endTime, tz)
  if (!end) return startLabel
  const endLabel = end.toPlainTime().toString({ smallestUnit: 'minute' }).slice(0, 5)
  return `${startLabel} - ${endLabel}`
}

function compareStartAsc(a: CalendarWidgetEventLike, b: CalendarWidgetEventLike): number {
  const aMs = eventEpochMs(a.startTime) ?? 0
  const bMs = eventEpochMs(b.startTime) ?? 0
  return aMs - bMs
}

function eventEpochMs(value: string | number | Date | undefined): number | null {
  if (value === undefined || value === null) return null
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function durationHours(event: CalendarWidgetEventLike): number {
  const startMs = eventEpochMs(event.startTime)
  const endMs = eventEpochMs(event.endTime)
  if (startMs === null || endMs === null || endMs <= startMs) return 0
  return (endMs - startMs) / (60 * 60 * 1000)
}

function mapSourceNames(sources: ReadonlyArray<CalendarWidgetSourceLike>): Map<string, string> {
  return new Map(sources.map((source) => [source.id, source.name]))
}

function mapSourceColors(sources: ReadonlyArray<CalendarWidgetSourceLike>): Map<string, string | undefined> {
  return new Map(sources.map((source) => [source.id, source.color]))
}

/* ------------------------------------------------------------------ */
/* Fetcher implementations (DI form)                                  */
/* ------------------------------------------------------------------ */

export interface CalendarWidgetFetcher {
  fetchDaySchedule(options?: WidgetFetchOptions): Promise<DayScheduleSnapshot>
  fetchWeekSchedule(options?: WidgetFetchOptions): Promise<WeekScheduleSnapshot>
  fetchTimeAllocation(options?: WidgetFetchOptions): Promise<TimeAllocationSnapshot>
  fetchTodayFocusSnapshot(options?: WidgetFetchOptions): Promise<TodayFocusSnapshot>
  fetchScheduleRuntime(): Promise<ScheduleRuntimeSnapshot>
}

export interface CreateFetcherDeps {
  calendar: CalendarWidgetApi
  schedule?: ScheduleRuntimeApi
}

async function safeGetEvents(api: CalendarWidgetApi, start: Date, end: Date): Promise<CalendarWidgetEventLike[]> {
  try {
    const res = await api.getEvents(start, end)
    if (!res?.success || !Array.isArray(res.data)) return []
    return res.data
  } catch {
    return []
  }
}

async function safeGetSources(api: CalendarWidgetApi): Promise<CalendarWidgetSourceLike[]> {
  try {
    const res = await api.getSources()
    if (!res?.success || !Array.isArray(res.data)) return []
    return res.data
  } catch {
    return []
  }
}

export function createCalendarWidgetFetcher(deps: CreateFetcherDeps): CalendarWidgetFetcher {
  const { calendar, schedule } = deps

  async function fetchDaySchedule(options: WidgetFetchOptions = {}): Promise<DayScheduleSnapshot> {
    const tz = resolveTimezone(options.tz)
    const now = options.now ?? new Date()
    const locale = options.locale ?? zhCN
    const { start, end } = dayWindow(now, tz)
    const [events, sources] = await Promise.all([
      safeGetEvents(calendar, start, end),
      safeGetSources(calendar),
    ])
    const sourceNames = mapSourceNames(sources)
    const sourceColors = mapSourceColors(sources)
    const nowZdt = dateToZdt(now, tz)

    const filtered = events.filter((event) => {
      const startZdt = eventDateInTz(event.startTime, tz)
      return startZdt ? sameWallDay(startZdt, nowZdt) : false
    })

    return {
      dateLabel: format(toLabelDate(nowZdt), 'M月d日 EEEE', { locale }),
      events: filtered.sort(compareStartAsc).map((event) => ({
        title: String(event.title || '未命名事件'),
        timeLabel: buildTimeLabel(event, tz),
        accent: event.color || sourceColors.get(String(event.calendarId || '')) || '#5B8DEF',
        meta: sourceNames.get(String(event.calendarId || '')) || undefined,
      })),
    }
  }

  async function fetchWeekSchedule(options: WidgetFetchOptions = {}): Promise<WeekScheduleSnapshot> {
    const tz = resolveTimezone(options.tz)
    const now = options.now ?? new Date()
    const locale = options.locale ?? zhCN
    const { start: weekStart, end: weekEnd, mondayInstant } = weekWindow(now, tz)
    const events = await safeGetEvents(calendar, weekStart, weekEnd)

    const days: WeekScheduleSnapshot['days'] = []
    let mondayZdt = dateToZdt(mondayInstant, tz)
    for (let index = 0; index < 7; index += 1) {
      const dayZdt = mondayZdt.add({ days: index })
      const dayEvents = events.filter((event) => {
        const startZdt = eventDateInTz(event.startTime, tz)
        return startZdt ? sameWallDay(startZdt, dayZdt) : false
      })
      days.push({
        label: format(toLabelDate(dayZdt), 'EEE', { locale }),
        count: dayEvents.length,
        highlights: dayEvents
          .sort(compareStartAsc)
          .slice(0, 3)
          .map((event) => String(event.title || '未命名事件')),
      })
    }

    const mondayLabel = format(toLabelDate(mondayZdt), 'M月d日', { locale })
    const sundayZdt = mondayZdt.add({ days: 6 })
    const sundayLabel = format(toLabelDate(sundayZdt), 'M月d日', { locale })

    return {
      weekLabel: `${mondayLabel} - ${sundayLabel}`,
      days,
    }
  }

  async function fetchTimeAllocation(options: WidgetFetchOptions = {}): Promise<TimeAllocationSnapshot> {
    const tz = resolveTimezone(options.tz)
    const now = options.now ?? new Date()
    const { start: weekStart, end: weekEnd } = weekWindow(now, tz)
    const [events, sources] = await Promise.all([
      safeGetEvents(calendar, weekStart, weekEnd),
      safeGetSources(calendar),
    ])
    const sourceNames = mapSourceNames(sources)
    const sourceColors = mapSourceColors(sources)
    const buckets = new Map<string, { label: string; value: number; accent?: string }>()

    for (const event of events) {
      const hours = durationHours(event)
      if (hours <= 0) continue
      const calendarId = String(event.calendarId || 'unknown')
      const bucket = buckets.get(calendarId) ?? {
        label: sourceNames.get(calendarId) || '其他',
        value: 0,
        accent: event.color || sourceColors.get(calendarId) || '#5B8DEF',
      }
      bucket.value = Number((bucket.value + hours).toFixed(2))
      buckets.set(calendarId, bucket)
    }

    if (buckets.size === 0) {
      return {
        periodLabel: '本周时间分配',
        segments: [{ label: '暂无可统计的事件', value: 0, accent: '#94a3b8' }],
      }
    }

    return {
      periodLabel: '本周时间分配',
      segments: Array.from(buckets.values())
        .sort((left, right) => right.value - left.value)
        .slice(0, 6),
    }
  }

  async function fetchScheduleRuntime(): Promise<ScheduleRuntimeSnapshot> {
    if (!schedule) {
      return {
        heading: '自动计划',
        jobs: [{ name: '当前没有自动计划', status: 'paused', nextRun: undefined, lastRun: undefined }],
      }
    }
    let rows: ReadonlyArray<{ name?: string; enabled?: boolean; nextRunAt?: string; lastRunAt?: string }> = []
    try {
      const res = await schedule.listSchedules()
      rows = res?.success && Array.isArray(res.data) ? res.data : []
    } catch {
      rows = []
    }
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

  async function fetchTodayFocusSnapshot(options: WidgetFetchOptions = {}): Promise<TodayFocusSnapshot> {
    const tz = resolveTimezone(options.tz)
    const now = options.now ?? new Date()
    const locale = options.locale ?? zhCN
    const [day, runtime] = await Promise.all([
      fetchDaySchedule({ tz, now, locale }),
      fetchScheduleRuntime(),
    ])

    // "Next event" = first event whose start is strictly after `now`,
    // falling back to the first event of the day if everything is in
    // the past (still useful: "下一项安排：复盘" is more meaningful
    // than no highlight at all).
    const nowMs = now.getTime()
    const sourceEvents = await safeGetEvents(
      calendar,
      dayWindow(now, tz).start,
      dayWindow(now, tz).end,
    )
    const upcoming = sourceEvents
      .map((event) => ({ event, ms: eventEpochMs(event.startTime) ?? 0 }))
      .filter((entry) => entry.ms > nowMs)
      .sort((left, right) => left.ms - right.ms)
    const nextEvent = upcoming[0]?.event ?? null

    const nowZdt = dateToZdt(now, tz)
    const dayLabel = format(toLabelDate(nowZdt), '今天 · M月d日', { locale })

    const enabledCount = runtime.jobs.filter((job) => job.status === 'enabled').length
    return {
      dayLabel,
      highlights: [
        nextEvent
          ? `下一项安排：${String(nextEvent.title || '未命名事件')}`
          : day.events[0]
            ? `今天的安排：${day.events[0].title}`
            : '今天还没有安排事件',
        enabledCount > 0 ? `已启用 ${enabledCount} 个自动计划` : '当前没有启用中的自动计划',
      ],
      metrics: [
        { label: '今日事件', value: String(day.events.length) },
        { label: '启用计划', value: String(enabledCount) },
      ],
    }
  }

  return {
    fetchDaySchedule,
    fetchWeekSchedule,
    fetchTimeAllocation,
    fetchTodayFocusSnapshot,
    fetchScheduleRuntime,
  }
}

/**
 * Format a Temporal.ZonedDateTime as a plain JS Date carrying the same
 * wall-clock day. date-fns formats are tz-agnostic (they format the
 * Date in the host's local tz), so we synthesize a "wall-clock Date"
 * by reading y/m/d from the ZonedDateTime and constructing a local
 * Date with the same fields. This is only used for human-facing label
 * strings — never for IPC filtering.
 */
function toLabelDate(zdt: Temporal.ZonedDateTime): Date {
  return new Date(zdt.year, zdt.month - 1, zdt.day, 12, 0, 0, 0)
}

/* ------------------------------------------------------------------ */
/* Default adapter (window.electronAPI bridge)                        */
/* ------------------------------------------------------------------ */

/**
 * Build the default fetcher from `window.electronAPI`. Falls back to
 * an inert no-op when the global is missing (e.g. node tests that
 * never inject a fake) so the renderer cannot crash on cold paths.
 *
 * IMPORTANT: the calendar IPC channel returns `CalendarEventWire[]`
 * (Unix seconds + camelCase, see `src/shared/calendar-wire.ts`). The
 * `eventEpochMs` helper in this file does handle Unix seconds, but
 * relying on that implicit detection was the same shape mismatch that
 * caused the original "1970 on refresh" bug. Wrap the live API in a
 * normalizer so the fetcher always sees the canonical wire shape —
 * tests can still inject any compatible shape via `CalendarWidgetApi`.
 */
export function getDefaultCalendarWidgetFetcher(): CalendarWidgetFetcher {
  const electronAPI = (globalThis as { electronAPI?: unknown }).electronAPI
    ?? (globalThis as { window?: { electronAPI?: unknown } }).window?.electronAPI
  const calendarApi = (electronAPI as { calendar?: unknown })?.calendar as CalendarWidgetApi | undefined
  const agentApi = (electronAPI as { agent?: unknown })?.agent as ScheduleRuntimeApi | undefined

  if (!calendarApi) {
    return createCalendarWidgetFetcher({
      calendar: {
        async getEvents() { return { success: false, data: [] } },
        async getSources() { return { success: false, data: [] } },
      },
      schedule: agentApi,
    })
  }
  return createCalendarWidgetFetcher({
    calendar: wrapCalendarApiWithWireNormalization(calendarApi),
    schedule: agentApi,
  })
}

/**
 * Normalize the live calendar IPC response into wire shape before the
 * widget fetcher consumes it. The serializer accepts both snake_case
 * DB rows and camelCase EventInstance and emits a stable
 * `CalendarEventWire[]` — so any future drift on the main side surfaces
 * as a wire-shape mismatch, not as silently bad widget data.
 */
function wrapCalendarApiWithWireNormalization(api: CalendarWidgetApi): CalendarWidgetApi {
  return {
    async getEvents(start, end) {
      const res = await api.getEvents(start, end)
      if (!res.success || !res.data) return res
      // Lazy-load the wire helper to avoid bundling it in tests that
      // inject fake APIs directly.
      const { serializeEventToWire } = await import('../../../shared/calendar-wire')
      const normalized = (res.data as Array<Record<string, unknown>>).map((event) => {
        const wire = serializeEventToWire(event as Parameters<typeof serializeEventToWire>[0])
        // CalendarWidgetEventLike consumes a subset; the wire shape is a
        // superset. Cast through `unknown` to acknowledge the widening.
        return wire as unknown as CalendarWidgetEventLike
      })
      return { ...res, data: normalized }
    },
    async getSources() {
      return api.getSources()
    },
  }
}
