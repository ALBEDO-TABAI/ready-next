import { useEffect, useState, type ReactNode } from 'react'
import { IconButton, MenuList, Switch, anchorOf, confirmDialog, openFloat, showToast, tooltip, type MenuEntry } from '../../../components/ui'
import type { DocumentExportKind } from '../../../components/document/document-export'
import { saveBeforePageTrash } from '../page-ui/page-panel-state'
import type { PageNode, PageProperties, PageRoot, PageUserState } from '../../../../shared/document-pages'
import { toReadyUri } from '../../../../shared/ready-ref'
import type { DocTab } from '../../../stores/useDocTabs'
import { Icon } from './icons'
import { InkPageIcon } from './InkPageIcon'
import { openInCurrentTab } from './layout-state'
import { NavigationBackEntry } from '../../workbench/NavigationBackEntry'

type Crumb = { objectId?: string; path?: string; title: string; icon?: string; kind?: PageNode['kind'] }

/** Ancestors of the open page, read from the page trees (vault and folder roots). */
function useBreadcrumb(tab: DocTab | null, roots: PageRoot[]): { crumbs: Crumb[]; favorite: boolean | null; toggleFavorite(): void; node: PageNode | null; rootPath: string | null } {
  const api = window.electronAPI?.documentPages
  const [trees, setTrees] = useState<PageNode[]>([])
  const [states, setStates] = useState<PageUserState[]>([])
  const rootsKey = JSON.stringify(roots)
  useEffect(() => {
    if (!api) return
    let alive = true
    const load = async () => {
      const [results, userStates] = await Promise.all([Promise.all(roots.map(root => api.tree(root))), api.states()])
      if (!alive) return
      setTrees(results.flatMap(result => result.ok ? [result.value] : []))
      if (userStates.ok) setStates(userStates.value)
    }
    void load().catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = api.onChanged(() => { clearTimeout(timer); timer = setTimeout(() => { void load().catch(() => {}) }, 120) })
    return () => { alive = false; clearTimeout(timer); unsubscribe() }
  }, [api, rootsKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const objectId = tab?.objectId
  const chain: PageNode[] = []
  const find = (node: PageNode, trail: PageNode[]): boolean => {
    if (node.objectId === objectId) { chain.push(...trail, node); return true }
    return node.children.some(child => find(child, [...trail, node]))
  }
  if (objectId) for (const tree of trees) if (find(tree, [])) break
  const crumbs: Crumb[] = chain.filter(node => node.kind !== 'vault').map(node => ({ objectId: node.objectId, path: node.path, title: node.title, icon: node.icon, kind: node.kind }))
  const isPage = chain.at(-1)?.kind === 'page'
  const favorite = isPage ? states.some(state => state.objectId === objectId && state.favorite) : null
  return {
    crumbs, favorite,
    node: chain.at(-1) ?? null,
    rootPath: chain[0]?.path ?? null,
    toggleFavorite: () => {
      if (!api || !objectId) return
      void api.favorite(objectId, !favorite).then(async () => { const next = await api.states(); if (next.ok) setStates(next.value) })
    },
  }
}

/** The page menu's actions that live outside the header (the page view owns export, book reading and marks). */
export interface InkPageMenuActions {
  exportable: boolean
  onExport(kind: DocumentExportKind): void
  bookReading: { active: boolean; eligible: boolean; toggle(): void }
  marks: { open: boolean; toggle(): void }
  /** A file in a mounted folder can be brought into the library (W3 M4). */
  adopt?(): void
  /** A library page can be kept out of what the RSS sieve sees of the person's work (W5 §3). */
  sieve?: { hidden: boolean; toggle(): void }
}

// The page header (W3 §4.1): breadcrumb on the left; on the right only 收藏, 大纲 (when the page has three or
// more headings) and “…”, which holds copy link, export, book reading, marks, page style, Markdown source and
// move to trash.
export function InkTopbar({ tab, roots, home, outline, pageMenu, status, sourceMode, onSourceMode }: {
  tab: DocTab | null; roots: PageRoot[]; home: boolean; status?: ReactNode
  /** The outline toggle; absent when the page has fewer than three headings. */
  outline?: { open: boolean; toggle(): void }
  pageMenu?: InkPageMenuActions
  /** Markdown source editing, kept as a quiet escape hatch now that pages are the normal view. */
  sourceMode: boolean; onSourceMode(on: boolean): void
}) {
  const { crumbs, favorite, toggleFavorite, node, rootPath } = useBreadcrumb(home ? null : tab, roots)
  const markdown = !!tab && tab.kind !== 'library' && (!tab.path || /\.md$/i.test(tab.path))
  const copyLink = tab?.objectId && favorite !== null
    ? () => { void navigator.clipboard?.writeText(toReadyUri({ kind: 'page', id: tab.objectId! })).then(() => showToast('已复制链接')) }
    : undefined
  const trash = node && rootPath && node.kind === 'page'
    ? async () => {
      const ok = await confirmDialog({ title: `把「${node.title}」移到回收站？`, body: '子页面和附件会一起移过去，可以在回收站里恢复。', confirmLabel: '移到回收站', danger: true })
      if (!ok) return
      try {
        await saveBeforePageTrash(node)
        const result = await window.electronAPI.documentPages.operate({ type: 'trash', objectId: node.objectId, root: rootPath, operationId: crypto.randomUUID() })
        if (!result.ok) throw new Error(result.message)
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure)
        console.warn('[InkTopbar] move page to trash failed:', message)
        showToast(message)
      }
    }
    : undefined
  const fallback: Crumb[] = home ? [{ title: '今日' }]
    : !tab ? []
      : tab.kind === 'library' ? [{ title: '阅读' }]
        : crumbs.length ? crumbs : [{ title: tab.title.replace(/\.(md|canvas)$/i, '') || '未命名', path: tab.path ?? undefined, kind: /\.canvas$/i.test(tab.path ?? '') ? 'canvas' : 'page' }]
  return <header className="ink-topbar" aria-label="文档顶栏">
    <div className="ink-topbar-left">
      <NavigationBackEntry mode="document" />
      {fallback.map((crumb, index) => <span key={`${crumb.objectId ?? crumb.title}:${index}`} className="ink-crumb-wrap">
        {index > 0 && <span className="ink-crumb-sep">/</span>}
        <button type="button" className={`ink-crumb${index < fallback.length - 1 ? ' is-muted' : ''}`} title={crumb.path}
          onClick={() => { if (crumb.path && index < fallback.length - 1) openInCurrentTab(crumb.path) }}>
          {(crumb.icon || index === fallback.length - 1) && <span className="ink-crumb-icon">{home ? <span className="ink-crumb-today" aria-hidden /> : tab?.kind === 'library' ? <Icon name="library" size={16} /> : <InkPageIcon value={crumb.icon} kind={crumb.kind} size={16} emojiSize={14} />}</span>}
          <span className="ink-crumb-text">{crumb.title}</span>
        </button>
      </span>)}
    </div>
    <div className="ink-topbar-right">
      {!home && sourceMode && markdown && <button type="button" className="ink-source-chip" aria-label="返回页面视图" {...tooltip('返回页面视图')} onClick={() => onSourceMode(false)}>
        <Icon name="code" size={14} />源码<Icon name="x" size={12} stroke={2} />
      </button>}
      {/* On 今日 the draft controls keep only the recovery badge: unsaved drafts stay reachable after a crash. */}
      {status}
      {!home && tab?.objectId && favorite !== null && (
        <IconButton title={favorite ? '取消收藏' : '收藏'} active={favorite} icon={<Icon name="star" />} {...tooltip(favorite ? '取消收藏' : '收藏')} onClick={toggleFavorite} />
      )}
      {!home && outline && (
        <IconButton title="大纲" active={outline.open} icon={<Icon name="outline" />} {...tooltip('大纲')} onClick={outline.toggle} />
      )}
      {!home && markdown && <IconButton title="页面选项" icon={<Icon name="more" />} {...tooltip('导出、阅读方式、样式与源码')}
        onClick={event => openFloat({ id: 'ink-page-options', anchor: anchorOf(event.currentTarget), placement: 'bottom-end', offset: 6, role: 'dialog', label: '页面选项', className: 'ink-page-options',
          render: close => <PageOptions objectId={favorite !== null ? tab!.objectId! : null} sourceMode={sourceMode} onSourceMode={onSourceMode}
            close={close} copyLink={copyLink} actions={pageMenu} onTrash={trash} /> })} />}
    </div>
  </header>
}

type PageDisplay = NonNullable<PageProperties['ready_page']>

/** Inkwell's page menu: font style cards, small text and full width, saved to the page's frontmatter. */
function PageOptions({ objectId, sourceMode, onSourceMode, close, copyLink, actions, onTrash }: {
  objectId: string | null; sourceMode: boolean; onSourceMode(on: boolean): void
  close(): void; copyLink?: () => void; actions?: InkPageMenuActions; onTrash?: () => void | Promise<void>
}) {
  const api = window.electronAPI.documentPages
  const [display, setDisplay] = useState<PageDisplay | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!objectId) return
    void api.properties(objectId).then(result => { if (result.ok) setDisplay(result.value.properties.ready_page ?? {}); else setError(result.message) })
  }, [api, objectId])
  const update = async (change: PageDisplay) => {
    if (!objectId) return
    setBusy(true); setError(null)
    try {
      const current = await api.properties(objectId)
      if (!current.ok) throw new Error(current.message)
      const result = await api.patchProperties(objectId, current.value.version, { ready_page: change })
      if (!result.ok) throw new Error(result.message)
      setDisplay(previous => ({ ...previous, ...change }))
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } finally { setBusy(false) }
  }
  const font = display?.font ?? 'sans'
  // One shared menu (W1 §5): actions, the reading toggles as checkable items, source and trash; the page style
  // (font cards, small text, full width) sits above it and stays open while the writer tries the options.
  const items: MenuEntry[] = [
    ...(copyLink ? [{ id: 'link', label: '复制链接', icon: <Icon name="link" />, onSelect: copyLink }] : []),
    ...(actions ? [
      { id: 'pdf', label: '导出为 PDF', icon: <Icon name="download" />, disabled: !actions.exportable, onSelect: () => actions.onExport('pdf') },
      { id: 'md', label: '导出 Markdown（含资源）', icon: <Icon name="download" />, disabled: !actions.exportable, onSelect: () => actions.onExport('md-bundle') },
      { id: 'book', label: '书本阅读', icon: <Icon name="book" />, checked: actions.bookReading.active, disabled: !actions.bookReading.eligible, onSelect: actions.bookReading.toggle },
      { id: 'marks', label: '书签与笔记', icon: <Icon name="bookmark" />, checked: actions.marks.open, onSelect: actions.marks.toggle },
      ...(actions.adopt ? [{ id: 'adopt', label: '收进资料库…', icon: <Icon name="import" />, onSelect: actions.adopt }] : []),
      ...(actions.sieve ? [{ id: 'sieve', label: '不让筛子看到', icon: <Icon name="eyeOff" />, checked: actions.sieve.hidden, onSelect: actions.sieve.toggle }] : []),
    ] : []),
    ...(copyLink || actions ? [{ kind: 'separator' as const }] : []),
    { id: 'source', label: 'Markdown 源码', icon: <Icon name="code" />, checked: sourceMode, onSelect: () => onSourceMode(!sourceMode) },
    ...(onTrash ? [{ kind: 'separator' as const }, { id: 'trash', label: '移到回收站', icon: <Icon name="trash" />, danger: true, onSelect: () => { void onTrash() } }] : []),
  ]
  const ready = !busy && !!display
  return <>
    {objectId && <>
      <div className="ink-page-style" role="group" aria-label="页面样式">
        <div className="rn-menu__group" role="presentation">字体样式</div>
        <div className="ink-fontcards" role="radiogroup" aria-label="字体样式">
          {([['sans', '默认'], ['serif', '衬线'], ['mono', '等宽']] as const).map(([id, label]) => <button key={id} type="button" role="radio" aria-checked={font === id} aria-label={label}
            className="ink-fontcard" onClick={() => { if (ready) void update({ font: id }) }}>
            <span className={`ink-fontcard-ag is-${id}`}>Ag</span><span className="ink-fontcard-label">{label}</span>
          </button>)}
        </div>
        {([['small_text', '小字', 'smallText'], ['full_width', '全宽', 'fullWidth']] as const).map(([key, label, icon]) => <div key={key} className="ink-switch-row">
          <Icon name={icon} /><span>{label}</span>
          <Switch label={label} checked={!!display?.[key]} onChange={() => { if (ready) void update({ [key]: !display?.[key] }) }} />
        </div>)}
      </div>
      <div className="rn-menu__sep" role="separator" />
    </>}
    <MenuList items={items} label="页面操作" onDone={close} />
    {error && <p role="alert" className="ink-float-error">{error}</p>}
  </>
}
