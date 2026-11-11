import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { LibraryHighlight, LibraryHighlightColor } from '../../../../shared/library'
import { MARKERS, markerColor } from './marks'
import type { HighlightLens } from './useHighlights'
import type { FlipView } from './flipbook.js'

export function HighlightPopover({ lens, highlight, busy, onSave, onRemove, onCopy, onSource, onAsk, onClose }: {
  lens: HighlightLens; highlight?: LibraryHighlight; busy: boolean;
  onSave: (color: LibraryHighlightColor, note?: string) => Promise<void>; onRemove: () => Promise<void>;
  onCopy: (reference: boolean) => Promise<void>; onSource: () => Promise<void>; onAsk: () => Promise<void>; onClose: () => void
}) {
  const [writing, setWriting] = useState(false), [note, setNote] = useState(highlight?.note ?? '')
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState({ x: lens.x, y: lens.y })
  useLayoutEffect(() => {
    const el = ref.current!, root = el.closest('.reader')!.getBoundingClientRect()
    setAt({ x: Math.max(8, Math.min(root.width - el.offsetWidth - 8, lens.x - root.left)), y: Math.max(60, Math.min(root.height - el.offsetHeight - 12, lens.y - root.top + 12)) })
  }, [lens.x, lens.y, writing])
  return <div ref={ref} role="dialog" aria-label="划线" className="rd-highlight-popover rd-ui" style={{ left: at.x, top: at.y }}
    onKeyDown={e => { e.stopPropagation(); if (e.key === 'Escape') onClose() }}>
    <div className="rn-float highlight-tools"><div role="group" aria-label="划线颜色">{MARKERS.map(m => <button type="button" key={m.key} aria-label={m.label} title={m.label} disabled={busy || highlight?.location.status === 'malformed'} aria-pressed={highlight?.color === m.key} style={{ '--marker': m.color } as React.CSSProperties} onClick={() => void onSave(m.key)}>{m.label}</button>)}</div>
      <button type="button" disabled={busy || highlight?.location.status === 'malformed'} onClick={() => setWriting(v => !v)}>{highlight?.note ? '改批注' : '批注'}</button>
      <button type="button" onClick={() => void onCopy(false)}>复制</button>
      <button type="button" disabled={busy} onClick={() => void onAsk()}>问 AI</button>
      {highlight && <><button type="button" onClick={() => void onCopy(true)}>复制引用</button><button type="button" onClick={() => void onSource()}>在来源页中打开</button><button type="button" disabled={busy} onClick={() => void onRemove()}>删除划线</button></>}
      <button type="button" disabled={busy} onClick={onClose}>关闭划线浮层</button>
      {writing && <div className="highlight-write"><textarea aria-label="批注内容" value={note} onChange={e => setNote(e.target.value)} rows={4} autoFocus /><button type="button" disabled={busy} onClick={() => void onSave(highlight?.color ?? 'yellow', note)}>保存批注</button></div>}
      {!writing && highlight?.note && <p>{highlight.note}</p>}
      {highlight && highlight.location.status !== 'located' && <p role="status">{highlight.location.reason}</p>}
    </div>
  </div>
}

export function NotesList({ list, onGo, onOpen }: { list: LibraryHighlight[]; onGo: (h: LibraryHighlight) => void; onOpen: (h: LibraryHighlight, el: HTMLElement) => void }) {
  const groups = new Map<string, LibraryHighlight[]>()
  for (const h of [...list].sort((a, b) => {
    const x = a.location, y = b.location
    return x.status === 'located' && y.status === 'located' ? x.chapter - y.chapter || x.from - y.from : x.status === 'located' ? -1 : 1
  })) {
    const key = h.location.status === 'located' ? `${h.location.chapter + 1} · ${h.chapterTitle}` : '未定位'
    groups.set(key, [...(groups.get(key) ?? []), h])
  }
  if (!list.length) return <p>还没有划线。在书页上拖选文字即可添加。</p>
  return <div className="rd-notes-list">{[...groups].map(([title, items]) => <section key={title}><h3>{title}</h3>{items.map((h, i) => <div key={`${h.id}-${i}`} className="rd-note-item">
    <button type="button" style={{ borderColor: markerColor(h.color) }} onClick={e => h.location.status === 'located' ? onGo(h) : onOpen(h, e.currentTarget)}>{h.text}</button>
    {h.note && <p>{h.note}</p>}{h.location.status !== 'located' && <small>{h.location.reason}</small>}
    <button type="button" aria-label={`编辑划线 ${h.text}`} onClick={e => onOpen(h, e.currentTarget)}>编辑</button>
  </div>)}</section>)}</div>
}

/** Cards stay beside the actual line. Overflow is represented by the complete notes panel. */
export function MarginNotes({ root, book, view, list, hidden, onOpen }: {
  root: RefObject<HTMLDivElement | null>; book: RefObject<HTMLDivElement | null>; view: FlipView | null;
  list: LibraryHighlight[]; hidden: boolean; onOpen: (h: LibraryHighlight, el: HTMLElement) => void
}) {
  const [items, setItems] = useState<{ h: LibraryHighlight; x: number; y: number; width: number }[]>([])
  const cards = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (hidden || !root.current || !book.current || !view) { setItems([]); return }
    const measure = () => {
      const bounds = root.current!.getBoundingClientRect(), next: typeof items = [], seen = new Set<string>()
      for (const page of new Set([view.a - 1, view.b - 1])) {
        const sheet = book.current!.querySelector<HTMLElement>(`.leaf .sheet[data-pi="${page}"]`)
        if (!sheet) continue
        const rect = sheet.getBoundingClientRect(), right = !view.spread || page % 2 === 0
        const width = Math.min(230, (right ? bounds.right - rect.right : rect.left - bounds.left) - 32)
        if (width < 150) continue
        for (const h of list) {
          if (!h.note || h.location.status !== 'located' || seen.has(h.id)) continue
          const mark = [...sheet.querySelectorAll<HTMLElement>('mark[data-hl]')].find(el => el.dataset.hl === h.id)
          if (!mark) continue
          const line = mark.getClientRects()[0] ?? mark.getBoundingClientRect()
          seen.add(h.id)
          next.push({ h, x: (right ? rect.right + 16 : rect.left - width - 16) - bounds.left, y: line.top - bounds.top, width })
        }
      }
      setItems(next)
    }
    measure()
    const observer = new ResizeObserver(measure); observer.observe(root.current)
    const timer = setTimeout(measure, 780)
    return () => { observer.disconnect(); clearTimeout(timer) }
  // Geometry is recalculated after turns, resizing, notes and typography's resulting view change.
  }, [root, book, view, list, hidden])
  useLayoutEffect(() => {
    const floors = new Map<string, number>(), height = root.current?.clientHeight ?? 0
    for (const card of cards.current?.querySelectorAll<HTMLElement>('button') ?? []) {
      const side = card.style.left, top = parseFloat(card.style.top), bottom = top + card.offsetHeight
      const fits = top >= Math.max(70, floors.get(side) ?? 0) && bottom <= height - 80
      card.hidden = !fits
      if (fits) floors.set(side, bottom + 12)
    }
  }, [items, root])
  return <div ref={cards} aria-label="页边批注" className="rd-margin-notes">{items.map(it => <button key={it.h.id} type="button" style={{ left: it.x, top: it.y, width: it.width, borderColor: markerColor(it.h.color) }} onClick={e => onOpen(it.h, e.currentTarget)}>{it.h.note}</button>)}</div>
}
