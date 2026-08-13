/**
 * L5-A — Document widget compile entrypoint (renderer side).
 *
 * Two responsibilities live here:
 *
 *   1. Normalize the LLM-emitted spec into the strict
 *      `DocumentWidgetComponentSpec` shape (component name + props
 *      + optional dataSource) so downstream compile is deterministic.
 *
 *   2. For widgets whose `sourceType` is `calendar`, build
 *      a `DocumentWidgetCompileContext` from the live calendar IPC.
 *      The compile pipeline reaches into the context whenever `props`
 *      are missing.
 *
 * Important bug fix in L5-A:
 *   Previously the compile context was only built when the LLM
 *   remembered to set `spec.dataSource`. The 4 calendar widgets
 *   (`day_schedule_card`, `week_schedule_card`, `time_allocation_chart`,
 *   `today_focus_snapshot`) silently rendered
 *   the "暂无安排" empty state whenever the model omitted that field.
 *   We now treat calendar-backed widgets as auto-fetch by default: if
 *   `props` is missing AND the widget is one of the four, we
 *   transparently fill in a `dataSource` and pull live snapshots.
 *   The LLM can opt out by setting `dataSource.autoFetch: false`
 *   together with explicit `props` (manual data path).
 *
 * Boundary notes (CLAUDE §6.8.1 + §6.9):
 *   - The widget renderer never participates in `live-info-intent` or
 *     `arbitrateSkeletonForUserText`. We only translate IPC payloads
 *     into `DocumentWidgetCompileContext` shapes.
 *   - We must NOT issue any user-facing instruction or chat message
 *     from this compile path.
 */

import {
  compileDocumentWidgetSpec,
  type DocumentWidgetComponentSpec,
  type DocumentWidgetCompileContext,
} from '../../../shared/document-widget-openui'
import {
  getDefaultCalendarWidgetFetcher,
  type CalendarWidgetFetcher,
  type WidgetFetchOptions,
} from '../calendar/widget-data-provider'

/* ------------------------------------------------------------------ */
/* Component classification                                           */
/* ------------------------------------------------------------------ */

const CALENDAR_SOURCED_WIDGETS: ReadonlySet<string> = new Set([
  'day_schedule_card',
  'week_schedule_card',
  'time_allocation_chart',
  'today_focus_snapshot',
])

function isCalendarBackedWidget(name: string): boolean {
  return CALENDAR_SOURCED_WIDGETS.has(name)
}

/* ------------------------------------------------------------------ */
/* Spec normalization (LLM -> strict shape)                           */
/* ------------------------------------------------------------------ */

function toPointText(item: unknown): string | null {
  if (typeof item === 'string') {
    const normalized = item.trim()
    return normalized || null
  }
  if (!item || typeof item !== 'object') return null
  const record = item as Record<string, unknown>
  const label = typeof record.label === 'string' ? record.label.trim() : ''
  const value = typeof record.value === 'string' ? record.value.trim() : ''
  const text = [label, value].filter(Boolean).join('：')
  return text || null
}

function normalizeFlatComponentProps(
  component: string,
  props: Record<string, unknown>,
): Record<string, unknown> {
  if (component === 'info_card' || component === 'callout_block') {
    const points = Array.isArray(props.points)
      ? props.points
      : Array.isArray(props.items)
        ? (props.items as unknown[]).map(toPointText).filter(Boolean)
        : undefined
    const footer = typeof props.footer === 'string' && props.footer.trim()
      ? props.footer.trim()
      : null
    return {
      ...props,
      heading: typeof props.heading === 'string' ? props.heading : typeof props.title === 'string' ? props.title : undefined,
      body: typeof props.body === 'string' ? props.body : typeof props.content === 'string' ? props.content : undefined,
      points: footer && Array.isArray(points) ? [...points, footer] : points,
    }
  }

  if (component === 'stats_card' && !Array.isArray(props.metrics) && Array.isArray(props.items)) {
    return {
      ...props,
      heading: typeof props.heading === 'string' ? props.heading : typeof props.title === 'string' ? props.title : undefined,
      metrics: props.items,
    }
  }

  return props
}

