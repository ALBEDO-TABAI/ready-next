import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { Globe, Loader2, Lock, Plus, X } from 'lucide-react'
import { beginBrowserTabDragSession, endBrowserTabDragSession } from '../../modules/browser/browserTabDragSession'
import { addReadyContextReferenceToAgentInput, showBrowserTabContextMenu } from '../../modules/agent/chat-input-bridge'
import { extractBrowserDomain } from '../../modules/browser/url-utils'
import type { BrowserTab } from '../../stores/useBrowserTabs'
import type { TabGroup, TabGroupColor } from '../../../shared/tab-groups'
import { buildTabRailRows, resolveReorderDrop } from '../tabs/tab-rail-display-model'
import { resolveTabDropIntent, tabGroupColorSoft, type TabDropIntent } from '../tabs/tab-group-visuals'
import TabGroupHeaderRow from '../tabs/TabGroupHeaderRow'
import TabGroupEditMenu from '../tabs/TabGroupEditMenu'
import { ShellSidebarToggle } from '../../modules/workbench/shell/ShellSidebar'
import './browser-tab-list.css'

// The browser's navigator in the shell sidebar (W2-T3): tabs with titles, groups, drag to reorder,
// group or hand a tab to the assistant. It replaces the icon-only rail and its hover window — in the
// sidebar there is room for titles, so nothing has to float over the web page.

export interface BrowserTabListProps {
  tabs: BrowserTab[]
  tabGroups: TabGroup[]
  activeTabId: string | null
  splitTabId: string | null
  onTabClick: (id: string, event: { shiftKey: boolean }) => void | Promise<void>
  onTabClose: (id: string) => void | Promise<void>
  onNewTab: () => void | Promise<void>
  /** id-based reorder: toRank is a flat rank; intoGroupId (re)assigns the group. */
  onReorderToRank: (movedId: string, toRank: number, intoGroupId: string | null) => void
  onCreateGroup: (draggedId: string, targetId: string) => void
  onAddToGroup: (tabId: string, groupId: string) => void
  onRenameGroup: (groupId: string, name: string) => void
  onRecolorGroup: (groupId: string, color: TabGroupColor) => void
  onSetGroupCollapsed: (groupId: string, collapsed: boolean) => void
  onDisbandGroup: (groupId: string) => void
  onDeleteGroup: (groupId: string) => void
  onNewTabInGroup: (groupId: string) => void
}

type Row =
  | { kind: 'group-header'; group: TabGroup }
  | { kind: 'tab'; tab: BrowserTab; groupId: string | null; collapsed: boolean }

function tabIcon(tab: BrowserTab) {
  if (tab.loading) return <Loader2 className="browser-tab-list__icon animate-spin" strokeWidth={2} aria-hidden="true" />
  if (tab.favicon) return <img className="browser-tab-list__icon browser-tab-list__favicon" src={tab.favicon} alt="" draggable={false} />
  return <Globe className="browser-tab-list__icon" strokeWidth={1.8} aria-hidden="true" />
}

