import { z } from 'zod'

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
  'freeform_static',
  'freeform_interactive',
]

export const RAMP_IDS = ['indigo', 'emerald', 'amber', 'slate', 'rose', 'sky'] as const
export type WidgetRampId = (typeof RAMP_IDS)[number]

interface RampTier {
  bg: string
  border: string
  accent: string
  sub: string
  title: string
}

export const WIDGET_RAMPS: Record<WidgetRampId, RampTier> = {
  indigo:  { bg: '#EEF2FF', border: '#C7D2FE', accent: '#818CF8', sub: '#4F46E5', title: '#3730A3' },
  emerald: { bg: '#ECFDF5', border: '#A7F3D0', accent: '#34D399', sub: '#059669', title: '#065F46' },
  amber:   { bg: '#FFFBEB', border: '#FDE68A', accent: '#FBBF24', sub: '#D97706', title: '#92400E' },
  slate:   { bg: '#F8FAFC', border: '#E2E8F0', accent: '#94A3B8', sub: '#64748B', title: '#334155' },
  rose:    { bg: '#FFF1F2', border: '#FECDD3', accent: '#FB7185', sub: '#E11D48', title: '#9F1239' },
  sky:     { bg: '#F0F9FF', border: '#BAE6FD', accent: '#38BDF8', sub: '#0284C7', title: '#075985' },
}

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

