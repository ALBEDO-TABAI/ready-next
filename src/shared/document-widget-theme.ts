/**
 * 文档 widget 的 Ready 设计令牌单一来源。
 *
 * 值域与纪律来自 Ready 点阵理性风格规格（assets/embedded-skills/ready-human-touch-card/
 * references/style-ready.md 与 dot-charts.md），与 App 的设计令牌 design/next/tokens.css 同源：
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
  /** 大面积橘红染底（结果卡、重点格）：比 accentSoft 更淡，保证一页橘红面积克制。 */
  accentWash: string
  accentGlow: string
  dotDim: string
  ok: string
  dcOn: string
  dcOff: string
  dcRest: string
  /**
   * 文档里卡片玻璃面的近似实色：玻璃材质本身由宿主外壳绘制（iframe 内无法采样页面背景），
   * 卡片内容透明叠在玻璃上；这个值只给需要“擦掉背后线条”的元素用（连线光晕、标签底）。
   */
  docCard: string
  /** 玻璃卡里的内凹嵌板（结论、节点）：极淡的墨色，读作玻璃里压下去的一层。 */
  docInset: string
  /** 玻璃卡上的 hairline（导轨、表格线、页脚线）。 */
  docLine: string
  /** 玻璃卡上的点阵底点 / 未开始状态点。 */
  docRest: string
  /** 玻璃卡上的退避点（非强调数据）。 */
  docOff: string
}

export const WIDGET_THEME_LIGHT: WidgetThemeTokenSet = {
  paper: '#F6F5F1',
  card: '#FFFFFF',
  canvas: 'rgba(26,26,26,.035)',
  ink: '#1A1A1A',
  inkBody: '#333333',
  ink2: '#666666',
  ink3: '#999999',
  hair: '#E8E5DE',
  hairV: 'rgba(232,229,222,.4)',
  accent: '#FF4B2B',
  accentSoft: 'rgba(255,75,43,.12)',
  accentWash: 'rgba(255,75,43,.05)',
  accentGlow: 'rgba(255,75,43,.18)',
  dotDim: '#DFDED9',
  ok: '#34D399',
  dcOn: '#FF4B2B',
  dcOff: '#C9C6BE',
  dcRest: '#E3E1DA',
  docCard: '#FCFDFE',
  docInset: 'rgba(30,36,48,.035)',
  docLine: '#E4E6EA',
  docRest: '#E0E2E6',
  docOff: '#C2C5CB',
}

export const WIDGET_THEME_DARK: WidgetThemeTokenSet = {
  paper: '#1A1B1E',
  card: '#202124',
  canvas: 'rgba(255,255,255,.045)',
  ink: '#F2F3F5',
  inkBody: '#C4C7CF',
  ink2: '#8F96A3',
  ink3: '#6E7787',
  hair: '#333538',
  hairV: 'rgba(51,53,56,.5)',
  accent: '#FF6345',
  accentSoft: 'rgba(255,99,69,.16)',
  accentWash: 'rgba(255,99,69,.08)',
  accentGlow: 'rgba(255,99,69,.2)',
  dotDim: '#3A3C40',
  ok: '#34D399',
  dcOn: '#FF4B2B',
  dcOff: '#4A4D52',
  dcRest: '#2E3033',
  docCard: '#2D3139',
  docInset: 'rgba(255,255,255,.045)',
  docLine: '#3B3F48',
  docRest: '#3A3E47',
  docOff: '#5E636D',
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
  accentWash: '--widget-accent-wash',
  accentGlow: '--widget-accent-glow',
  dotDim: '--widget-dot-dim',
  ok: '--widget-ok',
  dcOn: '--widget-dc-on',
  dcOff: '--widget-dc-off',
  dcRest: '--widget-dc-rest',
  docCard: '--widget-doc-card',
  docInset: '--widget-doc-inset',
  docLine: '--widget-doc-line',
  docRest: '--widget-doc-rest',
  docOff: '--widget-doc-off',
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
    return { ...base, surface: widgetVar('accentWash'), marker: widgetVar('accent') }
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
  /**
   * document：嵌在文档正文里的卡片色块——无描边，暖灰底 + 纸白嵌板，
   * 高度随内容，画幅比例不在文档里撑出空白；
   * sheet（默认）：单卡导出的白色纸面，固定画幅按比例成型，内容成组居中。
   */
  surface?: 'document' | 'sheet'
}

/**
 * iframe / 导出宿主 / 静态投影共用的基线类层。所有规则 scoped 在 .widget-root 下。
 * 编译器只输出结构与这些类，视觉身份集中在此处与令牌里；构图顺序见
 * document-widget-chassis.ts（chrome → heading → 主体 → foot）。
 *
 * 版式纪律：12 栏网格（.grid + .span-N，24px 栏距），竖向节奏取 8 的倍数，
 * 行高取 4 的倍数；结构靠留白、对齐与单条 hairline，不用线框与层叠底板。
 */
