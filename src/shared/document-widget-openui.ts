import { z } from 'zod'
import { createLibrary, defineComponent } from './openui-lite'

export type DocumentWidgetComponentGroup = 'common-display' | 'personal-data'
export type DocumentWidgetDataSourceType = 'manual' | 'calendar' | 'schedule'
export type DocumentWidgetImplementation = 'svg' | 'chartjs' | 'html-inline-script'
export type DocumentWidgetActionPolicy = 'readonly' | 'local-toggle' | 'trigger-existing-writeback'

const metricSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  accent: z.string().optional(),
  trend: z.string().optional(),
})

const chartDatumSchema = z.object({
  label: z.string().min(1),
  value: z.number(),
  accent: z.string().optional(),
})

const tableRowSchema = z.array(z.string())

const calloutToneSchema = z.enum(['info', 'success', 'warning', 'danger', 'neutral'])

const tabSchema = z.object({
  label: z.string().min(1),
  body: z.string().min(1),
  points: z.array(z.string()).optional(),
})

const compareColumnSchema = z.object({
  title: z.string().min(1),
  points: z.array(z.string()).min(1),
})

const progressItemSchema = z.object({
  label: z.string().min(1),
  value: z.number().min(0),
  max: z.number().min(1).optional(),
  displayValue: z.string().optional(),
})

const scheduleEventSchema = z.object({
  title: z.string().min(1),
  timeLabel: z.string().min(1),
  accent: z.string().optional(),
  meta: z.string().optional(),
})

const weeklyFocusItemSchema = z.object({
  label: z.string().min(1),
  detail: z.string().optional(),
})

const weekDaySchema = z.object({
  label: z.string().min(1),
  count: z.number().min(0),
  highlights: z.array(z.string()).optional(),
})

const scheduleJobSchema = z.object({
  name: z.string().min(1),
  status: z.enum(['enabled', 'paused', 'running', 'error']),
  nextRun: z.string().optional(),
  lastRun: z.string().optional(),
})

const todoItemSchema = z.object({
  text: z.string().min(1),
  done: z.boolean().optional(),
  note: z.string().optional(),
})

const weeklyLaneSchema = z.object({
  title: z.string().min(1),
  items: z.array(z.string()).min(1),
})

const habitSchema = z.object({
  name: z.string().min(1),
  streak: z.number().min(0),
  completedToday: z.boolean().optional(),
  weekMarks: z.array(z.boolean()).length(7),
})

const focusMetricSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
})

const commonTextProps = {
  heading: z.string().optional(),
}

const componentSchemas = {
  info_card: z.object({
    ...commonTextProps,
    body: z.string().min(1),
    tone: calloutToneSchema.optional(),
    points: z.array(z.string()).optional(),
  }),
  stats_card: z.object({
    ...commonTextProps,
    metrics: z.array(metricSchema).min(1).max(6),
  }),
  bar_chart: z.object({
    ...commonTextProps,
    series: z.array(chartDatumSchema).min(1).max(8),
    yLabel: z.string().optional(),
  }),
  line_chart: z.object({
    ...commonTextProps,
    series: z.array(chartDatumSchema).min(2).max(12),
    yLabel: z.string().optional(),
    annotation: z.string().optional(),
  }),
  data_table: z.object({
    ...commonTextProps,
    columns: z.array(z.string().min(1)).min(1).max(6),
    rows: z.array(tableRowSchema).min(1).max(12),
  }),
  callout_block: z.object({
    ...commonTextProps,
    body: z.string().min(1),
    tone: calloutToneSchema.optional(),
    points: z.array(z.string()).optional(),
  }),
  tab_info_block: z.object({
    ...commonTextProps,
    tabs: z.array(tabSchema).min(2).max(4),
  }),
  comparison_grid: z.object({
    ...commonTextProps,
    columns: z.array(compareColumnSchema).min(2).max(4),
  }),
  progress_snapshot: z.object({
    ...commonTextProps,
    items: z.array(progressItemSchema).min(1).max(6),
  }),
  weekly_focus_chart: z.object({
    heading: z.string().optional(),
    currentLabel: z.string().min(1),
    nextLabel: z.string().min(1),
    currentItems: z.array(weeklyFocusItemSchema).min(1).max(5),
    nextItems: z.array(weeklyFocusItemSchema).min(1).max(5),
  }),
  mini_calculator: z.object({
    heading: z.string().optional(),
    fields: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      min: z.number().optional(),
      max: z.number().optional(),
      value: z.number().optional(),
    })).min(2).max(6),
    outputLabel: z.string().min(1),
  }),
  flow_diagram: z.object({
    heading: z.string().optional(),
    nodes: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
    })).min(2).max(8),
    edges: z.array(z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      label: z.string().optional(),
    })).min(1).max(10),
  }),
  day_schedule_card: z.object({
    heading: z.string().optional(),
    dateLabel: z.string().min(1),
    events: z.array(scheduleEventSchema).min(0).max(12),
  }),
  week_schedule_card: z.object({
    heading: z.string().optional(),
    weekLabel: z.string().min(1),
    days: z.array(weekDaySchema).min(1).max(7),
  }),
  time_allocation_chart: z.object({
    heading: z.string().optional(),
    periodLabel: z.string().min(1),
    segments: z.array(chartDatumSchema).min(1).max(8),
  }),
  schedule_runtime_card: z.object({
    heading: z.string().optional(),
    jobs: z.array(scheduleJobSchema).min(1).max(8),
  }),
  todo_list_manual: z.object({
    heading: z.string().optional(),
    items: z.array(todoItemSchema).min(1).max(12),
  }),
  weekly_plan_board_manual: z.object({
    heading: z.string().optional(),
    lanes: z.array(weeklyLaneSchema).min(2).max(4),
  }),
  habit_streak_manual: z.object({
    heading: z.string().optional(),
    habits: z.array(habitSchema).min(1).max(6),
  }),
  today_focus_snapshot: z.object({
    heading: z.string().optional(),
    dayLabel: z.string().min(1),
    highlights: z.array(z.string()).min(1).max(6),
    metrics: z.array(focusMetricSchema).min(1).max(4),
  }),
} as const

export type DocumentWidgetComponentName = keyof typeof componentSchemas

