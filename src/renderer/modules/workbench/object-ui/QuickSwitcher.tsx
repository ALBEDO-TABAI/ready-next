import { navigationHistory, webPageTitle } from '../navigation-history'
import { recentOpenedResults } from './recent-opened'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Bookmark, CornerDownLeft, Search, type LucideIcon } from 'lucide-react'
import { REF_CAPSULE_KINDS, type RefCapsuleKind } from '../../../components/ui/ref-capsule-kinds'
import { useDocTabs } from '../../../stores/useDocTabs'
import { computeDesiredRoots, useWorkspace } from '../../../stores/useWorkspace'
import { useMode } from '../../../stores/useMode'
import { shortcutKeycaps } from '../../../../shared/app-shortcuts'
import { commandRegistryRevision, listCommands, subscribeCommands } from '../commands/registry'
import { draftSearchResults, mergeDraftResults, queryObjectIndex, type SearchResultItem } from './query'
import { MaskedObjectOverlay } from './QuickLook'
import { openObjectTarget, searchResultTarget, type PreviewTarget } from './navigation'

export function QuickSwitcher({ onClose, onPreview }: {
  onClose: () => void; onPreview: (target: PreviewTarget) => void
}) {
  const tabs = useDocTabs(state => state.tabs)
  const workspaceRoot = useWorkspace(state => state.workspaceRoot)
  const pinnedFolders = useWorkspace(state => state.pinnedFolders)
  const roots = useMemo(() => computeDesiredRoots({ workspaceRoot, pinnedFolders }), [workspaceRoot, pinnedFolders])
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(0), [error, setError] = useState('')
  const [response, setResponse] = useState<{ query: string; roots: string[]; items: SearchResultItem[]; warning: string } | null>(null)
  const history = useSyncExternalStore(navigationHistory.subscribe, navigationHistory.getSnapshot)
  const running = useRef(false), mounted = useRef(true), selectionVersion = useRef(0)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let active = true
    void navigationHistory.load().catch(error => { if (active) setError(String(error)) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    let active = true
    if (query.trim()) void queryObjectIndex(query, roots).then(result => {
      if (active) setResponse({ query, roots, items: result.items, warning: result.degraded ? '搜索结果可能不完整' : '' })
    }, error => { if (active) setError(String(error)) })
    return () => { active = false }
  }, [query, roots])
  const items = useMemo(() => {
    if (query.trim()) return mergeDraftResults(response?.query === query && response.roots === roots ? response.items : [], draftSearchResults(query, tabs), tabs)
    return recentOpenedResults(history, RECENT_SHOWN, webPageTitle)
  }, [query, roots, response, tabs, history])
  const mode = useMode(state => state.workbenchMode)
  useSyncExternalStore(subscribeCommands, commandRegistryRevision)
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  // Nothing typed: 最近打开 and the common commands (W6 §2.3); typing searches every command.
  const commands = listCommands({ mode }).filter(command => {
    if (!terms.length) return command.common === true
    const text = [command.title, ...(command.keywords ?? [])].join(' ').toLocaleLowerCase()
    return terms.every(term => text.includes(term))
  })
  const count = items.length + commands.length
  const index = Math.min(selected, Math.max(0, count - 1))
  // ↵ opens, ⌥↵ quick-looks, ⌘↵ opens in a new tab (W6 §2.3); clicks read the same modifiers.
  const activate = async (row: number, how: 'open' | 'preview' | 'tab' = 'open') => {
    if (running.current) return
    running.current = true
    const version = selectionVersion.current
    try {
      if (row < items.length) {
        const target = await searchResultTarget(items[row])
        if (!mounted.current || selectionVersion.current !== version) return
        if (how === 'preview') { onPreview(target); return }
        await openObjectTarget(target, { newTab: how === 'tab' })
      }
      else await commands[row - items.length]?.run()
      if (mounted.current) onClose()
    } catch (error) { if (mounted.current) setError(String(error)) }
    finally { running.current = false }
  }
  // Inkwell's search palette: the field is the header, results are icon rows, keys are hinted at the foot.
  return <MaskedObjectOverlay onClose={onClose}>
    <h2 className="rn-sr-only">快速切换</h2>
    <div className="rn-switch-input">
      <Search size={18} strokeWidth={1.8} aria-hidden />
      <input autoFocus aria-label="搜索所有对象和命令" role="combobox" aria-expanded="true" aria-controls="ready-object-results" aria-activedescendant={count ? `ready-object-option-${index}` : undefined}
        value={query} placeholder="搜索页面、文件和命令…" className="rn-switch-field ready-input-slot-inner" onChange={event => { selectionVersion.current++; setQuery(event.target.value); setSelected(0); setError('') }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected((index + (event.key === 'ArrowDown' ? 1 : -1) + count) % Math.max(1, count)) }
          if (event.key === 'Enter' && count) { event.preventDefault(); void activate(index, how(event)) }
        }} />
    </div>
    {!query && items.length > 0 && <p className="rn-switch-label">最近打开</p>}
    <ul id="ready-object-results" role="listbox" className="rn-switch-list">
      {items.map((item, row) => { const Icon = TYPE_ICONS[item.typeLabel] ?? REF_CAPSULE_KINDS.page.icon; return <li key={item.path} id={`ready-object-option-${row}`} role="option" aria-selected={index === row} className="rn-switch-item" onMouseMove={() => { if (index !== row) setSelected(row) }}>
        <button className="rn-switch-open" onClick={event => void activate(row, how(event))}>
          <span className="rn-switch-icon"><Icon size={17} strokeWidth={1.5} /></span>
          <span className="rn-switch-name">{item.title}</span>
          <span className="rn-switch-type">{item.typeLabel}{item.draft && tabs.some(tab => tab.id === item.draft?.tabId && (!tab.path || tab.isDirty)) && ' · 未保存'}</span>
        </button>
        <button className="rn-switch-peek" aria-label={`速览 ${item.title}`} onClick={() => void activate(row, 'preview')}>速览</button>
      </li> })}
      {commands.length > 0 && <li role="presentation" className="rn-switch-label">{terms.length ? '命令' : '常用命令'}</li>}
      {commands.map((command, i) => <li key={command.id} id={`ready-object-option-${items.length + i}`} role="option" aria-selected={index === items.length + i} className="rn-switch-item" onMouseMove={() => { if (index !== items.length + i) setSelected(items.length + i) }}>
        <button className="rn-switch-open" onClick={() => void activate(items.length + i)}><span className="rn-switch-icon"><CornerDownLeft size={16} strokeWidth={1.6} /></span><span className="rn-switch-name">{command.title}</span>{command.shortcut && <span className="rn-switch-type">{shortcutKeycaps(command.shortcut, /Mac/.test(navigator.platform)).join(' ')}</span>}</button>
      </li>)}
      {query && !count && response?.query === query && <li role="presentation" className="rn-switch-empty">没有找到「{query}」</li>}
    </ul>
    {response?.query === query && response.warning && <p role="status" className="rn-switch-note">{response.warning}</p>}
    {error && <p role="alert" className="rn-switch-note is-error">{error}</p>}
    <footer className="rn-switch-foot"><span>↑↓ 选择</span><span>↵ 打开</span><span>⌥↵ 速览</span><span>⌘↵ 新标签打开</span><button onClick={onClose}>关闭</button></footer>
  </MaskedObjectOverlay>
}

const RECENT_SHOWN = 8
const how = (event: { altKey: boolean; metaKey: boolean; ctrlKey: boolean }) => event.altKey ? 'preview' as const : event.metaKey || event.ctrlKey ? 'tab' as const : 'open' as const
// Each search type shows the icon of the object it opens; 书签 are saved web pages.
const KIND_OF: Record<SearchResultItem['typeLabel'], RefCapsuleKind | null> = {
  页面: 'page', 数据库: 'database', 画板: 'canvas', 书: 'book', 划线: 'highlight', 资讯: 'rss', 日程: 'event', 对话: 'conversation', 书签: null, 收集: 'fastcard', 命令: null,
}
const TYPE_ICONS = Object.fromEntries(Object.entries(KIND_OF).map(([label, kind]) => [label, kind ? REF_CAPSULE_KINDS[kind].icon : label === '书签' ? Bookmark : CornerDownLeft])) as Record<SearchResultItem['typeLabel'], LucideIcon>
