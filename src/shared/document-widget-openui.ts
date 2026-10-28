import { z } from 'zod'
import { createLibrary, defineComponent } from './openui-lite'
import { READY_DOT_ROW_COLS, renderDotRowSvg, renderReadyChart } from './document-widget-dot-charts'
import { widgetVar } from './document-widget-theme'
import {
  renderWidgetChrome,
  renderWidgetDotList,
  renderWidgetHeading,
  renderWidgetLabelRow,
  type WidgetKickerTone,
} from './document-widget-chassis'
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
export type DocumentWidgetDataSourceType = 'manual' | 'calendar'
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

export interface TodayFocusSnapshot {
  dayLabel: string
  highlights: string[]
  metrics: Array<{ label: string; value: string }>
}

export interface DocumentWidgetCompileContext {
  calendar?: DayScheduleSnapshot
  calendarWeek?: WeekScheduleSnapshot
  timeAllocation?: TimeAllocationSnapshot
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
    'For calendar widgets, request existing data snapshots instead of inventing fake personal data.',
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
  return renderWidgetHeading(heading)
}

const INK = widgetVar('ink')
const INK2 = widgetVar('ink2')
const INK3 = widgetVar('ink3')
const INK_BODY = widgetVar('inkBody')
const HAIR = widgetVar('hair')
const CANVAS = widgetVar('canvas')
const ACCENT = widgetVar('accent')
const ACCENT_WASH = widgetVar('accentWash')

function buildButtonRow(items: Array<{ label: string; message: string }>): string {
  if (items.length === 0) return ''
  return `<div class="widget-actions" style="display:flex;gap:8px;flex-wrap:wrap;">${items.map((item) => (
    `<button data-ready-agent-message="${escapeAttr(item.message)}" style="display:inline-flex;align-items:center;gap:7px;border:0;border-radius:999px;padding:6px 13px 6px 11px;background:var(--widget-bg-secondary, rgba(26,26,26,.035));color:${INK};font-size:12px;font-weight:500;line-height:16px;cursor:pointer;"><span style="width:5px;height:5px;border-radius:50%;background:${ACCENT};"></span>${escapeHtml(item.label)}</button>`
  )).join('')}</div>`
}

function renderSegmented(attr: 'data-tab-target' | 'data-focus-target', className: string, items: Array<{ target: string; label: string }>): string {
  return `<div class="segmented" role="tablist">${items.map((item, index) => (
    `<button ${attr}="${escapeAttr(item.target)}" class="${className}${index === 0 ? ' is-active' : ''}" role="tab">${escapeHtml(item.label)}</button>`
  )).join('')}</div>`
}

/** 分段切换脚本：只切 is-active 与面板显隐，视觉全部交给 .segmented 类层。 */
function segmentedScript(buttonSelector: string, attr: string, panelAttr: string): string {
  return `<script>(function(){const root=document.currentScript && document.currentScript.parentElement;if(!root)return;const buttons=Array.from(root.querySelectorAll('${buttonSelector}'));const panels=Array.from(root.querySelectorAll('[${panelAttr}]'));buttons.forEach((button)=>{button.addEventListener('click',()=>{const target=button.getAttribute('${attr}');buttons.forEach((btn)=>btn.classList.toggle('is-active',btn===button));panels.forEach((panel)=>{panel.style.display=panel.getAttribute('${panelAttr}')===target?'block':'none';});});});})();</script>`
}

