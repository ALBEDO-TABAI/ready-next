import { resolveWidgetToneStyle, widgetVar } from './document-widget-theme'

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
  if (tone === 'info' || tone === 'warning' || tone === 'danger') return 'amber'
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
  const kicker = props.kicker
    ? `<div data-info-kicker style="display:flex;align-items:center;gap:8px;${align === 'center' ? 'justify-content:center;' : ''}"><span class="dot" style="background:${tone.marker};"></span><span class="label">${escapeHtml(props.kicker)}</span></div>`
    : ''
  const decoration = props.decoration === 'quote_mark'
    ? `<div aria-hidden="true" style="font-size:40px;line-height:.72;color:${tone.marker};font-weight:600;">“</div>`
    : props.decoration === 'left_bar' && !props.kicker
      ? `<div class="badge badge--hot" style="align-self:${align === 'center' ? 'center' : 'flex-start'};">重点提示</div>`
      : props.decoration === 'top_divider'
        ? `<div aria-hidden="true" style="height:3px;width:40px;background:${tone.marker};border-radius:999px;${align === 'center' ? 'align-self:center;' : ''}"></div>`
        : ''
  const title = props.title
    ? `<div class="title" style="font-size:21px;line-height:1.25;text-wrap:balance;">${escapeHtml(props.title)}</div>`
    : ''
  const facts = props.facts?.length
    ? `<div data-info-facts style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));column-gap:24px;">
      ${props.facts.map((fact) => `<div data-info-fact style="min-width:0;padding:12px 0 14px;border-top:1px solid ${widgetVar('hair')};text-align:left;">
        <div class="label" style="font-size:10px;">${escapeHtml(fact.label)}</div>
        <div style="margin-top:6px;font-size:13px;line-height:1.65;color:${widgetVar('inkBody')};text-wrap:pretty;">${escapeHtml(fact.value)}</div>
      </div>`).join('')}
    </div>`
    : ''
  const points = props.points?.length
    ? `<div data-info-notes style="display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;padding-top:12px;border-top:1px solid ${widgetVar('hair')};text-align:left;">
      <div class="label" style="font-size:10px;padding-top:2px;">补充</div>
      <ul style="margin:0;padding-left:16px;font-size:12px;line-height:1.65;color:${widgetVar('ink2')};">${props.points.map((point) => `<li style="margin:0 0 5px;">${escapeHtml(point)}</li>`).join('')}</ul>
    </div>`
    : ''
  const attribution = props.attribution
    ? `<div class="muted" style="font-size:12px;line-height:1.5;">${escapeHtml(props.attribution)}</div>`
    : ''
  const footer = props.footer
    ? `<div data-info-footer class="label" style="font-size:11px;line-height:1.5;padding-top:12px;border-top:1px solid ${widgetVar('hair')};">${escapeHtml(props.footer)}</div>`
    : ''

  return `<div class="card stack ready-info-card" data-ready-info-card style="gap:18px;padding:24px;text-align:${align};">
    <div class="stack" style="gap:10px;">
      ${kicker}
      ${decoration}
      ${title}
    </div>
    <div data-info-lede style="padding:14px 16px;border-radius:12px;background:${tone.surface};font-size:15px;line-height:1.7;color:${widgetVar('inkBody')};text-wrap:pretty;">${escapeRichText(props.body)}</div>
    ${facts}
    ${points}
    ${attribution}
    ${footer}
  </div>`
}
