import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { buildWidgetBaseStyleCss } from '../../../shared/document-widget-theme'
import { openWebpageInBrowser } from '../../modules/browser/openWebpageInBrowser'
import { sanitizeBookWidgetStaticHtml } from '../../modules/document/book/bookWidgetStatic'
import { resolveWidgetThemePayload, type WidgetBackgroundMode } from './widget-css-bridge'
import { subscribeWidgetThemeChanges } from './widget-theme-observer'

/**
 * Widget 的静态投影：与 iframe 同一套令牌和基线类层，去脚本、去事件后放进受约束
 * 的 ShadowRoot。用于组件较多时的休眠态与 iframe 就绪前的占位——读者先看到完整
 * 构图，交互运行时按需再挂载。与书本阅读的静态投影共用同一净化入口。
 *
 * ShadowRoot 标记 clonable + serializable：PDF 导出克隆预览后按声明式 shadow DOM
 * 序列化，静态卡片随文档一起打印。
 */

function buildStaticStyle(backgroundMode: WidgetBackgroundMode): string {
  const payload = resolveWidgetThemePayload({ backgroundMode })
  const vars = Object.entries(payload.vars)
    .filter(([, value]) => value.length > 0)
    .map(([key, value]) => `${key}:${value};`)
    .join('')
  return `:host{display:block;min-width:0;contain:layout paint style;color-scheme:${payload.isDark ? 'dark' : 'light'};${vars}}
${buildWidgetBaseStyleCss({ backgroundMode, surface: 'document' })}`
}

export default function WidgetStaticProjection({
  widgetCode,
  backgroundMode,
}: {
  widgetCode: string
  backgroundMode: WidgetBackgroundMode
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [themeEpoch, setThemeEpoch] = useState(0)

  useEffect(() => subscribeWidgetThemeChanges(() => setThemeEpoch((epoch) => epoch + 1)), [])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const shadow = host.shadowRoot ?? host.attachShadow({
      mode: 'open',
      clonable: true,
      serializable: true,
    } as ShadowRootInit)
    shadow.innerHTML = `<style>${buildStaticStyle(backgroundMode)}</style><div class="widget-root">${sanitizeBookWidgetStaticHtml(widgetCode)}</div>`
  }, [backgroundMode, themeEpoch, widgetCode])

  useEffect(() => {
    const shadow = hostRef.current?.shadowRoot
    if (!shadow) return
    const handleClick = (event: Event) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]')
      if (!(anchor instanceof HTMLAnchorElement)) return
      event.preventDefault()
      const href = anchor.href
      if (/^https?:/i.test(href)) void openWebpageInBrowser(href)
    }
    shadow.addEventListener('click', handleClick)
    return () => shadow.removeEventListener('click', handleClick)
  }, [widgetCode])

  return <div ref={hostRef} className="document-widget-static-projection" data-widget-static-projection="true" />
}
