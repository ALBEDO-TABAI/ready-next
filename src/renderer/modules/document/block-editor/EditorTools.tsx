import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { createBlockCommand, parseDocumentBlocks, parseInlineBlock, type DocumentBlock, type DocumentBuffer, type InlineMarks, type InlineModel, type InlineSpan } from '../../../../shared/document-blocks'
import WidgetEditDrawer from '../../../components/document/WidgetEditDrawer'
import { useDocTabs } from '../../../stores/useDocTabs'
import { CommandMenu, BlockEditorStyles, type MenuAnchor, type MenuItem } from './CommandMenu'
import { InlineToolbar } from './InlineToolbar'
import { BLOCK_KINDS, convertBlock } from './catalog'
import { getCaret, plainText, setCaret, sliceSpans } from './dom-inline'
import { emptyBlock, inlineMarkdown, newline, plainModel } from './editing'
import { findReferences, openInlineReference, wikiTarget, workspaceRoots, type ReferenceChoice } from './references'
import type { TabBuffer } from './tab-buffer'

interface Selection {
  block: DocumentBlock; model: InlineModel; snapshot: DocumentBuffer; start: number; end: number; anchor: MenuAnchor
}
type Picker = Selection & { kind: 'slash' | 'wiki' | 'mention' }
const widgetInput = { title: '新信息卡', widgetCode: '', skeletonSpec: { skeleton: 'single_focus', size: 'doc_block', props: { title: '新信息卡', body: '填写内容' } } }

