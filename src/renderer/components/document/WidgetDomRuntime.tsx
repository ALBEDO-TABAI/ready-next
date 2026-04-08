import { useEffect, useRef } from 'react'
import { getWidgetIframeStyleBlock, resolveWidgetThemePayload } from './widget-css-bridge'
import {
  buildScopedWidgetInlineScript,
  collectInlineHandlerNames,
  invokeInlineHandlerExpression,
} from './widget-dom-script-runtime'
import { clampNumericInputValue } from './widget-runtime-helpers'
import { applyWidgetPersistedState, collectWidgetPersistedState, type DocumentWidgetPersistedState } from './widget-state-runtime'
import { appendWidgetMessageToAgentInput } from '../../modules/agent/chat-input-bridge'

interface WidgetDomRuntimeProps {
  title?: string
  widgetCode: string
  widgetState?: DocumentWidgetPersistedState | null
  onStateChange?: (state: DocumentWidgetPersistedState) => void
  onOpenHref: (href: string) => void
  onRuntimeError?: (message: string) => void
}

const WIDGET_RUNTIME_NONCE = 'cmVhZHktd2lkZ2V0'

function executeScripts(container: HTMLElement): Promise<void> {
  const scripts = Array.from(container.querySelectorAll('script'))
  const exportedHandlerNames = collectInlineHandlerNames(container)
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
        next.textContent = buildScopedWidgetInlineScript(oldScript.textContent || '', exportedHandlerNames)
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
  title,
  widgetCode,
  widgetState,
  onStateChange,
  onOpenHref,
  onRuntimeError,
}: WidgetDomRuntimeProps) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const widgetWindow = window as typeof window & {
      __readyWidgetSendMessage?: (text: string) => void
    }

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

      applyWidgetPersistedState(container, widgetState)
      window.setTimeout(() => {
        onStateChange?.(collectWidgetPersistedState(container))
      }, 0)
    }

    const handleClick = (event: Event) => {
      const target = event.target as HTMLElement | null
      const messageNode = target?.closest?.('[data-ready-agent-message]') as HTMLElement | null
      const widgetMessage = messageNode?.getAttribute('data-ready-agent-message')?.trim()
      if (widgetMessage) {
        event.preventDefault()
        appendWidgetMessageToAgentInput(widgetMessage, title)
        return
      }
      const link = target?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!link?.href) return
      if (/^\s*javascript\s*:/i.test(link.href)) return
      event.preventDefault()
      onOpenHref(link.href)
      return
    }

    const container = host.querySelector('.widget-root')
    if (container instanceof HTMLElement) {
      window.setTimeout(() => onStateChange?.(collectWidgetPersistedState(container)), 0)
    }

    const invokeInlineHandler = (target: EventTarget | null, attr: string, event: Event) => {
      if (!(target instanceof HTMLElement)) return
      invokeInlineHandlerExpression(target.getAttribute(attr), widgetWindow as unknown as Record<string, unknown>, event)
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

    const handleInput = (event: Event) => {
      handleNumericBounds(event)
      invokeInlineHandler(event.target, 'oninput', event)
      const container = host.querySelector('.widget-root')
      if (container instanceof HTMLElement) {
        window.setTimeout(() => onStateChange?.(collectWidgetPersistedState(container)), 0)
      }
    }

    const handleChange = (event: Event) => {
      handleNumericBounds(event)
      invokeInlineHandler(event.target, 'onchange', event)
      const container = host.querySelector('.widget-root')
      if (container instanceof HTMLElement) {
        window.setTimeout(() => onStateChange?.(collectWidgetPersistedState(container)), 0)
      }
    }

    const previousBridge = widgetWindow.__readyWidgetSendMessage
    const nextBridge = (text: string) => {
      appendWidgetMessageToAgentInput(text, title)
    }
    widgetWindow.__readyWidgetSendMessage = nextBridge

    renderRuntime()
    host.addEventListener('click', handleClick)
    host.addEventListener('input', handleInput, true)
    host.addEventListener('change', handleChange, true)

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
      host.removeEventListener('input', handleInput, true)
      host.removeEventListener('change', handleChange, true)
      if (widgetWindow.__readyWidgetSendMessage === nextBridge) {
        widgetWindow.__readyWidgetSendMessage = previousBridge
      }
    }
  }, [onOpenHref, onRuntimeError, onStateChange, title, widgetCode, widgetState])

  return <div ref={hostRef} className="document-widget-dom-runtime" />
}
