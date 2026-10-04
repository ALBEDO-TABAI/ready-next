import { renderWidgetChrome, renderWidgetDotList, renderWidgetFoot, renderWidgetLabelRow } from './document-widget-chassis'
import { resolveWidgetTone, resolveWidgetToneStyle, widgetVar } from './document-widget-theme'

export interface ReadyInfoCardFact {
  label: string
  value: string
}

export type ReadyInfoCardDecoration = 'none' | 'quote_mark' | 'left_bar' | 'top_divider'

export interface ReadyInfoCardProps {
  title?: string
  body: string
  facts?: ReadyInfoCardFact[]
  points?: string[]
  kicker?: string
  footer?: string
  attribution?: string
  ramp?: string
  decoration?: ReadyInfoCardDecoration
  alignment?: 'left' | 'center'
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeRichText(value: string): string {
  return escapeHtml(value).replace(/\n/g, '<br/>')
}

export function resolveInfoCardRamp(tone?: string | null): 'indigo' | 'amber' | 'emerald' {
  if (tone === 'success') return 'emerald'
  if (tone === 'warning' || tone === 'danger') return 'amber'
  return 'indigo'
}

export function resolveInfoCardKicker(tone?: string | null): string {
  if (tone === 'success') return '结论'
  if (tone === 'warning') return '注意'
  if (tone === 'danger') return '风险'
  return '内容速览'
}

export function compileReadyInfoCard(props: ReadyInfoCardProps): string {
  const align = props.alignment === 'center' ? 'center' : 'left'
  const tone = resolveWidgetToneStyle(props.ramp)
  const toneId = resolveWidgetTone(props.ramp)
  const isQuote = props.decoration === 'quote_mark'
  // 身份行：显式 kicker 优先；引语卡用 QUOTE，其余用 NOTE。语气只换橘点颜色。
  const kickerText = props.kicker || (isQuote ? 'QUOTE' : 'NOTE')
  const kickerTone = toneId === 'ok' ? 'ok' : toneId === 'accent' ? 'accent' : props.kicker ? 'accent' : 'ink'
  const meta = props.facts?.length ? `${props.facts.length} 项速览` : null
  const chrome = `<div data-info-kicker>${renderWidgetChrome({ kicker: kickerText, meta, tone: kickerTone })}</div>`
  // 引语记号用点阵搭成（两组“大点 + 小点”的开引号），与 Ready 的点母题同源。
  const quoteMark = `<svg aria-hidden="true" width="30" height="20" viewBox="0 0 30 20" style="display:block;${align === 'center' ? 'margin:0 auto;' : ''}"><circle cx="6" cy="6" r="4.6" fill="${tone.marker}"/><circle cx="3.6" cy="15" r="2.4" fill="${tone.marker}"/><circle cx="20" cy="6" r="4.6" fill="${tone.marker}"/><circle cx="17.6" cy="15" r="2.4" fill="${tone.marker}"/></svg>`
  const decoration = isQuote
    ? quoteMark
    : props.decoration === 'left_bar' && !props.kicker
      ? `<div class="badge badge--hot" style="align-self:${align === 'center' ? 'center' : 'flex-start'};">重点提示</div>`
      : props.decoration === 'top_divider'
        ? `<div aria-hidden="true" style="height:2px;width:32px;background:${tone.marker};border-radius:999px;${align === 'center' ? 'align-self:center;' : ''}"></div>`
        : ''
  const title = props.title
    ? `<div class="title" style="font-size:21px;line-height:30px;">${escapeHtml(props.title)}</div>`
    : ''
  // 结论：极浅的墨色底，只把结论从正文里托出一层，不抢视觉热点；语气只落在身份行圆点上。
  const lede = isQuote
    ? `<div data-info-lede data-info-quote style="font-size:22px;line-height:34px;letter-spacing:-0.01em;color:${widgetVar('ink')};font-weight:500;text-wrap:pretty;">${escapeRichText(props.body)}</div>`
    : `<div data-info-lede style="padding:16px 20px;border-radius:10px;background:${tone.surface};font-size:15px;line-height:26px;color:${widgetVar('ink')};text-wrap:pretty;">${escapeRichText(props.body)}</div>`
  // 速览：两列对齐 12 栏网格的第 1、7 栏；只靠对齐与留白分组，不画格线。
  const facts = props.facts?.length
    ? `<div data-info-facts class="grid keep-pairs" style="row-gap:20px;">
      ${props.facts.map((fact) => `<div data-info-fact class="span-6" style="min-width:0;text-align:left;">
        <div class="label" style="font-size:10px;">${escapeHtml(fact.label)}</div>
        <div style="margin-top:4px;font-size:13px;line-height:20px;color:${widgetVar('ink')};text-wrap:pretty;">${escapeHtml(fact.value)}</div>
      </div>`).join('')}
    </div>`
    : ''
  const points = props.points?.length
    ? `<div data-info-notes style="font-size:12px;text-align:left;">${renderWidgetLabelRow('补充', `<div style="color:${widgetVar('ink2')};">${renderWidgetDotList(props.points, { size: 12, gap: 4 })}</div>`)}</div>`
    : ''
  const attribution = props.attribution
    ? `<div class="label" style="font-size:10.5px;text-transform:none;letter-spacing:0.04em;">—— ${escapeHtml(props.attribution)}</div>`
    : ''
  const footer = props.footer
    ? `<div data-info-footer>${renderWidgetFoot(props.footer)}</div>`
    : ''

  return `<div class="card stack ready-info-card" data-ready-info-card style="gap:20px;text-align:${align};">
    ${chrome}
    ${(!isQuote && decoration) || title ? `<div class="stack" style="gap:12px;">${isQuote ? '' : decoration}${title}</div>` : ''}
    <div data-fill="center" class="stack" style="gap:24px;">
      ${isQuote ? decoration : ''}
      ${lede}
      ${facts}
      ${isQuote ? attribution : ''}
    </div>
    ${points}
    ${isQuote ? '' : attribution}
    ${footer}
  </div>`
}
