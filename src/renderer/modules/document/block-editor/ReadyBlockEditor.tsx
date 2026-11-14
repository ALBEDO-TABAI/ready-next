import { readReadyRefTransfer, READY_REF_MIME } from '../../../../shared/ready-ref'
import { dropDocumentReference } from '../../workbench/capture'
import { getGeneratedImageDragPayload } from '../../image-generation/generatedImageDrag'
import { blockWithMarker } from '../../../../shared/document-anchors'
import { AnnotationWorkspace } from '../annotations/AnnotationWorkspace'
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, useId, type CSSProperties, type ReactNode } from 'react'
import { useDocTabs } from '../../../stores/useDocTabs'
import {
  createBlockCommand, createRangeEdit, parseDocumentBlocks, parseInlineBlock, replaceRanges,
  type DocumentBlock,
} from '../../../../shared/document-blocks'
import { getTabBuffer } from './tab-buffer'
import type { EditorBuffer } from './editor-buffer'
import { emptyBlock, inlineMarkdown, newline, plainModel, quoteOf, unquote } from './editing'
import { getCaret, plainText, setCaret } from './dom-inline'
import { BlockIdentity } from './block-identity'
import { RichBlock } from './RichBlock'
import { BlockControls, BlockShell, ItemMarker } from './BlockControls'
import { TableBlock } from './TableBlock'
import { parseTable } from './table-model'
import { calloutView } from './CalloutBlock'
import { calloutLabel } from '../callouts'
import { EditorTools } from './EditorTools'
import { isNonContentBlock } from './catalog'
import { duplicatePageHeading } from '../page-ui/page-title'
import { textAreaContent } from './text-edit'
import type { EditorLinkBase } from './references'
import { useInLibrary } from '../page-ui/library-membership'
import { Button } from '../../../components/ui'

function SourceBlock({ block, buffer, children, report }: { block: DocumentBlock; buffer: EditorBuffer; children: ReactNode; report(error: unknown): void }) {
  const [draft, setDraft] = useState<{ block: DocumentBlock; version: number; text: string } | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const commit = () => {
    if (!draft) return
    // Textarea uses LF internally; its initial value is display-only. A no-op
    // must retain the original CRLF bytes.
    if (draft.text !== draft.block.raw.replace(/\r\n?/g, '\n')) {
      buffer.apply(createBlockCommand({ ...buffer.snapshot, version: draft.version }, {
        type: 'replace', mode: 'source', block: draft.text ? draft.block : blockWithMarker(buffer.snapshot.content, draft.block), markdown: textAreaContent(draft.block.raw, draft.text),
      }))
    }
    setDraft(null)
  }
  const commitRef = useRef(commit); commitRef.current = commit
  useLayoutEffect(() => {
    const flush = () => commitRef.current()
    buffer.flushers.add(flush); return () => { buffer.flushers.delete(flush) }
  }, [buffer])
  useLayoutEffect(() => { if (draft) textarea.current?.focus() }, [draft !== null]) // eslint-disable-line react-hooks/exhaustive-deps
  const root = useRef<HTMLDivElement>(null)
  // Markdown renders task boxes disabled; in the page they are the block's own checkboxes.
  useLayoutEffect(() => { root.current?.querySelectorAll<HTMLInputElement>('input[type="checkbox"][disabled]').forEach(box => { if (!box.closest('[data-own-drops]')) box.disabled = false }) })
  const open = () => setDraft({ block, version: buffer.snapshot.version, text: block.raw.replace(/\r\n?/g, '\n') })
  /** The nth rendered task box is the nth task marker in this block's source. */
  const toggleTask = (box: HTMLInputElement) => {
    const boxes = [...root.current!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter(item => !item.closest('[data-own-drops]'))
    const marks = [...block.raw.matchAll(/^([ \t>]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])\]/gm)]
    const mark = marks[boxes.indexOf(box)]
    if (!mark || marks.length !== boxes.length) throw new Error('这个勾选框对不上源码里的位置，请用“编辑源码”修改')
    buffer.flush()
    const at = block.start + mark.index + mark[1].length
    buffer.apply(createRangeEdit(buffer.snapshot, [{ start: at, end: at + 1, expectedText: mark[2], replacement: mark[2] === ' ' ? 'x' : ' ' }], { anchor: at, focus: at }), 'edit')
  }
  // What a pointer gesture inside the rendered block already means: its own controls, links, embedded views and players.
  const busy = (target: EventTarget | null) => !(target instanceof Element) || !!target.closest('button, a, input, textarea, select, summary, iframe, video, audio, [contenteditable], [data-own-drops], .note-preview-edit-editor')
  return <div ref={root} className="ready-block-source" data-block-type={block.type} data-editing={draft ? true : undefined}
    onClickCapture={event => {
      if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'checkbox' || event.target.closest('[data-own-drops]')) return
      event.preventDefault(); event.stopPropagation()
      try { toggleTask(event.target) } catch (error) { console.warn('[ReadyBlockEditor] toggle rendered task failed:', error instanceof Error ? error.message : String(error)); report(error) }
    }}
    onDoubleClick={event => { if (!draft && !busy(event.target)) { event.preventDefault(); window.getSelection()?.removeAllRanges(); open() } }}>
    {children}
    {draft ? <div className="note-preview-edit-editor">
      <textarea ref={textarea} aria-label="块源码" value={draft.text} spellCheck={false} rows={Math.min(24, Math.max(2, draft.text.split('\n').length))}
        onChange={event => setDraft({ ...draft, text: event.target.value })}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); setDraft(null) }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); try { commit() } catch (error) { console.warn('[ReadyBlockEditor] commit block source with shortcut failed:', error instanceof Error ? error.message : String(error)); report(error) } }
        }} />
      <div className="note-preview-edit-editor__actions">
        <span className="note-preview-edit-editor__hint">⌘↵ 完成 · Esc 取消</span>
        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>取消</Button>
        <Button size="sm" variant="primary" onClick={() => { try { commit() } catch (error) { console.warn('[ReadyBlockEditor] commit block source failed:', error instanceof Error ? error.message : String(error)); report(error) } }}>完成</Button>
      </div>
    </div> : <button type="button" className="ready-block-source-edit" title="也可以双击这一块" onClick={open}>
      {block.capability === 'readonly' ? '编辑这段源码' : '编辑源码'}
    </button>}
  </div>
}