function normalizeIncomingComponentSpec(spec: DocumentWidgetComponentSpec): DocumentWidgetComponentSpec {
  const record = spec as unknown as Record<string, unknown>
  const component =
    typeof record.component === 'string'
      ? record.component
      : typeof record.componentType === 'string'
        ? record.componentType
        : ''

  const rawProps = record.props && typeof record.props === 'object'
    ? { ...(record.props as Record<string, unknown>) }
    : Object.fromEntries(
      Object.entries(record).filter(([key]) => !['component', 'componentType', 'props', 'dataSource'].includes(key)),
    )
  const normalizedProps = normalizeFlatComponentProps(component, rawProps)

  return {
    component,
    props: Object.keys(normalizedProps).length > 0 ? normalizedProps : undefined,
    dataSource: record.dataSource && typeof record.dataSource === 'object'
      ? record.dataSource as DocumentWidgetComponentSpec['dataSource']
      : undefined,
  }
}

/* ------------------------------------------------------------------ */
/* Auto-fetch promotion                                               */
/* ------------------------------------------------------------------ */

/**
 * For the 4 calendar-backed widgets, decide whether the compile path
 * should fetch live data instead of just trusting the LLM's `props`.
 *
 * Rules:
 *   - If `props` is present, the LLM is providing static / curated
 *     data. We honor it (existing behavior; matches §6.8.1's "do not
 *     write fake data and silently replace").
 *   - If `dataSource` is present, the LLM has explicitly opted into
 *     the live path. Fetch.
 *   - Otherwise, for calendar-backed widgets, promote to live fetch
 *     by synthesizing a `dataSource` with `autoFetch: true`. This is
 *     the L5-A fix.
 */
function maybePromoteAutoFetch(spec: DocumentWidgetComponentSpec): DocumentWidgetComponentSpec {
  if (spec.props) return spec
  if (spec.dataSource) return spec
  if (!isCalendarBackedWidget(spec.component)) return spec

  return { ...spec, dataSource: { type: 'calendar' } }
}

/* ------------------------------------------------------------------ */
/* Compile context builder                                            */
/* ------------------------------------------------------------------ */

export interface CompileContextDeps {
  fetcher?: CalendarWidgetFetcher
  fetchOptions?: WidgetFetchOptions
}

async function buildCompileContext(
  spec: DocumentWidgetComponentSpec,
  deps: CompileContextDeps,
): Promise<DocumentWidgetCompileContext> {
  const fetcher = deps.fetcher ?? getDefaultCalendarWidgetFetcher()
  const fetchOptions = deps.fetchOptions
  switch (spec.component) {
    case 'day_schedule_card':
      return { calendar: await fetcher.fetchDaySchedule(fetchOptions) }
    case 'week_schedule_card':
      return { calendarWeek: await fetcher.fetchWeekSchedule(fetchOptions) }
    case 'time_allocation_chart':
      return { timeAllocation: await fetcher.fetchTimeAllocation(fetchOptions) }
    case 'today_focus_snapshot':
      return { todayFocus: await fetcher.fetchTodayFocusSnapshot(fetchOptions) }
    default:
      return {}
  }
}

/* ------------------------------------------------------------------ */
/* Public entrypoint                                                  */
/* ------------------------------------------------------------------ */

export async function compileDocumentWidgetComponentSpec(
  spec: DocumentWidgetComponentSpec,
  deps: CompileContextDeps = {},
): Promise<{
  component: string
  widgetCode: string
}> {
  const normalizedSpec = normalizeIncomingComponentSpec(spec)
  const promotedSpec = maybePromoteAutoFetch(normalizedSpec)
  const context = promotedSpec.dataSource ? await buildCompileContext(promotedSpec, deps) : undefined
  return compileDocumentWidgetSpec(promotedSpec, context)
}

/**
 * Re-export so renderer callers can build a fetcher with their own DI
 * (e.g. an integration test that swaps in a fake `CalendarWidgetApi`).
 */
export {
  createCalendarWidgetFetcher,
  getDefaultCalendarWidgetFetcher,
  type CalendarWidgetFetcher,
  type CalendarWidgetApi,
  type CalendarWidgetEventLike,
  type CalendarWidgetSourceLike,
  type WidgetFetchOptions,
} from '../calendar/widget-data-provider'
