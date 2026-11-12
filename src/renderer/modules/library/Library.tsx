import { userOpenedObject } from '../workbench/navigation-open-event'
import type { BookTarget } from './reader/navigation-state'
import { FindSheet } from './find/FindSheet'
import { JobView } from './find/JobView'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownUp, FolderOpen, Import, Search, Shuffle } from 'lucide-react'
import type { LibraryBook, LibraryState } from '../../../shared/library'
import { Button, Chip, closeFloat, EmptyState, Input, toggleMenu, Toolbar, type MenuEntry } from '../../components/ui'
import { getLibraryAPI, confirmed, type LibraryAPI } from './access'
import { Shelf } from './Shelf'
import { BookOpen } from './BookOpen'
import { Reader } from './reader/Reader'
import { SORTS, sortBooks, TOPICS, type Sort } from './topics'
import { shelfBook } from './presentation'

type Route = { kind: 'shelf' } | { kind: 'info'; id: string; origin: HTMLElement } | { kind: 'read'; id: string; target?: BookTarget }
type Snapshot = { status: 'loading' } | LibraryState
const IMPORT_MENU = 'library-import-menu', SORT_MENU = 'library-sort-menu'

export function Library({ api: providedAPI, requestedPath, requestedTarget, onOpenOther }: { api?: LibraryAPI; requestedPath?: string; requestedTarget?: BookTarget; onOpenOther?: (path: string) => void }) {
  const [finding, setFinding] = useState(false)
  const sourceAPI = window.electronAPI?.bookSources
  const [snapshot, setSnapshot] = useState<Snapshot>({ status: 'loading' })
  const [error, setError] = useState('')
  const [route, setRoute] = useState<Route>(requestedTarget ? { kind: 'read', id: requestedTarget.book, target: requestedTarget } : { kind: 'shelf' })
  const [opened, setOpened] = useState<Record<string, number>>({})
  const [sort, setSort] = useState<Sort>('topic')
  const [query, setQuery] = useState('')
  const [topic, setTopic] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [menu, setMenu] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null)
  const apiRef = useRef<LibraryAPI | null>(null)
  const apiError = useRef('')
  if (!apiRef.current) {
    try { apiRef.current = providedAPI ?? getLibraryAPI() }
    catch (error) { console.warn('[Library] initialize library API failed:', error instanceof Error ? error.message : String(error)); apiError.current = String(error) }
  }
  const api = apiRef.current
  const reportError = useCallback((message: string) => setError(message), [])
  useEffect(() => {
    if (!api) { setError(apiError.current); return }
    let live = true, pushed = false
    setSnapshot({ status: 'loading' })
    const unsubscribe = api.onChanged(state => { pushed = true; if (live) setSnapshot(state) })
    void api.get().then(confirmed).then(state => { if (live && !pushed) setSnapshot(state) }).catch(error => { if (live) setError(String(error)) })
    return () => { live = false; unsubscribe() }
  }, [api, revision])

  useEffect(() => {
    if (!api || !requestedPath) return
    let live = true
    setBusy(true)
    void (async () => {
      const state = confirmed(await api.get())
      if (state.status === 'no_vault') throw new Error('请先在文件面板设置资料库，再导入这本书。')
      let book = state.books.find(b => b.filePath === requestedPath)
      if (!book) {
        const result = confirmed(await api.importFiles([requestedPath]))
        if (result.failed.length) throw new Error(result.failed.map(f => `${f.path}：${f.reason}`).join('\n'))
        book = result.imported[0]
      }
      if (!book) throw new Error('导入完成但未返回书籍，请重试。')
      if (live) { setSnapshot(confirmed(await api.get())); if (live) setRoute({ kind: 'read', id: book.id }) }
    })().catch(error => { if (live) setError(String(error)) }).finally(() => { if (live) setBusy(false) })
    return () => { live = false }
  }, [api, requestedPath, revision])

  const books = useMemo(() => snapshot.status === 'ready' ? snapshot.books : [], [snapshot])
  useEffect(() => {
    if (!api || sort !== 'recent') return
    let live = true
    void Promise.all(books.map(async b => [b.id, confirmed(await api.getPosition(b.id))?.updatedAt ?? 0] as const))
      .then(entries => { if (live) setOpened(Object.fromEntries(entries)) })
      .catch(error => { if (live) setError(String(error)) })
    return () => { live = false }
  }, [api, books, sort, route.kind])
  const sorted = useMemo(() => sortBooks(books.map(b => ({ ...shelfBook(b), opened: opened[b.id] })), sort), [books, sort, opened])
  const shown = useMemo(() => new Set(sorted.filter(b => (!topic || b.topic === topic) && `${b.title} ${b.author}`.toLowerCase().includes(query.trim().toLowerCase())).map(b => b.id)), [sorted, query, topic])
  const current = route.kind === 'shelf' ? null : books.find(b => b.id === route.id)
  const read = (record: LibraryBook) => {
    if (['epub', 'txt', 'md'].includes(record.format)) { userOpenedObject({ mode: 'document', title: record.title, ref: { kind: 'book-location', book: record.id, loc: 'c0:0+1' } }); setRoute({ kind: 'read', id: record.id }) }
    else if (onOpenOther) onOpenOther(record.filePath)
    else setError('请从文件面板打开此格式的书籍。')
  }
  const draw = () => {
    const pool = sorted.filter(b => shown.has(b.id))
    const b = pool[Math.floor(Math.random() * pool.length)]
    const origin = b && [...(root.current?.querySelectorAll<HTMLElement>('[data-book]') ?? [])].find(el => el.dataset.book === b.id)
    if (b && origin) { origin.scrollIntoView?.({ block: 'nearest' }); setRoute({ kind: 'info', id: b.id, origin }) }
  }
  const importBooks = async () => {
    if (!api || busy) return
    setBusy(true); setError('')
    try {
      const imported = confirmed(await api.pickAndImport())
      setSnapshot(confirmed(await api.get()))
      if (imported.failed.length) setError(imported.failed.map(f => `${f.path}：${f.reason}`).join('\n'))
    } catch (error) { setError(String(error)) }
    finally { setBusy(false) }
  }
  const canImport = !busy && snapshot.status === 'ready'
  const sortLabel = SORTS.find(s => s.key === sort)?.label ?? ''
  const onShelf = route.kind !== 'read'
  // The shelf's menus belong to its buttons: they close when the reader takes over or the library closes.
  useEffect(() => onShelf ? () => { closeFloat(IMPORT_MENU); closeFloat(SORT_MENU) } : undefined, [onShelf])
  const showMenu = (button: HTMLElement, id: string, label: string, items: MenuEntry[], placement: 'bottom-end' | 'top') => toggleMenu(button, {
    id, label, items, placement,
    onOpenChange: open => setMenu(current => open ? id : current === id ? null : current),
  })
  const importMenu = (button: HTMLElement) => showMenu(button, IMPORT_MENU, '导入', [
    { id: 'local', label: '本地文件…', icon: <FolderOpen />, disabled: !canImport, onSelect: () => void importBooks() },
    { id: 'find', label: '找书…', icon: <Search />, hint: 'F', onSelect: () => setFinding(true) },
  ], 'bottom-end')
  const sortMenu = (button: HTMLElement) => showMenu(button, SORT_MENU, '排序', SORTS.map(s => ({ id: s.key, label: s.label, checked: s.key === sort, onSelect: () => setSort(s.key) })), 'top')
  return <div ref={root} className="rn-library rn-design" tabIndex={0} aria-label="书房" onPointerDown={e => { if (e.target === e.currentTarget) e.currentTarget.focus() }} onKeyDown={e => {
    if (route.kind !== 'shelf' || e.metaKey || e.ctrlKey || e.altKey || (e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable]'))) return
    if (finding) return
    if (e.key.toLowerCase() === 'f' && sourceAPI) { e.preventDefault(); e.stopPropagation(); setFinding(true) }
    if (e.key === '/') { e.preventDefault(); e.stopPropagation(); search.current?.focus() }
    if (e.key.toLowerCase() === 'r') { e.preventDefault(); e.stopPropagation(); draw() }
  }}>
    {route.kind === 'read' && snapshot.status === 'ready' && !current && <p role="alert">书籍不存在或已从书房移除</p>}
    {error && <div className="library-error" role="alert"><span>{error}</span><Button variant="ghost" size="sm" onClick={() => { setError(''); setRevision(n => n + 1) }}>重试</Button><Button variant="ghost" size="sm" onClick={() => setError('')}>关闭提示</Button></div>}
    {route.kind === 'read' && current && api ? <Reader key={current.id} record={current} api={api} target={route.target} onBack={() => setRoute({ kind: 'shelf' })} onError={reportError} /> : <>
      <header className="library-toolbar">
        <div className="rn-float library-pill is-text"><b>书房</b><Input ref={search} className="library-search" aria-label="搜索书架" placeholder="在书架上找… /" value={query} onChange={e => setQuery(e.target.value)} /></div>
        {/* With book sources, 导入 is a menu (local files or 找书); without them it imports local files at once. */}
        <div className="rn-float library-pill">{sourceAPI
          ? <Button variant="ghost" icon={<Import />} aria-haspopup="menu" aria-expanded={menu === IMPORT_MENU} data-float-anchor={IMPORT_MENU} onClick={e => importMenu(e.currentTarget)}>导入</Button>
          : <Button variant="ghost" icon={<Import />} disabled={!canImport} onClick={() => void importBooks()}>导入</Button>}</div>
      </header>
      <div className="library-scroll"><header className="library-hero"><h1>我的<em>藏书</em></h1><div className="library-statistics">{[[books.length, '本藏书'], [new Set(books.map(b => b.topic)).size, '个分类'], [books.filter(b => b.status === '在读').length, '本在读'], [books.filter(b => b.status === '读完').length, '本读完']].map(([n, unit]) => <span key={unit}><b>{n}</b> {unit}</span>)}</div></header>
        {snapshot.status === 'loading' && !error && <p role="status">正在整理书架…</p>}
        {snapshot.status === 'no_vault' && <EmptyState title="还没有资料库" body="请先在文件面板设置资料库。" />}
        {snapshot.status === 'ready' && <>
          {snapshot.issues.length > 0 && <div role="alert">{snapshot.issues.map(issue => <p key={issue.notePath}>{issue.notePath}：{issue.reason}</p>)}</div>}
          {books.length === 0 ? <EmptyState title="书架还是空的" body="导入一本本地书开始阅读。" /> : <>
            <div className="library-filters" role="group" aria-label="分类筛选"><Chip aria-pressed={!topic} onClick={() => setTopic('')}>全部</Chip>{TOPICS.filter(t => sorted.some(b => b.topic === t.key)).map(t => <Chip key={t.key} aria-pressed={topic === t.key} onClick={() => setTopic(t.key)}>{t.name}</Chip>)}</div>
            <Shelf books={sorted} shown={shown} sort={sort} openId={route.kind === 'info' ? route.id : null} fresh={new Set()} onOpen={(book, origin) => setRoute({ kind: 'info', id: book.id, origin })} />
            {!shown.size && <EmptyState title="没有找到符合条件的书" />}
            <p className="library-hint">点书脊取书 · ← → 沿书架走 · R 随手抽一本 · / 搜索</p>
          </>}
        </>}
      </div>
      <footer className="library-footer"><div className="rn-float library-pill"><Toolbar label="书架">
        {sourceAPI && <Button variant="ghost" icon={<Search />} title="找书（F）" aria-keyshortcuts="F" onClick={() => setFinding(true)}>找书</Button>}
        <Button variant="ghost" icon={<ArrowDownUp />} aria-label={`排序：${sortLabel}`} aria-haspopup="menu" aria-expanded={menu === SORT_MENU} data-float-anchor={SORT_MENU} onClick={e => sortMenu(e.currentTarget)}>排序<span className="library-sort-value">{sortLabel}</span></Button>
        <Button variant="ghost" icon={<Shuffle />} title="随手抽一本（R）" aria-keyshortcuts="R" disabled={!shown.size} onClick={draw}>抽一本</Button>
      </Toolbar></div></footer>
      {route.kind === 'info' && current && <BookOpen key={current.id} book={shelfBook(current)} record={current} origin={route.origin} onClose={() => setRoute({ kind: 'shelf' })} onRead={() => read(current)} />}
    </>}
    {finding && sourceAPI && <FindSheet api={sourceAPI} onClose={() => { setFinding(false); root.current?.focus() }} />}
    {sourceAPI && <JobView api={sourceAPI} />}
  </div>
}
