import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react'
import { useWorkspace } from '../../stores/useWorkspace'
import { useMode } from '../../stores/useMode'
import { useBrowserTabs } from '../../stores/useBrowserTabs'
import type { RSSItem } from './RSSFeed'

interface PreviewBrowserProps {
  item: RSSItem
  onClose: () => void
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

export default function PreviewBrowser({ item, onClose }: PreviewBrowserProps) {
  const [previewState, setPreviewState] = useState<PreviewState>(defaultPreviewState)
  const contentRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const sidebarVisible = useWorkspace((state) => state.sidebarVisible)
  const sidePanelVariant = useWorkspace((state) => state.sidePanelVariant)
  const sidePanelWidths = useWorkspace((state) => state.sidePanelWidths)
  const skillsSplitRatio = useWorkspace((state) => state.skillsSplitRatio)
  const chatPanelVisible = useWorkspace((state) => state.chatPanelVisible)
  const chatPanelWidth = useWorkspace((state) => state.chatPanelWidth)
  const effectiveSidePanelWidth = useMemo(() => {
    if (sidePanelVariant === 'skills') return sidePanelWidths.skills
    if (sidePanelVariant === 'search') return sidePanelWidths.search
    return sidePanelWidths.files
  }, [sidePanelVariant, sidePanelWidths.files, sidePanelWidths.search, sidePanelWidths.skills])

  const sendBoundsImmediate = useCallback(() => {
    const container = contentRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const width = Math.round(rect.width)
    const height = Math.round(rect.height)
    if (width <= 0 || height <= 0) return
    void window.electronAPI?.browser?.previewUpdateBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width,
      height,
    })
  }, [])

  const startBoundsTracking = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    if (timeoutRef.current) clearTimeout(timeoutRef.current)

    const started = Date.now()
    const trackDuration = 400
    const tick = () => {
      sendBoundsImmediate()
      if (Date.now() - started < trackDuration) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = null
        timeoutRef.current = setTimeout(() => {
          sendBoundsImmediate()
          timeoutRef.current = null
        }, 50)
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [sendBoundsImmediate])

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
    setPreviewState((prev) => ({ ...prev, loading: true, error: undefined }))
    void window.electronAPI?.browser?.previewOpen({ url: item.link })
    requestAnimationFrame(() => sendBoundsImmediate())
  }, [item.id, item.link, sendBoundsImmediate])

  useEffect(() => {
    const el = contentRef.current
    if (!el) return

    const observer = new ResizeObserver(() => sendBoundsImmediate())
    observer.observe(el)
    const onResize = () => sendBoundsImmediate()
    window.addEventListener('resize', onResize)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onResize)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [sendBoundsImmediate])

  useEffect(() => {
    startBoundsTracking()
  }, [
    sidebarVisible,
    sidePanelVariant,
    effectiveSidePanelWidth,
    skillsSplitRatio,
    chatPanelVisible,
    chatPanelWidth,
    startBoundsTracking,
  ])

  useEffect(() => {
    return () => {
      void window.electronAPI?.browser?.previewClose()
    }
  }, [])

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
      useBrowserTabs.getState().setActiveTabId(result.tabId)
      useBrowserTabs.getState().setUrlInput(item.link)
      useMode.getState().setWorkbenchMode('browser')
      void window.electronAPI?.browser?.previewClose()
      onClose()
    }
  }, [item.link, item.title, onClose])

  return (
    <div className="content-surface-panel flex-1 flex flex-col animate-fadeIn" style={{ background: 'var(--surface-panel-bg)' }}>
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

      <div ref={contentRef} className="flex-1 relative overflow-hidden" style={{ background: 'var(--bg-content)' }}>
        {previewState.loading && !previewState.error && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--bg-content)]/90">
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
                <span>{item.publishedAt}</span>
              </div>
              <p className="text-[14px] text-[var(--text-body)] leading-relaxed mb-6">{item.summary}</p>
              <button
                onClick={handleOpenBrowserMode}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-blue)] text-white text-[12px] hover:brightness-95 transition-all"
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