export interface DocumentWidgetComponentSpec {
  component: DocumentWidgetComponentName | string
  props?: Record<string, unknown>
  dataSource?: {
    type: DocumentWidgetDataSourceType
    preset?: string
    date?: string
  }
}

export interface DocumentWidgetValidateResult {
  ok: boolean
  errors: string[]
}

export interface DocumentWidgetCatalogEntry {
  name: DocumentWidgetComponentName
  group: DocumentWidgetComponentGroup
  description: string
  sourceType: DocumentWidgetDataSourceType
  implementation: DocumentWidgetImplementation
  actionPolicy: DocumentWidgetActionPolicy
  styleTags: string[]
  titleHint: string
  propsSchema: (typeof componentSchemas)[DocumentWidgetComponentName]
  openuiExample: string
}

export interface DayScheduleSnapshot {
  dateLabel: string
  events: Array<{ title: string; timeLabel: string; accent?: string; meta?: string }>
}

export interface WeekScheduleSnapshot {
  weekLabel: string
  days: Array<{ label: string; count: number; highlights: string[] }>
}

export interface TimeAllocationSnapshot {
  periodLabel: string
  segments: Array<{ label: string; value: number; accent?: string }>
}

export interface ScheduleRuntimeSnapshot {
  heading?: string
  jobs: Array<{ name: string; status: 'enabled' | 'paused' | 'running' | 'error'; nextRun?: string; lastRun?: string }>
}

export interface TodayFocusSnapshot {
  dayLabel: string
  highlights: string[]
  metrics: Array<{ label: string; value: string }>
}

export interface DocumentWidgetCompileContext {
  calendar?: DayScheduleSnapshot
  calendarWeek?: WeekScheduleSnapshot
  timeAllocation?: TimeAllocationSnapshot
  schedule?: ScheduleRuntimeSnapshot
  todayFocus?: TodayFocusSnapshot
}

export interface CompiledDocumentWidget {
  component: DocumentWidgetComponentName
  widgetCode: string
}

function renderNullComponent(): null {
  return null
}

function buildExampleTag(name: string, attrs: Record<string, string>): string {
  const content = Object.entries(attrs)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ')
  return `<${name} ${content} />`
}

