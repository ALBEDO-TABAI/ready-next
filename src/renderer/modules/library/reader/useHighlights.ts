import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { LibraryBook, LibraryHighlightColor, LibraryHighlightState } from '../../../../shared/library'
import type { ReadyRef } from '../../../../shared/ready-ref'
import { confirmed, type LibraryAPI } from '../access'
import type { LoadedBook } from './book'
import type { Layout } from './paginate'
import type { createFlipbook } from './flipbook.js'
import { anchorOf, MARKERS } from './marks'
import { addBookLocationToAgentInput } from '../../agent/chat-input-bridge'
import type { CaptureSelection } from '../../workbench/capture'
import { announceHighlight } from '../../workbench/capture-receipt'

const MARKER_DEFAULT = MARKERS[0].key
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
  // The toast's 撤销 runs after later renders; it must see the latest version, not the one of its own render.
  const stateRef = useRef(state); stateRef.current = state
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
    } catch (error) { console.warn('[useHighlights] read highlights failed:', error instanceof Error ? error.message : String(error)); if (live.current && sequence === request.current) fail.current(String(error)) }
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
  const mutate = async (work: (version: string) => ReturnType<LibraryAPI['createHighlight']>): Promise<LibraryHighlightState | undefined> => {
    const current = stateRef.current
    if (!current || pending.current || current.persistence === 'pending_save') return
    pending.current = true; setBusy(true); request.current++
    try {
      const result = confirmed(await work(current.version))
      if (live.current) { pendingDiskVersion.current = result.persistence === 'pending_save' ? current.version : null; setState(result); close() }
      return result
    } catch (error) { console.warn('[useHighlights] save highlight change failed:', error instanceof Error ? error.message : String(error)); if (live.current) fail.current(String(error)); return undefined }
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
  // The shared selection bar's 划线: the first marker, then the reading scenes' toast; a book highlight can be removed.
  const mark = async () => {
    const before = new Set(stateRef.current?.highlights.map(h => h.id))
    const result = await save(MARKER_DEFAULT)
    const created = result?.highlights.find(h => !before.has(h.id))
    if (!result || !created) return
    announceHighlight(result, created.text, async () => {
      if (!await mutate(version => api.removeHighlight({ ...context, expectedVersion: version, id: created.id }))) throw new Error('划线没有删除')
    })
  }
  /** The passage (a selection or a highlight) as a capture: the book location, as 书 and 划线 are referred to. */
  const capture = (): CaptureSelection | null => {
    const at = selected?.location.status === 'located' ? selected.location : lens?.draft
    const text = selected?.text ?? lens?.draft?.text
    if (!at || !text) return null
    const chapter = selected?.chapterTitle || book.chapters[at.chapter]?.title
    return { ref: { kind: 'book-location', book: record.id, loc: `c${at.chapter}:${at.from}+${at.to - at.from}` }, title: chapter ? `${record.title} · ${chapter}` : record.title, text }
  }
  /** A highlight in its source page (the book's note), as ⌘K refers to it. */
  const sourceRef: ReadyRef | null = selected ? { kind: 'page', id: record.id, anchor: `^${selected.id}` } : null
  const copy = async (reference: boolean) => {
    try {
      const name = (state?.sourcePath ?? record.notePath).split(/[\\/]/).pop()!.replace(/\.md$/i, '')
      const text = reference && selected ? `![[${name}#^${selected.id}]]` : `${selected?.text ?? lens?.draft?.text ?? ''}\n——${record.author}《${record.title}》`
      await navigator.clipboard.writeText(text)
      if (live.current) close()
    } catch (error) { console.warn('[useHighlights] copy highlight failed:', error instanceof Error ? error.message : String(error)); fail.current(`复制失败：${String(error)}`) }
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
    } catch (error) { console.warn('[useHighlights] attach book location failed:', error instanceof Error ? error.message : String(error)); fail.current(error instanceof Error ? error.message : String(error)) }
  }
  return { state, listRef, lens, selected, busy: busy || !state || state.persistence === 'pending_save', onSelect, onMark, close, save, remove, copy, ask, mark, capture, sourceRef, refresh }
}
