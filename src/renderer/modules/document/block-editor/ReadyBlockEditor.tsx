import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useDocTabs } from '../../../stores/useDocTabs'
import {
  createBlockCommand, createRangeEdit, parseDocumentBlocks, parseInlineBlock, replaceRanges,
  type DocumentBlock,
} from '../../../../shared/document-blocks'
import { getTabBuffer, type TabBuffer } from './tab-buffer'
import { emptyBlock, inlineMarkdown, newline, plainModel } from './editing'
import { getCaret, plainText, setCaret } from './dom-inline'
import { BlockIdentity } from './block-identity'
import { RichBlock } from './RichBlock'
import { textAreaContent } from './text-edit'

function SourceBlock({ block, buffer, children, report }: { block: DocumentBlock; buffer: TabBuffer; children: ReactNode; report(error: unknown): void }) {
  const [draft, setDraft] = useState<{ block: DocumentBlock; version: number; text: string } | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const commit = () => {
    if (!draft) return
    // Textarea uses LF internally; its initial value is display-only. A no-op
    // must retain the original CRLF bytes.
    if (draft.text !== draft.block.raw.replace(/\r\n?/g, '\n')) {
      buffer.apply(createBlockCommand({ ...buffer.snapshot, version: draft.version }, {
        type: 'replace', mode: 'source', block: draft.block, markdown: textAreaContent(draft.block.raw, draft.text),
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
  return <div data-block-type={block.type}>
    {children}
    {draft ? <div className="note-preview-edit-editor">
      <textarea ref={textarea} aria-label="块源码" value={draft.text} spellCheck={false}
        onChange={event => setDraft({ ...draft, text: event.target.value })}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); setDraft(null) }
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); try { commit() } catch (error) { report(error) } }
        }} />
      <button type="button" onClick={() => { try { commit() } catch (error) { report(error) } }}>完成</button>
      <button type="button" onClick={() => setDraft(null)}>取消</button>
    </div> : <button type="button" onClick={() => setDraft({ block, version: buffer.snapshot.version, text: block.raw.replace(/\r\n?/g, '\n') })}>
      {block.capability === 'readonly' ? '编辑这段源码' : '编辑源码'}
    </button>}
  </div>
}

