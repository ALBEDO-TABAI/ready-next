import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { openWebpageInBrowser } from '../../modules/browser/openWebpageInBrowser'
import {
  getWidgetIframeStyleBlock,
  resolveWidgetThemePayload,
  type WidgetBackgroundMode,
} from './widget-css-bridge'
import { buildWidgetReceiverSrcdoc, sanitizeWidgetHtml } from './widget-sanitizer'
import WidgetStaticProjection from './WidgetStaticProjection'
import { appendWidgetMessageToAgentInput } from '../../modules/agent/chat-input-bridge'
import type { DocumentWidgetPersistedState } from './widget-state-runtime'
import { widgetHasInteractiveRuntime, widgetNeedsManualPreview } from './widget-card-helpers'
import { subscribeWidgetThemeChanges } from './widget-theme-observer'
import { BoundedLruCache } from '../../../shared/bounded-lru'

interface WidgetRendererProps {
  title?: string
  widgetCode: string
  widgetState?: DocumentWidgetPersistedState | null
  onWidgetStateChange?: (state: DocumentWidgetPersistedState) => void
  preferManualPreview?: boolean
  /**
   * 受控的交互预览开关：由外层（文档卡片题注）决定何时挂载 iframe；
   * 省略时组件自管休眠态，并在卡下给出启用入口。
   */
  previewEnabled?: boolean
  backgroundMode?: WidgetBackgroundMode
}

