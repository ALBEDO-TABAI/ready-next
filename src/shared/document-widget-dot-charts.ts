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

function markColor(index: number, hot?: number): string {
  if (hot == null || !Number.isInteger(hot)) return DC_ON
  return index === hot ? DC_ON : DC_OFF
}

/** 百分号与千分号紧贴数字，其余单位与数字之间留一个空格。 */
function unitSeparator(unitLabel: string): string {
  return /^[%‰]/.test(unitLabel) ? '' : ' '
}

function valueText(value: number, unitLabel?: string): string {
  return `${formatNumber(value)}${unitLabel ? `${unitSeparator(unitLabel)}${escapeHtml(unitLabel)}` : ''}`
}

/*
 * 细点阵场（dot field）：整张图铺一层等距淡点（DC_REST），数据只用实心点（DC_ON / hot 退避 DC_OFF）
 * 在同一网格上"点亮"。点小而密（节距 9、半径 2.4 viewBox 单位），读起来是一块安静的矩阵，
 * 而不是一排排大圆点；量化仍然诚实：每行/每列 = unit，图例与真值直标保留。
 */
const FIELD_W = 640
const PITCH = 9
const DOT_R = 2.4
const REST_R = 1.7
const MONO = 'var(--widget-font-mono, ui-monospace, monospace)'

/** 细点阵用的"好看"单位：让最大值落在约 16–26 个点 */
export function resolveFieldUnit(maxValue: number): number {
  const max = Math.max(Math.abs(maxValue), Number.EPSILON)
  const raw = max / 22
  const exp = Math.floor(Math.log10(raw))
  const base = raw / 10 ** exp
  const step = base <= 1 ? 1 : base <= 2 ? 2 : base <= 2.5 ? 2.5 : base <= 5 ? 5 : 10
  return step * 10 ** exp
}

function dot(cx: number, cy: number, on: boolean, color: string): string {
  return on
    ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${DOT_R}" fill="${color}"/>`
    : `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${REST_R}" fill="${DC_REST}"/>`
}

function fieldLegend(unit: number, unitLabel: string | undefined, axis: 'row' | 'col'): string {
  const unitText = `${formatNumber(unit)}${unitLabel ? `${unitSeparator(unitLabel)}${escapeHtml(unitLabel)}` : ''}`
  return `<div class="label" style="display:flex;align-items:center;gap:6px;">
    <span style="width:6px;height:6px;border-radius:50%;background:${DC_ON};flex:none;"></span>
    <span style="text-transform:none;">每${axis === 'row' ? '行' : '列'} = ${unitText}</span>
  </div>`
}

/** 横向点条的列数：与点阵场同一节距（在文档栏宽里约 10px），条宽吃满 12 栏中的 8 栏。 */
const ROW_COLS = 46

/** 让最大值落在约 36 个点上的“好看”单位，横条因此铺开到七八成宽。 */
function resolveRowUnit(maxValue: number): number {
  const max = Math.max(Math.abs(maxValue), Number.EPSILON)
  const raw = max / 36
  const exp = Math.floor(Math.log10(raw))
  const base = raw / 10 ** exp
  const step = base <= 1 ? 1 : base <= 2 ? 2 : base <= 2.5 ? 2.5 : base <= 5 ? 5 : 10
  return step * 10 ** exp
}

/** 共享的横向点条：rows 行 × ROW_COLS 列，前 filled 列点亮。进度卡也用它，保证点径一致。 */
export function renderDotRowSvg(filled: number, color: string, rows = 2): string {
  const n = Math.max(0, Math.min(ROW_COLS, Math.round(filled)))
  let dots = ''
  for (let r = 0; r < rows; r++) for (let c = 0; c < ROW_COLS; c++) dots += dot(PITCH / 2 + c * PITCH, PITCH / 2 + r * PITCH, c < n, color)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ROW_COLS * PITCH} ${rows * PITCH}" style="width:100%;height:auto;display:block;" role="img">${dots}</svg>`
}

export const READY_DOT_ROW_COLS = ROW_COLS

