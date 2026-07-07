import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { ChevronDown, ChevronRight, Globe, Loader2, MoreHorizontal, Plus, X } from 'lucide-react'
import type {
  VerticalRailOverlayCommand,
  VerticalRailOverlaySnapshot,
  VerticalRailOverlayTab,
} from '../../shared/browser-vertical-rail-overlay'
import type { TabGroup, TabGroupColor } from '../../shared/tab-groups'
import { TAB_GROUP_COLORS } from '../../shared/tab-groups'
import { buildTabRailRows, resolveReorderDrop } from '../components/tabs/tab-rail-display-model'
import { resolveTabDropIntent, tabGroupColorSoft, tabGroupColorVar, type TabDropIntent } from '../components/tabs/tab-group-visuals'
import {
  VERTICAL_RAIL_FLYOUT_PAD_Y,
  VERTICAL_RAIL_FLYOUT_RADIUS,
  VERTICAL_RAIL_FLYOUT_ROW_GAP,
  VERTICAL_RAIL_FLYOUT_ROW_HEIGHT,
  VERTICAL_RAIL_FLYOUT_ROW_RADIUS,
  VERTICAL_RAIL_FLYOUT_SURFACE_BACKDROP,
  VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND,
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
  // The group whose inline editor is open. Rendered inside the list (no floating popup —
  // this is a fixed, content-sized child window that a portal cannot escape).
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
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

  // Drop the editor if its group vanished from the snapshot (deleted / disbanded elsewhere).
  useEffect(() => {
    if (editingGroupId && !groupById.has(editingGroupId)) setEditingGroupId(null)
  }, [editingGroupId, groupById])

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
    const { toRank, intoGroupId } = resolveReorderDrop(flatOrder, groupOf, movedId, targetId, target.intent)
    send({ type: 'reorder', movedTabId: movedId, toRank, intoGroupId })
  }, [dropTarget, finishDrag, flatOrder, groupOf])

  const switchTab = useCallback((tab: VerticalRailOverlayTab, event: { shiftKey: boolean }) => {
    // D-COLLAPSE: activating a member of a collapsed group auto-expands it first. (In the
    // flyout collapsed members are hidden, so this only fires for the rare header-active case.)
    const group = tab.groupId ? groupById.get(tab.groupId) : undefined
    if (group?.collapsed) send({ type: 'set-group-collapsed', groupId: group.id, collapsed: false })
    send({ type: 'switch', tabId: tab.id, shiftKey: event.shiftKey })
  }, [groupById])

  return (
    <div
      className="vertical-rail-overlay-root flex h-screen w-screen flex-col overflow-hidden"
      onMouseEnter={() => { pointerInsideRef.current = true; send({ type: 'hover-enter' }) }}
      onMouseLeave={() => { pointerInsideRef.current = false; if (!draggingIdRef.current) send({ type: 'hover-leave' }) }}
      style={{
        paddingTop: VERTICAL_RAIL_FLYOUT_PAD_Y,
        paddingBottom: VERTICAL_RAIL_FLYOUT_PAD_Y,
        background: VERTICAL_RAIL_FLYOUT_SURFACE_BACKGROUND,
        boxShadow: VERTICAL_RAIL_FLYOUT_SURFACE_SHADOW,
        backdropFilter: VERTICAL_RAIL_FLYOUT_SURFACE_BACKDROP,
        WebkitBackdropFilter: VERTICAL_RAIL_FLYOUT_SURFACE_BACKDROP,
        borderRadius: VERTICAL_RAIL_FLYOUT_RADIUS,
        border: VERTICAL_RAIL_FLYOUT_SURFACE_BORDER,
        boxSizing: 'border-box',
        backgroundClip: 'padding-box',
      }}
    >
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden"
        style={{ gap: VERTICAL_RAIL_FLYOUT_ROW_GAP }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) }}
      >
        {rows.map((row) => {
          if (row.kind === 'group-header') {
            const g = row.group
            return (
              <div key={`h-${g.id}`}>
                <div
                  className="relative flex flex-shrink-0 items-center gap-[7px] pr-[6px]"
                  style={{ height: 26, paddingLeft: 8, borderRadius: VERTICAL_RAIL_FLYOUT_ROW_RADIUS, background: tabGroupColorSoft(g.color, 10) }}
                >
                  <button
                    type="button"
                    onClick={() => send({ type: 'set-group-collapsed', groupId: g.id, collapsed: !g.collapsed })}
                    className="flex h-[16px] w-[16px] flex-shrink-0 items-center justify-center rounded"
                    title={g.collapsed ? '展开群组' : '折叠群组'}
                  >
                    {g.collapsed ? <ChevronRight style={{ width: 13, height: 13 }} className="text-[var(--text-gray)]" /> : <ChevronDown style={{ width: 13, height: 13 }} className="text-[var(--text-gray)]" />}
                  </button>
                  <span className="h-[9px] w-[9px] flex-shrink-0 rounded-full" style={{ background: tabGroupColorVar(g.color) }} />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold" style={{ color: 'var(--text-title)' }}>{g.name || '未命名群组'}</span>
                  <span className="flex-shrink-0 text-[10px]" style={{ color: 'var(--text-light)' }}>{row.memberIds.length}</span>
                  <button
                    type="button"
                    onClick={() => setEditingGroupId((prev) => (prev === g.id ? null : g.id))}
                    className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded opacity-70 transition-opacity hover:opacity-100"
                    title="群组选项"
                  >
                    <MoreHorizontal style={{ width: 14, height: 14 }} className="text-[var(--text-gray)]" />
                  </button>
                </div>
                {editingGroupId === g.id && (
                  <GroupInlineEditor
                    key={g.id}
                    group={g}
                    onRename={(name) => send({ type: 'rename-group', groupId: g.id, name })}
                    onRecolor={(color) => send({ type: 'recolor-group', groupId: g.id, color })}
                    onNewTab={() => { send({ type: 'new-tab-in-group', groupId: g.id }); setEditingGroupId(null) }}
                    onDisband={() => { send({ type: 'disband-group', groupId: g.id }); setEditingGroupId(null) }}
                    onDelete={() => { send({ type: 'delete-group', groupId: g.id }); setEditingGroupId(null) }}
                  />
                )}
              </div>
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
              className="group relative flex flex-shrink-0 cursor-pointer items-center pr-[8px]"
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
                background: isDropOnto
                  ? tabGroupColorSoft(group?.color ?? 'blue', 20)
                  : isActive
                    ? 'var(--files-panel-state-active-bg)'
                    : 'transparent',
                boxShadow: isActive ? 'var(--files-panel-state-active-shadow)' : 'none',
                borderRadius: VERTICAL_RAIL_FLYOUT_ROW_RADIUS,
              }}
            >
              {group && <span aria-hidden className="pointer-events-none absolute left-[9px] top-0 bottom-0 w-[2px]" style={{ background: tabGroupColorVar(group.color) }} />}
              {isDropBefore && <span aria-hidden className="pointer-events-none absolute left-[8px] right-[8px] top-0 h-[2px] rounded" style={{ background: 'var(--color-blue)' }} />}
              {isDropAfter && <span aria-hidden className="pointer-events-none absolute left-[8px] right-[8px] bottom-0 h-[2px] rounded" style={{ background: 'var(--color-blue)' }} />}
              {overlayTabIcon(tab, 15)}
              <span className="flex min-w-0 flex-1 flex-col justify-center">
                <span className="truncate text-[12px] font-medium" style={{ color: isActive ? 'var(--text-title)' : 'var(--text-body)', lineHeight: 1.3 }}>{tab.title || 'New Tab'}</span>
                {tab.domain && <span className="truncate text-[10px]" style={{ color: 'var(--text-light)', lineHeight: 1.25 }}>{tab.domain}</span>}
              </span>
              {group && (
                <span
                  role="button"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => { event.stopPropagation(); send({ type: 'remove-from-group', tabId: tab.id }) }}
                  className="flex h-[20px] flex-shrink-0 items-center rounded px-[5px] text-[10px] opacity-0 transition-opacity hover:bg-[var(--bg-hover)] group-hover:opacity-70"
                  title="移出群组"
                  style={{ color: 'var(--text-gray)' }}
                >
                  移出
                </span>
              )}
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
    </div>
  )
}