export const documentWidgetCatalog: DocumentWidgetCatalogEntry[] = [
  {
    name: 'info_card',
    group: 'common-display',
    description: 'Single-summary information card for conclusions, highlights, and concise recommendations.',
    sourceType: 'manual',
    implementation: 'html-inline-script',
    actionPolicy: 'readonly',
    styleTags: ['notebook', 'editorial', 'warm_minimal'],
    titleHint: 'info_card',
    propsSchema: componentSchemas.info_card,
    openuiExample: buildExampleTag('info_card', { heading: '今日重点', body: '把版本说明同步给团队。', tone: 'neutral' }),
  },
  {
    name: 'stats_card',
    group: 'common-display',
    description: 'Compact KPI snapshot card with 3 to 6 metrics.',
    sourceType: 'manual',
    implementation: 'svg',
    actionPolicy: 'readonly',
    styleTags: ['dashboard', 'bold_data'],
    titleHint: 'stats_card',
    propsSchema: componentSchemas.stats_card,
    openuiExample: buildExampleTag('stats_card', { heading: '关键指标', metrics: '[...]' }),
  },
  {
    name: 'bar_chart',
    group: 'common-display',
    description: 'Bar comparison chart for categories, weekly summaries, and grouped counts.',
    sourceType: 'manual',
    implementation: 'chartjs',
    actionPolicy: 'readonly',
    styleTags: ['dashboard', 'academic'],
    titleHint: 'bar_chart',
    propsSchema: componentSchemas.bar_chart,
    openuiExample: buildExampleTag('bar_chart', { heading: '分类对比', series: '[...]' }),
  },
  {
    name: 'line_chart',
    group: 'common-display',
    description: 'Line trend chart for time series, progress, and change over time.',
    sourceType: 'manual',
    implementation: 'chartjs',
    actionPolicy: 'readonly',
    styleTags: ['academic', 'dashboard', 'bold_data'],
    titleHint: 'line_chart',
    propsSchema: componentSchemas.line_chart,
    openuiExample: buildExampleTag('line_chart', { heading: '趋势变化', series: '[...]' }),
  },
  {
    name: 'data_table',
    group: 'common-display',
    description: 'Small structured comparison or detail table.',
    sourceType: 'manual',
    implementation: 'html-inline-script',
    actionPolicy: 'readonly',
    styleTags: ['notebook', 'dashboard'],
    titleHint: 'data_table',
    propsSchema: componentSchemas.data_table,
    openuiExample: buildExampleTag('data_table', { heading: '统计明细', columns: '[...]', rows: '[...]' }),
  },
  {
    name: 'callout_block',
    group: 'common-display',
    description: 'Callout card for reminders, risks, conclusions, and key suggestions.',
    sourceType: 'manual',
    implementation: 'html-inline-script',
    actionPolicy: 'readonly',
    styleTags: ['notebook', 'warm_minimal', 'editorial'],
    titleHint: 'callout_block',
    propsSchema: componentSchemas.callout_block,
    openuiExample: buildExampleTag('callout_block', { heading: '发布提醒', body: '今晚 20:00 前完成封面和标题检查。', tone: 'warning' }),
  },
  {
    name: 'tab_info_block',
    group: 'common-display',
    description: 'Small grouped information block with 2 to 4 tabs.',
    sourceType: 'manual',
    implementation: 'html-inline-script',
    actionPolicy: 'local-toggle',
    styleTags: ['notebook', 'dashboard'],
    titleHint: 'tab_info_block',
    propsSchema: componentSchemas.tab_info_block,
    openuiExample: buildExampleTag('tab_info_block', { heading: '分组信息', tabs: '[...]' }),
  },
  {
    name: 'comparison_grid',
    group: 'common-display',
    description: 'Two-to-four column comparison grid for structured differences.',
    sourceType: 'manual',
    implementation: 'html-inline-script',
    actionPolicy: 'readonly',
    styleTags: ['editorial', 'dashboard'],
    titleHint: 'comparison_grid',
    propsSchema: componentSchemas.comparison_grid,
    openuiExample: buildExampleTag('comparison_grid', { heading: '方案对比', columns: '[...]' }),
  },
  {
    name: 'progress_snapshot',
    group: 'common-display',
    description: 'Progress and completion snapshot with mini bars.',
    sourceType: 'manual',
    implementation: 'html-inline-script',
    actionPolicy: 'readonly',
    styleTags: ['dashboard', 'notebook'],
    titleHint: 'progress_snapshot',
    propsSchema: componentSchemas.progress_snapshot,
    openuiExample: buildExampleTag('progress_snapshot', { heading: '完成度', items: '[...]' }),
  },
  {
    name: 'weekly_focus_chart',
    group: 'common-display',
    description: 'Two-state focus card for current week and next week highlights.',
    sourceType: 'manual',
    implementation: 'html-inline-script',
    actionPolicy: 'local-toggle',
    styleTags: ['dashboard', 'warm_minimal', 'notebook'],
    titleHint: 'weekly_focus_chart',
    propsSchema: componentSchemas.weekly_focus_chart,
    openuiExample: buildExampleTag('weekly_focus_chart', { currentLabel: '本周', nextLabel: '下周', currentItems: '[...]', nextItems: '[...]' }),
  },
  {
    name: 'mini_calculator',
    group: 'common-display',
    description: 'Local calculator widget with bounded numeric inputs and deterministic inline computation.',
    sourceType: 'manual',
    implementation: 'html-inline-script',
    actionPolicy: 'local-toggle',
    styleTags: ['notebook', 'dashboard'],
    titleHint: 'mini_calculator',
    propsSchema: componentSchemas.mini_calculator,
    openuiExample: buildExampleTag('mini_calculator', { heading: '评分计算器', fields: '[...]', outputLabel: '总分' }),
  },
  {
    name: 'flow_diagram',
    group: 'common-display',
    description: 'Simple flow diagram for process and architecture summaries.',
    sourceType: 'manual',
    implementation: 'svg',
    actionPolicy: 'readonly',
    styleTags: ['academic', 'editorial'],
    titleHint: 'flow_diagram',
    propsSchema: componentSchemas.flow_diagram,
    openuiExample: buildExampleTag('flow_diagram', { heading: '流程图', nodes: '[...]', edges: '[...]' }),
  },
  {
    name: 'day_schedule_card',
    group: 'personal-data',
    description: 'Single-day schedule card based on calendar events.',
    sourceType: 'calendar',
    implementation: 'html-inline-script',
    actionPolicy: 'trigger-existing-writeback',
    styleTags: ['dashboard', 'notebook'],
    titleHint: 'day_schedule_card',
    propsSchema: componentSchemas.day_schedule_card,
    openuiExample: buildExampleTag('day_schedule_card', { dateLabel: '今天', events: '[...]' }),
  },
  {
    name: 'week_schedule_card',
    group: 'personal-data',
    description: 'Week schedule overview card grouped by day.',
    sourceType: 'calendar',
    implementation: 'html-inline-script',
    actionPolicy: 'trigger-existing-writeback',
    styleTags: ['dashboard', 'notebook'],
    titleHint: 'week_schedule_card',
    propsSchema: componentSchemas.week_schedule_card,
    openuiExample: buildExampleTag('week_schedule_card', { weekLabel: '本周', days: '[...]' }),
  },
  {
    name: 'time_allocation_chart',
    group: 'personal-data',
    description: 'Time allocation snapshot aggregated from calendar events.',
    sourceType: 'calendar',
    implementation: 'svg',
    actionPolicy: 'trigger-existing-writeback',
    styleTags: ['dashboard', 'academic'],
    titleHint: 'time_allocation_chart',
    propsSchema: componentSchemas.time_allocation_chart,
    openuiExample: buildExampleTag('time_allocation_chart', { periodLabel: '本周时间分配', segments: '[...]' }),
  },
  {
    name: 'schedule_runtime_card',
    group: 'personal-data',
    description: 'Runtime schedule status card derived from existing automation schedules.',
    sourceType: 'schedule',
    implementation: 'html-inline-script',
    actionPolicy: 'trigger-existing-writeback',
    styleTags: ['dashboard', 'bold_data'],
    titleHint: 'schedule_runtime_card',
    propsSchema: componentSchemas.schedule_runtime_card,
    openuiExample: buildExampleTag('schedule_runtime_card', { heading: '自动计划', jobs: '[...]' }),
  },
  {
    name: 'todo_list_manual',
    group: 'personal-data',
    description: 'Manual todo list stored inside the document widget itself.',
    sourceType: 'manual',
    implementation: 'html-inline-script',
    actionPolicy: 'local-toggle',
    styleTags: ['notebook', 'warm_minimal'],
    titleHint: 'todo_list_manual',
    propsSchema: componentSchemas.todo_list_manual,
    openuiExample: buildExampleTag('todo_list_manual', { heading: '今日待办', items: '[...]' }),
  },
  {
    name: 'weekly_plan_board_manual',
    group: 'personal-data',
    description: 'Manual weekly plan board stored in the document.',
    sourceType: 'manual',
    implementation: 'html-inline-script',
    actionPolicy: 'local-toggle',
    styleTags: ['notebook', 'dashboard'],
    titleHint: 'weekly_plan_board_manual',
    propsSchema: componentSchemas.weekly_plan_board_manual,
    openuiExample: buildExampleTag('weekly_plan_board_manual', { heading: '本周计划', lanes: '[...]' }),
  },
  {
    name: 'habit_streak_manual',
    group: 'personal-data',
    description: 'Manual habit streak tracker stored in the document.',
    sourceType: 'manual',
    implementation: 'html-inline-script',
    actionPolicy: 'local-toggle',
    styleTags: ['warm_minimal', 'notebook'],
    titleHint: 'habit_streak_manual',
    propsSchema: componentSchemas.habit_streak_manual,
    openuiExample: buildExampleTag('habit_streak_manual', { heading: '习惯记录', habits: '[...]' }),
  },
  {
    name: 'today_focus_snapshot',
    group: 'personal-data',
    description: 'Today focus snapshot combining highlights and top metrics.',
    sourceType: 'calendar',
    implementation: 'html-inline-script',
    actionPolicy: 'trigger-existing-writeback',
    styleTags: ['dashboard', 'warm_minimal'],
    titleHint: 'today_focus_snapshot',
    propsSchema: componentSchemas.today_focus_snapshot,
    openuiExample: buildExampleTag('today_focus_snapshot', { dayLabel: '今天', highlights: '[...]', metrics: '[...]' }),
  },
] as const