function compileStatsCard(props: z.infer<typeof componentSchemas.stats_card>): string {
  const cols = props.metrics.length <= 4 ? props.metrics.length : 3
  const span = 12 / Math.max(1, cols)
  const cells = props.metrics.map((metric) => `<div data-metric class="span-${span}" style="min-width:0;">
    <div class="label" style="font-size:10px;">${escapeHtml(metric.label)}</div>
    <div class="num" style="margin-top:10px;font-size:32px;font-weight:500;letter-spacing:-0.02em;line-height:36px;color:${INK};white-space:nowrap;">${escapeHtml(metric.value)}</div>
    ${metric.trend ? `<div class="num" style="margin-top:8px;font-size:11.5px;line-height:16px;letter-spacing:0.02em;color:${INK2};">${escapeHtml(metric.trend)}</div>` : ''}
  </div>`).join('')
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'METRICS', meta: `${props.metrics.length} 项` })}
    ${renderHeader(props.heading)}
    <div class="grid keep-pairs" style="row-gap:28px;padding-top:4px;">${cells}</div>
  </div>`
}

function renderOpenuiInsight(text: string): string {
  return `<div data-chart-insight>${renderWidgetLabelRow('INSIGHT', `<div style="font-size:14px;line-height:22px;color:${INK};">${escapeHtml(text)}</div>`, { labelColor: ACCENT })}</div>`
}

function compileSimpleBarChart(props: z.infer<typeof componentSchemas.bar_chart>): string {
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'DATA', meta: props.yLabel ? `单位 · ${props.yLabel}` : `${props.series.length} 项` })}
    ${renderHeader(props.heading)}
    <div>${renderReadyChart({
      type: 'bar',
      data: props.series.map((item) => ({ label: item.label, value: item.value })),
      unitLabel: props.yLabel,
    })}</div>
  </div>`
}

function compileSimpleLineChart(props: z.infer<typeof componentSchemas.line_chart>): string {
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'TREND', meta: props.yLabel ? `单位 · ${props.yLabel}` : `${props.series.length} 点` })}
    ${renderHeader(props.heading)}
    <div>${renderReadyChart({
      type: 'line',
      data: props.series.map((item) => ({ label: item.label, value: item.value })),
      unitLabel: props.yLabel,
    })}</div>
    ${props.annotation ? renderOpenuiInsight(props.annotation) : ''}
  </div>`
}

const NUMERIC_CELL = /^[\s+\-−±~≈]*[¥$€£]?\s*\d[\d,.\s]*(?:%|‰|[a-zA-Z]{1,3}|[万亿千百倍元次个人天小时分秒])?\s*$/

function compileDataTable(props: z.infer<typeof componentSchemas.data_table>): string {
  // 三线表：顶线与表头线用 hairline，行间极淡；整列都是数值时右对齐并用 tabular mono。
  const numericColumns = props.columns.map((_, columnIndex) => {
    const cells = props.rows.map((row) => (row[columnIndex] ?? '').trim()).filter(Boolean)
    return cells.length > 0 && cells.every((cell) => NUMERIC_CELL.test(cell))
  })
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'TABLE', meta: `${props.rows.length} 行 · ${props.columns.length} 列` })}
    ${renderHeader(props.heading)}
    <div style="overflow:auto;border-top:1px solid ${HAIR};border-bottom:1px solid ${HAIR};">
      <table style="width:100%;border-collapse:collapse;font-size:13px;line-height:1.55;font-variant-numeric:tabular-nums;">
        <thead>
          <tr>${props.columns.map((column, columnIndex) => `<th class="label" style="text-align:${numericColumns[columnIndex] ? 'right' : 'left'};font-size:10px;padding:11px ${columnIndex === props.columns.length - 1 ? 0 : 12}px 10px ${columnIndex === 0 ? 0 : 12}px;border-bottom:1px solid var(--widget-border, #E8E5DE);">${escapeHtml(column)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${props.rows.map((row, rowIndex) => `<tr>${row.map((cell, cellIndex) => `<td${numericColumns[cellIndex] ? ' class="num"' : ''} style="padding:10px ${cellIndex === row.length - 1 ? 0 : 12}px 10px ${cellIndex === 0 ? 0 : 12}px;${rowIndex < props.rows.length - 1 ? `border-bottom:1px solid ${widgetVar('hairV')};` : ''}color:${cellIndex === 0 ? INK : INK_BODY};${cellIndex === 0 ? 'font-weight:500;' : ''}${numericColumns[cellIndex] ? 'text-align:right;font-size:12.5px;white-space:nowrap;' : ''}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`
}

function compileCalloutBlock(props: z.infer<typeof componentSchemas.callout_block>): string {
  const resolvedTone = props.tone || 'info'
  // 语气只落在身份行圆点与结论底色上（极浅），正文永不穿彩。
  const tones: Record<z.infer<typeof calloutToneSchema>, { surface: string; label: string; kicker: WidgetKickerTone }> = {
    info: { surface: CANVAS, label: '提示', kicker: 'ink' },
    success: { surface: CANVAS, label: '完成', kicker: 'ok' },
    warning: { surface: ACCENT_WASH, label: '提醒', kicker: 'accent' },
    danger: { surface: ACCENT_WASH, label: '风险', kicker: 'accent' },
    neutral: { surface: CANVAS, label: '说明', kicker: 'quiet' },
  }
  const tone = tones[resolvedTone]
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: tone.label, tone: tone.kicker })}
    ${props.heading ? `<div class="title">${escapeHtml(props.heading)}</div>` : ''}
    <div style="padding:16px 20px;border-radius:10px;background:${tone.surface};font-size:15px;line-height:26px;color:${INK};text-wrap:pretty;">${escapeHtml(props.body)}</div>
    ${props.points?.length ? renderWidgetDotList(props.points, { size: 13.5, gap: 6 }) : ''}
  </div>`
}

function compileTabInfoBlock(props: z.infer<typeof componentSchemas.tab_info_block>): string {
  const tabs = renderSegmented('data-tab-target', 'tab-button', props.tabs.map((tab, index) => ({ target: `tab-${index}`, label: tab.label })))
  const panels = props.tabs.map((tab, index) => `
    <section data-tab-panel="tab-${index}" style="display:${index === 0 ? 'block' : 'none'};">
      <div style="font-size:14.5px;line-height:24px;color:${INK};text-wrap:pretty;">${escapeHtml(tab.body)}</div>
      ${(tab.points || []).length ? `<div style="margin-top:12px;">${renderWidgetDotList(tab.points || [], { size: 13.5, gap: 7 })}</div>` : ''}
    </section>
  `).join('')
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'BRIEF', meta: `${props.tabs.length} 组` })}
    ${renderHeader(props.heading)}
    ${tabs}
    <div>${panels}</div>
    ${segmentedScript('.tab-button', 'data-tab-target', 'data-tab-panel')}
  </div>`
}

