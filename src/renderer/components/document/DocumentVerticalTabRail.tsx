import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Plus, X } from 'lucide-react'

export const DOCUMENT_VERTICAL_RAIL_WIDTH = 52
const RAIL_WIDTH = DOCUMENT_VERTICAL_RAIL_WIDTH
const FLYOUT_WIDTH = 264
const HOVER_OPEN_DELAY = 140
const HOVER_CLOSE_DELAY = 180

export interface DocumentVerticalTabItem {
  id: string
  label: string
  pathLabel?: string
  title?: string
  dotColor?: string
  active?: boolean
  secondaryActive?: boolean
  dirty?: boolean
}

interface DocumentVerticalTabRailProps {
  tabs: DocumentVerticalTabItem[]
  onTabClick: (id: string, event: MouseEvent) => void
  onTabClose: (id: string, event: MouseEvent) => void
  onNewTab: () => void | Promise<void>
  onTabDragStart?: (event: DragEvent, id: string) => void
  onTabDragOver?: (event: DragEvent, index: number) => void
  onTabDrop?: (event: DragEvent, index: number) => void
  onTabDragEnd?: (event: DragEvent) => void
  onTabContextMenu?: (event: MouseEvent, id: string) => void
}

function iconNode(tab: DocumentVerticalTabItem, size: number) {
  return (
    <FileText
      style={{ width: size, height: size, color: tab.dotColor || 'var(--text-gray)' }}
      strokeWidth={2}
      className="flex-shrink-0"
    />
  )
}