const documentWidgetOpenUIComponents = documentWidgetCatalog.map((entry) => defineComponent({
  name: entry.name,
  description: `${entry.description} Source=${entry.sourceType}; Implementation=${entry.implementation}; Actions=${entry.actionPolicy}.`,
  props: entry.propsSchema,
  component: renderNullComponent,
}))

const documentWidgetOpenUILibrary = createLibrary({
  components: documentWidgetOpenUIComponents,
})

export const documentWidgetOpenUIPrompt = documentWidgetOpenUILibrary.prompt({
  preamble: 'You generate document widget specs for Ready. Only use approved components and keep each widget focused, compact, and deterministic.',
  additionalRules: [
    'Prefer the approved component list over arbitrary HTML inventions.',
    'Keep widget interactions local and compact.',
    'For calendar or schedule widgets, request existing data snapshots instead of inventing fake personal data.',
    'Do not generate multi-panel mini apps, fetch calls, iframe content, or external stateful runtimes.',
    'When a user asks for an existing widget to change, preserve the existing title and component family unless the request clearly requires a switch.',
  ],
  examples: documentWidgetCatalog.map((entry) => entry.openuiExample),
})

export const documentWidgetOpenUISchema = documentWidgetOpenUILibrary.toJSONSchema()

const componentEntryMap = new Map<DocumentWidgetComponentName, DocumentWidgetCatalogEntry>(
  documentWidgetCatalog.map((entry) => [entry.name, entry]),
)

function getComponentEntry(name: string): DocumentWidgetCatalogEntry | null {
  return componentEntryMap.get(name as DocumentWidgetComponentName) || null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(value: string): string {
  return escapeHtml(value)
}

function renderHeader(heading?: string): string {
  return heading ? `<div class="title">${escapeHtml(heading)}</div>` : ''
}

function buildButtonRow(items: Array<{ label: string; message: string }>): string {
  if (items.length === 0) return ''
  return `<div class="widget-actions" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">${items.map((item) => (
    `<button data-ready-agent-message="${escapeAttr(item.message)}" style="border:0;border-radius:999px;padding:8px 12px;background:var(--widget-accent,#dbeafe);color:var(--widget-text-primary,#0f172a);cursor:pointer;">${escapeHtml(item.label)}</button>`
  )).join('')}</div>`
}

function compileStatsCard(props: z.infer<typeof componentSchemas.stats_card>): string {
  const width = 680
  const cardWidth = Math.max(160, Math.floor((width - 24) / props.metrics.length))
  const height = 180
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttr(props.heading || '指标卡')}">
    <rect x="0" y="0" width="${width}" height="${height}" rx="24" fill="#f8fafc"/>
    ${props.heading ? `<text x="28" y="36" font-size="20" font-weight="700" fill="#0f172a">${escapeHtml(props.heading)}</text>` : ''}
    ${props.metrics.map((metric, index) => {
      const x = 12 + index * cardWidth
      return `
        <rect x="${x}" y="56" width="${cardWidth - 8}" height="96" rx="18" fill="#ffffff" stroke="rgba(15,23,42,0.08)"/>
        <text x="${x + 18}" y="84" font-size="12" fill="#64748b">${escapeHtml(metric.label)}</text>
        <text x="${x + 18}" y="118" font-size="28" font-weight="700" fill="${escapeAttr(metric.accent || '#0f172a')}">${escapeHtml(metric.value)}</text>
        ${metric.trend ? `<text x="${x + 18}" y="140" font-size="12" fill="#475569">${escapeHtml(metric.trend)}</text>` : ''}
      `
    }).join('')}
  </svg>`
}

function compileSimpleBarChart(props: z.infer<typeof componentSchemas.bar_chart>): string {
  const max = Math.max(...props.series.map((item) => item.value), 1)
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading)}
    ${props.series.map((item) => {
      const width = `${Math.max(8, (item.value / max) * 100)}%`
      return `<div class="stack" style="gap:6px;">
        <div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;"><span>${escapeHtml(item.label)}</span><span>${item.value}</span></div>
        <div style="height:12px;border-radius:999px;background:#e2e8f0;overflow:hidden;">
          <div style="height:100%;width:${width};background:${escapeAttr(item.accent || 'linear-gradient(90deg,#60a5fa,#2563eb)')};border-radius:999px;"></div>
        </div>
      </div>`
    }).join('')}
  </div>`
}

