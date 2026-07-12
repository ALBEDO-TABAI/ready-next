import { z } from 'zod'
import { createLibrary, defineComponent } from './openui-lite'
import { renderReadyChart } from './document-widget-dot-charts'
import { widgetVar } from './document-widget-theme'
import {
  compileReadyInfoCard,
  resolveInfoCardKicker,
  resolveInfoCardRamp,
} from './document-widget-info-card'
import {
  compileProcessFlow,
  processFlowFromGraph,
} from './document-widget-process-flow'
import {
  compileRelationshipGraph,
  relationshipGraphPropsSchema,
} from './document-widget-relation-graph'

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

const infoCardFactSchema = z.object({
  label: z.string().min(1).describe('速览项名，如 广告定位 / 核心策略 / 一句话概括'),
  value: z.string().min(1).describe('该项内容，短语或一句话'),
})

const componentSchemas = {
  info_card: z.object({
    ...commonTextProps,
    body: z
      .string()
      .min(1)
      .describe('一句话结论（建议 ≤80 字）；结构化内容放 facts / points，不要把长文塞进 body'),
    tone: calloutToneSchema.optional(),
    points: z.array(z.string()).optional().describe('补充要点列表（每条一短句）'),
    facts: z
      .array(infoCardFactSchema)
      .max(8)
      .optional()
      .describe('键值速览行；"一眼看懂本章 / 快速获取文章信息"类信息卡优先用它承载结构化条目'),
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
  relationship_graph: relationshipGraphPropsSchema,
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
    implementation: 'html-inline-script',
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
    implementation: 'html-inline-script',
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
    implementation: 'html-inline-script',
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
    description: 'Step-by-step process explainer with optional branches; give nodes/edges, layout is deterministic.',
    sourceType: 'manual',
    implementation: 'html-inline-script',
    actionPolicy: 'readonly',
    styleTags: ['academic', 'editorial'],
    titleHint: 'flow_diagram',
    propsSchema: componentSchemas.flow_diagram,
    openuiExample: buildExampleTag('flow_diagram', { heading: '流程图', nodes: '[...]', edges: '[...]' }),
  },
  {
    name: 'relationship_graph',
    group: 'common-display',
    description: 'Relationship graph for people, roles, families, and semantic links; use structured nodes, groups, and edges instead of hand-written SVG coordinates.',
    sourceType: 'manual',
    implementation: 'html-inline-script',
    actionPolicy: 'readonly',
    styleTags: ['editorial', 'notebook'],
    titleHint: 'relationship_graph',
    propsSchema: componentSchemas.relationship_graph,
    openuiExample: buildExampleTag('relationship_graph', { heading: '人物关系图', groups: '[...]', nodes: '[...]', edges: '[...]' }),
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
    implementation: 'html-inline-script',
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
    `<button data-ready-agent-message="${escapeAttr(item.message)}" style="border:1px solid ${widgetVar('hair')};border-radius:999px;padding:7px 12px;background:${widgetVar('accentSoft')};color:${widgetVar('accent')};font-size:12px;font-weight:500;cursor:pointer;">${escapeHtml(item.label)}</button>`
  )).join('')}</div>`
}

function compileStatsCard(props: z.infer<typeof componentSchemas.stats_card>): string {
  const cols = Math.min(props.metrics.length, 4)
  const cells = props.metrics.map((metric) => `<div class="stack" style="gap:6px;padding:14px;border-radius:12px;background:${widgetVar('canvas')};border:1px solid ${widgetVar('hair')};">
    <div class="label" style="font-size:10px;">${escapeHtml(metric.label)}</div>
    <div class="num" style="font-size:28px;font-weight:600;color:${widgetVar('ink')};line-height:1;">${escapeHtml(metric.value)}</div>
    ${metric.trend ? `<div class="num" style="font-size:12px;color:${widgetVar('ink2')};">${escapeHtml(metric.trend)}</div>` : ''}
  </div>`).join('')
  return `<div class="card stack" style="gap:16px;">
    ${renderHeader(props.heading)}
    <div style="display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:10px;">${cells}</div>
  </div>`
}

function compileSimpleBarChart(props: z.infer<typeof componentSchemas.bar_chart>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading)}
    ${renderReadyChart({
      type: 'bar',
      data: props.series.map((item) => ({ label: item.label, value: item.value })),
      unitLabel: props.yLabel,
    })}
  </div>`
}

