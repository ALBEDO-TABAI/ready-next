import { useLayoutEffect, useRef, useState } from 'react'
import type { LibraryBook } from '../../../shared/library'
import { Button } from '../../components/ui'
import { Cover } from './Book'
import { hash, lookOf, type ShelfBook, TOPIC } from './topics'

/** Cover and information stay inside the workbench pane, including during flight. Opened, the cover lies to the left
 *  with its inside up (a bookplate), so the first spread is two pages. */
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
  const topic = TOPIC[book.topic]
  const plate = String((hash(book.id) % 900) + 100).padStart(3, '0')
  const shelved = record.addedAt ? new Date(record.addedAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) : ''
  return <div className="book-dialog" role="dialog" aria-label={`《${book.title}》信息`} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
    <Button variant="ghost" className="dialog-close" onClick={onClose}>放回书架</Button>
    <div ref={ref} className="open-book" tabIndex={-1} data-open={open}>
      <div className="book-information">
        <p>{TOPIC[book.topic].name} · {record.format.toUpperCase()}</p>
        <h2>{record.title}</h2><p>{record.author}</p>
        <dl><dt>出版社</dt><dd>{record.publisher || '未提供'}</dd><dt>年份</dt><dd>{record.year || '未提供'}</dd><dt>语言</dt><dd>{record.language || '未提供'}</dd><dt>状态</dt><dd>{record.status}</dd><dt>字数</dt><dd>{record.words?.toLocaleString() || '未统计'}</dd></dl>
        <Button variant="primary" onClick={onRead}>开始阅读</Button>
      </div>
      <button type="button" className="open-cover" aria-label={open ? '合上封面' : '翻看封面'} onClick={() => setOpen(!open)}
        style={{ ['--cloth' as string]: lookOf(book).color, ['--cloth-2' as string]: topic.shades[3] }}>
        <div className="open-cover__face is-front"><Cover book={book} /></div>
        <div className="open-cover__face is-inside" aria-hidden="true">
          <div className="ex-libris">
            <span className="ex-no">EX LIBRIS · Nº {plate}</span>
            <span className="ex-mark"><i /><i /><i /><b /></span>
            <span className="ex-head">Ready 藏书</span>
            <span className="ex-name">{topic.name}<em> · {topic.en}</em></span>
            <span className="ex-rule" />
            {shelved && <span className="ex-meta">{shelved} 上架</span>}
          </div>
        </div>
      </button>
    </div>
  </div>
}