export function EditorTools({ buffer, children, report }: { buffer: TabBuffer; children: ReactNode; report(error: unknown): void }) {
  const root = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [picker, setPicker] = useState<Picker | null>(null), [query, setQuery] = useState('')
  const [results, setResults] = useState<ReferenceChoice[]>([]), [loading, setLoading] = useState(false)
  const [widget, setWidget] = useState<Picker | null>(null)
  const [page, setPage] = useState<{ picker: Picker; title: string; operationId: string; state: 'editing' | 'pending' | 'failed' } | null>(null)
  const pagePending = useRef(false)
  const [restore, setRestore] = useState<{ at: number; start: number; end: number } | null>(null)
  useLayoutEffect(() => {
    if (!restore) return
    const el = root.current?.querySelector<HTMLElement>(`[data-rich-start="${restore.at}"]`)
    if (el) { el.focus(); setCaret(el, restore.start, restore.end) }
    setRestore(null)
  }, [restore])
  function readSelection(el: HTMLElement): Selection | null {
    const snapshot = buffer.snapshot, at = Number(el.dataset.richStart)
    const block = parseDocumentBlocks(snapshot.content).blocks.find(item => item.start === at && ['paragraph', 'heading', 'wikiLink'].includes(item.type)) ?? (el.textContent === '' ? emptyBlock(at) : null)
    if (!block) return null
    const model = parseInlineBlock(block.raw)
    if (model.capability !== 'rich') return null
    const caret = getCaret(el)
    return { block, model, snapshot, start: caret.start, end: caret.end, anchor: el.getBoundingClientRect() }
  }
  const close = () => {
    const state = picker ?? selection
    setPicker(null); setSelection(null)
    if (state) setRestore({ at: state.block.start, start: state.end, end: state.end })
  }
  function replaceSelection(state: Selection, inserted: InlineSpan[]) {
    const spans = [...sliceSpans(state.model.spans, 0, state.start), ...inserted, ...sliceSpans(state.model.spans, state.end)]
    const markdown = inlineMarkdown(state.model, spans)
    buffer.apply(createBlockCommand(state.snapshot, { type: 'replace', block: state.block, markdown }))
    const next = parseInlineBlock(markdown)
    if (next.capability !== 'rich') throw new Error(next.reason)
    const end = state.start + plainText(inserted).length
    setSelection(null); setPicker(null); setRestore({ at: state.block.start, start: end, end })
  }
  function applyMarks(state: Selection, patch: InlineMarks) {
    try {
      const selected = sliceSpans(state.model.spans, state.start, state.end).map(span => ({ ...span, marks: { ...span.marks, ...patch } }))
      replaceSelection(state, selected)
      setRestore({ at: state.block.start, start: state.start, end: state.end })
    } catch (error) { report(error) }
  }
  function select() {
    if (document.activeElement?.closest('[data-block-popup]')) return
    const current = window.getSelection()
    const el = current?.anchorNode?.parentElement?.closest<HTMLElement>('[data-rich-start]')
    if (!el || !root.current?.contains(el) || !current?.focusNode || !el.contains(current.focusNode)) { setSelection(null); return }
    const state = readSelection(el)
    setSelection(state && state.start !== state.end ? state : null)
  }
  useEffect(() => {
    document.addEventListener('selectionchange', select)
    return () => document.removeEventListener('selectionchange', select)
  })
  useEffect(() => {
    if (!picker || picker.kind === 'slash') return
    let cancelled = false
    setLoading(true); setResults([])
    const timer = window.setTimeout(() => {
      findReferences(query, picker.kind === 'wiki', buffer.tabId).then(items => { if (!cancelled) setResults(items) })
        .catch(error => { if (!cancelled) report(error) }).finally(() => { if (!cancelled) setLoading(false) })
    }, 150)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [buffer.tabId, picker, query, report])
  const attempt = (action: () => void) => { try { action() } catch (error) { report(error) } }
  function slashMarkdown(state: Picker, markdown: string) {
    // Only the typed trigger is consumed; existing following text is retained.
    const remainder = inlineMarkdown(plainModel(), sliceSpans(state.model.spans, state.end))
    const eol = newline(state.snapshot.content)
    buffer.apply(createBlockCommand(state.snapshot, { type: 'replace', block: state.block, markdown: markdown + (remainder ? eol + eol + remainder : '') }))
    setPicker(null); setRestore({ at: state.block.start, start: 0, end: 0 })
  }
  let items: MenuItem[] = []
  if (picker?.kind === 'slash') {
    const current = picker, eol = newline(current.snapshot.content)
    items = BLOCK_KINDS.map(([kind, label]) => ({ id: kind, label, run: () => attempt(() => {
      const body = inlineMarkdown(plainModel(), sliceSpans(current.model.spans, current.end))
      const block = { ...emptyBlock(0), raw: body }
      buffer.apply(createBlockCommand(current.snapshot, { type: 'replace', block: current.block, markdown: convertBlock(block, kind, eol) }))
      setPicker(null); setRestore({ at: current.block.start, start: 0, end: 0 })
    }) }))
    items.push({ id: 'widget', label: '插入 Widget', run: () => { setPicker(null); setWidget(current) } },
      { id: 'mermaid', label: '插入 Mermaid', run: () => attempt(() => slashMarkdown(current, `\`\`\`mermaid${eol}graph TD${eol}  A --> B${eol}\`\`\``)) },
      { id: 'columns', label: '插入分栏', run: () => attempt(() => slashMarkdown(current, `<!-- ready:columns widths=1,1 -->${eol}${eol}<!-- ready:column -->${eol}${eol}<!-- ready:columns-end -->`)) },
      { id: 'page', label: '插入子页面链接', run: () => { setPicker(null); setPage({ picker: current, title: '', operationId: crypto.randomUUID(), state: 'editing' }) } })
  } else if (picker) items = results.map(result => ({ ...result, run: () => attempt(() => replaceSelection(picker, [{ text: result.text, marks: { reference: result.reference } }])) }))
  async function createPage() {
    if (!page || pagePending.current) return
    pagePending.current = true; setPage({ ...page, state: 'pending' })
    try {
      const tab = useDocTabs.getState().tabs.find(item => item.id === buffer.tabId)
      const path = tab?.path
      if (!path) throw new Error('请先保存当前页面，再创建子页面')
      if (/[[\]|#\r\n]/.test(path + page.title)) throw new Error('页面路径或名称不能表示为 Wiki 引用')
      const rootPath = workspaceRoots().filter(root => path.startsWith(root.replace(/[/\\]$/, '') + '/')).sort((a, b) => b.length - a.length)[0]
      if (!rootPath) throw new Error('当前页面不在已打开的资料库中')
      if (buffer.snapshot.version !== page.picker.snapshot.version) throw new Error('正文已经改变，请取消后重新插入')
      const result = await window.electronAPI.documentPages.operate({ type: 'create', operationId: page.operationId, root: rootPath, parentPath: path, title: page.title })
      if (!result.ok) throw new Error(result.message)
      if (!result.value.path) throw new Error('新页面没有返回路径')
      const target = await wikiTarget(buffer.tabId, result.value.path)
      if (buffer.snapshot.version !== page.picker.snapshot.version) throw new Error(`页面已创建在 ${result.value.path}；正文已变化，未插入链接。请取消并从 [[ 选择器插入。`)
      replaceSelection(page.picker, [{ text: target, marks: { reference: { kind: 'wiki', target } } }])
      setPage(null)
    } catch (error) { report(error); setPage({ ...page, state: 'failed' }) } finally { pagePending.current = false }
  }
  return <div ref={root} onMouseUp={select} onKeyUp={select}
    onInput={event => {
      if (!(event.target instanceof HTMLElement) || !event.target.matches('[data-rich-start]') || ('isComposing' in event.nativeEvent && event.nativeEvent.isComposing)) return
      const state = readSelection(event.target); if (!state || state.start !== state.end) return
      const prefix = plainText(state.model.spans).slice(0, state.end)
      const trigger = /^(\/)\S*$/.exec(prefix) ?? /(\[\[)([^[\]\r\n]*)$/.exec(prefix) ?? /(?:^|\s)(@)([^@\r\n]*)$/.exec(prefix)
      if (!trigger) return
      const token = trigger[1], at = prefix.lastIndexOf(token)
      setSelection(null); setQuery(prefix.slice(at + token.length)); setResults([])
      setPicker({ ...state, start: at, kind: token === '/' ? 'slash' : token === '[[' ? 'wiki' : 'mention' })
    }}
    onKeyDownCapture={event => {
      if (event.nativeEvent.isComposing || !(event.target instanceof HTMLElement) || event.target.closest('[data-block-popup]')) return
      const el = event.target.closest<HTMLElement>('[data-rich-start]'); if (!el) return
      const state = readSelection(el)
      if (event.altKey && event.key === 'F10' && state && state.start !== state.end) {
        event.preventDefault(); event.stopPropagation(); setSelection(state)
        queueMicrotask(() => document.querySelector<HTMLButtonElement>('[aria-label="文字格式"] button')?.focus()); return
      }
      if (!(event.ctrlKey || event.metaKey) || !state || state.start === state.end) return
      const key = event.key.toLowerCase()
      const mark = key === 'b' ? 'bold' : key === 'i' ? 'italic' : key === 'u' ? 'underline' : key === 'e' ? 'code' : key === 'x' && event.shiftKey ? 'strike' : null
      if (mark) {
        event.preventDefault(); event.stopPropagation()
        const all = sliceSpans(state.model.spans, state.start, state.end).every(span => span.marks[mark])
        applyMarks(state, { [mark]: all ? undefined : true })
      }
    }}
    onClick={event => {
      if (!(event.target instanceof HTMLElement)) return
      const anchor = event.target.closest('a'), el = anchor?.closest<HTMLElement>('[data-rich-start]')
      if (!anchor || !el) return
      event.preventDefault(); event.stopPropagation()
      if (!(event.metaKey || event.ctrlKey)) return
      const reference = anchor.dataset.readyWiki ? { kind: 'wiki' as const, target: anchor.dataset.readyWiki }
        : { kind: 'link' as const, href: anchor.getAttribute('href') ?? anchor.dataset.readyHref ?? '' }
      void openInlineReference(reference, buffer.tabId).catch(report)
    }}>
    <BlockEditorStyles />{children}
    {selection && !picker && <InlineToolbar anchor={selection.anchor}
      marks={sliceSpans(selection.model.spans, selection.start, selection.end)[0]?.marks ?? {}}
      apply={patch => applyMarks(selection, patch)} close={close} report={report} open={ref => openInlineReference(ref, buffer.tabId)} />}
    {picker && <CommandMenu label={picker.kind === 'slash' ? '插入块' : picker.kind === 'wiki' ? '页面和标题' : '提及'} anchor={picker.anchor} items={items} close={close} initialQuery={query}
      {...(picker.kind !== 'slash' ? { query, onQuery: setQuery, pending: loading } : {})} />}
    <WidgetEditDrawer open={Boolean(widget)} input={widgetInput} onClose={() => setWidget(null)} onSave={result => {
      if (!widget) return
      const eol = newline(widget.snapshot.content)
      const json = JSON.stringify({ id: crypto.randomUUID(), title: String(result.skeletonSpec.props?.title ?? '信息卡'), skeleton_spec: result.skeletonSpec, widget_code: result.widgetCode })
      // JSON may contain backticks. A fence longer than every run keeps it intact.
      const fence = '`'.repeat(Math.max(3, ...[...json.matchAll(/`+/g)].map(match => match[0].length + 1)))
      slashMarkdown(widget, `${fence}show-widget${eol}${json}${eol}${fence}`); setWidget(null)
    }} />
    {page && createPortal(<form className="ready-block-popover" data-block-popup data-ready-native-overlay="" role="dialog" aria-label="新建子页面" style={{ left: page.picker.anchor.left, top: page.picker.anchor.bottom }}
      onSubmit={event => { event.preventDefault(); void createPage() }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' && page.state !== 'pending') setPage(null) }}>
      <input autoFocus aria-label="子页面标题" required value={page.title} disabled={page.state !== 'editing'} onChange={event => setPage({ ...page, title: event.target.value })} />
      <button disabled={page.state === 'pending'} type="submit">{page.state === 'failed' ? '重试' : '创建并插入'}</button>
      <button disabled={page.state === 'pending'} type="button" onClick={() => setPage(null)}>取消</button>
    </form>, document.body)}
  </div>
}
