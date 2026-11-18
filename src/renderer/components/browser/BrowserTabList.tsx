import { ReadyRefSchema, writeReadyRefTransfer } from '../../../shared/ready-ref'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { AtSign, FolderMinus, FolderPlus, Lock, Plus, X } from 'lucide-react'
import { beginBrowserTabDragSession, endBrowserTabDragSession } from '../../modules/browser/browserTabDragSession'
import { addReadyContextReferenceToAgentInput } from '../../modules/agent/chat-input-bridge'
import type { BrowserTab } from '../../stores/useBrowserTabs'
import type { TabGroup, TabGroupColor } from '../../../shared/tab-groups'
import { buildTabRailRows, resolveReorderDrop } from '../tabs/tab-rail-display-model'
import { resolveTabDropIntent, tabGroupColorSoft, tabGroupColorVar, type TabDropIntent } from '../tabs/tab-group-visuals'
import TabGroupHeaderRow from '../tabs/TabGroupHeaderRow'
import TabGroupEditMenu from '../tabs/TabGroupEditMenu'
import { IconButton } from '../ui/Button'
import type { MenuEntry } from '../ui/float/Menu'
import { openContextMenu } from '../ui/float/open-menu'
import BrowserTaskTabGroups, { type BrowserTaskTabGroup } from './BrowserTaskTabGroups'
import { browserTabHoverText } from '../../modules/browser/url-utils'
import { BrowserTabIcon } from './BrowserTabIcon'
import './browser-tab-list.css'

// The browser's navigator in the shell sidebar (W2-T3): tabs with titles, groups, drag to reorder,
// group or hand a tab to the assistant. It replaces the icon-only rail and its hover window — in the
// sidebar there is room for titles, so nothing has to float over the web page. A tab is one line, its
// icon and its title; the site it is on is in the row's hover text.

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
  /** The tab menu's 添加到新分组: a new group holding this tab; returns its id so the name can be typed at once. */
  onGroupTab: (tabId: string) => string | null
  onUngroupTab: (tabId: string) => void
  onRenameGroup: (groupId: string, name: string) => void
  onRecolorGroup: (groupId: string, color: TabGroupColor) => void
  onSetGroupCollapsed: (groupId: string, collapsed: boolean) => void
  onDisbandGroup: (groupId: string) => void
  onDeleteGroup: (groupId: string) => void
  onNewTabInGroup: (groupId: string) => void
  /** The assistant's work tabs, one group per task (W7 §4.10); they are listed there instead of among the person's. */
  taskGroups?: BrowserTaskTabGroup[]
  onCloseTaskTabs?: (browserTaskId: string) => void | Promise<void>
}

const NO_TASK_GROUPS: BrowserTaskTabGroup[] = []

