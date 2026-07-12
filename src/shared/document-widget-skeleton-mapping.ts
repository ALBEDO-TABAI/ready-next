import type { DocumentWidgetComponentSpecSummary } from './document-widget-parse'
import type { WidgetSkeletonSpec, WidgetSkeletonId, WidgetBackgroundMode } from './document-widget-skeletons'
import { resolveInfoCardKicker, resolveInfoCardRamp } from './document-widget-info-card'

type Record_ = Record<string, unknown>

function toRecord(value: unknown): Record_ {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record_
  return {}
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function pickNonEmpty(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const text = readString(candidate)
    if (text) return text
  }
  return ''
}

const BAR_RAMP = 'sky'
const LINE_RAMP = 'indigo'
const PIE_RAMP = 'emerald'

export interface MapComponentSpecOptions {
  backgroundMode?: WidgetBackgroundMode
}

export function mapComponentSpecToSkeletonSpec(
  spec: DocumentWidgetComponentSpecSummary,
  options?: MapComponentSpecOptions,
): WidgetSkeletonSpec | null {
  if (!spec || typeof spec.component !== 'string') return null
  const component = spec.component.trim()
  if (!component) return null
  const props = toRecord(spec.props)
  const backgroundMode = options?.backgroundMode

  switch (component) {
    case 'info_card':
      return wrap('single_focus', mapInfoCard(props), backgroundMode)
    case 'callout_block':
      return wrap('single_focus', mapCalloutBlock(props), backgroundMode)
    case 'stats_card':
      return wrap('metric_grid', mapStatsCard(props), backgroundMode)
    case 'bar_chart':
      return wrap('chart_focus', mapBarChart(props), backgroundMode)
    case 'line_chart':
      return wrap('chart_focus', mapLineChart(props), backgroundMode)
    case 'data_table':
      return wrap('metric_grid', mapDataTable(props), backgroundMode)
    case 'tab_info_block':
      return wrap('dual_compare', mapTabInfoBlock(props), backgroundMode)
    case 'comparison_grid':
      return wrap('dual_compare', mapComparisonGrid(props), backgroundMode)
    case 'progress_snapshot':
      return wrap('metric_grid', mapProgressSnapshot(props), backgroundMode)
    case 'weekly_focus_chart':
      return wrap('dual_compare', mapWeeklyFocusChart(props), backgroundMode)
    case 'mini_calculator':
      return wrap('freeform_interactive', mapMiniCalculator(props), backgroundMode)
    case 'flow_diagram':
      return wrap('process_flow', mapFlowDiagram(props), backgroundMode)
    case 'relationship_graph':
      return wrap('relation_map', mapRelationshipGraph(props), backgroundMode)
    case 'day_schedule_card':
      return wrap('vertical_timeline', mapDaySchedule(props), backgroundMode)
    case 'week_schedule_card':
      return wrap('vertical_timeline', mapWeekSchedule(props), backgroundMode)
    case 'time_allocation_chart':
      return wrap('chart_focus', mapTimeAllocationChart(props), backgroundMode)
    case 'schedule_runtime_card':
      return wrap('vertical_timeline', mapScheduleRuntimeCard(props), backgroundMode)
    case 'todo_list_manual':
      return wrap('vertical_timeline', mapTodoListManual(props), backgroundMode)
    case 'weekly_plan_board_manual':
      return wrap('grid_collection', mapWeeklyPlanBoardManual(props), backgroundMode)
    case 'habit_streak_manual':
      return wrap('grid_collection', mapHabitStreakManual(props), backgroundMode)
    case 'today_focus_snapshot':
      return wrap('metric_grid', mapTodayFocusSnapshot(props), backgroundMode)
    default:
      return null
  }
}

function wrap(
  skeleton: WidgetSkeletonId,
  props: Record_,
  backgroundMode?: WidgetBackgroundMode,
): WidgetSkeletonSpec {
  const spec: WidgetSkeletonSpec = { skeleton, props }
  if (backgroundMode) spec.background_mode = backgroundMode
  return spec
}