function renderDotHBar(data: ReadyChartDatum[], options: ReadyChartOptions, opts?: { percentOfTotal?: boolean }): string {
  const unit = resolveRowUnit(Math.max(...data.map((d) => d.value), 1))
  const total = data.reduce((acc, d) => acc + Math.max(d.value, 0), 0) || 1
  const unitIsPercent = /%/.test(options.unitLabel || '')
  // 名称落在标签栏（2 栏），点条 8 栏，数值 2 栏右对齐——与卡片里其他行同一网格。
  const rows = data.map((d, i) => {
    const filled = Math.max(d.value, 0) / unit
    const percent = opts?.percentOfTotal && !unitIsPercent ? ` <span class="muted">· ${Math.round((Math.max(d.value, 0) / total) * 100)}%</span>` : ''
    return `<div class="span-2" style="font-size:13px;line-height:20px;color:${INK};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(d.label)}</div>
      <div class="span-8" style="padding-top:1px;">${renderDotRowSvg(filled, markColor(i, options.hot))}</div>
      <div class="num span-2" style="font-size:12px;line-height:20px;color:${INK};text-align:right;white-space:nowrap;">${valueText(d.value, options.unitLabel)}${percent}</div>`
  }).join('')
  return `<div class="stack" style="gap:16px;"><div class="grid keep-row" style="row-gap:14px;align-items:center;">${rows}</div>${fieldLegend(unit, options.unitLabel, 'col')}</div>`
}

function renderDotBar(data: ReadyChartDatum[], options: ReadyChartOptions): string {
  if (data.length > 8) return renderDotHBar(data, options)
  const unit = resolveFieldUnit(Math.max(...data.map((d) => d.value), 1))
  const counts = data.map((d) => Math.max(0, Math.round(Math.max(d.value, 0) / unit)))
  const maxRows = Math.max(...counts, 1)
  const rows = Math.min(maxRows + 3, 30)
  const cols = Math.floor(FIELD_W / PITCH)
  const bw = data.length <= 4 ? 5 : data.length <= 6 ? 4 : 3
  const slot = cols / data.length
  const top = 22
  const fieldH = rows * PITCH
  const h = top + fieldH + 26
  const x0 = (FIELD_W - cols * PITCH) / 2 + PITCH / 2
  const barStart = data.map((_, i) => Math.round(i * slot + (slot - bw) / 2))
  let dots = ''
  for (let c = 0; c < cols; c++) {
    const bi = barStart.findIndex((s) => c >= s && c < s + bw)
    for (let r = 0; r < rows; r++) {
      const fromBottom = rows - 1 - r
      const on = bi >= 0 && fromBottom < Math.min(counts[bi], rows)
      dots += dot(x0 + c * PITCH, top + PITCH / 2 + r * PITCH, on, on ? markColor(bi, options.hot) : DC_REST)
    }
  }
  const labels = data.map((d, i) => {
    const cx = x0 + (barStart[i] + (bw - 1) / 2) * PITCH
    const barTop = top + (rows - Math.min(counts[i], rows)) * PITCH
    return `<text x="${cx.toFixed(1)}" y="${(barTop - 7).toFixed(1)}" text-anchor="middle" font-size="11" font-family="${MONO}" fill="${INK}">${escapeHtml(valueText(d.value, options.unitLabel))}</text>
      <text x="${cx.toFixed(1)}" y="${(top + fieldH + 18).toFixed(1)}" text-anchor="middle" font-size="11" fill="${INK2}">${escapeHtml(d.label)}</text>`
  }).join('')
  return `<div class="stack" style="gap:10px;">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FIELD_W} ${h}" style="width:100%;height:auto;display:block;" role="img">${dots}${labels}</svg>
    ${fieldLegend(unit, options.unitLabel, 'row')}
  </div>`
}

