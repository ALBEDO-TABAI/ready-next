import { z } from 'zod'
import { renderReadyChart } from './document-widget-dot-charts'
import {
  compileProcessFlow,
  processFlowPropsSchema,
} from './document-widget-process-flow'
import {
  compileRelationshipGraph,
  relationshipGraphPropsSchema,
} from './document-widget-relation-graph'
import {
  resolveWidgetTone,
  widgetVar,
} from './document-widget-theme'
import { compileReadyInfoCard } from './document-widget-info-card'
import {
  renderWidgetChrome,
  renderWidgetDotList,
  renderWidgetFoot,
  renderWidgetHeading,
  renderWidgetLabelRow,
} from './document-widget-chassis'

export type WidgetSize =
  | 'square_card'
  | 'portrait_card'
  | 'story_card'
  | 'landscape_card'
  | 'landscape_4_3'
  | 'a4_portrait'
  | 'doc_block'

export const WIDGET_SIZE_IDS: readonly WidgetSize[] = [
  'square_card',
  'portrait_card',
  'story_card',
  'landscape_card',
  'landscape_4_3',
  'a4_portrait',
  'doc_block',
]

export type WidgetBackgroundMode = 'opaque' | 'transparent'

export type WidgetSkeletonId =
  | 'single_focus'
  | 'dual_compare'
  | 'metric_grid'
  | 'vertical_timeline'
  | 'photo_note'
  | 'chart_focus'
  | 'grid_collection'
  | 'relation_map'
  | 'process_flow'
  | 'freeform_static'
  | 'freeform_interactive'

export const WIDGET_SKELETON_IDS: readonly WidgetSkeletonId[] = [
  'single_focus',
  'dual_compare',
  'metric_grid',
  'vertical_timeline',
  'photo_note',
  'chart_focus',
  'grid_collection',
  'relation_map',
  'process_flow',
  'freeform_static',
  'freeform_interactive',
]

/**
 * legacy 六色 ramp id 继续被 schema 接受（存量 spec 兼容），但不再驱动多彩配色；
 * 语义经 resolveWidgetToneStyle 收敛为 Ready 三档（neutral / ok / accent）。
 */
export const RAMP_IDS = ['indigo', 'emerald', 'amber', 'slate', 'rose', 'sky'] as const
export type WidgetRampId = (typeof RAMP_IDS)[number]

const rampSchema = z.enum(RAMP_IDS)
const sizeSchema = z.enum([
  'square_card',
  'portrait_card',
  'story_card',
  'landscape_card',
  'landscape_4_3',
  'a4_portrait',
  'doc_block',
])
const backgroundModeSchema = z.enum(['opaque', 'transparent'])

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

function escapeRichText(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br/>')
}

interface CanvasOptions {
  size: WidgetSize
  backgroundMode: WidgetBackgroundMode
  skeletonId: WidgetSkeletonId
  body: string
}

function wrapCanvas({ size, backgroundMode, skeletonId, body }: CanvasOptions): string {
  return `<div class="widget-canvas" data-widget-skeleton="${skeletonId}" data-widget-size="${size}" data-widget-bg="${backgroundMode}">${body}</div>`
}

const RAMP_DEFAULT: WidgetRampId = 'indigo'

const INK = widgetVar('ink')
const INK2 = widgetVar('ink2')
const INK_BODY = widgetVar('inkBody')
const HAIR = widgetVar('hair')
const ACCENT = widgetVar('accent')
const MONO = "var(--widget-font-mono, ui-monospace, 'SF Mono', monospace)"

const singleFocusProps = z.object({
  title: z.string().optional(),
  /** 上标（mono 大写 + 橘点）：卡的身份行；抽屉字段表 path=kicker，schema 缺席会导致编辑被静默丢弃。 */
  kicker: z.string().optional(),
  body: z.string().min(1),
  facts: z.array(z.object({
    label: z.string().min(1),
    value: z.string().min(1),
  })).max(8).optional(),
  points: z.array(z.string().min(1)).max(8).optional(),
  attribution: z.string().optional(),
  /** 脚注（hairline 上缘 + mono 弱化）：来源/日期等元信息行。 */
  footer: z.string().optional(),
  ramp: rampSchema.default(RAMP_DEFAULT),
  decoration: z.enum(['none', 'quote_mark', 'left_bar', 'top_divider']).default('quote_mark'),
  alignment: z.enum(['left', 'center']).default('left'),
})