export function buildWidgetBaseStyleCss(options?: WidgetBaseStyleOptions): string {
  const isTransparent = options?.backgroundMode === 'transparent'
  const isDocument = options?.surface === 'document'
  const mono = `var(--widget-font-mono, ${WIDGET_FONT_MONO})`
  const cardRule = isTransparent
    ? `border: 0;
  border-radius: 0;
  background: transparent;
  padding: 0;`
    : isDocument
      ? `border: 0;
  border-radius: ${WIDGET_RADIUS.card}px;
  background: transparent;
  padding: 24px 28px;`
      : `border: 0;
  border-radius: ${WIDGET_RADIUS.card}px;
  background: var(--widget-bg-primary);
  padding: 32px;`

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
  container-type: inline-size;
  color: var(--widget-text-secondary);
  font-family: var(--widget-font-sans, ${WIDGET_FONT_SANS});
  font-size: 14px;
  line-height: 22px;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

.widget-root, .widget-root * {
  box-sizing: border-box;
}

.widget-root a {
  color: var(--widget-text-primary);
  text-decoration: underline;
  text-decoration-color: var(--widget-accent);
  text-underline-offset: 0.24em;
}

.widget-root .card {
  ${cardRule}
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
${isDocument ? `
/* 文档卡片：玻璃面由宿主外壳绘制（白纱 + 边缘高光 + 柔影，与聊天输入框同一材质），
   卡片内容透明叠在玻璃上；内部嵌板是极淡的内凹墨色，线与点阵用偏冷的中性灰阶贴合玻璃。 */
.widget-root {
  --widget-bg-primary: var(--widget-doc-card, ${WIDGET_THEME_LIGHT.docCard});
  --widget-bg-secondary: var(--widget-doc-inset, ${WIDGET_THEME_LIGHT.docInset});
  --widget-border: var(--widget-doc-line, ${WIDGET_THEME_LIGHT.docLine});
  --widget-dc-rest: var(--widget-doc-rest, ${WIDGET_THEME_LIGHT.docRest});
  --widget-dot-dim: var(--widget-doc-rest, ${WIDGET_THEME_LIGHT.docRest});
  --widget-dc-off: var(--widget-doc-off, ${WIDGET_THEME_LIGHT.docOff});
}

/* 文档卡片：画幅只在导出时成型；正文里一律随栏宽、随内容高度，与正文同一左缘。 */
.widget-root .widget-canvas[data-widget-size] {
  max-width: none;
  aspect-ratio: auto;
  margin-inline: 0;
}
` : ''}
/* 固定画幅（导出纸面）：主体区成组居中，页脚落底——不把条目拉散去填满画幅。 */
.widget-root .widget-canvas:not([data-widget-size="doc_block"]) > .card {
  display: flex;
  flex-direction: column;
}

.widget-root .widget-canvas:not([data-widget-size="doc_block"]) > .card > [data-fill] {
  flex: 1 1 auto;
  min-height: 0;
}

.widget-root .widget-canvas:not([data-widget-size="doc_block"]) > .card > [data-fill="center"] {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.widget-root .widget-canvas:not([data-widget-size="doc_block"]) > .card > [data-fill="grid"] {
  align-content: center;
}

.widget-root .widget-canvas:not([data-widget-size="doc_block"]) > .card > .foot {
  margin-top: auto;
}

.widget-root .widget-canvas[data-widget-bg="transparent"] > .card {
  border: 0;
  background: transparent;
  padding: 0;
}

${isDocument ? '' : `.widget-root .widget-canvas:not([data-widget-size="doc_block"]) [data-info-quote] {
  font-size: 28px !important;
  line-height: 40px !important;
}
`}
/* ─── 12 栏网格 ─── */
.widget-root .grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  column-gap: 24px;
  row-gap: 24px;
  align-items: start;
}

.widget-root .span-1 { grid-column: span 1; }
.widget-root .span-2 { grid-column: span 2; }
.widget-root .span-3 { grid-column: span 3; }
.widget-root .span-4 { grid-column: span 4; }
.widget-root .span-5 { grid-column: span 5; }
.widget-root .span-6 { grid-column: span 6; }
.widget-root .span-7 { grid-column: span 7; }
.widget-root .span-8 { grid-column: span 8; }
.widget-root .span-9 { grid-column: span 9; }
.widget-root .span-10 { grid-column: span 10; }
.widget-root .span-11 { grid-column: span 11; }
.widget-root .span-12 { grid-column: span 12; }

@container (max-width: 560px) {
  .widget-root .grid > [class*="span-"] { grid-column: 1 / -1; }
  .widget-root .grid.keep-pairs > [class*="span-"] { grid-column: span 6; }
  .widget-root .grid.keep-row > .span-2 { grid-column: span 3; }
  .widget-root .grid.keep-row > .span-8 { grid-column: span 6; }
}

/* ─── chassis：身份行 / 标题块 / 页脚 ─── */
.widget-root .chrome {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 14px;
}

.widget-root [data-kicker] {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  letter-spacing: 0.1em;
  line-height: 1.2;
}

.widget-root [data-kicker]::before {
  content: '';
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--widget-accent);
}

.widget-root [data-kicker][data-tone="ok"]::before { background: var(--widget-ok); }
.widget-root [data-kicker][data-tone="ink"]::before { background: var(--widget-text-primary); }
.widget-root [data-kicker][data-tone="quiet"]::before { background: var(--widget-dot-dim); }

.widget-root .chrome-meta {
  flex: none;
  color: var(--widget-text-faint);
  font-family: ${mono};
  font-size: 10.5px;
  letter-spacing: 0.06em;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.widget-root .heading {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.widget-root .foot {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding-top: 12px;
  margin-top: 8px;
  border-top: 1px solid var(--widget-border);
  color: var(--widget-text-muted);
  font-family: ${mono};
  font-size: 10.5px;
  letter-spacing: 0.04em;
  line-height: 1.55;
}

.widget-root .foot > .foot-meta {
  flex: none;
  color: var(--widget-text-faint);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.widget-root .muted {
  color: var(--widget-text-muted);
}

.widget-root .title {
  color: var(--widget-text-primary);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.014em;
  line-height: 28px;
  text-wrap: balance;
}

.widget-root .subtitle {
  color: var(--widget-text-muted);
  font-size: 13px;
  line-height: 20px;
  text-wrap: pretty;
}

.widget-root .label {
  font-family: ${mono};
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.08em;
  line-height: 16px;
  text-transform: uppercase;
  color: var(--widget-text-muted);
}

.widget-root .num {
  font-family: ${mono};
  font-variant-numeric: tabular-nums;
}

.widget-root .figure {
  color: var(--widget-text-primary);
  font-family: ${mono};
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.widget-root .well {
  border-radius: ${WIDGET_RADIUS.control}px;
  background: var(--widget-bg-secondary);
}

.widget-root .dot-list {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--widget-text-secondary);
  line-height: 22px;
}

.widget-root .dot-list > li {
  position: relative;
  padding-left: 15px;
  text-wrap: pretty;
}

.widget-root .dot-list > li::before {
  content: '';
  position: absolute;
  left: 1px;
  top: 9px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--widget-text-faint);
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
  border: 0;
  border-radius: ${WIDGET_RADIUS.pill}px;
  padding: 3px 10px;
  background: var(--widget-bg-secondary);
  color: var(--widget-text-muted);
  font-family: ${mono};
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: 0.06em;
  line-height: 1.3;
}

.widget-root .badge--hot {
  border-color: transparent;
  background: var(--widget-accent-soft);
  color: var(--widget-accent);
}

.widget-root .dot {
  display: inline-block;
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--widget-dot-dim);
}

.widget-root .dot--active { background: var(--widget-accent); }
.widget-root .dot--done { background: var(--widget-ok); }
.widget-root .dot--blocked { background: var(--widget-text-primary); }
.widget-root .dot--pending { background: var(--widget-dot-dim); }

/* 分段切换（tab / 本周下周）：文字标签 + 当前项橘红下划线，坐在一条 hairline 上 */
.widget-root .segmented {
  display: flex;
  align-self: stretch;
  gap: 24px;
  border-bottom: 1px solid var(--widget-border);
}

.widget-root .segmented > button {
  margin-bottom: -1px;
  border: 0;
  border-radius: 0;
  padding: 0 0 10px;
  background: transparent;
  color: var(--widget-text-muted);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  box-shadow: inset 0 -2px 0 transparent;
  transition: color 160ms ease, box-shadow 160ms ease;
}

.widget-root .segmented > button.is-active {
  color: var(--widget-text-primary);
  box-shadow: inset 0 -2px 0 var(--widget-accent);
}

.widget-root button,
.widget-root input,
.widget-root select {
  font: inherit;
}

.widget-root button {
  border: 0;
  border-radius: 8px;
  background: var(--widget-bg-secondary);
  color: var(--widget-text-primary);
  padding: 8px 12px;
  cursor: pointer;
}

.widget-root button:focus-visible,
.widget-root input:focus-visible,
.widget-root select:focus-visible {
  outline: 1.5px solid var(--widget-accent);
  outline-offset: 2px;
}

.widget-root input,
.widget-root select {
  width: 100%;
  border: 0;
  border-bottom: 1px solid var(--widget-border);
  border-radius: 0;
  background: transparent;
  color: var(--widget-text-primary);
  padding: 6px 0 8px;
}

.widget-root input[type="checkbox"] {
  position: relative;
  flex: none;
  width: 16px;
  height: 16px;
  margin: 2px 0 0;
  padding: 0;
  border: 1.5px solid var(--widget-dc-off);
  border-radius: 5px;
  background: transparent;
  -webkit-appearance: none;
  appearance: none;
  cursor: pointer;
}

.widget-root input[type="checkbox"]:checked {
  border-color: var(--widget-text-primary);
  background: var(--widget-text-primary);
}

.widget-root input[type="checkbox"]:checked::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 1px;
  width: 4px;
  height: 8px;
  border: solid var(--widget-bg-primary);
  border-width: 0 1.6px 1.6px 0;
  transform: rotate(42deg);
}

.widget-root canvas {
  display: block;
  width: 100%;
  max-width: 100%;
}
`
}