function compileComparisonGrid(props: z.infer<typeof componentSchemas.comparison_grid>): string {
  const span = 12 / props.columns.length
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'COMPARE', meta: `${props.columns.length} 方案` })}
    ${renderHeader(props.heading)}
    <div class="grid">
      ${props.columns.map((column, index) => `<section class="span-${span} stack" style="gap:12px;min-width:0;">
        <div style="display:flex;align-items:baseline;gap:10px;"><span class="num" style="font-size:10.5px;color:${INK3};">${String.fromCharCode(65 + index)}</span><span style="font-size:15px;font-weight:600;line-height:22px;color:${INK};">${escapeHtml(column.title)}</span></div>
        ${renderWidgetDotList(column.points, { size: 13.5, gap: 8 })}
      </section>`).join('')}
    </div>
  </div>`
}

function compileProgressSnapshot(props: z.infer<typeof componentSchemas.progress_snapshot>): string {
  // 进度：名称落在标签栏（2 栏），点阵 8 栏（与横向点条同一节距），数值 2 栏右对齐。
  const rows = props.items.map((item) => {
    const max = item.max || 100
    const ratio = item.value / max
    return `<span class="span-2" style="font-size:13.5px;line-height:20px;color:${INK};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(item.label)}</span>
      <div class="span-8">${renderDotRowSvg(Math.max(0, Math.min(1, ratio)) * READY_DOT_ROW_COLS, widgetVar('dcOn'), 1)}</div>
      <span class="num span-2" style="font-size:12px;line-height:20px;color:${INK};text-align:right;white-space:nowrap;">${escapeHtml(item.displayValue || `${item.value}/${max}`)}</span>`
  }).join('')
  const average = props.items.reduce((sum, item) => sum + Math.max(0, Math.min(1, item.value / (item.max || 100))), 0) / Math.max(props.items.length, 1)
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'PROGRESS', meta: `平均 ${Math.round(average * 100)}%` })}
    ${renderHeader(props.heading)}
    <div class="grid keep-row" style="row-gap:14px;align-items:center;padding-top:4px;">${rows}</div>
  </div>`
}