function compileSimpleLineChart(props: z.infer<typeof componentSchemas.line_chart>): string {
  const width = 640
  const height = 220
  const max = Math.max(...props.series.map((item) => item.value), 1)
  const stepX = props.series.length > 1 ? (width - 96) / (props.series.length - 1) : 1
  const points = props.series.map((item, index) => {
    const x = 48 + stepX * index
    const y = 176 - ((item.value / max) * 120)
    return { x, y, item }
  })
  const polyline = points.map((point) => `${point.x},${point.y}`).join(' ')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttr(props.heading || '折线图')}">
    <rect x="0" y="0" width="${width}" height="${height}" rx="24" fill="#ffffff"/>
    ${props.heading ? `<text x="24" y="34" font-size="20" font-weight="700" fill="#0f172a">${escapeHtml(props.heading)}</text>` : ''}
    <polyline fill="none" stroke="#2563eb" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" points="${polyline}" />
    ${points.map((point) => `
      <circle cx="${point.x}" cy="${point.y}" r="4" fill="#2563eb" />
      <text x="${point.x}" y="${height - 18}" text-anchor="middle" font-size="12" fill="#64748b">${escapeHtml(point.item.label)}</text>
    `).join('')}
    ${props.annotation ? `<text x="24" y="${height - 18}" font-size="12" fill="#475569">${escapeHtml(props.annotation)}</text>` : ''}
  </svg>`
}

function compileDataTable(props: z.infer<typeof componentSchemas.data_table>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading)}
    <div style="overflow:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr>${props.columns.map((column) => `<th style="text-align:left;padding:10px 12px;border-bottom:1px solid rgba(15,23,42,0.08);color:#475569;">${escapeHtml(column)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${props.rows.map((row) => `<tr>${row.map((cell) => `<td style="padding:10px 12px;border-bottom:1px solid rgba(15,23,42,0.06);">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`
}

function compileCalloutBlock(props: z.infer<typeof componentSchemas.callout_block>): string {
  const resolvedTone = props.tone || 'info'
  const tones: Record<z.infer<typeof calloutToneSchema>, { bg: string; border: string; label: string }> = {
    info: { bg: '#eff6ff', border: '#60a5fa', label: '提示' },
    success: { bg: '#ecfdf5', border: '#34d399', label: '完成' },
    warning: { bg: '#fff7ed', border: '#fb923c', label: '提醒' },
    danger: { bg: '#fef2f2', border: '#f87171', label: '风险' },
    neutral: { bg: '#f8fafc', border: '#94a3b8', label: '说明' },
  }
  const tone = tones[resolvedTone]
  return `<div class="card stack" style="gap:10px;padding:18px 20px;background:${tone.bg};border:1px solid ${tone.border};">
    <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${tone.border};">${tone.label}</div>
    ${props.heading ? `<div class="title">${escapeHtml(props.heading)}</div>` : ''}
    <div class="subtitle">${escapeHtml(props.body)}</div>
    ${props.points?.length ? `<ul style="margin:0;padding-left:18px;">${props.points.map((point) => `<li style="margin:6px 0;">${escapeHtml(point)}</li>`).join('')}</ul>` : ''}
  </div>`
}

function compileTabInfoBlock(props: z.infer<typeof componentSchemas.tab_info_block>): string {
  const tabs = props.tabs.map((tab, index) => `
    <button data-tab-target="tab-${index}" class="tab-button${index === 0 ? ' is-active' : ''}" style="border:0;border-radius:999px;padding:8px 12px;background:${index === 0 ? '#dbeafe' : '#eef2f7'};cursor:pointer;">${escapeHtml(tab.label)}</button>
  `).join('')
  const panels = props.tabs.map((tab, index) => `
    <section data-tab-panel="tab-${index}" style="display:${index === 0 ? 'block' : 'none'};">
      <div class="subtitle">${escapeHtml(tab.body)}</div>
      ${(tab.points || []).length ? `<ul style="margin-top:10px;padding-left:18px;">${(tab.points || []).map((point) => `<li style="margin:6px 0;">${escapeHtml(point)}</li>`).join('')}</ul>` : ''}
    </section>
  `).join('')
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading)}
    <div style="display:flex;gap:8px;flex-wrap:wrap;">${tabs}</div>
    <div>${panels}</div>
    <script>(function(){const root=document.currentScript && document.currentScript.parentElement; if(!root) return; const buttons=Array.from(root.querySelectorAll('.tab-button')); const panels=Array.from(root.querySelectorAll('[data-tab-panel]')); buttons.forEach((button)=>{button.addEventListener('click',()=>{const target=button.getAttribute('data-tab-target'); buttons.forEach((btn)=>{btn.classList.remove('is-active'); btn.style.background='#eef2f7';}); panels.forEach((panel)=>{panel.style.display=panel.getAttribute('data-tab-panel')===target?'block':'none';}); button.classList.add('is-active'); button.style.background='#dbeafe';});});})();</script>
  </div>`
}

function compileComparisonGrid(props: z.infer<typeof componentSchemas.comparison_grid>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading)}
    <div style="display:grid;grid-template-columns:repeat(${props.columns.length}, minmax(0,1fr));gap:12px;">
      ${props.columns.map((column) => `<section style="padding:14px;border-radius:16px;background:#ffffff;border:1px solid rgba(15,23,42,0.08);">
        <div style="font-weight:700;margin-bottom:8px;">${escapeHtml(column.title)}</div>
        <ul style="margin:0;padding-left:18px;">${column.points.map((point) => `<li style="margin:6px 0;">${escapeHtml(point)}</li>`).join('')}</ul>
      </section>`).join('')}
    </div>
  </div>`
}

function compileProgressSnapshot(props: z.infer<typeof componentSchemas.progress_snapshot>): string {
  return `<div class="card stack" style="gap:12px;">
    ${renderHeader(props.heading)}
    ${props.items.map((item) => {
      const max = item.max || 100
      const ratio = Math.max(0, Math.min(100, (item.value / max) * 100))
      return `<div class="stack" style="gap:6px;">
        <div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;"><span>${escapeHtml(item.label)}</span><span>${escapeHtml(item.displayValue || `${item.value}/${max}`)}</span></div>
        <div style="height:10px;border-radius:999px;background:#e2e8f0;overflow:hidden;"><div style="height:100%;width:${ratio}%;background:linear-gradient(90deg,#60a5fa,#0ea5e9);border-radius:999px;"></div></div>
      </div>`
    }).join('')}
  </div>`
}

function compileDayScheduleCard(props: z.infer<typeof componentSchemas.day_schedule_card>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading || props.dateLabel)}
    <div style="display:grid;gap:10px;">
      ${props.events.length > 0 ? props.events.map((event) => `<div style="padding:12px 14px;border-radius:16px;background:#ffffff;border:1px solid rgba(15,23,42,0.08);display:flex;justify-content:space-between;gap:12px;">
        <div>
          <div style="font-weight:700;">${escapeHtml(event.title)}</div>
          ${event.meta ? `<div style="font-size:12px;color:#64748b;">${escapeHtml(event.meta)}</div>` : ''}
        </div>
        <div style="white-space:nowrap;color:${escapeAttr(event.accent || '#2563eb')};font-weight:600;">${escapeHtml(event.timeLabel)}</div>
      </div>`).join('') : '<div class="subtitle">今天没有已记录安排。</div>'}
    </div>
    ${buildButtonRow([
      { label: '打开日历', message: `请切换到日历模式并查看${props.dateLabel}的安排。` },
      { label: '新增事件', message: `请在日历里新增一个${props.dateLabel}的事件。` },
    ])}
  </div>`
}

