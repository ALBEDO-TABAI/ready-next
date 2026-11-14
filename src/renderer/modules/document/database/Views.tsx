import { readReadyRefTransfer, writeReadyRefTransfer } from '../../../../shared/ready-ref'
import { useLayoutEffect, useRef, useState, type ReactNode, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { DatabaseDefinition, DatabaseView } from '../../../../shared/document-database'
import type { PersonalState, Query, ViewRow } from './access'
import { cellText } from './cell-text'
import { FieldIcon } from './cells'
import { addDays, dateRange, dayDistance, moveGroup, shiftDate } from './moves'

export interface ViewProps {
  definition: DatabaseDefinition; view: DatabaseView; query: Query; personal: PersonalState; disabled: boolean
  cell(row: ViewRow, fieldId: string): ReactNode
  open(row: ViewRow): void
  setField(row: ViewRow, field: string, value: unknown): void
  savePersonal(patch: PersonalState): void
}
// One height for the head and every row (database.css, ink.css), on the 4px grid.
const rowHeight = 36
const viewportHeight = 456
export function TableView(props: ViewProps) {
  const { definition, query, view, personal, cell, savePersonal } = props
  const scroll = useRef<HTMLDivElement>(null)
  const [top, setTop] = useState(personal.scroll?.y ?? 0)
  const initialScroll = useRef(personal.scroll)
  useLayoutEffect(() => { if (scroll.current) { scroll.current.scrollTop = initialScroll.current?.y ?? 0; scroll.current.scrollLeft = initialScroll.current?.x ?? 0 } }, []) // Scroll restoration happens on mount/view change, never during scrolling.
  const fields = view.visibleFields ?? ['$title', ...Object.values(definition.fields).map(f => f.id)]
  const rowById = new Map(query.rows.map(row => [row.id, row]))
  const items: ({ kind: 'group'; label: string; key: string } | { kind: 'row'; row: ViewRow; key: string })[] = view.groupBy
    ? query.groups.flatMap((group, i) => [{ kind: 'group' as const, label: String(group.value ?? '未分组'), key: `group:${i}` }, ...group.rowIds.flatMap(id => { const row = rowById.get(id); return row ? [{ kind: 'row' as const, row, key: `${i}:${id}` }] : [] })])
    : query.rows.map(row => ({ kind: 'row', row, key: row.id }))
  const start = Math.max(0, Math.min(Math.floor(top / rowHeight) - 4, Math.max(0, items.length - 1)))
  const end = Math.min(items.length, start + Math.ceil(viewportHeight / rowHeight) + 7)
  const columns = fields.map(id => `${personal.widths?.[id] ?? (id === '$title' ? 220 : 160)}px`).join(' ')
  const width = fields.reduce((sum, id) => sum + (personal.widths?.[id] ?? (id === '$title' ? 220 : 160)), 0)
  const resize = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    const target = event.currentTarget, x = event.clientX, initial = personal.widths?.[id] ?? (id === '$title' ? 220 : 160)
    target.setPointerCapture(event.pointerId)
    const up = (e: PointerEvent) => { target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', cancel); savePersonal({ widths: { [id]: Math.max(80, Math.min(800, initial + e.clientX - x)) } }) }
    const cancel = () => { target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', cancel) }
    target.addEventListener('pointerup', up); target.addEventListener('pointercancel', cancel)
  }
  // A short table is as tall as its rows (the ＋ 新页面 row follows it); a long one scrolls inside the viewport.
  return <div className="rdb-scroll" ref={scroll} data-testid="table-scroll" style={{ height: Math.min(viewportHeight, rowHeight + items.length * rowHeight + 2) }} onScroll={e => { setTop(e.currentTarget.scrollTop); savePersonal({ scroll: { x: e.currentTarget.scrollLeft, y: e.currentTarget.scrollTop } }) }}>
    <div role="table" aria-label="数据库表格" aria-rowcount={items.length + 1} style={{ width, minWidth: '100%' }}>
      <div className="rdb-table-head" role="row" style={{ gridTemplateColumns: columns }}>{fields.map(id => {
        const field = Object.values(definition.fields).find(f => f.id === id)
        return <div role="columnheader" key={id} data-col={id === '$title' ? 'title' : undefined}>
        <span className="rdb-head-label">{id === '$title' ? <FieldIcon field="title" /> : field ? <FieldIcon field={field} /> : null}<span>{id === '$title' ? '标题' : id === '$id' ? '身份' : field?.name}</span></span>
        <button className="rdb-resize" aria-label={`调整列宽 ${id}`} onPointerDown={e => resize(e, id)} onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); savePersonal({ widths: { [id]: Math.max(80, (personal.widths?.[id] ?? 160) + (e.key === 'ArrowLeft' ? -20 : 20)) } }) } }} />
      </div>
      })}</div>
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>
        {items.slice(start, end).map((item, i) => <div className="rdb-table-row" role="row" aria-rowindex={start + i + 2} draggable={item.kind === 'row' && !props.disabled} onDragStart={e => { if (item.kind === 'row') dragStart(e, item.row, null) }} onDragEnd={() => { draggedRow = null }} data-row-id={item.kind === 'row' ? item.row.id : undefined} key={item.key} style={{ position: 'absolute', top: (start + i) * rowHeight, height: rowHeight, gridTemplateColumns: columns, width: '100%' }}>{item.kind === 'group' ? <div role="cell" style={{ gridColumn: '1 / -1' }}>{item.label}</div> : fields.map(id => <div role="cell" key={id} data-col={id === '$title' ? 'title' : undefined}>{cell(item.row, id)}</div>)}</div>)}
      </div>
    </div>
  </div>
}
// Group position belongs to this gesture, not to the cross-module reference.
let draggedRow: { id: string; from: unknown } | null = null
function dragStart(e: DragEvent, row: ViewRow, from: unknown) {
  draggedRow = { id: row.id, from }
  writeReadyRefTransfer(e.dataTransfer, { kind: 'page', id: row.id }, row.title)
  e.dataTransfer.effectAllowed = 'copyMove'
}
function dropped(e: DragEvent, rows: ViewRow[]): { row: ViewRow; from: unknown } | null {
  e.preventDefault()
  const dropped = readReadyRefTransfer(e.dataTransfer)
  if (dropped?.ref.kind !== 'page' || draggedRow?.id !== dropped.ref.id) return null
  const id = dropped.ref.id
  const row = rows.find(row => row.id === id)
  return row ? { row, from: draggedRow.from } : null
}
function Card({ row, ctx, from = null }: { row: ViewRow; ctx: ViewProps; from?: unknown; draggable?: boolean }) {
  const fields = ctx.view.cardFields ?? Object.values(ctx.definition.fields).filter(f => !['formula', 'rollup'].includes(f.type)).slice(0, 3).map(f => f.id)
  return <article className="rdb-card" data-row-id={row.id} draggable={!ctx.disabled} onDragStart={e => dragStart(e, row, from)} onDragEnd={() => { draggedRow = null }}>
    <button className="rdb-title" onClick={() => ctx.open(row)}>{row.title}</button>
    {fields.map(id => <div className="rdb-card-field" key={id}>{ctx.cell(row, id)}</div>)}
  </article>
}
export function CardViews(props: ViewProps) {
  const { view, query, definition, disabled } = props
  if (view.type === 'board') {
    const field = Object.values(definition.fields).find(f => f.id === view.groupBy)
    if (!field) return <p>在视图设置中选择分组字段。</p>
    const editable = ['text', 'number', 'select', 'multi_select', 'checkbox'].includes(field.type)
    const groups = [...query.groups]
    for (const value of [...field.options ?? [], null]) if (!groups.some(g => g.value === value)) groups.push({ value, rowIds: [] })
    return <div className="rdb-board">{groups.map(group => <section className="rdb-column" key={JSON.stringify(group.value)} data-group={String(group.value ?? '未分组')} onDragOver={e => { if (!disabled && editable) e.preventDefault() }} onDrop={e => {
      const item = dropped(e, query.rows)
      if (!item || disabled || !editable) return
      const cell = item.row.cells[field.id]
      if (cell?.status === 'value') props.setField(item.row, field.id, moveGroup(field, cell.value, item.from, group.value))
    }}><h3><span className="rdb-tag">{String(group.value ?? '未分组')}</span><small>{group.rowIds.length}</small></h3>{group.rowIds.map(id => query.rows.find(row => row.id === id)).filter((row): row is ViewRow => !!row).map(row => <Card key={row.id} row={row} ctx={props} from={group.value} draggable={editable} />)}</section>)}</div>
  }
  const rows = (ids: string[]) => ids.map(id => query.rows.find(row => row.id === id)).filter((row): row is ViewRow => !!row)
  const groups = view.groupBy ? query.groups.map(g => ({ label: String(g.value ?? '未分组'), rows: rows(g.rowIds) })) : [{ label: '', rows: query.rows }]
  return <>{groups.map((group, i) => <section key={i}>{group.label && <h3>{group.label}</h3>}<div className={`rdb-${view.type}`}>{group.rows.map(row => <Card key={row.id} row={row} ctx={props} />)}</div></section>)}</>
}
export function TimeViews(props: ViewProps) {
  const { view, query, disabled } = props
  const today = new Date(), initialMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`
  const [month, setMonth] = useState(initialMonth)
  const first = `${month}-01`, monthEnd = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)
  const days = Array.from({ length: dayDistance(first, monthEnd) + 1 }, (_, i) => addDays(first, i))
  const fieldId = view.dateField
  if (!fieldId) return <p>在视图设置中选择日期字段。</p>
  const entries = query.rows.map(row => ({ row, range: row.cells[fieldId]?.status === 'value' ? dateRange(row.cells[fieldId].value) : null }))
  const move = (e: DragEvent, day: string) => {
    const item = dropped(e, query.rows)
    if (item && !disabled) { const cell = item.row.cells[fieldId]; if (cell?.status === 'value') props.setField(item.row, fieldId, shiftDate(cell.value, day)) }
  }
  const undated = entries.filter(entry => !entry.range)
  return <>
    <div className="rdb-time-toolbar"><label>显示月份<input aria-label="显示月份" type="month" value={month} onChange={e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) setMonth(e.target.value) }} /></label></div>
    {view.type === 'calendar' ? <div className="rdb-calendar">
      {['日', '一', '二', '三', '四', '五', '六'].map(day => <div className="rdb-weekday" key={day}>{day}</div>)}
      {days.map((day, i) => <section key={day} className="rdb-day" data-date={day} style={i === 0 ? { gridColumnStart: new Date(`${day}T12:00:00Z`).getUTCDay() + 1 } : undefined} onDragOver={e => { if (!disabled) e.preventDefault() }} onDrop={e => move(e, day)}><time>{Number(day.slice(-2))}</time>{entries.filter(({ range }) => range && range.start.slice(0, 10) <= day && range.end.slice(0, 10) >= day).map(({ row }) => <Card key={row.id} row={row} ctx={props} draggable />)}</section>)}
    </div> : <div className="rdb-timeline-scroll"><div className="rdb-timeline" style={{ gridTemplateColumns: `180px repeat(${days.length}, 72px)` }}>
      <div>页面</div>{days.map(day => <div className="rdb-time-head" key={day} data-date={day} onDragOver={e => { if (!disabled) e.preventDefault() }} onDrop={e => move(e, day)}>{day.slice(5)}</div>)}
      {entries.filter(({ range }) => range && range.start.slice(0, 10) <= monthEnd && range.end.slice(0, 10) >= first).map(({ row, range }, index) => {
        const start = Math.max(0, dayDistance(first, range!.start)), end = Math.min(days.length - 1, dayDistance(first, range!.end))
        return <div className="rdb-timeline-entry" key={row.id} style={{ display: 'contents' }}><button style={{ gridRow: index + 2, gridColumn: 1 }} onClick={() => props.open(row)}>{row.title}</button>
          {days.map((day, i) => <div className="rdb-time-track" key={day} style={{ gridRow: index + 2, gridColumn: i + 2 }} data-date={day} onDragOver={e => { if (!disabled) e.preventDefault() }} onDrop={e => move(e, day)} />)}
          <div className="rdb-time-bar" style={{ gridRow: index + 2, gridColumn: `${start + 2} / ${end + 3}` }}><Card row={row} ctx={props} draggable /></div>
        </div>
      })}
    </div></div>}
    {!!undated.length && <section className="rdb-undated"><h3>未设置日期</h3>{undated.map(({ row }) => <Card key={row.id} row={row} ctx={props} draggable />)}</section>}
  </>
}
export function Calculations({ query, definition }: Pick<ViewProps, 'query' | 'definition'>) {
  return <div className="rdb-calculations">{Object.entries(query.calculations).map(([id, cell]) => <span key={id}>{Object.values(definition.fields).find(f => f.id === id)?.name ?? id}：{cellText(cell)}</span>)}</div>
}
