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
  resolveWidgetToneStyle,
  widgetStatusDotColor,
  widgetVar,
} from './document-widget-theme'
import { compileReadyInfoCard } from './document-widget-info-card'

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
const CARD = widgetVar('card')
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

function renderCompareColumn(side: { heading: string; items: string[]; ramp: WidgetRampId }): string {
  const tone = resolveWidgetToneStyle(side.ramp)
  const items = side.items.map((item) => `<li style="margin:6px 0;color:${INK_BODY};">${escapeHtml(item)}</li>`).join('')
  return `<div class="stack" style="gap:10px;padding:16px;border-radius:12px;background:${tone.surface};border:1px solid ${tone.border};">
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="width:8px;height:8px;border-radius:50%;background:${tone.marker};flex:none;"></span>
      <div style="font-weight:600;color:${tone.title};">${escapeHtml(side.heading)}</div>
    </div>
    <ul style="margin:0;padding-left:18px;">${items}</ul>
  </div>`
}

function compileDualCompare(props: z.infer<typeof dualCompareProps>): string {
  const divider = props.divider_style === 'vs_badge'
    ? `<div class="badge" style="align-self:center;background:${INK};color:${CARD};border-color:transparent;">VS</div>`
    : props.divider_style === 'line'
      ? `<div style="align-self:stretch;width:1px;background:${widgetVar('hairV')};"></div>`
      : ''
  return `<div class="card stack" style="gap:18px;">
    <div class="stack" style="gap:6px;">
      <div class="title">${escapeHtml(props.title)}</div>
      ${props.subtitle ? `<div class="subtitle">${escapeHtml(props.subtitle)}</div>` : ''}
    </div>
    <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:14px;align-items:stretch;">
      ${renderCompareColumn(props.left)}
      ${divider}
      ${renderCompareColumn(props.right)}
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

function compileMetricGrid(props: z.infer<typeof metricGridProps>): string {
  const cols = props.columns ?? (props.metrics.length <= 2 ? 2 : props.metrics.length <= 4 ? 2 : 3)
  const cells = props.metrics.map((metric) => {
    const tone = resolveWidgetToneStyle(metric.ramp)
    const isHot = resolveWidgetTone(metric.ramp) === 'accent'
    const arrow = metric.delta_direction === 'up' ? '↑' : metric.delta_direction === 'down' ? '↓' : metric.delta_direction === 'flat' ? '→' : ''
    const deltaColor = metric.delta_direction === 'up' ? widgetVar('ok') : INK2
    const deltaLine = metric.delta
      ? `<div class="num" style="font-size:12px;color:${deltaColor};">${arrow ? `${arrow} ` : ''}${escapeHtml(metric.delta)}</div>`
      : ''
    return `<div class="stack" style="gap:6px;padding:14px;border-radius:12px;background:${tone.surface};border:1px solid ${tone.border};">
      <div class="label" style="font-size:10px;">${escapeHtml(metric.label)}</div>
      <div class="num" style="font-size:32px;font-weight:600;color:${isHot ? ACCENT : INK};line-height:1;">${escapeHtml(metric.value)}${metric.unit ? `<span style="font-size:14px;font-weight:500;margin-left:4px;color:${INK2};">${escapeHtml(metric.unit)}</span>` : ''}</div>
      ${deltaLine}
    </div>`
  }).join('')
  return `<div class="card stack" style="gap:16px;">
    <div class="stack" style="gap:4px;">
      <div class="title">${escapeHtml(props.title)}</div>
      ${props.period ? `<div class="subtitle">${escapeHtml(props.period)}</div>` : ''}
    </div>
    <div style="display:grid;grid-template-columns:repeat(${cols}, minmax(0,1fr));gap:12px;">${cells}</div>
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

function compileVerticalTimeline(props: z.infer<typeof verticalTimelineProps>): string {
  const items = props.events.map((event, index) => {
    const dotColor = widgetStatusDotColor(event.status ?? 'pending')
    const isLast = index === props.events.length - 1
    const connector = props.show_connector && !isLast
      ? `<div style="position:absolute;left:6px;top:18px;bottom:-12px;width:1px;background:${HAIR};"></div>`
      : ''
    const body = event.body ? `<div class="subtitle" style="margin-top:4px;">${escapeRichText(event.body)}</div>` : ''
    return `<div style="position:relative;padding-left:28px;padding-bottom:${isLast ? '0' : '12px'};">
      ${connector}
      <div style="position:absolute;left:0;top:4px;width:13px;height:13px;border-radius:50%;background:${dotColor};border:2px solid ${CARD};"></div>
      <div class="num" style="font-size:12px;color:${INK2};">${escapeHtml(event.time)}</div>
      <div style="font-weight:600;color:${INK};">${escapeHtml(event.heading)}</div>
      ${body}
    </div>`
  }).join('')
  return `<div class="card stack" style="gap:14px;">
    <div class="stack" style="gap:4px;">
      <div class="title">${escapeHtml(props.title)}</div>
      ${props.axis_label ? `<div class="subtitle">${escapeHtml(props.axis_label)}</div>` : ''}
    </div>
    <div>${items}</div>
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
    return `<div style="aspect-ratio:${escapeAttr(aspect)};border-radius:18px;overflow:hidden;background:${wellBg};"><img src="${escapeAttr(hero.src)}" alt="" style="display:block;width:100%;height:100%;object-fit:cover;"/></div>`
  }
  if (hero.type === 'svg_illustration' && hero.svg) {
    return `<div style="aspect-ratio:${escapeAttr(aspect)};border-radius:18px;overflow:hidden;background:${wellBg};display:flex;align-items:center;justify-content:center;">${hero.svg}</div>`
  }
  if (hero.type === 'emoji_block') {
    return `<div data-ready-media-placeholder style="aspect-ratio:${escapeAttr(aspect)};border-radius:18px;background:${wellBg};display:flex;align-items:center;justify-content:center;gap:9px;"><span class="dot dot--active"></span><span class="label">视觉占位</span></div>`
  }
  return `<div style="aspect-ratio:${escapeAttr(aspect)};border-radius:18px;background:${wellBg};border:1px dashed ${HAIR};"></div>`
}

function compilePhotoNote(props: z.infer<typeof photoNoteProps>): string {
  const hero = compileHero(props.hero)
  const tags = props.tags?.length
    ? `<div style="display:flex;gap:6px;flex-wrap:wrap;">${props.tags.map((tag) => `<span class="badge">#${escapeHtml(tag)}</span>`).join('')}</div>`
    : ''
  return `<div class="card stack" style="gap:14px;">
    ${hero}
    <div class="title">${escapeHtml(props.title)}</div>
    ${props.body ? `<div style="font-size:15px;line-height:1.7;color:${INK_BODY};">${escapeRichText(props.body)}</div>` : ''}
    ${tags}
    ${props.footer ? `<div class="muted" style="font-size:12px;">${escapeHtml(props.footer)}</div>` : ''}
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
  return `<div class="card stack" style="gap:16px;">
    <div class="stack" style="gap:4px;">
      <div class="title">${escapeHtml(props.title)}</div>
      ${props.subtitle ? `<div class="subtitle">${escapeHtml(props.subtitle)}</div>` : ''}
    </div>
    <div class="stack" style="gap:8px;">${chartHtml}</div>
    ${props.insight ? `<div style="display:flex;gap:8px;align-items:baseline;"><span class="label" style="color:${ACCENT};">INSIGHT</span><span style="font-size:13px;color:${INK_BODY};">${escapeHtml(props.insight)}</span></div>` : ''}
    ${props.source_note ? `<div class="label" style="font-size:10px;">来源 · ${escapeHtml(props.source_note)}</div>` : ''}
  </div>`
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

function renderGridItem(item: z.infer<typeof gridItemSchema>, shape: 'square' | 'portrait' | 'free'): string {
  const tone = resolveWidgetToneStyle(item.ramp)
  const aspect = shape === 'square' ? '1/1' : shape === 'portrait' ? '3/4' : 'auto'
  const visual = item.image
    ? `<img src="${escapeAttr(item.image)}" alt="" style="display:block;width:100%;height:100%;object-fit:cover;"/>`
    : `<div style="width:14px;height:14px;border-radius:50%;background:${widgetStatusDotColor(item.status ?? 'pending')};"></div>`
  const statusBorder = item.status === 'done'
    ? widgetVar('ok')
    : item.status === 'active' || item.status === 'highlight'
      ? ACCENT
      : tone.border
  return `<div class="stack" style="gap:6px;align-items:center;justify-content:center;text-align:center;padding:12px;border-radius:12px;background:${tone.surface};border:1px solid ${statusBorder};${aspect !== 'auto' ? `aspect-ratio:${aspect};` : ''}">
    <div style="display:flex;align-items:center;justify-content:center;flex:1;${item.image ? 'width:100%;height:100%;border-radius:8px;overflow:hidden;' : ''}">${visual}</div>
    ${item.label ? `<div style="font-size:12px;color:${INK};font-weight:600;">${escapeHtml(item.label)}</div>` : ''}
  </div>`
}

function compileGridCollection(props: z.infer<typeof gridCollectionProps>): string {
  const cells = props.items.map((item) => renderGridItem(item, props.item_shape)).join('')
  return `<div class="card stack" style="gap:14px;">
    <div class="title">${escapeHtml(props.title)}</div>
    <div style="display:grid;grid-template-columns:repeat(${props.cols}, minmax(0,1fr));gap:10px;">${cells}</div>
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
    defaultSize: 'landscape_card',
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
    defaultSize: 'landscape_card',
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
    defaultSize: 'portrait_card',
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
    defaultSize: 'portrait_card',
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
    defaultSize: 'landscape_card',
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
    defaultSize: 'square_card',
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
    defaultSize: 'landscape_4_3',
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
    defaultSize: 'portrait_card',
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
