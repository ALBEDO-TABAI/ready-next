import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, FileText, Plus, X } from 'lucide-react'
import type { TabGroup, TabGroupColor } from '../../../shared/tab-groups'
import {
  resolveTabDropIntent,
  tabGroupColorSoft,
  tabGroupColorVar,
  tabGroupPillTextColor,
  type TabDropIntent,
} from '../tabs/tab-group-visuals'
import TabGroupHeaderRow from '../tabs/TabGroupHeaderRow'
import TabGroupEditMenu, { TAB_GROUP_EDIT_MENU_EST_HEIGHT, TAB_GROUP_EDIT_MENU_WIDTH } from '../tabs/TabGroupEditMenu'
import { buildTabRailRows, resolveReorderDrop } from '../tabs/tab-rail-display-model'
import {
  resolveGroupedFlyoutContentHeight,
  VERTICAL_RAIL_FLYOUT_GROUP_HEADER_HEIGHT,
  VERTICAL_RAIL_FLYOUT_MIN_HEIGHT,
  VERTICAL_RAIL_FLYOUT_PAD_Y,
  VERTICAL_RAIL_FLYOUT_RADIUS,
  VERTICAL_RAIL_FLYOUT_ROW_GAP,
  VERTICAL_RAIL_FLYOUT_ROW_HEIGHT,
  VERTICAL_RAIL_FLYOUT_ROW_RADIUS,
  VERTICAL_RAIL_FLYOUT_SURFACE_BACKDROP,
  VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND,
  VERTICAL_RAIL_FLYOUT_SURFACE_BORDER,
  VERTICAL_RAIL_FLYOUT_SURFACE_SHADOW,
} from '../../../shared/vertical-rail-flyout-layout'

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
  /** 文件管理里为该文件设置的自定义呈现图标（emoji/短文字），优先于默认 FileText。 */
  customIcon?: string | null
  active?: boolean
  secondaryActive?: boolean
  dirty?: boolean
  groupId?: string | null
}

interface DocumentVerticalTabRailProps {
  tabs: DocumentVerticalTabItem[]
  groups?: TabGroup[]
  onTabClick: (id: string, event: MouseEvent) => void
  onTabClose: (id: string, event: MouseEvent) => void
  onNewTab: () => void | Promise<void>
  // Attach cross-component drag payload (e.g. dropping a doc tab onto the chat panel).
  // The intra-rail group reorder is handled internally via the ops below.
  onTabDragStart?: (event: DragEvent, id: string) => void
  onTabDragEnd?: (event: DragEvent) => void
  onTabContextMenu?: (event: MouseEvent, id: string) => void
  // Group ops (all no-ops when omitted → rail degrades to the pre-groups behavior).
  // Per-tab removal is drag-out (resolveReorderDrop clears the group by drop geometry).
  onCreateGroup?: (draggedId: string, targetId: string) => void
  onAddToGroup?: (tabId: string, groupId: string) => void
  onReorderToRank?: (movedId: string, toRank: number, intoGroupId: string | null) => void
  onRenameGroup?: (groupId: string, name: string) => void
  onRecolorGroup?: (groupId: string, color: TabGroupColor) => void
  onSetGroupCollapsed?: (groupId: string, collapsed: boolean) => void
  onDisbandGroup?: (groupId: string) => void
  onDeleteGroup?: (groupId: string) => void
  onNewTabInGroup?: (groupId: string) => void
}

function iconNode(tab: DocumentVerticalTabItem, size: number) {
  const isHighlighted = Boolean(tab.active || tab.secondaryActive)
  if (tab.customIcon) {
    return (
      <span
        aria-hidden
        className="flex-shrink-0"
        style={{
          width: size,
          height: size,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: Math.max(11, Math.round(size * 0.9)),
          lineHeight: 1,
          color: isHighlighted ? tab.dotColor || 'var(--text-title)' : 'var(--text-gray)',
          filter: isHighlighted ? 'none' : 'grayscale(0.35)',
        }}
      >
        {tab.customIcon}
      </span>
    )
  }
  return (
    <FileText
      style={{ width: size, height: size, color: isHighlighted ? tab.dotColor || 'var(--ready-document-tab-doc-dot, var(--color-ready-orange))' : 'var(--text-gray)' }}
      strokeWidth={2}
      className="flex-shrink-0"
    />
  )
}

