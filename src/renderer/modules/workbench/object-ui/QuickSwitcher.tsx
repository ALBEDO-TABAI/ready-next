import { useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, File, FileText, Search, Shapes } from 'lucide-react'
import { useDocTabs } from '../../../stores/useDocTabs'
import { computeDesiredRoots, useWorkspace } from '../../../stores/useWorkspace'
import type { WorkbenchMode } from '../../../stores/useMode'
import { requestWorkbenchModeOpen } from '../mode-transition'
import { draftSearchResults, mergeDraftResults, queryObjectIndex, type SearchResultItem } from './query'
import { MaskedObjectOverlay } from './QuickLook'
import { openObjectTarget, searchResultTarget, type PreviewTarget } from './navigation'

export function QuickSwitcher({ onClose, onPreview, onSettings }: {
  onClose: () => void; onPreview: (target: PreviewTarget) => void; onSettings: () => void
}) {
  const tabs = useDocTabs(state => state.tabs)
  const workspaceRoot = useWorkspace(state => state.workspaceRoot)
  const pinnedFolders = useWorkspace(state => state.pinnedFolders)
  const roots = useMemo(() => computeDesiredRoots({ workspaceRoot, pinnedFolders }), [workspaceRoot, pinnedFolders])
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(0), [error, setError] = useState('')
  const [response, setResponse] = useState<{ query: string; roots: string[]; items: SearchResultItem[]; warning: string } | null>(null)
  const [recent, setRecent] = useState<SearchResultItem[]>([])
  const running = useRef(false), mounted = useRef(true), selectionVersion = useRef(0)
  const createRequest = useRef<{ root: string; operationId: string } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let active = true
    void window.electronAPI.documentPages.states().then(async result => {
      if (!result.ok) throw new Error(result.message)
      const rows = await Promise.all(result.value.filter(row => row.lastVisitedAt).sort((a, b) => b.lastVisitedAt! - a.lastVisitedAt!).slice(0, 20).map(async row => {
        const location = await window.electronAPI.objects.locate(row.objectId)
        return location ? { path: location.path, name: location.path.split(/[\\/]/).pop()!, nameMatch: false, snippet: '', tagsHit: [], linksHit: [], sourceType: 'document' } : null
      }))
      if (active) setRecent(rows.filter(row => row !== null))
    }).catch(error => { if (active) setError(String(error)) })
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
    const open = [...tabs].filter(tab => tab.kind !== 'library').sort((a, b) => (b.lastActivatedAt ?? 0) - (a.lastActivatedAt ?? 0)).map(tab => ({ path: tab.path ?? `draft://${tab.id}`, name: tab.title, nameMatch: false, snippet: '', tagsHit: [], linksHit: [], sourceType: 'document', draft: { tabId: tab.id } }))
    const paths = new Set(open.map(item => item.path))
    return [...open, ...recent.filter(item => !paths.has(item.path))]
  }, [query, roots, response, tabs, recent])
  const commands = [
    { name: '新建页面', run: async () => {
      const vault = await window.electronAPI.vault.get()
      if (vault.status !== 'ready') throw new Error('请先打开资料库')
      if (createRequest.current?.root !== vault.root) createRequest.current = { root: vault.root, operationId: crypto.randomUUID() }
      const result = await window.electronAPI.documentPages.operate({ type: 'create', ...createRequest.current, parentPath: vault.root, title: '新页面', content: '' })
      if (!result.ok) throw new Error(result.message)
      if (mounted.current) await openObjectTarget({ kind: 'page', id: result.value.objectId })
    } },
    ...(['document', 'browser', 'rss', 'calendar'] as WorkbenchMode[]).map((mode, i) => ({ name: `切换到${['文档', '浏览器', 'RSS', '日历'][i]}`, run: () => requestWorkbenchModeOpen(mode) })),
    { name: '打开设置', run: onSettings },
  ].filter(command => !query || command.name.includes(query))
  const count = items.length + commands.length
  const index = Math.min(selected, Math.max(0, count - 1))
  const activate = async (row: number, preview = false) => {
    if (running.current) return
    running.current = true
    const version = selectionVersion.current
    try {
      if (row < items.length) {
        const target = await searchResultTarget(items[row])
        if (!mounted.current || selectionVersion.current !== version) return
        if (preview) { onPreview(target); return }
        await openObjectTarget(target)
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
          if (event.key === 'Enter' && count) { event.preventDefault(); void activate(index, event.altKey) }
        }} />
    </div>
    {!query && items.length > 0 && <p className="rn-switch-label">最近打开</p>}
    <ul id="ready-object-results" role="listbox" className="rn-switch-list">
      {items.map((item, row) => <li key={item.path} id={`ready-object-option-${row}`} role="option" aria-selected={index === row} className="rn-switch-item" onMouseMove={() => { if (index !== row) setSelected(row) }}>
        <button className="rn-switch-open" onClick={event => void activate(row, event.altKey)}>
          <span className="rn-switch-icon">{/\.canvas$/i.test(item.path) ? <Shapes size={17} strokeWidth={1.5} /> : /\.md$/i.test(item.path) || item.draft ? <FileText size={17} strokeWidth={1.5} /> : <File size={17} strokeWidth={1.5} />}</span>
          <span className="rn-switch-name">{item.name}</span>
          <span className="rn-switch-type">{SOURCE_LABELS[item.sourceType] ?? item.sourceType}{item.draft && tabs.some(tab => tab.id === item.draft?.tabId && (!tab.path || tab.isDirty)) && ' · 未保存'}</span>
        </button>
        <button className="rn-switch-peek" aria-label={`速览 ${item.name}`} onClick={() => void activate(row, true)}>速览</button>
      </li>)}
      {commands.length > 0 && <li role="presentation" className="rn-switch-label">命令</li>}
      {commands.map((command, i) => <li key={command.name} id={`ready-object-option-${items.length + i}`} role="option" aria-selected={index === items.length + i} className="rn-switch-item" onMouseMove={() => { if (index !== items.length + i) setSelected(items.length + i) }}>
        <button className="rn-switch-open" onClick={() => void activate(items.length + i)}><span className="rn-switch-icon"><CornerDownLeft size={16} strokeWidth={1.6} /></span><span className="rn-switch-name">{command.name}</span></button>
      </li>)}
      {query && !count && response?.query === query && <li role="presentation" className="rn-switch-empty">没有找到「{query}」</li>}
    </ul>
    {response?.query === query && response.warning && <p role="status" className="rn-switch-note">{response.warning}</p>}
    {error && <p role="alert" className="rn-switch-note is-error">{error}</p>}
    <footer className="rn-switch-foot"><span>↑↓ 选择</span><span>↵ 打开</span><span>⌥↵ 速览</span><button onClick={onClose}>关闭</button></footer>
  </MaskedObjectOverlay>
}

const SOURCE_LABELS: Record<string, string> = { page: '页面', file: '文件', canvas: '画板', document: '文档', draft: '草稿', book: '书', rss: '文章', event: '日程' }