export default function BrowserTabList({
  tabs,
  tabGroups,
  activeTabId,
  splitTabId,
  onTabClick,
  onTabClose,
  onNewTab,
  onReorderToRank,
  onCreateGroup,
  onAddToGroup,
  onRenameGroup,
  onRecolorGroup,
  onSetGroupCollapsed,
  onDisbandGroup,
  onDeleteGroup,
  onNewTabInGroup,
}: BrowserTabListProps) {
  const draggingIdRef = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; intent: TabDropIntent } | null>(null)
  const [editing, setEditing] = useState<{ id: string; top: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const groupOf = useMemo(() => Object.fromEntries(tabs.map(tab => [tab.id, tab.groupId ?? null])), [tabs])
  const groupById = useMemo(() => new Map(tabGroups.map(group => [group.id, group])), [tabGroups])
  const { rows, flatOrder } = useMemo(() => {
    const byId = new Map(tabs.map(tab => [tab.id, tab]))
    const built = buildTabRailRows(tabs.map(tab => tab.id), groupOf, tabGroups, activeTabId, splitTabId)
    const out: Row[] = []
    for (const row of built.rows) {
      if (row.kind === 'group-header') { out.push({ kind: 'group-header', group: row.group }); continue }
      const tab = byId.get(row.id)
      if (!tab) continue
      out.push({ kind: 'tab', tab, groupId: row.groupId, collapsed: row.groupId ? Boolean(groupById.get(row.groupId)?.collapsed) : false })
    }
    return { rows: out, flatOrder: built.flatOrder }
  }, [activeTabId, groupById, groupOf, splitTabId, tabGroups, tabs])
  // Drops resolve against the visual order (the split tab is hoisted next to the active one).
  const visualTabIds = useMemo(() => rows.flatMap(row => (row.kind === 'tab' ? [row.tab.id] : [])), [rows])

  const finishDrag = useCallback(() => {
    draggingIdRef.current = null
    setDropTarget(null)
    endBrowserTabDragSession()
  }, [])

  // A drag can end anywhere (Escape, a drop on the assistant): clear the highlight either way.
  useEffect(() => {
    window.addEventListener('dragend', finishDrag)
    window.addEventListener('drop', finishDrag)
    return () => { window.removeEventListener('dragend', finishDrag); window.removeEventListener('drop', finishDrag) }
  }, [finishDrag])

  // The edit menu closes when its group disappears (deleted or disbanded elsewhere).
  useEffect(() => { if (editing && !groupById.has(editing.id)) setEditing(null) }, [editing, groupById])

  const beginDrag = useCallback((event: DragEvent, tab: BrowserTab) => {
    draggingIdRef.current = tab.id
    event.dataTransfer.effectAllowed = 'copyMove'
    // The same payload the assistant and the document accept from a tab (a browser-tab resource).
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
  }, [])

  const handleRowDragOver = useCallback((event: DragEvent, targetId: string) => {
    if (!draggingIdRef.current || draggingIdRef.current === targetId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const rect = event.currentTarget.getBoundingClientRect()
    const intent = resolveTabDropIntent(event.clientY - rect.top, rect.height)
    setDropTarget(prev => (prev && prev.id === targetId && prev.intent === intent ? prev : { id: targetId, intent }))
  }, [])

  const handleRowDrop = useCallback((event: DragEvent, targetId: string) => {
    event.preventDefault()
    const movedId = draggingIdRef.current
    const target = dropTarget
    finishDrag()
    if (!movedId || movedId === targetId || !target || target.id !== targetId) return
    const targetGroupId = groupOf[targetId] ?? null
    if (target.intent === 'onto') {
      if (targetGroupId) onAddToGroup(movedId, targetGroupId)
      else onCreateGroup(movedId, targetId)
      return
    }
    const { toRank, intoGroupId } = resolveReorderDrop(visualTabIds, flatOrder, groupOf, movedId, targetId, target.intent, splitTabId)
    onReorderToRank(movedId, toRank, intoGroupId)
  }, [dropTarget, finishDrag, flatOrder, groupOf, onAddToGroup, onCreateGroup, onReorderToRank, splitTabId, visualTabIds])

  // Dropping onto a group header adds the dragged tab to that group.
  const handleHeaderDragOver = useCallback((event: DragEvent, groupId: string) => {
    const movedId = draggingIdRef.current
    if (!movedId || (groupOf[movedId] ?? null) === groupId) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDropTarget(prev => (prev && prev.id === groupId ? prev : { id: groupId, intent: 'onto' }))
  }, [groupOf])

  const handleHeaderDrop = useCallback((event: DragEvent, groupId: string) => {
    event.preventDefault()
    const movedId = draggingIdRef.current
    finishDrag()
    if (!movedId || (groupOf[movedId] ?? null) === groupId) return
    onAddToGroup(movedId, groupId)
  }, [finishDrag, groupOf, onAddToGroup])

  const activate = useCallback((tab: BrowserTab, groupId: string | null, shiftKey: boolean) => {
    // Activating a tab inside a collapsed group opens the group first.
    const group = groupId ? groupById.get(groupId) : undefined
    if (group?.collapsed) onSetGroupCollapsed(group.id, false)
    void onTabClick(tab.id, { shiftKey })
  }, [groupById, onSetGroupCollapsed, onTabClick])

  const handleContextMenu = useCallback((event: MouseEvent, tab: BrowserTab) => {
    event.preventDefault()
    event.stopPropagation()
    void showBrowserTabContextMenu({ x: event.clientX, y: event.clientY }, { canReference: Boolean(tab.url || tab.title) }).then(action => {
      if (action === 'close-tab') { void onTabClose(tab.id); return }
      if (action === 'reference-to-input') {
        void addReadyContextReferenceToAgentInput({ type: 'browser-tab', name: tab.title || 'New Tab', title: tab.title || 'New Tab', url: tab.url, tabId: tab.id })
      }
    })
  }, [onTabClose])

  const openEditor = useCallback((group: TabGroup, anchor: DOMRect) => {
    const listTop = listRef.current?.getBoundingClientRect().top ?? 0
    const scrollTop = listRef.current?.scrollTop ?? 0
    setEditing(prev => (prev?.id === group.id ? null : { id: group.id, top: Math.round(anchor.bottom - listTop + scrollTop) + 4 }))
  }, [])

  const editingGroup = editing ? groupById.get(editing.id) : undefined

  return (
    <div className="browser-tab-list" data-browser-tab-list="">
      <div className="browser-tab-list__head">
        <span className="browser-tab-list__title">标签页</span>
        <span className="browser-tab-list__head-tools">
          <button type="button" className="browser-tab-list__head-button" title="新标签页 ⌘T" aria-label="新标签页" onClick={() => void onNewTab()}>
            <Plus strokeWidth={1.8} aria-hidden="true" />
          </button>
          <ShellSidebarToggle />
        </span>
      </div>
      <div
        ref={listRef}
        className="browser-tab-list__scroll"
        role="list"
        aria-label="打开的标签页"
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) }}
      >
        {rows.map(row => {
          if (row.kind === 'group-header') {
            const group = row.group
            return (
              <TabGroupHeaderRow
                key={`h-${group.id}`}
                group={group}
                isDropTarget={dropTarget?.id === group.id && dropTarget.intent === 'onto'}
                onToggleCollapsed={() => onSetGroupCollapsed(group.id, !group.collapsed)}
                onNewTabInGroup={() => { setEditing(null); onNewTabInGroup(group.id) }}
                onEdit={anchor => openEditor(group, anchor)}
                onDragOver={event => handleHeaderDragOver(event, group.id)}
                onDrop={event => handleHeaderDrop(event, group.id)}
              />
            )
          }
          if (row.collapsed) return null
          const { tab } = row
          const isSplit = tab.id === splitTabId && tab.id !== activeTabId
          const current = tab.id === activeTabId || isSplit
          const group = row.groupId ? groupById.get(row.groupId) : undefined
          const drop = dropTarget?.id === tab.id ? dropTarget.intent : null
          const domain = tab.domain || extractBrowserDomain(tab.url || '')
          return (
            <div
              key={tab.id}
              role="listitem"
              className="browser-tab-list__row"
              data-current={current || undefined}
              data-grouped={group ? 'true' : undefined}
              data-drop={drop ?? undefined}
              style={drop === 'onto' ? { background: tabGroupColorSoft(group?.color ?? 'blue', 20) } : undefined}
              draggable
              title={tab.title || 'New Tab'}
              onDragStart={event => beginDrag(event, tab)}
              onDragEnd={finishDrag}
              onDragOver={event => handleRowDragOver(event, tab.id)}
              onDrop={event => handleRowDrop(event, tab.id)}
              onClick={event => activate(tab, row.groupId, event.shiftKey)}
              onAuxClick={event => { if (event.button === 1) { event.preventDefault(); void onTabClose(tab.id) } }}
              onContextMenu={event => handleContextMenu(event, tab)}
            >
              <span className="browser-tab-list__glyph">
                {tabIcon(tab)}
                {tab.owner === 'agent' && <span className="browser-tab-list__badge" data-kind="agent" aria-label="助手在用" />}
                {tab.activity && tab.activity !== 'idle' && <span className="browser-tab-list__badge" data-kind={tab.activity} aria-label={tab.activity === 'attention' ? '需要你处理' : '助手正在操作'} />}
              </span>
              <span className="browser-tab-list__text">
                <span className="browser-tab-list__label">{tab.title || 'New Tab'}</span>
                {domain && <span className="browser-tab-list__meta">{domain}</span>}
              </span>
              {tab.required && <Lock className="browser-tab-list__lock" strokeWidth={2} aria-label="任务需要这个标签" />}
              <button
                type="button"
                className="browser-tab-list__close"
                title="关闭标签页"
                aria-label={`关闭 ${tab.title || '标签页'}`}
                onMouseDown={event => event.stopPropagation()}
                onClick={event => { event.stopPropagation(); void onTabClose(tab.id) }}
              >
                <X strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          )
        })}
        <button type="button" className="browser-tab-list__row browser-tab-list__new" onClick={() => void onNewTab()}>
          <span className="browser-tab-list__glyph"><Plus className="browser-tab-list__icon" strokeWidth={1.8} aria-hidden="true" /></span>
          <span className="browser-tab-list__label">新标签页</span>
        </button>
        {editing && editingGroup && (
          <div className="browser-tab-list__editor rn-float" style={{ top: editing.top }}>
            <TabGroupEditMenu
              // Keyed by group: switching groups remounts, so the old draft commits against the old group.
              key={editing.id}
              group={editingGroup}
              onRename={name => onRenameGroup(editing.id, name)}
              onRecolor={color => onRecolorGroup(editing.id, color)}
              onNewTab={() => { onNewTabInGroup(editing.id); setEditing(null) }}
              onDisband={() => { onDisbandGroup(editing.id); setEditing(null) }}
              onDelete={() => { onDeleteGroup(editing.id); setEditing(null) }}
              onRequestClose={() => setEditing(null)}
            />
          </div>
        )}
      </div>
    </div>
  )
}