// A flat display row: a group header or a tab. Group runs stay contiguous; the split
// tab is hoisted next to the active tab only WITHIN its own run (D-SPLIT / I-DISPLAY),
// so grouping is never visually broken.
type DisplayRow =
  | { kind: 'group-header'; group: TabGroup; memberIds: string[] }
  | { kind: 'tab'; item: DocumentVerticalTabItem; groupId: string | null; flatRank: number; collapsed: boolean }

// Thin adapter over the pure display model: resolve ids → projection items and carry
// each grouped tab's collapsed flag. Every member row is emitted; collapsed members are
// hidden at render (strip and flyout both stand a group chip/pill in for them).
function buildDisplayRows(
  tabs: DocumentVerticalTabItem[],
  groups: TabGroup[],
  activeId: string | null,
  splitId: string | null,
): { rows: DisplayRow[]; flatOrder: string[] } {
  const byId = new Map(tabs.map((t) => [t.id, t]))
  const collapsedOf = new Map(groups.map((g) => [g.id, g.collapsed]))
  const groupOf = Object.fromEntries(tabs.map((t) => [t.id, t.groupId ?? null]))
  const { rows: rawRows, flatOrder } = buildTabRailRows(tabs.map((t) => t.id), groupOf, groups, activeId, splitId)
  const rows: DisplayRow[] = []
  for (const row of rawRows) {
    if (row.kind === 'group-header') {
      rows.push({ kind: 'group-header', group: row.group, memberIds: row.memberIds })
      continue
    }
    const item = byId.get(row.id)
    if (!item) continue
    rows.push({
      kind: 'tab',
      item,
      groupId: row.groupId,
      flatRank: row.flatRank,
      collapsed: row.groupId ? Boolean(collapsedOf.get(row.groupId)) : false,
    })
  }
  return { rows, flatOrder }
}

