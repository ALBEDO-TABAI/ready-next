import { useLayoutEffect, useRef } from 'react'
import { createBlockCommand, fragmentHash, parseInlineBlock, type DocumentBlock, type InlineModel, type InlineSpan } from '../../../../shared/document-blocks'
import { atVerticalEdge, drawInline, getCaret, plainText, readInline, setCaret, sliceSpans } from './dom-inline'
import { inlineMarkdown, inputRule, newline, spliceRich } from './editing'
import type { EditorBuffer } from './editor-buffer'

interface Props {
  block: DocumentBlock
  model: InlineModel
  buffer: EditorBuffer
  continuation: string
  focus(at: number, empty?: boolean, textOffset?: number): void
  merge(block: DocumentBlock, model: InlineModel): void
  report(error: unknown): void
  navigate(element: HTMLElement, direction: 'up' | 'down'): void
}
export function RichBlock({ block, model, buffer, continuation, focus, merge, report, navigate }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const typingGroup = useRef(0)
  const previousCaret = useRef<number | null>(null)
  const session = useRef({ block, model, version: buffer.snapshot.version, dirty: false })
  const flush = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    const el = ref.current!
    if (composing.current || session.current.dirty) return
    if (document.activeElement !== el || session.current.block.raw !== block.raw) {
      const caret = document.activeElement === el ? getCaret(el) : null
      drawInline(el, model.spans)
      if (caret) setCaret(el, caret.start, caret.end, caret.backward)
    }
    session.current = { block, model, version: buffer.snapshot.version, dirty: false }
  }, [block, model, buffer])
  useLayoutEffect(() => {
    const commit = () => flush.current()
    buffer.flushers.add(commit)
    return () => { buffer.flushers.delete(commit) }
  }, [buffer])
  const commit = (kind: 'typing' | 'composition' = 'typing') => {
    const state = session.current
    if (!state.dirty) return
    if (composing.current) throw new Error('请先完成当前输入法组合输入，再保存或撤销')
    const spans = readInline(ref.current!)
    const markdown = inlineMarkdown(state.model, spans)
    if (markdown !== state.block.raw) {
      const edit = createBlockCommand({ content: buffer.snapshot.content, version: state.version }, { type: 'replace', block: state.block, markdown })
      if (previousCaret.current !== null && kind === 'typing') edit.selectionBefore = { anchor: previousCaret.current, focus: previousCaret.current }
      buffer.apply(edit, kind, kind === 'typing' ? `rich:${block.start}:${typingGroup.current}` : undefined)
      previousCaret.current = edit.selectionAfter.focus
      const nextModel = parseInlineBlock(markdown)
      if (nextModel.capability !== 'rich') throw new Error(nextModel.reason)
      state.block = { ...state.block, raw: markdown, end: state.block.start + markdown.length, hash: fragmentHash(markdown) }
      state.model = nextModel; state.version = buffer.snapshot.version
    }
    state.dirty = false
  }
  flush.current = commit
  const attempt = (action: () => void) => { try { action() } catch (error) { report(error) } }
  return <div ref={ref} role="textbox" aria-label="编辑段落" contentEditable suppressContentEditableWarning
    data-rich-start={block.start} data-ready-heading-title={block.type === 'heading' ? plainText(model.spans) : undefined}
    className={block.type === 'heading' ? `note-preview-markdown-h${Math.min(6, /^#+/.exec(model.prefix)?.[0].length ?? 1)}` : 'note-preview-markdown-p'}
    style={{ minHeight: '1.7em', whiteSpace: 'pre-wrap', outline: 'none', overflowWrap: 'anywhere' }}
    onFocus={() => { typingGroup.current++; previousCaret.current = null; if (!session.current.dirty) session.current = { block, model, version: buffer.snapshot.version, dirty: false } }}
    onInput={() => {
      session.current.dirty = true
      if (composing.current) return
      attempt(() => {
        const spans = readInline(ref.current!), text = plainText(spans), caret = getCaret(ref.current!)
        const prefix = text.slice(0, caret.end)
        const rule = session.current.model.prefix === '' && !continuation && spans.every(span => Object.keys(span.marks).length === 0)
          ? inputRule(prefix, newline(buffer.snapshot.content)) ?? inputRule(text, newline(buffer.snapshot.content)) : null
        if (rule !== null) {
          const state = session.current
          const remainder = inputRule(prefix, newline(buffer.snapshot.content)) !== null ? sliceSpans(spans, caret.end) : []
          const rest = inlineMarkdown({ ...state.model, prefix: '', suffix: '', source: '', baseline: '[]' }, remainder)
          const eol = newline(buffer.snapshot.content)
          const markdown = rule.startsWith('```') ? `\`\`\`${eol}${plainText(remainder)}${eol}\`\`\``
            : rule === '---' && rest ? rule + eol + eol + rest : rule + rest
          buffer.apply(createBlockCommand({ ...buffer.snapshot, version: state.version }, { type: 'replace', block: state.block, markdown }), 'typing')
          state.dirty = false; focus(state.block.start + rule.length, false, 0)
        } else {
          const wasEmpty = session.current.block.id.startsWith('empty:')
          const caret = getCaret(ref.current!)
          const at = session.current.block.start + session.current.model.prefix.length + caret.end
          commit()
          if (!plainText(spans).length && !session.current.model.prefix) focus(at, true)
          else if (wasEmpty) focus(at, false, caret.end)
        }
      })
    }}
    onCompositionStart={() => { composing.current = true }}
    onCompositionUpdate={() => { session.current.dirty = true }}
    onCompositionEnd={() => { composing.current = false; session.current.dirty = true; attempt(() => commit('composition')) }}
    onBlur={() => attempt(() => commit())}
    onKeyDown={event => {
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
      const el = ref.current!, caret = getCaret(el)
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') return // buffer-level capture
      if (event.key === 'Enter') {
        event.preventDefault()
        attempt(() => {
          if (event.shiftKey) {
            const spans = readInline(el)
            drawInline(el, [...sliceSpans(spans, 0, caret.start), { text: '\n', marks: {} }, ...sliceSpans(spans, caret.end)])
            setCaret(el, caret.start + 1); session.current.dirty = true; return
          }
          const state = session.current
          const result = spliceRich({ ...buffer.snapshot, version: state.version }, state.block, state.model, readInline(el), caret.start, caret.end, null, continuation)
          buffer.apply(result.edit, 'split'); state.dirty = false; focus(result.at, result.empty, 0)
        })
      } else if (event.key === 'Backspace' && caret.start === 0 && caret.end === 0) {
        event.preventDefault()
        attempt(() => { commit(); merge(session.current.block, session.current.model) })
      } else if (['ArrowUp', 'ArrowDown'].includes(event.key) && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        const direction = event.key === 'ArrowUp' ? 'up' : 'down'
        if (atVerticalEdge(el, direction)) { event.preventDefault(); attempt(() => { commit(); navigate(el, direction) }) }
      }
    }}
    onPaste={event => {
      if (composing.current) return
      event.preventDefault(); event.stopPropagation()
      attempt(() => {
        const el = ref.current!, caret = getCaret(el), html = event.clipboardData.getData('text/html')
        let pasted
        if (html) { const template = document.createElement('template'); template.innerHTML = html; pasted = readInline(template.content, '\n\n') }
        else pasted = [{ text: event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'), marks: {} }]
        const text = plainText(pasted), spans = readInline(el)
        if (/\n\s*\n/.test(text)) {
          const parts: InlineSpan[][] = []; let offset = 0
          for (const match of text.matchAll(/\n\s*\n/g)) { parts.push(sliceSpans(pasted, offset, match.index)); offset = match.index + match[0].length }
          parts.push(sliceSpans(pasted, offset))
          const state = session.current
          const result = spliceRich({ ...buffer.snapshot, version: state.version }, state.block, state.model, spans, caret.start, caret.end, parts, continuation)
          buffer.apply(result.edit, 'paste'); state.dirty = false; focus(result.at, false, plainText(parts.at(-1)!).length)
        } else {
          drawInline(el, [...sliceSpans(spans, 0, caret.start), ...pasted, ...sliceSpans(spans, caret.end)])
          setCaret(el, caret.start + text.length); session.current.dirty = true; commit()
        }
      })
    }} />
}
