/**
 * Ready 点阵图表引擎（文档 widget 共享层）。
 *
 * 纪律来自 ready-human-touch-card/references/dot-charts.md 与 dataviz 方法论：
 * - 单系列全主色 #FF4B2B（亮暗恒定），强调一项时其余退避灰；无第二彩色、无彩虹。
 * - 量化诚实：unit 图例（● = N）与逐项真值直标都不许删；unit 取值让最大值落 8–15 点。
 * - 禁饼图/双轴/按值染深浅；占比用 waffle（单值）或按值排序横向点条（多值）。
 * - 文字穿文字色（mono 数字/标签），颜色只落在数据 mark 上。
 *
 * 两套编译器（openui bar_chart/line_chart 与骨架 chart_focus）都委托这里渲染。
 */

import { widgetVar } from './document-widget-theme'

export type ReadyChartType = 'bar' | 'hbar' | 'line' | 'pie' | 'stacked_bar' | 'scatter' | 'waffle'

export const READY_CHART_TYPES: readonly ReadyChartType[] = [
  'bar',
  'hbar',
  'line',
  'pie',
  'stacked_bar',
  'scatter',
  'waffle',
]

export interface ReadyChartDatumPart {
  label: string
  value: number
}

export interface ReadyChartDatum {
  label: string
  value: number
  /** scatter 专用横轴值；缺省用序号 */
  x?: number
  /** stacked_bar 专用子构成 */
  parts?: ReadyChartDatumPart[]
}

export interface ReadyChartOptions {
  type: ReadyChartType | string
  data: ReadyChartDatum[]
  /** 数值单位文本（如 "h" / "次" / "万"），进入 unit 图例与直标 */
  unitLabel?: string
  /** 强调项下标：该项主色，其余退避灰 */
  hot?: number
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const DC_ON = widgetVar('dcOn')
const DC_OFF = widgetVar('dcOff')
const DC_REST = widgetVar('dcRest')
const INK = widgetVar('ink')
const INK2 = widgetVar('ink2')
const HAIR = widgetVar('hair')

const DOT_SIZE = 'var(--widget-dc-dot, 12px)'
const DOT_GAP = 'var(--widget-dc-gap, 5px)'

/** 让最大值落在 8–15 点之间的"好看"单位：1/2/2.5/5 × 10^k */
export function resolveDotUnit(maxValue: number): number {
  const max = Math.max(Math.abs(maxValue), Number.EPSILON)
  const raw = max / 12
  const exp = Math.floor(Math.log10(raw))
  const base = raw / 10 ** exp
  const step = base <= 1 ? 1 : base <= 2 ? 2 : base <= 2.5 ? 2.5 : base <= 5 ? 5 : 10
  return step * 10 ** exp
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value * 100) / 100
  return String(rounded)
}

function dotSpan(color: string): string {
  return `<span style="width:${DOT_SIZE};height:${DOT_SIZE};border-radius:50%;background:${color};flex:none;"></span>`
}

function dotRow(count: number, color: string): string {
  const capped = Math.max(0, Math.min(count, 24))
  if (capped === 0) {
    return `<span style="width:${DOT_SIZE};height:${DOT_SIZE};border-radius:50%;border:1px solid ${HAIR};flex:none;"></span>`
  }
  return Array.from({ length: capped }, () => dotSpan(color)).join('')
}

function unitLegend(unit: number, unitLabel?: string): string {
  const unitText = `${formatNumber(unit)}${unitLabel ? ` ${escapeHtml(unitLabel)}` : ''}`
  return `<div class="label" style="display:flex;align-items:center;gap:6px;">
    <span style="width:8px;height:8px;border-radius:50%;background:${DC_ON};flex:none;"></span>
    <span style="text-transform:none;">= ${unitText}</span>
  </div>`
}

function markColor(index: number, hot?: number): string {
  if (hot == null || !Number.isInteger(hot)) return DC_ON
  return index === hot ? DC_ON : DC_OFF
}

function valueText(value: number, unitLabel?: string): string {
  return `${formatNumber(value)}${unitLabel ? ` ${escapeHtml(unitLabel)}` : ''}`
}

function renderDotHBar(data: ReadyChartDatum[], options: ReadyChartOptions, opts?: { percentOfTotal?: boolean }): string {
  const unit = resolveDotUnit(Math.max(...data.map((d) => d.value), 1))
  const total = data.reduce((acc, d) => acc + Math.max(d.value, 0), 0) || 1
  const rows = data.map((d, i) => {
    const dots = Math.round(Math.max(d.value, 0) / unit)
    const percent = opts?.percentOfTotal ? ` <span class="muted">· ${Math.round((Math.max(d.value, 0) / total) * 100)}%</span>` : ''
    return `<div style="display:grid;grid-template-columns:minmax(56px,auto) 1fr auto;gap:10px;align-items:center;">
      <div style="font-size:12px;color:${INK2};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(d.label)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:${DOT_GAP};align-items:center;">${dotRow(dots, markColor(i, options.hot))}</div>
      <div class="num" style="font-size:12px;color:${INK};">${valueText(d.value, options.unitLabel)}${percent}</div>
    </div>`
  }).join('')
  return `<div class="stack" style="gap:10px;">${rows}${unitLegend(unit, options.unitLabel)}</div>`
}

