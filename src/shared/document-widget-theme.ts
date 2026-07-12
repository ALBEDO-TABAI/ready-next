/**
 * 文档 widget 的 Ready 设计令牌单一来源。
 *
 * 值域与纪律来自 Ready 点阵理性风格规格（assets/embedded-skills/ready-human-touch-card/
 * references/style-ready.md 与 dot-charts.md），与 App 主题 theme-tokens.css 同源：
 * - 单一品牌橘红 accent，无第二 accent；正文永不穿彩。
 * - 标签/数字走 mono（大写 + 0.08em 字距 / tabular-nums）。
 * - 图表数据 mark 亮暗两面恒用 #FF4B2B（#FF6345 只作暗底文字/发光，不作数据色）。
 *
 * 两套 widget 编译器（document-widget-openui / document-widget-skeletons）与 iframe
 * 基线样式（widget-css-bridge）都从这里取值；编译产物一律经 widgetVar() 引用 CSS 变量
 * 并带回退值，保证脱离 bridge（如导出路径）也能渲染。
 */

export interface WidgetThemeTokenSet {
  paper: string
  card: string
  canvas: string
  ink: string
  inkBody: string
  ink2: string
  ink3: string
  hair: string
  hairV: string
  accent: string
  accentSoft: string
  accentGlow: string
  dotDim: string
  ok: string
  dcOn: string
  dcOff: string
  dcRest: string
}

export const WIDGET_THEME_LIGHT: WidgetThemeTokenSet = {
  paper: '#F6F5F1',
  card: '#FFFFFF',
  canvas: '#F0EFED',
  ink: '#1A1A1A',
  inkBody: '#333333',
  ink2: '#666666',
  ink3: '#999999',
  hair: '#E8E5DE',
  hairV: 'rgba(232,229,222,.4)',
  accent: '#FF4B2B',
  accentSoft: 'rgba(255,75,43,.12)',
  accentGlow: 'rgba(255,75,43,.18)',
  dotDim: '#DFDED9',
  ok: '#34D399',
  dcOn: '#FF4B2B',
  dcOff: '#C9C6BE',
  dcRest: '#E3E1DA',
}

export const WIDGET_THEME_DARK: WidgetThemeTokenSet = {
  paper: '#1A1B1E',
  card: '#202124',
  canvas: '#232427',
  ink: '#F2F3F5',
  inkBody: '#C4C7CF',
  ink2: '#8F96A3',
  ink3: '#6E7787',
  hair: '#333538',
  hairV: 'rgba(51,53,56,.5)',
  accent: '#FF6345',
  accentSoft: 'rgba(255,99,69,.16)',
  accentGlow: 'rgba(255,99,69,.2)',
  dotDim: '#3A3C40',
  ok: '#34D399',
  dcOn: '#FF4B2B',
  dcOff: '#4A4D52',
  dcRest: '#2E3033',
}

export const WIDGET_FONT_SANS =
  "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', Inter, 'Segoe UI', 'Noto Sans SC', 'Microsoft YaHei', sans-serif"

export const WIDGET_FONT_MONO =
  "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace"

export const WIDGET_RADIUS = {
  card: 16,
  module: 18,
  control: 12,
  pill: 999,
} as const

/** 卡壳浮起用内高光而非外投影；外阴影上限 0 1px 3px。 */
export const WIDGET_SHADOW_MAX = '0 1px 3px rgba(0,0,0,.06)'
export const WIDGET_INSET_HIGHLIGHT = 'inset 0 1px 0 rgba(255,255,255,.58)'

const TOKEN_VAR_NAMES: Record<keyof WidgetThemeTokenSet, string> = {
  paper: '--widget-bg-paper',
  card: '--widget-bg-primary',
  canvas: '--widget-bg-secondary',
  ink: '--widget-text-primary',
  inkBody: '--widget-text-secondary',
  ink2: '--widget-text-muted',
  ink3: '--widget-text-faint',
  hair: '--widget-border',
  hairV: '--widget-border-v',
  accent: '--widget-accent',
  accentSoft: '--widget-accent-soft',
  accentGlow: '--widget-accent-glow',
  dotDim: '--widget-dot-dim',
  ok: '--widget-ok',
  dcOn: '--widget-dc-on',
  dcOff: '--widget-dc-off',
  dcRest: '--widget-dc-rest',
}

