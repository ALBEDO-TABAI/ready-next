import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { ChevronLeft, ChevronRight, Globe, Loader2, Lock, Plus, Star, X } from 'lucide-react'
import { MorphTabButton, MorphTabStrip } from '../motion/MorphTabStrip'
import RefreshDock from './RefreshDock'
import {
  WORKBENCH_HEADER_EDGE_X,
  WORKBENCH_TAB_MAX_WIDTH,
  WORKBENCH_TAB_ROW_HEIGHT,
} from '../../modules/workbench/chrome'
import type { ActiveTabMode, RefreshDockMode } from '../../modules/browser/useBrowserHeaderInteraction'
import {
  getActiveTabSlotMetrics,
  getActiveTabSurfaceMetrics,
  getTabRailLayoutMetrics,
} from '../../modules/browser/tab-rail-layout'
import {
  beginBrowserTabDragSession,
  endBrowserTabDragSession,
} from '../../modules/browser/browserTabDragSession'
import type { BrowserTab } from '../../stores/useBrowserTabs'
import ActiveTabSurface from './ActiveTabSurface'

interface TabRailProps {
  isActive: boolean
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
  isActive,
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
  const hasStarterTab = tabs.length === 0
  const displayTabs = useMemo<BrowserTab[]>(() => (
    hasStarterTab
      ? [{
        id: '__browser-starter__',
        url: '',
        title: loading ? '浏览器启动中…' : '新标签页',
        loading,
        canGoBack: false,
        canGoForward: false,
        domain: '',
        required: false,
        activity: 'idle',
      }]
      : tabs
  ), [hasStarterTab, loading, tabs])
  const scrollRef = useRef<HTMLDivElement>(null)
  const tabSlotRefs = useRef(new Map<string, HTMLDivElement>())
  const previousTabCountRef = useRef(displayTabs.length)
  const [showLeftArrow, setShowLeftArrow] = useState(false)
  const [showRightArrow, setShowRightArrow] = useState(false)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null)
  const dragIndexRef = useRef<number | null>(null)
  const layoutMetrics = getTabRailLayoutMetrics(displayTabs.length)
  const activeSurfaceMetrics = getActiveTabSurfaceMetrics(layoutMetrics, activeTabMode)
  const activeSlotMetrics = getActiveTabSlotMetrics(layoutMetrics, activeTabMode, refreshDockMode)

  const setBrowserTabDragPayload = useCallback((event: React.DragEvent, tab: BrowserTab) => {
    const payload = {
      type: 'browser-tab' as const,
      name: tab.title || 'New Tab',
      title: tab.title || 'New Tab',
      url: tab.url,
      ext: '.url',
      tabId: tab.id,
      draggedAt: Date.now(),
    }
    beginBrowserTabDragSession(payload)
    const data = JSON.stringify(payload)
    event.dataTransfer.setData('application/x-ready-drag', data)
  }, [])

  const checkOverflow = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    setShowLeftArrow(element.scrollLeft > 0)
    setShowRightArrow(element.scrollLeft + element.clientWidth < element.scrollWidth - 1)
  }, [])

  const registerTabSlot = useCallback((tabId: string) => (node: HTMLDivElement | null) => {
    if (node) {
      tabSlotRefs.current.set(tabId, node)
      return
    }
    tabSlotRefs.current.delete(tabId)
  }, [])

  const keepTabSlotVisible = useCallback((tabId: string | null, behavior: ScrollBehavior) => {
    if (!tabId) return
    const container = scrollRef.current
    const slot = tabSlotRefs.current.get(tabId)
    if (!container || !slot) return

    const containerRect = container.getBoundingClientRect()
    const slotRect = slot.getBoundingClientRect()
    const leftInset = 8
    const rightInset = 44

    if (slotRect.left < containerRect.left + leftInset) {
      container.scrollBy({
        left: slotRect.left - (containerRect.left + leftInset),
        behavior,
      })
      return
    }

    if (slotRect.right > containerRect.right - rightInset) {
      container.scrollBy({
        left: slotRect.right - (containerRect.right - rightInset),
        behavior,
      })
    }
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
  }, [checkOverflow, displayTabs.length])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const lastTab = displayTabs[displayTabs.length - 1]
    if (!lastTab) return

    const tabCountChanged = previousTabCountRef.current !== displayTabs.length
    previousTabCountRef.current = displayTabs.length
    const shouldBiasToEnd = tabCountChanged || activeTabId === lastTab.id
    if (!shouldBiasToEnd) return

    const frame = requestAnimationFrame(() => {
      const targetLeft = Math.max(0, element.scrollWidth - element.clientWidth)
      element.scrollTo({ left: targetLeft, behavior: isActive ? 'smooth' : 'auto' })
      checkOverflow()
    })

    return () => cancelAnimationFrame(frame)
  }, [activeTabId, checkOverflow, displayTabs, isActive])

  useEffect(() => {
    if (!activeTabId) return

    const frame = requestAnimationFrame(() => {
      keepTabSlotVisible(activeTabId, isActive ? 'smooth' : 'auto')
      checkOverflow()
    })

    return () => cancelAnimationFrame(frame)
  }, [activeTabId, checkOverflow, isActive, keepTabSlotVisible, activeTabMode, refreshDockMode, displayTabs.length])

  const clearGlobalDragState = useCallback(() => {
    dragIndexRef.current = null
    setDragOverIndex(null)
    setDraggingTabId(null)
    endBrowserTabDragSession()
  }, [])

  useEffect(() => {
    clearGlobalDragState()
    return clearGlobalDragState
  }, [clearGlobalDragState])

  useEffect(() => {
    const handleGlobalDragCleanup = () => {
      clearGlobalDragState()
    }
    const handleVisibilityCleanup = () => {
      if (document.visibilityState === 'hidden') {
        clearGlobalDragState()
      }
    }

    window.addEventListener('dragend', handleGlobalDragCleanup)
    window.addEventListener('drop', handleGlobalDragCleanup)
    window.addEventListener('mouseup', handleGlobalDragCleanup)
    window.addEventListener('pointerup', handleGlobalDragCleanup)
    window.addEventListener('pointercancel', handleGlobalDragCleanup)
    document.addEventListener('visibilitychange', handleVisibilityCleanup)

    return () => {
      window.removeEventListener('dragend', handleGlobalDragCleanup)
      window.removeEventListener('drop', handleGlobalDragCleanup)
      window.removeEventListener('mouseup', handleGlobalDragCleanup)
      window.removeEventListener('pointerup', handleGlobalDragCleanup)
      window.removeEventListener('pointercancel', handleGlobalDragCleanup)
      document.removeEventListener('visibilitychange', handleVisibilityCleanup)
    }
  }, [clearGlobalDragState])

  useEffect(() => {
    if (!draggingTabId) return
    if (!isActive || !displayTabs.some((tab) => tab.id === draggingTabId)) {
      clearGlobalDragState()
    }
  }, [clearGlobalDragState, draggingTabId, displayTabs, isActive])

  const handleDragStart = (event: React.DragEvent, index: number) => {
    dragIndexRef.current = index
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData('text/plain', String(index))
    const tab = displayTabs[index]
    if (tab) {
      setDraggingTabId(tab.id)
      setBrowserTabDragPayload(event, tab)
    }
  }

  const handleDragEnd = () => {
    clearGlobalDragState()
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
    clearGlobalDragState()
  }

  const handleAuxClick = (event: React.MouseEvent, id: string) => {
    if (event.button === 1) {
      event.preventDefault()
      void onTabClose(id)
    }
  }

  return (
    <div className="flex min-w-0 flex-1 items-center" style={{ gap: 6 }}>
      <div className="flex h-[24px] w-[24px] flex-shrink-0 items-center justify-center">
        <button
          type="button"
          onClick={() => scrollRef.current?.scrollBy({ left: -160, behavior: 'smooth' })}
          className="flex h-[24px] w-[24px] flex-shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)]"
          style={{ opacity: showLeftArrow ? 1 : 0, pointerEvents: showLeftArrow ? 'auto' : 'none' }}
          tabIndex={showLeftArrow ? 0 : -1}
          aria-hidden={!showLeftArrow}
        >
          <ChevronLeft style={{ width: 12, height: 12 }} className="text-[var(--text-gray)]" strokeWidth={2} />
        </button>
      </div>

      <div
        ref={scrollRef}
        className="browser-tab-rail-scroll flex min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden"
        style={{ paddingLeft: WORKBENCH_HEADER_EDGE_X / 2, paddingRight: WORKBENCH_HEADER_EDGE_X / 2 }}
      >
        <MorphTabStrip layoutId="browser-unified-header" className="flex min-w-full w-max items-center gap-[6px]">
          {displayTabs.map((tab, index) => {
            const isActive = tab.id === activeTabId
            const isDragOver = dragOverIndex === index
            const isDragging = draggingTabId === tab.id
            const isHovered = hoveredTabId === tab.id
            const isStarterTab = hasStarterTab && tab.id === '__browser-starter__'

            const utilityCount =
              (isStarterTab ? 0 : 1) +
              (tab.owner === 'agent' ? 1 : 0) +
              (tab.required ? 1 : 0) +
              (tab.activity && tab.activity !== 'idle' ? 1 : 0)
            const rightReserve = isStarterTab ? 0 : 34 + utilityCount * 18

            const tabIsBookmarked = bookmarkedUrls.includes(tab.url)
            const slotWidth = isActive ? activeSlotMetrics.width : layoutMetrics.inactiveWidth
            const slotMinWidth = isActive ? activeSlotMetrics.minWidth : layoutMetrics.inactiveMinWidth

            return (
              <div
                key={tab.id}
                ref={registerTabSlot(tab.id)}
                className="relative flex min-w-0 flex-shrink-0 items-center"
                style={{
                  width: isActive ? activeSlotMetrics.width : layoutMetrics.inactiveWidth,
                  minWidth: isActive ? activeSlotMetrics.minWidth : layoutMetrics.inactiveMinWidth,
                  maxWidth: isActive ? activeSlotMetrics.width : WORKBENCH_TAB_MAX_WIDTH,
                  overflow: 'visible',
                }}
              >
                {isActive ? (
                  <div
                    className="relative z-[2] flex min-w-0 w-full items-center gap-[6px]"
                    style={{ opacity: isDragging ? 0.72 : 1 }}
                  >
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
                      width={activeSurfaceMetrics.width}
                      minWidth={activeSurfaceMetrics.minWidth}
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
                ) : (
                  <MorphTabButton
                    layoutId="browser-unified-header"
                    active={false}
                    draggable={!isStarterTab}
                    onDragStart={isStarterTab ? undefined : (event) => handleDragStart(event, index)}
                    onDragEnd={handleDragEnd}
                    onDragOver={isStarterTab ? undefined : (event) => handleDragOver(event, index)}
                    onDrop={isStarterTab ? undefined : (event) => handleDrop(event, index)}
                    onMouseEnter={() => setHoveredTabId(tab.id)}
                    onMouseLeave={() => setHoveredTabId((current) => current === tab.id ? null : current)}
                    onClick={() => {
                      if (isStarterTab) {
                        if (loading) return
                        void onNewTab()
                        return
                      }
                      void onTabClick(tab.id)
                    }}
                    onAuxClick={isStarterTab ? undefined : (event) => handleAuxClick(event, tab.id)}
                    className="group relative flex min-w-0 w-full cursor-pointer items-center rounded-[14px] border px-[10px] text-[12px] transition-[background-color,color,border-color,box-shadow,opacity] duration-150"
                    style={{
                      gap: 6,
                      height: Math.max(30, WORKBENCH_TAB_ROW_HEIGHT - 4),
                      width: slotWidth,
                      minWidth: slotMinWidth,
                      maxWidth: WORKBENCH_TAB_MAX_WIDTH,
                      opacity: isDragging ? 0.72 : 1,
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
                        maxWidth: rightReserve > 0 ? `calc(100% - ${rightReserve}px)` : '100%',
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
                          draggable={false}
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

                    {!isStarterTab && (
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

                        <span
                          role="button"
                          tabIndex={0}
                          onMouseDown={(event) => {
                            event.stopPropagation()
                          }}
                          onClick={(event) => {
                            event.stopPropagation()
                            onToggleBookmarkForTab(tab)
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault()
                              event.stopPropagation()
                              onToggleBookmarkForTab(tab)
                            }
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
                        </span>

                        <span
                          role="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            void onTabClose(tab.id)
                          }}
                          className="flex h-[18px] w-[18px] cursor-pointer items-center justify-center rounded opacity-75 transition-[background-color,opacity] hover:bg-[var(--bg-hover)] hover:opacity-100"
                          title="Close tab"
                        >
                          <X style={{ width: 10, height: 10 }} strokeWidth={2} />
                        </span>
                      </span>
                    )}
                  </MorphTabButton>
                )}
              </div>
            )
          })}
          <button
            type="button"
            onClick={() => void onNewTab()}
            className="ml-[6px] flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-[8px] transition-colors hover:bg-[var(--bg-hover)]"
            title="New tab"
          >
            <Plus style={{ width: 14, height: 14 }} className="text-[var(--text-muted)]" strokeWidth={2} />
          </button>
        </MorphTabStrip>
      </div>

      <div className="flex h-[24px] w-[24px] flex-shrink-0 items-center justify-center">
        <button
          type="button"
          onClick={() => scrollRef.current?.scrollBy({ left: 160, behavior: 'smooth' })}
          className="flex h-[24px] w-[24px] flex-shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--bg-hover)]"
          style={{ opacity: showRightArrow ? 1 : 0, pointerEvents: showRightArrow ? 'auto' : 'none' }}
          tabIndex={showRightArrow ? 0 : -1}
          aria-hidden={!showRightArrow}
        >
          <ChevronRight style={{ width: 12, height: 12 }} className="text-[var(--text-gray)]" strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}
