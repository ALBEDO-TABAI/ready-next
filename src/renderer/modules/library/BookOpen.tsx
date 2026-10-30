import { useLayoutEffect, useRef, useState } from 'react'
import type { LibraryBook } from '../../../shared/library'
import { Cover } from './Book'
import { type ShelfBook, TOPIC } from './topics'

/** Cover and information stay inside the workbench pane, including during flight. */
export function BookOpen({ book, record, origin, onRead, onClose }: {
  book: ShelfBook; record: LibraryBook; origin: HTMLElement; onRead: () => void; onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const target = ref.current!
    const a = origin.getBoundingClientRect(), b = target.getBoundingClientRect()
    const animation = target.animate?.([
      { transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / Math.max(1, b.width)}, ${a.height / Math.max(1, b.height)}) rotateY(85deg)`, opacity: .4 },
      { transform: 'none', opacity: 1 },
    ], { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650, easing: 'cubic-bezier(.42,0,.2,1)' })
    target.focus()
    return () => { animation?.cancel(); if (origin.isConnected) origin.closest('button')?.focus({ preventScroll: true }) }
  }, [origin])
  return <div className="book-dialog" role="dialog" aria-label={`《${book.title}》信息`} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
    <button type="button" className="dialog-close" onClick={onClose}>放回书架</button>
    <div ref={ref} className="open-book" tabIndex={-1} data-open={open}>
      <div className="book-information">
        <p>{TOPIC[book.topic].name} · {record.format.toUpperCase()}</p>
        <h2>{record.title}</h2><p>{record.author}</p>
        <dl><dt>出版社</dt><dd>{record.publisher || '未提供'}</dd><dt>年份</dt><dd>{record.year || '未提供'}</dd><dt>语言</dt><dd>{record.language || '未提供'}</dd><dt>状态</dt><dd>{record.status}</dd><dt>字数</dt><dd>{record.words?.toLocaleString() || '未统计'}</dd></dl>
        <button type="button" onClick={onRead}>开始阅读</button>
      </div>
      <button type="button" className="open-cover" aria-label={open ? '合上封面' : '翻看封面'} onClick={() => setOpen(!open)}><Cover book={book} /></button>
    </div>
  </div>
}