/** 编译产物引用令牌的唯一入口：var(--widget-x, 亮色回退)。 */
export function widgetVar(token: keyof WidgetThemeTokenSet): string {
  return `var(${TOKEN_VAR_NAMES[token]}, ${WIDGET_THEME_LIGHT[token]})`
}

export function widgetVarName(token: keyof WidgetThemeTokenSet): string {
  return TOKEN_VAR_NAMES[token]
}

/** bridge/导出路径用：把整套令牌展开为 CSS 变量声明（不含 :root 包裹）。 */
export function buildWidgetTokenVarDeclarations(tokens: WidgetThemeTokenSet): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const key of Object.keys(TOKEN_VAR_NAMES) as Array<keyof WidgetThemeTokenSet>) {
    vars[TOKEN_VAR_NAMES[key]] = tokens[key]
  }
  vars['--widget-font-sans'] = WIDGET_FONT_SANS
  vars['--widget-font-mono'] = WIDGET_FONT_MONO
  return vars
}

/**
 * ramp 兼容收敛：legacy 六色 ramp id 继续被 schema 接受，但语义重映射为 Ready 三档
 * 色调；橘红预算由编译代码执掌，模型/用户选色造不出彩虹。
 */
export type WidgetTone = 'neutral' | 'ok' | 'accent'

export function resolveWidgetTone(ramp?: string | null): WidgetTone {
  if (ramp === 'emerald') return 'ok'
  if (ramp === 'amber' || ramp === 'rose') return 'accent'
  return 'neutral'
}

export interface WidgetToneStyle {
  /** 小卡/列/格的底色 */
  surface: string
  /** hairline 边框 */
  border: string
  /** 标记色（状态点/条/强调数字），三档中唯一随 tone 变化的彩色 */
  marker: string
  /** 标题墨 */
  title: string
  /** 次要文字 */
  sub: string
}

export function resolveWidgetToneStyle(ramp?: string | null): WidgetToneStyle {
  const tone = resolveWidgetTone(ramp)
  const base = {
    border: widgetVar('hair'),
    title: widgetVar('ink'),
    sub: widgetVar('ink2'),
  }
  if (tone === 'ok') {
    return { ...base, surface: widgetVar('canvas'), marker: widgetVar('ok') }
  }
  if (tone === 'accent') {
    return { ...base, surface: widgetVar('accentSoft'), marker: widgetVar('accent') }
  }
  return { ...base, surface: widgetVar('canvas'), marker: widgetVar('accent') }
}

/** 状态点语义（Ready 纪律：橘=进行中/此刻，绿=完成，灰=未开始；形状+标签先行）。 */
export function widgetStatusDotColor(status?: string | null): string {
  if (status === 'done') return widgetVar('ok')
  if (status === 'active' || status === 'highlight') return widgetVar('accent')
  if (status === 'blocked') return widgetVar('ink')
  return widgetVar('dotDim')
}

export interface WidgetBaseStyleOptions {
  backgroundMode?: 'opaque' | 'transparent'
}

/**
 * iframe / 导出宿主共用的基线类层。所有规则 scoped 在 .widget-root 下。
 * 编译器只输出结构与这些类，视觉身份集中在此处与令牌里。
 */
