import { useAnnotationMenus } from '../annotations/menus'
import { useMentionNavigation } from '../../calendar/workbench/layers/mention-navigation'
import { matchDateMentionRanges, parseDateMentions } from '../../../../shared/calendar/date-mentions'
import { DateMentionPicker } from './DateMentionPicker'
import { parseReadyUri } from '../../../../shared/ready-ref'
import type { DateMentionRef } from '../../../../shared/calendar/date-mentions'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { createBlockCommand, parseDocumentBlocks, parseInlineBlock, type DocumentBlock, type DocumentBuffer, type InlineMarks, type InlineModel, type InlineSpan } from '../../../../shared/document-blocks'
import WidgetEditDrawer from '../../../components/document/WidgetEditDrawer'
import { useDocTabs } from '../../../stores/useDocTabs'
import { CommandMenu, BlockEditorStyles, type MenuAnchor, type MenuItem } from './CommandMenu'
import { SlashMenu } from './SlashMenu'
import { SLASH_META, filterSlashItems, type SlashItem } from './slash-items'
import { CalendarClock, Sparkles } from 'lucide-react'
import { InlineToolbar } from './InlineToolbar'
import { useSceneVisible } from './scene'
import { BLOCK_KINDS, convertBlock } from './catalog'
import { getCaret, plainText, setCaret, sliceSpans } from './dom-inline'
import { emptyBlock, inlineMarkdown, newline, plainModel } from './editing'
import { capsuleSource, findReferences, openInlineReference, settledCapsuleReference, wikiTarget, workspaceRoots, type ReferenceChoice, type EditorLinkBase } from './references'
import { activateRefCapsule, enterRefCapsule, leaveRefCapsule, openRefCapsuleMenu, startRefCapsuleDrag } from '../../../components/ui/ref-capsule-actions'
import type { RefCapsuleKind } from '../../../components/ui/ref-capsule-kinds'
import type { EditorBuffer } from './editor-buffer'
import { flashElement } from '../../../design/next/motion'
import { useLeavingRef } from '../../../components/ui/leave'

interface Selection {
  block: DocumentBlock; model: InlineModel; snapshot: DocumentBuffer; start: number; end: number; anchor: MenuAnchor
}
type Picker = Selection & { kind: 'slash' | 'wiki' | 'mention' }
const widgetInput = { title: '新信息卡', widgetCode: '', skeletonSpec: { skeleton: 'single_focus', size: 'doc_block', props: { title: '新信息卡', body: '填写内容' } } }