function compileDayScheduleCard(props: z.infer<typeof componentSchemas.day_schedule_card>): string {
  const rows = props.events.length > 0
    ? props.events.map((event) => `<div class="num span-2" style="padding-top:3px;font-size:11.5px;line-height:16px;color:${INK2};white-space:nowrap;">${escapeHtml(event.timeLabel)}</div>
        <div class="span-10" style="min-width:0;">
          <div style="font-size:14.5px;font-weight:600;line-height:22px;color:${INK};">${escapeHtml(event.title)}</div>
          ${event.meta ? `<div style="font-size:13px;line-height:20px;color:${INK2};margin-top:2px;">${escapeHtml(event.meta)}</div>` : ''}
        </div>`).join('')
    : `<div class="subtitle span-12">今天没有已记录安排。</div>`
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'SCHEDULE', meta: `${props.dateLabel} · ${props.events.length} 项` })}
    ${renderHeader(props.heading || props.dateLabel)}
    <div class="grid" style="row-gap:20px;padding-top:4px;">${rows}</div>
    ${buildButtonRow([
      { label: '打开日历', message: `请切换到日历模式并查看${props.dateLabel}的安排。` },
      { label: '新增事件', message: `请在日历里新增一个${props.dateLabel}的事件。` },
    ])}
  </div>`
}

function renderFocusItems(items: Array<{ label: string; detail?: string }>): string {
  return `<div class="grid" style="row-gap:16px;">${items.map((item, index) => `<span class="num span-2" style="padding-top:3px;font-size:11.5px;line-height:16px;color:${INK3};">${String(index + 1).padStart(2, '0')}</span>
    <div class="span-10" style="min-width:0;"><div style="font-size:14.5px;font-weight:600;line-height:22px;color:${INK};">${escapeHtml(item.label)}</div>${item.detail ? `<div style="font-size:13px;line-height:20px;color:${INK2};margin-top:2px;">${escapeHtml(item.detail)}</div>` : ''}</div>`).join('')}</div>`
}

function compileWeeklyFocusChart(props: z.infer<typeof componentSchemas.weekly_focus_chart>): string {
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'FOCUS', meta: `${props.currentItems.length} · ${props.nextItems.length}` })}
    ${renderHeader(props.heading)}
    ${renderSegmented('data-focus-target', 'focus-toggle', [
      { target: 'current', label: props.currentLabel },
      { target: 'next', label: props.nextLabel },
    ])}
    <section data-focus-panel="current">${renderFocusItems(props.currentItems)}</section>
    <section data-focus-panel="next" style="display:none;">${renderFocusItems(props.nextItems)}</section>
    ${segmentedScript('[data-focus-target]', 'data-focus-target', 'data-focus-panel')}
  </div>`
}

