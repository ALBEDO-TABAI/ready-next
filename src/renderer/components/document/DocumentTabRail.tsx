import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react'
import { MorphTabButton, MorphTabStrip } from '../motion/MorphTabStrip'
import { getTabRailLayoutMetrics } from '../../modules/browser/tab-rail-layout'
import {
  WORKBENCH_HEADER_EDGE_X,
  WORKBENCH_TAB_MAX_WIDTH,
  WORKBENCH_TAB_ROW_HEIGHT,
} from '../../modules/workbench/chrome'

export interface DocumentTabRailItem {
  id: string
  label: string
  title?: string
  dotColor?: string
  active?: boolean
  secondaryActive?: boolean
  dirty?: boolean
}

interface DocumentTabRailProps {
  layoutId: string
  tabs: DocumentTabRailItem[]
  onTabClick: (id: string, event: MouseEvent<HTMLButtonElement>) => void
  onTabClose?: (id: string, event: MouseEvent<HTMLElement>) => void
  onNewTab: () => void | Promise<void>
  onTabDragStart?: (event: DragEvent<HTMLButtonElement>, id: string) => void
  onTabDragOver?: (event: DragEvent<HTMLButtonElement>, index: number) => void
  onTabDrop?: (event: DragEvent<HTMLButtonElement>, index: number) => void
  onTabDragEnd?: (event: DragEvent<HTMLButtonElement>) => void
  rightActions?: ReactNode
}