export function ReadyBlockEditor({ tabId, content: displayedContent, renderSource }: { tabId: string; content?: string; renderSource(block: DocumentBlock): ReactNode }) {
  // A retained hidden DocumentMode supplies its frozen snapshot. Do not bypass it.
  const content = useDocTabs(state => displayedContent ?? state.tabs.find(tab => tab.id === tabId)?.content ?? '')
  const buffer = useMemo(() => getTabBuffer(tabId), [tabId])
  const parsed = useMemo(() => parseDocumentBlocks(content), [content])
  const identities = useRef(new BlockIdentity())
  const keys = useMemo(() => identities.current.resolve(parsed), [parsed])
  const [error, setError] = useState('')
  const [emptyAt, setEmptyAt] = useState<number | null>(null)
  const [appendPrefix, setAppendPrefix] = useState('')
  const [focusRequest, setFocusRequest] = useState<{ at: number; textOffset?: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))
  const focus = (at: number, empty = false, textOffset?: number) => { setAppendPrefix(''); setEmptyAt(empty ? at : null); setFocusRequest({ at, textOffset }) }
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
    if (!previous || previous.capability !== 'rich') return
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
    const key = keys.get(block.id) ?? fallbackKey
    const children = block.children.filter((part): part is DocumentBlock => part.kind === 'block')
    if (extra?.parentId === block.id) { children.push(extra); children.sort((a, b) => a.start - b.start) }
    const line = content.slice(0, block.start).split(/\r\n|\n|\r/).length
    const shell = (body: ReactNode) => <div key={key} className="note-preview-render-block" data-ready-block-source-line={line} data-block-type={block.type}>{body}</div>
    if (['columns', 'column', 'list', 'listItem', 'taskItem', 'blockquote', 'callout'].includes(block.type)) {
      const isList = block.type === 'listItem' || block.type === 'taskItem'
      const prefix = isList ? /^(?:\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/.exec(block.raw)?.[0] ?? ''
        : block.type === 'blockquote' || block.type === 'callout' ? '> ' : continuation
      const body = children.length ? children.map((child, index) => renderBlock(child, `${key}/${index}`, prefix))
        : renderBlock(emptyBlock(block.end, block.id), `${key}/empty`, prefix)
      if (block.type === 'columns') return shell(<div data-ready-columns style={{ display: 'grid', gridTemplateColumns: block.widths?.map(width => `minmax(0, ${width}fr)`).join(' '), gap: 24 }}>{body}</div>)
      if (block.type === 'list') return shell(<div role="list">{body}</div>)
      return shell(<div role={isList ? 'listitem' : undefined} style={{ minWidth: 0, paddingLeft: isList || prefix === '> ' ? 24 : 0,
        borderLeft: prefix === '> ' ? '2px solid var(--border-color)' : undefined }}>
        {isList && <span aria-hidden style={{ float: 'left', marginLeft: -24 }}>{block.type === 'taskItem' ? (/\[[xX]\]/.test(prefix) ? '☑' : '☐') : /^\s*\d/.test(prefix) ? prefix.trim() : '•'}</span>}{body}
      </div>)
    }
    const model = block.id.startsWith('empty:') && block.start === emptyAt && appendPrefix
      ? { ...plainModel(), prefix: appendPrefix } : parseInlineBlock(block.raw)
    if (block.capability === 'rich' && !['embed', 'image', 'table', 'thematicBreak'].includes(block.type) && model.capability === 'rich') {
      return shell(<RichBlock block={block} model={model} buffer={buffer} continuation={continuation} focus={focus} merge={merge} report={report} navigate={navigate} />)
    }
    // Source/readonly blocks never enter contentEditable. Rendering remains in
    // NotePreview, including Widget's sandbox and the library quote resolver.
    return <div key={key} className="note-preview-render-block" data-ready-block-source-line={line}>
      <SourceBlock block={block} buffer={buffer} report={report}>{renderSource(block)}</SourceBlock>
    </div>
  }
  const segments = parsed.segments.filter((part): part is DocumentBlock => part.kind === 'block')
  const containing = emptyAt === null ? undefined : parsed.blocks.filter(block =>
    ['column', 'listItem', 'taskItem', 'blockquote'].includes(block.type) && block.start <= emptyAt && block.end > emptyAt).at(-1)
  const extra = emptyAt === null || parsed.blocks.some(block => block.start === emptyAt && block.type === 'paragraph')
    ? null : emptyBlock(emptyAt, containing?.id ?? null)
  if (extra && !extra.parentId) { segments.push(extra); segments.sort((a, b) => a.start - b.start) }
  return <div ref={root} className="note-preview-body" data-ready-block-editor={tabId}
    onKeyDownCapture={event => {
      if (event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
      event.preventDefault(); event.stopPropagation()
      try { const selection = buffer.travel(event.shiftKey ? 'redo' : 'undo'); if (selection) focus(selection.focus); setError('') } catch (cause) { report(cause) }
    }}>
    {error && <p role="alert">{error}</p>}
    {parsed.blocks.some(block => block.issue) && <p role="status">分栏格式需修复，其他段落仍可编辑。</p>}
    {segments.map((block, index) => renderBlock(block, String(index)))}
    <button type="button" onClick={() => {
      try {
        buffer.flush()
        const end = buffer.snapshot.content.length
        // The insertion's separator is committed with its text, not on click.
        setAppendPrefix(end ? newline(buffer.snapshot.content).repeat(2) : ''); setEmptyAt(end); setFocusRequest({ at: end })
      } catch (cause) { report(cause) }
    }}>添加文字</button>
  </div>
}