function ramp(id: WidgetRampId): RampTier {
  return WIDGET_RAMPS[id] ?? WIDGET_RAMPS.indigo
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

const singleFocusProps = z.object({
  title: z.string().optional(),
  body: z.string().min(1),
  attribution: z.string().optional(),
  ramp: rampSchema.default(RAMP_DEFAULT),
  decoration: z.enum(['none', 'quote_mark', 'left_bar', 'top_divider']).default('quote_mark'),
  alignment: z.enum(['left', 'center']).default('left'),
})

function compileSingleFocus(props: z.infer<typeof singleFocusProps>): string {
  const r = ramp(props.ramp)
  const align = props.alignment === 'center' ? 'center' : 'left'
  const decoration = props.decoration === 'quote_mark'
    ? `<div style="font-size:48px;line-height:1;color:${r.accent};font-weight:700;">"</div>`
    : props.decoration === 'left_bar'
      ? `<div style="position:absolute;left:0;top:0;bottom:0;width:4px;background:${r.accent};border-radius:4px;"></div>`
      : props.decoration === 'top_divider'
        ? `<div style="height:3px;width:48px;background:${r.accent};border-radius:3px;"></div>`
        : ''
  const attribution = props.attribution
    ? `<div class="muted" style="margin-top:12px;font-size:13px;">— ${escapeHtml(props.attribution)}</div>`
    : ''
  const title = props.title
    ? `<div class="title" style="color:${r.title};">${escapeHtml(props.title)}</div>`
    : ''
  const padLeft = props.decoration === 'left_bar' ? 'padding-left:20px;' : ''
  return `<div class="card stack" style="position:relative;text-align:${align};gap:14px;${padLeft}">
    ${decoration}
    ${title}
    <div class="subtitle" style="font-size:16px;line-height:1.6;color:var(--widget-text-secondary);">${escapeRichText(props.body)}</div>
    ${attribution}
  </div>`
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
  const r = ramp(side.ramp)
  const items = side.items.map((item) => `<li style="margin:6px 0;color:var(--widget-text-secondary);">${escapeHtml(item)}</li>`).join('')
  return `<div class="stack" style="gap:10px;padding:16px;border-radius:12px;background:${r.bg};border:1px solid ${r.border};">
    <div style="font-weight:700;color:${r.title};">${escapeHtml(side.heading)}</div>
    <ul style="margin:0;padding-left:18px;">${items}</ul>
  </div>`
}

function compileDualCompare(props: z.infer<typeof dualCompareProps>): string {
  const divider = props.divider_style === 'vs_badge'
    ? `<div class="badge" style="align-self:center;background:#0f172a;color:#ffffff;">VS</div>`
    : props.divider_style === 'line'
      ? `<div style="align-self:stretch;width:1px;background:var(--widget-border);"></div>`
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
    const r = ramp(metric.ramp ?? RAMP_DEFAULT)
    const arrow = metric.delta_direction === 'up' ? '↑' : metric.delta_direction === 'down' ? '↓' : metric.delta_direction === 'flat' ? '→' : ''
    const deltaLine = metric.delta
      ? `<div style="font-size:12px;color:${r.sub};">${arrow ? `${arrow} ` : ''}${escapeHtml(metric.delta)}</div>`
      : ''
    return `<div class="stack" style="gap:6px;padding:14px;border-radius:12px;background:${r.bg};border:1px solid ${r.border};">
      <div style="font-size:12px;color:var(--widget-text-muted);">${escapeHtml(metric.label)}</div>
      <div style="font-size:32px;font-weight:700;color:${r.title};line-height:1;font-family:'JetBrains Mono','SF Mono',monospace;">${escapeHtml(metric.value)}${metric.unit ? `<span style="font-size:14px;font-weight:600;margin-left:4px;color:${r.sub};">${escapeHtml(metric.unit)}</span>` : ''}</div>
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
    const r = ramp(event.ramp ?? RAMP_DEFAULT)
    const dotColor = event.status === 'done'
      ? r.accent
      : event.status === 'blocked'
        ? '#E11D48'
        : event.status === 'pending'
          ? '#94A3B8'
          : r.sub
    const isLast = index === props.events.length - 1
    const connector = props.show_connector && !isLast
      ? `<div style="position:absolute;left:7px;top:18px;bottom:-12px;width:2px;background:${r.border};"></div>`
      : ''
    const body = event.body ? `<div class="subtitle" style="margin-top:4px;">${escapeRichText(event.body)}</div>` : ''
    return `<div style="position:relative;padding-left:28px;padding-bottom:${isLast ? '0' : '12px'};">
      ${connector}
      <div style="position:absolute;left:0;top:4px;width:14px;height:14px;border-radius:999px;background:${dotColor};border:2px solid var(--widget-bg-primary);"></div>
      <div style="font-size:12px;color:var(--widget-text-muted);font-family:'JetBrains Mono','SF Mono',monospace;">${escapeHtml(event.time)}</div>
      <div style="font-weight:600;color:var(--widget-text-primary);">${escapeHtml(event.heading)}</div>
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

function compileHero(hero: z.infer<typeof photoNoteProps>['hero'], r: RampTier): string {
  const aspect = hero.aspect || '4/3'
  if (hero.type === 'image' && hero.src) {
    return `<div style="aspect-ratio:${escapeAttr(aspect)};border-radius:12px;overflow:hidden;background:${r.bg};"><img src="${escapeAttr(hero.src)}" alt="" style="display:block;width:100%;height:100%;object-fit:cover;"/></div>`
  }
  if (hero.type === 'svg_illustration' && hero.svg) {
    return `<div style="aspect-ratio:${escapeAttr(aspect)};border-radius:12px;overflow:hidden;background:${r.bg};display:flex;align-items:center;justify-content:center;">${hero.svg}</div>`
  }
  if (hero.type === 'emoji_block' && hero.emoji) {
    return `<div style="aspect-ratio:${escapeAttr(aspect)};border-radius:12px;background:${r.bg};display:flex;align-items:center;justify-content:center;font-size:96px;line-height:1;">${escapeHtml(hero.emoji)}</div>`
  }
  return `<div style="aspect-ratio:${escapeAttr(aspect)};border-radius:12px;background:${r.bg};border:1px dashed ${r.border};"></div>`
}

function compilePhotoNote(props: z.infer<typeof photoNoteProps>): string {
  const r = ramp(props.ramp)
  const hero = compileHero(props.hero, r)
  const tags = props.tags?.length
    ? `<div style="display:flex;gap:6px;flex-wrap:wrap;">${props.tags.map((tag) => `<span class="badge" style="background:${r.bg};color:${r.sub};">#${escapeHtml(tag)}</span>`).join('')}</div>`
    : ''
  return `<div class="card stack" style="gap:14px;">
    ${hero}
    <div class="title" style="color:${r.title};">${escapeHtml(props.title)}</div>
    ${props.body ? `<div class="subtitle" style="font-size:15px;">${escapeRichText(props.body)}</div>` : ''}
    ${tags}
    ${props.footer ? `<div class="muted" style="font-size:12px;">${escapeHtml(props.footer)}</div>` : ''}
  </div>`
}

const chartDatumSchema = z.object({
  label: z.string().min(1),
  value: z.number(),
})

const chartFocusProps = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  chart: z.object({
    type: z.enum(['bar', 'line', 'pie', 'stacked_bar', 'scatter']),
    data: z.array(chartDatumSchema).min(1).max(20),
    ramp: rampSchema.default('sky'),
  }),
  insight: z.string().optional(),
  source_note: z.string().optional(),
})

function compileBarChart(data: { label: string; value: number }[], r: RampTier): string {
  const max = Math.max(...data.map((d) => d.value), 1)
  return data.map((d) => {
    const w = Math.max(8, (d.value / max) * 100)
    return `<div class="stack" style="gap:4px;">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--widget-text-muted);"><span>${escapeHtml(d.label)}</span><span style="color:${r.sub};font-weight:600;">${d.value}</span></div>
      <div style="height:10px;border-radius:6px;background:${r.bg};overflow:hidden;"><div style="height:100%;width:${w}%;background:${r.accent};border-radius:6px;"></div></div>
    </div>`
  }).join('')
}