function renderDotLine(data: ReadyChartDatum[], options: ReadyChartOptions): string {
  if (data.length < 2) return renderDotHBar(data, options)
  const max = Math.max(...data.map((d) => d.value))
  const min = Math.min(...data.map((d) => d.value), 0)
  const range = max - min || 1
  const rows = 18
  const top = 26
  const fieldH = rows * PITCH
  const h = top + fieldH + 28
  const padX = 30
  const cols = Math.floor((FIELD_W - padX * 2) / PITCH)
  const x0 = (FIELD_W - cols * PITCH) / 2 + PITCH / 2
  const xEnd = x0 + (cols - 1) * PITCH
  const yBottom = top + PITCH / 2 + (rows - 1) * PITCH
  const yTop = top + PITCH / 2
  const xOf = (i: number) => x0 + (i / (data.length - 1)) * (xEnd - x0)
  const yOf = (v: number) => yBottom - ((v - min) / range) * (yBottom - yTop)
  const points = data.map((d, i) => ({ x: xOf(i), y: yOf(d.value) }))
  const lineYAt = (x: number) => {
    const span = (xEnd - x0) / (data.length - 1)
    const i = Math.min(Math.max(Math.floor((x - x0) / span), 0), data.length - 2)
    const t = (x - points[i].x) / (points[i + 1].x - points[i].x)
    return points[i].y + (points[i + 1].y - points[i].y) * t
  }
  // 1) 点阵场：线下方的格点用退避灰“点亮”成面积，其余是淡底点。
  let field = ''
  for (let c = 0; c < cols; c++) {
    const cx = x0 + c * PITCH
    const lineY = lineYAt(cx)
    for (let r = 0; r < rows; r++) {
      const cy = yTop + r * PITCH
      field += cy > lineY + PITCH * 0.6
        ? `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${REST_R}" fill="${DC_OFF}" fill-opacity="0.78"/>`
        : dot(cx, cy, false, DC_REST)
    }
  }
  // 2) 折线：沿真实线段等弧长落点，读起来是一条连续的点线而不是阶梯。
  let line = ''
  const step = 5.4
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i]
    const q = points[i + 1]
    const length = Math.hypot(q.x - p.x, q.y - p.y)
    const n = Math.max(1, Math.round(length / step))
    for (let k = 0; k < n; k++) {
      const t = k / n
      line += `<circle cx="${(p.x + (q.x - p.x) * t).toFixed(1)}" cy="${(p.y + (q.y - p.y) * t).toFixed(1)}" r="1.7" fill="${DC_ON}"/>`
    }
  }
  // 3) 数据点 + 真值直标：首尾标签向内对齐，避免被画布裁掉。
  const showAllLabels = data.length <= 8
  const maxIndex = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0)
  const minIndex = data.reduce((best, d, i) => (d.value < data[best].value ? i : best), 0)
  const marks = data.map((d, i) => {
    const { x, y } = points[i]
    const color = markColor(i, options.hot)
    const anchor = i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'
    const labelX = i === 0 ? x - 4 : i === data.length - 1 ? x + 4 : x
    const labelled = showAllLabels || i === 0 || i === data.length - 1 || i === maxIndex || i === minIndex || i === options.hot
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.9" fill="${widgetVar('card')}"/>
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.9" fill="${color}"/>
      ${labelled ? `<text x="${labelX.toFixed(1)}" y="${(y - 10).toFixed(1)}" text-anchor="${anchor}" font-size="11" font-weight="500" font-family="${MONO}" fill="${INK}">${escapeHtml(valueText(d.value, options.unitLabel))}</text>` : ''}
      <text x="${labelX.toFixed(1)}" y="${(yBottom + 22).toFixed(1)}" text-anchor="${anchor}" font-size="11" font-family="${MONO}" fill="${INK2}">${escapeHtml(d.label)}</text>`
  }).join('')
  return `<div class="stack" style="gap:8px;">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FIELD_W} ${h}" style="width:100%;height:auto;display:block;overflow:visible;" role="img">${field}${line}${marks}</svg>
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
  const unit = resolveRowUnit(Math.max(...flatValues, 1))
  const groups = data.map((d, i) => {
    const parts = d.parts?.length ? d.parts : [{ label: d.label, value: d.value }]
    const total = parts.reduce((acc, p) => acc + Math.max(p.value, 0), 0)
    const rows = parts.map((p) => `<div style="display:grid;grid-template-columns:minmax(48px,auto) 1fr auto;gap:10px;align-items:center;">
      <div class="label" style="font-size:10px;">${escapeHtml(p.label)}</div>
      ${renderDotRowSvg(Math.max(p.value, 0) / unit, markColor(i, options.hot), 1)}
      <div class="num" style="font-size:12px;color:${INK};">${valueText(p.value, options.unitLabel)}</div>
    </div>`).join('')
    return `<div class="stack" style="gap:8px;padding-top:12px;border-top:1px solid ${HAIR};">
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;">
        <div style="font-size:13px;font-weight:600;color:${INK};">${escapeHtml(d.label)}</div>
        <div class="num" style="font-size:12px;color:${INK2};">Σ ${valueText(total, options.unitLabel)}</div>
      </div>
      ${rows}
    </div>`
  }).join('')
  return `<div class="stack" style="gap:10px;">${groups}${fieldLegend(unit, options.unitLabel, 'col')}</div>`
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
