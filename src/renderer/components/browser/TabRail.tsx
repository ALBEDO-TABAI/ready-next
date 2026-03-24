import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { ChevronLeft, ChevronRight, Globe, Loader2, Lock, Plus, Star, X } from 'lucide-react'
import { MorphTabButton, MorphTabStrip } from '../motion/MorphTabStrip'
import RefreshDock from './RefreshDock'
import {
  WORKBENCH_HEADER_EDGE_X,
  WORKBENCH_TAB_MAX_WIDTH,
  WORKBENCH_TAB_ROW_HEIGHT,
} from '../../modules/workbench/chrome'
import type { ActiveTabMode, RefreshDockMode } from '../../modules/browser/useBrowserHeaderInteraction'
import { getTabRailLayoutMetrics } from '../../modules/browser/tab-rail-layout'
import type { BrowserTab } from '../../stores/useBrowserTabs'
import ActiveTabSurface from './ActiveTabSurface'

interface TabRailProps {
  tabs: BrowserTab[]
  activeTabId: string | null
  activeTabMode: ActiveTabMode
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  refreshDockMode: RefreshDockMode
  activeTabSurfaceRef: RefObject<HTMLDivElement | null>
  urlInput: string
  isBookmarked: boolean
  bookmarkedUrls: string[]
  onTabClick: (id: string) => void | Promise<void>
  onTabClose: (id: string) => void | Promise<void>
  onNewTab: () => void | Promise<void>
  onReorder: (fromIndex: number, toIndex: number) => void
  onUrlChange: (value: string) => void
  onExpandRequest: () => void
  onHotspotEnter: () => void
  onHotspotLeave: () => void
  onInputFocus: () => void
  onInputBlur: () => void
  onRefreshDockEnter: () => void
  onRefreshDockLeave: () => void
  onRefresh: () => void
  onGoBack: () => void
  onGoForward: () => void
  onCommitNavigation: () => void
  onToggleBookmark: () => void
  onToggleBookmarkForTab: (tab: BrowserTab) => void
}