function mapInfoCard(props: Record_): Record_ {
  const title = pickNonEmpty(props.heading, props.title)
  const body = pickNonEmpty(props.body, '…')
  const facts = readArray(props.facts)
    .map((entry) => {
      const record = toRecord(entry)
      const label = readString(record.label)
      const value = readString(record.value)
      return label && value ? { label, value } : null
    })
    .filter((entry): entry is { label: string; value: string } => entry != null)
  const points = readArray(props.points)
    .map((item) => readString(item))
    .filter((text) => text.length > 0)
  const tone = readString(props.tone)
  return {
    title,
    body: body || '（空）',
    facts: facts.length > 0 ? facts : undefined,
    points: points.length > 0 ? points : undefined,
    kicker: resolveInfoCardKicker(tone),
    ramp: resolveInfoCardRamp(tone),
    decoration: 'none',
  }
}

function mapCalloutBlock(props: Record_): Record_ {
  const base = mapInfoCard(props)
  const tone = readString(props.tone)
  const rampByTone: Record<string, string> = {
    neutral: 'slate',
    info: 'indigo',
    success: 'emerald',
    warning: 'amber',
    danger: 'rose',
  }
  return {
    ...base,
    ramp: rampByTone[tone] || 'amber',
    decoration: 'left_bar',
  }
}

function mapStatsCard(props: Record_): Record_ {
  const title = pickNonEmpty(props.heading, props.title, '关键指标')
  const metrics = readArray(props.metrics).map((entry) => {
    const record = toRecord(entry)
    return {
      label: pickNonEmpty(record.label, '指标'),
      value: pickNonEmpty(record.value, '-'),
      unit: readString(record.unit) || undefined,
      delta: readString(record.delta) || undefined,
      delta_direction: pickDeltaDirection(record.deltaDirection ?? record.delta_direction),
    }
  })
  return { title, metrics: padMetrics(metrics) }
}

function mapDataTable(props: Record_): Record_ {
  const title = pickNonEmpty(props.heading, props.title, '数据一览')
  const rows = readArray(props.rows)
  const metrics = rows.slice(0, 6).map((row) => {
    const record = toRecord(row)
    const cells = readArray(record.cells).map((cell) => readString(cell))
    return {
      label: readString(record.header ?? record.label) || cells[0] || '条目',
      value: cells[1] ?? cells[0] ?? '-',
    }
  })
  return { title, metrics: padMetrics(metrics) }
}

function mapBarChart(props: Record_): Record_ {
  return mapSeriesChart(props, 'bar', BAR_RAMP)
}

function mapLineChart(props: Record_): Record_ {
  return mapSeriesChart(props, 'line', LINE_RAMP)
}

function mapSeriesChart(props: Record_, type: 'bar' | 'line' | 'pie', ramp: string): Record_ {
  const title = pickNonEmpty(props.heading, props.title, type === 'line' ? '趋势' : '对比')
  const series = readArray(props.series).map((entry) => {
    const record = toRecord(entry)
    const value = readNumber(record.value) ?? 0
    return { label: pickNonEmpty(record.label, '—'), value }
  }).filter((d) => d.label.length > 0)
  const safeSeries = series.length > 0 ? series : [{ label: '—', value: 0 }]
  return {
    title,
    chart: {
      type,
      data: safeSeries,
      ramp,
    },
    insight: readString(props.annotation) || undefined,
    subtitle: readString(props.yLabel) || undefined,
  }
}

function mapTabInfoBlock(props: Record_): Record_ {
  const title = pickNonEmpty(props.heading, props.title, '分组信息')
  const tabs = readArray(props.tabs)
  const leftTab = toRecord(tabs[0])
  const rightTab = toRecord(tabs[1] ?? tabs[0])
  return {
    title,
    left: {
      heading: pickNonEmpty(leftTab.label, leftTab.heading, '组 A'),
      items: extractListItems(leftTab.body, leftTab.points),
      ramp: 'indigo',
    },
    right: {
      heading: pickNonEmpty(rightTab.label, rightTab.heading, '组 B'),
      items: extractListItems(rightTab.body, rightTab.points),
      ramp: 'rose',
    },
  }
}