export function EditorTools({ buffer, linkBase, children, report }: { buffer: EditorBuffer; linkBase?: EditorLinkBase; children: ReactNode; report(error: unknown): void }) {
  const extensions = useAnnotationMenus()
  const tabId = buffer.owner.kind === 'document' ? buffer.owner.tabId : undefined
  const root = useRef<HTMLDivElement>(null)
  const pageFormRef = useLeavingRef<HTMLFormElement>()
  const sceneVisible = useSceneVisible(() => root.current)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [picker, setPicker] = useState<Picker | null>(null), [query, setQuery] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  const [results, setResults] = useState<ReferenceChoice[]>([]), [loading, setLoading] = useState(false)
  const [dateMention, setDateMention] = useState<{ selection: Selection; ref: DateMentionRef } | null>(null)
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
  const mentionTarget = useMentionNavigation(s => s.target)
  useLayoutEffect(() => {
    if (!mentionTarget || !tabId || !buffer.snapshot.content) return
    const tab = useDocTabs.getState().tabs.find(tab => tab.id === tabId)
    if (tab?.path !== mentionTarget.path || useDocTabs.getState().activeTabId !== tabId) return
    try {
      const before = parseDateMentions('', mentionTarget.content), after = parseDateMentions('', buffer.snapshot.content)
      const index = before.findIndex(row => row.start === mentionTarget.start && row.end === mentionTarget.end)
      const matches = matchDateMentionRanges(mentionTarget.content, buffer.snapshot.content, before, after)
      const next = after.find((_row, j) => matches.get(j) === index)
      if (index < 0 || !next) throw new Error('当前正文中的日期提及已变更，无法定位')
      const block = parseDocumentBlocks(buffer.snapshot.content).blocks.find(block => block.start <= next.start && block.end >= next.end)
      const element = block && root.current?.querySelector<HTMLElement>(`[data-block-start="${block.start}"]`)
      if (!element) throw new Error('日期提及所在段落尚不可用')
      element.scrollIntoView({ block: 'center' })
      flashElement(element)
    } catch (error) { console.warn('[EditorTools] locate date mention failed:', error instanceof Error ? error.message : String(error)); report(error) }
    useMentionNavigation.setState({ target: null })
  }, [mentionTarget, tabId, buffer.snapshot.content, report])
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
    } catch (error) { console.warn('[EditorTools] apply inline marks failed:', error instanceof Error ? error.message : String(error)); report(error) }
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
      findReferences(query, picker.kind === 'wiki', linkBase?.filePath).then(items => { if (!cancelled) setResults(items) })
        .catch(error => { if (!cancelled) report(error) }).finally(() => { if (!cancelled) setLoading(false) })
    }, 150)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [linkBase?.filePath, picker, query, report])
  const attempt = (action: () => void) => { try { action() } catch (error) { console.warn('[EditorTools] run editor action failed:', error instanceof Error ? error.message : String(error)); report(error) } }
  /** A capsule link inside the editable text (dom-inline draws them). */
  const capsuleAt = (target: EventTarget | null) => target instanceof Element
    ? target.closest<HTMLAnchorElement>('[data-rich-start] a[data-ready-ref-capsule]') : null
  /** Opens the date picker on a date capsule; it replaces exactly that link's text. */
  function editDate(anchor: HTMLAnchorElement, ref: DateMentionRef) {
    const el = anchor.closest<HTMLElement>('[data-rich-start]')
    if (!el) return
    attempt(() => {
      buffer.flush()
      const state = readSelection(el)
      if (!state) return
      const range = document.createRange(); range.selectNodeContents(el); range.setEndBefore(anchor)
      const start = range.toString().length
      setSelection(null); setPicker(null)
      setDateMention({ selection: { ...state, start, end: start + (anchor.textContent?.length ?? 0), anchor: anchor.getBoundingClientRect() }, ref })
    })
  }
  function slashMarkdown(state: Picker, markdown: string) {
    // Only the typed trigger is consumed; existing following text is retained.
    const remainder = inlineMarkdown(plainModel(), sliceSpans(state.model.spans, state.end))
    const eol = newline(state.snapshot.content)
    buffer.apply(createBlockCommand(state.snapshot, { type: 'replace', block: state.block, markdown: markdown + (remainder ? eol + eol + remainder : '') }))
    setPicker(null); setRestore({ at: state.block.start, start: 0, end: 0 })
  }
  let items: MenuItem[] = []
  let slashItems: SlashItem[] = []
  if (picker?.kind === 'slash') {
    const current = picker, eol = newline(current.snapshot.content)
    const item = (id: string, run: () => void | Promise<void>, label?: string): SlashItem =>
      ({ ...(SLASH_META[id] ?? { group: '嵌入', label: label ?? id, description: '', icon: Sparkles, keywords: '' }), id, run })
    const all: SlashItem[] = BLOCK_KINDS.map(([kind]) => item(kind, () => attempt(() => {
      const body = inlineMarkdown(plainModel(), sliceSpans(current.model.spans, current.end))
      const block = { ...emptyBlock(0), raw: body }
      buffer.apply(createBlockCommand(current.snapshot, { type: 'replace', block: current.block, markdown: convertBlock(block, kind, eol) }))
      setPicker(null); setRestore({ at: current.block.start, start: 0, end: 0 })
    })))
    all.push(...extensions.slashItems(markdown => slashMarkdown(current, markdown)).map(extension => item(extension.id, () => { setPicker(null); extension.run() }, extension.label)))
    all.push(item('widget', () => { setPicker(null); setWidget(current) }),
      item('mermaid', () => attempt(() => slashMarkdown(current, `\`\`\`mermaid${eol}graph TD${eol}  A --> B${eol}\`\`\``))),
      item('columns', () => attempt(() => slashMarkdown(current, `<!-- ready:columns widths=1,1 -->${eol}${eol}<!-- ready:column -->${eol}${eol}<!-- ready:columns-end -->`))),
      item('table', () => attempt(() => slashMarkdown(current, `| 列 1 | 列 2 |${eol}| --- | --- |${eol}|  |  |`))),
      // Today as a date mention: the same capsule the date picker writes, editable by clicking it.
      item('date', () => attempt(() => {
        const now = new Date(), date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
        replaceSelection({ ...current, start: 0 }, [{ text: date, marks: { reference: { kind: 'ready', ref: { kind: 'day', date } } } }])
      })),
      // 链接页面 hands the typed “/…” over to the [[ picker, which replaces it with the chosen page or heading.
      item('reference', () => { setQuery(''); setResults([]); setPicker({ ...current, start: 0, kind: 'wiki' }) }),
      ...(linkBase?.parentPath ? [
        item('page', () => { setPicker(null); setPage({ picker: current, title: '', operationId: crypto.randomUUID(), state: 'editing' }) }),
        item('database', () => { setPicker(null); void createDatabase(current) }),
        item('board', () => { setPicker(null); void createBoard(current) }),
      ] : []))
    slashItems = filterSlashItems(all, query)
  } else if (picker) items = results.map(result => ({ ...result, run: () => attempt(() => replaceSelection(picker, [{ text: result.text, marks: { reference: result.reference } }])) }))
  /** 数据库: a new database in the page's own folder, shown inline (its 表格 view) where “/” was typed. */
  async function createDatabase(state: Picker) {
    try {
      const parent = linkBase?.parentPath
      if (!parent) throw new Error('请先保存当前页面，再新建数据库')
      const vault = await window.electronAPI.vault.get()
      if (vault.status !== 'ready') throw new Error('请先设置资料库')
      const result = await window.electronAPI.documentPages.operate({ type: 'create', operationId: crypto.randomUUID(), root: vault.root, parentPath: parent, title: '未命名数据库', database: true })
      if (!result.ok) throw new Error(result.message)
      if (!result.value.path) throw new Error('新数据库没有返回路径')
      const target = result.value.path.replace(/\\/g, '/').slice(vault.root.replace(/\\/g, '/').replace(/\/$/, '').length + 1).replace(/\.md$/i, '')
      if (buffer.snapshot.version !== state.snapshot.version) throw new Error(`数据库已建在 ${result.value.path}；正文已变化，未插入视图。`)
      slashMarkdown(state, `![[${target}#表格]]`)
    } catch (error) { console.warn('[EditorTools] create database failed:', error instanceof Error ? error.message : String(error)); report(error) }
  }
  /** 画板: a new board in the page's own folder (A.md → A/), linked from where “/” was typed. */
  async function createBoard(state: Picker) {
    try {
      const parent = linkBase?.parentPath
      if (!parent) throw new Error('请先保存当前页面，再新建画板')
      const vault = await window.electronAPI.vault.get()
      if (vault.status !== 'ready') throw new Error('请先设置资料库')
      const root = vault.root.replace(/\\/g, '/').replace(/\/$/, ''), folder = parent.replace(/\\/g, '/').replace(/\.md$/i, '')
      if (!folder.startsWith(`${root}/`)) throw new Error('当前页面不在资料库中')
      let name = '未命名画板'
      for (let n = 2; (await window.electronAPI.document.stat(`${folder}/${name}.canvas`))?.success; n++) name = `未命名画板 ${n}`
      const mkdir = await window.electronAPI.document.mkdir(folder)
      if (!mkdir.success) throw new Error(mkdir.error || '无法建立页面文件夹')
      const created = await window.electronAPI.canvas.create({ path: `${folder.slice(root.length + 1)}/${name}.canvas`, operationId: crypto.randomUUID() })
      if (!created.ok) throw new Error(created.error)
      await window.electronAPI.canvas.release(created.value.handleId)
      const target = await wikiTarget(linkBase?.filePath, `${root}/${created.value.path}`)
      if (buffer.snapshot.version !== state.snapshot.version) throw new Error(`画板已建在 ${created.value.path}；正文已变化，未插入链接。`)
      replaceSelection(state, [{ text: target, marks: { reference: { kind: 'wiki', target } } }])
    } catch (error) { console.warn('[EditorTools] create board failed:', error instanceof Error ? error.message : String(error)); report(error) }
  }
  async function createPage() {
    if (!page || pagePending.current) return
    pagePending.current = true; setPage({ ...page, state: 'pending' })
    try {
      const path = linkBase?.parentPath
      if (!path) throw new Error('请先保存当前页面，再创建子页面')
      if (/[[\]|#\r\n]/.test(path + page.title)) throw new Error('页面路径或名称不能表示为 Wiki 引用')
      const rootPath = workspaceRoots().filter(root => path.startsWith(root.replace(/[/\\]$/, '') + '/')).sort((a, b) => b.length - a.length)[0]
      if (!rootPath) throw new Error('当前页面不在已打开的资料库中')
      if (buffer.snapshot.version !== page.picker.snapshot.version) throw new Error('正文已经改变，请取消后重新插入')
      const result = await window.electronAPI.documentPages.operate({ type: 'create', operationId: page.operationId, root: rootPath, parentPath: path, title: page.title })
      if (!result.ok) throw new Error(result.message)
      if (!result.value.path) throw new Error('新页面没有返回路径')
      const target = await wikiTarget(linkBase?.filePath, result.value.path)
      if (buffer.snapshot.version !== page.picker.snapshot.version) throw new Error(`页面已创建在 ${result.value.path}；正文已变化，未插入链接。请取消并从 [[ 选择器插入。`)
      replaceSelection(page.picker, [{ text: target, marks: { reference: { kind: 'wiki', target } } }])
      setPage(null)
    } catch (error) { console.warn('[EditorTools] create child page failed:', error instanceof Error ? error.message : String(error)); report(error); setPage({ ...page, state: 'failed' }) } finally { pagePending.current = false }
  }
  /**
   * Opens or updates a picker from the text before the caret. The slash menu reads its query from the page (“/标题”),
   * so it updates on every input and closes once the “/” is gone; [[ and @ open their own search field.
   */
  function detectPicker(target: EventTarget) {
    if (!(target instanceof HTMLElement) || !target.matches('[data-rich-start]')) return
    const state = readSelection(target)
    if (!state || state.start !== state.end) { if (picker?.kind === 'slash') setPicker(null); return }
    const prefix = plainText(state.model.spans).slice(0, state.end)
    const slash = /^\/([^\r\n]*)$/.exec(prefix)
    if (slash) {
      if (picker?.kind !== 'slash' || query !== slash[1]) setSlashIndex(0)
      setSelection(null); setQuery(slash[1]); setPicker({ ...state, start: 0, kind: 'slash' })
      return
    }
    if (picker?.kind === 'slash') setPicker(null)
    const trigger = /(\[\[)([^[\]\r\n]*)$/.exec(prefix) ?? /(?:^|\s)(@)([^@\r\n]*)$/.exec(prefix)
    if (!trigger) return
    const token = trigger[1], at = prefix.lastIndexOf(token)
    if (token === '[[' && !linkBase) return
    setSelection(null); setQuery(prefix.slice(at + token.length)); setResults([])
    setPicker({ ...state, start: at, kind: token === '[[' ? 'wiki' : 'mention' })
  }
  // A query that matches nothing and ends with a space means the writer moved on.
  const slashStale = picker?.kind === 'slash' && !slashItems.length && /\s$/.test(query)
  useEffect(() => { if (slashStale) setPicker(null) }, [slashStale])
  // .ready-block-flow: the page's top-level blocks are this wrapper's children; the page's block spacing is keyed to it.
  return <div ref={root} className="ready-block-flow" onMouseUp={select} onKeyUp={select}
    onInput={event => { if (!('isComposing' in event.nativeEvent && event.nativeEvent.isComposing)) detectPicker(event.target) }}
    onCompositionEnd={event => detectPicker(event.target)}
    onKeyDownCapture={event => {
      if (event.nativeEvent.isComposing || !(event.target instanceof HTMLElement) || event.target.closest('[data-block-popup]')) return
      if (picker?.kind === 'slash') {
        const count = slashItems.length, index = Math.min(slashIndex, Math.max(0, count - 1))
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count) {
          event.preventDefault(); event.stopPropagation()
          setSlashIndex((index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count); return
        }
        if (event.key === 'Enter' && count) { event.preventDefault(); event.stopPropagation(); void slashItems[index].run(); return }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
      }
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
      const parsed = parseReadyUri(anchor.getAttribute('href') ?? '')
      // A date in the text is a value you edit: clicking it opens its picker (which can open the day), as in C9.
      if (parsed.ok && parsed.ref.kind === 'day' && !(event.metaKey || event.ctrlKey || event.altKey)) { editDate(anchor, parsed.ref); return }
      if (anchor.matches('[data-ready-ref-capsule]')) { activateRefCapsule(event, capsuleSource(anchor, linkBase?.filePath)); return }
      if (!(event.metaKey || event.ctrlKey)) return
      void openInlineReference({ kind: 'link' as const, href: anchor.getAttribute('href') ?? anchor.dataset.readyHref ?? '' }, linkBase?.filePath).catch(report)
    }}
    onContextMenu={event => {
      const anchor = capsuleAt(event.target)
      if (!anchor) return
      const parsed = parseReadyUri(anchor.getAttribute('href') ?? '')
      const extra = parsed.ok && parsed.ref.kind === 'day' ? [{ id: 'edit-date', label: '修改日期与提醒…', icon: <CalendarClock />, onSelect: () => editDate(anchor, parsed.ref as DateMentionRef) }] : []
      openRefCapsuleMenu({ clientX: event.clientX, clientY: event.clientY, currentTarget: anchor, preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() },
        capsuleSource(anchor, linkBase?.filePath), anchor.textContent ?? '', anchor.dataset.refKind as RefCapsuleKind, extra)
    }}
    onDragStart={event => {
      const anchor = capsuleAt(event.target)
      if (anchor) startRefCapsuleDrag(event, settledCapsuleReference(anchor), anchor.textContent ?? '')
    }}
    onMouseOver={event => {
      const anchor = capsuleAt(event.target)
      if (!anchor || (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) return
      const source = capsuleSource(anchor, linkBase?.filePath)
      // Resolving a [[wiki]] target on hover lets a drag that follows carry it.
      if (typeof source === 'function') void source().catch(() => undefined)
      enterRefCapsule(anchor, source, anchor.textContent ?? '', anchor.dataset.refKind as RefCapsuleKind)
    }}
    onMouseOut={event => {
      const anchor = capsuleAt(event.target)
      if (anchor && !(event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) leaveRefCapsule(anchor)
    }}>
    <BlockEditorStyles />{children}
    {sceneVisible && dateMention && <DateMentionPicker value={dateMention.ref} anchor={dateMention.selection.anchor} report={report}
      close={() => setDateMention(null)} open={() => openInlineReference({ kind: 'ready', ref: dateMention.ref }, linkBase?.filePath)}
      save={ref => {
        replaceSelection(dateMention.selection, [{ text: `${ref.date}${ref.at ? ` ${ref.at}` : ''}`, marks: { reference: { kind: 'ready', ref } } }])
        setDateMention(null)
      }} />}
    {sceneVisible && selection && !picker && <InlineToolbar anchor={selection.anchor}
      marks={sliceSpans(selection.model.spans, selection.start, selection.end)[0]?.marks ?? {}}
      apply={patch => applyMarks(selection, patch)} close={close} report={report} open={ref => openInlineReference(ref, linkBase?.filePath)} />}
    {sceneVisible && picker?.kind === 'slash' && <SlashMenu anchor={picker.anchor} items={slashItems} active={Math.min(slashIndex, Math.max(0, slashItems.length - 1))}
      onActive={setSlashIndex} onChoose={choice => { void choice.run() }} onClose={close} />}
    {sceneVisible && picker && picker.kind !== 'slash' && <CommandMenu label={picker.kind === 'wiki' ? '页面和标题' : '提及'} anchor={picker.anchor} items={items} close={close}
      initialQuery={query} query={query} onQuery={setQuery} pending={loading} />}
    <WidgetEditDrawer open={Boolean(widget)} input={widgetInput} onClose={() => setWidget(null)} onSave={result => {
      if (!widget) return
      const eol = newline(widget.snapshot.content)
      const json = JSON.stringify({ id: crypto.randomUUID(), title: String(result.skeletonSpec.props?.title ?? '信息卡'), skeleton_spec: result.skeletonSpec, widget_code: result.widgetCode })
      // JSON may contain backticks. A fence longer than every run keeps it intact.
      const fence = '`'.repeat(Math.max(3, ...[...json.matchAll(/`+/g)].map(match => match[0].length + 1)))
      slashMarkdown(widget, `${fence}show-widget${eol}${json}${eol}${fence}`); setWidget(null)
    }} />
    {sceneVisible && page && createPortal(<form ref={pageFormRef} className="rn-ui rn-float ready-block-popover" data-float-motion="down" data-block-popup data-ready-native-overlay="" role="dialog" aria-label="新建子页面" style={{ left: page.picker.anchor.left, top: page.picker.anchor.bottom }}
      onSubmit={event => { event.preventDefault(); void createPage() }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' && page.state !== 'pending') setPage(null) }}>
      <input autoFocus className="rn-field" aria-label="子页面标题" required value={page.title} disabled={page.state !== 'editing'} onChange={event => setPage({ ...page, title: event.target.value })} />
      <button disabled={page.state === 'pending'} type="submit">{page.state === 'failed' ? '重试' : '创建并插入'}</button>
      <button disabled={page.state === 'pending'} type="button" onClick={() => setPage(null)}>取消</button>
    </form>, document.body)}
  </div>
}