export default function DocumentVerticalTabRail({
  tabs,
  groups = [],
  onTabClick,
  onTabClose,
  onNewTab,
  onTabDragStart,
  onTabDragEnd,
  onTabContextMenu,
  onCreateGroup,
  onAddToGroup,
  onReorderToRank,
  onRenameGroup,
  onRecolorGroup,
  onSetGroupCollapsed,
  onDisbandGroup,
  onDeleteGroup,
  onNewTabInGroup,
}: DocumentVerticalTabRailProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const railListRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  // The group whose edit popup is open, anchored off the header's options button rect
  // so the popup can be PORTALED (escaping the flyout's overflow-hidden clip).
  const [editingGroup, setEditingGroup] = useState<{ id: string; rect: DOMRect } | null>(null)
  // Drag preview state: the id being dragged + the current drop target + intent.
  const draggingIdRef = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; intent: TabDropIntent } | null>(null)
  const railHoveredRef = useRef(false)
  const flyoutHoveredRef = useRef(false)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  const groupsEnabled = Boolean(onReorderToRank && onCreateGroup)

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) { window.clearTimeout(openTimerRef.current); openTimerRef.current = null }
    if (closeTimerRef.current !== null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null }
  }, [])

  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current !== null) return
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      if (draggingIdRef.current) return // never self-close mid-drag
      if (!railHoveredRef.current && !flyoutHoveredRef.current) { setExpanded(false); setEditingGroup(null) }
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
    setEditingGroup(null)
  }, [clearTimers])

  const activeId = useMemo(() => tabs.find((t) => t.active)?.id ?? null, [tabs])
  const splitId = useMemo(() => tabs.find((t) => t.secondaryActive && t.id !== activeId)?.id ?? null, [activeId, tabs])
  const { rows, flatOrder } = useMemo(
    () => buildDisplayRows(tabs, groups, activeId, splitId),
    [tabs, groups, activeId, splitId],
  )
  // The hoisted visual tab order — drops resolve against this, not the flat order (D-SPLIT).
  const visualTabIds = useMemo(
    () => rows.filter((r): r is Extract<DisplayRow, { kind: 'tab' }> => r.kind === 'tab').map((r) => r.item.id),
    [rows],
  )
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  // What the 52px strip actually renders: group-header chips + tab icons, with members of
  // a COLLAPSED group hidden (Edge semantics — the chip stands in for the group). Drop
  // resolution keeps using the full hoisted visual order; hiding is render-only.
  const stripRows = useMemo(() => rows.filter((row) => row.kind === 'group-header' || !row.collapsed), [rows])
  // Size the flyout to the rows it ACTUALLY renders: group headers (26px) + visible
  // (non-collapsed) tab rows (38px) + the trailing action, capped at the available
  // height. When capped, the inner list scrolls itself (overflow-y-auto below).
  const visibleTabRows = useMemo(() => rows.filter((r) => r.kind === 'tab' && !r.collapsed).length, [rows])
  const headerRows = useMemo(() => rows.filter((r) => r.kind === 'group-header').length, [rows])
  const flyoutHeight = anchorRect
    ? Math.min(
        Math.max(VERTICAL_RAIL_FLYOUT_MIN_HEIGHT, Math.round(anchorRect.height)),
        resolveGroupedFlyoutContentHeight(visibleTabRows, headerRows),
      )
    : 0

  // ---- drag ----
  const beginDrag = useCallback((event: DragEvent, id: string) => {
    draggingIdRef.current = id
    event.dataTransfer.effectAllowed = 'copyMove'
    event.dataTransfer.setData('application/x-ready-doc-tab-move', id)
    onTabDragStart?.(event, id) // cross-component payload (chat panel etc.)
  }, [onTabDragStart])

  const handleRowDragOver = useCallback((event: DragEvent, targetId: string) => {
    if (!groupsEnabled || !draggingIdRef.current || draggingIdRef.current === targetId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const intent = resolveTabDropIntent(event.clientY - rect.top, rect.height)
    setDropTarget((prev) => (prev && prev.id === targetId && prev.intent === intent ? prev : { id: targetId, intent }))
  }, [groupsEnabled])

  const finishDrag = useCallback(() => {
    draggingIdRef.current = null
    setDropTarget(null)
  }, [])

  const handleRowDrop = useCallback((event: DragEvent, targetId: string) => {
    if (!groupsEnabled) return
    event.preventDefault()
    const movedId = draggingIdRef.current
    const target = dropTarget
    finishDrag()
    if (!movedId || movedId === targetId || !target || target.id !== targetId) return
    const targetGroupId = tabs.find((t) => t.id === targetId)?.groupId ?? null
    if (target.intent === 'onto') {
      if (targetGroupId) onAddToGroup?.(movedId, targetGroupId)
      else onCreateGroup?.(movedId, targetId)
      return
    }
    const groupOf = Object.fromEntries(tabs.map((t) => [t.id, t.groupId ?? null]))
    const { toRank, intoGroupId } = resolveReorderDrop(visualTabIds, flatOrder, groupOf, movedId, targetId, target.intent, splitId)
    onReorderToRank?.(movedId, toRank, intoGroupId)
  }, [dropTarget, finishDrag, flatOrder, groupsEnabled, onAddToGroup, onCreateGroup, onReorderToRank, splitId, tabs, visualTabIds])

  // Dropping onto a group HEADER adds the dragged tab to that group (Edge behavior).
  const handleHeaderDragOver = useCallback((event: DragEvent, groupId: string) => {
    if (!groupsEnabled || !onAddToGroup) return
    const movedId = draggingIdRef.current
    if (!movedId || (tabs.find((t) => t.id === movedId)?.groupId ?? null) === groupId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget((prev) => (prev && prev.id === groupId ? prev : { id: groupId, intent: 'onto' }))
  }, [groupsEnabled, onAddToGroup, tabs])

  const handleHeaderDrop = useCallback((event: DragEvent, groupId: string) => {
    if (!groupsEnabled || !onAddToGroup) return
    event.preventDefault()
    const movedId = draggingIdRef.current
    finishDrag()
    if (!movedId || (tabs.find((t) => t.id === movedId)?.groupId ?? null) === groupId) return
    onAddToGroup(movedId, groupId)
  }, [finishDrag, groupsEnabled, onAddToGroup, tabs])

  const handleDragEndAll = useCallback((event: DragEvent) => {
    finishDrag()
    onTabDragEnd?.(event)
  }, [finishDrag, onTabDragEnd])

  const activateTab = useCallback((id: string, event: MouseEvent, groupId: string | null) => {
    // D-COLLAPSE: activating a tab inside a collapsed group auto-expands the group.
    if (groupId) {
      const g = groupById.get(groupId)
      if (g?.collapsed) onSetGroupCollapsed?.(groupId, false)
    }
    onTabClick(id, event)
  }, [groupById, onSetGroupCollapsed, onTabClick])

  // Clear a stale drop highlight when the drag ends ANYWHERE (pointer leaves the rail,
  // drop lands on another component, Escape) — dragover only fires while over a row.
  useEffect(() => {
    const reset = () => finishDrag()
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)
    return () => { window.removeEventListener('dragend', reset); window.removeEventListener('drop', reset) }
  }, [finishDrag])

  return (
    <div
      ref={rootRef}
      className="document-vertical-tab-rail relative flex flex-shrink-0 flex-col"
      style={{
        width: RAIL_WIDTH,
        background: 'var(--workbench-module-surface-bg, var(--workbench-liquid-chrome-bg, var(--bg-content)))',
        borderRight: '1px solid color-mix(in srgb, var(--text-title) 8%, transparent)',
      }}
      onMouseEnter={handleRailEnter}
      onMouseLeave={handleRailLeave}
    >
      {/* 52px icon strip: a group chip per header (click = collapse/expand, drop = add
          to group; members hidden while collapsed) + one icon per visible tab, with a
          continuous group-color spine on grouped icons. */}
      <div
        ref={railListRef}
        className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto overflow-x-hidden"
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) }}
        style={{ gap: VERTICAL_RAIL_FLYOUT_ROW_GAP, paddingTop: VERTICAL_RAIL_FLYOUT_PAD_Y, paddingBottom: VERTICAL_RAIL_FLYOUT_PAD_Y }}
      >
        {stripRows.map((row, index) => {
          if (row.kind === 'group-header') {
            const g = row.group
            const GroupCaret = g.collapsed ? ChevronRight : ChevronDown
            // With the group collapsed its member icons are hidden, so the chip carries
            // the active state (ring) when the active/split doc lives inside it.
            const chipShowsActive = g.collapsed && Boolean(
              (activeId && row.memberIds.includes(activeId)) || (splitId && row.memberIds.includes(splitId)),
            )
            const isDropOntoChip = dropTarget?.id === g.id && dropTarget.intent === 'onto'
            return (
              <div
                key={`h-${g.id}`}
                className="relative flex w-full flex-shrink-0 items-center justify-center"
                style={{ height: VERTICAL_RAIL_FLYOUT_GROUP_HEADER_HEIGHT }}
                onDragOver={(event) => handleHeaderDragOver(event, g.id)}
                onDrop={(event) => handleHeaderDrop(event, g.id)}
              >
                <button
                  type="button"
                  // Mouse clicks must not focus the chip — the global :focus-visible
                  // outline would linger as a stray blue ring. Keyboard focus still works.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSetGroupCollapsed?.(g.id, !g.collapsed)}
                  title={`${g.name || '未命名群组'}（${g.collapsed ? '展开' : '折叠'}群组）`}
                  className="flex items-center justify-center rounded-[8px] transition-[background-color,box-shadow]"
                  style={{
                    width: VERTICAL_RAIL_FLYOUT_ROW_HEIGHT,
                    height: VERTICAL_RAIL_FLYOUT_GROUP_HEADER_HEIGHT,
                    background: isDropOntoChip
                      ? tabGroupColorSoft(g.color, 22)
                      : chipShowsActive
                        ? 'var(--files-panel-state-active-bg)'
                        : 'transparent',
                    boxShadow: isDropOntoChip
                      ? `0 0 0 1px ${tabGroupColorVar(g.color)}`
                      : chipShowsActive
                        ? 'var(--files-panel-state-active-shadow)'
                        : 'none',
                  }}
                >
                  {/* Same height/radius as the flyout header pill so the two shapes sit
                      edge-aligned when the flyout is open next to the strip. */}
                  <span
                    className="flex items-center justify-center transition-[filter] hover:brightness-[1.06]"
                    style={{
                      width: 28,
                      height: 20,
                      borderRadius: 6,
                      background: tabGroupColorVar(g.color),
                      color: tabGroupPillTextColor(g.color),
                      boxShadow: '0 1px 2px rgba(0, 0, 0, 0.10)',
                    }}
                  >
                    <GroupCaret style={{ width: 11, height: 11 }} strokeWidth={2.75} />
                  </span>
                </button>
              </div>
            )
          }
          const tab = row.item
          const isActive = Boolean(tab.active)
          const isSplit = Boolean(tab.secondaryActive) && !isActive
          const isHighlighted = isActive || isSplit
          const group = row.groupId ? groupById.get(row.groupId) : undefined
          // Same-group neighbours in the strip: bridge the row gap so the group bar reads
          // as one continuous line. STRIP-ONLY by 白's call (07-10) — the flyout stays
          // line-free; here the icons have no other affiliation cue below the chip.
          const prevRow = stripRows[index - 1]
          const nextRow = stripRows[index + 1]
          const prevSameGroup = Boolean(group) && prevRow?.kind === 'tab' && prevRow.groupId === row.groupId
          const nextSameGroup = Boolean(group) && nextRow?.kind === 'tab' && nextRow.groupId === row.groupId
          const isDropOnto = dropTarget?.id === tab.id && dropTarget.intent === 'onto'
          const isDropBefore = dropTarget?.id === tab.id && dropTarget.intent === 'before'
          const isDropAfter = dropTarget?.id === tab.id && dropTarget.intent === 'after'
          return (
            <div
              key={tab.id}
              className="group relative flex w-full flex-shrink-0 items-center justify-center"
              draggable
              onDragStart={(event) => beginDrag(event, tab.id)}
              onDragEnd={handleDragEndAll}
              onDragOver={(event) => handleRowDragOver(event, tab.id)}
              onDrop={(event) => handleRowDrop(event, tab.id)}
            >
              {group && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute"
                  style={{
                    left: 0,
                    width: 3,
                    background: tabGroupColorVar(group.color),
                    top: prevSameGroup ? -VERTICAL_RAIL_FLYOUT_ROW_GAP : 8,
                    bottom: nextSameGroup ? 0 : 8,
                    borderTopRightRadius: prevSameGroup ? 0 : 2,
                    borderBottomRightRadius: nextSameGroup ? 0 : 2,
                  }}
                />
              )}
              {isDropBefore && <span aria-hidden className="pointer-events-none absolute left-[6px] right-[6px] top-0 h-[2px] rounded" style={{ background: 'var(--color-blue)' }} />}
              {isDropAfter && <span aria-hidden className="pointer-events-none absolute left-[6px] right-[6px] bottom-0 h-[2px] rounded" style={{ background: 'var(--color-blue)' }} />}
              <button
                type="button"
                onClick={(event) => activateTab(tab.id, event, row.groupId)}
                onContextMenu={onTabContextMenu ? (event) => onTabContextMenu(event, tab.id) : undefined}
                className="relative flex items-center justify-center rounded-[10px] transition-[background-color,box-shadow]"
                title={tab.title || tab.label}
                style={{
                  width: VERTICAL_RAIL_FLYOUT_ROW_HEIGHT,
                  height: VERTICAL_RAIL_FLYOUT_ROW_HEIGHT,
                  background: isDropOnto
                    ? (group ? tabGroupColorSoft(group.color, 22) : 'color-mix(in srgb, var(--color-blue) 16%, transparent)')
                    : isHighlighted ? 'var(--files-panel-state-active-bg)' : 'transparent',
                  boxShadow: isDropOnto
                    ? `0 0 0 1px ${group ? tabGroupColorVar(group.color) : 'var(--color-blue)'}`
                    : isHighlighted ? 'var(--files-panel-state-active-shadow)' : 'none',
                }}
              >
                {iconNode(tab, 18)}
              </button>
              <button
                type="button"
                aria-label={`关闭 ${tab.title || tab.label}`}
                title="关闭"
                draggable={false}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); onTabClose(tab.id, event) }}
                className="pointer-events-none absolute right-[4px] top-[1px] z-20 flex h-[16px] w-[16px] items-center justify-center rounded-full opacity-0 transition-[background-color,opacity] hover:bg-[var(--bg-hover)] group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
                style={{ background: 'color-mix(in srgb, var(--surface-floating-bg) 86%, transparent)', boxShadow: '0 0 0 1px color-mix(in srgb, var(--text-title) 8%, transparent)' }}
              >
                <X style={{ width: 10, height: 10 }} strokeWidth={2.2} className="text-[var(--text-gray)]" />
              </button>
            </div>
          )
        })}

        <div className="relative flex w-full flex-shrink-0 items-center justify-center">
          <button
            type="button"
            onClick={() => void onNewTab()}
            className="flex items-center justify-center rounded-[10px] transition-colors hover:bg-[var(--bg-hover)]"
            style={{ width: VERTICAL_RAIL_FLYOUT_ROW_HEIGHT, height: VERTICAL_RAIL_FLYOUT_ROW_HEIGHT }}
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
            position: 'fixed', zIndex: 60, left: anchorRect.right, top: anchorRect.top,
            height: flyoutHeight, width: FLYOUT_WIDTH,
            paddingTop: VERTICAL_RAIL_FLYOUT_PAD_Y, paddingBottom: VERTICAL_RAIL_FLYOUT_PAD_Y,
            background: VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND, boxShadow: VERTICAL_RAIL_FLYOUT_SURFACE_SHADOW,
            backdropFilter: VERTICAL_RAIL_FLYOUT_SURFACE_BACKDROP, WebkitBackdropFilter: VERTICAL_RAIL_FLYOUT_SURFACE_BACKDROP,
            borderRadius: VERTICAL_RAIL_FLYOUT_RADIUS, border: VERTICAL_RAIL_FLYOUT_SURFACE_BORDER,
            boxSizing: 'border-box', backgroundClip: 'padding-box',
          }}
          onMouseEnter={() => { flyoutHoveredRef.current = true; cancelClose() }}
          onMouseLeave={() => { flyoutHoveredRef.current = false; scheduleClose() }}
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" style={{ gap: VERTICAL_RAIL_FLYOUT_ROW_GAP }}>
            {rows.map((row) => {
              if (row.kind === 'group-header') {
                const g = row.group
                return (
                  <TabGroupHeaderRow
                    key={`h-${g.id}`}
                    group={g}
                    isDropTarget={dropTarget?.id === g.id && dropTarget.intent === 'onto'}
                    onToggleCollapsed={() => onSetGroupCollapsed?.(g.id, !g.collapsed)}
                    onNewTabInGroup={() => { setEditingGroup(null); onNewTabInGroup?.(g.id) }}
                    onEdit={(anchor) => setEditingGroup((prev) => (prev?.id === g.id ? null : { id: g.id, rect: anchor }))}
                    onDragOver={(event) => handleHeaderDragOver(event, g.id)}
                    onDrop={(event) => handleHeaderDrop(event, g.id)}
                  />
                )
              }
              if (row.collapsed) return null // members of a collapsed group are hidden in the flyout
              const tab = row.item
              const isActive = Boolean(tab.active)
              const isSplit = Boolean(tab.secondaryActive) && !isActive
              const isHighlighted = isActive || isSplit
              const group = row.groupId ? groupById.get(row.groupId) : undefined
              const isDropOnto = dropTarget?.id === tab.id && dropTarget.intent === 'onto'
              const isDropBefore = dropTarget?.id === tab.id && dropTarget.intent === 'before'
              const isDropAfter = dropTarget?.id === tab.id && dropTarget.intent === 'after'
              return (
                <div
                  key={tab.id}
                  className="group relative flex flex-shrink-0 cursor-pointer items-center"
                  draggable
                  onDragStart={(event) => beginDrag(event, tab.id)}
                  onDragEnd={handleDragEndAll}
                  onDragOver={(event) => handleRowDragOver(event, tab.id)}
                  onDrop={(event) => handleRowDrop(event, tab.id)}
                  onClick={(event) => { activateTab(tab.id, event, row.groupId); closeNow() }}
                  onContextMenu={onTabContextMenu ? (event) => onTabContextMenu(event, tab.id) : undefined}
                  style={{
                    height: VERTICAL_RAIL_FLYOUT_ROW_HEIGHT, gap: 9, paddingLeft: group ? 20 : 10, paddingRight: 8,
                    background: isDropOnto ? tabGroupColorSoft(group?.color ?? 'blue', 20) : isHighlighted ? 'var(--files-panel-state-active-bg)' : 'transparent',
                    boxShadow: isHighlighted ? 'var(--files-panel-state-active-shadow)' : 'none',
                    borderRadius: VERTICAL_RAIL_FLYOUT_ROW_RADIUS,
                  }}
                >
                  {isDropBefore && <span aria-hidden className="pointer-events-none absolute left-[8px] right-[8px] top-0 h-[2px] rounded" style={{ background: 'var(--color-blue)' }} />}
                  {isDropAfter && <span aria-hidden className="pointer-events-none absolute left-[8px] right-[8px] bottom-0 h-[2px] rounded" style={{ background: 'var(--color-blue)' }} />}
                  {iconNode(tab, 15)}
                  <span className="flex min-w-0 flex-1 flex-col justify-center">
                    <span className="truncate text-[12px] font-medium" style={{ color: isHighlighted ? 'var(--text-title)' : 'var(--text-body)', lineHeight: 1.3 }}>{tab.label}</span>
                    {tab.pathLabel && <span className="truncate text-[10px]" style={{ color: 'var(--text-light)', lineHeight: 1.25 }}>{tab.pathLabel}</span>}
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
              style={{ height: VERTICAL_RAIL_FLYOUT_ROW_HEIGHT, paddingLeft: 10, color: 'var(--text-muted)', borderRadius: VERTICAL_RAIL_FLYOUT_ROW_RADIUS }}
              title="新建"
            >
              <Plus style={{ width: 15, height: 15 }} strokeWidth={2} />
              新建文档
            </div>
          </div>
        </div>,
        document.body,
      )}

      {editingGroup && groupById.get(editingGroup.id) && createPortal(
        <GroupEditPopup
          // key remounts on group switch so useState re-inits with the new group's
          // name AND the old instance's unmount-commit runs against the OLD group —
          // without it, switching groups renames the wrong group (stale name commit).
          key={editingGroup.id}
          anchor={editingGroup.rect}
          group={groupById.get(editingGroup.id) as TabGroup}
          onRename={(nextName) => onRenameGroup?.(editingGroup.id, nextName)}
          onRecolor={(color) => onRecolorGroup?.(editingGroup.id, color)}
          onNewTab={() => { onNewTabInGroup?.(editingGroup.id); setEditingGroup(null) }}
          onDisband={() => { onDisbandGroup?.(editingGroup.id); setEditingGroup(null) }}
          onDelete={() => { onDeleteGroup?.(editingGroup.id); setEditingGroup(null) }}
          onClose={() => setEditingGroup(null)}
          onHoverEnter={() => { flyoutHoveredRef.current = true; cancelClose() }}
          onHoverLeave={() => { flyoutHoveredRef.current = false; scheduleClose() }}
        />,
        document.body,
      )}
    </div>
  )
}

