/**
 * 文档 widget 的共享构图（chassis）：所有卡片按同一顺序排布——
 *
 *   身份行 chrome（橘点 + mono 类别 · 右侧元信息）
 *   标题块 heading（20px/600 标题 + 13px 副题）
 *   主体（各卡自己的结构）
 *   页脚 foot（hairline 上缘 + mono 来源/说明，可选）
 *
 * 版式与语义见 assets/embedded-skills/ready-human-touch-card/references/recipes-ready.md
 * 的 chrome/foot 纪律：“一组卡里 chrome/foot 格式必须完全一致”。视觉落在
 * buildWidgetBaseStyleCss() 的类层里，这里只产出结构，保证两套编译器同源。
 */

export type WidgetKickerTone = 'accent' | 'ok' | 'ink' | 'quiet'

export function escapeWidgetText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function escapeWidgetRichText(value: string): string {
  return escapeWidgetText(value).replace(/\n/g, '<br/>')
}

export interface WidgetChromeOptions {
  /** mono 类别名（如 METRICS / TIMELINE）或中文身份词（如 内容速览）。 */
  kicker: string
  /** 右侧 mono 元信息（数量、周期、单位）。 */
  meta?: string | null
  tone?: WidgetKickerTone
}

export function renderWidgetChrome({ kicker, meta, tone = 'accent' }: WidgetChromeOptions): string {
  const metaHtml = meta && meta.trim()
    ? `<span class="chrome-meta">${escapeWidgetText(meta.trim())}</span>`
    : ''
  return `<div class="chrome" data-widget-chrome><span class="label" data-kicker data-tone="${tone}">${escapeWidgetText(kicker)}</span>${metaHtml}</div>`
}

export function renderWidgetHeading(title?: string | null, subtitle?: string | null): string {
  const titleHtml = title && title.trim() ? `<div class="title">${escapeWidgetText(title.trim())}</div>` : ''
  const subtitleHtml = subtitle && subtitle.trim() ? `<div class="subtitle">${escapeWidgetText(subtitle.trim())}</div>` : ''
  if (!titleHtml && !subtitleHtml) return ''
  return `<div class="heading">${titleHtml}${subtitleHtml}</div>`
}

/** 页脚：左侧说明/来源，右侧元信息；两侧都空时不输出。 */
export function renderWidgetFoot(left?: string | null, right?: string | null): string {
  const leftText = left && left.trim() ? left.trim() : ''
  const rightText = right && right.trim() ? right.trim() : ''
  if (!leftText && !rightText) return ''
  return `<div class="foot" data-widget-foot><span>${escapeWidgetText(leftText)}</span>${rightText ? `<span class="foot-meta">${escapeWidgetText(rightText)}</span>` : ''}</div>`
}

/** 圆点列表：完整正圆的弱墨圆点，替代浏览器默认 disc。 */
export function renderWidgetDotList(items: readonly string[], options?: { size?: number; gap?: number }): string {
  if (items.length === 0) return ''
  const size = options?.size ?? 13.5
  const gap = options?.gap ?? 8
  return `<ul class="dot-list" style="gap:${gap}px;font-size:${size}px;">${items.map((item) => `<li>${escapeWidgetText(item)}</li>`).join('')}</ul>`
}

/**
 * 标签栏 + 内容栏的一行：12 栏网格里标签占 2 栏、内容占 10 栏，
 * 所有卡片的“内容左缘”因此落在同一条竖线上（窄容器时上下堆叠）。
 */
export function renderWidgetLabelRow(label: string, contentHtml: string, options?: { labelColor?: string; attrs?: string }): string {
  const color = options?.labelColor ? `color:${options.labelColor};` : ''
  return `<div class="grid"${options?.attrs ? ` ${options.attrs}` : ''} style="row-gap:4px;"><div class="label span-2" style="padding-top:3px;${color}">${escapeWidgetText(label)}</div><div class="span-10" style="min-width:0;">${contentHtml}</div></div>`
}
