import { explicitBlockId, markBlock, blockWithMarker } from '../../../../shared/document-anchors'
import { useAnnotationMenus } from '../annotations/menus'
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { createBlockCommand, createRangeEdit, parseDocumentBlocks, parseInlineBlock, replaceRanges, DOCUMENT_PALETTE, isDocumentColor, type DocumentBlock, type DocumentBuffer } from '../../../../shared/document-blocks'
import { useDocTabs } from '../../../stores/useDocTabs'
import { useSceneVisible } from './scene'
import { actionableBlocks, BLOCK_KINDS, convertBlock } from './catalog'
import { CommandMenu, type MenuAnchor, type MenuItem } from './CommandMenu'
import { inlineMarkdown, newline } from './editing'
import type { EditorBuffer } from './editor-buffer'
import type { EditorLinkBase } from './references'
import { toReadyUri, writeReadyRefTransfer } from '../../../../shared/ready-ref'
import { receiveToCanvas } from '../../workbench/capture-receipt'

interface Drag { block: DocumentBlock; snapshot: DocumentBuffer; target: DocumentBlock; placement: 'before' | 'after' }
interface Controls {
  menu(block: DocumentBlock, anchor: MenuAnchor): void
  drag: Drag | null
  start(block: DocumentBlock, data?: DataTransfer): void
  over(block: DocumentBlock, placement: 'before' | 'after'): void
  drop(): void
  cancel(): void
  step(direction: number): void
  /** Whether the block being moved may land beside this one: a list entry among its siblings, any other block among the page's blocks. */
  accepts(target: DocumentBlock, actionable: boolean): boolean
}
const isItem = (block: DocumentBlock) => block.type === 'listItem' || block.type === 'taskItem'
const Context = createContext<Controls | null>(null)

/** T1 owns validation and writes. Column entry/exit combines its delete and paste
 * commands into one checked range edit; no intermediate buffer is published. */
function moveEdit(snapshot: DocumentBuffer, block: DocumentBlock, target: DocumentBlock, placement: 'before' | 'after') {
  block = blockWithMarker(snapshot.content, block); target = blockWithMarker(snapshot.content, target)
  if (!target.raw) placement = 'before' // Empty columns end exactly at their closing marker.
  const parsed = parseDocumentBlocks(snapshot.content), eol = newline(snapshot.content)
  const prefix = placement === 'after' ? eol + eol : '', suffix = placement === 'before' ? eol + eol : ''
  if (block.type === 'columns' && target.parentId) throw new Error('分栏不能嵌套')
  if (block.capability === 'rich' && block.parentId === target.parentId) return createBlockCommand(snapshot, { type: 'move', block, target, placement, prefix, suffix })
  const from = parsed.blocks.find(item => item.id === block.parentId), to = parsed.blocks.find(item => item.id === target.parentId)
  const at = placement === 'before' ? target.start : target.end
  if (block.capability === 'rich' && from?.type === 'column' && to?.type === 'column' && from.parentId === to.parentId) {
    return createBlockCommand(snapshot, { type: 'moveInColumns', block, fromColumn: from, toColumn: to, at, prefix, suffix })
  }
  if ((from && from.type !== 'column') || (to && to.type !== 'column') || (at >= block.start && at <= block.end)) throw new Error('不能移动到这个位置')
  const remove = createBlockCommand(snapshot, block.capability === 'rich' ? { type: 'delete', block: blockWithMarker(snapshot.content, block) } : { type: 'replace', mode: 'source', block: blockWithMarker(snapshot.content, block), markdown: '' })
  const insert = createBlockCommand(snapshot, { type: 'paste', at, markdown: block.raw, prefix, suffix })
  const cursor = at - (at > block.end ? block.raw.length : 0) + prefix.length
  return createRangeEdit(snapshot, [...remove.operation.ranges, ...insert.operation.ranges], remove.selectionBefore, { anchor: cursor, focus: cursor })
}