export default function DocumentTabRail({
  layoutId,
  tabs,
  onTabClick,
  onTabClose,
  onNewTab,
  onTabDragStart,
  onTabDragOver,
  onTabDrop,
  onTabDragEnd,
  rightActions,
}: DocumentTabRailProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const previousTabCountRef = useRef(tabs.length)
  const [showLeftArrow, setShowLeftArrow] = useState(false)
  const [showRightArrow, setShowRightArrow] = useState(false)
  const [hoveredTabId, setHoveredTabId] = useState<string | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const layoutMetrics = getTabRailLayoutMetrics(tabs.length)

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
    const shouldBiasToEnd = tabCountChanged || Boolean(lastTab.active)
    if (!shouldBiasToEnd) return

    const frame = requestAnimationFrame(() => {
      const targetLeft = Math.max(0, element.scrollWidth - element.clientWidth)
      element.scrollTo({ left: targetLeft, behavior: 'smooth' })
      checkOverflow()
    })

    return () => cancelAnimationFrame(frame)
  }, [checkOverflow, tabs])

  const handleDragOver = (event: DragEvent<HTMLButtonElement>, index: number) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOverIndex(index)
    onTabDragOver?.(event, index)
  }

  const handleDrop = (event: DragEvent<HTMLButtonElement>, index: number) => {
    event.preventDefault()
    setDragOverIndex(null)
    onTabDrop?.(event, index)
  }

  const handleDragEnd = (event: DragEvent<HTMLButtonElement>) => {
    setDragOverIndex(null)
    onTabDragEnd?.(event)
  }

  return (
    <div
      data-liquid-shell="workbench-tabs"
      className="workbench-tabs-surface glass-surface-panel flex-shrink-0"
    >
      <div className="flex items-center justify-between min-w-0" style={{ minHeight: WORKBENCH_TAB_ROW_HEIGHT }}>
        <div className="flex min-w-0 flex-1 items-center" style={{ gap: 6, paddingLeft: WORKBENCH_HEADER_EDGE_X }}>
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
            className="document-tab-rail-scroll flex min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden"
          >
            <MorphTabStrip layoutId={layoutId} className="flex min-w-0 items-center gap-[6px]">
              {tabs.map((tab, index) => {
                const isActive = Boolean(tab.active)
                const isSecondaryActive = Boolean(tab.secondaryActive) && !isActive
                const isHovered = hoveredTabId === tab.id
                const isDragOver = dragOverIndex === index
                const rightReserve = onTabClose ? 28 : 0

                return (
                  <div
                    key={tab.id}
                    className="relative flex min-w-0 flex-shrink-0 items-center"
                    style={{
                      width: isActive ? layoutMetrics.activeCompactWidth : layoutMetrics.inactiveWidth,
                      minWidth: isActive ? layoutMetrics.activeCompactMinWidth : layoutMetrics.inactiveMinWidth,
                      maxWidth: WORKBENCH_TAB_MAX_WIDTH,
                    }}
                  >
                    <MorphTabButton
                      layoutId={layoutId}
                      active={false}
                      secondaryActive={false}
                      suppressLiquidPill
                      draggable={Boolean(onTabDragStart)}
                      onDragStart={onTabDragStart ? (event) => onTabDragStart(event, tab.id) : undefined}
                      onDragOver={onTabDragOver ? (event) => handleDragOver(event, index) : undefined}
                      onDrop={onTabDrop ? (event) => handleDrop(event, index) : undefined}
                      onDragEnd={handleDragEnd}
                      onClick={(event) => onTabClick(tab.id, event)}
                      onMouseEnter={() => setHoveredTabId(tab.id)}
                      onMouseLeave={() => setHoveredTabId((current) => current === tab.id ? null : current)}
                      className="group relative flex min-w-0 w-full cursor-pointer items-center rounded-[14px] border px-[10px] text-[12px] transition-all duration-150"
                      style={{
                        gap: 6,
                        height: Math.max(30, WORKBENCH_TAB_ROW_HEIGHT - 4),
                        background: isActive
                          ? 'color-mix(in srgb, var(--surface-card-bg) 18%, transparent)'
                          : isSecondaryActive
                            ? 'color-mix(in srgb, var(--surface-card-bg) 12%, transparent)'
                            : isHovered
                              ? 'color-mix(in srgb, var(--surface-card-bg) 20%, transparent)'
                              : 'transparent',
                        color: isActive || isSecondaryActive ? 'var(--text-body)' : 'var(--text-gray)',
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
                      title={tab.title}
                    >
                      <>
                        <span
                          className="flex min-w-0 items-center justify-center gap-[6px]"
                          style={{
                            maxWidth: `calc(100% - ${rightReserve}px)`,
                            marginRight: rightReserve,
                          }}
                        >
                          {tab.dotColor ? (
                            <span
                              className="flex-shrink-0 rounded-full"
                              style={{ width: 8, height: 8, background: tab.dotColor }}
                            />
                          ) : null}

                          <span
                            className="truncate flex-1 min-w-0"
                            style={{ lineHeight: '28px', color: isActive ? 'var(--text-title)' : isSecondaryActive ? 'var(--text-body)' : 'var(--text-gray)' }}
                          >
                            {tab.label}
                            {tab.dirty ? <span className="ml-0.5" style={{ color: 'var(--text-light)' }}>●</span> : null}
                          </span>
                        </span>

                        {onTabClose ? (
                          <span
                            role="button"
                            onClick={(event) => {
                              event.stopPropagation()
                              onTabClose(tab.id, event)
                            }}
                            className="absolute right-[8px] top-1/2 flex items-center justify-center rounded opacity-70 group-hover:opacity-100 hover:bg-[var(--bg-hover)] transition-all cursor-pointer"
                            style={{ width: 18, height: 18, transform: 'translateY(-50%)' }}
                            title="Close"
                          >
                            <X style={{ width: 10, height: 10 }} strokeWidth={2} />
                          </span>
                        ) : null}
                      </>
                    </MorphTabButton>
                  </div>
                )
              })}
              <button
                type="button"
                onClick={() => void onNewTab()}
                className="ml-[6px] flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center rounded-[8px] transition-colors hover:bg-[var(--bg-hover)]"
                title="新建"
              >
                <Plus style={{ width: 14, height: 14 }} className="text-[var(--text-muted)]" strokeWidth={2} />
              </button>
            </MorphTabStrip>
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

        {rightActions ? (
          <div
            className="flex items-center justify-end flex-shrink-0 h-full"
            style={{ gap: 8, paddingLeft: 8, paddingRight: WORKBENCH_HEADER_EDGE_X }}
          >
            {rightActions}
          </div>
        ) : null}
      </div>
    </div>
  )
}