function compileMiniCalculator(props: z.infer<typeof componentSchemas.mini_calculator>): string {
  const span = props.fields.length >= 3 ? 4 : 6
  const inputs = props.fields.map((field) => `<label class="span-${span} stack" style="gap:6px;min-width:0;"><span class="label" style="font-size:10px;">${escapeHtml(field.label)}</span><input type="number" id="${escapeAttr(field.id)}" ${field.min != null ? `min="${field.min}"` : ''} ${field.max != null ? `max="${field.max}"` : ''} ${field.value != null ? `value="${field.value}"` : ''} class="num" style="font-size:16px;" /></label>`).join('')
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'CALCULATOR', meta: `${props.fields.length} 项输入` })}
    ${renderHeader(props.heading)}
    <div class="grid keep-pairs" style="row-gap:20px;">${inputs}</div>
    ${renderWidgetLabelRow(props.outputLabel, `<span id="calculator-output" class="figure" style="font-size:32px;line-height:36px;">-</span>`)}
    <script>(function(){const root=document.currentScript && document.currentScript.parentElement;if(!root)return;const inputs=Array.from(root.querySelectorAll('input[type="number"]'));const output=root.querySelector('#calculator-output');const render=()=>{if(!output)return;const values=inputs.map((input)=>Number(input.value||0));if(values.every((value)=>value===0)&&inputs.every((input)=>input.value==='')){output.textContent='-';return;}const total=values.reduce((sum,value)=>sum+value,0)/Math.max(values.length,1);output.textContent=String(total.toFixed(1));};inputs.forEach((input)=>input.addEventListener('input',render));render();})();</script>
  </div>`
}

function compileFlowDiagram(props: z.infer<typeof componentSchemas.flow_diagram>): string {
  return compileProcessFlow(processFlowFromGraph(props.heading, props.nodes, props.edges))
}

function compileWeekScheduleCard(props: z.infer<typeof componentSchemas.week_schedule_card>): string {
  const total = props.days.reduce((sum, day) => sum + day.count, 0)
  const span = 12 / Math.min(props.days.length, 4)
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'WEEK', meta: `${props.weekLabel} · ${total} 项` })}
    ${renderHeader(props.heading || props.weekLabel)}
    <div class="grid keep-pairs" style="row-gap:24px;">
      ${props.days.map((day) => `<section class="span-${span}" style="min-width:0;padding-top:10px;border-top:1px solid ${HAIR};">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;"><span style="font-size:14px;font-weight:600;line-height:22px;color:${INK};">${escapeHtml(day.label)}</span><span class="num" style="font-size:11px;color:${day.count > 0 ? INK2 : INK3};">${day.count}</span></div>
        ${(day.highlights || []).length ? `<div style="margin-top:8px;">${renderWidgetDotList(day.highlights || [], { size: 12.5, gap: 4 })}</div>` : `<div style="margin-top:8px;font-size:12.5px;line-height:20px;color:${INK3};">暂无重点</div>`}
      </section>`).join('')}
    </div>
    ${buildButtonRow([{ label: '查看本周日历', message: `请切换到日历模式并查看${props.weekLabel}。` }])}
  </div>`
}

function compileTimeAllocationChart(props: z.infer<typeof componentSchemas.time_allocation_chart>): string {
  const total = props.segments.reduce((sum, segment) => sum + Math.max(segment.value, 0), 0)
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'TIME', meta: `${props.periodLabel} · ${Math.round(total * 10) / 10} h` })}
    ${renderHeader(props.heading || props.periodLabel)}
    ${renderReadyChart({
      type: 'pie',
      data: props.segments.map((segment) => ({ label: segment.label, value: segment.value })),
      unitLabel: 'h',
    })}
    ${buildButtonRow([{ label: '查看日历明细', message: `请切换到日历模式并查看${props.periodLabel}的时间分配。` }])}
  </div>`
}

function compileTodoListManual(props: z.infer<typeof componentSchemas.todo_list_manual>): string {
  const doneCount = props.items.filter((item) => item.done).length
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'TODO', meta: `${doneCount} / ${props.items.length} 完成` })}
    ${renderHeader(props.heading)}
    <div style="display:grid;border-top:1px solid ${HAIR};">
      ${props.items.map((item, index) => `<label style="display:flex;gap:12px;align-items:flex-start;padding:11px 2px;border-bottom:1px solid ${HAIR};cursor:pointer;">
        <input type="checkbox" ${item.done ? 'checked' : ''} data-todo-index="${index}" />
        <span style="flex:1;min-width:0;font-size:14px;line-height:1.5;${item.done ? `text-decoration:line-through;text-decoration-color:${INK3};color:${INK3};` : `color:${INK};`}">${escapeHtml(item.text)}${item.note ? `<small style="display:block;margin-top:2px;font-size:12px;color:${INK2};text-decoration:none;">${escapeHtml(item.note)}</small>` : ''}</span>
      </label>`).join('')}
    </div>
    <script>(function(){const root=document.currentScript && document.currentScript.parentElement; if(!root) return; root.querySelectorAll('input[type="checkbox"]').forEach((box)=>{box.addEventListener('change',()=>{const text=box.parentElement && box.parentElement.querySelector('span'); if(text){text.style.textDecoration = box.checked ? 'line-through' : 'none'; text.style.color = box.checked ? 'var(--widget-text-faint, #999999)' : 'var(--widget-text-primary, #1A1A1A)';}});});})();</script>
  </div>`
}

