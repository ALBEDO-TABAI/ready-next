import type { BookTarget } from './reader/navigation-state'
import { FindSheet } from './find/FindSheet'
import { JobView } from './find/JobView'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryBook, LibraryState } from '../../../shared/library'
import { getLibraryAPI, confirmed, type LibraryAPI } from './access'
import { Glass } from '../../design/next/GlassSurface'
import { Shelf } from './Shelf'
import { BookOpen } from './BookOpen'
import { Reader } from './reader/Reader'
import { SORTS, sortBooks, TOPICS, type Sort } from './topics'
import { shelfBook } from './presentation'

type Route = { kind: 'shelf' } | { kind: 'info'; id: string; origin: HTMLElement } | { kind: 'read'; id: string; target?: BookTarget }
type Snapshot = { status: 'loading' } | LibraryState

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
  const root = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null)
  const apiRef = useRef<LibraryAPI | null>(null)
  const apiError = useRef('')
  if (!apiRef.current) {
    try { apiRef.current = providedAPI ?? getLibraryAPI() }
    catch (error) { apiError.current = String(error) }
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
    if (['epub', 'txt', 'md'].includes(record.format)) setRoute({ kind: 'read', id: record.id })
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
  return <div ref={root} className="rn-library rn-design" tabIndex={0} aria-label="书房" onPointerDown={e => { if (e.target === e.currentTarget) e.currentTarget.focus() }} onKeyDown={e => {
    if (route.kind !== 'shelf' || e.metaKey || e.ctrlKey || e.altKey || (e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable]'))) return
    if (finding) return
    if (e.key.toLowerCase() === 'f' && sourceAPI) { e.preventDefault(); e.stopPropagation(); setFinding(true) }
    if (e.key === '/') { e.preventDefault(); e.stopPropagation(); search.current?.focus() }
    if (e.key.toLowerCase() === 'r') { e.preventDefault(); e.stopPropagation(); draw() }
  }}>
    {route.kind === 'read' && snapshot.status === 'ready' && !current && <p role="alert">书籍不存在或已从书房移除</p>}
    {error && <div className="library-error" role="alert">{error}<button type="button" onClick={() => { setError(''); setRevision(n => n + 1) }}>重试</button><button type="button" onClick={() => setError('')}>关闭提示</button></div>}
    {route.kind === 'read' && current && api ? <Reader key={current.id} record={current} api={api} target={route.target} onBack={() => setRoute({ kind: 'shelf' })} onError={reportError} /> : <>
      <header className="library-toolbar"><Glass><b>书房</b><input ref={search} aria-label="搜索书架" placeholder="在书架上找… /" value={query} onChange={e => setQuery(e.target.value)} /></Glass><Glass><button type="button" disabled={busy || snapshot.status !== 'ready'} onClick={() => void importBooks()}>导入本地书</button></Glass></header>
      <div className="library-scroll"><header className="library-hero"><h1>我的<em>藏书</em></h1><div className="library-statistics"><span>{books.length} 本藏书</span><span>{new Set(books.map(b => b.topic)).size} 个分类</span><span>{books.filter(b => b.status === '在读').length} 本在读</span><span>{books.filter(b => b.status === '读完').length} 本读完</span></div></header>
        {snapshot.status === 'loading' && !error && <p role="status">正在整理书架…</p>}
        {snapshot.status === 'no_vault' && <p>请先在文件面板设置资料库。</p>}
        {snapshot.status === 'ready' && <>
          {snapshot.issues.length > 0 && <div role="alert">{snapshot.issues.map(issue => <p key={issue.notePath}>{issue.notePath}：{issue.reason}</p>)}</div>}
          {books.length === 0 ? <p>书架还是空的，导入一本本地书开始阅读。</p> : <>
            <div className="library-filters" aria-label="分类筛选"><button type="button" aria-pressed={!topic} onClick={() => setTopic('')}>全部</button>{TOPICS.filter(t => sorted.some(b => b.topic === t.key)).map(t => <button type="button" key={t.key} aria-pressed={topic === t.key} onClick={() => setTopic(t.key)}>{t.name}</button>)}</div>
            <Shelf books={sorted} shown={shown} sort={sort} openId={route.kind === 'info' ? route.id : null} fresh={new Set()} onOpen={(book, origin) => setRoute({ kind: 'info', id: book.id, origin })} />
            {!shown.size && <p>没有找到符合条件的书。</p>}
            <p className="library-hint">点书脊取书 · ← → 沿书架走 · R 随手抽一本 · / 搜索</p>
          </>}
        </>}
      </div>
      <footer className="library-footer"><Glass>{sourceAPI && <button type="button" onClick={() => setFinding(true)}>找书 F</button>}{SORTS.map(s => <button type="button" key={s.key} aria-pressed={sort === s.key} onClick={() => setSort(s.key)}>{s.label}</button>)}<button type="button" disabled={!shown.size} onClick={draw}>抽一本</button></Glass></footer>
      {route.kind === 'info' && current && <BookOpen key={current.id} book={shelfBook(current)} record={current} origin={route.origin} onClose={() => setRoute({ kind: 'shelf' })} onRead={() => read(current)} />}
    </>}
    {finding && sourceAPI && <FindSheet api={sourceAPI} onClose={() => { setFinding(false); root.current?.focus() }} />}
    {sourceAPI && <JobView api={sourceAPI} />}
  </div>
}