function mapComparisonGrid(props: Record_): Record_ {
  const title = pickNonEmpty(props.heading, props.title, '方案对比')
  const columns = readArray(props.columns)
  const leftCol = toRecord(columns[0])
  const rightCol = toRecord(columns[1] ?? columns[0])
  return {
    title,
    left: {
      heading: pickNonEmpty(leftCol.heading, leftCol.label, '方案 A'),
      items: extractListItems(undefined, leftCol.points ?? leftCol.items),
      ramp: 'indigo',
    },
    right: {
      heading: pickNonEmpty(rightCol.heading, rightCol.label, '方案 B'),
      items: extractListItems(undefined, rightCol.points ?? rightCol.items),
      ramp: 'rose',
    },
  }
}

function mapProgressSnapshot(props: Record_): Record_ {
  const title = pickNonEmpty(props.heading, props.title, '完成度')
  const items = readArray(props.items).map((entry) => {
    const record = toRecord(entry)
    const progress = readNumber(record.percent ?? record.progress ?? record.value) ?? 0
    return {
      label: pickNonEmpty(record.label, record.name, '项目'),
      value: `${Math.round(progress)}`,
      unit: '%',
      delta_direction: progress >= 100 ? 'up' : 'flat',
    }
  })
  return { title, metrics: padMetrics(items) }
}

function mapWeeklyFocusChart(props: Record_): Record_ {
  return {
    title: pickNonEmpty(props.heading, props.title, '焦点'),
    left: {
      heading: pickNonEmpty(props.currentLabel, '本周'),
      items: extractListItems(undefined, props.currentItems),
      ramp: 'indigo',
    },
    right: {
      heading: pickNonEmpty(props.nextLabel, '下周'),
      items: extractListItems(undefined, props.nextItems),
      ramp: 'emerald',
    },
  }
}

function mapMiniCalculator(props: Record_): Record_ {
  const heading = pickNonEmpty(props.heading, props.title, '交互式计算器')
  const fields = readArray(props.fields)
  const placeholderCode = `<div class="card stack" style="gap:12px;">
  <div class="title">${escape(heading)}</div>
  <div class="subtitle">兼容模式：mini_calculator 已迁移为 freeform_interactive 骨架，请在抽屉中重新配置字段。</div>
  <div class="muted" style="font-size:12px;">共 ${fields.length} 个字段</div>
</div>`
  return {
    title: heading,
    widget_code: placeholderCode,
    aspect_ratio: '4:3',
    supports_animation: true,
  }
}

function mapFlowDiagram(props: Record_): Record_ {
  const heading = pickNonEmpty(props.heading, props.title, '流程')
  const nodes = readArray(props.nodes).map((node) => {
    const record = toRecord(node)
    const id = pickNonEmpty(record.id, record.label)
    return { id, label: pickNonEmpty(record.label, record.id, '节点') }
  }).filter((node) => node.id.length > 0)
  const knownIds = new Set(nodes.map((node) => node.id))
  const edges = readArray(props.edges).map((edge) => {
    const record = toRecord(edge)
    return {
      from: readString(record.from),
      to: readString(record.to),
      label: readString(record.label) || undefined,
    }
  }).filter((edge) => knownIds.has(edge.from) && knownIds.has(edge.to))
  const steps = nodes.slice(0, 10).map((node) => {
    const outgoing = edges.filter((edge) => edge.from === node.id)
    if (outgoing.length >= 2) {
      return {
        label: node.label,
        kind: 'decision',
        branches: outgoing.slice(0, 3).map((edge) => ({
          label: nodes.find((candidate) => candidate.id === edge.to)?.label || edge.to,
          detail: edge.label,
        })),
      }
    }
    return {
      label: node.label,
      detail: outgoing[0]?.label ? `→ ${outgoing[0].label}` : undefined,
    }
  })
  while (steps.length < 2) steps.push({ label: '（待补充）', detail: undefined })
  return { heading, steps }
}

