import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Globe, Loader2, Lock, Plus, X } from 'lucide-react'
import {
  beginBrowserTabDragSession,
  endBrowserTabDragSession,
} from '../../modules/browser/browserTabDragSession'
import {
  addReadyContextReferenceToAgentInput,
  showBrowserTabContextMenu,
} from '../../modules/agent/chat-input-bridge'
import { extractBrowserDomain } from '../../modules/browser/url-utils'
import { getActiveTabPairOrder } from '../../modules/workbench/active-tab-pair-order'
import type { BrowserTab } from '../../stores/useBrowserTabs'
import type {
  VerticalRailOverlayCommand,
  VerticalRailOverlaySnapshot,
  VerticalRailOverlayTab,
} from '../../../shared/browser-vertical-rail-overlay'

export const BROWSER_VERTICAL_RAIL_WIDTH = 52
const RAIL_WIDTH = BROWSER_VERTICAL_RAIL_WIDTH
const HOVER_OPEN_DELAY = 140
const HOVER_CLOSE_DELAY = 180

interface VerticalTabRailProps {
  isActive: boolean
  tabs: BrowserTab[]
  activeTabId: string | null
  splitTabId: string | null
  bookmarkedUrls: string[]
  onTabClick: (id: string, event: { shiftKey: boolean }) => void | Promise<void>
  onTabClose: (id: string) => void | Promise<void>
  onNewTab: () => void | Promise<void>
  onReorder: (fromIndex: number, toIndex: number) => void
  onToggleBookmarkForTab: (tab: BrowserTab) => void
}

function tabIconNode(tab: BrowserTab, size: number) {
  if (tab.loading) {
    return <Loader2 style={{ width: size, height: size }} className="animate-spin flex-shrink-0 text-[var(--color-blue)]" strokeWidth={2} />
  }
  if (tab.favicon) {
    return <img src={tab.favicon} alt="" draggable={false} className="flex-shrink-0 rounded-[3px] object-cover" style={{ width: size, height: size }} />
  }
  return <Globe style={{ width: size, height: size }} className="flex-shrink-0 text-[var(--text-gray)]" strokeWidth={2} />
}