// Floating host for the shared Edge-style edit menu: fixed-position portal anchored off
// the group header ROW (menu left-aligns with the pill), flipping up if it would overflow.
function GroupEditPopup({
  anchor,
  group,
  onRename,
  onRecolor,
  onNewTab,
  onDisband,
  onDelete,
  onClose,
  onHoverEnter,
  onHoverLeave,
}: {
  anchor: DOMRect
  group: TabGroup
  onRename: (name: string) => void
  onRecolor: (color: TabGroupColor) => void
  onNewTab: () => void
  onDisband: () => void
  onDelete: () => void
  onClose: () => void
  onHoverEnter: () => void
  onHoverLeave: () => void
}) {
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1200
  const left = Math.max(8, Math.min(anchor.left + 6, viewportW - TAB_GROUP_EDIT_MENU_WIDTH - 8))
  const openUp = anchor.bottom + TAB_GROUP_EDIT_MENU_EST_HEIGHT + 8 > viewportH
  const top = openUp ? Math.max(8, anchor.top - TAB_GROUP_EDIT_MENU_EST_HEIGHT - 4) : anchor.bottom + 4
  return (
    <div
      className="flex flex-col overflow-hidden"
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: 70,
        width: TAB_GROUP_EDIT_MENU_WIDTH,
        background: VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND,
        backdropFilter: VERTICAL_RAIL_FLYOUT_SURFACE_BACKDROP,
        WebkitBackdropFilter: VERTICAL_RAIL_FLYOUT_SURFACE_BACKDROP,
        boxShadow: VERTICAL_RAIL_FLYOUT_SURFACE_SHADOW,
        border: VERTICAL_RAIL_FLYOUT_SURFACE_BORDER,
        borderRadius: 12,
      }}
      onMouseEnter={onHoverEnter}
      onMouseLeave={onHoverLeave}
      onClick={(event) => event.stopPropagation()}
    >
      <TabGroupEditMenu
        group={group}
        onRename={onRename}
        onRecolor={onRecolor}
        onNewTab={onNewTab}
        onDisband={onDisband}
        onDelete={onDelete}
        onRequestClose={onClose}
      />
    </div>
  )
}
