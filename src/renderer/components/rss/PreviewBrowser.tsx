import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react'
import { browserTabActivationSequencer } from '../../modules/browser/browserTabActivationSequencer'
import { PANEL_RESIZE_STATE_EVENT, type PanelResizeStateDetail } from '../../modules/browser/resize-events'
import { subscribeWorkbenchWindowResize } from '../../modules/workbench/windowResize'
import { useWorkspace } from '../../stores/useWorkspace'
import { useMode } from '../../stores/useMode'
import { useBrowserTabs } from '../../stores/useBrowserTabs'
import type { RSSItem } from './RSSFeed'

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

export default function PreviewBrowser({ item, onClose, isActive = true }: PreviewBrowserProps) {
  const [previewState, setPreviewState] = useState<PreviewState>(defaultPreviewState)
  const contentRef = useRef<HTMLDivElement>(null)
  const frameSyncRafRef = useRef<number | null>(null)
  const finalSyncTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const panelResizingRef = useRef(false)
  const lastBoundsKeyRef = useRef('')
  const pendingSyncOptionsRef = useRef<{ force: boolean; trailingFinal: boolean } | null>(null)

  const sidebarVisible = useWorkspace((state) => state.sidebarVisible)
  const sidePanelVariant = useWorkspace((state) => state.sidePanelVariant)
  const sidePanelWidths = useWorkspace((state) => state.sidePanelWidths)
  const skillsSplitRatio = useWorkspace((state) => state.skillsSplitRatio)
  const chatPanelVisible = useWorkspace((state) => state.chatPanelVisible)
  const chatPanelWidth = useWorkspace((state) => state.chatPanelWidth)
  const effectiveSidePanelWidth = sidePanelWidths.shared

  const clearFrameSync = useCallback(() => {
    if (frameSyncRafRef.current !== null) {
      cancelAnimationFrame(frameSyncRafRef.current)
      frameSyncRafRef.current = null
    }
    pendingSyncOptionsRef.current = null
  }, [])

  const clearFinalSyncTimeout = useCallback(() => {
    if (finalSyncTimeoutRef.current !== null) {
      clearTimeout(finalSyncTimeoutRef.current)
      finalSyncTimeoutRef.current = null
    }
  }, [])

  const sendBoundsImmediate = useCallback((options?: { force?: boolean }) => {
    const container = contentRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const width = Math.round(rect.width)
    const height = Math.round(rect.height)
    if (width <= 0 || height <= 0) return
    const x = Math.round(rect.left)
    const y = Math.round(rect.top)
    const boundsKey = `${x}:${y}:${width}:${height}`
    if (!options?.force && lastBoundsKeyRef.current === boundsKey) return

    lastBoundsKeyRef.current = boundsKey
    void window.electronAPI?.browser?.previewUpdateBounds({
      x,
      y,
      width,
      height,
    })
  }, [])

  const scheduleBoundsSync = useCallback((options?: { force?: boolean; trailingFinal?: boolean }) => {
    if (!isActive) return

    const previousOptions = pendingSyncOptionsRef.current
    pendingSyncOptionsRef.current = {
      force: previousOptions?.force || options?.force || false,
      trailingFinal: previousOptions?.trailingFinal || options?.trailingFinal || false,
    }

    if (frameSyncRafRef.current !== null) return

    frameSyncRafRef.current = requestAnimationFrame(() => {
      frameSyncRafRef.current = null
      const pendingOptions = pendingSyncOptionsRef.current
      pendingSyncOptionsRef.current = null
      if (!pendingOptions) return

      sendBoundsImmediate({ force: pendingOptions.force })
      if (!pendingOptions.trailingFinal || panelResizingRef.current) return

      clearFinalSyncTimeout()
      finalSyncTimeoutRef.current = setTimeout(() => {
        finalSyncTimeoutRef.current = null
        sendBoundsImmediate({ force: true })
      }, 64)
    })
  }, [clearFinalSyncTimeout, isActive, sendBoundsImmediate])

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
    void window.electronAPI?.browser?.previewOpen({ url: item.link })
    requestAnimationFrame(() => {
      scheduleBoundsSync({ force: true, trailingFinal: true })
    })
  }, [isActive, item.id, item.link, scheduleBoundsSync])

  useEffect(() => {
    const el = contentRef.current
    if (!el) return

    const handleBoundsShift = () => {
      scheduleBoundsSync({
        force: panelResizingRef.current,
        trailingFinal: !panelResizingRef.current,
      })
    }

    const observer = new ResizeObserver(handleBoundsShift)
    observer.observe(el)
    const unsubscribeWindowResize = subscribeWorkbenchWindowResize(handleBoundsShift)

    return () => {
      observer.disconnect()
      unsubscribeWindowResize()
      clearFrameSync()
      clearFinalSyncTimeout()
    }
  }, [clearFinalSyncTimeout, clearFrameSync, scheduleBoundsSync])

  useEffect(() => {
    if (!isActive) {
      clearFrameSync()
      clearFinalSyncTimeout()
      return
    }

    scheduleBoundsSync({ force: true, trailingFinal: !panelResizingRef.current })
  }, [
    chatPanelVisible,
    chatPanelWidth,
    clearFinalSyncTimeout,
    clearFrameSync,
    effectiveSidePanelWidth,
    sidebarVisible,
    sidePanelVariant,
    skillsSplitRatio,
    isActive,
    scheduleBoundsSync,
  ])

  useEffect(() => {
    const handlePanelResizeState = (event: Event) => {
      const detail = (event as CustomEvent<PanelResizeStateDetail>).detail
      if (!detail) return

      if (detail.resizing) {
        panelResizingRef.current = true
        clearFinalSyncTimeout()
        scheduleBoundsSync({ force: true })
        return
      }

      panelResizingRef.current = false
      clearFinalSyncTimeout()
      scheduleBoundsSync({ force: true, trailingFinal: true })
    }

    window.addEventListener(PANEL_RESIZE_STATE_EVENT, handlePanelResizeState as EventListener)
    return () => {
      window.removeEventListener(PANEL_RESIZE_STATE_EVENT, handlePanelResizeState as EventListener)
    }
  }, [clearFinalSyncTimeout, scheduleBoundsSync])

  useEffect(() => {
    return () => {
      clearFrameSync()
      clearFinalSyncTimeout()
      void window.electronAPI?.browser?.previewClose()
    }
  }, [clearFinalSyncTimeout, clearFrameSync])

  const handleClose = useCallback(() => {
    void window.electronAPI?.browser?.previewClose()
    onClose()
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
      useMode.getState().setWorkbenchMode('browser')
      void window.electronAPI?.browser?.previewClose()
      onClose()
    }
  }, [item.link, item.title, onClose])

  return (
    <div className="content-surface-panel rss-preview-surface flex-1 flex flex-col animate-fadeIn" style={{ background: 'var(--workbench-module-surface-bg)' }}>
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
