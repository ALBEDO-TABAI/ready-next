import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { GripHorizontal, GripVertical, Plus } from 'lucide-react'
import { createRangeEdit, parseInlineBlock, type DocumentBlock } from '../../../../shared/document-blocks'
import { anchorOf, openMenu, type MenuEntry } from '../../../components/ui'
import { atVerticalEdge, drawInline, getCaret, plainText, readInline, setCaret, sliceSpans } from './dom-inline'
import { inlineMarkdown, plainModel } from './editing'
import type { EditorBuffer } from './editor-buffer'
import {
  cellMarkdown, columnAlign, deleteColumn, deleteRow, insertColumn, insertRow, moveColumn, moveRow, setCell,
  type TableCell, type TableModel,
} from './table-model'

// A Markdown table in the page view (design language plan §1.8): every cell edits in place; a row is added from
// the bar under the table and a column from the bar at its right, both quiet until the pointer comes near; the
// handle on a column's top edge or a row's left edge opens insert, move and delete.

interface CellProps {
  cell: TableCell; row: number; column: number; start: number; header: boolean; align?: 'left' | 'center' | 'right'
  write(row: number, column: number, markdown: string): void
  keys(event: ReactKeyboardEvent<HTMLElement>, row: number, column: number, commit: () => void): void
  report(error: unknown): void
}
function Cell({ cell, row, column, start, header, align, write, keys, report }: CellProps) {
  const ref = useRef<HTMLTableCellElement>(null)
  const composing = useRef(false)
  const session = useRef({ raw: cell.raw, dirty: false })
  useLayoutEffect(() => {
    const el = ref.current!
    if (composing.current || session.current.dirty) return
    if (document.activeElement !== el || session.current.raw !== cell.raw) {
      const caret = document.activeElement === el ? getCaret(el) : null
      const model = parseInlineBlock(cell.raw)
      drawInline(el, model.capability === 'rich' ? model.spans : [{ text: cell.raw, marks: {} }])
      if (caret) setCaret(el, caret.start, caret.end, caret.backward)
    }
    session.current = { raw: cell.raw, dirty: false }
  }, [cell.raw])
  const commit = () => {
    const state = session.current
    if (!state.dirty) return
    if (composing.current) throw new Error('请先完成当前输入法组合输入，再保存或撤销')
    const parsed = parseInlineBlock(state.raw), model = parsed.capability === 'rich' ? parsed : plainModel()
    const markdown = cellMarkdown(inlineMarkdown(model, readInline(ref.current!)))
    state.dirty = false
    if (markdown !== state.raw) { state.raw = markdown; write(row, column, markdown) }
  }
  const attempt = (action: () => void) => { try { action() } catch (error) { console.warn('[TableBlock] edit table cell failed:', error instanceof Error ? error.message : String(error)); report(error) } }
  const Tag = header ? 'th' : 'td'
  return <Tag ref={ref} role="textbox" aria-label={header ? '编辑表头' : '编辑单元格'} contentEditable suppressContentEditableWarning
    className={header ? 'note-preview-markdown-th' : 'note-preview-markdown-td'} data-table-cell={`${row}:${column}`} data-rich-start={start < 0 ? undefined : start}
    style={{ textAlign: align, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
    onInput={() => { session.current.dirty = true; if (!composing.current) attempt(commit) }}
    onCompositionStart={() => { composing.current = true }}
    onCompositionEnd={() => { composing.current = false; session.current.dirty = true; attempt(commit) }}
    onBlur={() => attempt(commit)}
    onKeyDown={event => { if (!composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) keys(event, row, column, () => attempt(commit)) }}
    onPaste={event => {
      if (composing.current) return
      event.preventDefault(); event.stopPropagation()
      attempt(() => {
        const el = ref.current!, caret = getCaret(el), html = event.clipboardData.getData('text/html')
        let pasted
        if (html) { const template = document.createElement('template'); template.innerHTML = html; pasted = readInline(template.content, ' ') }
        else pasted = [{ text: event.clipboardData.getData('text/plain'), marks: {} }]
        pasted = pasted.map(span => ({ ...span, text: span.text.replace(/\s*[\r\n]+\s*/g, ' ') }))
        const spans = readInline(el)
        drawInline(el, [...sliceSpans(spans, 0, caret.start), ...pasted, ...sliceSpans(spans, caret.end)])
        setCaret(el, caret.start + plainText(pasted).length); session.current.dirty = true; commit()
      })
    }} />
}

interface Hover { row: number; column: number; left: number; top: number; width: number; height: number }

export function TableBlock({ block, model, buffer, report }: { block: DocumentBlock; model: TableModel; buffer: EditorBuffer; report(error: unknown): void }) {
  const root = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  const [near, setNear] = useState('')
  const [pending, setPending] = useState<{ row: number; column: number } | null>(null)
  const group = useRef(0)
  const live = useRef({ block, model }); live.current = { block, model }
  const rows = model.rows.length, columns = model.align.length
  const cellAt = (row: number, column: number) => root.current?.querySelector<HTMLElement>(`[data-table-cell="${row}:${column}"]`)
  useLayoutEffect(() => {
    if (!pending) return
    const el = cellAt(pending.row, pending.column)
    if (el) { el.focus(); setCaret(el, el.textContent?.length ?? 0) }
    setPending(null)
  }, [pending, block.raw])
  const attempt = (action: () => void) => { try { action() } catch (error) { console.warn('[TableBlock] change table failed:', error instanceof Error ? error.message : String(error)); report(error) } }
  /** Replaces the whole table (a structural change) as one history step; `focus` is the cell to continue in. */
  const restructure = (next: (model: TableModel) => string, focus?: { row: number; column: number }) => attempt(() => {
    buffer.flush()
    const { block: current, model: table } = live.current, raw = next(table)
    buffer.apply(createRangeEdit(buffer.snapshot, [{ start: current.start, end: current.end, expectedText: current.raw, replacement: raw }],
      { anchor: current.start, focus: current.start }, { anchor: current.start, focus: current.start }), 'edit')
    setHover(null)
    if (focus) setPending(focus)
  })
  const write = (row: number, column: number, markdown: string) => {
    const { block: current, model: table } = live.current
    const edit = setCell(current.raw, table, row, column, markdown), at = current.start + edit.start + edit.replacement.length
    buffer.apply(createRangeEdit(buffer.snapshot, [{ start: current.start + edit.start, end: current.start + edit.end, expectedText: current.raw.slice(edit.start, edit.end), replacement: edit.replacement }],
      { anchor: current.start + edit.start, focus: current.start + edit.start }, { anchor: at, focus: at }), 'typing', `cell:${current.start}:${row}:${column}:${group.current}`)
  }
  const go = (row: number, column: number) => { const el = cellAt(row, column); if (el) { el.focus(); setCaret(el, el.textContent?.length ?? 0) } }
  /** Leaves the table for the editable text before or after it. */
  const leave = (direction: 'up' | 'down') => {
    const all = [...(root.current?.closest('[data-ready-block-editor]')?.querySelectorAll<HTMLElement>('[data-rich-start]') ?? [])]
    const own = all.filter(el => root.current!.contains(el))
    const next = direction === 'up' ? all[all.indexOf(own[0]) - 1] : all[all.indexOf(own[own.length - 1]) + 1]
    if (next) { next.focus(); setCaret(next, direction === 'up' ? next.textContent?.length ?? 0 : 0) }
  }
  const keys = (event: ReactKeyboardEvent<HTMLElement>, row: number, column: number, commit: () => void) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') return // the editor's history
    const el = event.currentTarget
    if (event.key === 'Tab') {
      event.preventDefault(); commit(); group.current++
      const index = row * columns + column + (event.shiftKey ? -1 : 1)
      if (index < 0) return
      if (index >= rows * columns) restructure(table => insertRow(table, table.rows.length), { row: rows, column: 0 })
      else go(Math.floor(index / columns), index % columns)
    } else if (event.key === 'Enter') {
      // A cell is one line: Enter moves down the column, and adds a row under the last one.
      event.preventDefault(); commit(); group.current++
      if (row + 1 >= rows) restructure(table => insertRow(table, table.rows.length), { row: rows, column })
      else go(row + 1, column)
    } else if (event.key === 'Escape') { el.blur() }
    else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const direction = event.key === 'ArrowUp' ? 'up' : 'down'
      if (!atVerticalEdge(el, direction)) return
      event.preventDefault(); commit(); group.current++
      const target = row + (direction === 'up' ? -1 : 1)
      if (target < 0 || target >= rows) leave(direction); else go(target, column)
    }
  }
  const columnMenu = (button: HTMLElement, column: number) => {
    const items: MenuEntry[] = [
      { id: 'insert-left', label: '在左侧插入列', onSelect: () => restructure(table => insertColumn(table, column), { row: 0, column }) },
      { id: 'insert-right', label: '在右侧插入列', onSelect: () => restructure(table => insertColumn(table, column + 1), { row: 0, column: column + 1 }) },
      { kind: 'separator' },
      { id: 'move-left', label: '左移', disabled: column === 0, onSelect: () => restructure(table => moveColumn(table, column, column - 1)) },
      { id: 'move-right', label: '右移', disabled: column === columns - 1, onSelect: () => restructure(table => moveColumn(table, column, column + 1)) },
      { kind: 'separator' },
      { id: 'delete', label: '删除列', danger: true, disabled: columns < 2, onSelect: () => restructure(table => deleteColumn(table, column)) },
    ]
    openMenu(anchorOf(button), items, { label: '列操作' })
  }
  const rowMenu = (button: HTMLElement, row: number) => {
    const items: MenuEntry[] = [
      { id: 'insert-above', label: '在上方插入行', disabled: row === 0, onSelect: () => restructure(table => insertRow(table, row), { row, column: 0 }) },
      { id: 'insert-below', label: '在下方插入行', onSelect: () => restructure(table => insertRow(table, row + 1), { row: row + 1, column: 0 }) },
      { kind: 'separator' },
      { id: 'move-up', label: '上移', disabled: row < 2, onSelect: () => restructure(table => moveRow(table, row, row - 1)) },
      { id: 'move-down', label: '下移', disabled: row === 0 || row === rows - 1, onSelect: () => restructure(table => moveRow(table, row, row + 1)) },
      { kind: 'separator' },
      { id: 'delete', label: '删除行', danger: true, disabled: row === 0, onSelect: () => restructure(table => deleteRow(table, row)) },
    ]
    openMenu(anchorOf(button), items, { label: '行操作' })
  }
  return <div ref={root} className="ready-table" data-ready-table data-near={near || undefined}
    onMouseMove={event => {
      const target = event.target instanceof Element ? event.target : null
      if (!target || target.closest('.ready-table__handle')) return
      const bar = target.closest<HTMLElement>('.ready-table__add')
      const cell = target.closest<HTMLElement>('[data-table-cell]')
      const [row, column] = (cell?.dataset.tableCell ?? '-1:-1').split(':').map(Number)
      const next = bar ? bar.dataset.add! : [row === rows - 1 ? 'row' : '', column === columns - 1 ? 'column' : ''].filter(Boolean).join(' ')
      if (next !== near) setNear(next)
      if (!cell) { if (hover && !bar) setHover(null); return }
      if (hover?.row === row && hover.column === column) return
      const box = root.current!.getBoundingClientRect(), rect = cell.getBoundingClientRect()
      setHover({ row, column, left: rect.left - box.left, top: rect.top - box.top, width: rect.width, height: rect.height })
    }}
    onMouseLeave={() => { setHover(null); setNear('') }}
    // The cell being edited shows its row and column handles too, so they are reachable without the pointer.
    onFocusCapture={event => {
      const cell = event.target instanceof HTMLElement && event.target.matches('[data-table-cell]') ? event.target : null
      if (!cell) return
      const [row, column] = cell.dataset.tableCell!.split(':').map(Number)
      const box = root.current!.getBoundingClientRect(), rect = cell.getBoundingClientRect()
      setHover({ row, column, left: rect.left - box.left, top: rect.top - box.top, width: rect.width, height: rect.height })
    }}>
    <div className="note-preview-table-scroll ready-table__scroll" data-note-preview-table="true" style={{ margin: 0 }}>
      <table className="note-preview-markdown-table">
        <thead className="note-preview-markdown-thead"><tr className="note-preview-markdown-tr">
          {model.rows[0].map((cell, column) => <Cell key={column} cell={cell} row={0} column={column} start={cell.start < 0 ? -1 : block.start + cell.start} header
            align={columnAlign(model.align[column])} write={write} keys={keys} report={report} />)}
        </tr></thead>
        <tbody className="note-preview-markdown-tbody">{model.rows.slice(1).map((cells, index) => <tr key={index} className="note-preview-markdown-tr">
          {cells.map((cell, column) => <Cell key={column} cell={cell} row={index + 1} column={column} start={cell.start < 0 ? -1 : block.start + cell.start} header={false}
            align={columnAlign(model.align[column])} write={write} keys={keys} report={report} />)}
        </tr>)}</tbody>
      </table>
    </div>
    <button type="button" className="ready-table__add is-row" data-add="row" aria-label="添加一行" title="添加一行"
      onClick={() => restructure(table => insertRow(table, table.rows.length), { row: rows, column: 0 })}><Plus aria-hidden /></button>
    <button type="button" className="ready-table__add is-column" data-add="column" aria-label="添加一列" title="添加一列"
      onClick={() => restructure(table => insertColumn(table, table.align.length), { row: 0, column: columns })}><Plus aria-hidden /></button>
    {hover && <>
      <button type="button" className="ready-table__handle is-column" aria-label="列操作" title="列操作" style={{ left: hover.left + hover.width / 2 }}
        onMouseDown={event => event.preventDefault()} onClick={event => columnMenu(event.currentTarget, hover.column)}><GripHorizontal aria-hidden /></button>
      <button type="button" className="ready-table__handle is-row" aria-label="行操作" title="行操作" style={{ top: hover.top + hover.height / 2 }}
        onMouseDown={event => event.preventDefault()} onClick={event => rowMenu(event.currentTarget, hover.row)}><GripVertical aria-hidden /></button>
    </>}
  </div>
}
