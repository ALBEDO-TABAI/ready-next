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

function valueText(value: number, unitLabel?: string): string {
  return `${formatNumber(value)}${unitLabel ? ` ${escapeHtml(unitLabel)}` : ''}`
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
  const unitText = `${formatNumber(unit)}${unitLabel ? ` ${escapeHtml(unitLabel)}` : ''}`
  return `<div class="label" style="display:flex;align-items:center;gap:6px;">
    <span style="width:6px;height:6px;border-radius:50%;background:${DC_ON};flex:none;"></span>
    <span style="text-transform:none;">每${axis === 'row' ? '行' : '列'} = ${unitText}</span>
  </div>`
}

function fieldRow(filled: number, color: string, cols = 34): string {
  const n = Math.max(0, Math.min(cols, filled))
  let dots = ''
  for (let c = 0; c < cols; c++) dots += dot(PITCH / 2 + c * PITCH, PITCH / 2, c < n, color)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cols * PITCH} ${PITCH}" style="width:100%;height:auto;display:block;" role="img">${dots}</svg>`
}

function renderDotHBar(data: ReadyChartDatum[], options: ReadyChartOptions, opts?: { percentOfTotal?: boolean }): string {
  const unit = resolveFieldUnit(Math.max(...data.map((d) => d.value), 1))
  const total = data.reduce((acc, d) => acc + Math.max(d.value, 0), 0) || 1
  const cols = 34
  const rows = data.map((d, i) => {
    const filled = Math.max(0, Math.min(cols, Math.round(Math.max(d.value, 0) / unit)))
    const color = markColor(i, options.hot)
    let dots = ''
    for (let r = 0; r < 2; r++) for (let c = 0; c < cols; c++) dots += dot(PITCH / 2 + c * PITCH, PITCH / 2 + r * PITCH, c < filled, color)
    const percent = opts?.percentOfTotal ? ` <span class="muted">· ${Math.round((Math.max(d.value, 0) / total) * 100)}%</span>` : ''
    return `<div style="display:grid;grid-template-columns:minmax(56px,auto) 1fr auto;gap:12px;align-items:center;">
      <div style="font-size:12px;color:${INK2};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(d.label)}</div>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cols * PITCH} ${2 * PITCH}" style="width:100%;height:auto;display:block;" role="img">${dots}</svg>
      <div class="num" style="font-size:12px;color:${INK};">${valueText(d.value, options.unitLabel)}${percent}</div>
    </div>`
  }).join('')
  return `<div class="stack" style="gap:10px;">${rows}${fieldLegend(unit, options.unitLabel, 'col')}</div>`
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
  const top = 24
  const fieldH = rows * PITCH
  const h = top + fieldH + 26
  const padX = 26
  const cols = Math.floor((FIELD_W - padX * 2) / PITCH)
  const x0 = (FIELD_W - cols * PITCH) / 2 + PITCH / 2
  const colOf = (i: number) => Math.round((i / (data.length - 1)) * (cols - 1))
  const levelOf = (v: number) => Math.round(((v - min) / range) * (rows - 1))
  // 在每一列上插值出折线所在的行，折线本身由点亮的点组成
  const lineRow: number[] = []
  for (let c = 0; c < cols; c++) {
    const pos = (c / (cols - 1)) * (data.length - 1)
    const i = Math.min(Math.floor(pos), data.length - 2)
    const t = pos - i
    lineRow[c] = Math.round(levelOf(data[i].value) * (1 - t) + levelOf(data[i + 1].value) * t)
  }
  const pointCols = new Map(data.map((d, i) => [colOf(i), i]))
  let dots = ''
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const level = rows - 1 - r
      const cx = x0 + c * PITCH
      const cy = top + PITCH / 2 + r * PITCH
      const prev = c > 0 ? lineRow[c - 1] : lineRow[c]
      const lo = Math.min(prev, lineRow[c]), hi = Math.max(prev, lineRow[c])
      const onLine = level === lineRow[c] || (level > lo && level < hi)
      if (onLine && level !== lineRow[c]) {
        dots += dot(cx, cy, true, DC_ON)
      } else if (level === lineRow[c]) {
        const pi = pointCols.get(c)
        const color = pi == null ? DC_ON : markColor(pi, options.hot)
        dots += pi == null ? dot(cx, cy, true, color) : `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${DOT_R + 1.4}" fill="${color}"/>`
      } else {
        dots += dot(cx, cy, false, DC_REST)
      }
    }
  }
  const labels = data.map((d, i) => {
    const cx = x0 + colOf(i) * PITCH
    const cy = top + PITCH / 2 + (rows - 1 - levelOf(d.value)) * PITCH
    return `<text x="${cx.toFixed(1)}" y="${(cy - 9).toFixed(1)}" text-anchor="middle" font-size="11" font-family="${MONO}" fill="${INK}">${escapeHtml(valueText(d.value, options.unitLabel))}</text>
      <text x="${cx.toFixed(1)}" y="${(top + fieldH + 18).toFixed(1)}" text-anchor="middle" font-size="11" font-family="${MONO}" fill="${INK2}">${escapeHtml(d.label)}</text>`
  }).join('')
  return `<div class="stack" style="gap:8px;">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${FIELD_W} ${h}" style="width:100%;height:auto;display:block;" role="img">${dots}${labels}</svg>
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
  const unit = resolveFieldUnit(Math.max(...flatValues, 1))
  const groups = data.map((d, i) => {
    const parts = d.parts?.length ? d.parts : [{ label: d.label, value: d.value }]
    const total = parts.reduce((acc, p) => acc + Math.max(p.value, 0), 0)
    const rows = parts.map((p) => `<div style="display:grid;grid-template-columns:minmax(48px,auto) 1fr auto;gap:10px;align-items:center;">
      <div class="label" style="font-size:10px;">${escapeHtml(p.label)}</div>
      ${fieldRow(Math.round(Math.max(p.value, 0) / unit), markColor(i, options.hot))}
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
