import { useEffect, useState, type ReactNode } from 'react'
import type { PageNode, PageProperties, PageRoot, PageUserState } from '../../../../shared/document-pages'
import { toReadyUri } from '../../../../shared/ready-ref'
import type { DocTab } from '../../../stores/useDocTabs'
import { Icon } from './icons'
import { InkPageIcon } from './InkPageIcon'
import { openInCurrentTab } from './layout-state'
import { openPopover, tip } from './overlay'

type Crumb = { objectId?: string; path?: string; title: string; icon?: string; kind?: PageNode['kind'] }

/** Ancestors of the open page, read from the page trees (vault and folder roots). */
function useBreadcrumb(tab: DocTab | null, roots: PageRoot[]): { crumbs: Crumb[]; favorite: boolean | null; toggleFavorite(): void } {
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
    toggleFavorite: () => {
      if (!api || !objectId) return
      void api.favorite(objectId, !favorite).then(async () => { const next = await api.states(); if (next.ok) setStates(next.value) })
    },
  }
}

export function InkTopbar({ tab, roots, home, actions, status, sourceMode, onSourceMode }: {
  tab: DocTab | null; roots: PageRoot[]; home: boolean; actions?: ReactNode; status?: ReactNode
  /** Markdown source editing, kept as a quiet escape hatch now that pages are the normal view. */
  sourceMode: boolean; onSourceMode(on: boolean): void
}) {
  const { crumbs, favorite, toggleFavorite } = useBreadcrumb(home ? null : tab, roots)
  const markdown = !!tab && tab.kind !== 'library' && (!tab.path || /\.md$/i.test(tab.path))
  const [copied, setCopied] = useState(false)
  const fallback: Crumb[] = home ? [{ title: '主页' }]
    : !tab ? []
      : tab.kind === 'library' ? [{ title: '阅读' }]
        : crumbs.length ? crumbs : [{ title: tab.title.replace(/\.(md|canvas)$/i, '') || '未命名', path: tab.path ?? undefined, kind: /\.canvas$/i.test(tab.path ?? '') ? 'canvas' : 'page' }]
  return <header className="ink-topbar" aria-label="文档顶栏">
    <div className="ink-topbar-left">
      {fallback.map((crumb, index) => <span key={`${crumb.objectId ?? crumb.title}:${index}`} className="ink-crumb-wrap">
        {index > 0 && <span className="ink-crumb-sep">/</span>}
        <button type="button" className={`ink-crumb${index < fallback.length - 1 ? ' is-muted' : ''}`} title={crumb.path}
          onClick={() => { if (crumb.path && index < fallback.length - 1) openInCurrentTab(crumb.path) }}>
          {(crumb.icon || index === fallback.length - 1) && <span className="ink-crumb-icon">{home ? <Icon name="home" size={14} stroke={2} /> : tab?.kind === 'library' ? <Icon name="library" size={14} /> : <InkPageIcon value={crumb.icon} kind={crumb.kind} size={16} emojiSize={14} />}</span>}
          <span className="ink-crumb-text">{crumb.title}</span>
        </button>
      </span>)}
    </div>
    <div className="ink-topbar-right">
      {!home && sourceMode && markdown && <button type="button" className="ink-source-chip" aria-label="返回页面视图" {...tip('返回页面视图')} onClick={() => onSourceMode(false)}>
        <Icon name="code" size={13} stroke={2} />源码<Icon name="x" size={12} stroke={2} />
      </button>}
      {!home && status}
      {!home && tab?.objectId && favorite !== null && <>
        <button type="button" className="ink-topbar-icon" aria-label={copied ? '已复制链接' : '复制链接'} {...tip(copied ? '已复制' : '复制链接')}
          onClick={() => { void navigator.clipboard?.writeText(toReadyUri({ kind: 'page', id: tab.objectId! })).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}>
          <Icon name={copied ? 'check' : 'link'} size={18} stroke={1.6} />
        </button>
        <button type="button" className={`ink-topbar-icon${favorite ? ' is-fav' : ''}`} aria-label={favorite ? '取消收藏' : '收藏'} aria-pressed={favorite} {...tip(favorite ? '取消收藏' : '收藏')} onClick={toggleFavorite}>
          <Icon name="star" size={18} stroke={1.6} style={favorite ? { fill: '#F6C050', color: '#F6C050' } : undefined} />
        </button>
      </>}
      {!home && actions}
      {!home && markdown && <button type="button" className="ink-topbar-icon" aria-label="页面选项" {...tip('样式、源码等')}
        onClick={event => openPopover({ id: 'ink-page-options', anchor: event.currentTarget.getBoundingClientRect(), placement: 'bottom-end', offset: 6, label: '页面选项',
          render: close => <PageOptions objectId={favorite !== null ? tab!.objectId! : null} sourceMode={sourceMode} onSourceMode={on => { close(); onSourceMode(on) }} /> })}>
        <Icon name="more" size={18} stroke={2} />
      </button>}
    </div>
  </header>
}

type PageDisplay = NonNullable<PageProperties['ready_page']>

/** Inkwell's page menu: font style cards, small text and full width, saved to the page's frontmatter. */
function PageOptions({ objectId, sourceMode, onSourceMode }: { objectId: string | null; sourceMode: boolean; onSourceMode(on: boolean): void }) {
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
  const source = <div className="ink-menu-group">
    <div role="menuitemcheckbox" aria-checked={sourceMode} aria-label="Markdown 源码" tabIndex={0} className="ink-menu-item" onClick={() => onSourceMode(!sourceMode)}
      onKeyDown={event => { if (event.key === 'Enter') onSourceMode(!sourceMode) }}>
      <span className="ink-menu-icon"><Icon name="code" size={18} /></span><span className="ink-menu-text">Markdown 源码</span>
      <span className={`ink-switch${sourceMode ? ' is-on' : ''}`} aria-hidden><span className="ink-switch-knob" /></span>
    </div>
  </div>
  if (!objectId) return <div className="ink-menu" style={{ width: 240 }}>{source}</div>
  return <div className="ink-menu" style={{ width: 286 }}>
    <div className="ink-menu-group">
      <div className="ink-menu-label">字体样式</div>
      <div className="ink-fontcards" role="radiogroup" aria-label="字体样式">
        {([['sans', '默认'], ['serif', '衬线'], ['mono', '等宽']] as const).map(([id, label]) => <div key={id} role="radio" aria-checked={font === id} aria-label={label} tabIndex={0}
          className={`ink-fontcard${font === id ? ' is-active' : ''}`} onClick={() => { if (!busy && display) void update({ font: id }) }}>
          <div className={`ink-fontcard-ag is-${id}`}>Ag</div><div className="ink-fontcard-label">{label}</div>
        </div>)}
      </div>
    </div>
    <div className="ink-menu-divider" />
    <div className="ink-menu-group">
      {([['small_text', '小字', 'smallText'], ['full_width', '全宽', 'fullWidth']] as const).map(([key, label, icon]) => <div key={key} role="menuitemcheckbox" aria-checked={!!display?.[key]} aria-label={label} tabIndex={0}
        className="ink-menu-item" onClick={() => { if (!busy && display) void update({ [key]: !display[key] }) }}>
        <span className="ink-menu-icon"><Icon name={icon} size={18} /></span><span className="ink-menu-text">{label}</span>
        <span className={`ink-switch${display?.[key] ? ' is-on' : ''}`} aria-hidden><span className="ink-switch-knob" /></span>
      </div>)}
    </div>
    <div className="ink-menu-divider" />
    {source}
    {error && <div role="alert" className="ink-menu-footer ink-panel-error">{error}</div>}
  </div>
}