function mapRelationshipGraph(props: Record_): Record_ {
  const heading = pickNonEmpty(props.heading, props.title)
  const spec: Record_ = {
    nodes: readArray(props.nodes),
    edges: readArray(props.edges),
  }
  if (heading) spec.heading = heading
  const groups = readArray(props.groups)
  if (groups.length > 0) spec.groups = groups
  const note = readString(props.note)
  if (note) spec.note = note
  return spec
}

function mapDaySchedule(props: Record_): Record_ {
  const title = pickNonEmpty(props.heading, props.title, '日程')
  const dateLabel = pickNonEmpty(props.dateLabel, '今天')
  const events = readArray(props.events).slice(0, 12).map((entry) => {
    const record = toRecord(entry)
    return {
      time: pickNonEmpty(record.startTime, record.time, '全天'),
      heading: pickNonEmpty(record.title, record.heading, '日程'),
      body: readString(record.location) || undefined,
      status: mapEventStatus(record.status),
    }
  })
  return {
    title,
    axis_label: dateLabel,
    events: ensureEvents(events),
  }
}

function mapWeekSchedule(props: Record_): Record_ {
  const title = pickNonEmpty(props.heading, props.title, '本周日程')
  const weekLabel = pickNonEmpty(props.weekLabel, '本周')
  const days = readArray(props.days)
  const events: Array<Record_> = []
  for (const day of days) {
    const record = toRecord(day)
    const label = pickNonEmpty(record.dateLabel, record.day, '某日')
    const evs = readArray(record.events).slice(0, 3)
    if (evs.length === 0) {
      events.push({ time: label, heading: '（无日程）', status: 'pending' })
    } else {
      for (const ev of evs) {
        const evRec = toRecord(ev)
        events.push({
          time: label,
          heading: pickNonEmpty(evRec.title, '日程'),
          status: mapEventStatus(evRec.status),
        })
      }
    }
    if (events.length >= 12) break
  }
  return {
    title,
    axis_label: weekLabel,
    events: ensureEvents(events.slice(0, 12)),
  }
}

function mapTimeAllocationChart(props: Record_): Record_ {
  const title = pickNonEmpty(props.heading, props.title, '时间分配')
  const segments = readArray(props.segments).map((entry) => {
    const record = toRecord(entry)
    return { label: pickNonEmpty(record.label, '片段'), value: readNumber(record.value) ?? 0 }
  })
  const safe = segments.length > 0 ? segments : [{ label: '—', value: 1 }]
  return {
    title,
    subtitle: readString(props.periodLabel) || undefined,
    chart: { type: 'pie', data: safe, ramp: PIE_RAMP },
  }
}

function mapScheduleRuntimeCard(props: Record_): Record_ {
  const title = pickNonEmpty(props.heading, props.title, '自动计划')
  const jobs = readArray(props.jobs).slice(0, 12).map((entry) => {
    const record = toRecord(entry)
    return {
      time: pickNonEmpty(record.nextRun, record.schedule, '—'),
      heading: pickNonEmpty(record.name, record.title, '任务'),
      body: readString(record.summary) || undefined,
      status: mapJobStatus(record.status),
    }
  })
  return { title, events: ensureEvents(jobs) }
}

function mapTodoListManual(props: Record_): Record_ {
  const title = pickNonEmpty(props.heading, props.title, '待办')
  const items = readArray(props.items).slice(0, 12).map((entry, index) => {
    const record = toRecord(entry)
    const done = record.done === true || record.checked === true
    return {
      time: readString(record.dueAt) || `待办 ${index + 1}`,
      heading: pickNonEmpty(record.label, record.title, `任务 ${index + 1}`),
      status: done ? 'done' : 'pending',
    }
  })
  return { title, events: ensureEvents(items) }
}

