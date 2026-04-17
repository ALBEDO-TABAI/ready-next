import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { browserTabActivationSequencer } from '../../modules/browser/browserTabActivationSequencer'
import { useBrowserTabs } from '../../stores/useBrowserTabs'
import { useMode } from '../../stores/useMode'
import { getWidgetIframeStyleBlock, resolveWidgetThemePayload } from './widget-css-bridge'
import { buildWidgetReceiverSrcdoc, sanitizeWidgetHtml, stripWidgetScripts } from './widget-sanitizer'
import { appendWidgetMessageToAgentInput } from '../../modules/agent/chat-input-bridge'
import type { DocumentWidgetPersistedState } from './widget-state-runtime'
import { widgetNeedsManualPreview } from './widget-card-helpers'

interface WidgetRendererProps {
  title?: string
  widgetCode: string
  widgetState?: DocumentWidgetPersistedState | null
  onWidgetStateChange?: (state: DocumentWidgetPersistedState) => void
  preferManualPreview?: boolean
}

const MAX_IFRAME_HEIGHT = 2000
const widgetHeightCache = new Map<string, number>()

function getCacheKey(code: string): string {
  return code.slice(0, 200)
}

export default function WidgetRenderer({
  title,
  widgetCode,
  widgetState,
  onWidgetStateChange,
  preferManualPreview = false,
}: WidgetRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const widgetTokenRef = useRef(`widget-${Math.random().toString(36).slice(2, 10)}`)
  const [receiverReady, setReceiverReady] = useState(false)
  const [height, setHeight] = useState(() => widgetHeightCache.get(getCacheKey(widgetCode)) || 180)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [showSandboxFallback, setShowSandboxFallback] = useState(false)
  const manualPreviewRequired = useMemo(
    () => preferManualPreview || widgetNeedsManualPreview(widgetCode),
    [preferManualPreview, widgetCode],
  )
  const [manualPreviewEnabled, setManualPreviewEnabled] = useState(() => !manualPreviewRequired)

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
        return
      }

      if (event.data.type === 'widget:state' && event.data.state && typeof event.data.state === 'object') {
        onWidgetStateChange?.(event.data.state as DocumentWidgetPersistedState)
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [onWidgetStateChange, openHref, postTheme, sanitizedWidgetCode.length, title, widgetCode.length])

  useEffect(() => {
    setReceiverReady(false)
    setRenderError(null)
    setShowSandboxFallback(false)
  }, [srcDoc, widgetCode])

  useEffect(() => {
    setManualPreviewEnabled(!manualPreviewRequired)
  }, [manualPreviewRequired, widgetCode])

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
    if (!receiverReady) return
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    iframe.contentWindow.postMessage(
      { type: 'widget:hydrate', state: widgetState || null, token: widgetTokenRef.current },
      '*',
    )
  }, [receiverReady, widgetState])

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
      {!manualPreviewEnabled ? (
        <div className="document-widget-fallback-shell">
          <div className="document-widget-fallback-note">
            {preferManualPreview
              ? '当前文档里的组件较多，默认不自动渲染，避免拖垮当前文档页面。'
              : '这个组件内容较重，默认不自动渲染，避免拖垮当前文档页面。'}
          </div>
          <button
            type="button"
            className="ready-doc-widget-card-action"
            onClick={() => {
              setManualPreviewEnabled(true)
            }}
          >
            启用预览
          </button>
        </div>
      ) : null}
      {renderError ? (
        <div className="document-widget-error">
          <AlertTriangle style={{ width: 16, height: 16 }} strokeWidth={2} />
          <span>{renderError}</span>
        </div>
      ) : null}
      {manualPreviewEnabled ? (
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
      ) : null}
      {(manualPreviewEnabled && (showSandboxFallback || renderError)) ? (
        <div className="document-widget-fallback-shell">
          <div className="document-widget-fallback-note">
            {renderError
              ? '脚本交互预览出现错误，已显示静态回退内容。'
              : '交互预览加载较慢，先显示静态回退内容。'}
          </div>
          {staticFallbackHtml.trim().length > 0 ? (
            <div
              className="document-widget-static"
              dangerouslySetInnerHTML={{ __html: staticFallbackHtml }}
            />
          ) : (
            <div className="document-widget-fallback-note">
              当前组件暂时无法展示静态回退内容。
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
