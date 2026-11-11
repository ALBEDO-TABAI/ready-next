import { useEffect, useState } from 'react'
import { useDocTabs } from '../../stores/useDocTabs'
import { confirmed, getLibraryAPI } from '../../modules/library/access'
import { markerColor } from '../../modules/library/reader/marks'
import { openReadyRef } from '../../modules/workbench/open-ready-ref'
import { parseQuoteEmbed, readQuoteCard } from './library-quote'

type Card = NonNullable<ReturnType<typeof readQuoteCard>>
type State = { status: 'loading' } | { status: 'ready'; card: Card } | { status: 'invalid'; reason: string }
export function LibraryQuoteCard({ raw }: { raw: string }) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true, sequence = 0
    const refresh = async () => {
      const request = ++sequence
      try {
        const embed = parseQuoteEmbed(raw)
        if (!embed) throw new Error('引用格式无效')
        const library = confirmed(await getLibraryAPI().get())
        const name = embed.page.replace(/\\/g, '/').replace(/\.md$/i, '')
        const books = library.status === 'ready' ? library.books.filter(b => {
          const path = b.notePath.replace(/\\/g, '/').replace(/\.md$/i, '')
          return path === name || path.endsWith(`/${name}`)
        }) : []
        if (books.length !== 1) throw new Error(books.length ? '来源页名称不唯一' : '来源页已删除或不存在')
        const book = books[0]
        const disk = await window.electronAPI.document.readFile(book.notePath)
        if (!disk.success || typeof disk.content !== 'string') throw new Error(disk.error || '无法读取来源页')
        const dirty = useDocTabs.getState().tabs.find(t => t.path === book.notePath && t.isDirty)
        const card = readQuoteCard(dirty?.content ?? disk.content, book.id, book.title, embed.id)
        if (!card) throw new Error('引用块已删除或格式已修改')
        if (live && request === sequence) setState({ status: 'ready', card })
      } catch (cause) {
        console.warn('[LibraryQuoteCard] read quote source failed:', cause instanceof Error ? cause.message : String(cause))
        if (live && request === sequence) setState({ status: 'invalid', reason: cause instanceof Error ? cause.message : String(cause) })
      }
    }
    const update = () => { void refresh() }
    update()
    const api = window.electronAPI
    const stops = [api?.library?.onChanged(update), api?.document?.onDirectoryChange?.(update), api?.document?.onIndexChanged?.(update),
      useDocTabs.subscribe((next, previous) => { if (next.tabs !== previous.tabs) update() })]
    window.addEventListener('focus', update)
    return () => { live = false; sequence++; stops.forEach(stop => stop?.()); window.removeEventListener('focus', update) }
  }, [raw])
  return <figure className="glass-surface-card" data-library-quote="true" style={{ padding: '20px 24px', margin: '16px 0', borderRadius: 18, border: '1px solid var(--border-subtle)', background: 'var(--surface-card-bg)' }}>
    {state.status === 'ready' ? <>
      <figcaption style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span aria-label={`${state.card.color}标记`} style={{ width: 8, height: 24, borderRadius: 4, background: markerColor(state.card.color) }} /><strong>{state.card.title}</strong><span>{state.card.author}</span></figcaption>
      <p className="note-preview-embed-caption">{state.card.chapter}</p>
      <blockquote className="note-preview-markdown-quote" style={{ whiteSpace: 'pre-wrap' }}>{state.card.text}</blockquote>
      {state.card.note && <p style={{ whiteSpace: 'pre-wrap' }}>{state.card.note}</p>}
      <button type="button" className="note-preview-chip" onClick={() => { setError(''); void openReadyRef(state.card.uri, 'document').catch(cause => setError(String(cause))) }}>回到原文</button>
    </> : <><strong>{state.status === 'loading' ? '正在读取引用…' : '引用已失效'}</strong><p>{raw}</p>{state.status === 'invalid' && <small>{state.reason}</small>}</>}
    {error && <p role="alert">{error}</p>}
  </figure>
}
