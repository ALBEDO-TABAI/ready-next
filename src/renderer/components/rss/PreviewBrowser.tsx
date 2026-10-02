import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react'
import { useHostedPreviewBounds } from '../../modules/browser/useHostedPreviewBounds'
import { useWorkspace } from '../../stores/useWorkspace'
import { WORKBENCH_SUPPORT_PANEL_WIDTH } from '../../modules/workbench/chrome'
import { requestWorkbenchModeChange } from '../../modules/workbench/mode-transition'
import { BROWSER_OVERLAY_LOCK_EVENT } from '../../modules/overlay/browserViewMask'
import { openRSSItemInBrowserTab } from '../../modules/rss/open-rss-item-in-browser'
import type { RSSItem } from './RSSFeed'
import RssTimeHintBanner from './RssTimeHintBanner'

interface PreviewBrowserProps {
  item: RSSItem
  onClose: () => void
  isActive?: boolean
}

interface PreviewState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}

const defaultPreviewState: PreviewState = {
  url: '',
  title: 'Preview',
  loading: false,
  canGoBack: false,
  canGoForward: false,
}

const EXIT_DURATION_MS = 240
const PREVIEW_OPEN_DELAY_MS = 260

export default function PreviewBrowser({ item, onClose, isActive = true }: PreviewBrowserProps) {
  const [previewState, setPreviewState] = useState<PreviewState>(defaultPreviewState)
  const [isMounted, setIsMounted] = useState(false)
  const [isExiting, setIsExiting] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const raf = requestAnimationFrame(() => setIsMounted(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const sidebarVisible = useWorkspace((state) => state.sidebarVisible)
  const sidePanelVariant = useWorkspace((state) => state.sidePanelVariant)
  const sidePanelWidths = useWorkspace((state) => state.sidePanelWidths)
  const skillsSplitRatio = useWorkspace((state) => state.skillsSplitRatio)
  const chatPanelVisible = useWorkspace((state) => state.chatPanelVisible)
  const chatPanelWidth = useWorkspace((state) => state.chatPanelWidth)
  const effectiveSidePanelWidth = sidePanelWidths.shared

  // While a DOM overlay holds the shared native mask, placing the preview would show it above that overlay.
  const overlayLocked = useRef(false)
  const sendPreviewBounds = useCallback(
    (bounds: { x: number; y: number; width: number; height: number }) => {
      if (overlayLocked.current) return
      void window.electronAPI?.browser?.previewUpdateBounds(bounds)
    },
    [],
  )

  const { scheduleSync: scheduleBoundsSync, flush: flushBoundsSync } = useHostedPreviewBounds({
    hostRef: contentRef,
    isActive,
    sendBounds: sendPreviewBounds,
  })

  useEffect(() => {
    const unsubscribe = window.electronAPI?.browser?.onPreviewUpdate((state) => {
      setPreviewState(state as PreviewState)
    })
    void window.electronAPI?.browser?.previewGetState().then((state) => {
      setPreviewState(state as PreviewState)
    })
    return () => {
      unsubscribe?.()
    }
  }, [])

  useEffect(() => {
    if (!isActive) {
      void window.electronAPI?.browser?.previewClose()
      return
    }
    setPreviewState((prev) => ({ ...prev, loading: true, error: undefined }))
    const timer = window.setTimeout(() => {
      void window.electronAPI?.browser?.previewOpen({ url: item.link })
      requestAnimationFrame(() => {
        scheduleBoundsSync({ force: true, trailingFinal: true })
      })
    }, PREVIEW_OPEN_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [isActive, item.id, item.link, scheduleBoundsSync])

  useEffect(() => {
    if (!isActive) return
    scheduleBoundsSync({ force: true, trailingFinal: true })
  }, [
    chatPanelVisible,
    chatPanelWidth,
    effectiveSidePanelWidth,
    sidebarVisible,
    sidePanelVariant,
    skillsSplitRatio,
    isActive,
    scheduleBoundsSync,
  ])

  useEffect(() => {
    return () => {
      flushBoundsSync()
      void window.electronAPI?.browser?.previewClose()
    }
  }, [flushBoundsSync])

  const handleClose = useCallback(() => {
    void window.electronAPI?.browser?.previewClose()
    setIsExiting(true)
    window.setTimeout(() => {
      onClose()
    }, EXIT_DURATION_MS)
  }, [onClose])

  // 原生预览在 DOM 浮层（菜单、对话框）出现时会被统一隐藏；浮层收起后按当前位置重新放回。
  useEffect(() => {
    if (!isActive) return
    const restore = (event: Event) => {
      const locked = (event as CustomEvent<{ locked?: boolean }>).detail?.locked
      if (locked === true) overlayLocked.current = true
      if (locked !== false) return
      overlayLocked.current = false
      scheduleBoundsSync({ force: true, trailingFinal: true })
    }
    window.addEventListener(BROWSER_OVERLAY_LOCK_EVENT, restore)
    return () => window.removeEventListener(BROWSER_OVERLAY_LOCK_EVENT, restore)
  }, [isActive, scheduleBoundsSync])

  // 转到浏览器模块时带上预览里当前所在的页面，而不只是文章链接。
  const handleOpenBrowserMode = useCallback(async () => {
    const opened = await openRSSItemInBrowserTab({ link: previewState.url || item.link, title: previewState.title && previewState.title !== 'Preview' ? previewState.title : item.title })
    if (!opened) return
    requestWorkbenchModeChange('browser')
    void window.electronAPI?.browser?.previewClose()
    onClose()
  }, [item.link, item.title, onClose, previewState.title, previewState.url])

  const floatingStateClass = isExiting ? 'is-exiting' : isMounted ? 'is-entered' : ''

  return (
    <div
      className={`rss-preview-floating content-surface-panel rss-preview-surface flex flex-col ${floatingStateClass}`}
      role="region"
      aria-label="原文预览"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: `calc(100% - ${WORKBENCH_SUPPORT_PANEL_WIDTH}px)`,
        minWidth: 480,
        background: 'var(--workbench-module-surface-bg)',
        borderRadius: 'var(--workbench-canvas-radius) 0 0 var(--workbench-canvas-radius)',
        overflow: 'hidden',
        isolation: 'isolate',
        boxShadow: '-18px 0 44px -16px rgba(8,12,22,0.32)',
        zIndex: 30,
      }}
    >
      <div className="rss-preview-toolbar">
        <button type="button" className="rss-btn rss-btn--icon" onClick={handleClose} title="关闭预览" aria-label="关闭预览">
          <X size={15} strokeWidth={1.9} />
        </button>
        <button type="button" className="rss-btn rss-btn--icon" onClick={() => void window.electronAPI?.browser?.previewGoBack()} disabled={!previewState.canGoBack} title="后退" aria-label="后退">
          <ChevronLeft size={16} strokeWidth={1.9} />
        </button>
        <button type="button" className="rss-btn rss-btn--icon" onClick={() => void window.electronAPI?.browser?.previewGoForward()} disabled={!previewState.canGoForward} title="前进" aria-label="前进">
          <ChevronRight size={16} strokeWidth={1.9} />
        </button>
        <button type="button" className="rss-btn rss-btn--icon" onClick={() => void window.electronAPI?.browser?.previewReload()} title="刷新" aria-label="刷新">
          <RefreshCw size={14} strokeWidth={1.9} className={previewState.loading ? 'animate-spin' : ''} />
        </button>
        <span className="rss-preview-url" title={previewState.url || item.link}>{previewState.url || item.link}</span>
        {/* L5-B — RSS → calendar event hint: renders nothing unless the article mentions a time. */}
        <RssTimeHintBanner
          itemId={item.id}
          title={item.title}
          summary={item.summary}
          author={item.author}
          publishedAt={item.publishedAt}
        />
        <button type="button" className="rss-btn" onClick={() => void handleOpenBrowserMode()} title="在浏览器模块打开当前页面">
          <ExternalLink size={14} strokeWidth={1.9} />浏览器模式
        </button>
      </div>

      <div ref={contentRef} data-ready-native-surface="browser" className="rss-preview-content flex-1 relative overflow-hidden" style={{ background: 'transparent' }}>
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 'var(--workbench-canvas-radius)',
            height: 'var(--workbench-canvas-radius)',
            borderBottomRightRadius: 'var(--workbench-canvas-radius)',
            background: 'var(--workbench-module-surface-bg)',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        />
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            bottom: 0,
            width: 'var(--workbench-canvas-radius)',
            height: 'var(--workbench-canvas-radius)',
            borderTopRightRadius: 'var(--workbench-canvas-radius)',
            background: 'var(--workbench-module-surface-bg)',
            pointerEvents: 'none',
            zIndex: 2,
          }}
        />
        {previewState.loading && !previewState.error && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center"
            style={{ background: 'color-mix(in srgb, var(--workbench-module-surface-bg) 90%, transparent)' }}
          >
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="w-6 h-6 text-[var(--text-light)] animate-spin" />
              <span className="text-[12px] text-[var(--text-muted)]">正在打开原文…</span>
            </div>
          </div>
        )}

        {previewState.error && (
          <div className="h-full overflow-auto p-8">
            <div className="max-w-[680px] mx-auto">
              <h1 className="text-[20px] font-semibold text-[var(--text-title)] mb-3">{item.title}</h1>
              <p className="mb-6 text-[12px] text-[var(--text-muted)]">原文暂时无法在预览中打开：{previewState.error}</p>
              <button type="button" className="sx-btn sx-btn--primary sx-btn--sm" onClick={() => void handleOpenBrowserMode()}>
                <ExternalLink size={14} strokeWidth={1.9} />
                在浏览器模块中打开
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
