import { useEffect, useRef } from 'react'
import { getWidgetIframeStyleBlock, resolveWidgetThemePayload } from './widget-css-bridge'
import { clampNumericInputValue } from './widget-runtime-helpers'

interface WidgetDomRuntimeProps {
  widgetCode: string
  onOpenHref: (href: string) => void
  onRuntimeError?: (message: string) => void
}

const WIDGET_RUNTIME_NONCE = 'cmVhZHktd2lkZ2V0'

function executeScripts(container: HTMLElement): Promise<void> {
  const scripts = Array.from(container.querySelectorAll('script'))
  let chain = Promise.resolve()

  scripts.forEach((oldScript) => {
    chain = chain.then(() => new Promise<void>((resolve) => {
      const next = document.createElement('script')
      next.setAttribute('nonce', 'cmVhZHktd2lkZ2V0')
      Array.from(oldScript.attributes).forEach((attr) => {
        next.setAttribute(attr.name, attr.value)
      })
      if (oldScript.src) {
        next.onload = () => resolve()
        next.onerror = () => resolve()
      } else {
        next.textContent = oldScript.textContent
      }
      oldScript.replaceWith(next)
      if (!oldScript.src) {
        resolve()
      }
    }))
  })

  return chain
}

export default function WidgetDomRuntime({
  widgetCode,
  onOpenHref,
  onRuntimeError,
}: WidgetDomRuntimeProps) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const renderRuntime = () => {
      const themePayload = resolveWidgetThemePayload()
      host.innerHTML = ''

      const style = document.createElement('style')
      style.setAttribute('nonce', WIDGET_RUNTIME_NONCE)
      style.textContent = `${getWidgetIframeStyleBlock(themePayload.vars)}
.document-widget-dom-runtime {
  display: block;
  width: 100%;
}
`
      const container = document.createElement('div')
      container.className = 'widget-root'
      container.innerHTML = widgetCode

      host.append(style, container)

      executeScripts(container).catch((error) => {
        onRuntimeError?.(error instanceof Error ? error.message : String(error))
      })
    }

    const handleClick = (event: Event) => {
      const target = event.target as HTMLElement | null
      const link = target?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!link?.href) return
      if (/^\s*javascript\s*:/i.test(link.href)) return
      event.preventDefault()
      onOpenHref(link.href)
    }

    const handleNumericBounds = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLInputElement)) return
      if (target.type !== 'number') return
      const next = clampNumericInputValue(
        target.value,
        target.getAttribute('min'),
        target.getAttribute('max'),
      )
      if (next !== target.value) {
        target.value = next
      }
    }

    renderRuntime()
    host.addEventListener('click', handleClick)
    host.addEventListener('input', handleNumericBounds, true)
    host.addEventListener('change', handleNumericBounds, true)

    const observer = new MutationObserver(() => {
      renderRuntime()
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-skin'],
    })

    return () => {
      observer.disconnect()
      host.removeEventListener('click', handleClick)
      host.removeEventListener('input', handleNumericBounds, true)
      host.removeEventListener('change', handleNumericBounds, true)
    }
  }, [onOpenHref, onRuntimeError, widgetCode])

  return <div ref={hostRef} className="document-widget-dom-runtime" />
}