// An embedded view that handles drops inside itself (a database board, calendar or timeline moving its own rows)
// marks its root with data-own-drops; the page leaves those drops alone instead of inserting a reference.
const ownsDrops = (target: EventTarget | null) => target instanceof Element && !!target.closest('[data-own-drops]')

export function ReadyBlockEditor({ tabId, content: displayedContent, pageTitle, renderSource }: { tabId: string; content?: string; pageTitle?: string; renderSource(block: DocumentBlock): ReactNode }) {
  // A retained hidden DocumentMode supplies its frozen snapshot. Do not bypass it.
  const content = useDocTabs(state => displayedContent ?? state.tabs.find(tab => tab.id === tabId)?.content ?? '')
  const path = useDocTabs(state => state.tabs.find(tab => tab.id === tabId)?.path ?? null)
  // Sub-pages are a library feature: a file in a mounted folder has no parent for them (W3 M4).
  const inLibrary = useInLibrary(path)
  const linkBase = useMemo(() => ({ filePath: path, parentPath: inLibrary ? path : null }), [inLibrary, path])
  const buffer = useMemo(() => getTabBuffer(tabId), [tabId])
  return <BufferedBlockEditor pageTitle={pageTitle} buffer={buffer} linkBase={linkBase} content={content} renderSource={renderSource} />
}