function compileSingleFocus(props: z.infer<typeof singleFocusProps>): string {
  return compileReadyInfoCard(props)
}

const dualCompareProps = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  divider_style: z.enum(['line', 'vs_badge', 'none']).default('vs_badge'),
  left: z.object({
    heading: z.string().min(1),
    items: z.array(z.string().min(1)).min(1).max(8),
    ramp: rampSchema.default('indigo'),
  }),
  right: z.object({
    heading: z.string().min(1),
    items: z.array(z.string().min(1)).min(1).max(8),
    ramp: rampSchema.default('rose'),
  }),
})

function renderCompareColumn(side: { heading: string; items: string[]; ramp: WidgetRampId }, position: 'left' | 'right', rule: string): string {
  const tone = resolveWidgetTone(side.ramp)
  const marker = tone === 'ok' ? widgetVar('ok') : tone === 'accent' ? ACCENT : INK
  return `<section data-compare-side="${position}" class="span-6 stack" style="position:relative;gap:12px;min-width:0;">
    ${rule}
    <div style="display:flex;align-items:center;gap:10px;">
      <span class="dot" style="width:6px;height:6px;background:${marker};"></span>
      <div style="font-size:15px;font-weight:600;line-height:22px;color:${INK};">${escapeHtml(side.heading)}</div>
    </div>
    ${renderWidgetDotList(side.items, { size: 13.5, gap: 8 })}
  </section>`
}

function compileDualCompare(props: z.infer<typeof dualCompareProps>): string {
  // 两栏对齐 12 栏网格的第 1、7 栏；分隔只用栏距中线上的一条竖 hairline（标题已写明对比，不再画 VS 徽章）。
  const rule = props.divider_style === 'none'
    ? ''
    : `<span aria-hidden="true" style="position:absolute;left:-12px;top:0;bottom:0;width:1px;background:${HAIR};"></span>`
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'COMPARE', meta: `${props.left.items.length} / ${props.right.items.length}` })}
    ${renderWidgetHeading(props.title, props.subtitle)}
    <div data-fill="grid" class="grid">
      ${renderCompareColumn(props.left, 'left', '')}
      ${renderCompareColumn(props.right, 'right', rule)}
    </div>
  </div>`
}

const metricSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
  unit: z.string().optional(),
  delta: z.string().optional(),
  delta_direction: z.enum(['up', 'down', 'flat']).optional(),
  ramp: rampSchema.optional(),
})

const metricGridProps = z.object({
  title: z.string().min(1),
  period: z.string().optional(),
  metrics: z.array(metricSchema).min(2).max(6),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
})

/** 指标在 12 栏里的跨度：≤4 项一行排开，5–6 项三列。 */
function metricSpan(count: number, columns?: number): number {
  const cols = columns ?? (count <= 4 ? count : 3)
  return 12 / Math.max(1, Math.min(4, cols))
}

function compileMetricGrid(props: z.infer<typeof metricGridProps>): string {
  const span = metricSpan(props.metrics.length, props.columns)
  // 指标面板：网格对齐 + 留白分组，不画格线与外框；数字按 Ready kpi-num 用 mono 500，
  // 只有被标记的指标点亮橘红；涨跌不猜好坏，统一墨色箭头。
  const cells = props.metrics.map((metric) => {
    const isHot = resolveWidgetTone(metric.ramp) === 'accent'
    const arrow = metric.delta_direction === 'up' ? '↑' : metric.delta_direction === 'down' ? '↓' : metric.delta_direction === 'flat' ? '→' : ''
    const deltaLine = metric.delta
      ? `<div class="num" style="margin-top:8px;font-size:11.5px;line-height:16px;letter-spacing:0.02em;color:${INK2};">${arrow ? `<span style="color:${isHot ? ACCENT : INK};margin-right:4px;">${arrow}</span>` : ''}${escapeHtml(metric.delta)}</div>`
      : ''
    return `<div data-metric class="span-${span}" style="min-width:0;">
      <div class="label" style="font-size:10px;">${escapeHtml(metric.label)}</div>
      <div class="num" style="margin-top:10px;font-size:34px;font-weight:500;letter-spacing:-0.02em;line-height:36px;color:${isHot ? ACCENT : INK};white-space:nowrap;">${escapeHtml(metric.value)}${metric.unit ? `<span style="font-size:13px;letter-spacing:0;margin-left:4px;color:${INK2};">${escapeHtml(metric.unit)}</span>` : ''}</div>
      ${deltaLine}
    </div>`
  }).join('')
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'METRICS', meta: props.period || `${props.metrics.length} 项` })}
    ${renderWidgetHeading(props.title)}
    <div data-fill="grid" class="grid keep-pairs" style="row-gap:28px;padding-top:4px;">${cells}</div>
  </div>`
}

