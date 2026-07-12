import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Globe, Loader2, Plus, X } from 'lucide-react'
import type {
  VerticalRailOverlayCommand,
  VerticalRailOverlaySnapshot,
  VerticalRailOverlayTab,
} from '../../shared/browser-vertical-rail-overlay'
import type { TabGroup } from '../../shared/tab-groups'
import { buildTabRailRows, resolveReorderDrop } from '../components/tabs/tab-rail-display-model'
import { resolveTabDropIntent, tabGroupColorSoft, type TabDropIntent } from '../components/tabs/tab-group-visuals'
import TabGroupHeaderRow from '../components/tabs/TabGroupHeaderRow'
import TabGroupEditMenu, { TAB_GROUP_EDIT_MENU_EST_HEIGHT, TAB_GROUP_EDIT_MENU_WIDTH } from '../components/tabs/TabGroupEditMenu'
import {
  VERTICAL_RAIL_FLYOUT_PAD_Y,
  VERTICAL_RAIL_FLYOUT_RADIUS,
  VERTICAL_RAIL_FLYOUT_ROW_GAP,
  VERTICAL_RAIL_FLYOUT_ROW_HEIGHT,
  VERTICAL_RAIL_FLYOUT_ROW_RADIUS,
  VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND_OPAQUE,
  VERTICAL_RAIL_FLYOUT_SURFACE_BORDER,
  VERTICAL_RAIL_FLYOUT_SURFACE_SHADOW,
} from '../../shared/vertical-rail-flyout-layout'

function send(command: VerticalRailOverlayCommand): void {
  void window.electronAPI?.browser?.sendVerticalRailOverlayCommand?.(command)
}

function overlayTabIcon(tab: VerticalRailOverlayTab, size: number) {
  if (tab.loading) return <Loader2 style={{ width: size, height: size }} className="animate-spin flex-shrink-0 text-[var(--color-blue)]" strokeWidth={2} />
  if (tab.favicon) return <img src={tab.favicon} alt="" draggable={false} className="flex-shrink-0 rounded-[3px] object-cover" style={{ width: size, height: size }} />
  return <Globe style={{ width: size, height: size }} className="flex-shrink-0 text-[var(--text-gray)]" strokeWidth={2} />
}

type OverlayRow =
  | { kind: 'group-header'; group: TabGroup; memberIds: string[] }
  | { kind: 'tab'; item: VerticalRailOverlayTab; groupId: string | null; collapsed: boolean }

// Adapter over the shared display model: ids → overlay tab items, carrying each grouped
// tab's collapsed flag. Every member row is emitted; collapsed members are hidden at render.
function buildOverlayRows(
  tabs: VerticalRailOverlayTab[],
  groups: TabGroup[],
  activeId: string | null,
  splitId: string | null,
): { rows: OverlayRow[]; flatOrder: string[] } {
  const byId = new Map(tabs.map((t) => [t.id, t]))
  const collapsedOf = new Map(groups.map((g) => [g.id, g.collapsed]))
  const groupOf = Object.fromEntries(tabs.map((t) => [t.id, t.groupId ?? null]))
  const { rows: rawRows, flatOrder } = buildTabRailRows(tabs.map((t) => t.id), groupOf, groups, activeId, splitId)
  const rows: OverlayRow[] = []
  for (const row of rawRows) {
    if (row.kind === 'group-header') {
      rows.push({ kind: 'group-header', group: row.group, memberIds: row.memberIds })
      continue
    }
    const item = byId.get(row.id)
    if (!item) continue
    rows.push({ kind: 'tab', item, groupId: row.groupId, collapsed: row.groupId ? Boolean(collapsedOf.get(row.groupId)) : false })
  }
  return { rows, flatOrder }
}