function compileSimpleLineChart(props: z.infer<typeof componentSchemas.line_chart>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading)}
    ${renderReadyChart({
      type: 'line',
      data: props.series.map((item) => ({ label: item.label, value: item.value })),
      unitLabel: props.yLabel,
    })}
    ${props.annotation ? `<div style="display:flex;gap:8px;align-items:baseline;"><span class="label" style="color:${widgetVar('accent')};">INSIGHT</span><span style="font-size:13px;color:${widgetVar('inkBody')};">${escapeHtml(props.annotation)}</span></div>` : ''}
  </div>`
}

function compileDataTable(props: z.infer<typeof componentSchemas.data_table>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading)}
    <div style="overflow:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr>${props.columns.map((column) => `<th class="label" style="text-align:left;padding:10px 12px;border-bottom:1px solid ${widgetVar('hair')};">${escapeHtml(column)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${props.rows.map((row) => `<tr>${row.map((cell) => `<td style="padding:10px 12px;border-bottom:1px solid ${widgetVar('hairV')};color:${widgetVar('inkBody')};">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`
}

function compileCalloutBlock(props: z.infer<typeof componentSchemas.callout_block>): string {
  const resolvedTone = props.tone || 'info'
  const tones: Record<z.infer<typeof calloutToneSchema>, { bg: string; border: string; edge: string; label: string; labelColor: string }> = {
    info: { bg: widgetVar('canvas'), border: widgetVar('hair'), edge: 'transparent', label: '提示', labelColor: widgetVar('ink2') },
    success: { bg: widgetVar('canvas'), border: widgetVar('hair'), edge: widgetVar('ok'), label: '完成', labelColor: widgetVar('ink2') },
    warning: { bg: widgetVar('accentSoft'), border: widgetVar('hair'), edge: widgetVar('accent'), label: '提醒', labelColor: widgetVar('accent') },
    danger: { bg: widgetVar('accentSoft'), border: widgetVar('accent'), edge: widgetVar('accent'), label: '风险', labelColor: widgetVar('accent') },
    neutral: { bg: widgetVar('canvas'), border: widgetVar('hair'), edge: 'transparent', label: '说明', labelColor: widgetVar('ink2') },
  }
  const tone = tones[resolvedTone]
  return `<div class="card stack" style="gap:10px;padding:18px 20px;background:${tone.bg};border:1px solid ${tone.border};border-left:3px solid ${tone.edge === 'transparent' ? tone.border : tone.edge};">
    <div class="label" style="color:${tone.labelColor};">${tone.label}</div>
    ${props.heading ? `<div class="title">${escapeHtml(props.heading)}</div>` : ''}
    <div style="font-size:14px;line-height:1.7;color:${widgetVar('inkBody')};">${escapeHtml(props.body)}</div>
    ${props.points?.length ? `<ul style="margin:0;padding-left:18px;">${props.points.map((point) => `<li style="margin:6px 0;">${escapeHtml(point)}</li>`).join('')}</ul>` : ''}
  </div>`
}

function compileTabInfoBlock(props: z.infer<typeof componentSchemas.tab_info_block>): string {
  const tabs = props.tabs.map((tab, index) => `
    <button data-tab-target="tab-${index}" class="tab-button${index === 0 ? ' is-active' : ''}" style="border:0;border-radius:999px;padding:8px 12px;background:${index === 0 ? widgetVar('accentSoft') : widgetVar('canvas')};cursor:pointer;">${escapeHtml(tab.label)}</button>
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
    <script>(function(){const root=document.currentScript && document.currentScript.parentElement; if(!root) return; const buttons=Array.from(root.querySelectorAll('.tab-button')); const panels=Array.from(root.querySelectorAll('[data-tab-panel]')); buttons.forEach((button)=>{button.addEventListener('click',()=>{const target=button.getAttribute('data-tab-target'); buttons.forEach((btn)=>{btn.classList.remove('is-active'); btn.style.background='var(--widget-bg-secondary, #F0EFED)';}); panels.forEach((panel)=>{panel.style.display=panel.getAttribute('data-tab-panel')===target?'block':'none';}); button.classList.add('is-active'); button.style.background='var(--widget-accent-soft, rgba(255,75,43,.12))';});});})();</script>
  </div>`
}

function compileComparisonGrid(props: z.infer<typeof componentSchemas.comparison_grid>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading)}
    <div style="display:grid;grid-template-columns:repeat(${props.columns.length}, minmax(0,1fr));gap:12px;">
      ${props.columns.map((column) => `<section style="padding:14px;border-radius:12px;background:${widgetVar('canvas')};border:1px solid ${widgetVar('hair')};">
        <div style="font-weight:600;color:${widgetVar('ink')};margin-bottom:8px;">${escapeHtml(column.title)}</div>
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
        <div style="height:8px;border-radius:999px;background:${widgetVar('dcRest')};overflow:hidden;"><div style="height:100%;width:${ratio}%;background:${widgetVar('accent')};border-radius:999px;"></div></div>
      </div>`
    }).join('')}
  </div>`
}

function compileDayScheduleCard(props: z.infer<typeof componentSchemas.day_schedule_card>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading || props.dateLabel)}
    <div style="display:grid;gap:10px;">
      ${props.events.length > 0 ? props.events.map((event) => `<div style="padding:12px 14px;border-radius:12px;background:${widgetVar('canvas')};border:1px solid ${widgetVar('hair')};display:flex;justify-content:space-between;gap:12px;">
        <div>
          <div style="font-weight:600;color:${widgetVar('ink')};">${escapeHtml(event.title)}</div>
          ${event.meta ? `<div style="font-size:12px;color:${widgetVar('ink2')};">${escapeHtml(event.meta)}</div>` : ''}
        </div>
        <div class="num" style="white-space:nowrap;color:${widgetVar('accent')};font-size:13px;font-weight:500;">${escapeHtml(event.timeLabel)}</div>
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
      <button data-focus-target="current" class="focus-toggle is-active" style="border:0;border-radius:999px;padding:8px 12px;background:${widgetVar('accentSoft')};cursor:pointer;">${escapeHtml(props.currentLabel)}</button>
      <button data-focus-target="next" class="focus-toggle" style="border:0;border-radius:999px;padding:8px 12px;background:${widgetVar('canvas')};cursor:pointer;">${escapeHtml(props.nextLabel)}</button>
    </div>
    <section data-focus-panel="current"><ul style="margin:0;padding-left:18px;">${currentItems}</ul></section>
    <section data-focus-panel="next" style="display:none;"><ul style="margin:0;padding-left:18px;">${nextItems}</ul></section>
    <script>(function(){const root=document.currentScript && document.currentScript.parentElement;if(!root)return;const buttons=Array.from(root.querySelectorAll('[data-focus-target]'));const panels=Array.from(root.querySelectorAll('[data-focus-panel]'));buttons.forEach((button)=>{button.addEventListener('click',()=>{const target=button.getAttribute('data-focus-target');buttons.forEach((btn)=>{btn.classList.remove('is-active');btn.style.background='var(--widget-bg-secondary, #F0EFED)';});panels.forEach((panel)=>{panel.style.display=panel.getAttribute('data-focus-panel')===target?'block':'none';});button.classList.add('is-active');button.style.background='var(--widget-accent-soft, rgba(255,75,43,.12))';});});})();</script>
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
  return compileProcessFlow(processFlowFromGraph(props.heading, props.nodes, props.edges))
}

function compileWeekScheduleCard(props: z.infer<typeof componentSchemas.week_schedule_card>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading || props.weekLabel)}
    <div style="display:grid;grid-template-columns:repeat(${Math.min(props.days.length, 4)}, minmax(0,1fr));gap:10px;">
      ${props.days.map((day) => `<section style="padding:12px;border-radius:12px;background:${widgetVar('canvas')};border:1px solid ${widgetVar('hair')};">
        <div style="font-weight:600;color:${widgetVar('ink')};">${escapeHtml(day.label)}</div>
        <div class="num" style="font-size:12px;color:${widgetVar('ink2')};margin-top:4px;">${day.count} 个安排</div>
        ${(day.highlights || []).length ? `<ul style="margin:10px 0 0;padding-left:18px;">${(day.highlights || []).map((item) => `<li style="margin:4px 0;">${escapeHtml(item)}</li>`).join('')}</ul>` : `<div style="margin-top:10px;font-size:12px;color:${widgetVar('ink3')};">暂无重点</div>`}
      </section>`).join('')}
    </div>
    ${buildButtonRow([{ label: '查看本周日历', message: `请切换到日历模式并查看${props.weekLabel}。` }])}
  </div>`
}

function compileTimeAllocationChart(props: z.infer<typeof componentSchemas.time_allocation_chart>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading || props.periodLabel)}
    ${renderReadyChart({
      type: 'pie',
      data: props.segments.map((segment) => ({ label: segment.label, value: segment.value })),
      unitLabel: 'h',
    })}
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
    ${props.jobs.map((job) => `<section style="padding:14px;border-radius:12px;background:${widgetVar('canvas')};border:1px solid ${widgetVar('hair')};display:grid;gap:6px;">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;"><strong style="color:${widgetVar('ink')};font-weight:600;">${escapeHtml(job.name)}</strong><span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:${widgetVar('ink2')};"><span class="dot${job.status === 'running' ? ' dot--active' : job.status === 'enabled' ? ' dot--done' : job.status === 'error' ? ' dot--blocked' : ''}"></span>${statusLabel[job.status]}</span></div>
      ${job.nextRun ? `<div class="num" style="font-size:12px;color:${widgetVar('ink2')};">下次运行：${escapeHtml(job.nextRun)}</div>` : ''}
      ${job.lastRun ? `<div class="num" style="font-size:12px;color:${widgetVar('ink3')};">最近运行：${escapeHtml(job.lastRun)}</div>` : ''}
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
      ${props.items.map((item, index) => `<label style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:12px;background:${widgetVar('canvas')};border:1px solid ${widgetVar('hair')};">
        <input type="checkbox" ${item.done ? 'checked' : ''} data-todo-index="${index}" />
        <span style="flex:1;${item.done ? `text-decoration:line-through;color:${widgetVar('ink3')};` : ''}">${escapeHtml(item.text)}${item.note ? `<small style="display:block;margin-top:4px;color:${widgetVar('ink2')};">${escapeHtml(item.note)}</small>` : ''}</span>
      </label>`).join('')}
    </div>
    <script>(function(){const root=document.currentScript && document.currentScript.parentElement; if(!root) return; root.querySelectorAll('input[type="checkbox"]').forEach((box)=>{box.addEventListener('change',()=>{const text=box.parentElement && box.parentElement.querySelector('span'); if(text){text.style.textDecoration = box.checked ? 'line-through' : 'none'; text.style.color = box.checked ? 'var(--widget-text-faint, #999999)' : '';}});});})();</script>
  </div>`
}

function compileWeeklyPlanBoard(props: z.infer<typeof componentSchemas.weekly_plan_board_manual>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading)}
    <div style="display:grid;grid-template-columns:repeat(${props.lanes.length}, minmax(0,1fr));gap:12px;">
      ${props.lanes.map((lane) => `<section style="padding:12px;border-radius:12px;background:${widgetVar('canvas')};border:1px solid ${widgetVar('hair')};">
        <div style="font-weight:600;color:${widgetVar('ink')};margin-bottom:8px;">${escapeHtml(lane.title)}</div>
        <ul style="margin:0;padding-left:18px;">${lane.items.map((item) => `<li style="margin:6px 0;">${escapeHtml(item)}</li>`).join('')}</ul>
      </section>`).join('')}
    </div>
  </div>`
}

function compileHabitStreak(props: z.infer<typeof componentSchemas.habit_streak_manual>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading)}
    ${props.habits.map((habit) => `<section style="padding:12px;border-radius:12px;background:${widgetVar('canvas')};border:1px solid ${widgetVar('hair')};display:grid;gap:6px;">
      <div style="display:flex;justify-content:space-between;gap:12px;"><strong style="color:${widgetVar('ink')};font-weight:600;">${escapeHtml(habit.name)}</strong><span class="num" style="color:${widgetVar('ink2')};">${habit.streak} 天</span></div>
      <div style="display:flex;gap:6px;">${habit.weekMarks.map((mark) => `<span style="width:12px;height:12px;border-radius:50%;background:${mark ? widgetVar('ok') : widgetVar('dcRest')};"></span>`).join('')}</div>
    </section>`).join('')}
  </div>`
}

