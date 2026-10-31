import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { LibraryBook, LibraryHighlightColor, LibraryHighlightState } from '../../../../shared/library'
import { useDocTabs } from '../../../stores/useDocTabs'
import { confirmed, type LibraryAPI } from '../access'
import type { LoadedBook } from './book'
import type { Layout } from './paginate'
import type { createFlipbook } from './flipbook.js'
import { anchorOf } from './marks'
import { addBookLocationToAgentInput } from '../../agent/chat-input-bridge'

export type HighlightLens = { x: number; y: number } & ({ id: string; draft?: never } | { id?: never; draft: NonNullable<ReturnType<typeof anchorOf>> })
export function useHighlights({ record, api, book, layout, flip, onError }: {
  record: LibraryBook; api: LibraryAPI; book: LoadedBook; layout: Layout | null;
  flip: RefObject<ReturnType<typeof createFlipbook> | null>; onError: (message: string) => void
}) {
  const context = useMemo(() => ({ bookId: record.id, chapters: book.chapters.map(c => {
    const template = document.createElement('template'); template.innerHTML = c.html
    return { title: c.title, text: template.content.textContent ?? '' }
  }) }), [record.id, book])
  const [state, setState] = useState<LibraryHighlightState | null>(null)
  const [lens, setLens] = useState<HighlightLens | null>(null)
  const [busy, setBusy] = useState(false)
  const pendingDiskVersion = useRef<string | null>(null)
  const pending = useRef(false), live = useRef(true), request = useRef(0)
  const fail = useRef(onError); fail.current = onError
  const listRef = useRef(state?.highlights ?? []); listRef.current = state?.highlights ?? []
  const close = useCallback(() => { setLens(null); window.getSelection()?.removeAllRanges(); flip.current?.selecting(false) }, [flip])
  const refresh = useCallback(async () => {
    if (pending.current) return
    const sequence = ++request.current
    try {
      const result = confirmed(await api.listHighlights(context))
      if (live.current && sequence === request.current && pendingDiskVersion.current !== result.version) { pendingDiskVersion.current = null; setState(result) }
    } catch (error) { if (live.current && sequence === request.current) fail.current(String(error)) }
  }, [api, context])
  useEffect(() => {
    live.current = true
    void refresh()
    const focus = () => { void refresh() }
    window.addEventListener('focus', focus)
    const stop = api.onChanged(focus)
    return () => { live.current = false; stop(); window.removeEventListener('focus', focus) }
  }, [api, refresh])
  useEffect(() => {
    if (layout) flip.current?.repaint(layout.pages.flatMap((p, i) => p.kind === 'text' ? [i] : []))
  }, [state, layout, flip])
  const onSelect = useCallback((selection: Selection, event: PointerEvent) => {
    if (!layout) return
    const draft = anchorOf(selection, layout)
    if (!draft) { close(); return }
    setLens({ draft, x: event.clientX, y: event.clientY })
  }, [layout, close])
  const onMark = useCallback((id: string, el: HTMLElement) => {
    const box = el.getBoundingClientRect()
    flip.current?.selecting(true)
    setLens({ id, x: box.left, y: box.bottom })
  }, [flip])
  const mutate = async (work: (version: string) => ReturnType<LibraryAPI['createHighlight']>) => {
    if (!state || pending.current || state.persistence === 'pending_save') return
    pending.current = true; setBusy(true); request.current++
    try {
      const result = confirmed(await work(state.version))
      if (live.current) { pendingDiskVersion.current = result.persistence === 'pending_save' ? state.version : null; setState(result); close() }
    } catch (error) { if (live.current) fail.current(String(error)) }
    finally { pending.current = false; if (live.current) setBusy(false) }
  }
  const save = (color: LibraryHighlightColor, note?: string) => mutate(version => {
    if (!lens) throw new Error('没有选中的文字')
    return lens.id
      ? api.updateHighlight({ ...context, expectedVersion: version, id: lens.id, patch: { color, ...(note !== undefined ? { note } : {}) } })
      : api.createHighlight({ ...context, expectedVersion: version, chapter: lens.draft!.chapter, from: lens.draft!.from, to: lens.draft!.to, color, note })
  })
  const remove = () => mutate(version => {
    if (!lens?.id) throw new Error('没有选中的划线')
    return api.removeHighlight({ ...context, expectedVersion: version, id: lens.id })
  })
  const selected = state?.highlights.find(h => h.id === lens?.id)
  const copy = async (reference: boolean) => {
    try {
      const name = (state?.sourcePath ?? record.notePath).split(/[\\/]/).pop()!.replace(/\.md$/i, '')
      const text = reference && selected ? `![[${name}#^${selected.id}]]` : `${selected?.text ?? lens?.draft?.text ?? ''}\n——${record.author}《${record.title}》`
      await navigator.clipboard.writeText(text)
      if (live.current) close()
    } catch (error) { fail.current(`复制失败：${String(error)}`) }
  }
  // Sends the passage to the AI chat as a book location (read-only; the reader's location counting is kept).
  const ask = async () => {
    try {
      const located = selected?.location.status === 'located' ? selected.location : null
      const location = located ? { chapter: located.chapter, from: located.from, to: located.to }
        : lens?.draft ? { chapter: lens.draft.chapter, from: lens.draft.from, to: lens.draft.to } : null
      if (!location) throw new Error('请先选中一段文字')
      await addBookLocationToAgentInput(record.id, location, record.title, selected?.text ?? lens?.draft?.text)
      if (live.current) close()
    } catch (error) { fail.current(error instanceof Error ? error.message : String(error)) }
  }
  const openSource = async () => {
    if (!selected) return
    try {
      // Re-read the source to get its current name and line after external edits.
      const latest = confirmed(await api.listHighlights(context))
      const h = latest.highlights.find(h => h.id === selected.id)
      if (!h) throw new Error('这条划线已从来源页删除')
      if (!live.current) return
      const tabs = useDocTabs.getState()
      tabs.openTab(latest.sourcePath)
      tabs.setPendingReveal({ path: latest.sourcePath, lineStart: h.sourceLine, selection: h.text, requestedAt: Date.now() })
      close()
    } catch (error) { fail.current(String(error)) }
  }
  return { state, listRef, lens, selected, busy: busy || !state || state.persistence === 'pending_save', onSelect, onMark, close, save, remove, copy, ask, openSource, refresh }
}