const TRANSPARENT_BG_MARKER = /data-widget-bg=["']transparent["']/i

function inferBackgroundMode(
  explicit: WidgetBackgroundMode | undefined,
  widgetCode: string,
): WidgetBackgroundMode {
  if (explicit === 'transparent' || explicit === 'opaque') return explicit
  return TRANSPARENT_BG_MARKER.test(widgetCode) ? 'transparent' : 'opaque'
}

const MAX_IFRAME_HEIGHT = 2000
const widgetHeightCache = new BoundedLruCache<string, number>(96)

function getCacheKey(code: string): string {
  let first = 2166136261
  let second = 0x9e3779b9
  for (let index = 0; index < code.length; index += 1) {
    const value = code.charCodeAt(index)
    first = Math.imul(first ^ value, 16777619)
    second = Math.imul(second ^ value, 2246822519)
  }
  return `${code.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`
}

export default function WidgetRenderer({
  title,
  widgetCode,
  widgetState,
  onWidgetStateChange,
  preferManualPreview = false,
  previewEnabled,
  backgroundMode,
}: WidgetRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const widgetTokenRef = useRef(`widget-${Math.random().toString(36).slice(2, 10)}`)
  const [receiverReady, setReceiverReady] = useState(false)
  const [height, setHeight] = useState(() => widgetHeightCache.get(getCacheKey(widgetCode)) || 180)
  const [renderError, setRenderError] = useState<string | null>(null)
  const manualPreviewRequired = useMemo(
    () => preferManualPreview || widgetNeedsManualPreview(widgetCode),
    [preferManualPreview, widgetCode],
  )
  const [internalPreviewEnabled, setManualPreviewEnabled] = useState(() => !manualPreviewRequired)
  const isControlled = typeof previewEnabled === 'boolean'
  const manualPreviewEnabled = isControlled ? previewEnabled : internalPreviewEnabled

  const sanitizedWidgetCode = useMemo(() => sanitizeWidgetHtml(widgetCode), [widgetCode])
  const hasInteractiveRuntime = useMemo(() => widgetHasInteractiveRuntime(sanitizedWidgetCode), [sanitizedWidgetCode])
  const resolvedBackgroundMode = useMemo<WidgetBackgroundMode>(
    () => inferBackgroundMode(backgroundMode, sanitizedWidgetCode),
    [backgroundMode, sanitizedWidgetCode],
  )
  const themePayload = useMemo(
    () => resolveWidgetThemePayload({ backgroundMode: resolvedBackgroundMode }),
    [resolvedBackgroundMode],
  )
  const srcDoc = useMemo(() => {
    const styleBlock = getWidgetIframeStyleBlock(themePayload.vars, {
      backgroundMode: resolvedBackgroundMode,
      surface: 'document',
    })
    return buildWidgetReceiverSrcdoc(styleBlock, themePayload.isDark, sanitizedWidgetCode, widgetTokenRef.current)
  }, [sanitizedWidgetCode, themePayload, resolvedBackgroundMode])
  const openHref = useCallback(async (href: string) => {
    await openWebpageInBrowser(href)
  }, [])
  const postTheme = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    const payload = resolveWidgetThemePayload({ backgroundMode: resolvedBackgroundMode })
    iframe.contentWindow.postMessage(
      { type: 'widget:theme', vars: payload.vars, isDark: payload.isDark },
      '*',
    )
  }, [resolvedBackgroundMode])

  useLayoutEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (!event.data || typeof event.data.type !== 'string') return
      if (event.data.token !== widgetTokenRef.current) return

      if (event.data.type === 'widget:ready') {
        setReceiverReady(true)
        setRenderError(null)
        postTheme()
        return
      }

      if (event.data.type === 'widget:resize' && typeof event.data.height === 'number') {
        const nextHeight = Math.max(120, Math.min(MAX_IFRAME_HEIGHT, Math.ceil(event.data.height)))
        widgetHeightCache.set(getCacheKey(widgetCode), nextHeight)
        setHeight(nextHeight)
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
  }, [onWidgetStateChange, openHref, postTheme, sanitizedWidgetCode.length, title, widgetCode])

  useEffect(() => {
    setReceiverReady(false)
    setRenderError(null)
  }, [srcDoc, widgetCode])

  useEffect(() => {
    setManualPreviewEnabled(!manualPreviewRequired)
  }, [manualPreviewRequired, widgetCode])

  useEffect(() => {
    if (!receiverReady) return
    return subscribeWidgetThemeChanges(postTheme)
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

  // 舞台：static = 休眠（只显示静态投影）；loading = iframe 在投影下方就绪；
  // live = 交互运行时接管；error = 运行时报错，保留静态投影并说明原因。
  const liveVisible = manualPreviewEnabled && receiverReady && !renderError
  const stage = !manualPreviewEnabled ? 'static' : renderError ? 'error' : liveVisible ? 'live' : 'loading'

  return (
    <div className="document-widget-shell" data-widget-stage={stage}>
      {title ? <div className="document-widget-title">{title}</div> : null}
      {!liveVisible ? (
        <WidgetStaticProjection widgetCode={sanitizedWidgetCode} backgroundMode={resolvedBackgroundMode} />
      ) : null}
      {!isControlled && !manualPreviewEnabled && hasInteractiveRuntime ? (
        <div className="document-widget-fallback-shell document-widget-activate">
          <button
            type="button"
            className="document-widget-activate-button"
            onClick={() => {
              setManualPreviewEnabled(true)
            }}
          >
            <span className="document-widget-activate-dot" aria-hidden="true" />
            启用交互预览
          </button>
          <span className="document-widget-fallback-note">
            {preferManualPreview ? '组件较多，先以静态方式呈现' : '内容较重，先以静态方式呈现'}
          </span>
        </div>
      ) : null}
      {renderError ? (
        <div className="document-widget-error">
          <AlertTriangle style={{ width: 14, height: 14 }} strokeWidth={2} />
          <span>交互预览出错，已保留静态内容：{renderError}</span>
        </div>
      ) : null}
      {manualPreviewEnabled ? (
        <iframe
          ref={iframeRef}
          title={title || 'Document widget'}
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          className="document-widget-frame"
          data-widget-frame-ready={liveVisible ? 'true' : undefined}
          aria-hidden={liveVisible ? undefined : true}
          tabIndex={liveVisible ? undefined : -1}
          style={{ height }}
        />
      ) : null}
    </div>
  )
}