function compileTodayFocusSnapshot(props: z.infer<typeof componentSchemas.today_focus_snapshot>): string {
  return `<div class="card stack" style="gap:14px;">
    ${renderHeader(props.heading || props.dayLabel)}
    <div style="display:grid;grid-template-columns:repeat(${props.metrics.length}, minmax(0,1fr));gap:10px;">
      ${props.metrics.map((metric) => `<section style="padding:12px;border-radius:12px;background:${widgetVar('canvas')};border:1px solid ${widgetVar('hair')};"><div class="label" style="font-size:10px;">${escapeHtml(metric.label)}</div><div class="num" style="font-size:22px;font-weight:600;color:${widgetVar('ink')};margin-top:4px;">${escapeHtml(metric.value)}</div></section>`).join('')}
    </div>
    <ul style="margin:0;padding-left:18px;">${props.highlights.map((item) => `<li style="margin:6px 0;">${escapeHtml(item)}</li>`).join('')}</ul>
    ${buildButtonRow([{ label: '查看今天安排', message: `请切换到日历模式并查看${props.dayLabel}的重点安排。` }])}
  </div>`
}

function compileInfoCard(props: z.infer<typeof componentSchemas.info_card>): string {
  return compileReadyInfoCard({
    title: props.heading,
    body: props.body,
    facts: props.facts,
    points: props.points,
    kicker: resolveInfoCardKicker(props.tone),
    ramp: resolveInfoCardRamp(props.tone),
    decoration: 'none',
  })
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

type JsonSchemaNode = {
  type?: string | string[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode | JsonSchemaNode[]
  enum?: unknown[]
  anyOf?: JsonSchemaNode[]
  oneOf?: JsonSchemaNode[]
  const?: unknown
  minItems?: number
  maxItems?: number
}

function summarizePrimitive(node: JsonSchemaNode): string {
  if (node.enum && node.enum.length > 0) {
    const values = node.enum
      .filter((value): value is string | number | boolean => {
        const t = typeof value
        return t === 'string' || t === 'number' || t === 'boolean'
      })
      .map((value) => String(value))
    if (values.length > 0) return `enum: ${values.join('|')}`
  }
  if (Array.isArray(node.type)) return node.type.join('|')
  if (typeof node.type === 'string') return node.type
  return 'any'
}

function summarizeTypeInline(node: JsonSchemaNode): string {
  if (node.anyOf && node.anyOf.length > 0) {
    return node.anyOf.map((sub) => summarizeTypeInline(sub)).join('|')
  }
  if (node.type === 'array') {
    const items = Array.isArray(node.items) ? node.items[0] : node.items
    if (!items) return 'array'
    if (items.type === 'object') {
      const keys = Object.keys(items.properties || {})
      if (keys.length === 0) return 'object[]'
      return `{${keys.join(',')}}[]`
    }
    if (items.type === 'array') return `${summarizeTypeInline(items)}[]`
    return `${summarizePrimitive(items)}[]`
  }
  if (node.type === 'object') {
    const keys = Object.keys(node.properties || {})
    return keys.length > 0 ? `{${keys.join(',')}}` : 'object'
  }
  return summarizePrimitive(node)
}

function describeNestedObjectNode(label: string, node: JsonSchemaNode): string | null {
  if (node.type !== 'object' || !node.properties) return null
  const required = new Set(node.required || [])
  const parts = Object.entries(node.properties).map(([key, child]) => {
    const marker = required.has(key) ? '!' : '?'
    return `${key}${marker}(${summarizeTypeInline(child)})`
  })
  if (parts.length === 0) return null
  return `    · ${label} = {${parts.join(', ')}}`
}

function collectNestedLines(schema: JsonSchemaNode): string[] {
  if (!schema.properties) return []
  const lines: string[] = []
  for (const [propName, node] of Object.entries(schema.properties)) {
    if (node.type === 'array') {
      const items = Array.isArray(node.items) ? node.items[0] : node.items
      if (items && items.type === 'object') {
        const nested = describeNestedObjectNode(`${propName}[]`, items)
        if (nested) lines.push(nested)
      }
    } else if (node.type === 'object') {
      const nested = describeNestedObjectNode(propName, node)
      if (nested) lines.push(nested)
    }
  }
  return lines
}

export function describeApprovedWidgetProps(names: Iterable<DocumentWidgetComponentName>): string {
  const blocks: string[] = []
  for (const name of names) {
    const schema = componentSchemas[name]
    if (!schema) continue
    const jsonSchema = z.toJSONSchema(schema) as JsonSchemaNode
    const required = new Set(jsonSchema.required || [])
    const propEntries = Object.entries(jsonSchema.properties || {})
    const propsLine = propEntries.map(([key, node]) => {
      const marker = required.has(key) ? '!' : '?'
      return `${key}${marker}(${summarizeTypeInline(node)})`
    }).join(', ')
    blocks.push(`- ${name}: ${propsLine}`)
    for (const nestedLine of collectNestedLines(jsonSchema)) {
      blocks.push(nestedLine)
    }
  }
  return blocks.join('\n')
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
    } else if (entry.name === 'relationship_graph') {
      const props = result.data as z.infer<typeof componentSchemas.relationship_graph>
      const nodeIds = new Set<string>()
      for (const node of props.nodes) {
        if (nodeIds.has(node.id)) errors.push(`relationship_graph.nodes: duplicate node id "${node.id}"`)
        nodeIds.add(node.id)
      }
      const groupIds = new Set((props.groups || []).map((group) => group.id))
      for (const group of props.groups || []) {
        if ((props.groups || []).filter((candidate) => candidate.id === group.id).length > 1) {
          errors.push(`relationship_graph.groups: duplicate group id "${group.id}"`)
        }
      }
      for (const node of props.nodes) {
        if (node.group && groupIds.size > 0 && !groupIds.has(node.group)) {
          errors.push(`relationship_graph.nodes.${node.id}: unknown group "${node.group}"`)
        }
      }
      for (const edge of props.edges) {
        if (!nodeIds.has(edge.from)) errors.push(`relationship_graph.edges: unknown from node "${edge.from}"`)
        if (!nodeIds.has(edge.to)) errors.push(`relationship_graph.edges: unknown to node "${edge.to}"`)
      }
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
    case 'relationship_graph':
      return compileRelationshipGraph(componentSchemas.relationship_graph.parse(props))
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

export const WIDGET_COMPONENT_IDS: ReadonlyArray<DocumentWidgetComponentName>
  = documentWidgetCatalog.map((entry) => entry.name)

export function listDocumentWidgetCatalog(): DocumentWidgetCatalogEntry[] {
  return [...documentWidgetCatalog]
}