function compileWeeklyFocusChart(props: z.infer<typeof componentSchemas.weekly_focus_chart>): string {
  const currentItems = props.currentItems.map((item) => `<li style="margin:6px 0;"><strong>${escapeHtml(item.label)}</strong>${item.detail ? `：${escapeHtml(item.detail)}` : ''}</li>`).join('')
  const nextItems = props.nextItems.map((item) => `<li style="margin:6px 0;"><strong>${escapeHtml(item.label)}</strong>${item.detail ? `：${escapeHtml(item.detail)}` : ''}</li>`).join('')
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading)}
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button data-focus-target="current" class="focus-toggle is-active" style="border:0;border-radius:999px;padding:8px 12px;background:#dbeafe;cursor:pointer;">${escapeHtml(props.currentLabel)}</button>
      <button data-focus-target="next" class="focus-toggle" style="border:0;border-radius:999px;padding:8px 12px;background:#eef2f7;cursor:pointer;">${escapeHtml(props.nextLabel)}</button>
    </div>
    <section data-focus-panel="current"><ul style="margin:0;padding-left:18px;">${currentItems}</ul></section>
    <section data-focus-panel="next" style="display:none;"><ul style="margin:0;padding-left:18px;">${nextItems}</ul></section>
    <script>(function(){const root=document.currentScript && document.currentScript.parentElement;if(!root)return;const buttons=Array.from(root.querySelectorAll('[data-focus-target]'));const panels=Array.from(root.querySelectorAll('[data-focus-panel]'));buttons.forEach((button)=>{button.addEventListener('click',()=>{const target=button.getAttribute('data-focus-target');buttons.forEach((btn)=>{btn.classList.remove('is-active');btn.style.background='#eef2f7';});panels.forEach((panel)=>{panel.style.display=panel.getAttribute('data-focus-panel')===target?'block':'none';});button.classList.add('is-active');button.style.background='#dbeafe';});});})();</script>
  </div>`
}

function compileMiniCalculator(props: z.infer<typeof componentSchemas.mini_calculator>): string {
  const inputs = props.fields.map((field) => `<label class="stack" style="gap:6px;"><span>${escapeHtml(field.label)}</span><input type="number" id="${escapeAttr(field.id)}" ${field.min != null ? `min="${field.min}"` : ''} ${field.max != null ? `max="${field.max}"` : ''} ${field.value != null ? `value="${field.value}"` : ''} /></label>`).join('')
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading)}
    ${inputs}
    <div class="card" style="text-align:center;"><div class="subtitle">${escapeHtml(props.outputLabel)}</div><div id="calculator-output" class="title">-</div></div>
    <script>(function(){const root=document.currentScript && document.currentScript.parentElement;if(!root)return;const inputs=Array.from(root.querySelectorAll('input[type="number"]'));const output=root.querySelector('#calculator-output');const render=()=>{if(!output)return;const values=inputs.map((input)=>Number(input.value||0));if(values.every((value)=>value===0)&&inputs.every((input)=>input.value==='')){output.textContent='-';return;}const total=values.reduce((sum,value)=>sum+value,0)/Math.max(values.length,1);output.textContent=String(total.toFixed(1));};inputs.forEach((input)=>input.addEventListener('input',render));render();})();</script>
  </div>`
}

function compileFlowDiagram(props: z.infer<typeof componentSchemas.flow_diagram>): string {
  const width = 680
  const height = 180
  const stepX = props.nodes.length > 1 ? (width - 120) / (props.nodes.length - 1) : 1
  const nodePositions = props.nodes.map((node, index) => ({
    ...node,
    x: 60 + index * stepX,
    y: 96,
  }))
  const positionById = new Map(nodePositions.map((node) => [node.id, node]))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttr(props.heading || '流程图')}">
    <rect x="0" y="0" width="${width}" height="${height}" rx="24" fill="#ffffff" />
    ${props.heading ? `<text x="24" y="32" font-size="18" font-weight="700" fill="#0f172a">${escapeHtml(props.heading)}</text>` : ''}
    ${props.edges.map((edge) => {
      const from = positionById.get(edge.from)
      const to = positionById.get(edge.to)
      if (!from || !to) return ''
      const midX = (from.x + to.x) / 2
      return `
        <line x1="${from.x + 46}" y1="${from.y}" x2="${to.x - 46}" y2="${to.y}" stroke="#94a3b8" stroke-width="2.5" />
        ${edge.label ? `<text x="${midX}" y="${from.y - 12}" text-anchor="middle" font-size="11" fill="#64748b">${escapeHtml(edge.label)}</text>` : ''}
      `
    }).join('')}
    ${nodePositions.map((node) => `
      <rect x="${node.x - 44}" y="${node.y - 22}" width="88" height="44" rx="16" fill="#eff6ff" stroke="#60a5fa" />
      <text x="${node.x}" y="${node.y + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="#0f172a">${escapeHtml(node.label)}</text>
    `).join('')}
  </svg>`
}

function compileWeekScheduleCard(props: z.infer<typeof componentSchemas.week_schedule_card>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading || props.weekLabel)}
    <div style="display:grid;grid-template-columns:repeat(${Math.min(props.days.length, 4)}, minmax(0,1fr));gap:10px;">
      ${props.days.map((day) => `<section style="padding:12px;border-radius:16px;background:#ffffff;border:1px solid rgba(15,23,42,0.08);">
        <div style="font-weight:700;">${escapeHtml(day.label)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px;">${day.count} 个安排</div>
        ${(day.highlights || []).length ? `<ul style="margin:10px 0 0;padding-left:18px;">${(day.highlights || []).map((item) => `<li style="margin:4px 0;">${escapeHtml(item)}</li>`).join('')}</ul>` : '<div style="margin-top:10px;font-size:12px;color:#94a3b8;">暂无重点</div>'}
      </section>`).join('')}
    </div>
    ${buildButtonRow([{ label: '查看本周日历', message: `请切换到日历模式并查看${props.weekLabel}。` }])}
  </div>`
}