function compileWeeklyPlanBoard(props: z.infer<typeof componentSchemas.weekly_plan_board_manual>): string {
  const span = 12 / props.lanes.length
  // 看板：每列顶边一条 hairline + mono 列名，条目是对齐的纯文字行，不叠底板与卡片。
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'PLAN', meta: `${props.lanes.length} 列` })}
    ${renderHeader(props.heading)}
    <div class="grid keep-pairs">
      ${props.lanes.map((lane) => `<section class="span-${span}" style="min-width:0;padding-top:10px;border-top:1px solid ${HAIR};">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:10px;"><span class="label" style="font-size:10px;color:${INK};">${escapeHtml(lane.title)}</span><span class="num" style="font-size:10.5px;color:${INK3};">${lane.items.length}</span></div>
        ${renderWidgetDotList(lane.items, { size: 13.5, gap: 6 })}
      </section>`).join('')}
    </div>
  </div>`
}

function compileHabitStreak(props: z.infer<typeof componentSchemas.habit_streak_manual>): string {
  const weekdays = ['一', '二', '三', '四', '五', '六', '日']
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'HABITS', meta: `${props.habits.length} 项` })}
    ${renderHeader(props.heading)}
    <div style="display:grid;grid-template-columns:minmax(0,1fr) repeat(7,18px) minmax(48px,auto);gap:8px 6px;align-items:center;">
      <span></span>${weekdays.map((day) => `<span class="num" style="font-size:9.5px;color:${INK3};text-align:center;">${day}</span>`).join('')}<span></span>
      ${props.habits.map((habit) => `<span style="font-size:13.5px;font-weight:500;color:${INK};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(habit.name)}</span>${habit.weekMarks.map((mark) => `<span style="justify-self:center;width:9px;height:9px;border-radius:50%;background:${mark ? widgetVar('dcOn') : widgetVar('dcRest')};"></span>`).join('')}<span class="num" style="font-size:12px;color:${INK};text-align:right;">${habit.streak}<span style="color:${INK2};margin-left:2px;">天</span></span>`).join('')}
    </div>
  </div>`
}

function compileTodayFocusSnapshot(props: z.infer<typeof componentSchemas.today_focus_snapshot>): string {
  const span = 12 / Math.max(1, props.metrics.length)
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'TODAY', meta: props.dayLabel })}
    ${renderHeader(props.heading || props.dayLabel)}
    <div class="grid keep-pairs" style="row-gap:24px;">
      ${props.metrics.map((metric) => `<section class="span-${span}" style="min-width:0;"><div class="label" style="font-size:10px;">${escapeHtml(metric.label)}</div><div class="figure" style="font-size:26px;line-height:32px;margin-top:8px;">${escapeHtml(metric.value)}</div></section>`).join('')}
    </div>
    ${renderWidgetDotList(props.highlights, { size: 13.5, gap: 6 })}
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

// A rejected spec says what would have been accepted, so the caller can correct it instead of guessing.
function unknownComponentMessage(component: unknown): string {
  return `Unknown approved document widget component: ${String(component)}. Approved components: ${WIDGET_COMPONENT_IDS.join(', ')}`
}

export function validateDocumentWidgetComponentSpec(spec: DocumentWidgetComponentSpec): DocumentWidgetValidateResult {
  const entry = getComponentEntry(spec.component)
  if (!entry) {
    return {
      ok: false,
      errors: [unknownComponentMessage(spec.component)],
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
      errors.push(`${entry.name} props (!required ?optional):\n${describeApprovedWidgetProps([entry.name])}`)
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
    throw new Error(unknownComponentMessage(spec.component))
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