type Row =
  | { kind: 'group-header'; group: TabGroup }
  | { kind: 'tab'; tab: BrowserTab; groupId: string | null; collapsed: boolean }

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
  onGroupTab,
  onUngroupTab,
  onRenameGroup,
  onRecolorGroup,
  onSetGroupCollapsed,
  onDisbandGroup,
  onDeleteGroup,
  onNewTabInGroup,
  taskGroups = NO_TASK_GROUPS,
  onCloseTaskTabs,
}: BrowserTabListProps) {
  const draggingIdRef = useRef<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; intent: TabDropIntent } | null>(null)
  const [editing, setEditing] = useState<{ id: string; top: number } | null>(null)
  // A group made from the tab menu opens its editor (name focused) once its header is in the list.
  const [namingGroupId, setNamingGroupId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const groupOf = useMemo(() => Object.fromEntries(tabs.map(tab => [tab.id, tab.groupId ?? null])), [tabs])
  const groupById = useMemo(() => new Map(tabGroups.map(group => [group.id, group])), [tabGroups])
  const taskTabIds = useMemo(() => new Set(taskGroups.flatMap(group => group.tabs.map(tab => tab.id))), [taskGroups])
  const { rows, flatOrder } = useMemo(() => {
    const byId = new Map(tabs.map(tab => [tab.id, tab]))
    // Ranks stay those of every tab (the store reorders the full list); the task tabs are only not shown here.
    const built = buildTabRailRows(tabs.map(tab => tab.id), groupOf, tabGroups, activeTabId, splitTabId)
    const out: Row[] = []
    for (const row of built.rows) {
      if (row.kind === 'group-header') {
        if (row.memberIds.every(id => taskTabIds.has(id))) continue
        out.push({ kind: 'group-header', group: row.group })
        continue
      }
      const tab = byId.get(row.id)
      if (!tab || taskTabIds.has(tab.id)) continue
      out.push({ kind: 'tab', tab, groupId: row.groupId, collapsed: row.groupId ? Boolean(groupById.get(row.groupId)?.collapsed) : false })
    }
    return { rows: out, flatOrder: built.flatOrder }
  }, [activeTabId, groupById, groupOf, splitTabId, tabGroups, tabs, taskTabIds])
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
    const ref = ReadyRefSchema.safeParse({ kind: 'web', url: tab.url })
    if (ref.success) writeReadyRefTransfer(event.dataTransfer, ref.data, tab.title || tab.url)
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

  // The person's groups, in the order their headers show (a group of only assistant work tabs has no header here).
  const menuGroups = useMemo(() => rows.flatMap(row => (row.kind === 'group-header' ? [row.group] : [])), [rows])

  const handleContextMenu = useCallback((event: MouseEvent, tab: BrowserTab) => {
    event.stopPropagation()
    const currentGroupId = tab.groupId ?? null
    const others = menuGroups.filter(group => group.id !== currentGroupId)
    const items: MenuEntry[] = []
    if (tab.url || tab.title) {
      items.push({
        id: 'reference-to-input',
        label: '引用到输入框',
        icon: <AtSign aria-hidden="true" />,
        onSelect: () => { void addReadyContextReferenceToAgentInput({ type: 'browser-tab', name: tab.title || 'New Tab', title: tab.title || 'New Tab', url: tab.url, tabId: tab.id }) },
      })
      items.push({ kind: 'separator' })
    }
    items.push({
      id: 'group-new',
      label: '添加到新分组',
      icon: <FolderPlus aria-hidden="true" />,
      onSelect: () => { const groupId = onGroupTab(tab.id); if (groupId) setNamingGroupId(groupId) },
    })
    if (others.length) {
      items.push({ kind: 'group', label: '添加到分组' })
      for (const group of others) {
        items.push({
          id: `group-add-${group.id}`,
          label: group.name || '未命名分组',
          icon: <span className="browser-tab-list__group-dot" style={{ background: tabGroupColorVar(group.color) }} aria-hidden="true" />,
          onSelect: () => onAddToGroup(tab.id, group.id),
        })
      }
    }
    if (currentGroupId) {
      if (others.length) items.push({ kind: 'separator' })
      items.push({ id: 'group-leave', label: '移出分组', icon: <FolderMinus aria-hidden="true" />, onSelect: () => onUngroupTab(tab.id) })
    }
    items.push({ kind: 'separator' })
    items.push({ id: 'close-tab', label: '关闭标签页', icon: <X aria-hidden="true" />, onSelect: () => { void onTabClose(tab.id) } })
    setEditing(null)
    openContextMenu(event, items, '标签页')
  }, [menuGroups, onAddToGroup, onGroupTab, onTabClose, onUngroupTab])

  const openEditor = useCallback((group: TabGroup, anchor: DOMRect) => {
    const listTop = listRef.current?.getBoundingClientRect().top ?? 0
    const scrollTop = listRef.current?.scrollTop ?? 0
    setEditing(prev => (prev?.id === group.id ? null : { id: group.id, top: Math.round(anchor.bottom - listTop + scrollTop) + 4 }))
  }, [])

  // 添加到新分组 → the new group's editor opens under its header, the name field focused.
  useEffect(() => {
    if (!namingGroupId) return
    const group = groupById.get(namingGroupId)
    const header = listRef.current?.querySelector<HTMLElement>(`[data-tab-group-header="${namingGroupId}"]`)
    if (!group || !header) return
    setNamingGroupId(null)
    const listTop = listRef.current?.getBoundingClientRect().top ?? 0
    const scrollTop = listRef.current?.scrollTop ?? 0
    setEditing({ id: group.id, top: Math.round(header.getBoundingClientRect().bottom - listTop + scrollTop) + 4 })
  }, [groupById, namingGroupId])

  const editingGroup = editing ? groupById.get(editing.id) : undefined

  return (
    <div className="browser-tab-list" data-browser-tab-list="">
      <div className="shell-navigator__head">
        <span className="shell-navigator__title">标签页</span>
        <IconButton icon={<Plus aria-hidden="true" />} title="新标签页 ⌘T" aria-label="新标签页" onClick={() => void onNewTab()} />
      </div>
      <div
        ref={listRef}
        className="browser-tab-list__scroll"
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null) }}
      >
        <div className="browser-tab-list__rows" role="list" aria-label="打开的标签页">
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
          return (
            <div
              key={tab.id}
              role="listitem"
              className="browser-tab-list__row"
              data-browser-tab={tab.id}
              data-current={current || undefined}
              data-grouped={group ? 'true' : undefined}
              data-drop={drop ?? undefined}
              style={drop === 'onto' ? { background: tabGroupColorSoft(group?.color ?? 'blue', 20) } : undefined}
              draggable
              title={browserTabHoverText(tab)}
              onDragStart={event => beginDrag(event, tab)}
              onDragEnd={finishDrag}
              onDragOver={event => handleRowDragOver(event, tab.id)}
              onDrop={event => handleRowDrop(event, tab.id)}
              onClick={event => activate(tab, row.groupId, event.shiftKey)}
              onAuxClick={event => { if (event.button === 1) { event.preventDefault(); void onTabClose(tab.id) } }}
              onContextMenu={event => handleContextMenu(event, tab)}
            >
              {group && <span className="browser-tab-list__group-rail" style={{ background: tabGroupColorSoft(group.color, 45) }} aria-hidden="true" />}
              <span className="browser-tab-list__glyph">
                <BrowserTabIcon tab={tab} />
                {tab.owner === 'agent' && <span className="browser-tab-list__badge" data-kind="agent" aria-label="助手在用" />}
                {tab.activity && tab.activity !== 'idle' && <span className="browser-tab-list__badge" data-kind={tab.activity} aria-label={tab.activity === 'attention' ? '需要你处理' : '助手正在操作'} />}
              </span>
              <span className="browser-tab-list__label">{tab.title || 'New Tab'}</span>
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
        </div>
        <button type="button" className="browser-tab-list__row browser-tab-list__new" onClick={() => void onNewTab()}>
          <span className="browser-tab-list__glyph"><Plus className="browser-tab-list__icon" strokeWidth={1.8} aria-hidden="true" /></span>
          <span className="browser-tab-list__label">新标签页</span>
        </button>
        <BrowserTaskTabGroups
          groups={taskGroups}
          activeTabId={activeTabId}
          splitTabId={splitTabId}
          onTabClick={onTabClick}
          onTabClose={onTabClose}
          onCloseAll={browserTaskId => onCloseTaskTabs?.(browserTaskId)}
        />
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