/** Both document tabs and canvas cards render this exact editor. */
export function BufferedBlockEditor({ buffer, linkBase, content: displayedContent, pageTitle, renderSource, startTyping }: {
  pageTitle?: string; buffer: EditorBuffer; linkBase?: EditorLinkBase; content?: string; renderSource(block: DocumentBlock): ReactNode
  /** Opening the editor places the caret: in a new paragraph when it is empty, otherwise at the end (text cards). */
  startTyping?: boolean
}) {
  const content = useSyncExternalStore(buffer.subscribe, () => displayedContent ?? buffer.snapshot.content)
  const writeError = useSyncExternalStore(buffer.subscribe, () => buffer.error)
  const instanceId = useId()
  const editorId = buffer.owner.kind === 'document' ? buffer.owner.tabId : instanceId
  const parsed = useMemo(() => parseDocumentBlocks(content), [content])
  const hiddenHeading = useMemo(() => duplicatePageHeading(parsed, pageTitle), [parsed, pageTitle])
  const identities = useRef(new BlockIdentity())
  const keys = useMemo(() => identities.current.resolve(parsed), [parsed])
  const [error, setError] = useState('')
  const [emptyAt, setEmptyAt] = useState<number | null>(null)
  const [appendPrefix, setAppendPrefix] = useState('')
  // The callout (by its start) that the empty paragraph at emptyAt belongs to: a title-only callout getting its first body line.
  const [emptyIn, setEmptyIn] = useState<number | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ at: number; textOffset?: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const movingOwnBlock = useRef(false)
  const dropLine = useRef<{ el: HTMLElement; placement: 'before' | 'after' } | null>(null)
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), [])
  const focus = (at: number, empty = false, textOffset?: number) => { setAppendPrefix(''); setEmptyIn(null); setEmptyAt(empty ? at : null); setFocusRequest({ at, textOffset }) }
  function travel(direction: 'undo' | 'redo') {
    // Undoing back to an empty text keeps the caret in an empty paragraph instead of leaving nothing to type into.
    try { const selection = buffer.travel(direction); if (selection) focus(selection.focus, !buffer.snapshot.content.length); setError('') } catch (cause) { console.warn('[ReadyBlockEditor] travel edit history failed:', cause instanceof Error ? cause.message : String(cause)); report(cause) }
  }
  useLayoutEffect(() => {
    // Native Edit-menu commands arrive as beforeinput, without a keydown.
    // React's before-input plugin does not forward these history input types.
    const editor = root.current!
    const beforeInput = (event: InputEvent) => {
      if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return
      event.preventDefault(); event.stopPropagation()
      travel(event.inputType === 'historyUndo' ? 'undo' : 'redo')
    }
    editor.addEventListener('beforeinput', beforeInput)
    return () => editor.removeEventListener('beforeinput', beforeInput)
  })
  const started = useRef(false)
  useLayoutEffect(() => {
    if (!startTyping || started.current) return
    started.current = true
    const end = buffer.snapshot.content.length
    if (end) setFocusRequest({ at: end })
    else { setAppendPrefix(''); setEmptyIn(null); setEmptyAt(0); setFocusRequest({ at: 0 }) }
  }, [startTyping, buffer])
  useLayoutEffect(() => {
    if (!focusRequest) return
    const elements = [...root.current!.querySelectorAll<HTMLElement>('[data-rich-start]')]
    const el = elements.filter(item => Number(item.dataset.richStart) <= focusRequest.at).at(-1) ?? elements[0]
    if (el) { el.focus(); setCaret(el, focusRequest.textOffset ?? Math.max(0, focusRequest.at - Number(el.dataset.richStart))) }
    setFocusRequest(null)
  }, [content, focusRequest])
  function merge(block: DocumentBlock) {
    const current = parseDocumentBlocks(buffer.snapshot.content)
    const live = current.blocks.find(item => item.start === block.start && item.type === block.type)
    if (!live) return
    const parent = current.blocks.find(item => item.id === live.parentId)
    const unit = parent && ['listItem', 'taskItem'].includes(parent.type) ? parent : live
    const siblings = current.blocks.filter(item => item.parentId === unit.parentId)
    const previous = siblings[siblings.indexOf(unit) - 1]
    if (!previous || previous.start === hiddenHeading?.start || previous.capability !== 'rich') return
    const previousText = previous.children.filter((part): part is DocumentBlock => part.kind === 'block').at(-1) ?? previous
    const before = parseInlineBlock(previousText.raw), right = parseInlineBlock(live.raw)
    if (before.capability !== 'rich' || right.capability !== 'rich') return
    const joined = previous.raw.slice(0, previousText.start - previous.start)
      + inlineMarkdown(before, [...before.spans, ...right.spans]) + unit.raw.slice(live.end - unit.start)
    const validated = createBlockCommand(buffer.snapshot, { type: 'merge', first: previous, second: unit, separator: '' })
    replaceRanges(buffer.snapshot.content, validated.operation, buffer.snapshot.version)
    const at = previousText.start + plainText(before.spans).length
    buffer.apply(createRangeEdit(buffer.snapshot, [{ start: previous.start, end: unit.end,
      expectedText: buffer.snapshot.content.slice(previous.start, unit.end), replacement: joined }],
    { anchor: live.start, focus: live.start }, { anchor: at, focus: at }))
    focus(at, false, plainText(before.spans).length)
  }
  function navigate(el: HTMLElement, direction: 'up' | 'down') {
    const items = [...root.current!.querySelectorAll<HTMLElement>('[data-rich-start]')]
    const next = items[items.indexOf(el) + (direction === 'up' ? -1 : 1)]
    if (!next) return
    const offset = getCaret(el).start
    next.focus(); setCaret(next, Math.min(offset, next.textContent?.length ?? 0))
  }
  function renderBlock(block: DocumentBlock, fallbackKey: string, continuation = ''): ReactNode {
    if (isNonContentBlock(block)) return null
    // Keep a textless anchor in source order: duplicate heading ordinals and old
    // scroll positions must not shift when the title disappears visually.
    if (block === hiddenHeading) return <span key={block.id} aria-hidden data-ready-hidden-title style={{ display: 'block', height: 0 }} data-ready-heading-title={pageTitle?.trim()}
      data-block-start={block.start} data-ready-block-source-line={content.slice(0, block.start).split(/\r\n|\n|\r/).length} />
    const key = keys.get(block.id) ?? fallbackKey
    const children = block.children.filter((part): part is DocumentBlock => part.kind === 'block')
    if (extra?.parentId === block.id) { children.push(extra); children.sort((a, b) => a.start - b.start) }
    const line = content.slice(0, block.start).split(/\r\n|\n|\r/).length
    const parent = parsed.blocks.find(item => item.id === block.parentId)
    const actionable = block.type !== 'frontmatter' && block.type !== 'column' && !isNonContentBlock(block) && (!block.parentId || parent?.type === 'column')
    const shell = (body: ReactNode) => <BlockShell key={key} block={block} line={line} actionable={actionable}>{body}</BlockShell>
    if (block.type === 'callout') {
      // Its title and body edit in place; a folded callout or an unusual header stays a source block.
      const view = calloutView(block, content)
      if (!view) return shell(<SourceBlock block={block} buffer={buffer} report={report}>{renderSource(block)}</SourceBlock>)
      const quote = quoteOf(block.raw, '> ')
      const body = [...(view.lead ? [view.lead] : []), ...view.rest, ...(extra?.parentId === block.id ? [extra] : [])]
      return shell(<aside className="ready-callout" data-callout={view.type} data-callout-color={view.color}>
        {/* Enter in the title goes to the body (a title is one line); a title-only callout gets its first body line. */}
        <div className="ready-callout-title" data-callout-title style={{ '--callout-placeholder': JSON.stringify(calloutLabel(view.type)) } as CSSProperties}
          onKeyDownCapture={event => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.keyCode === 229) return
            event.preventDefault(); event.stopPropagation()
            const first = root.current?.querySelector<HTMLElement>(`[data-block-start="${block.start}"] .ready-callout-body [data-rich-start]`)
            if (first) { first.focus(); setCaret(first, 0); return }
            try {
              buffer.flush()
              const live = parseDocumentBlocks(buffer.snapshot.content).blocks.find(item => item.type === 'callout' && item.start === block.start)
              if (!live) return
              setAppendPrefix(newline(buffer.snapshot.content)); setEmptyIn(live.start); setEmptyAt(live.end); setFocusRequest({ at: live.end })
            } catch (cause) { console.warn('[ReadyBlockEditor] add callout body failed:', cause instanceof Error ? cause.message : String(cause)); report(cause) }
          }}>
          <RichBlock block={view.title} model={view.titleModel} buffer={buffer} continuation={quote} focus={(at, _empty, textOffset) => focus(at, false, textOffset)}
            merge={() => {}} report={report} navigate={navigate} />
        </div>
        {body.length > 0 && <div className="ready-callout-body">{body.map((child, index) => renderBlock(child, `${key}/${index}`, quote))}</div>}
      </aside>)
    }
    if (['columns', 'column', 'list', 'listItem', 'taskItem', 'blockquote'].includes(block.type)) {
      const isList = block.type === 'listItem' || block.type === 'taskItem'
      const prefix = isList ? /^(?:\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/.exec(block.raw)?.[0] ?? ''
        : block.type === 'blockquote' ? '> ' : continuation
      const body = children.length ? children.map((child, index) => renderBlock(child, `${key}/${index}`, prefix))
        : renderBlock(emptyBlock(block.end, block.id), `${key}/empty`, prefix)
      if (block.type === 'columns') return shell(<div data-ready-columns style={{ display: 'grid', gridTemplateColumns: block.widths?.map(width => `minmax(0, ${width}fr)`).join(' '), gap: 24 }}>{body}</div>)
      if (block.type === 'list') return shell(<div role="list">{body}</div>)
      const quote = prefix === '> ', task = block.type === 'taskItem', checked = task && /\[[xX]\]/.test(prefix)
      return shell(<div role={isList ? 'listitem' : undefined} className={`ready-block-container${isList || quote ? ' is-indented' : ''}${quote ? ' is-quote' : ''}`}
        data-checked={task ? checked : undefined}>
        {isList && <ItemMarker block={block} kind={task ? 'task' : /^\s*\d/.test(prefix) ? 'number' : 'bullet'} text={task ? '' : /^\s*\d/.test(prefix) ? prefix.trim() : '•'}
          checked={checked} label={task ? `${checked ? '已完成' : '未完成'}：${block.raw.slice(prefix.length).split(/\r\n|\n|\r/, 1)[0]}` : undefined}
          onToggle={() => {
            try {
              buffer.flush()
              const mark = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/.exec(block.raw)
              if (!mark) return
              const at = block.start + mark[1].length
              buffer.apply(createRangeEdit(buffer.snapshot, [{ start: at, end: at + 1, expectedText: mark[2], replacement: mark[2] === ' ' ? 'x' : ' ' }], { anchor: at, focus: at }), 'edit')
            } catch (cause) { console.warn('[ReadyBlockEditor] toggle task failed:', cause instanceof Error ? cause.message : String(cause)); report(cause) }
          }} />}{body}
      </div>)
    }
    // Inside a quote or callout a paragraph's further lines each carry the quote marker; it edits as the text without them.
    const quoted = /^\s*>/.test(continuation)
    const quote = !quoted ? '' : /[\r\n]/.test(block.raw) ? quoteOf(block.raw, continuation) : continuation
    const model = block.id.startsWith('empty:') && block.start === emptyAt && appendPrefix
      ? { ...plainModel(), prefix: appendPrefix } : parseInlineBlock(quote ? unquote(block.raw) : block.raw)
    const rich = block.capability === 'rich' || (!!quote && block.type === 'paragraph')
    if (rich && !['embed', 'image', 'table', 'thematicBreak'].includes(block.type) && model.capability === 'rich') {
      return shell(<RichBlock block={block.capability === 'rich' ? block : { ...block, capability: 'rich' }} model={model} buffer={buffer} continuation={continuation} quote={quote}
        focus={focus} merge={merge} report={report} navigate={navigate} />)
    }
    if (block.type === 'table' && block.capability === 'rich') {
      const table = parseTable(block.raw)
      if (table) return shell(<TableBlock block={block} model={table} buffer={buffer} report={report} />)
    }
    // Source/readonly blocks never enter contentEditable. Rendering remains in
    // NotePreview, including Widget's sandbox and the library quote resolver.
    return shell(<SourceBlock block={block} buffer={buffer} report={report}>{renderSource(block)}</SourceBlock>)
  }
  const segments = parsed.segments.filter((part): part is DocumentBlock => part.kind === 'block')
  const containing = emptyAt === null ? undefined : emptyIn !== null ? parsed.blocks.find(block => block.type === 'callout' && block.start === emptyIn) : parsed.blocks.filter(block =>
    ['column', 'listItem', 'taskItem', 'blockquote', 'callout'].includes(block.type) && block.start <= emptyAt && block.end > emptyAt).at(-1)
  const extra = emptyAt === null || parsed.blocks.some(block => block.start === emptyAt && block.type === 'paragraph')
    ? null : emptyBlock(emptyAt, containing?.id ?? null)
  if (extra && !extra.parentId) { segments.push(extra); segments.sort((a, b) => a.start - b.start) }
  /** Where a reference dragged in from outside would land: beside the list entry or the page block under the pointer. */
  const landing = (event: { target: EventTarget | null; clientY: number }) => {
    const hit = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-block-type="listItem"], [data-block-type="taskItem"], [data-block-start][data-actionable]') : null
    const el = hit ?? [...root.current!.querySelectorAll<HTMLElement>(':scope [data-block-start][data-actionable]')].filter(item => !item.parentElement?.closest('[data-actionable]')).at(-1)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { el, placement: hit && event.clientY < rect.top + rect.height / 2 ? 'before' as const : 'after' as const }
  }
  const showLanding = (next: ReturnType<typeof landing>) => {
    const current = dropLine.current
    if (current && (current.el !== next?.el || current.placement !== next.placement)) delete current.el.dataset.refDrop
    if (next) next.el.dataset.refDrop = next.placement
    dropLine.current = next
  }
  /** The source position and the surrounding text for a reference dropped at `spot`: a new entry in a list, otherwise a paragraph. */
  const insertion = (spot: NonNullable<ReturnType<typeof landing>>) => {
    const { content: source } = buffer.snapshot, eol = newline(source)
    const start = Number(spot.el.dataset.blockStart)
    const block = parseDocumentBlocks(source).blocks.find(item => item.start === start && item.type === spot.el.dataset.blockType)
    if (!block) return null
    if (block.type === 'listItem' || block.type === 'taskItem') {
      let line = block.start
      while (line > 0 && source[line - 1] !== '\n' && source[line - 1] !== '\r') line--
      const lead = source.slice(line, block.start)
      const marker = (/^(?:[-*+]|\d+[.)])[ \t]+/.exec(block.raw)?.[0] ?? '- ') + (block.type === 'taskItem' ? '[ ] ' : '')
      return spot.placement === 'before' ? { at: line, wrap: (markdown: string) => lead + marker + markdown + eol } : { at: block.end, wrap: (markdown: string) => eol + lead + marker + markdown }
    }
    return spot.placement === 'before' ? { at: block.start, wrap: (markdown: string) => markdown + eol + eol } : { at: block.end, wrap: (markdown: string) => eol + eol + markdown }
  }
  return <AnnotationWorkspace buffer={buffer}><div ref={root} className="note-preview-body" data-ready-block-editor={editorId}
    onDragStartCapture={event => { movingOwnBlock.current = event.target instanceof Element && !!event.target.closest('.ready-block-handle, .ready-block-marker') }}
    onDragEndCapture={() => { movingOwnBlock.current = false; showLanding(null) }}
    onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) showLanding(null) }}
    onDragOverCapture={event => {
      if (movingOwnBlock.current || ownsDrops(event.target) || !event.dataTransfer?.types.includes(READY_REF_MIME)) { showLanding(null); return }
      event.preventDefault(); event.stopPropagation()
      // A line shows where the reference will land (above or below the block under the pointer).
      showLanding(landing(event))
    }}
    onDropCapture={event => {
      try {
        // The line shown while dragging decides. A drop that never showed one (no dragover reached the page) keeps the
        // older rule: before the block under the pointer, or at the end of the page.
        const under = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-block-type="listItem"], [data-block-type="taskItem"], [data-block-start][data-actionable]') : null
        const spot = dropLine.current ?? (under ? { el: under, placement: 'before' as const } : null)
        showLanding(null)
        if (movingOwnBlock.current) { movingOwnBlock.current = false; return }
        if (ownsDrops(event.target)) return
        if (getGeneratedImageDragPayload(event.dataTransfer)) return
        const dropped = event.dataTransfer ? readReadyRefTransfer(event.dataTransfer) : null
        if (!dropped) return
        event.preventDefault(); event.stopPropagation()
        buffer.flush()
        const place = spot && insertion(spot)
        void dropDocumentReference(event.dataTransfer, buffer, place ? place.at : buffer.snapshot.content.length, place?.wrap).catch(report)
      } catch (cause) { console.warn('[ReadyBlockEditor] insert dropped reference failed:', cause instanceof Error ? cause.message : String(cause)); event.preventDefault(); event.stopPropagation(); report(cause) }
    }}
    onKeyDownCapture={event => {
      if (event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
      event.preventDefault(); event.stopPropagation()
      travel(event.shiftKey ? 'redo' : 'undo')
    }}>
    <BlockControls editorId={editorId} buffer={buffer} linkBase={linkBase} report={report}><EditorTools buffer={buffer} linkBase={linkBase} report={report}>
    {(writeError || error) && <p role="alert">{writeError || error}</p>}
    {parsed.blocks.some(block => block.issue) && <p role="status">分栏格式需修复，其他段落仍可编辑。</p>}
    {segments.map((block, index) => renderBlock(block, String(index)))}
    {/* The page tail: clicking below the last block continues the text, as in Inkwell. The label keeps the empty-page
        placeholder (CSS generated text) out of the button's accessible name. */}
    <button type="button" className="ready-block-tail" aria-label="添加文字" onClick={() => {
      try {
        buffer.flush()
        const end = buffer.snapshot.content.length
        // The insertion's separator is committed with its text, not on click.
        setAppendPrefix(end ? newline(buffer.snapshot.content).repeat(2) : ''); setEmptyIn(null); setEmptyAt(end); setFocusRequest({ at: end })
      } catch (cause) { console.warn('[ReadyBlockEditor] append text block failed:', cause instanceof Error ? cause.message : String(cause)); report(cause) }
    }}>添加文字</button>
    </EditorTools></BlockControls>
  </div></AnnotationWorkspace>
}
