import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Globe, Loader2, Lock, Plus, X } from 'lucide-react'
import {
  beginBrowserTabDragSession,
  endBrowserTabDragSession,
} from '../../modules/browser/browserTabDragSession'
import {
  addReadyContextReferenceToAgentInput,
  showBrowserTabContextMenu,
} from '../../modules/agent/chat-input-bridge'
import type { BrowserTab } from '../../stores/useBrowserTabs'
import type { TabGroup, TabGroupColor } from '../../../shared/tab-groups'
import type {
  VerticalRailOverlayCommand,
  VerticalRailOverlaySnapshot,
} from '../../../shared/browser-vertical-rail-overlay'
import {
  resolveGroupedFlyoutContentHeight,
  VERTICAL_RAIL_FLYOUT_GROUP_HEADER_HEIGHT,
  VERTICAL_RAIL_FLYOUT_MIN_HEIGHT,
  VERTICAL_RAIL_FLYOUT_PAD_Y,
  VERTICAL_RAIL_FLYOUT_ROW_GAP,
} from '../../../shared/vertical-rail-flyout-layout'
import { buildTabRailRows, resolveReorderDrop } from '../tabs/tab-rail-display-model'
import {
  resolveTabDropIntent,
  tabGroupColorVar,
  tabGroupColorSoft,
  tabGroupPillTextColor,
  type TabDropIntent,
} from '../tabs/tab-group-visuals'
import { buildOverlaySnapshotTabs } from './vertical-rail-overlay-snapshot'

export const BROWSER_VERTICAL_RAIL_WIDTH = 52
const RAIL_WIDTH = BROWSER_VERTICAL_RAIL_WIDTH
const HOVER_OPEN_DELAY = 140
const HOVER_CLOSE_DELAY = 180
const STRIP_ICON = 38