function compileTimeAllocationChart(props: z.infer<typeof componentSchemas.time_allocation_chart>): string {
  const max = Math.max(...props.segments.map((item) => item.value), 1)
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading || props.periodLabel)}
    ${props.segments.map((segment) => `<div class="stack" style="gap:6px;">
      <div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;"><span>${escapeHtml(segment.label)}</span><span>${segment.value}h</span></div>
      <div style="height:12px;border-radius:999px;background:#e2e8f0;overflow:hidden;"><div style="height:100%;width:${Math.max(8, (segment.value / max) * 100)}%;background:${escapeAttr(segment.accent || 'linear-gradient(90deg,#34d399,#0ea5e9)')};border-radius:999px;"></div></div>
    </div>`).join('')}
    ${buildButtonRow([{ label: '查看日历明细', message: `请切换到日历模式并查看${props.periodLabel}的时间分配。` }])}
  </div>`
}

function compileScheduleRuntimeCard(props: z.infer<typeof componentSchemas.schedule_runtime_card>): string {
  const statusLabel: Record<z.infer<typeof scheduleJobSchema>['status'], string> = {
    enabled: '已启用',
    paused: '已暂停',
    running: '运行中',
    error: '异常',
  }
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading || '自动计划')}
    ${props.jobs.map((job) => `<section style="padding:14px;border-radius:16px;background:#ffffff;border:1px solid rgba(15,23,42,0.08);display:grid;gap:6px;">
      <div style="display:flex;justify-content:space-between;gap:12px;"><strong>${escapeHtml(job.name)}</strong><span style="font-size:12px;color:#475569;">${statusLabel[job.status]}</span></div>
      ${job.nextRun ? `<div style="font-size:12px;color:#64748b;">下次运行：${escapeHtml(job.nextRun)}</div>` : ''}
      ${job.lastRun ? `<div style="font-size:12px;color:#94a3b8;">最近运行：${escapeHtml(job.lastRun)}</div>` : ''}
    </section>`).join('')}
    ${buildButtonRow([
      { label: '查看计划', message: '请打开当前项目里的自动计划列表。' },
      { label: '调整计划', message: '请帮我调整当前自动计划的启用状态或时间。' },
    ])}
  </div>`
}

function compileTodoListManual(props: z.infer<typeof componentSchemas.todo_list_manual>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading)}
    <div style="display:grid;gap:10px;">
      ${props.items.map((item, index) => `<label style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:14px;background:#ffffff;border:1px solid rgba(15,23,42,0.08);">
        <input type="checkbox" ${item.done ? 'checked' : ''} data-todo-index="${index}" />
        <span style="flex:1;${item.done ? 'text-decoration:line-through;color:#94a3b8;' : ''}">${escapeHtml(item.text)}${item.note ? `<small style="display:block;margin-top:4px;color:#64748b;">${escapeHtml(item.note)}</small>` : ''}</span>
      </label>`).join('')}
    </div>
    <script>(function(){const root=document.currentScript && document.currentScript.parentElement; if(!root) return; root.querySelectorAll('input[type="checkbox"]').forEach((box)=>{box.addEventListener('change',()=>{const text=box.parentElement && box.parentElement.querySelector('span'); if(text){text.style.textDecoration = box.checked ? 'line-through' : 'none'; text.style.color = box.checked ? '#94a3b8' : '';}});});})();</script>
  </div>`
}

function compileWeeklyPlanBoard(props: z.infer<typeof componentSchemas.weekly_plan_board_manual>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading)}
    <div style="display:grid;grid-template-columns:repeat(${props.lanes.length}, minmax(0,1fr));gap:12px;">
      ${props.lanes.map((lane) => `<section style="padding:12px;border-radius:16px;background:#ffffff;border:1px solid rgba(15,23,42,0.08);">
        <div style="font-weight:700;margin-bottom:8px;">${escapeHtml(lane.title)}</div>
        <ul style="margin:0;padding-left:18px;">${lane.items.map((item) => `<li style="margin:6px 0;">${escapeHtml(item)}</li>`).join('')}</ul>
      </section>`).join('')}
    </div>
  </div>`
}

function compileHabitStreak(props: z.infer<typeof componentSchemas.habit_streak_manual>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading)}
    ${props.habits.map((habit) => `<section style="padding:12px;border-radius:16px;background:#ffffff;border:1px solid rgba(15,23,42,0.08);display:grid;gap:6px;">
      <div style="display:flex;justify-content:space-between;gap:12px;"><strong>${escapeHtml(habit.name)}</strong><span>${habit.streak} 天</span></div>
      <div style="display:flex;gap:6px;">${habit.weekMarks.map((mark) => `<span style="width:12px;height:12px;border-radius:999px;background:${mark ? '#34d399' : '#e2e8f0'};"></span>`).join('')}</div>
    </section>`).join('')}
  </div>`
}

function compileTodayFocusSnapshot(props: z.infer<typeof componentSchemas.today_focus_snapshot>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading || props.dayLabel)}
    <div style="display:grid;grid-template-columns:repeat(${props.metrics.length}, minmax(0,1fr));gap:10px;">
      ${props.metrics.map((metric) => `<section style="padding:12px;border-radius:14px;background:#ffffff;border:1px solid rgba(15,23,42,0.08);"><div style="font-size:12px;color:#64748b;">${escapeHtml(metric.label)}</div><div style="font-size:22px;font-weight:700;">${escapeHtml(metric.value)}</div></section>`).join('')}
    </div>
    <ul style="margin:0;padding-left:18px;">${props.highlights.map((item) => `<li style="margin:6px 0;">${escapeHtml(item)}</li>`).join('')}</ul>
    ${buildButtonRow([{ label: '查看今天安排', message: `请切换到日历模式并查看${props.dayLabel}的重点安排。` }])}
  </div>`
}

function compileInfoCard(props: z.infer<typeof componentSchemas.info_card>): string {
  return `<div class="card stack" style="gap:12px;">
    ${renderHeader(props.heading)}
    <div class="subtitle">${escapeHtml(props.body)}</div>
    ${props.points?.length ? `<ul style="margin:0;padding-left:18px;">${props.points.map((point) => `<li style="margin:6px 0;">${escapeHtml(point)}</li>`).join('')}</ul>` : ''}
  </div>`
}