export default function VerticalRailOverlayWindow() {
  const [snapshot, setSnapshot] = useState<VerticalRailOverlaySnapshot | null>(null)
  const draggingIdRef = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; intent: TabDropIntent } | null>(null)
  // The open group-edit menu, absolutely positioned INSIDE this content-sized child
  // window (a portal cannot escape it). `top` is captured from the header row at open
  // time; the rail is told via set-group-editor so the window grows to fit the menu.
  const [editing, setEditing] = useState<{ id: string; top: number } | null>(null)
  // Whether the pointer is inside the overlay, tracked independent of drag so a drag that
  // ends outside can defer the hover-leave (mid-drag hover-leave is suppressed).
  const pointerInsideRef = useRef(false)

  useEffect(() => {
    document.documentElement.dataset.verticalRailOverlayWindow = 'true'
    return () => { delete document.documentElement.dataset.verticalRailOverlayWindow }
  }, [])

  useEffect(() => {
    let cancelled = false
    const browser = window.electronAPI?.browser
    const cleanup = browser?.onVerticalRailOverlaySnapshot?.((next) => setSnapshot(next)) ?? (() => undefined)
    void browser?.getVerticalRailOverlaySnapshot?.().then((result) => {
      if (cancelled) return
      if (result?.success && result.data) setSnapshot(result.data)
      else void browser?.hideVerticalRailOverlay?.()
    })
    return () => { cancelled = true; cleanup() }
  }, [])

  const closeEditor = useCallback(() => {
    setEditing((prev) => {
      if (prev) send({ type: 'set-group-editor', groupId: null })
      return null
    })
  }, [])

  const openEditor = useCallback((group: TabGroup, anchor: DOMRect) => {
    const top = Math.round(anchor.bottom) + 4
    setEditing({ id: group.id, top })
    send({ type: 'set-group-editor', groupId: group.id, bottom: top + TAB_GROUP_EDIT_MENU_EST_HEIGHT })
  }, [])

  // The window hides without a renderer-visible IPC signal — drop a stale menu via the
  // page visibility flip so the next hover-open starts clean.
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') closeEditor() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [closeEditor])

  const finishDrag = useCallback(() => {
    draggingIdRef.current = null
    setDropTarget(null)
  }, [])

  // A drag can end anywhere (Escape, drop off a row). Clear the highlight; if the pointer
  // ended OUTSIDE the overlay, defer the hover-leave now (it was suppressed mid-drag).
  useEffect(() => {
    const reset = () => {
      const wasDragging = draggingIdRef.current !== null
      finishDrag()
      if (wasDragging && !pointerInsideRef.current) send({ type: 'hover-leave' })
    }
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)
    return () => { window.removeEventListener('dragend', reset); window.removeEventListener('drop', reset) }
  }, [finishDrag])

  const tabs = useMemo(() => snapshot?.tabs ?? [], [snapshot])
  const groups = useMemo(() => snapshot?.groups ?? [], [snapshot])
  const activeId = useMemo(() => tabs.find((t) => t.active && !t.split)?.id ?? null, [tabs])
  const splitId = useMemo(() => tabs.find((t) => t.split)?.id ?? null, [tabs])
  const { rows, flatOrder } = useMemo(() => buildOverlayRows(tabs, groups, activeId, splitId), [tabs, groups, activeId, splitId])
  const groupOf = useMemo(() => Object.fromEntries(tabs.map((t) => [t.id, t.groupId ?? null])), [tabs])
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])
  // The hoisted visual tab order — drops resolve against this, not the flat order (D-SPLIT).
  const visualTabIds = useMemo(
    () => rows.filter((r): r is Extract<OverlayRow, { kind: 'tab' }> => r.kind === 'tab').map((r) => r.item.id),
    [rows],
  )

  // Drop the editor if its group vanished from the snapshot (deleted / disbanded elsewhere).
  useEffect(() => {
    if (editing && !groupById.has(editing.id)) closeEditor()
  }, [closeEditor, editing, groupById])

  const beginDrag = useCallback((event: DragEvent, id: string) => {
    draggingIdRef.current = id
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('application/x-ready-overlay-tab-move', id)
  }, [])

  const handleRowDragOver = useCallback((event: DragEvent, targetId: string) => {
    if (!draggingIdRef.current || draggingIdRef.current === targetId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const intent = resolveTabDropIntent(event.clientY - rect.top, rect.height)
    setDropTarget((prev) => (prev && prev.id === targetId && prev.intent === intent ? prev : { id: targetId, intent }))
  }, [])

  const handleRowDrop = useCallback((event: DragEvent, targetId: string) => {
    event.preventDefault()
    const movedId = draggingIdRef.current
    const target = dropTarget
    finishDrag()
    if (!movedId || movedId === targetId || !target || target.id !== targetId) return
    const targetGroupId = groupOf[targetId] ?? null
    if (target.intent === 'onto') {
      if (targetGroupId) send({ type: 'add-to-group', tabId: movedId, groupId: targetGroupId })
      else send({ type: 'create-group', draggedTabId: movedId, targetTabId: targetId })
      return
    }
    const { toRank, intoGroupId } = resolveReorderDrop(visualTabIds, flatOrder, groupOf, movedId, targetId, target.intent, splitId)
    send({ type: 'reorder', movedTabId: movedId, toRank, intoGroupId })
  }, [dropTarget, finishDrag, flatOrder, groupOf, splitId, visualTabIds])

  // Dropping onto a group HEADER adds the dragged tab to that group (Edge behavior).
  const handleHeaderDragOver = useCallback((event: DragEvent, groupId: string) => {
    const movedId = draggingIdRef.current
    if (!movedId || (groupOf[movedId] ?? null) === groupId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget((prev) => (prev && prev.id === groupId ? prev : { id: groupId, intent: 'onto' }))
  }, [groupOf])

  const handleHeaderDrop = useCallback((event: DragEvent, groupId: string) => {
    event.preventDefault()
    const movedId = draggingIdRef.current
    finishDrag()
    if (!movedId || (groupOf[movedId] ?? null) === groupId) return
    send({ type: 'add-to-group', tabId: movedId, groupId })
  }, [finishDrag, groupOf])

  const switchTab = useCallback((tab: VerticalRailOverlayTab, event: { shiftKey: boolean }) => {
    // D-COLLAPSE: activating a member of a collapsed group auto-expands it first. (In the
    // flyout collapsed members are hidden, so this only fires for the rare header-active case.)
    const group = tab.groupId ? groupById.get(tab.groupId) : undefined
    if (group?.collapsed) send({ type: 'set-group-collapsed', groupId: group.id, collapsed: false })
    send({ type: 'switch', tabId: tab.id, shiftKey: event.shiftKey })
  }, [groupById])

  const editingGroup = editing ? groupById.get(editing.id) : undefined

  const markPointerInside = useCallback(() => {
    if (pointerInsideRef.current) return
    pointerInsideRef.current = true
    send({ type: 'hover-enter' })
  }, [])

  return (
    <div
      className="vertical-rail-overlay-root relative flex h-screen w-screen flex-col overflow-hidden"
      onMouseEnter={markPointerInside}
      // Chromium can miss the initial mouseenter when this child window becomes visible
      // underneath a pointer that is already crossing from the rail. Mouse movement is a
      // second, idempotent presence signal so the rail's close timer cannot win that race.
      onMouseMove={markPointerInside}
      onMouseLeave={() => { pointerInsideRef.current = false; if (!draggingIdRef.current) send({ type: 'hover-leave' }) }}
      style={{
        paddingTop: VERTICAL_RAIL_FLYOUT_PAD_Y,
        paddingBottom: VERTICAL_RAIL_FLYOUT_PAD_Y,
        background: VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND_OPAQUE,
        boxShadow: VERTICAL_RAIL_FLYOUT_SURFACE_SHADOW,
        borderRadius: VERTICAL_RAIL_FLYOUT_RADIUS,
        border: VERTICAL_RAIL_FLYOUT_SURFACE_BORDER,
        boxSizing: 'border-box',
        backgroundClip: 'padding-box',
      }}
    >
      <div
        className="browser-tab-rail-scroll flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden"
        style={{ gap: VERTICAL_RAIL_FLYOUT_ROW_GAP }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) }}
      >
        {rows.map((row) => {
          if (row.kind === 'group-header') {
            const g = row.group
            return (
              <TabGroupHeaderRow
                key={`h-${g.id}`}
                group={g}
                isDropTarget={dropTarget?.id === g.id && dropTarget.intent === 'onto'}
                onToggleCollapsed={() => send({ type: 'set-group-collapsed', groupId: g.id, collapsed: !g.collapsed })}
                onNewTabInGroup={() => { closeEditor(); send({ type: 'new-tab-in-group', groupId: g.id }) }}
                onEdit={(anchor) => { if (editing?.id === g.id) closeEditor(); else openEditor(g, anchor) }}
                onDragOver={(event) => handleHeaderDragOver(event, g.id)}
                onDrop={(event) => handleHeaderDrop(event, g.id)}
              />
            )
          }
          if (row.collapsed) return null // members of a collapsed group are hidden in the flyout
          const tab = row.item
          const isActive = tab.active || tab.split
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
              onDragEnd={finishDrag}
              onDragOver={(event) => handleRowDragOver(event, tab.id)}
              onDrop={(event) => handleRowDrop(event, tab.id)}
              onClick={(event) => switchTab(tab, { shiftKey: event.shiftKey })}
              onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); send({ type: 'close', tabId: tab.id }) } }}
              onContextMenu={(event) => { event.preventDefault(); send({ type: 'reference', tabId: tab.id }) }}
              style={{
                height: VERTICAL_RAIL_FLYOUT_ROW_HEIGHT,
                gap: 9,
                paddingLeft: group ? 20 : 10,
                paddingRight: 8,
                background: isDropOnto
                  ? tabGroupColorSoft(group?.color ?? 'blue', 20)
                  : isActive
                    ? 'var(--files-panel-state-active-bg)'
                    : 'transparent',
                boxShadow: isActive ? 'var(--files-panel-state-active-shadow)' : 'none',
                borderRadius: VERTICAL_RAIL_FLYOUT_ROW_RADIUS,
              }}
            >
              {isDropBefore && <span aria-hidden className="pointer-events-none absolute left-[8px] right-[8px] top-0 h-[2px] rounded" style={{ background: 'var(--color-blue)' }} />}
              {isDropAfter && <span aria-hidden className="pointer-events-none absolute left-[8px] right-[8px] bottom-0 h-[2px] rounded" style={{ background: 'var(--color-blue)' }} />}
              {overlayTabIcon(tab, 15)}
              <span className="flex min-w-0 flex-1 flex-col justify-center">
                <span className="truncate text-[12px] font-medium" style={{ color: isActive ? 'var(--text-title)' : 'var(--text-body)', lineHeight: 1.3 }}>{tab.title || 'New Tab'}</span>
                {tab.domain && <span className="truncate text-[10px]" style={{ color: 'var(--text-light)', lineHeight: 1.25 }}>{tab.domain}</span>}
              </span>
              <span
                role="button"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => { event.stopPropagation(); send({ type: 'close', tabId: tab.id }) }}
                className="flex h-[20px] w-[20px] flex-shrink-0 items-center justify-center rounded opacity-0 transition-[background-color,opacity] hover:bg-[var(--bg-hover)] group-hover:opacity-80"
                title="关闭标签页"
              >
                <X style={{ width: 12, height: 12 }} strokeWidth={2} className="text-[var(--text-gray)]" />
              </span>
            </div>
          )
        })}
        <div
          role="button"
          onClick={() => send({ type: 'new-tab' })}
          className="flex flex-shrink-0 cursor-pointer items-center gap-[8px] text-[12px] transition-colors hover:bg-[var(--bg-hover)]"
          style={{ height: VERTICAL_RAIL_FLYOUT_ROW_HEIGHT, paddingLeft: 10, color: 'var(--text-muted)', borderRadius: VERTICAL_RAIL_FLYOUT_ROW_RADIUS }}
          title="新标签页"
        >
          <Plus style={{ width: 16, height: 16 }} strokeWidth={2} />
          新标签页
        </div>
      </div>

      {editing && editingGroup && (
        <div
          className="absolute flex flex-col overflow-hidden"
          style={{
            left: 8,
            top: editing.top,
            width: TAB_GROUP_EDIT_MENU_WIDTH,
            zIndex: 40,
            borderRadius: 12,
            background: VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND_OPAQUE,
            border: VERTICAL_RAIL_FLYOUT_SURFACE_BORDER,
            boxShadow: 'var(--chat-menu-shadow, 0 24px 48px rgba(31, 36, 46, 0.16)), 0 2px 8px rgba(0, 0, 0, 0.08)',
          }}
        >
          <TabGroupEditMenu
            // Keyed by group id: switching groups remounts, so the old instance's
            // unmount-commit runs against the OLD group's draft (P3 review lineage).
            key={editing.id}
            group={editingGroup}
            onRename={(name) => send({ type: 'rename-group', groupId: editing.id, name })}
            onRecolor={(color) => send({ type: 'recolor-group', groupId: editing.id, color })}
            onNewTab={() => { send({ type: 'new-tab-in-group', groupId: editing.id }); closeEditor() }}
            onDisband={() => { send({ type: 'disband-group', groupId: editing.id }); closeEditor() }}
            onDelete={() => { send({ type: 'delete-group', groupId: editing.id }); closeEditor() }}
            onRequestClose={closeEditor}
          />
        </div>
      )}
    </div>
  )
}