function compileLineChart(data: { label: string; value: number }[], r: RampTier): string {
  if (data.length < 2) return compileBarChart(data, r)
  const w = 640
  const h = 200
  const max = Math.max(...data.map((d) => d.value), 1)
  const min = Math.min(...data.map((d) => d.value), 0)
  const range = max - min || 1
  const stepX = (w - 80) / (data.length - 1)
  const points = data.map((d, i) => ({
    x: 40 + i * stepX,
    y: h - 40 - ((d.value - min) / range) * (h - 80),
    d,
  }))
  const polyline = points.map((p) => `${p.x},${p.y}`).join(' ')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;">
    <polyline fill="none" stroke="${r.accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${polyline}"/>
    ${points.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="4" fill="${r.sub}"/>`).join('')}
    ${points.map((p) => `<text x="${p.x}" y="${h - 12}" text-anchor="middle" font-size="11" fill="#94A3B8">${escapeHtml(p.d.label)}</text>`).join('')}
  </svg>`
}

function compilePieChart(data: { label: string; value: number }[], r: RampTier): string {
  const total = data.reduce((acc, d) => acc + d.value, 0) || 1
  const cx = 90
  const cy = 90
  const radius = 72
  let cursor = -Math.PI / 2
  const palette = [r.accent, r.sub, r.title, r.border, '#94A3B8', '#475569']
  const slices = data.map((d, i) => {
    const angle = (d.value / total) * Math.PI * 2
    const x1 = cx + radius * Math.cos(cursor)
    const y1 = cy + radius * Math.sin(cursor)
    cursor += angle
    const x2 = cx + radius * Math.cos(cursor)
    const y2 = cy + radius * Math.sin(cursor)
    const largeArc = angle > Math.PI ? 1 : 0
    const color = palette[i % palette.length]
    return `<path d="M${cx},${cy} L${x1},${y1} A${radius},${radius} 0 ${largeArc} 1 ${x2},${y2} Z" fill="${color}"/>`
  }).join('')
  const legend = data.map((d, i) => `<div style="display:flex;align-items:center;gap:6px;font-size:12px;"><span style="width:10px;height:10px;border-radius:2px;background:${palette[i % palette.length]}"></span>${escapeHtml(d.label)} <span style="color:var(--widget-text-muted);margin-left:auto;">${Math.round((d.value / total) * 100)}%</span></div>`).join('')
  return `<div style="display:grid;grid-template-columns:180px 1fr;gap:16px;align-items:center;">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" style="width:180px;height:180px;">${slices}</svg>
    <div class="stack" style="gap:6px;">${legend}</div>
  </div>`
}

function compileChartFocus(props: z.infer<typeof chartFocusProps>): string {
  const r = ramp(props.chart.ramp)
  const chartHtml = props.chart.type === 'line'
    ? compileLineChart(props.chart.data, r)
    : props.chart.type === 'pie'
      ? compilePieChart(props.chart.data, r)
      : compileBarChart(props.chart.data, r)
  return `<div class="card stack" style="gap:16px;">
    <div class="stack" style="gap:4px;">
      <div class="title">${escapeHtml(props.title)}</div>
      ${props.subtitle ? `<div class="subtitle">${escapeHtml(props.subtitle)}</div>` : ''}
    </div>
    <div class="stack" style="gap:8px;">${chartHtml}</div>
    ${props.insight ? `<div class="subtitle" style="font-size:14px;color:${r.sub};">💡 ${escapeHtml(props.insight)}</div>` : ''}
    ${props.source_note ? `<div class="muted" style="font-size:11px;">来源：${escapeHtml(props.source_note)}</div>` : ''}
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
  const r = ramp(item.ramp ?? RAMP_DEFAULT)
  const aspect = shape === 'square' ? '1/1' : shape === 'portrait' ? '3/4' : 'auto'
  const visual = item.image
    ? `<img src="${escapeAttr(item.image)}" alt="" style="display:block;width:100%;height:100%;object-fit:cover;"/>`
    : item.emoji
      ? `<div style="font-size:36px;line-height:1;">${escapeHtml(item.emoji)}</div>`
      : item.icon
        ? `<div style="font-size:24px;color:${r.sub};">${escapeHtml(item.icon)}</div>`
        : `<div style="width:24px;height:24px;border-radius:6px;background:${r.accent};"></div>`
  const statusBorder = item.status === 'done'
    ? r.accent
    : item.status === 'active'
      ? r.sub
      : item.status === 'highlight'
        ? '#FBBF24'
        : r.border
  return `<div class="stack" style="gap:6px;align-items:center;justify-content:center;text-align:center;padding:12px;border-radius:12px;background:${r.bg};border:1px solid ${statusBorder};${aspect !== 'auto' ? `aspect-ratio:${aspect};` : ''}">
    <div style="display:flex;align-items:center;justify-content:center;flex:1;${item.image ? 'width:100%;height:100%;border-radius:8px;overflow:hidden;' : ''}">${visual}</div>
    ${item.label ? `<div style="font-size:12px;color:${r.title};font-weight:600;">${escapeHtml(item.label)}</div>` : ''}
  </div>`
}

function compileGridCollection(props: z.infer<typeof gridCollectionProps>): string {
  const cells = props.items.map((item) => renderGridItem(item, props.item_shape)).join('')
  return `<div class="card stack" style="gap:14px;">
    <div class="title">${escapeHtml(props.title)}</div>
    <div style="display:grid;grid-template-columns:repeat(${props.cols}, minmax(0,1fr));gap:10px;">${cells}</div>
  </div>`
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
    defaultSize: 'square_card',
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
    description: '一张图说明一个趋势 / 分布',
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