interface VerticalTabRailProps {
  isActive: boolean
  tabs: BrowserTab[]
  tabGroups: TabGroup[]
  activeTabId: string | null
  splitTabId: string | null
  bookmarkedUrls: string[]
  onTabClick: (id: string, event: { shiftKey: boolean }) => void | Promise<void>
  onTabClose: (id: string) => void | Promise<void>
  onNewTab: () => void | Promise<void>
  // id-based reorder (D-CMD): toRank is a flat rank; intoGroupId (re)assigns the group.
  onReorderToRank: (movedId: string, toRank: number, intoGroupId: string | null) => void
  onCreateGroup: (draggedId: string, targetId: string) => void
  onAddToGroup: (tabId: string, groupId: string) => void
  onRemoveFromGroup: (tabId: string) => void
  onRenameGroup: (groupId: string, name: string) => void
  onRecolorGroup: (groupId: string, color: TabGroupColor) => void
  onSetGroupCollapsed: (groupId: string, collapsed: boolean) => void
  onDisbandGroup: (groupId: string) => void
  onDeleteGroup: (groupId: string) => void
  onNewTabInGroup: (groupId: string) => void
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
  tabGroups,
  activeTabId,
  splitTabId,
  bookmarkedUrls,
  onTabClick,
  onTabClose,
  onNewTab,
  onReorderToRank,
  onCreateGroup,
  onAddToGroup,
  onRemoveFromGroup,
  onRenameGroup,
  onRecolorGroup,
  onSetGroupCollapsed,
  onDisbandGroup,
  onDeleteGroup,
  onNewTabInGroup,
  onToggleBookmarkForTab,
}: VerticalTabRailProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const railListRef = useRef<HTMLDivElement>(null)
  // id-based drag state (two-intent): the dragged id + the current drop target + intent.
  const draggingIdRef = useRef<string | null>(null)
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; intent: TabDropIntent } | null>(null)

  // Native-overlay hover flyout state (cross-window dual-hover arbitration).
  const railHoveredRef = useRef(false)
  const overlayHoveredRef = useRef(false)
  const overlayOpenRef = useRef(false)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  // The overlay's group-edit menu floats inside the content-sized child window; while it
  // is open the snapshot height must reserve room down to the menu's bottom edge.
  const overlayEditorRef = useRef<{ groupId: string; bottom: number } | null>(null)

  // Keep latest props (state + all callbacks) reachable from the IPC command handler
  // without re-subscribing the overlay command listener each render.
  const latestRef = useRef({
    tabs, tabGroups, activeTabId, splitTabId, bookmarkedUrls,
    onTabClick, onTabClose, onNewTab, onReorderToRank, onCreateGroup, onAddToGroup,
    onRemoveFromGroup, onRenameGroup, onRecolorGroup, onSetGroupCollapsed,
    onDisbandGroup, onDeleteGroup, onNewTabInGroup, onToggleBookmarkForTab,
  })
  latestRef.current = {
    tabs, tabGroups, activeTabId, splitTabId, bookmarkedUrls,
    onTabClick, onTabClose, onNewTab, onReorderToRank, onCreateGroup, onAddToGroup,
    onRemoveFromGroup, onRenameGroup, onRecolorGroup, onSetGroupCollapsed,
    onDisbandGroup, onDeleteGroup, onNewTabInGroup, onToggleBookmarkForTab,
  }

  const groupOf = useMemo(
    () => Object.fromEntries(tabs.map((tab) => [tab.id, tab.groupId ?? null])),
    [tabs],
  )
  const { rows, flatOrder } = useMemo(
    () => buildTabRailRows(tabs.map((tab) => tab.id), groupOf, tabGroups, activeTabId, splitTabId),
    [tabs, groupOf, tabGroups, activeTabId, splitTabId],
  )
  const tabRows = useMemo(
    () => rows.filter((row): row is Extract<typeof rows[number], { kind: 'tab' }> => row.kind === 'tab'),
    [rows],
  )
  const tabById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs])
  const groupById = useMemo(() => new Map(tabGroups.map((group) => [group.id, group])), [tabGroups])
  // What the 52px strip actually renders: group-header chips + tab icons, with members of
  // a COLLAPSED group hidden (Edge semantics — the chip stands in for the group). Drop
  // resolution keeps using the full hoisted tabRows order; hiding is render-only.
  const stripRows = useMemo(
    () => rows.filter((row) => row.kind === 'group-header' || !(row.groupId && groupById.get(row.groupId)?.collapsed)),
    [rows, groupById],
  )

  // D-SNAPSHOT: emit the RAW FLAT tab order + per-tab groupId + the group list. The
  // overlay window does its own run-local split hoist; a reorder command's toRank is
  // resolved against this flat array. Never wrap the overlay tabs in a global display
  // hoist (getActiveTabPairOrder) — that would put toRank in display space (drift gate
  // check-overlay-snapshot-flat-order).
  const buildSnapshot = useCallback((): VerticalRailOverlaySnapshot | null => {
    const root = rootRef.current
    if (!root) return null
    const rect = root.getBoundingClientRect()
    if (rect.height <= 0) return null
    const { tabs: t, tabGroups: g, activeTabId: aId, splitTabId: sId, bookmarkedUrls: marks } = latestRef.current
    const overlayTabs = buildOverlaySnapshotTabs(t, aId, sId, marks)
    const collapsedGroupIds = new Set(g.filter((group) => group.collapsed).map((group) => group.id))
    const visibleTabRows = t.filter((tab) => !(tab.groupId && collapsedGroupIds.has(tab.groupId))).length
    const height = Math.min(
      Math.max(VERTICAL_RAIL_FLYOUT_MIN_HEIGHT, Math.round(rect.height)),
      resolveGroupedFlyoutContentHeight(visibleTabRows, g.length),
    )
    // While the overlay's group-edit menu is open, grow the window down to the menu's
    // reported bottom edge (the menu floats inside the child window and would clip).
    const editor = overlayEditorRef.current
    const editorFloor = editor && g.some((group) => group.id === editor.groupId)
      ? Math.round(editor.bottom) + VERTICAL_RAIL_FLYOUT_PAD_Y
      : 0
    return {
      tabs: overlayTabs,
      groups: g,
      bounds: { left: Math.round(rect.left), top: Math.round(rect.top), width: RAIL_WIDTH, height: Math.max(height, editorFloor) },
      scrollTop: Math.round(railListRef.current?.scrollTop ?? 0),
    }
  }, [])

  const pushSnapshot = useCallback(() => {
    if (!overlayOpenRef.current) return
    const snapshot = buildSnapshot()
    if (snapshot) void window.electronAPI?.browser?.showVerticalRailOverlay?.(snapshot)
  }, [buildSnapshot])

  const hideOverlay = useCallback(() => {
    overlayOpenRef.current = false
    overlayEditorRef.current = null
    void window.electronAPI?.browser?.hideVerticalRailOverlay?.()
  }, [])

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) { window.clearTimeout(openTimerRef.current); openTimerRef.current = null }
    if (closeTimerRef.current !== null) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null }
  }, [])

  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current !== null) return
    // Cross-window enter/leave delivery is advisory only. While the child window is open,
    // keep checking the OS cursor so a missed event can neither close early nor stay open.
    const checkForClose = async () => {
      closeTimerRef.current = null
      if (!overlayOpenRef.current) return
      if (draggingIdRef.current) {
        closeTimerRef.current = window.setTimeout(checkForClose, HOVER_CLOSE_DELAY)
        return
      }
      const result = await window.electronAPI?.browser?.isVerticalRailOverlayPointerInside?.().catch(() => null)
      if (!overlayOpenRef.current) return
      if (result?.success && result.data) {
        closeTimerRef.current = window.setTimeout(checkForClose, HOVER_CLOSE_DELAY)
        return
      }
      if (!result?.success && (railHoveredRef.current || overlayHoveredRef.current)) {
        closeTimerRef.current = window.setTimeout(checkForClose, HOVER_CLOSE_DELAY)
        return
      }
      hideOverlay()
    }
    closeTimerRef.current = window.setTimeout(checkForClose, HOVER_CLOSE_DELAY)
  }, [hideOverlay])

  const handleRailEnter = useCallback(() => {
    railHoveredRef.current = true
    if (overlayOpenRef.current) { scheduleClose(); return }
    if (openTimerRef.current !== null) return
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      if (!railHoveredRef.current) return
      const snapshot = buildSnapshot()
      if (!snapshot) return
      overlayOpenRef.current = true
      void window.electronAPI?.browser?.showVerticalRailOverlay?.(snapshot)
      scheduleClose()
    }, HOVER_OPEN_DELAY)
  }, [buildSnapshot, scheduleClose])

  const handleRailLeave = useCallback(() => {
    railHoveredRef.current = false
    if (openTimerRef.current !== null) { window.clearTimeout(openTimerRef.current); openTimerRef.current = null }
    scheduleClose()
  }, [scheduleClose])

  // Dispatch commands coming back from the overlay window. Reads all handlers off
  // latestRef so the subscription stays stable across renders.
  useEffect(() => {
    const off = window.electronAPI?.browser?.onVerticalRailOverlayCommand?.((command: VerticalRailOverlayCommand) => {
      const h = latestRef.current
      const later = () => setTimeout(pushSnapshot, 0)
      switch (command.type) {
        case 'hover-enter':
          overlayHoveredRef.current = true
          scheduleClose()
          break
        case 'hover-leave':
          overlayHoveredRef.current = false
          scheduleClose()
          break
        case 'switch':
          void h.onTabClick(command.tabId, { shiftKey: Boolean(command.shiftKey) })
          overlayHoveredRef.current = false
          hideOverlay()
          break
        case 'close':
          void Promise.resolve(h.onTabClose(command.tabId)).then(later)
          break
        case 'new-tab':
          void h.onNewTab()
          overlayHoveredRef.current = false
          hideOverlay()
          break
        case 'reorder':
          h.onReorderToRank(command.movedTabId, command.toRank, command.intoGroupId)
          later()
          break
        case 'create-group':
          h.onCreateGroup(command.draggedTabId, command.targetTabId)
          later()
          break
        case 'add-to-group':
          h.onAddToGroup(command.tabId, command.groupId)
          later()
          break
        case 'remove-from-group':
          h.onRemoveFromGroup(command.tabId)
          later()
          break
        case 'rename-group':
          h.onRenameGroup(command.groupId, command.name)
          later()
          break
        case 'recolor-group':
          h.onRecolorGroup(command.groupId, command.color)
          later()
          break
        case 'set-group-collapsed':
          h.onSetGroupCollapsed(command.groupId, command.collapsed)
          later()
          break
        case 'disband-group':
          h.onDisbandGroup(command.groupId)
          later()
          break
        case 'delete-group':
          h.onDeleteGroup(command.groupId)
          later()
          break
        case 'new-tab-in-group':
          h.onNewTabInGroup(command.groupId)
          later()
          break
        case 'set-group-editor':
          overlayEditorRef.current = command.groupId
            ? { groupId: command.groupId, bottom: command.bottom ?? 0 }
            : null
          pushSnapshot()
          break
        case 'toggle-bookmark': {
          const tab = h.tabs.find((item) => item.id === command.tabId)
          if (tab) h.onToggleBookmarkForTab(tab)
          later()
          break
        }
        case 'reference': {
          const tab = h.tabs.find((item) => item.id === command.tabId)
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
  }, [hideOverlay, pushSnapshot, scheduleClose])

  // Keep the overlay in sync with tab/group/active changes while it is open.
  useEffect(() => { pushSnapshot() }, [tabs, tabGroups, activeTabId, splitTabId, bookmarkedUrls, pushSnapshot])

  // Collapse the overlay whenever the rail leaves the active browser mode, and on unmount.
  useEffect(() => {
    if (!isActive) { clearTimers(); railHoveredRef.current = false; overlayHoveredRef.current = false; hideOverlay() }
  }, [clearTimers, hideOverlay, isActive])
  useEffect(() => () => {
    clearTimers()
    hideOverlay()
    endBrowserTabDragSession()
  }, [clearTimers, hideOverlay])

  // ---- strip drag (two-intent: onto → group, before/after → reorder) ----
  const clearDragState = useCallback(() => {
    draggingIdRef.current = null
    setDropTarget(null)
    setDraggingTabId(null)
    endBrowserTabDragSession()
  }, [])

  const handleDragStart = useCallback((event: React.DragEvent, tab: BrowserTab) => {
    draggingIdRef.current = tab.id
    event.dataTransfer.effectAllowed = 'copyMove'
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
    event.dataTransfer.setData('text/plain', tab.url || tab.title || '')
    setDraggingTabId(tab.id)
  }, [])

  const handleRowDragOver = useCallback((event: React.DragEvent, targetId: string) => {
    if (!draggingIdRef.current || draggingIdRef.current === targetId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const intent = resolveTabDropIntent(event.clientY - rect.top, rect.height)
    setDropTarget((prev) => (prev && prev.id === targetId && prev.intent === intent ? prev : { id: targetId, intent }))
  }, [])

  const handleRowDrop = useCallback((event: React.DragEvent, targetId: string) => {
    event.preventDefault()
    const movedId = draggingIdRef.current
    const target = dropTarget
    clearDragState()
    if (!movedId || movedId === targetId || !target || target.id !== targetId) return
    const targetGroupId = groupOf[targetId] ?? null
    if (target.intent === 'onto') {
      if (targetGroupId) onAddToGroup(movedId, targetGroupId)
      else onCreateGroup(movedId, targetId)
      return
    }
    const { toRank, intoGroupId } = resolveReorderDrop(tabRows.map((r) => r.id), flatOrder, groupOf, movedId, targetId, target.intent, splitTabId)
    onReorderToRank(movedId, toRank, intoGroupId)
  }, [clearDragState, dropTarget, flatOrder, groupOf, onAddToGroup, onCreateGroup, onReorderToRank, splitTabId, tabRows])

  // Dropping onto a group chip adds the dragged tab to that group (Edge behavior).
  const handleHeaderDragOver = useCallback((event: React.DragEvent, groupId: string) => {
    const movedId = draggingIdRef.current
    if (!movedId || (groupOf[movedId] ?? null) === groupId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget((prev) => (prev && prev.id === groupId ? prev : { id: groupId, intent: 'onto' }))
  }, [groupOf])

  const handleHeaderDrop = useCallback((event: React.DragEvent, groupId: string) => {
    event.preventDefault()
    const movedId = draggingIdRef.current
    clearDragState()
    if (!movedId || (groupOf[movedId] ?? null) === groupId) return
    onAddToGroup(movedId, groupId)
  }, [clearDragState, groupOf, onAddToGroup])

  // Clear a stale drop highlight when the drag ends ANYWHERE (Escape, drop off-rail).
  useEffect(() => {
    const reset = () => clearDragState()
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)
    return () => { window.removeEventListener('dragend', reset); window.removeEventListener('drop', reset) }
  }, [clearDragState])

  const activateTab = useCallback((id: string, shiftKey: boolean, groupId: string | null) => {
    // D-COLLAPSE: activating a tab inside a collapsed group auto-expands the group.
    if (groupId) {
      const g = groupById.get(groupId)
      if (g?.collapsed) onSetGroupCollapsed(groupId, false)
    }
    void onTabClick(id, { shiftKey })
  }, [groupById, onSetGroupCollapsed, onTabClick])

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
        // No backdrop-filter — a DOM backdrop-filter element in the BrowserView band
        // fights the macOS vibrancy compositor (ghosting / bleed / false color). See LESSONS 6.8.
        // 材质与横向 .browser-header-surface / 文档竖栏同源：夜间 chrome-bg 是近实心海军蓝，
        // 会让竖栏比横栏更深一档。
        background: 'var(--workbench-module-surface-bg, var(--workbench-liquid-chrome-bg, var(--bg-content)))',
        borderRight: '1px solid color-mix(in srgb, var(--text-title) 8%, transparent)',
      }}
      onMouseEnter={handleRailEnter}
      onMouseLeave={handleRailLeave}
    >
      <div
        ref={railListRef}
        className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto overflow-x-hidden"
        onScroll={() => pushSnapshot()}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) }}
        // Padding via the shared constant, INLINE — the strip and the overlay flyout must
        // start their first row at the same offset for cross-window row alignment, and a
        // Tailwind arbitrary class (the old py-[6px]) is not reliably in the built CSS.
        style={{ gap: VERTICAL_RAIL_FLYOUT_ROW_GAP, paddingTop: VERTICAL_RAIL_FLYOUT_PAD_Y, paddingBottom: VERTICAL_RAIL_FLYOUT_PAD_Y }}
      >
        {stripRows.map((row, index) => {
          if (row.kind === 'group-header') {
            const g = row.group
            const GroupCaret = g.collapsed ? ChevronRight : ChevronDown
            // With the group collapsed its member icons are hidden, so the chip carries
            // the active state (ring) when the active/split tab lives inside it.
            const chipShowsActive = g.collapsed && Boolean(
              (activeTabId && row.memberIds.includes(activeTabId)) || (splitTabId && row.memberIds.includes(splitTabId)),
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
                  onClick={() => onSetGroupCollapsed(g.id, !g.collapsed)}
                  title={`${g.name || '未命名群组'}（${g.collapsed ? '展开' : '折叠'}群组）`}
                  className="flex items-center justify-center rounded-[8px] transition-[background-color,box-shadow]"
                  style={{
                    width: STRIP_ICON,
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
                  {/* Same height/radius as the flyout header pill so the two blue shapes
                      sit edge-aligned when the flyout is open next to the strip. */}
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
          const tab = tabById.get(row.id)
          if (!tab) return null
          const isPrimaryActive = tab.id === activeTabId
          const isSplitActive = tab.id === splitTabId && !isPrimaryActive
          const isTabActive = isPrimaryActive || isSplitActive
          const prevRow = stripRows[index - 1]
          const nextRow = stripRows[index + 1]
          // The split-pair connector nub bridges the active icon down to the split icon,
          // so only draw it when the split is ACTUALLY the next VISIBLE row. The run-local
          // hoist keeps the split adjacent to the active only within one run (I-DISPLAY);
          // when they straddle runs (e.g. active grouped, split ungrouped) they aren't
          // adjacent — and a split hidden inside a collapsed group must never be bridged —
          // otherwise the nub would falsely pair the active with whatever icon sits below.
          const splitIsNextRow = Boolean(splitTabId) && splitTabId !== activeTabId && nextRow?.kind === 'tab' && nextRow.id === splitTabId
          const group = row.groupId ? groupById.get(row.groupId) : undefined
          // Same-group neighbours in the strip: bridge the row gap so the group bar reads
          // as one continuous line. STRIP-ONLY by 白's call (07-10) — the flyout stays
          // line-free; here the icons have no other affiliation cue below the chip.
          const prevSameGroup = Boolean(group) && prevRow?.kind === 'tab' && prevRow.groupId === row.groupId
          const nextSameGroup = Boolean(group) && nextRow?.kind === 'tab' && nextRow.groupId === row.groupId
          const isDragging = draggingTabId === tab.id
          const isDropOnto = dropTarget?.id === tab.id && dropTarget.intent === 'onto'
          const isDropBefore = dropTarget?.id === tab.id && dropTarget.intent === 'before'
          const isDropAfter = dropTarget?.id === tab.id && dropTarget.intent === 'after'
          return (
            <div
              key={tab.id}
              className="group relative flex w-full flex-shrink-0 items-center justify-center"
              draggable
              onDragStart={(event) => handleDragStart(event, tab)}
              onDragEnd={clearDragState}
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
              {isPrimaryActive && splitIsNextRow && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-1/2 top-[32px] z-0 h-[14px] w-[18px] -translate-x-1/2"
                  style={{ background: 'var(--files-panel-state-active-bg)' }}
                />
              )}
              <button
                type="button"
                onClick={(event) => activateTab(tab.id, event.shiftKey, row.groupId)}
                onAuxClick={(event) => handleAuxClick(event, tab.id)}
                onContextMenu={(event) => handleContextMenu(event, tab)}
                className="relative flex items-center justify-center rounded-[10px] transition-[background-color,box-shadow]"
                title={tab.title || 'New Tab'}
                style={{
                  width: STRIP_ICON,
                  height: STRIP_ICON,
                  opacity: isDragging ? 0.5 : 1,
                  background: isDropOnto
                    ? (group ? tabGroupColorSoft(group.color, 22) : 'color-mix(in srgb, var(--color-blue) 16%, transparent)')
                    : isTabActive
                      ? 'var(--files-panel-state-active-bg)'
                      : 'transparent',
                  boxShadow: isDropOnto
                    ? `0 0 0 1px ${group ? tabGroupColorVar(group.color) : 'var(--color-blue)'}`
                    : isTabActive
                      ? 'var(--files-panel-state-active-shadow)'
                      : 'none',
                }}
              >
                {tabIconNode(tab, 18)}
                {tab.owner === 'agent' && (
                  <span className="absolute right-[3px] top-[3px] rounded-full" style={{ width: 6, height: 6, background: 'var(--color-blue)', boxShadow: '0 0 0 1.5px var(--workbench-module-surface-bg, var(--workbench-liquid-chrome-bg, var(--bg-content)))' }} />
                )}
                {tab.activity && tab.activity !== 'idle' && (
                  <span
                    className={`absolute bottom-[3px] right-[3px] rounded-full ${tab.activity === 'running' ? 'animate-pulse' : ''}`}
                    style={{ width: 6, height: 6, background: tab.activity === 'attention' ? 'var(--color-orange)' : 'var(--color-green)', boxShadow: '0 0 0 1.5px var(--workbench-module-surface-bg, var(--workbench-liquid-chrome-bg, var(--bg-content)))' }}
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
            style={{ width: STRIP_ICON, height: STRIP_ICON }}
            title="新标签页"
          >
            <Plus style={{ width: 16, height: 16 }} className="text-[var(--text-muted)]" strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  )
}