function resolvePropsFromSnapshots(
  component: DocumentWidgetComponentName,
  dataSource: DocumentWidgetComponentSpec['dataSource'] | undefined,
  context: DocumentWidgetCompileContext | undefined,
): Record<string, unknown> | null {
  void dataSource
  switch (component) {
    case 'day_schedule_card':
      return context?.calendar ? {
        heading: `今天 · ${context.calendar.dateLabel}`,
        dateLabel: context.calendar.dateLabel,
        events: context.calendar.events,
      } : null
    case 'week_schedule_card':
      return context?.calendarWeek ? {
        heading: '周日程概览',
        weekLabel: context.calendarWeek.weekLabel,
        days: context.calendarWeek.days,
      } : null
    case 'time_allocation_chart':
      return context?.timeAllocation ? {
        heading: '时间分配',
        periodLabel: context.timeAllocation.periodLabel,
        segments: context.timeAllocation.segments,
      } : null
    case 'schedule_runtime_card':
      return context?.schedule ? {
        heading: context.schedule.heading || '自动计划',
        jobs: context.schedule.jobs,
      } : null
    case 'today_focus_snapshot':
      return context?.todayFocus ? {
        heading: '今日重点',
        dayLabel: context.todayFocus.dayLabel,
        highlights: context.todayFocus.highlights,
        metrics: context.todayFocus.metrics,
      } : null
    default:
      return null
  }
}

export function validateDocumentWidgetComponentSpec(spec: DocumentWidgetComponentSpec): DocumentWidgetValidateResult {
  const entry = getComponentEntry(spec.component)
  if (!entry) {
    return {
      ok: false,
      errors: [`Unknown approved document widget component: ${String(spec.component)}`],
    }
  }

  const errors: string[] = []
  if (entry.sourceType === 'manual' && !spec.props) {
    errors.push(`Component "${entry.name}" requires props for manual rendering`)
  }
  if (entry.sourceType !== 'manual' && !spec.props && !spec.dataSource) {
    errors.push(`Component "${entry.name}" requires props or a dataSource request`)
  }
  if (spec.dataSource && spec.dataSource.type !== entry.sourceType) {
    errors.push(`Component "${entry.name}" only supports dataSource type "${entry.sourceType}"`)
  }
  if (spec.props) {
    const result = entry.propsSchema.safeParse(spec.props)
    if (!result.success) {
      errors.push(...result.error.issues.map((issue) => issue.path.length > 0
        ? `${entry.name}.${issue.path.join('.')}: ${issue.message}`
        : `${entry.name}: ${issue.message}`))
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  }
}

function compileByComponent(component: DocumentWidgetComponentName, props: Record<string, unknown>): string {
  switch (component) {
    case 'info_card':
      return compileInfoCard(componentSchemas.info_card.parse(props))
    case 'stats_card':
      return compileStatsCard(componentSchemas.stats_card.parse(props))
    case 'bar_chart':
      return compileSimpleBarChart(componentSchemas.bar_chart.parse(props))
    case 'line_chart':
      return compileSimpleLineChart(componentSchemas.line_chart.parse(props))
    case 'data_table':
      return compileDataTable(componentSchemas.data_table.parse(props))
    case 'callout_block':
      return compileCalloutBlock(componentSchemas.callout_block.parse(props))
    case 'tab_info_block':
      return compileTabInfoBlock(componentSchemas.tab_info_block.parse(props))
    case 'comparison_grid':
      return compileComparisonGrid(componentSchemas.comparison_grid.parse(props))
    case 'progress_snapshot':
      return compileProgressSnapshot(componentSchemas.progress_snapshot.parse(props))
    case 'weekly_focus_chart':
      return compileWeeklyFocusChart(componentSchemas.weekly_focus_chart.parse(props))
    case 'mini_calculator':
      return compileMiniCalculator(componentSchemas.mini_calculator.parse(props))
    case 'flow_diagram':
      return compileFlowDiagram(componentSchemas.flow_diagram.parse(props))
    case 'day_schedule_card':
      return compileDayScheduleCard(componentSchemas.day_schedule_card.parse(props))
    case 'week_schedule_card':
      return compileWeekScheduleCard(componentSchemas.week_schedule_card.parse(props))
    case 'time_allocation_chart':
      return compileTimeAllocationChart(componentSchemas.time_allocation_chart.parse(props))
    case 'schedule_runtime_card':
      return compileScheduleRuntimeCard(componentSchemas.schedule_runtime_card.parse(props))
    case 'todo_list_manual':
      return compileTodoListManual(componentSchemas.todo_list_manual.parse(props))
    case 'weekly_plan_board_manual':
      return compileWeeklyPlanBoard(componentSchemas.weekly_plan_board_manual.parse(props))
    case 'habit_streak_manual':
      return compileHabitStreak(componentSchemas.habit_streak_manual.parse(props))
    case 'today_focus_snapshot':
      return compileTodayFocusSnapshot(componentSchemas.today_focus_snapshot.parse(props))
  }
}

export function compileDocumentWidgetSpec(
  spec: DocumentWidgetComponentSpec,
  context?: DocumentWidgetCompileContext,
): CompiledDocumentWidget {
  const entry = getComponentEntry(spec.component)
  if (!entry) {
    throw new Error(`Unknown approved document widget component: ${String(spec.component)}`)
  }

  const validation = validateDocumentWidgetComponentSpec(spec)
  if (!validation.ok && !spec.dataSource) {
    throw new Error(validation.errors.join('\n'))
  }

  const resolvedProps = spec.props || resolvePropsFromSnapshots(entry.name, spec.dataSource, context)
  if (!resolvedProps) {
    throw new Error(`Component "${entry.name}" could not resolve props from the provided data source snapshot`)
  }

  const widgetCode = compileByComponent(entry.name, resolvedProps)
  return {
    component: entry.name,
    widgetCode,
  }
}

export function buildDocumentWidgetOpenUIRulesSnippet(): string {
  const lines = [
    '## OpenUI 文档组件规则',
    '- 只能使用已批准的文档组件家族，不要自由发明新的组件名。',
    '- 通用展示组件：',
    ...documentWidgetCatalog.filter((entry) => entry.group === 'common-display').map((entry) => `  - ${entry.name}: ${entry.description}`),
    '- 个性化组件：',
    ...documentWidgetCatalog.filter((entry) => entry.group === 'personal-data').map((entry) => `  - ${entry.name}: ${entry.description}`),
  ]

  return lines.join('\n')
}