const timelineEventSchema = z.object({
  time: z.string().min(1),
  heading: z.string().min(1),
  body: z.string().optional(),
  status: z.enum(['done', 'active', 'pending', 'blocked']).optional(),
  ramp: rampSchema.optional(),
})

const verticalTimelineProps = z.object({
  title: z.string().min(1),
  axis_label: z.string().optional(),
  events: z.array(timelineEventSchema).min(1).max(12),
  show_connector: z.boolean().default(true),
})

const TIMELINE_STATUS_LABEL: Record<string, string> = {
  active: '进行中',
  blocked: '受阻',
}

function timelineMarkerClass(status: string): string {
  if (status === 'active') return 'dot dot--active'
  if (status === 'done') return 'dot dot--done'
  if (status === 'blocked') return 'dot dot--blocked'
  return 'dot dot--pending'
}

function compileVerticalTimeline(props: z.infer<typeof verticalTimelineProps>): string {
  const doneCount = props.events.filter((event) => event.status === 'done').length
  // 时间落在标签栏（2 栏），节点与事件落在内容栏；导轨是内容栏左缘的一条 hairline。
  const rows = props.events.map((event, index) => {
    const status = event.status ?? 'pending'
    const isLast = index === props.events.length - 1
    const rail = props.show_connector && !isLast
      ? `<span aria-hidden="true" style="position:absolute;left:3.5px;top:16px;bottom:-26px;width:1px;background:${HAIR};"></span>`
      : ''
    const statusLabel = TIMELINE_STATUS_LABEL[status]
      ? `<span class="label" style="font-size:9.5px;margin-left:10px;color:${status === 'active' ? ACCENT : INK};">${TIMELINE_STATUS_LABEL[status]}</span>`
      : ''
    const body = event.body ? `<div style="margin-top:2px;font-size:13px;line-height:20px;color:${INK2};text-wrap:pretty;">${escapeRichText(event.body)}</div>` : ''
    return `<div data-timeline-event="${status}" class="num span-2" style="padding-top:3px;font-size:11.5px;line-height:16px;color:${status === 'pending' ? widgetVar('ink3') : INK2};white-space:nowrap;">${escapeHtml(event.time)}</div>
      <div class="span-10" style="position:relative;min-width:0;padding-left:24px;">
        <span class="${timelineMarkerClass(status)}" style="position:absolute;left:0;top:7px;width:8px;height:8px;"></span>
        ${rail}
        <div style="display:flex;align-items:baseline;flex-wrap:wrap;font-size:14.5px;font-weight:600;line-height:22px;color:${status === 'pending' ? INK_BODY : INK};">${escapeHtml(event.heading)}${statusLabel}</div>
        ${body}
      </div>`
  }).join('')
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'TIMELINE', meta: doneCount > 0 ? `${doneCount} / ${props.events.length} 完成` : `${props.events.length} 节点` })}
    ${renderWidgetHeading(props.title, props.axis_label)}
    <div data-fill="grid" class="grid" style="row-gap:24px;padding-top:4px;">${rows}</div>
  </div>`
}

const mediaRefSchema = z.object({
  kind: z.enum(['doc-attachment', 'url', 'live-asset']),
  id: z.string().min(1),
}).optional()

const photoNoteProps = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  hero: z.object({
    type: z.enum(['image', 'svg_illustration', 'emoji_block']),
    src: z.string().optional(),
    svg: z.string().optional(),
    emoji: z.string().optional(),
    aspect: z.string().optional(),
    mediaRef: mediaRefSchema,
  }),
  tags: z.array(z.string().min(1)).optional(),
  footer: z.string().optional(),
  ramp: rampSchema.default(RAMP_DEFAULT),
})

function compileHero(hero: z.infer<typeof photoNoteProps>['hero']): string {
  const aspect = hero.aspect || '4/3'
  const wellBg = widgetVar('canvas')
  if (hero.type === 'image' && hero.src) {
    return `<div style="aspect-ratio:${escapeAttr(aspect)};border-radius:12px;overflow:hidden;background:${wellBg};"><img src="${escapeAttr(hero.src)}" alt="" style="display:block;width:100%;height:100%;object-fit:cover;"/></div>`
  }
  if (hero.type === 'svg_illustration' && hero.svg) {
    return `<div style="aspect-ratio:${escapeAttr(aspect)};border-radius:12px;overflow:hidden;background:${wellBg};display:flex;align-items:center;justify-content:center;">${hero.svg}</div>`
  }
  if (hero.type === 'emoji_block') {
    return `<div data-ready-media-placeholder style="aspect-ratio:${escapeAttr(aspect)};border-radius:12px;background:radial-gradient(circle, ${widgetVar('dcRest')} 1.4px, transparent 1.9px) 0 0 / 12px 12px, ${wellBg};display:flex;align-items:center;justify-content:center;gap:9px;"><span class="dot dot--active"></span><span class="label">视觉占位</span></div>`
  }
  return `<div style="aspect-ratio:${escapeAttr(aspect)};border-radius:12px;background:${wellBg};border:1px dashed ${HAIR};"></div>`
}

function compilePhotoNote(props: z.infer<typeof photoNoteProps>): string {
  const hero = compileHero(props.hero)
  const tags = props.tags?.length
    ? `<div style="display:flex;gap:6px;flex-wrap:wrap;">${props.tags.map((tag) => `<span class="badge">#${escapeHtml(tag)}</span>`).join('')}</div>`
    : ''
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'NOTE', meta: props.tags?.length ? `${props.tags.length} 标签` : null })}
    <div data-fill="center">${hero}</div>
    ${renderWidgetHeading(props.title)}
    ${props.body ? `<div style="font-size:15px;line-height:26px;color:${INK_BODY};text-wrap:pretty;">${escapeRichText(props.body)}</div>` : ''}
    ${tags}
    ${renderWidgetFoot(props.footer)}
  </div>`
}