export function buildWidgetBaseStyleCss(options?: WidgetBaseStyleOptions): string {
  const isTransparent = options?.backgroundMode === 'transparent'
  const cardBackground = isTransparent ? 'transparent' : 'var(--widget-bg-primary)'
  const cardBorder = isTransparent ? '0' : '1px solid var(--widget-border)'
  const cardPadding = isTransparent ? '0' : '20px'

  return `
html, body {
  margin: 0;
  padding: 0;
  background: transparent;
  color: var(--widget-text-secondary);
  font-family: var(--widget-font-sans, ${WIDGET_FONT_SANS});
}

.widget-root {
  box-sizing: border-box;
  width: 100%;
  color: var(--widget-text-secondary);
}

.widget-root, .widget-root * {
  box-sizing: border-box;
}

.widget-root a {
  color: var(--widget-accent);
}

.widget-root .card {
  border: ${cardBorder};
  border-radius: ${WIDGET_RADIUS.card}px;
  background: ${cardBackground};
  padding: ${cardPadding};
}

.widget-root .widget-canvas {
  display: block;
  width: 100%;
  margin-inline: auto;
}

.widget-root .widget-canvas > .card {
  min-height: 100%;
}

.widget-root .widget-canvas[data-widget-size="square_card"] {
  max-width: 560px;
  aspect-ratio: 1 / 1;
}

.widget-root .widget-canvas[data-widget-size="portrait_card"] {
  max-width: 480px;
  aspect-ratio: 4 / 5;
}

.widget-root .widget-canvas[data-widget-size="story_card"] {
  max-width: 420px;
  aspect-ratio: 9 / 16;
}

.widget-root .widget-canvas[data-widget-size="landscape_card"] {
  max-width: 100%;
  aspect-ratio: 16 / 9;
}

.widget-root .widget-canvas[data-widget-size="landscape_4_3"] {
  max-width: 100%;
  aspect-ratio: 4 / 3;
}

.widget-root .widget-canvas[data-widget-size="a4_portrait"] {
  max-width: 640px;
  aspect-ratio: 210 / 297;
}

.widget-root .widget-canvas[data-widget-size="doc_block"] {
  max-width: none;
  aspect-ratio: auto;
}

.widget-root .widget-canvas[data-widget-bg="transparent"] > .card {
  border: 0;
  background: transparent;
  padding: 0;
}

.widget-root .muted {
  color: var(--widget-text-muted);
}

.widget-root .title {
  color: var(--widget-text-primary);
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.015em;
  line-height: 1.2;
}

.widget-root .subtitle {
  color: var(--widget-text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.widget-root .label {
  font-family: var(--widget-font-mono, ${WIDGET_FONT_MONO});
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--widget-text-muted);
}

.widget-root .num {
  font-family: var(--widget-font-mono, ${WIDGET_FONT_MONO});
  font-variant-numeric: tabular-nums;
}

.widget-root .row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.widget-root .stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.widget-root .badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--widget-border);
  border-radius: ${WIDGET_RADIUS.pill}px;
  padding: 3px 10px;
  background: transparent;
  color: var(--widget-text-muted);
  font-family: var(--widget-font-mono, ${WIDGET_FONT_MONO});
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
}

.widget-root .badge--hot {
  border-color: transparent;
  background: var(--widget-accent-soft);
  color: var(--widget-accent);
}

.widget-root .dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--widget-dot-dim);
}

.widget-root .dot--active { background: var(--widget-accent); }
.widget-root .dot--done { background: var(--widget-ok); }
.widget-root .dot--blocked { background: var(--widget-text-primary); }

.widget-root button,
.widget-root input,
.widget-root select {
  font: inherit;
}

.widget-root button {
  border: 1px solid var(--widget-border);
  border-radius: ${WIDGET_RADIUS.control}px;
  background: var(--widget-bg-primary);
  color: var(--widget-text-primary);
  padding: 8px 12px;
  cursor: pointer;
}

.widget-root input,
.widget-root select {
  width: 100%;
  border: 1px solid var(--widget-border);
  border-radius: ${WIDGET_RADIUS.control}px;
  background: var(--widget-bg-primary);
  color: var(--widget-text-primary);
  padding: 8px 10px;
}

.widget-root canvas {
  display: block;
  width: 100%;
  max-width: 100%;
}
`
}
