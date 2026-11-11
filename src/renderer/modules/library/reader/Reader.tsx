import { pageOf, resolveBookLocation } from './location'
import { requestBookLocation, type BookTarget } from './navigation-state'
import { registerReturnPosition } from '../../workbench/reference-return'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryBook, LibraryBookmark, LibraryReadingPosition } from '../../../../shared/library'
import { toLocalFileUrl } from '../../../utils/dragDrop'
import { confirmed, savePosition, type LibraryAPI } from '../access'
import { loadBook, type LoadedBook } from './book'
import { paginate, PAPERS, fontStack, type Layout, type Typo } from './paginate'
import { createFlipbook, type FlipView } from './flipbook.js'
import { renderSheet } from './renderSheet'
import { pageStyles } from './pageStyles'
import { paintMarks } from './marks'
import { useHighlights } from './useHighlights'
import { HighlightPopover, MarginNotes, NotesList } from './Notes'

type Loaded = { css: string; book: LoadedBook; position: LibraryReadingPosition | null; bookmarks: LibraryBookmark[] }
type Load = { status: 'loading' } | { status: 'ready'; data: Loaded } | { status: 'error'; error: string }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export function Reader({ record, api, target, onBack, onError }: { record: LibraryBook; api: LibraryAPI; target?: BookTarget; onBack: () => void; onError: (error: string) => void }) {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  useEffect(() => {
    const abort = new AbortController()
    let owned: LoadedBook | undefined
    setLoad({ status: 'loading' })
    void (async () => {
      try {
        const response = await fetch(toLocalFileUrl(record.filePath), { signal: abort.signal })
        if (!response.ok) throw new Error(`读不到书籍文件（${response.status}）`)
        owned = await loadBook(await response.arrayBuffer(), record.format, record.title)
        if (!owned.chapters.length) throw new Error('书中没有可阅读的正文')
        const [position, bookmarks, css] = await Promise.all([api.getPosition(record.id), api.listBookmarks(record.id), pageStyles()])
        if (!abort.signal.aborted) setLoad({ status: 'ready', data: { css, book: owned, position: confirmed(position), bookmarks: confirmed(bookmarks) } })
      } catch (error) {
        if (!abort.signal.aborted) setLoad({ status: 'error', error: errorText(error) })
      } finally {
        if (abort.signal.aborted) owned?.urls.forEach(url => URL.revokeObjectURL(url))
      }
    })()
    return () => { abort.abort(); owned?.urls.forEach(url => URL.revokeObjectURL(url)) }
  }, [api, record.id, record.filePath, record.title, record.format])
  if (load.status === 'ready') return <ReadyReader key={record.id} record={record} api={api} loaded={load.data} target={target} onBack={onBack} onError={onError} />
  return <div className="reader-loading"><button type="button" onClick={onBack}>回到书架</button><p role={load.status === 'error' ? 'alert' : 'status'}>{load.status === 'error' ? load.error : '正在打开书…'}</p></div>
}

