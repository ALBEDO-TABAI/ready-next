import { readReadyRefTransfer, READY_REF_MIME } from '../../../../shared/ready-ref'
import { dropDocumentReference } from '../../workbench/capture'
import { getGeneratedImageDragPayload } from '../../image-generation/generatedImageDrag'
import { blockWithMarker } from '../../../../shared/document-anchors'
import { AnnotationWorkspace } from '../annotations/AnnotationWorkspace'
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, useId, type ReactNode } from 'react'
import { useDocTabs } from '../../../stores/useDocTabs'
import {
  createBlockCommand, createRangeEdit, parseDocumentBlocks, parseInlineBlock, replaceRanges,
  type DocumentBlock,
} from '../../../../shared/document-blocks'
import { getTabBuffer } from './tab-buffer'
import type { EditorBuffer } from './editor-buffer'
import { emptyBlock, inlineMarkdown, newline, plainModel } from './editing'
import { getCaret, plainText, setCaret } from './dom-inline'
import { BlockIdentity } from './block-identity'
import { RichBlock } from './RichBlock'
import { BlockControls, BlockShell } from './BlockControls'
import { EditorTools } from './EditorTools'
import { isNonContentBlock } from './catalog'
import { duplicatePageHeading } from '../page-ui/page-title'
import { textAreaContent } from './text-edit'
import type { EditorLinkBase } from './references'
import { useInLibrary } from '../page-ui/library-membership'

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
  return <div className="ready-block-source" data-block-type={block.type}>
    {children}
    {draft ? <div className="note-preview-edit-editor">
      <textarea ref={textarea} aria-label="块源码" value={draft.text} spellCheck={false}
        onChange={event => setDraft({ ...draft, text: event.target.value })}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); setDraft(null) }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); try { commit() } catch (error) { console.warn('[ReadyBlockEditor] commit block source with shortcut failed:', error instanceof Error ? error.message : String(error)); report(error) } }
        }} />
      <button type="button" onClick={() => { try { commit() } catch (error) { console.warn('[ReadyBlockEditor] commit block source failed:', error instanceof Error ? error.message : String(error)); report(error) } }}>完成</button>
      <button type="button" onClick={() => setDraft(null)}>取消</button>
    </div> : <button type="button" className="ready-block-source-edit" onClick={() => setDraft({ block, version: buffer.snapshot.version, text: block.raw.replace(/\r\n?/g, '\n') })}>
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
  const [focusRequest, setFocusRequest] = useState<{ at: number; textOffset?: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const movingOwnBlock = useRef(false)
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), [])
  const focus = (at: number, empty = false, textOffset?: number) => { setAppendPrefix(''); setEmptyAt(empty ? at : null); setFocusRequest({ at, textOffset }) }
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
    else { setAppendPrefix(''); setEmptyAt(0); setFocusRequest({ at: 0 }) }
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
    // A callout's [!type] header and its first body lines form one Markdown paragraph, so its children
    // cannot be edited inline without showing the raw marker. Render it whole, like the preview does.
    if (block.type === 'callout') return shell(<SourceBlock block={block} buffer={buffer} report={report}>{renderSource(block)}</SourceBlock>)
    if (['columns', 'column', 'list', 'listItem', 'taskItem', 'blockquote'].includes(block.type)) {
      const isList = block.type === 'listItem' || block.type === 'taskItem'
      const prefix = isList ? /^(?:\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/.exec(block.raw)?.[0] ?? ''
        : block.type === 'blockquote' ? '> ' : continuation
      const body = children.length ? children.map((child, index) => renderBlock(child, `${key}/${index}`, prefix))
        : renderBlock(emptyBlock(block.end, block.id), `${key}/empty`, prefix)
      if (block.type === 'columns') return shell(<div data-ready-columns style={{ display: 'grid', gridTemplateColumns: block.widths?.map(width => `minmax(0, ${width}fr)`).join(' '), gap: 24 }}>{body}</div>)
      if (block.type === 'list') return shell(<div role="list">{body}</div>)
      const quote = prefix === '> ', task = block.type === 'taskItem'
      return shell(<div role={isList ? 'listitem' : undefined} className={`ready-block-container${isList || quote ? ' is-indented' : ''}${quote ? ' is-quote' : ''}`}
        data-checked={task ? /\[[xX]\]/.test(prefix) : undefined}>
        {isList && <span aria-hidden className={`ready-block-marker${task ? ' is-task' : /^\s*\d/.test(prefix) ? ' is-number' : ' is-bullet'}`}
          data-checked={task ? /\[[xX]\]/.test(prefix) : undefined}>{task ? '' : /^\s*\d/.test(prefix) ? prefix.trim() : '•'}</span>}{body}
      </div>)
    }
    const model = block.id.startsWith('empty:') && block.start === emptyAt && appendPrefix
      ? { ...plainModel(), prefix: appendPrefix } : parseInlineBlock(block.raw)
    if (block.capability === 'rich' && !['embed', 'image', 'table', 'thematicBreak'].includes(block.type) && model.capability === 'rich') {
      return shell(<RichBlock block={block} model={model} buffer={buffer} continuation={continuation} focus={focus} merge={merge} report={report} navigate={navigate} />)
    }
    // Source/readonly blocks never enter contentEditable. Rendering remains in
    // NotePreview, including Widget's sandbox and the library quote resolver.
    return shell(<SourceBlock block={block} buffer={buffer} report={report}>{renderSource(block)}</SourceBlock>)
  }
  const segments = parsed.segments.filter((part): part is DocumentBlock => part.kind === 'block')
  const containing = emptyAt === null ? undefined : parsed.blocks.filter(block =>
    ['column', 'listItem', 'taskItem', 'blockquote'].includes(block.type) && block.start <= emptyAt && block.end > emptyAt).at(-1)
  const extra = emptyAt === null || parsed.blocks.some(block => block.start === emptyAt && block.type === 'paragraph')
    ? null : emptyBlock(emptyAt, containing?.id ?? null)
  if (extra && !extra.parentId) { segments.push(extra); segments.sort((a, b) => a.start - b.start) }
  return <AnnotationWorkspace buffer={buffer}><div ref={root} className="note-preview-body" data-ready-block-editor={editorId}
    onDragStartCapture={event => { movingOwnBlock.current = event.target instanceof Element && !!event.target.closest('.ready-block-handle') }}
    onDragEndCapture={() => { movingOwnBlock.current = false }}
    onDragOverCapture={event => { if (!movingOwnBlock.current && !ownsDrops(event.target) && event.dataTransfer?.types.includes(READY_REF_MIME)) { event.preventDefault(); event.stopPropagation() } }}
    onDropCapture={event => {
      try {
        if (movingOwnBlock.current) { movingOwnBlock.current = false; return }
        if (ownsDrops(event.target)) return
        if (getGeneratedImageDragPayload(event.dataTransfer)) return
        const dropped = event.dataTransfer ? readReadyRefTransfer(event.dataTransfer) : null
        if (!dropped) return
        event.preventDefault(); event.stopPropagation()
        const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-block-start]') : null
        const at = target ? Number(target.dataset.blockStart) : buffer.snapshot.content.length
        void dropDocumentReference(event.dataTransfer, buffer, at).catch(report)
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
        setAppendPrefix(end ? newline(buffer.snapshot.content).repeat(2) : ''); setEmptyAt(end); setFocusRequest({ at: end })
      } catch (cause) { console.warn('[ReadyBlockEditor] append text block failed:', cause instanceof Error ? cause.message : String(cause)); report(cause) }
    }}>添加文字</button>
    </EditorTools></BlockControls>
  </div></AnnotationWorkspace>
}
