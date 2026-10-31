import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { DocumentPagesAPI, PageNode, PageOperation, PageResult, PageRoot, PageTrashEntry } from '../../../../shared/document-pages'
import { toReadyUri } from '../../../../shared/ready-ref'
import { useDocTabs } from '../../../stores/useDocTabs'
import { useVault } from '../../../stores/useVault'
import { useWorkspace } from '../../../stores/useWorkspace'
import { requestWorkbenchModeOpen } from '../../workbench/mode-transition'
import { ImportWizard } from '../import/ImportWizard'
import { TemplatePicker } from '../templates/TemplatePicker'
import { saveBeforePageTrash } from '../page-ui/page-panel-state'
import { createPageTreeStore, errorMessage, flattenPages } from '../page-ui/page-state'
import { SaveToPicker, type SaveToSelection } from '../page-ui/SaveToPicker'
import { CalendarBadge, Icon, type IconName } from './icons'
import { InkPageIcon } from './InkPageIcon'
import { eventTimeLabel, openInCurrentTab, useInkLayout, useUpcomingEvents } from './layout-state'
import { openMenu } from './menu'
import { openPopover, tip } from './overlay'

// Inkwell's sidebar inside Ready's document card. Pages come from Ready's page service; everything else that
// Inkwell showed (workspace switcher, team spaces, promotions) has no counterpart in Ready and is left out.
export interface InkSidebarProps {
  roots: PageRoot[]
  visible: boolean
  api?: DocumentPagesAPI
  /** Opens in the current tab, or a new one for ⌘/Ctrl-click. */
  onOpen?(node: PageNode, newTab?: boolean): void | Promise<void>
  onShowFiles?(node: PageNode): void | Promise<void>
  /** The hover-peek copy shown over the page while the sidebar is collapsed. */
  floating?: boolean
}