export default function DocumentVerticalTabRail({
  tabs,
  onTabClick,
  onTabClose,
  onNewTab,
  onTabDragStart,
  onTabDragOver,
  onTabDrop,
  onTabDragEnd,
  onTabContextMenu,
}: DocumentVerticalTabRailProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const railHoveredRef = useRef(false)
  const flyoutHoveredRef = useRef(false)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) { window.clearTimeout(openTimerRef.current); openTimerRef.current = null }
    if (closeTimerRef.current !== null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null }
  }, [])

  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current !== null) return
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      if (!railHoveredRef.current && !flyoutHoveredRef.current) setExpanded(false)
    }, HOVER_CLOSE_DELAY)
  }, [])

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null }
  }, [])

  const handleRailEnter = useCallback(() => {
    railHoveredRef.current = true
    cancelClose()
    if (expanded || openTimerRef.current !== null) return
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      if (!railHoveredRef.current) return
      setAnchorRect(rootRef.current?.getBoundingClientRect() ?? null)
      setExpanded(true)
    }, HOVER_OPEN_DELAY)
  }, [cancelClose, expanded])

  const handleRailLeave = useCallback(() => {
    railHoveredRef.current = false
    if (openTimerRef.current !== null) { window.clearTimeout(openTimerRef.current); openTimerRef.current = null }
    scheduleClose()
  }, [scheduleClose])

  useEffect(() => () => clearTimers(), [clearTimers])

  const closeNow = useCallback(() => {
    clearTimers()
    railHoveredRef.current = false
    flyoutHoveredRef.current = false
    setExpanded(false)
  }, [clearTimers])

  return (
    <div
      ref={rootRef}
      className="document-vertical-tab-rail relative flex flex-shrink-0 flex-col"
      style={{
        width: RAIL_WIDTH,
        background: 'var(--workbench-liquid-chrome-bg, var(--bg-content))',
        borderRight: '1px solid color-mix(in srgb, var(--text-title) 8%, transparent)',
      }}
      onMouseEnter={handleRailEnter}
      onMouseLeave={handleRailLeave}
    >
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto overflow-x-hidden py-[6px]" style={{ gap: 4 }}>
        {tabs.map((tab, index) => {
          const isActive = Boolean(tab.active)
          const isSplit = Boolean(tab.secondaryActive) && !isActive
          const isDragOver = dragOverIndex === index
          return (
            <div
              key={tab.id}
              className="relative flex w-full flex-shrink-0 items-center justify-center"
              draggable={Boolean(onTabDragStart)}
              onDragStart={onTabDragStart ? (event) => onTabDragStart(event, tab.id) : undefined}
              onDragEnd={(event) => { setDragOverIndex(null); onTabDragEnd?.(event) }}
              onDragOver={onTabDragOver ? (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOverIndex(index); onTabDragOver(event, index) } : undefined}
              onDrop={onTabDrop ? (event) => { event.preventDefault(); setDragOverIndex(null); onTabDrop(event, index) } : undefined}
            >
              <button
                type="button"
                onClick={(event) => onTabClick(tab.id, event)}
                onContextMenu={onTabContextMenu ? (event) => onTabContextMenu(event, tab.id) : undefined}
                className="relative flex items-center justify-center rounded-[10px] transition-[background-color,box-shadow]"
                title={tab.title || tab.label}
                style={{
                  width: 38,
                  height: 38,
                  background: isActive
                    ? 'var(--files-panel-state-active-bg)'
                    : isDragOver
                      ? 'color-mix(in srgb, var(--color-blue) 10%, transparent)'
                      : isSplit
                        ? 'color-mix(in srgb, var(--surface-card-bg) 30%, transparent)'
                        : 'transparent',
                  boxShadow: isDragOver
                    ? '0 0 0 1px var(--color-blue)'
                    : isActive
                      ? 'var(--files-panel-state-active-shadow)'
                      : 'none',
                }}
              >
                {iconNode(tab, 18)}
                {tab.dirty && (
                  <span
                    className="absolute right-[4px] top-[4px] rounded-full"
                    style={{ width: 6, height: 6, background: 'var(--text-light)', boxShadow: '0 0 0 1.5px var(--workbench-liquid-chrome-bg, var(--bg-content))' }}
                  />
                )}
              </button>
            </div>
          )
        })}

        <div className="relative flex w-full flex-shrink-0 items-center justify-center">
          <button
            type="button"
            onClick={() => void onNewTab()}
            className="flex items-center justify-center rounded-[10px] transition-colors hover:bg-[var(--bg-hover)]"
            style={{ width: 38, height: 38 }}
            title="新建"
          >
            <Plus style={{ width: 16, height: 16 }} className="text-[var(--text-muted)]" strokeWidth={2} />
          </button>
        </div>
      </div>

      {expanded && anchorRect && createPortal(
        <div
          className="document-vertical-tab-flyout flex flex-col overflow-hidden"
          style={{
            position: 'fixed',
            zIndex: 60,
            left: anchorRect.right,
            top: anchorRect.top,
            height: anchorRect.height,
            width: FLYOUT_WIDTH,
            paddingTop: 6,
            paddingBottom: 6,
            background: 'var(--workbench-liquid-chrome-bg, var(--bg-content))',
            boxShadow: 'inset 0 0 0 2000px color-mix(in srgb, var(--workbench-liquid-chrome-bg, var(--bg-content)) 80%, transparent), 14px 0 36px -16px color-mix(in srgb, var(--text-title) 38%, transparent)',
            borderTopRightRadius: 14,
            borderBottomRightRadius: 14,
            borderRight: '1px solid color-mix(in srgb, var(--text-title) 10%, transparent)',
          }}
          onMouseEnter={() => { flyoutHoveredRef.current = true; cancelClose() }}
          onMouseLeave={() => { flyoutHoveredRef.current = false; scheduleClose() }}
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" style={{ gap: 4 }}>
            {tabs.map((tab, index) => {
              const isActive = Boolean(tab.active)
              const isSplit = Boolean(tab.secondaryActive) && !isActive
              return (
                <div
                  key={tab.id}
                  className="group relative flex flex-shrink-0 cursor-pointer items-center pr-[8px]"
                  draggable={Boolean(onTabDragStart)}
                  onDragStart={onTabDragStart ? (event) => onTabDragStart(event, tab.id) : undefined}
                  onDragEnd={onTabDragEnd}
                  onDragOver={onTabDragOver ? (event) => { event.preventDefault(); onTabDragOver(event, index) } : undefined}
                  onDrop={onTabDrop ? (event) => { event.preventDefault(); onTabDrop(event, index) } : undefined}
                  onClick={(event) => { onTabClick(tab.id, event); closeNow() }}
                  onContextMenu={onTabContextMenu ? (event) => onTabContextMenu(event, tab.id) : undefined}
                  style={{
                    height: 42,
                    gap: 9,
                    paddingLeft: 10,
                    background: isActive
                      ? 'var(--files-panel-state-active-bg)'
                      : isSplit
                        ? 'color-mix(in srgb, var(--surface-card-bg) 40%, transparent)'
                        : 'transparent',
                    boxShadow: isActive ? 'var(--files-panel-state-active-shadow)' : 'none',
                    borderTopRightRadius: 10,
                    borderBottomRightRadius: 10,
                  }}
                >
                  {iconNode(tab, 15)}
                  <span className="flex min-w-0 flex-1 flex-col justify-center">
                    <span className="truncate text-[12px] font-medium" style={{ color: isActive ? 'var(--text-title)' : 'var(--text-body)', lineHeight: 1.3 }}>
                      {tab.label}
                      {tab.dirty ? <span className="ml-1" style={{ color: 'var(--text-light)' }}>●</span> : null}
                    </span>
                    {tab.pathLabel && (
                      <span className="truncate text-[10px]" style={{ color: 'var(--text-light)', lineHeight: 1.25 }}>{tab.pathLabel}</span>
                    )}
                  </span>
                  <span
                    role="button"
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => { event.stopPropagation(); onTabClose(tab.id, event) }}
                    className="flex h-[20px] w-[20px] flex-shrink-0 items-center justify-center rounded opacity-0 transition-[background-color,opacity] hover:bg-[var(--bg-hover)] group-hover:opacity-80"
                    title="关闭"
                  >
                    <X style={{ width: 12, height: 12 }} strokeWidth={2} className="text-[var(--text-gray)]" />
                  </span>
                </div>
              )
            })}
            <div
              role="button"
              onClick={() => { void onNewTab(); closeNow() }}
              className="flex flex-shrink-0 cursor-pointer items-center gap-[9px] text-[12px] transition-colors hover:bg-[var(--bg-hover)]"
              style={{ height: 42, paddingLeft: 10, color: 'var(--text-muted)', borderTopRightRadius: 10, borderBottomRightRadius: 10 }}
              title="新建"
            >
              <Plus style={{ width: 15, height: 15 }} strokeWidth={2} />
              新建文档
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
