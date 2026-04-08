import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { browserTabActivationSequencer } from '../../modules/browser/browserTabActivationSequencer'
import { useBrowserTabs } from '../../stores/useBrowserTabs'
import { useMode } from '../../stores/useMode'
import { getWidgetIframeStyleBlock, resolveWidgetThemePayload } from './widget-css-bridge'
import { buildWidgetReceiverSrcdoc, sanitizeWidgetHtml, stripWidgetScripts } from './widget-sanitizer'
import WidgetDomRuntime from './WidgetDomRuntime'
import { appendWidgetMessageToAgentInput } from '../../modules/agent/chat-input-bridge'

interface WidgetRendererProps {
  title?: string
  widgetCode: string
}

const MAX_IFRAME_HEIGHT = 2000
const widgetHeightCache = new Map<string, number>()

function getCacheKey(code: string): string {
  return code.slice(0, 200)
}

export default function WidgetRenderer({ title, widgetCode }: WidgetRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const widgetTokenRef = useRef(`widget-${Math.random().toString(36).slice(2, 10)}`)
  const [receiverReady, setReceiverReady] = useState(false)
  const [height, setHeight] = useState(() => widgetHeightCache.get(getCacheKey(widgetCode)) || 180)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [showSandboxFallback, setShowSandboxFallback] = useState(false)

  const sanitizedWidgetCode = useMemo(() => sanitizeWidgetHtml(widgetCode), [widgetCode])
  const staticFallbackHtml = useMemo(() => stripWidgetScripts(sanitizedWidgetCode), [sanitizedWidgetCode])
  const themePayload = useMemo(() => resolveWidgetThemePayload(), [])
  const srcDoc = useMemo(() => {
    const styleBlock = getWidgetIframeStyleBlock(themePayload.vars)
    return buildWidgetReceiverSrcdoc(styleBlock, themePayload.isDark, sanitizedWidgetCode, widgetTokenRef.current)
  }, [sanitizedWidgetCode, themePayload])
  const openHref = useCallback(async (href: string) => {
    if (window.electronAPI?.browser?.createTab) {
      const result = await window.electronAPI.browser.createTab(href)
      if (result?.success && result.tabId) {
        const browserTabs = useBrowserTabs.getState()
        if (!browserTabs.tabs.some((tab) => tab.id === result.tabId)) {
          browserTabs.addTab({
            id: result.tabId,
            url: href,
            title: result.title || href,
            loading: true,
            canGoBack: false,
            canGoForward: false,
          })
        }
        browserTabActivationSequencer.invalidate()
        browserTabs.setActiveTabId(result.tabId)
        browserTabs.setUrlInput(href)
        useMode.getState().setWorkbenchMode('browser')
        return
      }
    }

    window.open(href, '_blank', 'noopener,noreferrer')
  }, [])
  const postTheme = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    const payload = resolveWidgetThemePayload()
    iframe.contentWindow.postMessage(
      { type: 'widget:theme', vars: payload.vars, isDark: payload.isDark },
      '*',
    )
  }, [])

  useLayoutEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!event.data || typeof event.data.type !== 'string') return
      if (event.data.token !== widgetTokenRef.current) return

      if (event.data.type === 'widget:ready') {
        setReceiverReady(true)
        setShowSandboxFallback(false)
        setRenderError(null)
        postTheme()
        return
      }

      if (event.data.type === 'widget:resize' && typeof event.data.height === 'number') {
        const nextHeight = Math.max(120, Math.min(MAX_IFRAME_HEIGHT, Math.ceil(event.data.height)))
        widgetHeightCache.set(getCacheKey(widgetCode), nextHeight)
        setHeight(nextHeight)
        if (nextHeight > 140) {
          setShowSandboxFallback(false)
        }
        return
      }

      if (event.data.type === 'widget:error' && typeof event.data.message === 'string') {
        setRenderError(event.data.message)
        return
      }

      if (event.data.type === 'widget:message' && typeof event.data.text === 'string') {
        appendWidgetMessageToAgentInput(event.data.text, title)
        return
      }

      if (event.data.type === 'widget:link' && typeof event.data.href === 'string') {
        void openHref(event.data.href)
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [openHref, postTheme, sanitizedWidgetCode.length, title, widgetCode.length])

  useEffect(() => {
    setReceiverReady(false)
    setRenderError(null)
    setShowSandboxFallback(false)
  }, [srcDoc, widgetCode])

  useEffect(() => {
    if (!receiverReady) return

    const observer = new MutationObserver(() => {
      postTheme()
    })

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-skin'],
    })

    return () => observer.disconnect()
  }, [postTheme, receiverReady])

  useEffect(() => {
    if (receiverReady) return

    const timer = window.setTimeout(() => {
      setShowSandboxFallback(true)
    }, 180)
    return () => window.clearTimeout(timer)
  }, [receiverReady, widgetCode])

  return (
    <div className="document-widget-shell">
      {title ? <div className="document-widget-title">{title}</div> : null}
      {renderError ? (
        <div className="document-widget-error">
          <AlertTriangle style={{ width: 16, height: 16 }} strokeWidth={2} />
          <span>{renderError}</span>
        </div>
      ) : null}
      <iframe
        ref={iframeRef}
        title={title || 'Document widget'}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        className="document-widget-frame"
        style={{
          height: showSandboxFallback ? 0 : height,
          display: showSandboxFallback ? 'none' : 'block',
        }}
      />
      {(showSandboxFallback || renderError) ? (
        <div className="document-widget-fallback-shell">
          {renderError ? (
            <div className="document-widget-fallback-note">
              脚本交互预览出现错误，已显示静态回退内容。
            </div>
          ) : null}
          <WidgetDomRuntime
            title={title}
            widgetCode={sanitizedWidgetCode}
            onOpenHref={(href) => {
              void openHref(href)
            }}
            onRuntimeError={(message) => {
              console.error('[DocumentWidget] dom runtime error', { title, message })
            }}
          />
          {renderError && staticFallbackHtml.trim().length > 0 ? (
            <div
              className="document-widget-static"
              dangerouslySetInnerHTML={{ __html: staticFallbackHtml }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