// Inline group editor rendered within the flyout list (the child window is fixed-size, so a
// floating popup cannot escape it). Rename commits on Enter / blur; recolor & actions fire
// immediately. Text input is native to this child window (IME verified on a real machine,
// per Doc B R-OVERLAY-INPUT).
function GroupInlineEditor({
  group,
  onRename,
  onRecolor,
  onNewTab,
  onDisband,
  onDelete,
}: {
  group: TabGroup
  onRename: (name: string) => void
  onRecolor: (color: TabGroupColor) => void
  onNewTab: () => void
  onDisband: () => void
  onDelete: () => void
}) {
  const [name, setName] = useState(group.name)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => { rootRef.current?.scrollIntoView({ block: 'nearest' }) }, [])
  // Commit a pending rename on UNMOUNT (⋯ toggle / action click / group-switch / vanish).
  // On macOS, clicking a <button> does not blur the input, so onBlur alone loses the edit
  // when an editor button unmounts the field first — the ref-based unmount-commit is the
  // reliable path (mirrors the P2 doc rail GroupEditPopup). Keyed by g.id in the parent, so
  // switching groups commits against the OLD group's original name, never the wrong group.
  const originalName = group.name
  const nameRef = useRef(name)
  nameRef.current = name
  const renameRef = useRef(onRename)
  renameRef.current = onRename
  useEffect(() => () => { if (nameRef.current !== originalName) renameRef.current(nameRef.current) }, [originalName])
  const commitName = () => { if (name !== group.name) onRename(name) }
  return (
    <div
      ref={rootRef}
      className="mt-[3px] flex flex-col gap-[7px] p-[8px]"
      style={{ borderRadius: VERTICAL_RAIL_FLYOUT_ROW_RADIUS, background: tabGroupColorSoft(group.color, 8), border: '0.5px solid color-mix(in srgb, var(--text-title) 8%, transparent)' }}
      onClick={(event) => event.stopPropagation()}
    >
      <input
        value={name}
        autoFocus
        placeholder="群组名称"
        onChange={(event) => setName(event.target.value)}
        onBlur={commitName}
        onKeyDown={(event) => { if (event.key === 'Enter') commitName() }}
        className="w-full rounded-[7px] px-[8px] py-[5px] text-[12px] outline-none"
        style={{ background: 'var(--bg-content)', border: '1px solid color-mix(in srgb, var(--text-title) 12%, transparent)', color: 'var(--text-title)' }}
      />
      <div className="flex flex-wrap gap-[6px]">
        {TAB_GROUP_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={color}
            onClick={() => onRecolor(color)}
            className="h-[18px] w-[18px] rounded-full transition-transform hover:scale-110"
            style={{ background: tabGroupColorVar(color), boxShadow: color === group.color ? '0 0 0 2px var(--bg-content), 0 0 0 3.5px var(--text-title)' : 'none' }}
          />
        ))}
      </div>
      <div className="flex flex-col text-[12px]" style={{ color: 'var(--text-body)' }}>
        <button type="button" onClick={onNewTab} className="flex items-center rounded-[6px] px-[8px] py-[5px] text-left transition-colors hover:bg-[var(--bg-hover)]">群组中新建标签</button>
        <button type="button" onClick={onDisband} className="flex items-center rounded-[6px] px-[8px] py-[5px] text-left transition-colors hover:bg-[var(--bg-hover)]">取消群组</button>
        <button type="button" onClick={onDelete} className="flex items-center rounded-[6px] px-[8px] py-[5px] text-left transition-colors hover:bg-[var(--bg-hover)]" style={{ color: 'var(--color-red)' }}>关闭群组标签</button>
      </div>
    </div>
  )
}