function ReadyReader({ record, api, loaded, target, onBack, onError }: { record: LibraryBook; api: LibraryAPI; loaded: Loaded; target?: BookTarget; onBack: () => void; onError: (error: string) => void }) {
  const [typo, setTypo] = useState<Typo>({ size: 18, lead: 1.8, font: 'song', paper: document.documentElement.dataset.theme === 'dark' ? 'night' : 'cream' })
  const [single, setSingle] = useState(false)
  const [layout, setLayout] = useState<Layout | null>(null)
  const [view, setView] = useState<FlipView | null>(null)
  const [panel, setPanel] = useState<'toc' | 'marks' | 'notes' | 'type' | null>(null)
  const [marks, setMarks] = useState(loaded.bookmarks)
  const [markBusy, setMarkBusy] = useState(false)
  const markPending = useRef(false)
  const [turning, setTurning] = useState(false)
  const [rendering, setRendering] = useState(true)
  const [engine, setEngine] = useState('CSS 翻页')
  const root = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), bookEl = useRef<HTMLDivElement>(null)
  const flip = useRef<ReturnType<typeof createFlipbook> | null>(null)
  const position = useRef(target ? { bookId: record.id, chapter: target.location.chapter, offset: target.location.from, pct: 0, updatedAt: Date.now() } : loaded.position)
  const flashUntil = useRef<number | null>(null)
  const targetValidated = useRef(false)
  const targetPositionPublished = useRef(false)
  const { book } = loaded
  const annotations = useHighlights({ record, api, book, layout, flip, onError })
  const { listRef, onSelect, onMark, close: closeHighlight } = annotations
  const latin = !/^zh|^ja|^ko/i.test(book.lang) && !/[㐀-鿿]/.test(book.chapters[0]?.html.slice(0, 3000) ?? '')
  const toc = useMemo(() => book.toc.length ? book.toc : book.chapters.map((c, chapter) => ({ label: c.title, chapter, depth: 0 })), [book])
  const paper = PAPERS[typo.paper]
  const fail = useRef(onError); fail.current = onError

  const readingReady = view !== null
  useEffect(() => {
    if (!readingReady) return
    const layers = window.electronAPI.calendarLayers
    let session: { id: string; began: Promise<void> } | null = null
    const finish = () => {
      const current = session; session = null
      if (!current) return
      const endedAt = Date.now()
      void current.began.then(async () => {
        const result = await layers.endReading({ id: current.id, endedAt })
        if (!result.ok) throw new Error(result.message)
      }).catch(error => fail.current(errorText(error)))
    }
    const begin = () => {
      if (session || document.hidden) return
      const id = crypto.randomUUID(), at = position.current
      const began = layers.beginReading({ id, objectId: record.id, bookId: record.id,
        loc: `c${at?.chapter ?? 0}:${at?.offset ?? 0}+1`, startedAt: Date.now() }).then(result => { if (!result.ok) throw new Error(result.message) })
      session = { id, began }
      void began.catch(error => fail.current(errorText(error)))
    }
    const visibility = () => { if (document.hidden) finish(); else begin() }
    begin(); document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', finish)
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', finish); finish() }
  }, [record.id, readingReady])

  useEffect(() => registerReturnPosition('library-reader', () => {
    const at = position.current
    return () => { if (at) requestBookLocation({ book: record.id, location: { chapter: at.chapter, from: at.offset, to: at.offset + 1 } }) }
  }), [record.id])

  useEffect(() => {
    const observer = new MutationObserver(() => setTypo(t => ({ ...t, paper: document.documentElement.dataset.theme === 'dark' ? 'night' : 'cream' })))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const abort = new AbortController()
    setRendering(true)
    void (async () => {
      await document.fonts?.ready
      const next = await paginate(book, { size: typo.size, lead: typo.lead, font: typo.font, paper: 'cream' }, { container: root.current!, latin, tocRows: toc.length, signal: abort.signal })
      if (!abort.signal.aborted) { setLayout(next); setRendering(false) }
    })().catch(error => { if (!abort.signal.aborted) { setRendering(false); fail.current(errorText(error)) } })
    return () => abort.abort()
  }, [book, typo.size, typo.lead, typo.font, latin, toc.length])

  useEffect(() => {
    if (!layout || !stage.current || !bookEl.current) return
    if (target && !targetValidated.current) {
      try { resolveBookLocation(layout, target.location); targetValidated.current = true }
      catch (error) { fail.current(errorText(error)); return }
      flashUntil.current = Date.now() + 3500
    }
    let live = true
    const textPages = layout.pages.filter(p => p.kind === 'text').length
    const current = createFlipbook({
      stage: stage.current, book: bookEl.current, count: layout.pages.length,
      page: i => {
        const sheet = renderSheet(i, layout, book, record, typo, latin, toc)
        const page = layout.pages[i], flow = sheet.querySelector<HTMLElement>('.pg-flow')
        if (page.kind === 'text' && flow) {
          paintMarks(flow, page.start, listRef.current.filter(h => h.location.status === 'located' && h.location.chapter === page.chapter))
          if (target && target.location.chapter === page.chapter && (flashUntil.current ?? 0) > Date.now()) {
            const { chapter, from, to } = target.location
            paintMarks(flow, page.start, [{ id: 'reference-location', chapter, from, to, chapterTitle: '', text: '', note: '', color: 'yellow', sourceLine: 0, location: { status: 'located', chapter, from, to } }], 'reference-location')
            flow.querySelectorAll<HTMLElement>('[data-hl="reference-location"]').forEach(mark => { delete mark.dataset.hl; mark.dataset.bookLocation = 'true' })
          }
        }
        return sheet
      },
      blank: () => { const d = document.createElement('div'); d.className = 'sheet'; return d },
      look: { css: loaded.css, root: `font-family:${fontStack(typo.font, latin)}`, paper: [1, 3, 5].map(i => parseInt(paper.pp.slice(i, i + 2), 16) / 255) },
      startPage: position.current ? pageOf(layout, position.current) : layout.firstText + 1,
      selectable: true, onSelect, onMark,
      onBusy: busy => { setTurning(busy); if (busy) closeHighlight() },
      anchorPage: () => position.current ? pageOf(layout, position.current) : layout.firstText + 1,
      onChange: next => {
        if (!live) return
        setView(next)
        const anchoredPage = position.current ? pageOf(layout, position.current) : 0
        // A reference target keeps its exact passage while it stays in view; ordinary reading anchors to the spread start.
        const keepsAnchor = !!target && anchoredPage >= next.a && anchoredPage <= next.b
        if (keepsAnchor && targetPositionPublished.current) return
        const page = [layout.pages[next.a - 1], layout.pages[next.b - 1]].find(p => p?.kind === 'text')
        if (!page) return
        if (!keepsAnchor && position.current?.chapter === page.chapter && position.current.offset === page.start) return
        const pct = layout.pages.slice(0, next.b).filter(p => p.kind === 'text').length / Math.max(1, textPages)
        const at = keepsAnchor && position.current ? position.current : { chapter: page.chapter, offset: page.start }
        const p: LibraryReadingPosition = { bookId: record.id, chapter: at.chapter, offset: at.offset, pct, updatedAt: Date.now() }
        position.current = p
        targetPositionPublished.current = true
        void savePosition(api, p).catch(error => fail.current(`阅读位置保存失败：${errorText(error)}`))
      },
    })
    flip.current = current
    setEngine(current.gl ? 'WebGL 纸张翻页' : 'CSS 翻页')
    root.current?.focus({ preventScroll: true })
    const flashTimer = target && (flashUntil.current ?? 0) > Date.now() ? window.setTimeout(() => {
      flashUntil.current = 0
      current.repaint(layout.pages.flatMap((p, i) => p.kind === 'text' && p.chapter === target.location.chapter ? [i] : []))
    }, flashUntil.current! - Date.now()) : undefined
    return () => { live = false; window.clearTimeout(flashTimer); current.dispose(); flip.current = null }
  }, [api, book, layout, latin, loaded.css, paper.pp, record, toc, typo, listRef, onSelect, onMark, closeHighlight, target])

  useEffect(() => { flip.current?.setSingle(single) }, [single, layout, typo])

  const currentMark = position.current && marks.find(m => layout && pageOf(layout, m) >= (view?.a ?? 0) && pageOf(layout, m) <= (view?.b ?? 0))
  const toggleMark = async () => {
    const at = position.current
    if (!at || markPending.current) return
    markPending.current = true; setMarkBusy(true)
    const bookmarks = currentMark ? marks.filter(m => m.id !== currentMark.id) : [...marks, { id: crypto.randomUUID(), chapter: at.chapter, offset: at.offset, label: book.chapters[at.chapter]?.title || `第 ${view?.a} 页`, createdAt: Date.now() }]
    try { setMarks(confirmed(await api.setBookmarks({ bookId: record.id, bookmarks }))) }
    catch (error) { fail.current(`书签保存失败：${errorText(error)}`) }
    finally { markPending.current = false; setMarkBusy(false) }
  }
  const go = (page: number) => { void flip.current?.gotoPage(page).catch(error => fail.current(errorText(error))) }
  return <div ref={root} className="reader" tabIndex={-1} aria-label="阅读器" data-layout={view?.spread ? 'spread' : 'single'} style={{ '--paper-face': paper.pp, '--paper-edge': paper.pp2 } as React.CSSProperties}
    onKeyDown={e => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target instanceof Element && e.target.closest('input,textarea,select,[contenteditable]'))) return
      if (e.key.toLowerCase() === 't') { e.preventDefault(); e.stopPropagation(); setPanel(p => p === 'toc' ? null : 'toc') }
      if (e.key.toLowerCase() === 'n') { e.preventDefault(); e.stopPropagation(); setPanel(p => p === 'notes' ? null : 'notes'); void annotations.refresh() }
      if (e.key.toLowerCase() === 'b') { e.preventDefault(); e.stopPropagation(); void toggleMark() }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (annotations.lens) closeHighlight(); else if (panel) setPanel(null); else onBack() }
    }}>
    <header className="library-toolbar rd-ui"><div className="rn-float"><button type="button" onClick={onBack}>回到书架</button><b>{record.title}</b></div>
      <div className="rn-float"><button type="button" onClick={() => setPanel(panel === 'toc' ? null : 'toc')}>目录</button><button type="button" disabled={markBusy} onClick={() => void toggleMark()}>{currentMark ? '取下书签' : '夹一张书签'}</button><button type="button" onClick={() => setPanel(panel === 'marks' ? null : 'marks')}>书签 {marks.length}</button><button type="button" onClick={() => { setPanel(panel === 'notes' ? null : 'notes'); void annotations.refresh() }}>笔记 {annotations.state?.highlights.length ?? 0}</button><button type="button" onClick={() => setPanel(panel === 'type' ? null : 'type')}>排版</button></div></header>
    <div ref={stage} className="rd-stage is-in"><div ref={bookEl} className="rd-book" /></div>
    {rendering && <p role="status" className="reading-status">正在排版…</p>}
    <div className="rd-dock rd-ui"><button type="button" disabled={!view || view.atStart} onClick={() => { void flip.current?.prev().catch(error => fail.current(errorText(error))) }}>上一页</button><span>{view?.a ?? 0}{view?.spread ? `–${view.b}` : ''} / {view?.count ?? 0}</span><button type="button" disabled={!view || view.atEnd} onClick={() => { void flip.current?.next().catch(error => fail.current(errorText(error))) }}>下一页</button></div>
    {panel && <aside className="rd-panel" aria-label={panel === 'toc' ? '目录' : panel === 'marks' ? '书签' : panel === 'notes' ? '笔记' : '排版'}><div className="rn-float panel-body">
      <button type="button" onClick={() => setPanel(null)}>关闭面板</button>
      {panel === 'toc' && <div className="rd-toc">{toc.map((t, i) => <button type="button" key={i} onClick={() => { if (layout) go((('anchor' in t && t.anchor ? layout.idPage.get(`${t.chapter}#${t.anchor}`) : undefined) ?? layout.chapterPage[t.chapter]) + 1) }}>{t.label}</button>)}</div>}
      {panel === 'marks' && <div className="rd-toc">{marks.length ? marks.map(m => <button type="button" key={m.id} onClick={() => { if (layout) go(pageOf(layout, m)) }}>{m.label}</button>) : <p>还没有书签，按 B 夹一张。</p>}</div>}
      {panel === 'notes' && <><button type="button" disabled={annotations.busy && annotations.state?.persistence !== 'pending_save'} onClick={() => void annotations.refresh()}>刷新标注</button><NotesList list={annotations.state?.highlights ?? []} onGo={h => { if (layout && h.location.status === 'located') { closeHighlight(); go(pageOf(layout, { chapter: h.location.chapter, offset: h.location.from })) } }} onOpen={(h, el) => onMark(h.id, el)} /></>}
      {panel === 'type' && <div className="rd-set"><label>字号 <input aria-label="字号" type="range" min="13" max="30" value={typo.size} onChange={e => setTypo(t => ({ ...t, size: Number(e.target.value) }))} /></label>
        <label>行距 <input aria-label="行距" type="range" min="1.4" max="2.2" step="0.1" value={typo.lead} onChange={e => setTypo(t => ({ ...t, lead: Number(e.target.value) }))} /></label>
        <div>{(['song', 'hei', 'kai'] as const).map((font, i) => <button type="button" key={font} aria-pressed={typo.font === font} onClick={() => setTypo(t => ({ ...t, font }))}>{['宋体', '黑体', '楷体'][i]}</button>)}</div>
        <div>{(['white', 'cream', 'night'] as const).map((p, i) => <button type="button" key={p} aria-pressed={typo.paper === p} onClick={() => setTypo(t => ({ ...t, paper: p }))}>{['白纸', '米黄', '夜间'][i]}</button>)}</div>
        <button type="button" aria-pressed={!single} onClick={() => setSingle(false)}>双页</button><button type="button" aria-pressed={single} onClick={() => setSingle(true)}>单页</button><p>{engine} · 窄区自动单页</p></div>}
    </div></aside>}
    {annotations.state?.warning && <p role="status" className="rd-highlight-warning">{annotations.state.warning}</p>}
    <MarginNotes root={root} book={bookEl} view={view} list={annotations.state?.highlights ?? []} hidden={turning || !!panel || !!annotations.lens} onOpen={(h, el) => onMark(h.id, el)} />
    {annotations.lens && <HighlightPopover key={annotations.lens.id ?? 'selection'} lens={annotations.lens} highlight={annotations.selected} busy={annotations.busy} onSave={annotations.save} onRemove={annotations.remove} onCopy={annotations.copy} onSource={annotations.openSource} onAsk={annotations.ask} onClose={closeHighlight} />}
  </div>
}