export default function VerticalTabRail({
  isActive,
  tabs,
  activeTabId,
  splitTabId,
  bookmarkedUrls,
  onTabClick,
  onTabClose,
  onNewTab,
  onReorder,
  onToggleBookmarkForTab,
}: VerticalTabRailProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const dragIndexRef = useRef<number | null>(null)

  // Native-overlay hover flyout state (cross-window dual-hover arbitration).
  const railHoveredRef = useRef(false)
  const overlayHoveredRef = useRef(false)
  const overlayOpenRef = useRef(false)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  // Keep latest props reachable from the IPC command handler without re-subscribing.
  const latestRef = useRef({ tabs, activeTabId, splitTabId, bookmarkedUrls })
  latestRef.current = { tabs, activeTabId, splitTabId, bookmarkedUrls }

  const orderedTabs = useMemo(
    () => getActiveTabPairOrder(tabs, activeTabId, splitTabId),
    [activeTabId, splitTabId, tabs],
  )

  const buildSnapshot = useCallback((): VerticalRailOverlaySnapshot | null => {
    const root = rootRef.current
    if (!root) return null
    const rect = root.getBoundingClientRect()
    if (rect.height <= 0) return null
    const { tabs: t, activeTabId: aId, splitTabId: sId, bookmarkedUrls: marks } = latestRef.current
    const overlayTabs: VerticalRailOverlayTab[] = getActiveTabPairOrder(t, aId, sId).map(({ tab }) => ({
      id: tab.id,
      title: tab.title || 'New Tab',
      domain: tab.domain || extractBrowserDomain(tab.url || ''),
      url: tab.url,
      favicon: tab.favicon,
      active: tab.id === aId || (tab.id === sId && tab.id !== aId),
      split: tab.id === sId && tab.id !== aId,
      loading: Boolean(tab.loading),
      owner: tab.owner,
      activity: tab.activity,
      required: tab.required,
      bookmarked: marks.includes(tab.url),
    }))
    // Fit the overlay to its rows (tabs + new-tab) so it reads as labels next to the icons,
    // not a full-height sidebar. Mirrors the overlay's PAD_Y(6)/ROW_H(38)/ROW_GAP(4).
    const rows = overlayTabs.length + 1
    const desiredHeight = 12 + rows * 38 + (rows - 1) * 4
    return {
      tabs: overlayTabs,
      bounds: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: RAIL_WIDTH,
        height: Math.min(Math.round(rect.height), desiredHeight),
      },
    }
  }, [])

  const pushSnapshot = useCallback(() => {
    if (!overlayOpenRef.current) return
    const snapshot = buildSnapshot()
    if (snapshot) void window.electronAPI?.browser?.showVerticalRailOverlay?.(snapshot)
  }, [buildSnapshot])

  const hideOverlay = useCallback(() => {
    overlayOpenRef.current = false
    void window.electronAPI?.browser?.hideVerticalRailOverlay?.()
  }, [])

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) { window.clearTimeout(openTimerRef.current); openTimerRef.current = null }
    if (closeTimerRef.current !== null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null }
  }, [])

  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current !== null) return
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      if (!railHoveredRef.current && !overlayHoveredRef.current) hideOverlay()
    }, HOVER_CLOSE_DELAY)
  }, [hideOverlay])

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null }
  }, [])

  const handleRailEnter = useCallback(() => {
    railHoveredRef.current = true
    cancelClose()
    if (overlayOpenRef.current) return
    if (openTimerRef.current !== null) return
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      if (!railHoveredRef.current) return
      const snapshot = buildSnapshot()
      if (!snapshot) return
      overlayOpenRef.current = true
      void window.electronAPI?.browser?.showVerticalRailOverlay?.(snapshot)
    }, HOVER_OPEN_DELAY)
  }, [buildSnapshot, cancelClose])

  const handleRailLeave = useCallback(() => {
    railHoveredRef.current = false
    if (openTimerRef.current !== null) { window.clearTimeout(openTimerRef.current); openTimerRef.current = null }
    scheduleClose()
  }, [scheduleClose])

  // Dispatch commands coming back from the overlay window.
  useEffect(() => {
    const off = window.electronAPI?.browser?.onVerticalRailOverlayCommand?.((command: VerticalRailOverlayCommand) => {
      switch (command.type) {
        case 'hover-enter':
          overlayHoveredRef.current = true
          cancelClose()
          break
        case 'hover-leave':
          overlayHoveredRef.current = false
          scheduleClose()
          break
        case 'switch':
          void onTabClick(command.tabId, { shiftKey: Boolean(command.shiftKey) })
          overlayHoveredRef.current = false
          hideOverlay()
          break
        case 'close':
          void Promise.resolve(onTabClose(command.tabId)).then(() => setTimeout(pushSnapshot, 0))
          break
        case 'new-tab':
          void onNewTab()
          overlayHoveredRef.current = false
          hideOverlay()
          break
        case 'reorder':
          onReorder(command.fromIndex, command.toIndex)
          setTimeout(pushSnapshot, 0)
          break
        case 'toggle-bookmark': {
          const tab = latestRef.current.tabs.find((item) => item.id === command.tabId)
          if (tab) onToggleBookmarkForTab(tab)
          setTimeout(pushSnapshot, 0)
          break
        }
        case 'reference': {
          const tab = latestRef.current.tabs.find((item) => item.id === command.tabId)
          if (tab) {
            void addReadyContextReferenceToAgentInput({
              type: 'browser-tab',
              name: tab.title || 'New Tab',
              title: tab.title || 'New Tab',
              url: tab.url,
              tabId: tab.id,
            })
          }
          break
        }
      }
    })
    return off
  }, [cancelClose, hideOverlay, onNewTab, onReorder, onTabClick, onTabClose, onToggleBookmarkForTab, pushSnapshot, scheduleClose])

  // Keep the overlay in sync with tab/active changes while it is open.
  useEffect(() => { pushSnapshot() }, [tabs, activeTabId, splitTabId, bookmarkedUrls, pushSnapshot])

  // Collapse the overlay whenever the rail leaves the active browser mode, and on unmount.
  useEffect(() => {
    if (!isActive) { clearTimers(); railHoveredRef.current = false; overlayHoveredRef.current = false; hideOverlay() }
  }, [clearTimers, hideOverlay, isActive])
  useEffect(() => () => {
    clearTimers()
    hideOverlay()
    endBrowserTabDragSession()
  }, [clearTimers, hideOverlay])

  const clearDragState = useCallback(() => {
    dragIndexRef.current = null
    setDragOverIndex(null)
    setDraggingTabId(null)
    endBrowserTabDragSession()
  }, [])

  const handleDragStart = useCallback((event: React.DragEvent, index: number, tab: BrowserTab) => {
    dragIndexRef.current = index
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData('text/plain', String(index))
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
    event.dataTransfer.setData('application/x-ready-drag', JSON.stringify(payload))
    setDraggingTabId(tab.id)
  }, [])

  const handleReorderDrop = useCallback((toIndex: number) => {
    const fromIndex = dragIndexRef.current
    if (fromIndex !== null && fromIndex !== toIndex) onReorder(fromIndex, toIndex)
    clearDragState()
  }, [clearDragState, onReorder])

  const handleContextMenu = useCallback((event: React.MouseEvent, tab: BrowserTab) => {
    event.preventDefault()
    event.stopPropagation()
    void showBrowserTabContextMenu(
      { x: event.clientX, y: event.clientY },
      { canReference: Boolean(tab.url || tab.title) },
    ).then((action) => {
      if (action === 'close-tab') { void onTabClose(tab.id); return }
      if (action === 'reference-to-input') {
        void addReadyContextReferenceToAgentInput({
          type: 'browser-tab',
          name: tab.title || 'New Tab',
          title: tab.title || 'New Tab',
          url: tab.url,
          tabId: tab.id,
        })
      }
    })
  }, [onTabClose])

  const handleAuxClick = useCallback((event: React.MouseEvent, id: string) => {
    if (event.button === 1) { event.preventDefault(); void onTabClose(id) }
  }, [onTabClose])

  return (
    <div
      ref={rootRef}
      className="vertical-tab-rail relative flex flex-shrink-0 flex-col"
      style={{
        width: RAIL_WIDTH,
        // SOLID chrome, no backdrop-filter — a DOM backdrop-filter element in the BrowserView band
        // fights the macOS vibrancy compositor (ghosting / bleed / false color). See LESSONS 6.8.
        background: 'var(--workbench-liquid-chrome-bg, var(--bg-content))',
        borderRight: '1px solid color-mix(in srgb, var(--text-title) 8%, transparent)',
      }}
      onMouseEnter={handleRailEnter}
      onMouseLeave={handleRailLeave}
    >
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto overflow-x-hidden py-[6px]" style={{ gap: 4 }}>
        {orderedTabs.map(({ tab, sourceIndex }, displayIndex) => {
          const isPrimaryActive = tab.id === activeTabId
          const isSplitActive = tab.id === splitTabId && !isPrimaryActive
          const isTabActive = isPrimaryActive || isSplitActive
          const isActivePair = Boolean(activeTabId && splitTabId && activeTabId !== splitTabId)
          const isDragOver = dragOverIndex === displayIndex
          const isDragging = draggingTabId === tab.id
          return (
            <div
              key={tab.id}
              className="group relative flex w-full flex-shrink-0 items-center justify-center"
              draggable
              onDragStart={(event) => handleDragStart(event, sourceIndex, tab)}
              onDragEnd={clearDragState}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverIndex(displayIndex) }}
              onDrop={(event) => { event.preventDefault(); handleReorderDrop(sourceIndex) }}
            >
              {isPrimaryActive && isActivePair && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-1/2 top-[32px] z-0 h-[14px] w-[18px] -translate-x-1/2"
                  style={{ background: 'var(--files-panel-state-active-bg)' }}
                />
              )}
              <button
                type="button"
                onClick={(event) => void onTabClick(tab.id, { shiftKey: event.shiftKey })}
                onAuxClick={(event) => handleAuxClick(event, tab.id)}
                onContextMenu={(event) => handleContextMenu(event, tab)}
                className="relative flex items-center justify-center rounded-[10px] transition-[background-color,box-shadow]"
                title={tab.title || 'New Tab'}
                style={{
                  width: 38,
                  height: 38,
                  opacity: isDragging ? 0.5 : 1,
                  background: isTabActive
                    ? 'var(--files-panel-state-active-bg)'
                    : isDragOver
                      ? 'color-mix(in srgb, var(--color-blue) 10%, transparent)'
                      : 'transparent',
                  boxShadow: isDragOver
                    ? '0 0 0 1px var(--color-blue)'
                    : isTabActive
                      ? 'var(--files-panel-state-active-shadow)'
                      : 'none',
                }}
              >
                {tabIconNode(tab, 18)}
                {tab.owner === 'agent' && (
                  <span className="absolute right-[3px] top-[3px] rounded-full" style={{ width: 6, height: 6, background: 'var(--color-blue)', boxShadow: '0 0 0 1.5px var(--workbench-liquid-chrome-bg, var(--bg-content))' }} />
                )}
                {tab.activity && tab.activity !== 'idle' && (
                  <span
                    className={`absolute bottom-[3px] right-[3px] rounded-full ${tab.activity === 'running' ? 'animate-pulse' : ''}`}
                    style={{ width: 6, height: 6, background: tab.activity === 'attention' ? 'var(--color-orange)' : 'var(--color-green)', boxShadow: '0 0 0 1.5px var(--workbench-liquid-chrome-bg, var(--bg-content))' }}
                  />
                )}
                {tab.required && <Lock className="absolute bottom-[2px] left-[2px] text-[var(--text-light)]" style={{ width: 8, height: 8 }} strokeWidth={2.5} />}
              </button>
              <button
                type="button"
                aria-label={`关闭 ${tab.title || 'New Tab'}`}
                title="关闭标签页"
                draggable={false}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); void onTabClose(tab.id) }}
                className="pointer-events-none absolute right-[4px] top-[1px] z-20 flex h-[16px] w-[16px] items-center justify-center rounded-full opacity-0 transition-[background-color,opacity] hover:bg-[var(--bg-hover)] group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
                style={{
                  background: 'color-mix(in srgb, var(--surface-floating-bg) 86%, transparent)',
                  boxShadow: '0 0 0 1px color-mix(in srgb, var(--text-title) 8%, transparent)',
                }}
              >
                <X style={{ width: 10, height: 10 }} className="text-[var(--text-gray)]" strokeWidth={2.2} />
              </button>
            </div>
          )
        })}

        {/* New-tab button sits in the next slot directly below the last tab. */}
        <div className="relative flex w-full flex-shrink-0 items-center justify-center">
          <button
            type="button"
            onClick={() => void onNewTab()}
            className="flex items-center justify-center rounded-[10px] transition-colors hover:bg-[var(--bg-hover)]"
            style={{ width: 38, height: 38 }}
            title="新标签页"
          >
            <Plus style={{ width: 16, height: 16 }} className="text-[var(--text-muted)]" strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  )
}