const chartDatumPartSchema = z.object({
  label: z.string().min(1),
  value: z.number(),
})

const chartDatumSchema = z.object({
  label: z.string().min(1),
  value: z.number(),
  x: z.number().optional(),
  parts: z.array(chartDatumPartSchema).min(1).max(6).optional(),
})

const chartFocusProps = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  chart: z.object({
    type: z.enum(['bar', 'hbar', 'line', 'pie', 'stacked_bar', 'scatter', 'waffle']),
    data: z.array(chartDatumSchema).min(1).max(20),
    ramp: rampSchema.default('sky'),
    unit: z.string().optional(),
    hot: z.number().int().min(0).optional(),
  }),
  insight: z.string().optional(),
  source_note: z.string().optional(),
})

function compileChartFocus(props: z.infer<typeof chartFocusProps>): string {
  const chartHtml = renderReadyChart({
    type: props.chart.type,
    data: props.chart.data,
    unitLabel: props.chart.unit,
    hot: props.chart.hot,
  })
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'DATA', meta: props.chart.unit ? `单位 · ${props.chart.unit}` : `${props.chart.data.length} 项` })}
    ${renderWidgetHeading(props.title, props.subtitle)}
    <div data-fill="center" class="stack" style="gap:8px;">${chartHtml}</div>
    ${props.insight ? renderChartInsight(props.insight) : ''}
    ${renderWidgetFoot(props.source_note ? `来源 · ${props.source_note}` : null)}
  </div>`
}

/** 结论行：标签栏放 mono INSIGHT（卡里唯一的橘红文字），内容栏放结论正文。 */
export function renderChartInsight(text: string): string {
  return `<div data-chart-insight>${renderWidgetLabelRow('INSIGHT', `<div style="font-size:14px;line-height:22px;color:${INK};text-wrap:pretty;">${escapeHtml(text)}</div>`, { labelColor: ACCENT })}</div>`
}

const gridItemSchema = z.object({
  label: z.string().optional(),
  icon: z.string().optional(),
  image: z.string().optional(),
  emoji: z.string().optional(),
  status: z.enum(['done', 'active', 'pending', 'highlight']).optional(),
  ramp: rampSchema.optional(),
  mediaRef: mediaRefSchema,
})

const gridCollectionProps = z.object({
  title: z.string().min(1),
  cols: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
  item_shape: z.enum(['square', 'portrait', 'free']).default('square'),
  items: z.array(gridItemSchema).min(2).max(20),
})

const GRID_STATUS_LABEL: Record<string, string> = {
  done: '完成',
  active: '进行中',
  highlight: '重点',
  pending: '未开始',
}

function gridStatusDotClass(status: string): string {
  if (status === 'done') return 'dot dot--done'
  if (status === 'active' || status === 'highlight') return 'dot dot--active'
  return 'dot dot--pending'
}

function renderGridItem(
  item: z.infer<typeof gridItemSchema>,
  shape: 'square' | 'portrait' | 'free',
  index: number,
  showStatus: boolean,
  span: number,
): string {
  const status = item.status ?? 'pending'
  const emphasized = showStatus && (status === 'active' || status === 'highlight')
  const lead = showStatus
    ? `<span class="${gridStatusDotClass(status)}" style="width:6px;height:6px;"></span>`
    : `<span class="num" style="font-size:10.5px;line-height:16px;color:${widgetVar('ink3')};">${String(index + 1).padStart(2, '0')}</span>`
  const statusText = showStatus && GRID_STATUS_LABEL[status]
    ? `<span class="label" style="margin-left:auto;font-size:9.5px;white-space:nowrap;color:${emphasized ? ACCENT : widgetVar('ink3')};">${GRID_STATUS_LABEL[status]}</span>`
    : ''
  const image = item.image
    ? `<div style="margin-bottom:12px;${shape === 'square' ? 'aspect-ratio:1/1;' : shape === 'portrait' ? 'aspect-ratio:3/4;' : 'aspect-ratio:4/3;'}border-radius:10px;overflow:hidden;background:${widgetVar('canvas')};"><img src="${escapeAttr(item.image)}" alt="" style="display:block;width:100%;height:100%;object-fit:cover;"/></div>`
    : ''
  // 清单条目：顶边一条 hairline 起头，点/序号 + 名称 + 状态在同一行，不做底板瓷砖。
  return `<div data-grid-item="${status}" class="span-${span}" style="min-width:0;padding-top:12px;border-top:1px solid ${HAIR};">
    ${image}
    <div style="display:flex;align-items:center;gap:10px;min-width:0;">
      ${lead}
      <span style="min-width:0;font-size:14px;font-weight:600;line-height:22px;color:${status === 'pending' && showStatus ? INK_BODY : INK};overflow-wrap:anywhere;">${escapeHtml(item.label || '')}</span>
      ${statusText}
    </div>
  </div>`
}

function compileGridCollection(props: z.infer<typeof gridCollectionProps>): string {
  const showStatus = props.items.some((item) => Boolean(item.status))
  const span = 12 / props.cols
  const cells = props.items.map((item, index) => renderGridItem(item, props.item_shape, index, showStatus, span)).join('')
  const doneCount = props.items.filter((item) => item.status === 'done').length
  return `<div class="card stack" style="gap:20px;">
    ${renderWidgetChrome({ kicker: 'COLLECTION', meta: doneCount > 0 ? `${doneCount} / ${props.items.length} 完成` : `${props.items.length} 项` })}
    ${renderWidgetHeading(props.title)}
    <div data-fill="grid" class="grid keep-pairs" style="row-gap:20px;">${cells}</div>
  </div>`
}

const relationMapProps = relationshipGraphPropsSchema.extend({
  title: z.string().optional(),
})

function compileRelationMap(props: z.infer<typeof relationMapProps>): string {
  const { title, ...graphProps } = props
  return compileRelationshipGraph({
    ...graphProps,
    heading: props.heading ?? title,
  })
}

const processFlowSkeletonProps = processFlowPropsSchema.extend({
  title: z.string().optional(),
})

function compileProcessFlowSkeleton(props: z.infer<typeof processFlowSkeletonProps>): string {
  const { title, ...flowProps } = props
  return compileProcessFlow({
    ...flowProps,
    heading: props.heading ?? title,
  })
}

const freeformAspectSchema = z.enum(['1:1', '9:16', '16:9', '4:5', '4:3', 'a4'])

const freeformStaticProps = z.object({
  title: z.string().optional(),
  widget_code: z.string().min(1),
  aspect_ratio: freeformAspectSchema,
})

function compileFreeformStatic(props: z.infer<typeof freeformStaticProps>): string {
  return props.widget_code
}

const freeformInteractiveProps = z.object({
  title: z.string().optional(),
  widget_code: z.string().min(1),
  aspect_ratio: freeformAspectSchema,
  supports_animation: z.literal(true),
})

function compileFreeformInteractive(props: z.infer<typeof freeformInteractiveProps>): string {
  return props.widget_code
}

export interface WidgetSkeletonDefinition {
  id: WidgetSkeletonId
  displayName: string
  description: string
  defaultSize: WidgetSize
  allowedSizes: readonly WidgetSize[]
  defaultBackgroundMode: WidgetBackgroundMode
  supportsAnimation: boolean
  triggerKeywords: readonly string[]
  propsSchema: z.ZodTypeAny
  compile: (props: unknown) => string
}

function defineSkeleton<S extends z.ZodTypeAny>(def: {
  id: WidgetSkeletonId
  displayName: string
  description: string
  defaultSize: WidgetSize
  allowedSizes: readonly WidgetSize[]
  defaultBackgroundMode: WidgetBackgroundMode
  supportsAnimation: boolean
  triggerKeywords?: readonly string[]
  propsSchema: S
  compile: (props: z.infer<S>) => string
}): WidgetSkeletonDefinition {
  return {
    ...def,
    triggerKeywords: def.triggerKeywords ?? [],
    propsSchema: def.propsSchema,
    compile: (props: unknown) => def.compile(def.propsSchema.parse(props) as z.infer<S>),
  }
}

export const WIDGET_SKELETONS: Record<WidgetSkeletonId, WidgetSkeletonDefinition> = {
  single_focus: defineSkeleton({
    id: 'single_focus',
    displayName: '单焦长卡',
    description: '一段引语 / 摘录 / 金句 / 长文，单视觉焦点',
    defaultSize: 'doc_block',
    allowedSizes: ['square_card', 'portrait_card', 'story_card', 'doc_block'],
    defaultBackgroundMode: 'opaque',
    supportsAnimation: false,
    propsSchema: singleFocusProps,
    compile: compileSingleFocus,
  }),
  dual_compare: defineSkeleton({
    id: 'dual_compare',
    displayName: '双栏对比',
    description: '左右两栏对照，A vs B / 前后 / 优缺点',
    defaultSize: 'doc_block',
    allowedSizes: ['landscape_card', 'landscape_4_3', 'square_card', 'a4_portrait', 'doc_block'],
    defaultBackgroundMode: 'opaque',
    supportsAnimation: false,
    propsSchema: dualCompareProps,
    compile: compileDualCompare,
  }),
  metric_grid: defineSkeleton({
    id: 'metric_grid',
    displayName: '多栏数据板',
    description: '2–6 个 KPI 网格 + 标签 + 趋势',
    defaultSize: 'doc_block',
    allowedSizes: ['landscape_card', 'landscape_4_3', 'square_card', 'portrait_card', 'a4_portrait', 'doc_block'],
    defaultBackgroundMode: 'opaque',
    supportsAnimation: false,
    propsSchema: metricGridProps,
    compile: compileMetricGrid,
  }),
  vertical_timeline: defineSkeleton({
    id: 'vertical_timeline',
    displayName: '垂直时间线',
    description: '日报 / 行程 / 里程碑',
    defaultSize: 'doc_block',
    allowedSizes: ['portrait_card', 'square_card', 'story_card', 'a4_portrait', 'doc_block'],
    defaultBackgroundMode: 'opaque',
    supportsAnimation: false,
    propsSchema: verticalTimelineProps,
    compile: compileVerticalTimeline,
  }),
  photo_note: defineSkeleton({
    id: 'photo_note',
    displayName: '图文笔记',
    description: '主视觉 + 标题 + 正文 + 标签',
    defaultSize: 'doc_block',
    allowedSizes: ['portrait_card', 'story_card', 'square_card', 'doc_block'],
    defaultBackgroundMode: 'opaque',
    supportsAnimation: false,
    propsSchema: photoNoteProps,
    compile: compilePhotoNote,
  }),
  chart_focus: defineSkeleton({
    id: 'chart_focus',
    displayName: '单图表聚焦',
    description: '一张图说明一个趋势 / 分布 / 占比 / 相关性（点阵图表：bar/hbar/line/scatter/stacked_bar/waffle；pie 输入自动转合规占比形态）',
    defaultSize: 'doc_block',
    allowedSizes: ['landscape_card', 'landscape_4_3', 'square_card', 'a4_portrait', 'doc_block'],
    defaultBackgroundMode: 'opaque',
    supportsAnimation: false,
    propsSchema: chartFocusProps,
    compile: compileChartFocus,
  }),
  grid_collection: defineSkeleton({
    id: 'grid_collection',
    displayName: '网格拼贴',
    description: '清单 / 习惯 / 推荐墙 / 九宫格',
    defaultSize: 'doc_block',
    allowedSizes: ['square_card', 'portrait_card', 'a4_portrait', 'doc_block'],
    defaultBackgroundMode: 'opaque',
    supportsAnimation: false,
    propsSchema: gridCollectionProps,
    compile: compileGridCollection,
  }),
  relation_map: defineSkeleton({
    id: 'relation_map',
    displayName: '关系图谱',
    description: '人物 / 组织 / 概念关系网络：分组卡片 + 自动连线 + 图例，只给 groups/nodes/edges 不给坐标',
    defaultSize: 'doc_block',
    allowedSizes: ['landscape_4_3', 'landscape_card', 'square_card', 'a4_portrait', 'doc_block'],
    defaultBackgroundMode: 'opaque',
    supportsAnimation: false,
    propsSchema: relationMapProps,
    compile: compileRelationMap,
  }),
  process_flow: defineSkeleton({
    id: 'process_flow',
    displayName: '流程说明图',
    description: '步骤 / 科普流程 / 因果链：编号步骤 + 可选分支 chips + 可选结果卡',
    defaultSize: 'doc_block',
    allowedSizes: ['portrait_card', 'story_card', 'square_card', 'a4_portrait', 'landscape_4_3', 'doc_block'],
    defaultBackgroundMode: 'opaque',
    supportsAnimation: false,
    propsSchema: processFlowSkeletonProps,
    compile: compileProcessFlowSkeleton,
  }),
  freeform_static: defineSkeleton({
    id: 'freeform_static',
    displayName: '自由构图（静态）',
    description: '关键词触发：兜底自由构图，仅静态 HTML/SVG',
    defaultSize: 'square_card',
    allowedSizes: WIDGET_SIZE_IDS,
    defaultBackgroundMode: 'opaque',
    supportsAnimation: false,
    triggerKeywords: ['做一个超特殊卡片', '超特殊卡片'],
    propsSchema: freeformStaticProps,
    compile: compileFreeformStatic,
  }),
  freeform_interactive: defineSkeleton({
    id: 'freeform_interactive',
    displayName: '自由构图（交互）',
    description: '关键词触发：含交互 / 动画的自由构图',
    defaultSize: 'square_card',
    allowedSizes: WIDGET_SIZE_IDS,
    defaultBackgroundMode: 'opaque',
    supportsAnimation: true,
    triggerKeywords: ['交互式信息卡', '交互式数据图'],
    propsSchema: freeformInteractiveProps,
    compile: compileFreeformInteractive,
  }),
}

export interface WidgetSkeletonSpec {
  skeleton: WidgetSkeletonId | string
  size?: WidgetSize
  background_mode?: WidgetBackgroundMode
  props?: Record<string, unknown>
}

export interface CompiledWidgetSkeleton {
  skeleton: WidgetSkeletonId
  size: WidgetSize
  backgroundMode: WidgetBackgroundMode
  widgetCode: string
}

export interface CompileWidgetSkeletonOptions {
  size?: WidgetSize
  backgroundMode?: WidgetBackgroundMode
}

export function isKnownWidgetSkeleton(id: string): id is WidgetSkeletonId {
  return Object.prototype.hasOwnProperty.call(WIDGET_SKELETONS, id)
}

export function getWidgetSkeleton(id: string): WidgetSkeletonDefinition | null {
  return isKnownWidgetSkeleton(id) ? WIDGET_SKELETONS[id] : null
}

function resolveSize(skeleton: WidgetSkeletonDefinition, requested?: WidgetSize): WidgetSize {
  if (requested && skeleton.allowedSizes.includes(requested)) return requested
  return skeleton.defaultSize
}

function resolveBackgroundMode(
  skeleton: WidgetSkeletonDefinition,
  requested?: WidgetBackgroundMode,
): WidgetBackgroundMode {
  if (requested === 'opaque' || requested === 'transparent') return requested
  return skeleton.defaultBackgroundMode
}

export function compileWidgetSkeletonSpec(
  spec: WidgetSkeletonSpec,
  options?: CompileWidgetSkeletonOptions,
): CompiledWidgetSkeleton {
  const skeleton = getWidgetSkeleton(spec.skeleton)
  if (!skeleton) {
    throw new Error(`Unknown widget skeleton: ${spec.skeleton}`)
  }
  const size = resolveSize(skeleton, options?.size ?? spec.size)
  const backgroundMode = resolveBackgroundMode(
    skeleton,
    options?.backgroundMode ?? spec.background_mode,
  )
  const body = skeleton.compile(spec.props ?? {})
  const widgetCode = wrapCanvas({
    size,
    backgroundMode,
    skeletonId: skeleton.id,
    body,
  })
  return { skeleton: skeleton.id, size, backgroundMode, widgetCode }
}

export function widgetSkeletonRequiresTriggerKeyword(id: WidgetSkeletonId): boolean {
  return WIDGET_SKELETONS[id].triggerKeywords.length > 0
}

export function findSkeletonForTriggerKeyword(text: string): WidgetSkeletonId | null {
  if (!text) return null
  for (const id of WIDGET_SKELETON_IDS) {
    const skeleton = WIDGET_SKELETONS[id]
    if (skeleton.triggerKeywords.length === 0) continue
    if (skeleton.triggerKeywords.some((kw) => text.includes(kw))) return id
  }
  return null
}

const FREEFORM_INTERACTIVE_FALLBACK: WidgetSkeletonId = 'chart_focus'
const FREEFORM_STATIC_FALLBACK: WidgetSkeletonId = 'single_focus'

export interface SkeletonArbitrationResult {
  skeleton: WidgetSkeletonId
  downgraded: boolean
  reason: 'ok' | 'trigger_keyword_missing' | 'unknown_skeleton'
}

export function arbitrateSkeletonForUserText(
  rawSkeleton: string,
  userText: string,
): SkeletonArbitrationResult {
  if (!isKnownWidgetSkeleton(rawSkeleton)) {
    return { skeleton: FREEFORM_STATIC_FALLBACK, downgraded: true, reason: 'unknown_skeleton' }
  }
  const id = rawSkeleton as WidgetSkeletonId
  if (!widgetSkeletonRequiresTriggerKeyword(id)) {
    return { skeleton: id, downgraded: false, reason: 'ok' }
  }
  const matched = findSkeletonForTriggerKeyword(userText || '')
  if (matched === id) {
    return { skeleton: id, downgraded: false, reason: 'ok' }
  }
  const fallback: WidgetSkeletonId = id === 'freeform_interactive'
    ? FREEFORM_INTERACTIVE_FALLBACK
    : FREEFORM_STATIC_FALLBACK
  return { skeleton: fallback, downgraded: true, reason: 'trigger_keyword_missing' }
}
