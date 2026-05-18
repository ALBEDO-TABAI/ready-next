import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react'
import { browserTabActivationSequencer } from '../../modules/browser/browserTabActivationSequencer'
import { useHostedPreviewBounds } from '../../modules/browser/useHostedPreviewBounds'
import { useWorkspace } from '../../stores/useWorkspace'
import { useBrowserTabs } from '../../stores/useBrowserTabs'
import { WORKBENCH_SUPPORT_PANEL_WIDTH } from '../../modules/workbench/chrome'
import { requestWorkbenchModeChange } from '../../modules/workbench/mode-transition'
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

  const sendPreviewBounds = useCallback(
    (bounds: { x: number; y: number; width: number; height: number }) => {
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

  const handleOpenBrowserMode = useCallback(async () => {
    const result = (await window.electronAPI?.browser?.createTab(item.link)) as
      | { success: boolean; tabId?: string }
      | undefined

    if (result?.success && result.tabId) {
      useBrowserTabs.getState().addTab({
        id: result.tabId,
        url: item.link,
        title: item.title || 'Loading...',
        loading: true,
        canGoBack: false,
        canGoForward: false,
      })
      browserTabActivationSequencer.invalidate()
      useBrowserTabs.getState().setActiveTabId(result.tabId)
      useBrowserTabs.getState().setUrlInput(item.link)
      requestWorkbenchModeChange('browser')
      void window.electronAPI?.browser?.previewClose()
      onClose()
    }
  }, [item.link, item.title, onClose])

  const floatingStateClass = isExiting ? 'is-exiting' : isMounted ? 'is-entered' : ''

  return (
    <div
      className={`rss-preview-floating content-surface-panel rss-preview-surface flex flex-col ${floatingStateClass}`}
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
      <div
        className="glass-surface-panel flex items-center justify-between flex-shrink-0"
        style={{
          height: 38,
          padding: '0 12px',
          background: 'var(--surface-toolbar-bg)',
          borderBottom: '1px solid var(--border-default)',
        }}
      >
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <button
            onClick={handleClose}
            className="p-1.5 rounded hover:bg-black/5 transition-colors flex-shrink-0"
            title="关闭预览"
          >
            <X className="w-4 h-4 text-[var(--text-muted)]" strokeWidth={2} />
          </button>
          <button
            onClick={() => void window.electronAPI?.browser?.previewGoBack()}
            disabled={!previewState.canGoBack}
            className="p-1.5 rounded hover:bg-black/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="后退"
          >
            <ChevronLeft className="w-4 h-4 text-[var(--text-muted)]" strokeWidth={2} />
          </button>
          <button
            onClick={() => void window.electronAPI?.browser?.previewGoForward()}
            disabled={!previewState.canGoForward}
            className="p-1.5 rounded hover:bg-black/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="前进"
          >
            <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" strokeWidth={2} />
          </button>
          <button
            onClick={() => void window.electronAPI?.browser?.previewReload()}
            className="p-1.5 rounded hover:bg-black/5 transition-colors"
            title="刷新"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-[var(--text-muted)] ${previewState.loading ? 'animate-spin' : ''}`} />
          </button>
          <div className="glass-surface-card flex-1 min-w-0 px-2 py-1 rounded bg-[var(--surface-card-bg)] border border-[var(--border-default)]">
            <span className="text-[11px] text-[var(--text-muted)] truncate block">
              {previewState.url || item.link}
            </span>
          </div>
        </div>
        {/* L5-B — RSS → calendar event hint. Renders nothing when no
            time expressions are detected; otherwise shows a small chip
            that opens a "create event" modal pre-filled with the
            recognised time and the article title. */}
        <RssTimeHintBanner
          itemId={item.id}
          title={item.title}
          summary={item.summary}
          author={item.author}
          publishedAt={item.publishedAt}
        />
        <button
          onClick={handleOpenBrowserMode}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg hover:bg-black/5 transition-colors text-[11px] text-[var(--text-muted)] ml-2"
          title="在浏览器模式打开"
        >
          <ExternalLink className="w-3.5 h-3.5" strokeWidth={2} />
          <span>浏览器模式</span>
        </button>
      </div>

      <div ref={contentRef} className="rss-preview-content flex-1 relative overflow-hidden" style={{ background: 'transparent' }}>
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
              <Loader2 className="w-8 h-8 text-[var(--color-blue)] animate-spin" />
              <span className="text-[12px] text-[var(--text-muted)]">正在加载文章...</span>
            </div>
          </div>
        )}

        {previewState.error && (
          <div className="h-full overflow-auto p-8">
            <div className="max-w-[680px] mx-auto">
              <h1 className="text-[20px] font-bold text-[var(--text-title)] mb-3">{item.title}</h1>
              <div className="flex items-center gap-3 mb-6 text-[12px] text-[var(--text-muted)]">
                <span>{item.source}</span>
                {item.author && item.author !== item.source ? <span>{item.author}</span> : null}
                <span>{item.publishedAt}</span>
              </div>
              <p className="text-[14px] text-[var(--text-body)] leading-relaxed mb-6">{item.summary}</p>
              <button
                onClick={handleOpenBrowserMode}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-blue)] text-white text-[12px] hover:brightness-95 transition-[filter]"
              >
                <ExternalLink className="w-4 h-4" />
                在浏览器模式中打开
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