/** A list entry moves among its siblings as whole lines: its own line break goes with it, so the list stays tight. */
function moveItemEdit(snapshot: DocumentBuffer, block: DocumentBlock, target: DocumentBlock, placement: 'before' | 'after') {
  const { content } = snapshot, eol = newline(content)
  const lineStart = (at: number) => { while (at > 0 && content[at - 1] !== '\n' && content[at - 1] !== '\r') at--; return at }
  const from = lineStart(block.start), to = lineStart(target.start)
  if (block.parentId !== target.parentId || !/^[ \t>]*$/.test(content.slice(from, block.start) + content.slice(to, target.start))) throw new Error('不能移动到这个位置')
  const after = /^(?:\r\n|\n|\r)/.exec(content.slice(block.end)), before = /(?:\r\n|\n|\r)$/.exec(content.slice(0, from))
  const remove = after ? { start: from, end: block.end + after[0].length } : before ? { start: from - before[0].length, end: block.end } : { start: from, end: block.end }
  const at = placement === 'before' ? to : target.end
  if (at >= remove.start && at <= remove.end) return null
  const lead = content.slice(to, target.start)
  const edit = createRangeEdit(snapshot, [
    { ...remove, expectedText: content.slice(remove.start, remove.end), replacement: '' },
    { start: at, end: at, expectedText: '', replacement: placement === 'before' ? lead + block.raw + eol : eol + lead + block.raw },
  ], { anchor: block.start, focus: block.start }, { anchor: Math.min(at, remove.start), focus: Math.min(at, remove.start) })
  return replaceRanges(content, edit.operation, snapshot.version) === content ? null : edit
}