const EXPANDED_KEY = 'ready-ink-expanded'
const readExpanded = () => { try { return new Set<string>(JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]')) } catch { return new Set<string>() } }
const checked = <T,>(result: PageResult<T>): T => { if (!result.ok) throw new Error(result.message); return result.value }
const canHoldPages = (node: PageNode) => ['page', 'folder', 'vault'].includes(node.kind) && !node.ambiguity

function openNode(node: PageNode, newTab = false) {
  openInCurrentTab(node.path, { newTab })
  useWorkspace.getState().selectFile(node.path)
  requestWorkbenchModeOpen('document')
}

export function InkSidebar({ roots, visible, api = window.electronAPI.documentPages, onOpen = openNode, onShowFiles, floating = false }: InkSidebarProps) {
  const store = useMemo(() => createPageTreeStore(api), [api])
  const { trees, states, loading, error: loadError } = useStore(store)
  const width = useInkLayout(state => state.width)
  const home = useInkLayout(state => state.home)
  const activeObjectId = useDocTabs(state => state.tabs.find(tab => tab.id === (state.focusedPaneTabId || state.activeTabId))?.objectId)
  const libraryActive = useDocTabs(state => state.tabs.find(tab => tab.id === state.activeTabId)?.kind === 'library')
  const rootsKey = JSON.stringify(roots)
  const rootsRef = useRef(roots); rootsRef.current = roots
  const [expanded, setExpandedState] = useState(readExpanded)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const dragged = useRef<{ node: PageNode; parent: PageNode; root: string } | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const upcoming = useUpcomingEvents(visible)
  const refresh = () => store.getState().load(rootsRef.current)

  useEffect(() => {
    void store.getState().load(rootsRef.current)
    let timer: ReturnType<typeof setTimeout> | undefined
    let treeChanged = false
    const unsubscribe = api.onChanged(event => {
      treeChanged ||= !('operationId' in event) || !['visit', 'favorite'].includes(event.operationId)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (treeChanged) { treeChanged = false; void store.getState().load(rootsRef.current) }
        else void store.getState().loadStates().catch(failure => setError(errorMessage(failure)))
      }, 80)
    })
    return () => { unsubscribe(); clearTimeout(timer); store.getState().invalidate() }
  }, [api, store, rootsKey])

  const setExpanded = (id: string, value: boolean) => setExpandedState(previous => {
    const next = new Set(previous)
    if (value) next.add(id); else next.delete(id)
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next])) } catch { /* the tree still works without memory */ }
    return next
  })
  const run = async (action: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(null)
    try { await action() } catch (failure) { setError(errorMessage(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  const operate = async (input: PageOperation) => {
    const result = await api.operate(input)
    if (result.ok) await refresh()
    return result
  }
  const all = flattenPages(trees)
  const rootOf = (node: PageNode) => trees.find(tree => tree.objectId === node.objectId || flattenPages(tree.children).some(item => item.objectId === node.objectId))
  const isFavorite = (node: PageNode) => states.some(state => state.objectId === node.objectId && state.favorite)
  const open = (node: PageNode, newTab = false) => run(async () => { await onOpen(node, newTab); if (node.kind !== 'vault') checked(await api.visit(node.objectId)); await store.getState().loadStates() })
  const toggleFavorite = (node: PageNode) => run(async () => { checked(await api.favorite(node.objectId, !isFavorite(node))); await store.getState().loadStates() })

  /** Notion's flow: a new page appears at once as "未命名" and opens; its title is edited in the page itself. */
  const createIn = (parent: PageNode, root: string) => run(async () => {
    const taken = new Set(parent.children.map(child => child.title))
    let title = '未命名'
    for (let n = 2; taken.has(title); n++) title = `未命名 ${n}`
    const target = parent.kind === 'vault' ? { parentPath: parent.path } : { parentObjectId: parent.objectId }
    const receipt = checked(await operate({ type: 'create', root, operationId: crypto.randomUUID(), title, ...target }))
    if (parent.kind !== 'vault') setExpanded(parent.objectId, true)
    useInkLayout.getState().setTitleFocus(receipt.objectId)
    if (receipt.path) await onOpen({ objectId: receipt.objectId, revision: receipt.revision, path: receipt.path, name: `${title}.md`, kind: 'page', title, children: [], hasChildren: false, position: 0 })
  })
  const trash = (node: PageNode) => run(async () => {
    const root = rootOf(node); if (!root) throw new Error('找不到页面所在的资料库')
    await saveBeforePageTrash(node)
    checked(await operate({ type: 'trash', objectId: node.objectId, root: root.path, operationId: crypto.randomUUID() }))
  })
  const drop = (target: PageNode, parent: PageNode, root: string, before: boolean) => run(async () => {
    const source = dragged.current; dragged.current = null; setDropTarget(null)
    if (!source || source.node.objectId === target.objectId) return
    if (source.root !== root) throw new Error('页面只能在同一个资料库内移动。')
    if (before) {
      if (source.parent.objectId !== parent.objectId) throw new Error('排序只支持同级页面；移入另一页请拖到页面标题上。')
      const ids = parent.children.filter(node => node.objectId !== source.node.objectId).map(node => node.objectId)
      ids.splice(ids.indexOf(target.objectId), 0, source.node.objectId)
      checked(await api.order(parent.objectId, ids)); await refresh()
    } else {
      if (!canHoldPages(target)) throw new Error('此项目不能接收子页面。')
      if (flattenPages([source.node]).some(node => node.objectId === target.objectId)) throw new Error('不能移入自己的子页面。')
      checked(await operate({ type: 'move', root, operationId: crypto.randomUUID(), objectId: source.node.objectId, parentObjectId: target.objectId }))
      setExpanded(target.objectId, true)
    }
  })

  const openRename = (anchor: HTMLElement, node: PageNode) => {
    const root = rootOf(node); if (!root) return
    openPopover({ id: 'ink-rename', anchor: anchor.getBoundingClientRect(), placement: 'bottom-start', offset: 4, label: '改名',
      render: close => <RenamePanel node={node} onCancel={close} onConfirm={async (title, operationId) => {
        const result = await operate({ type: 'rename', root: root.path, objectId: node.objectId, title, operationId })
        if (result.ok) close()
        return result
      }} /> })
  }
  const openLocation = (kind: 'move' | 'restore', root: string, subject: { objectId: string; title: string; parentPath?: string }) => {
    // The picker is itself the labelled dialog; the frame stays unnamed so there is one dialog, not two.
    openPopover({ id: 'ink-location', anchor: { left: 0, top: 0, right: 0, bottom: 0 }, placement: 'center', modal: true,
      render: close => <div className="ink-menu" style={{ width: 440, padding: 8 }}>
        <SaveToPicker trees={trees.filter(tree => tree.path === root)} mode={kind} initialTitle={subject.title}
          excludeObjectId={kind === 'move' ? subject.objectId : undefined}
          onCancel={close}
          onConfirm={async (selection: SaveToSelection) => {
            const target = selection.parentObjectId ? { parentObjectId: selection.parentObjectId } : { parentPath: selection.parentPath }
            const result = await operate({ type: kind, root, operationId: selection.operationId, objectId: subject.objectId, ...target })
            if (result.ok) close()
            return result
          }} />
      </div> })
  }
  const openRowMenu = (anchor: HTMLElement, node: PageNode, point?: { x: number; y: number }) => {
    const root = rootOf(node)
    const page = node.kind === 'page' && !node.ambiguity
    openMenu(point ? { left: point.x, right: point.x, top: point.y, bottom: point.y } : anchor.getBoundingClientRect(), { width: 240, label: `${node.title} 操作`, groups: [
      [
        { id: 'favorite', label: isFavorite(node) ? '取消收藏' : '收藏', icon: 'star', onSelect: () => { void toggleFavorite(node) } },
        { id: 'link', label: '复制链接', icon: 'link', disabled: node.kind !== 'page', onSelect: () => { void navigator.clipboard?.writeText(toReadyUri({ kind: 'page', id: node.objectId })) } },
      ],
      [
        { id: 'child', label: '新建子页面', icon: 'newPage', disabled: !page || !root, onSelect: () => { if (root) void createIn(node, root.path) } },
        { id: 'rename', label: '改名', icon: 'rename', disabled: !page, onSelect: () => openRename(anchor, node) },
        { id: 'move', label: '移动到…', icon: 'move', disabled: !page || !root, onSelect: () => { if (root) openLocation('move', root.path, { objectId: node.objectId, title: node.name.replace(/\.md$/i, '') }) } },
        ...(onShowFiles ? [{ id: 'files', label: '在文件中显示', icon: 'folderOpen' as IconName, onSelect: () => { void run(async () => { await onShowFiles(node) }) } }] : []),
      ],
      [{ id: 'trash', label: '移到回收站', icon: 'trash', danger: true, disabled: !page || !root, onSelect: () => { void trash(node) } }],
    ], footer: node.ambiguity ? node.ambiguity : undefined }, { anchorEl: anchor, placement: point ? 'bottom-start' : 'bottom-start' })
  }
  const openTrash = (anchor: HTMLElement) => {
    openPopover({ id: 'ink-trash', anchor: anchor.getBoundingClientRect(), placement: 'right-start', offset: 8, label: '回收站',
      render: close => <TrashPanel api={api} roots={rootsRef.current} onChanged={refresh}
        onRestoreElsewhere={(item, root) => { close(); openLocation('restore', root, { objectId: item.objectId, title: item.originalPath.split(/[\\/]/).pop()!.replace(/\.md$/i, '') }) }} /> })
  }
  const openTemplates = () => {
    const path = useDocTabs.getState().tabs.find(tab => tab.id === useDocTabs.getState().activeTabId)?.path ?? null
    openPopover({ id: 'ink-templates', anchor: { left: 0, top: 0, right: 0, bottom: 0 }, placement: 'center', modal: true, label: '模板',
      render: close => <div className="ink-menu ink-panel ink-template-panel" style={{ width: 460 }}><TemplatePicker path={path && /\.md$/i.test(path) ? path : null} title="新页面" insert={null} close={close} /></div> })
  }
  const openImport = () => {
    openPopover({ id: 'ink-import', anchor: { left: 0, top: 0, right: 0, bottom: 0 }, placement: 'center', modal: true, label: '导入',
      render: close => <div className="ink-menu" style={{ width: 560, padding: 12 }}><ImportWizard onClose={() => { close(); void refresh() }} /></div> })
  }

  const renderChildren = (parent: PageNode, root: string, level: number): ReactNode => {
    if (!parent.children.length) return <div className="ink-sb-empty" style={{ paddingLeft: 8 + level * 8 + 30 }}>暂无页面</div>
    return <div role="group">{parent.children.map(node => renderRow(node, parent, root, level))}</div>
  }
  /** One tree row; favorites reuse it with a key prefix and without drag ordering. */
  const renderRow = (node: PageNode, parent: PageNode | null, root: string, level: number, keyPrefix = ''): ReactNode => {
    const id = keyPrefix + node.objectId
    const isOpen = expanded.has(id)
    const selected = !home && activeObjectId === node.objectId
    const expandable = canHoldPages(node)
    const sortable = !!parent && !keyPrefix
    const toggle = () => setExpanded(id, !isOpen)
    const activate = (event?: ReactMouseEvent) => { if (node.kind === 'folder' || node.kind === 'vault') toggle(); else void open(node, !!event && (event.metaKey || event.ctrlKey)) }
    return <div key={id} role="treeitem" aria-label={node.title} aria-expanded={expandable ? isOpen : undefined} aria-selected={selected} data-page-id={node.objectId}>
      {sortable && <div aria-label={`排在 ${node.title} 之前`} className={`ink-sb-drop-gap${dropTarget === `before:${id}` ? ' is-active' : ''}`}
        onDragOver={event => { if (dragged.current) { event.preventDefault(); setDropTarget(`before:${id}`) } }}
        onDragLeave={() => setDropTarget(current => current === `before:${id}` ? null : current)}
        onDrop={event => { event.preventDefault(); event.stopPropagation(); void drop(node, parent!, root, true) }} />}
      <div className={`ink-sb-row ink-sb-tree${selected ? ' is-selected' : ''}${dropTarget === `into:${id}` ? ' is-drop-into' : ''}`}
        draggable={sortable && !busy && node.kind === 'page' && !node.ambiguity}
        onDragStart={(event: DragEvent) => { event.stopPropagation(); dragged.current = { node, parent: parent!, root }; event.dataTransfer.setData('text/plain', node.objectId); event.dataTransfer.effectAllowed = 'move' }}
        onDragEnd={() => { dragged.current = null; setDropTarget(null) }}
        onDragOver={event => { if (dragged.current && sortable && expandable) { event.preventDefault(); setDropTarget(`into:${id}`) } }}
        onDragLeave={() => setDropTarget(current => current === `into:${id}` ? null : current)}
        onDrop={event => { event.preventDefault(); event.stopPropagation(); if (parent) void drop(node, parent, root, false) }}
        onClick={event => activate(event)}
        onContextMenu={event => { event.preventDefault(); openRowMenu(event.currentTarget, node, { x: event.clientX, y: event.clientY }) }}>
        <span className="ink-sb-indent" style={{ width: level * 8 }} />
        <span className="ink-sb-icon">
          <span className="ink-sb-icon-glyph"><InkPageIcon value={node.icon} kind={node.kind} size={20} emojiSize={15} /></span>
          {expandable && <button type="button" className="ink-sb-disclosure" aria-label={`${isOpen ? '收起' : '展开'} ${node.title}`}
            onClick={event => { event.stopPropagation(); toggle() }}>
            <svg width="12" height="12" viewBox="0 0 12 12" style={{ transform: isOpen ? 'rotate(90deg)' : 'none' }} aria-hidden><path d="M4.4 2.6L7.8 6l-3.4 3.4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>}
        </span>
        <button type="button" className="ink-sb-label ink-sb-label-btn" title={node.path} onClick={event => { event.stopPropagation(); activate(event) }}>{node.title}</button>
        <span className="ink-sb-row-actions">
          {node.kind === 'page' && !node.ambiguity && <button type="button" className="ink-sb-action" aria-label={`在 ${node.title} 中新建页面`} {...tip('在其中添加页面')}
            onClick={event => { event.stopPropagation(); void createIn(node, root) }}><Icon name="plus" size={16} stroke={1.8} /></button>}
          <button type="button" className="ink-sb-action" aria-label={`${node.title} 操作`} {...tip('删除、复制等')}
            onClick={event => { event.stopPropagation(); openRowMenu(event.currentTarget.closest('.ink-sb-row') as HTMLElement, node) }}><Icon name="more" size={16} stroke={2} /></button>
        </span>
      </div>
      {node.ambiguity && <div role="note" className="ink-sb-note" style={{ paddingLeft: 8 + (level + 1) * 8 + 22 }}>{node.ambiguity}
        {onShowFiles && <> <button type="button" onClick={() => void run(async () => { await onShowFiles(node) })}>在文件中查看</button></>}</div>}
      {isOpen && expandable && renderChildren(node, root, level + 1)}
    </div>
  }

  const favorites = states.filter(state => state.favorite).map(state => all.find(node => node.objectId === state.objectId)).filter((node): node is PageNode => !!node)
  const vaultTitle = useVaultTitle(trees)
  return <nav className={`ink-sidebar${floating ? ' is-floating' : ''}`} style={{ width }} aria-label={floating ? '文档侧栏（悬停）' : '文档侧栏'}>
    <div className="ink-sb-inner">
      <div className="ink-sb-top">
        <span className="ink-sb-top-title">{vaultTitle}</span>
        {floating
          ? <button type="button" className="ink-sb-collapse" aria-label="固定侧栏" {...tip('固定侧栏')} onClick={() => useInkLayout.getState().setOpen(true)}><Icon name="sidebarOpen" size={18} /></button>
          : <button type="button" className="ink-sb-collapse" aria-label="收起侧栏" {...tip('收起侧栏')} onClick={() => useInkLayout.getState().setOpen(false)}><Icon name="sidebarClose" size={18} /></button>}
      </div>
      <div className="ink-sb-search-wrap">
        <div className="ink-sb-search" role="button" tabIndex={0} aria-label="搜索" onClick={() => window.dispatchEvent(new CustomEvent('ready:open-quick-switcher'))}
          onKeyDown={event => { if (event.key === 'Enter') window.dispatchEvent(new CustomEvent('ready:open-quick-switcher')) }}>
          <span className="ink-sb-search-text">搜索</span>
          <span className="ink-kbd-chip">⌘K</span>
        </div>
      </div>
      <div className="ink-sb-scroll" aria-label="页面侧栏">
        <div className="ink-sb-home">
          <div className={`ink-sb-home-pill${home ? ' is-active' : ''}`} role="button" tabIndex={0} aria-pressed={home} onClick={() => useInkLayout.getState().setHome(true)}>
            <Icon name="home" size={16} stroke={2} style={{ fill: 'currentColor' }} /><span>主页</span>
          </div>
          <div className="ink-sb-home-btn" role="button" tabIndex={0} aria-label="AI 对话" {...tip('AI 对话')} onClick={() => window.dispatchEvent(new CustomEvent('ready:focus-chat-input'))}><Icon name="chat" size={16} stroke={2} style={{ fill: 'currentColor' }} /></div>
          <div className="ink-sb-home-btn" role="button" tabIndex={0} aria-label="日历" {...tip('日历')} onClick={() => requestWorkbenchModeOpen('calendar')}><Icon name="calendar" size={16} stroke={1.8} /></div>
        </div>
        <div className="ink-sb-group">
          <NavRow icon="library" label="阅读" selected={libraryActive && !home} dataAttr={{ 'data-library-entry': 'true' }}
            onClick={() => { useInkLayout.getState().setHome(false); useDocTabs.getState().openLibraryTab(); requestWorkbenchModeOpen('document') }} />
        </div>
        {(error || loadError) && <div role="alert" className="ink-sb-banner">{error || loadError}</div>}
        {favorites.length > 0 && <Section id="favorites" title="收藏">
          <div role="group">{favorites.map(node => renderRow(node, null, rootOf(node)?.path ?? '', 0, 'fav:'))}</div>
        </Section>}
        <Section id="upcoming" title="即将开始">
          {upcoming === null ? <div className="ink-sb-empty" style={{ paddingLeft: 8 }}>正在读取日程…</div>
            : upcoming.length === 0 ? <NavRow iconNode={<CalendarBadge />} label="打开日历" muted weight={400} onClick={() => requestWorkbenchModeOpen('calendar')} />
              : upcoming.map(item => <div key={item.key} className="ink-sb-row ink-sb-nav" role="button" tabIndex={0} aria-label={`${eventTimeLabel(item)} ${item.title}`}
                onClick={() => { void window.electronAPI.calendar.revealEvent(item.eventId); requestWorkbenchModeOpen('calendar') }}>
                <span className="ink-sb-event-dot" style={{ background: item.color }} />
                <span className="ink-sb-event-time">{eventTimeLabel(item)}</span>
                <span className="ink-sb-label" style={{ fontWeight: 400 }}>{item.title}</span>
              </div>)}
        </Section>
        {loading && !trees.length && <div role="status" className="ink-sb-empty" style={{ paddingLeft: 8 }}>正在读取页面…</div>}
        {!roots.length && <RootNotice />}
        {trees.map(tree => <Section key={tree.objectId} id={`root:${tree.objectId}`} title={tree.kind === 'vault' ? '页面' : tree.title}
          addLabel={`在 ${tree.title} 中新建页面`} onAdd={() => { void createIn(tree, tree.path) }}>
          {renderChildren(tree, tree.path, 0)}
        </Section>)}
      </div>
      <div className="ink-sb-bottom">
        <div className="ink-sb-divider" />
        <NavRow icon="template" label="模板" ariaLabel="从模板新建页面" muted onClick={openTemplates} />
        <NavRow icon="import" label="导入" muted onClick={openImport} />
        <NavRow icon="trash" label="回收站" muted onClick={event => openTrash(event.currentTarget)} />
      </div>
    </div>
    {!floating && <Resizer />}
  </nav>
}

function useVaultTitle(trees: PageNode[]): string {
  const vault = useVault(state => state.view.data)
  const tree = trees.find(item => item.kind === 'vault')
  return tree?.title || (vault?.status === 'ready' ? vault.root.split(/[\\/]/).pop() || '' : '')
}

function NavRow({ icon, iconNode, label, ariaLabel, muted, selected, onClick, weight, dataAttr }: { icon?: IconName; iconNode?: ReactNode; label: string; ariaLabel?: string; muted?: boolean; selected?: boolean; onClick?: (event: ReactMouseEvent<HTMLElement>) => void; weight?: number; dataAttr?: Record<string, string> }) {
  return <div className={`ink-sb-row ink-sb-nav${muted ? ' is-muted' : ''}${selected ? ' is-selected' : ''}`} role="button" tabIndex={0} aria-label={ariaLabel ?? label} {...dataAttr}
    onClick={onClick} onKeyDown={event => { if (event.key === 'Enter') (event.currentTarget as HTMLElement).click() }}>
    <span className="ink-sb-icon">{iconNode || (icon && <Icon name={icon} size={18} stroke={1.5} />)}</span>
    <span className="ink-sb-label" style={weight ? { fontWeight: weight } : undefined}>{label}</span>
  </div>
}

function Section({ id, title, children, onAdd, addLabel }: { id: string; title: string; children: ReactNode; onAdd?: () => void; addLabel?: string }) {
  const key = 'ready-ink-sections'
  const [open, setOpen] = useState(() => { try { return (JSON.parse(localStorage.getItem(key) || '{}') as Record<string, boolean>)[id] !== false } catch { return true } })
  const toggle = () => {
    setOpen(!open)
    try { localStorage.setItem(key, JSON.stringify({ ...(JSON.parse(localStorage.getItem(key) || '{}') as Record<string, boolean>), [id]: !open })) } catch { /* sections still toggle */ }
  }
  return <section className="ink-sb-section" aria-label={title}>
    <div className="ink-sb-section-head" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={event => { if (event.key === 'Enter') toggle() }}>
      <span className="ink-sb-section-title">{title}</span>
      {onAdd && <span className="ink-sb-row-actions">
        <button type="button" className="ink-sb-action" aria-label={addLabel || '新建页面'} {...tip('添加页面')} onClick={event => { event.stopPropagation(); onAdd() }}><Icon name="plus" size={16} stroke={1.8} /></button>
      </span>}
    </div>
    {open && children}
  </section>
}

function Resizer() {
  const onDown = (event: ReactPointerEvent) => {
    event.preventDefault()
    const layout = useInkLayout.getState()
    const startX = event.clientX, startWidth = layout.width
    let moved = false
    layout.setResizing(true)
    const move = (next: PointerEvent) => { if (Math.abs(next.clientX - startX) > 2) moved = true; useInkLayout.getState().setWidth(startWidth + next.clientX - startX) }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      const state = useInkLayout.getState()
      state.setResizing(false)
      if (!moved) state.setOpen(false); else state.commitWidth()
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  return <div className="ink-sb-resizer" role="separator" aria-orientation="vertical" aria-label="调整侧栏宽度" onPointerDown={onDown}
    onDoubleClick={() => useInkLayout.getState().resetWidth()} {...tip(<><div>拖动调整宽度</div><div className="ink-tooltip-sc">点击收起</div></>, undefined, 'right-start')}>
    <div className="ink-sb-resizer-line" />
  </div>
}

function RootNotice() {
  const { view, chooseFolder, createDefault } = useVault()
  const [error, setError] = useState<string | null>(null)
  const missing = view.data?.status === 'missing'
  return <div className="ink-sb-banner" aria-label="页面位置">
    <div>{missing ? `找不到资料库：${view.data?.root}` : '还没有设置资料库。页面会保存在资料库文件夹中。'}</div>
    <button type="button" className="ink-btn ink-btn-primary" onClick={() => void (missing ? chooseFolder() : createDefault())}>{missing ? '重新选择资料库…' : '设置资料库'}</button>
    <button type="button" className="ink-btn" onClick={() => { void useWorkspace.getState().pickWorkspaceRoot().then(result => { if (!result.ok && result.message !== '已取消选择。') setError(result.message || '无法打开文件夹') }) }}>打开文件夹…</button>
    {(error || view.phase === 'error') && <div role="alert">{error || (view.phase === 'error' ? view.message : '')}</div>}
  </div>
}

function RenamePanel({ node, onConfirm, onCancel }: { node: PageNode; onConfirm(title: string, operationId: string): Promise<PageResult<unknown>>; onCancel(): void }) {
  const [title, setTitle] = useState(node.title)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const intent = useRef({ title, id: crypto.randomUUID() })
  const lock = useRef(false)
  return <form className="ink-menu ink-panel" style={{ width: 300 }} onSubmit={event => {
    event.preventDefault()
    if (lock.current) return
    lock.current = true; setBusy(true)
    if (intent.current.title !== title) intent.current = { title, id: crypto.randomUUID() }
    void onConfirm(title, intent.current.id).then(result => { if (!result.ok) setError(result.message) })
      .catch(failure => setError(errorMessage(failure))).finally(() => { lock.current = false; setBusy(false) })
  }}>
    <div className="ink-panel-row">
      <InkPageIcon value={node.icon} kind={node.kind} size={20} />
      <input className="ink-input" aria-label="页面名称" data-autofocus value={title} disabled={busy} onChange={event => setTitle(event.target.value)} />
    </div>
    {error && <div role="alert" className="ink-panel-error">{error}</div>}
    <div className="ink-panel-actions">
      <button type="button" className="ink-btn" disabled={busy} onClick={onCancel}>取消</button>
      <button type="submit" className="ink-btn ink-btn-primary" disabled={busy || !title.trim()}>确定</button>
    </div>
  </form>
}

function TrashPanel({ api, roots, onChanged, onRestoreElsewhere }: { api: DocumentPagesAPI; roots: PageRoot[]; onChanged(): Promise<void>; onRestoreElsewhere(item: PageTrashEntry, root: string): void }) {
  const [items, setItems] = useState<{ root: string; item: PageTrashEntry }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const load = async () => {
    const entries = await Promise.all(roots.map(async root => checked(await api.trash(root.path)).map(item => ({ root: root.path, item }))))
    setItems(entries.flat())
  }
  useEffect(() => { void load().catch(failure => setError(errorMessage(failure))) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await work(); await onChanged(); await load() } catch (failure) { setError(errorMessage(failure)) } finally { setBusy(false) }
  }
  const restore = (item: PageTrashEntry, root: string) => act(async () => {
    const result = await api.operate({ type: 'restore', objectId: item.objectId, root, operationId: crypto.randomUUID() })
    if (!result.ok && (result.code === 'name_collision' || /parent_conflict/.test(result.message))) { onRestoreElsewhere(item, root); return }
    checked(result)
  })
  const shown = (items ?? []).filter(({ item }) => !query.trim() || item.title.toLowerCase().includes(query.trim().toLowerCase()))
  return <div className="ink-menu" style={{ width: 320 }} aria-label="回收站内容">
    <div className="ink-menu-search-wrap"><input className="ink-menu-search" data-autofocus aria-label="搜索回收站" placeholder="在回收站中搜索页面" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className="ink-menu-group ink-trash-list">
      {items === null && !error && <div className="ink-menu-empty">正在读取…</div>}
      {items !== null && shown.length === 0 && <div className="ink-menu-empty">{items.length ? '没有匹配的页面' : '回收站为空'}</div>}
      {shown.map(({ root, item }) => <div key={item.objectId} className="ink-trash-item" data-trash-id={item.objectId}>
        <span className="ink-menu-icon"><InkPageIcon size={18} /></span>
        <span className="ink-menu-text" title={item.originalPath}>{item.title}</span>
        {confirming === item.objectId ? <>
          <button type="button" className="ink-btn is-danger" disabled={busy} onClick={() => void act(async () => { checked(await api.operate({ type: 'delete', root, objectId: item.objectId, operationId: crypto.randomUUID() })); setConfirming(null) })}>确认永久删除</button>
          <button type="button" className="ink-sb-action" aria-label="取消" disabled={busy} onClick={() => setConfirming(null)}><Icon name="x" size={16} /></button>
        </> : <>
          <button type="button" className="ink-sb-action" aria-label={`恢复 ${item.title}`} {...tip('恢复')} disabled={busy} onClick={() => void restore(item, root)}><Icon name="restore" size={16} /></button>
          <button type="button" className="ink-sb-action" aria-label={`永久删除 ${item.title}`} {...tip('永久删除')} disabled={busy} onClick={() => setConfirming(item.objectId)}><Icon name="trash" size={16} /></button>
        </>}
      </div>)}
    </div>
    {error && <div role="alert" className="ink-menu-footer ink-panel-error">{error}</div>}
    <div className="ink-menu-divider" />
    <div className="ink-menu-footer">移到回收站的页面保留在资料库的回收站文件夹里，可以随时恢复。</div>
  </div>
}