function mapWeeklyPlanBoardManual(props: Record_): Record_ {
  const title = pickNonEmpty(props.heading, props.title, '本周计划')
  const lanes = readArray(props.lanes)
  const items: Record_[] = []
  for (const lane of lanes) {
    const record = toRecord(lane)
    const laneLabel = pickNonEmpty(record.heading, record.title, '泳道')
    for (const card of readArray(record.cards ?? record.items).slice(0, 6)) {
      const cardRecord = toRecord(card)
      items.push({
        label: pickNonEmpty(cardRecord.label, cardRecord.title, '条目'),
        status: 'pending',
        ramp: 'indigo',
      })
      if (items.length >= 20) break
    }
    if (items.length === 0) {
      items.push({ label: laneLabel, status: 'pending', ramp: 'slate' })
    }
    if (items.length >= 20) break
  }
  return {
    title,
    cols: 3,
    item_shape: 'free',
    items: ensureGridItems(items),
  }
}

function mapHabitStreakManual(props: Record_): Record_ {
  const title = pickNonEmpty(props.heading, props.title, '习惯追踪')
  const habits = readArray(props.habits).slice(0, 20).map((entry) => {
    const record = toRecord(entry)
    const completed = record.done === true || record.completed === true
    return {
      label: pickNonEmpty(record.label, record.name, '习惯'),
      status: completed ? 'done' : 'pending',
      ramp: completed ? 'emerald' : 'slate',
    }
  })
  return {
    title,
    cols: 3,
    item_shape: 'square',
    items: ensureGridItems(habits),
  }
}

function mapTodayFocusSnapshot(props: Record_): Record_ {
  const title = pickNonEmpty(props.dayLabel, props.heading, '今日焦点')
  const highlights = readArray(props.highlights).map((entry) => readString(entry)).filter(Boolean)
  const metrics = readArray(props.metrics).map((entry) => {
    const record = toRecord(entry)
    return {
      label: pickNonEmpty(record.label, '指标'),
      value: pickNonEmpty(record.value, '-'),
      unit: readString(record.unit) || undefined,
    }
  })
  const combined = metrics.length > 0
    ? metrics
    : highlights.map((highlight, index) => ({
        label: `重点 ${index + 1}`,
        value: highlight,
      }))
  return { title, metrics: padMetrics(combined) }
}

function pickDeltaDirection(value: unknown): 'up' | 'down' | 'flat' | undefined {
  const text = readString(value)
  if (text === 'up' || text === 'down' || text === 'flat') return text
  return undefined
}

function mapEventStatus(value: unknown): 'done' | 'active' | 'pending' | 'blocked' {
  const text = readString(value)
  if (text === 'done' || text === 'active' || text === 'pending' || text === 'blocked') return text
  return 'pending'
}

function mapJobStatus(value: unknown): 'done' | 'active' | 'pending' | 'blocked' {
  const text = readString(value)
  if (text === 'running') return 'active'
  if (text === 'failed') return 'blocked'
  if (text === 'idle' || text === 'scheduled') return 'pending'
  if (text === 'succeeded' || text === 'done') return 'done'
  return 'pending'
}

function padMetrics(metrics: Record_[]): Record_[] {
  if (metrics.length >= 2) return metrics.slice(0, 6)
  if (metrics.length === 1) return [...metrics, { label: '—', value: '—' }]
  return [
    { label: '—', value: '—' },
    { label: '—', value: '—' },
  ]
}

function ensureEvents(events: Record_[]): Record_[] {
  if (events.length === 0) return [{ time: '—', heading: '（暂无）', status: 'pending' }]
  return events.slice(0, 12)
}

function ensureGridItems(items: Record_[]): Record_[] {
  if (items.length >= 2) return items.slice(0, 20)
  if (items.length === 1) return [...items, { label: '—', status: 'pending', ramp: 'slate' }]
  return [
    { label: '—', status: 'pending', ramp: 'slate' },
    { label: '—', status: 'pending', ramp: 'slate' },
  ]
}

function extractListItems(bodyCandidate: unknown, listCandidate: unknown): string[] {
  const list = readArray(listCandidate)
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim()
      const record = toRecord(entry)
      return pickNonEmpty(record.label, record.title, record.text, record.body)
    })
    .filter((text) => text.length > 0)
  if (list.length > 0) return list.slice(0, 8)
  const body = readString(bodyCandidate)
  if (body) {
    const split = body
      .split(/\r?\n|[•·]/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (split.length > 0) return split.slice(0, 8)
    return [body]
  }
  return ['—']
}

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
