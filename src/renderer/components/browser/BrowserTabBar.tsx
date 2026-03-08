import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Plus, X, Globe, Loader2, ChevronLeft, ChevronRight, Lock
} from 'lucide-react'
import { MorphTabButton, MorphTabStrip } from '../motion/MorphTabStrip'
import { WORKBENCH_HEADER_EDGE_X, WORKBENCH_TAB_MAX_WIDTH, WORKBENCH_TAB_ROW_HEIGHT } from '../../modules/workbench/chrome'

interface Tab {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  domain?: string
  favicon?: string
  owner?: 'manual' | 'agent'
  required?: boolean
  activity?: 'idle' | 'running' | 'attention'
}

interface BrowserTabBarProps {
  tabs: Tab[]
  activeTabId: string | null
  onTabClick: (id: string) => void
  onTabClose: (id: string) => void
  onNewTab: () => void
  onReorder: (fromIndex: number, toIndex: number) => void
}

export default function BrowserTabBar({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onNewTab,
  onReorder,
}: BrowserTabBarProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [showLeftArrow, setShowLeftArrow] = useState(false)
  const [showRightArrow, setShowRightArrow] = useState(false)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const dragIndexRef = useRef<number | null>(null)

  // Check overflow state
  const checkOverflow = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setShowLeftArrow(el.scrollLeft > 0)
    setShowRightArrow(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    checkOverflow()
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', checkOverflow)
    const observer = new ResizeObserver(checkOverflow)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', checkOverflow)
      observer.disconnect()
    }
  }, [checkOverflow, tabs.length])

  const scrollLeft = () => {
    scrollRef.current?.scrollBy({ left: -160, behavior: 'smooth' })
  }
  const scrollRight = () => {
    scrollRef.current?.scrollBy({ left: 160, behavior: 'smooth' })
  }

  // Drag handlers
  const handleDragStart = (e: React.DragEvent, index: number) => {
    dragIndexRef.current = index
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
    // Attach ready-drag data for cross-component drop (e.g. ChatPanel)
    const tab = tabs[index]
    if (tab) {
      const data = JSON.stringify({
        type: 'browser-tab' as const,
        name: tab.title || 'New Tab',
        title: tab.title || 'New Tab',
        url: tab.url,
        ext: '.url',
        tabId: tab.id,
        draggedAt: Date.now(),
      })
      e.dataTransfer.setData('application/x-ready-drag', data)
    }
    // Make the drag image semi-transparent
    const target = e.currentTarget as HTMLElement
    target.style.opacity = '0.5'
  }

  const handleDragEnd = (e: React.DragEvent) => {
    const target = e.currentTarget as HTMLElement
    target.style.opacity = '1'
    dragIndexRef.current = null
    setDragOverIndex(null)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverIndex(index)
  }

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault()
    const fromIndex = dragIndexRef.current
    if (fromIndex !== null && fromIndex !== toIndex) {
      onReorder(fromIndex, toIndex)
    }
    dragIndexRef.current = null
    setDragOverIndex(null)
  }

  // Middle-click close
  const handleAuxClick = (e: React.MouseEvent, id: string) => {
    if (e.button === 1) {
      e.preventDefault()
      onTabClose(id)
    }
  }

  return (
    <div
      className="glass-surface-panel flex items-center no-drag"
      style={{
        height: WORKBENCH_TAB_ROW_HEIGHT,
        background: 'var(--surface-toolbar-bg)',
        borderBottom: '1px solid var(--border-default)',
        gap: 0,
      }}
    >
      <div
        className="flex items-center flex-1 min-w-0"
        style={{ paddingLeft: WORKBENCH_HEADER_EDGE_X, paddingRight: WORKBENCH_HEADER_EDGE_X, gap: 0 }}
      >
      {/* Scroll left arrow */}
      {showLeftArrow && (
        <button
          onClick={scrollLeft}
          className="flex items-center justify-center flex-shrink-0 hover:bg-[var(--bg-hover)] transition-colors"
          style={{ width: 20, height: 26, borderRadius: 4 }}
        >
          <ChevronLeft style={{ width: 12, height: 12 }} className="text-[var(--text-gray)]" strokeWidth={2} />
        </button>
      )}

      {/* Tabs scroll container */}
      <div
        ref={scrollRef}
        className="flex items-end flex-1 overflow-x-hidden"
        style={{ gap: 1, minWidth: 0 }}
      >
        <MorphTabStrip layoutId="browser-tabs" className="flex min-w-0 flex-1 items-end gap-[1px]">
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeTabId
            const isDragOver = dragOverIndex === index
            return (
              <MorphTabButton
                key={tab.id}
                layoutId="browser-tabs"
                active={isActive}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={(e) => handleDrop(e, index)}
                onClick={() => onTabClick(tab.id)}
                onAuxClick={(e) => handleAuxClick(e, tab.id)}
                className="group relative flex min-w-0 flex-1 cursor-pointer items-center rounded-t-[8px] px-[10px] text-[12px] transition-all duration-150"
                style={{
                  gap: 6,
                  height: isActive ? 33 : 28,
                  flex: '1 1 0',
                  maxWidth: WORKBENCH_TAB_MAX_WIDTH,
                  minWidth: 0,
                  background: isActive ? 'var(--surface-card-bg)' : 'transparent',
                  color: isActive ? 'var(--text-title)' : 'var(--text-gray)',
                  borderLeft: isDragOver ? '2px solid var(--color-blue)' : '2px solid transparent',
                  alignSelf: 'flex-end',
                }}
                contentClassName="relative z-[1] flex min-w-0 flex-1 items-center gap-[6px]"
              >
                {tab.loading ? (
                  <Loader2
                    style={{ width: 14, height: 14 }}
                    className="text-[var(--color-blue)] animate-spin flex-shrink-0"
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

                <span className="truncate flex-1" style={{ lineHeight: '28px' }}>
                  {tab.title || 'New Tab'}
                </span>

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
                  onClick={(e) => {
                    e.stopPropagation()
                    onTabClose(tab.id)
                  }}
                  className="rounded opacity-0 group-hover:opacity-100 hover:bg-[var(--bg-hover)] transition-all cursor-pointer flex-shrink-0"
                  style={{ padding: 2 }}
                  title="Close tab"
                >
                  <X style={{ width: 10, height: 10 }} strokeWidth={2} />
                </span>
              </MorphTabButton>
            )
          })}
        </MorphTabStrip>

      </div>

      <div className="flex items-center flex-shrink-0" style={{ gap: 2 }}>
        <button
          onClick={onNewTab}
          className="flex items-center justify-center hover:bg-[var(--bg-hover)] transition-colors flex-shrink-0"
          style={{ width: 26, height: 26, borderRadius: 6 }}
          title="New tab"
        >
          <Plus style={{ width: 14, height: 14 }} className="text-[var(--text-muted)]" strokeWidth={2} />
        </button>

        {/* Scroll right arrow */}
        {showRightArrow && (
          <button
            onClick={scrollRight}
            className="flex items-center justify-center flex-shrink-0 hover:bg-[var(--bg-hover)] transition-colors"
            style={{ width: 20, height: 26, borderRadius: 4 }}
          >
            <ChevronRight style={{ width: 12, height: 12 }} className="text-[var(--text-gray)]" strokeWidth={2} />
          </button>
        )}
      </div>
      </div>
    </div>
  )
}