export function BlockControls({ buffer, linkBase, editorId, report, children }: { editorId: string; linkBase?: EditorLinkBase; buffer: EditorBuffer; report(error: unknown): void; children: ReactNode }) {
  const extensions = useAnnotationMenus()
  const owner = buffer.owner
  const canvasPath = linkBase?.filePath
  const [menu, setMenu] = useState<{ block: DocumentBlock; snapshot: DocumentBuffer; anchor: MenuAnchor } | null>(null)
  const sceneVisible = useSceneVisible(() => [...document.querySelectorAll('[data-ready-block-editor]')].find(element => element instanceof HTMLElement && element.dataset.readyBlockEditor === editorId))
  const [drag, setDrag] = useState<Drag | null>(null), dragRef = useRef<Drag | null>(null)
  const [busy, setBusy] = useState(false), busyRef = useRef(false)
  const [restoreAt, setRestoreAt] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (restoreAt === null) return
    const editor = [...document.querySelectorAll<HTMLElement>('[data-ready-block-editor]')].find(el => el.dataset.readyBlockEditor === editorId)
    const block = [...(editor?.querySelectorAll<HTMLElement>('[data-block-start]') ?? [])].find(el => Number(el.dataset.blockStart) >= restoreAt)
    ;(block?.querySelector<HTMLElement>('[data-rich-start], button') ?? editor?.querySelector<HTMLElement>('button'))?.focus()
    setRestoreAt(null)
  }, [restoreAt, editorId])
  const closeMenu = () => { if (menu) setRestoreAt(menu.block.start); setMenu(null) }
  const changeDrag = (next: Drag | null) => { dragRef.current = next; setDrag(next) }
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') changeDrag(null) }
    window.addEventListener('keydown', cancel)
    const blur = () => changeDrag(null)
    window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', cancel); window.removeEventListener('blur', blur) }
  }, [])
  const run = (action: () => void | Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    const done = () => { busyRef.current = false; setBusy(false) }
    try {
      const result = action()
      if (result instanceof Promise) { void result.then(closeMenu).catch(report).finally(done); return }
      closeMenu(); done()
    } catch (error) { console.warn('[BlockControls] run block action failed:', error instanceof Error ? error.message : String(error)); report(error); done() }
  }
  const drop = () => {
    const current = dragRef.current; changeDrag(null)
    if (!current || current.block.id === current.target.id) return
    try {
      const edit = isItem(current.block) ? moveItemEdit(current.snapshot, current.block, current.target, current.placement) : moveEdit(current.snapshot, current.block, current.target, current.placement)
      if (edit) buffer.apply(edit, 'drag')
    } catch (error) { console.warn('[BlockControls] move block failed:', error instanceof Error ? error.message : String(error)); report(error) }
  }
  let items: MenuItem[] = []
  if (menu) {
    const { block, snapshot } = menu, eol = newline(snapshot.content)
    const replace = (markdown: string) => { buffer.apply(createBlockCommand(snapshot, { type: 'replace', mode: 'source', block, markdown })) }
    const action = (id: string, label: string, fn: () => void | Promise<void>): MenuItem => ({ id, label, run: () => run(fn) })
    items = BLOCK_KINDS.map(([kind, label]) => action(kind, label, () => {
      if (block.type === 'callout' && ['NOTE', 'TIP', 'WARNING'].includes(kind)) buffer.apply(createBlockCommand(snapshot, { type: 'callout', block, calloutType: kind, fold: block.callout?.fold ?? '' }))
      else replace(convertBlock(block, kind, eol))
    }))
    items.push(...extensions.blockItems(block, snapshot).map(item => ({ ...item, run: () => run(item.run) })))
    items.push(action('duplicate', '复制', () => { buffer.apply(createBlockCommand(snapshot, { type: 'insertAfter', block, markdown: block.raw, prefix: eol + eol, suffix: '' })) }),
      action('delete', '删除', () => { buffer.apply(createBlockCommand(snapshot, block.capability === 'rich' ? { type: 'delete', block: blockWithMarker(snapshot.content, block) } : { type: 'replace', mode: 'source', block: blockWithMarker(snapshot.content, block), markdown: '' })) }),
      ...(['before', 'after'] as const).map((placement, index) => action(`move-${placement}`, index ? '下移' : '上移', () => {
        const siblings = actionableBlocks(snapshot.content).filter(item => item.parentId === block.parentId)
        const target = siblings[siblings.findIndex(item => item.id === block.id) + (index ? 1 : -1)]
        if (target) buffer.apply(moveEdit(snapshot, block, target, placement), 'drag')
      })),
      ...(owner.kind === 'document' || (canvasPath && owner.nodeId) ? [action('reference', '复制块引用', async () => {
        if (!navigator.clipboard) throw new Error('当前环境无法访问剪贴板')
        if (owner.kind === 'canvas') {
          if (!canvasPath) throw new Error('尚未提供画板文件路径')
          const location = await window.electronAPI.objects.resolvePath(canvasPath)
          await navigator.clipboard.writeText(toReadyUri({ kind: 'canvas', id: location.objectId, node: owner.nodeId }))
          return
        }
        const tab = useDocTabs.getState().tabs.find(item => item.id === owner.tabId)
        if (!tab) throw new Error('文档已关闭')
        const page = (tab.path ?? tab.title).replace(/\.md$/i, '')
        if (/[[\]|#\r\n]/.test(page)) throw new Error('页面路径不能表示为 Wiki 引用')
        const existing = explicitBlockId(snapshot.content, block)
        const id = existing ?? `block-${crypto.randomUUID()}`
        if (!existing) replace(markBlock(snapshot.content, block, id))
        await navigator.clipboard.writeText(`[[${page}#^${id}]]`)
      })] : []),
      // 发送到画板 (W6 §3.2): the block's text as a card; its source is the block when it has an id, else the page.
      ...(owner.kind === 'document' ? [action('canvas', '发送到画板', async () => {
        const tab = useDocTabs.getState().tabs.find(item => item.id === owner.tabId)
        if (!tab?.objectId) throw new Error('请先把页面保存到资料库，再发送到画板')
        const id = explicitBlockId(snapshot.content, block)
        await receiveToCanvas({ ref: { kind: 'page', id: tab.objectId, ...(id ? { anchor: `^${id}` } : {}) },
          title: tab.title.replace(/\.md$/i, ''), text: block.raw.replace(/[ \t]+\^[\w-]+\s*$/, '').trim() })
      })] : []),
      ...Object.entries(DOCUMENT_PALETTE).map(([color, label]) => action(`color-${color}`, `文字颜色：${label}`, () => {
        if (!isDocumentColor(color)) throw new Error('无效颜色')
        const blocks = parseDocumentBlocks(snapshot.content).blocks.filter(part => part.start >= block.start && part.end <= block.end
          && ['paragraph', 'heading', 'wikiLink'].includes(part.type) && part.capability === 'rich')
        if (!blocks.length) throw new Error('此块不能整体设置行内颜色，请使用源码编辑')
        const edits = blocks.map(part => {
          const model = parseInlineBlock(part.raw)
          if (model.capability !== 'rich') throw new Error(model.reason)
          const markdown = inlineMarkdown(model, model.spans.map(span => ({ ...span, marks: { ...span.marks, color: color === 'default' ? undefined : color } })))
          return createBlockCommand(snapshot, { type: 'replace', block: part, markdown })
        })
        buffer.apply(createRangeEdit(snapshot, edits.flatMap(edit => edit.operation.ranges), edits[0].selectionBefore, edits[0].selectionAfter))
      })))
  }
  return <Context.Provider value={{ drag, cancel: () => changeDrag(null), drop,
    accepts: (target, actionable) => { const moving = dragRef.current?.block; return !!moving && (isItem(moving) ? isItem(target) && target.parentId === moving.parentId : actionable) },
    menu: (block, anchor) => { try { buffer.flush(); setMenu({ block, snapshot: buffer.snapshot, anchor }) } catch (error) { console.warn('[BlockControls] open block menu failed:', error instanceof Error ? error.message : String(error)); report(error) } },
    start: (block, data) => { try {
      buffer.flush()
      if (data && owner.kind === 'document') {
        const tab = useDocTabs.getState().tabs.find(tab => tab.id === owner.tabId)
        if (tab?.objectId) {
          const id = explicitBlockId(buffer.snapshot.content, block)
          writeReadyRefTransfer(data, { kind: 'page', id: tab.objectId, ...(id ? { anchor: '^' + id } : {}) }, block.raw.slice(0, 120).replace(/[\r\n]/g, ' '))
        }
      }
      changeDrag({ block, snapshot: buffer.snapshot, target: block, placement: 'before' })
    } catch (error) { console.warn('[BlockControls] start block drag failed:', error instanceof Error ? error.message : String(error)); report(error) } },
    over: (target, placement) => { if (dragRef.current) changeDrag({ ...dragRef.current, target, placement }) },
    step: direction => {
      const current = dragRef.current; if (!current) return
      const candidates = actionableBlocks(current.snapshot.content).filter(item => item.id === current.block.id || item.start < current.block.start || item.start >= current.block.end)
      const index = candidates.findIndex(item => item.id === current.target.id)
      const target = candidates[Math.min(candidates.length - 1, Math.max(0, index + direction))]
      if (target) changeDrag({ ...current, target, placement: direction > 0 ? 'after' : 'before' })
    },
  }}>{children}
    {drag && <p role="status">正在移动块；方向键选择位置，Enter 放下，Esc 取消。</p>}
    {sceneVisible && menu && <CommandMenu label="块菜单" anchor={menu.anchor} items={items} close={closeMenu} pending={busy} />}
  </Context.Provider>
}

export function BlockShell({ block, line, actionable, children }: { block: DocumentBlock; line: number; actionable: boolean; children: ReactNode }) {
  const landing = actionable || isItem(block)
  const controls = useContext(Context)!
  const preview = controls.drag?.target.id === block.id && controls.drag.block.id !== block.id ? controls.drag.placement : undefined
  return <div className="note-preview-render-block ready-block-shell" data-block-start={block.start} data-block-type={block.type}
    data-ready-block-source-line={line} data-drop={preview} data-actionable={actionable || undefined}
    // A table's handles and its add-column bar sit just outside its box, so this block must not clip its paint.
    style={block.type === 'table' ? { contentVisibility: 'visible' } : undefined}
    onDragOver={event => {
      if (!landing || !controls.accepts(block, actionable)) return
      event.preventDefault(); event.stopPropagation()
      const rect = event.currentTarget.getBoundingClientRect()
      controls.over(block, event.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
    }} onDrop={event => { if (actionable || controls.accepts(block, actionable)) { event.preventDefault(); event.stopPropagation(); controls.drop() } }}>
    {actionable && <button type="button" className="ready-block-handle" aria-label="块菜单" title="块菜单；空格开始移动" draggable
      onDragStart={event => { event.stopPropagation(); controls.start(block, event.dataTransfer) }}
      onDragEnd={() => controls.cancel()} onClick={event => controls.menu(block, event.currentTarget.getBoundingClientRect())}
      onKeyDown={event => {
        if (![' ', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        if (event.key === 'Escape') controls.cancel()
        else if (controls.drag) {
          if (event.key === 'Enter' || event.key === ' ') controls.drop()
          else controls.step(event.key === 'ArrowDown' ? 1 : -1)
        } else if (event.key === ' ') controls.start(block)
        else if (event.key === 'Enter') controls.menu(block, event.currentTarget.getBoundingClientRect())
      }}>⠿</button>}{children}
  </div>
}

/**
 * A list entry's marker. The bullet or number is the entry's handle: dragging it moves the entry among its siblings
 * (the page's own block handle belongs to the whole list). A task's marker is also its checkbox.
 */
export function ItemMarker({ block, kind, text, checked, label, onToggle }: {
  block: DocumentBlock; kind: 'task' | 'number' | 'bullet'; text: string; checked?: boolean; label?: string; onToggle?(): void
}) {
  const controls = useContext(Context)!
  const drag = {
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => { event.stopPropagation(); event.dataTransfer.effectAllowed = 'move'; controls.start(block, event.dataTransfer) },
    onDragEnd: () => controls.cancel(),
  }
  if (kind === 'task') return <button type="button" role="checkbox" aria-checked={!!checked} aria-label={label} title="点一下勾选或取消；拖动可排序"
    className="ready-block-marker is-task" data-checked={!!checked} onClick={onToggle} {...drag} />
  return <span aria-hidden title="拖动可排序" className={`ready-block-marker is-${kind}`} {...drag}>{text}</span>
}