function renderDotBar(data: ReadyChartDatum[], options: ReadyChartOptions): string {
  if (data.length > 8) return renderDotHBar(data, options)
  const unit = resolveDotUnit(Math.max(...data.map((d) => d.value), 1))
  const cols = data.map((d, i) => {
    const dots = Math.max(0, Math.min(Math.round(Math.max(d.value, 0) / unit), 20))
    const color = markColor(i, options.hot)
    const column = dots === 0
      ? `<span style="width:${DOT_SIZE};height:${DOT_SIZE};border-radius:50%;border:1px solid ${HAIR};flex:none;"></span>`
      : Array.from({ length: dots }, () => dotSpan(color)).join('')
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:8px;min-width:0;">
      <div class="num" style="font-size:12px;color:${INK};">${valueText(d.value, options.unitLabel)}</div>
      <div style="display:flex;flex-direction:column-reverse;gap:${DOT_GAP};align-items:center;">${column}</div>
      <div style="font-size:12px;color:${INK2};text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;">${escapeHtml(d.label)}</div>
    </div>`
  }).join('')
  return `<div class="stack" style="gap:12px;">
    <div style="display:flex;gap:14px;align-items:flex-end;justify-content:space-between;">${cols}</div>
    ${unitLegend(unit, options.unitLabel)}
  </div>`
}

function renderDotLine(data: ReadyChartDatum[], options: ReadyChartOptions): string {
  if (data.length < 2) return renderDotHBar(data, options)
  const w = 640
  const h = 220
  const padX = 44
  const padTop = 24
  const padBottom = 44
  const max = Math.max(...data.map((d) => d.value))
  const min = Math.min(...data.map((d) => d.value), 0)
  const range = max - min || 1
  const stepX = (w - padX * 2) / (data.length - 1)
  const points = data.map((d, i) => ({
    x: padX + i * stepX,
    y: h - padBottom - ((d.value - min) / range) * (h - padTop - padBottom),
    d,
    i,
  }))
  const polyline = points.map((p) => `${p.x},${p.y}`).join(' ')
  const gridY = [0.25, 0.5, 0.75].map((ratio) => padTop + (h - padTop - padBottom) * ratio)
  const gridLines = gridY.map((y) => `<line x1="${padX}" y1="${y}" x2="${w - padX}" y2="${y}" stroke="${HAIR}" stroke-width="1"/>`).join('')
  const pointMarks = points.map((p) => `
    <circle cx="${p.x}" cy="${p.y}" r="4.5" fill="${markColor(p.i, options.hot)}" stroke="${widgetVar('card')}" stroke-width="2"/>
    <text x="${p.x}" y="${p.y + (p.i % 2 === 0 ? -12 : 18)}" text-anchor="middle" font-size="11" font-family="var(--widget-font-mono, ui-monospace, monospace)" fill="${INK}">${escapeHtml(valueText(p.d.value, options.unitLabel))}</text>
  `).join('')
  const xLabels = points.map((p) => `<text x="${p.x}" y="${h - 14}" text-anchor="middle" font-size="11" font-family="var(--widget-font-mono, ui-monospace, monospace)" fill="${INK2}">${escapeHtml(p.d.label)}</text>`).join('')
  return `<div class="stack" style="gap:8px;">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;" role="img">
      ${gridLines}
      <line x1="${padX}" y1="${h - padBottom}" x2="${w - padX}" y2="${h - padBottom}" stroke="${HAIR}" stroke-width="1"/>
      <polyline fill="none" stroke="${DC_ON}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="${polyline}"/>
      ${pointMarks}
      ${xLabels}
    </svg>
  </div>`
}

function renderWaffle(data: ReadyChartDatum[], options: ReadyChartOptions): string {
  const first = data[0]
  const raw = first ? first.value : 0
  const percent = Math.max(0, Math.min(100, Math.round(raw <= 1 && raw > 0 ? raw * 100 : raw)))
  const cells = Array.from({ length: 100 }, (_, i) => {
    const filled = i < percent
    return `<span style="width:100%;aspect-ratio:1/1;border-radius:50%;background:${filled ? DC_ON : DC_REST};"></span>`
  }).join('')
  return `<div style="display:grid;grid-template-columns:minmax(120px,180px) 1fr;gap:18px;align-items:center;">
    <div style="display:grid;grid-template-columns:repeat(10,1fr);gap:4px;">${cells}</div>
    <div class="stack" style="gap:6px;">
      <div class="num" style="font-size:40px;font-weight:600;color:${INK};line-height:1;">${percent}<span style="font-size:18px;color:${INK2};">%</span></div>
      ${first ? `<div style="font-size:13px;color:${INK2};">${escapeHtml(first.label)}</div>` : ''}
      <div class="label">1 ● = 1%</div>
    </div>
  </div>`
}

function renderScatter(data: ReadyChartDatum[], options: ReadyChartOptions): string {
  const w = 640
  const h = 260
  const pad = 48
  const xs = data.map((d, i) => (typeof d.x === 'number' && Number.isFinite(d.x) ? d.x : i + 1))
  const ys = data.map((d) => d.value)
  const xMin = Math.min(...xs)
  const xMax = Math.max(...xs)
  const yMin = Math.min(...ys, 0)
  const yMax = Math.max(...ys)
  const xRange = xMax - xMin || 1
  const yRange = yMax - yMin || 1
  const maxIndex = ys.reduce((best, v, i) => (v > ys[best] ? i : best), 0)
  const dots = data.map((d, i) => {
    const cx = pad + ((xs[i] - xMin) / xRange) * (w - pad * 2)
    const cy = h - pad - ((ys[i] - yMin) / yRange) * (h - pad * 2)
    const isHot = options.hot === i || i === maxIndex
    return `
      <circle cx="${cx}" cy="${cy}" r="${options.hot === i ? 7 : 5}" fill="${markColor(i, options.hot)}" fill-opacity="0.92" stroke="${widgetVar('card')}" stroke-width="1.5"/>
      ${isHot ? `<text x="${cx}" y="${cy - 12}" text-anchor="middle" font-size="11" font-family="var(--widget-font-mono, ui-monospace, monospace)" fill="${INK}">${escapeHtml(d.label)} ${escapeHtml(valueText(d.value, options.unitLabel))}</text>` : ''}
    `
  }).join('')
  return `<div class="stack" style="gap:8px;">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;" role="img">
      <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="${HAIR}" stroke-width="1"/>
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="${HAIR}" stroke-width="1"/>
      ${dots}
    </svg>
    <div class="label">Y = ${options.unitLabel ? `<span style="text-transform:none;">${escapeHtml(options.unitLabel)}</span>` : 'VALUE'}</div>
  </div>`
}

function renderStackedGroups(data: ReadyChartDatum[], options: ReadyChartOptions): string {
  const flatValues = data.flatMap((d) => (d.parts?.length ? d.parts.map((p) => p.value) : [d.value]))
  const unit = resolveDotUnit(Math.max(...flatValues, 1))
  const groups = data.map((d, i) => {
    const parts = d.parts?.length ? d.parts : [{ label: d.label, value: d.value }]
    const total = parts.reduce((acc, p) => acc + Math.max(p.value, 0), 0)
    const rows = parts.map((p) => `<div style="display:grid;grid-template-columns:minmax(48px,auto) 1fr auto;gap:10px;align-items:center;">
      <div class="label" style="font-size:10px;">${escapeHtml(p.label)}</div>
      <div style="display:flex;flex-wrap:wrap;gap:${DOT_GAP};align-items:center;">${dotRow(Math.round(Math.max(p.value, 0) / unit), markColor(i, options.hot))}</div>
      <div class="num" style="font-size:12px;color:${INK};">${valueText(p.value, options.unitLabel)}</div>
    </div>`).join('')
    return `<div class="stack" style="gap:8px;padding:12px;border-radius:12px;background:${widgetVar('canvas')};border:1px solid ${HAIR};">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;">
        <div style="font-size:13px;font-weight:600;color:${INK};">${escapeHtml(d.label)}</div>
        <div class="num" style="font-size:12px;color:${INK2};">Σ ${valueText(total, options.unitLabel)}</div>
      </div>
      ${rows}
    </div>`
  }).join('')
  return `<div class="stack" style="gap:10px;">${groups}${unitLegend(unit, options.unitLabel)}</div>`
}

/**
 * 唯一渲染入口。`pie` 是被接受的输入，但渲染为合规比例形态：
 * 单值→waffle；多值→按值排序的横向点条 + 百分比直标。
 */
export function renderReadyChart(options: ReadyChartOptions): string {
  const data = (options.data || []).filter((d) => d && typeof d.label === 'string' && Number.isFinite(d.value))
  if (data.length === 0) {
    return `<div class="subtitle">（暂无数据）</div>`
  }
  const type = options.type
  if (type === 'waffle') return renderWaffle(data, options)
  if (type === 'pie') {
    if (data.length === 1) return renderWaffle(data, options)
    const sorted = [...data].sort((a, b) => b.value - a.value)
    return renderDotHBar(sorted, options, { percentOfTotal: true })
  }
  if (type === 'line') return renderDotLine(data, options)
  if (type === 'scatter') return renderScatter(data, options)
  if (type === 'stacked_bar') return renderStackedGroups(data, options)
  if (type === 'hbar') return renderDotHBar(data, options)
  return renderDotBar(data, options)
}