export default function TabRail({
  tabs,
  activeTabId,
  activeTabMode,
  loading,
  canGoBack,
  canGoForward,
  refreshDockMode,
  activeTabSurfaceRef,
  urlInput,
  isBookmarked,
  bookmarkedUrls,
  onTabClick,
  onTabClose,
  onNewTab,
  onReorder,
  onUrlChange,
  onExpandRequest,
  onHotspotEnter,
  onHotspotLeave,
  onInputFocus,
  onInputBlur,
  onRefreshDockEnter,
  onRefreshDockLeave,
  onRefresh,
  onGoBack,
  onGoForward,
  onCommitNavigation,
  onToggleBookmark,
  onToggleBookmarkForTab,
}: TabRailProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const previousTabCountRef = useRef(tabs.length)
  const [showLeftArrow, setShowLeftArrow] = useState(false)
  const [showRightArrow, setShowRightArrow] = useState(false)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null)
  const dragIndexRef = useRef<number | null>(null)
  const layoutMetrics = getTabRailLayoutMetrics(tabs.length)

  const setBrowserTabDragPayload = useCallback((event: React.DragEvent, tab: BrowserTab) => {
    const data = JSON.stringify({
      type: 'browser-tab' as const,
      name: tab.title || 'New Tab',
      title: tab.title || 'New Tab',
      url: tab.url,
      ext: '.url',
      tabId: tab.id,
      draggedAt: Date.now(),
    })
    event.dataTransfer.setData('application/x-ready-drag', data)
  }, [])

  const checkOverflow = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    setShowLeftArrow(element.scrollLeft > 0)
    setShowRightArrow(element.scrollLeft + element.clientWidth < element.scrollWidth - 1)
  }, [])

  useEffect(() => {
    checkOverflow()
    const element = scrollRef.current
    if (!element) return
    element.addEventListener('scroll', checkOverflow)
    const observer = new ResizeObserver(checkOverflow)
    observer.observe(element)
    return () => {
      element.removeEventListener('scroll', checkOverflow)
      observer.disconnect()
    }
  }, [checkOverflow, tabs.length])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const lastTab = tabs[tabs.length - 1]
    if (!lastTab) return

    const tabCountChanged = previousTabCountRef.current !== tabs.length
    previousTabCountRef.current = tabs.length
    const shouldBiasToEnd = tabCountChanged || activeTabId === lastTab.id
    if (!shouldBiasToEnd) return

    const frame = requestAnimationFrame(() => {
      const targetLeft = Math.max(0, element.scrollWidth - element.clientWidth)
      element.scrollTo({ left: targetLeft, behavior: 'smooth' })
      checkOverflow()
    })

    return () => cancelAnimationFrame(frame)
  }, [activeTabId, checkOverflow, tabs])

  const handleDragStart = (event: React.DragEvent, index: number) => {
    dragIndexRef.current = index
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData('text/plain', String(index))
    const tab = tabs[index]
    if (tab) {
      setBrowserTabDragPayload(event, tab)
    }
    const target = event.currentTarget as HTMLElement
    target.style.opacity = '0.5'
  }

  const handleDragEnd = (event: React.DragEvent) => {
    const target = event.currentTarget as HTMLElement
    target.style.opacity = '1'
    dragIndexRef.current = null
    setDragOverIndex(null)
  }

  const handleDragOver = (event: React.DragEvent, index: number) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOverIndex(index)
  }

  const handleDrop = (event: React.DragEvent, toIndex: number) => {
    event.preventDefault()
    const fromIndex = dragIndexRef.current
    if (fromIndex !== null && fromIndex !== toIndex) {
      onReorder(fromIndex, toIndex)
    }
    dragIndexRef.current = null
    setDragOverIndex(null)
  }

  const handleAuxClick = (event: React.MouseEvent, id: string) => {
    if (event.button === 1) {
      event.preventDefault()
      void onTabClose(id)
    }
  }

  return (
    <div className="flex min-w-0 flex-1 items-center" style={{ gap: 6 }}>
      {showLeftArrow && (
        <button
          type="button"
          onClick={() => scrollRef.current?.scrollBy({ left: -160, behavior: 'smooth' })}
          className="flex h-[24px] w-[24px] flex-shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)]"
        >
          <ChevronLeft style={{ width: 12, height: 12 }} className="text-[var(--text-gray)]" strokeWidth={2} />
        </button>
      )}

      <div
        ref={scrollRef}
        className="flex min-w-0 flex-1 items-center overflow-x-hidden"
        style={{ paddingLeft: WORKBENCH_HEADER_EDGE_X / 2, paddingRight: WORKBENCH_HEADER_EDGE_X / 2 }}
      >
        <MorphTabStrip layoutId="browser-unified-header" className="flex min-w-0 items-center gap-[6px]">
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeTabId
            const isDragOver = dragOverIndex === index
            const isHovered = hoveredTabId === tab.id

            if (isActive) {
              return (
                <div key={tab.id} className="relative z-[2] flex min-w-0 items-center gap-[6px]">
                  <RefreshDock
                    loading={loading}
                    canGoBack={canGoBack}
                    canGoForward={canGoForward}
                    refreshDockMode={refreshDockMode}
                    onMouseEnter={onRefreshDockEnter}
                    onMouseLeave={onRefreshDockLeave}
                    onRefresh={onRefresh}
                    onGoBack={onGoBack}
                    onGoForward={onGoForward}
                  />
                  <ActiveTabSurface
                    tab={tab}
                    mode={activeTabMode}
                    urlInput={urlInput}
                    isBookmarked={isBookmarked}
                    surfaceRef={activeTabSurfaceRef}
                    compactWidth={layoutMetrics.activeCompactWidth}
                    compactMinWidth={layoutMetrics.activeCompactMinWidth}
                    draggable={activeTabMode !== 'expanded' && activeTabMode !== 'editing'}
                    onDragStart={(event) => handleDragStart(event, index)}
                    onDragEnd={handleDragEnd}
                    onUrlChange={onUrlChange}
                    onExpandRequest={onExpandRequest}
                    onHotspotEnter={onHotspotEnter}
                    onHotspotLeave={onHotspotLeave}
                    onInputFocus={onInputFocus}
                    onInputBlur={onInputBlur}
                    onCommitNavigation={onCommitNavigation}
                    onToggleBookmark={onToggleBookmark}
                    onClose={() => void onTabClose(tab.id)}
                  />
                </div>
              )
            }

            const utilityCount =
              1 +
              (tab.owner === 'agent' ? 1 : 0) +
              (tab.required ? 1 : 0) +
              (tab.activity && tab.activity !== 'idle' ? 1 : 0)
            const rightReserve = 34 + utilityCount * 18

            const tabIsBookmarked = bookmarkedUrls.includes(tab.url)

            return (
              <MorphTabButton
                key={tab.id}
                layoutId="browser-unified-header"
                active={false}
                draggable
                onDragStart={(event) => handleDragStart(event, index)}
                onDragEnd={handleDragEnd}
                onDragOver={(event) => handleDragOver(event, index)}
                onDrop={(event) => handleDrop(event, index)}
                onMouseEnter={() => setHoveredTabId(tab.id)}
                onMouseLeave={() => setHoveredTabId((current) => current === tab.id ? null : current)}
                onClick={() => void onTabClick(tab.id)}
                onAuxClick={(event) => handleAuxClick(event, tab.id)}
                className="group relative flex min-w-0 cursor-pointer items-center rounded-[14px] border px-[10px] text-[12px] transition-all duration-150"
                style={{
                  gap: 6,
                  height: Math.max(30, WORKBENCH_TAB_ROW_HEIGHT - 4),
                  width: layoutMetrics.inactiveWidth,
                  minWidth: layoutMetrics.inactiveMinWidth,
                  maxWidth: WORKBENCH_TAB_MAX_WIDTH,
                  background: isHovered
                    ? 'color-mix(in srgb, var(--surface-card-bg) 20%, transparent)'
                    : 'transparent',
                  color: isHovered ? 'var(--text-title)' : 'var(--text-gray)',
                  borderColor: isDragOver
                    ? 'var(--color-blue)'
                    : isHovered
                      ? 'color-mix(in srgb, var(--color-blue) 28%, transparent)'
                      : 'transparent',
                  boxShadow: isHovered
                    ? '0 0 0 1px color-mix(in srgb, var(--color-blue) 18%, transparent)'
                    : 'none',
                }}
                contentClassName="relative z-[1] flex min-w-0 flex-1 items-center justify-center"
              >
                <span
                  className="flex min-w-0 items-center justify-center gap-[6px]"
                  style={{
                    maxWidth: `calc(100% - ${rightReserve}px)`,
                    marginRight: rightReserve,
                  }}
                >
                  {tab.loading ? (
                    <Loader2
                      style={{ width: 14, height: 14 }}
                      className="animate-spin flex-shrink-0 text-[var(--color-blue)]"
                      strokeWidth={2}
                    />
                  ) : tab.favicon ? (
                    <img
                      src={tab.favicon}
                      alt=""
                      className="h-[14px] w-[14px] flex-shrink-0 rounded-[3px] object-cover"
                    />
                  ) : (
                    <Globe
                      style={{ width: 14, height: 14 }}
                      className="flex-shrink-0"
                      strokeWidth={2}
                    />
                  )}

                  <span className="truncate min-w-0" style={{ lineHeight: '28px' }}>
                    {tab.title || 'New Tab'}
                  </span>
                </span>

                <span
                  className="absolute right-[8px] top-1/2 flex items-center gap-[4px]"
                  style={{ transform: 'translateY(-50%)' }}
                >
                  {tab.owner === 'agent' && (
                    <span
                      className="flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]"
                      style={{
                        background: 'var(--color-blue-light)',
                        color: 'var(--color-blue)',
                      }}
                    >
                      Agent
                    </span>
                  )}

                  {tab.required && (
                    <Lock
                      style={{ width: 10, height: 10 }}
                      className="flex-shrink-0 text-[var(--text-light)]"
                      strokeWidth={2}
                    />
                  )}

                  {tab.activity && tab.activity !== 'idle' && (
                    <span
                      className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${tab.activity === 'running' ? 'animate-pulse' : ''}`}
                      style={{
                        background: tab.activity === 'attention'
                          ? 'var(--color-orange)'
                          : 'var(--color-blue)',
                      }}
                    />
                  )}

                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      onToggleBookmarkForTab(tab)
                    }}
                    className="flex h-[18px] w-[18px] items-center justify-center rounded opacity-70 transition-colors hover:bg-[var(--bg-hover)] hover:opacity-100"
                    title={tabIsBookmarked ? '取消收藏' : '收藏此页面'}
                  >
                    <Star
                      style={{ width: 10, height: 10 }}
                      strokeWidth={2}
                      className={tabIsBookmarked ? 'text-[var(--color-orange)]' : 'text-[var(--text-light)]'}
                      fill={tabIsBookmarked ? 'var(--color-orange)' : 'none'}
                    />
                  </button>

                  <span
                    role="button"
                    onClick={(event) => {
                      event.stopPropagation()
                      void onTabClose(tab.id)
                    }}
                    className="flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded opacity-75 transition-all hover:bg-[var(--bg-hover)] hover:opacity-100"
                    title="Close tab"
                  >
                    <X style={{ width: 10, height: 10 }} strokeWidth={2} />
                  </span>
                </span>
              </MorphTabButton>
            )
          })}
        </MorphTabStrip>

        <button
          type="button"
          onClick={() => void onNewTab()}
          className="ml-[6px] flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-[8px] transition-colors hover:bg-[var(--bg-hover)]"
          title="New tab"
        >
          <Plus style={{ width: 14, height: 14 }} className="text-[var(--text-muted)]" strokeWidth={2} />
        </button>
      </div>

      {showRightArrow && (
        <button
          type="button"
          onClick={() => scrollRef.current?.scrollBy({ left: 160, behavior: 'smooth' })}
          className="flex h-[24px] w-[24px] flex-shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)]"
        >
          <ChevronRight style={{ width: 12, height: 12 }} className="text-[var(--text-gray)]" strokeWidth={2} />
        </button>
      )}
    </div>
  )
}
