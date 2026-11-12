import {
  AlignLeft, ArrowUpRight, Calendar, CalendarDays, CircleChevronDown, Columns3, GanttChart, Hash, LayoutGrid, LibraryBig, Link2,
  List, ListChecks, Search, Sigma, SquareCheck, Table2, type LucideIcon,
} from 'lucide-react'
import type { Cell, DatabaseField, DatabaseView } from '../../../../shared/document-database'
import { cellText, dateText } from './cell-text'
import { isStatusField, optionColor, type Color } from './cell-colors'

// Typed cell values and header icons (W3 §4.4, after Inkwell's cells): tags for selects, a dot and text for a
// status, numbers to the right, a checkbox, links and relation chips. Text never breaks inside a glyph; it ends
// in an ellipsis.

// Option colours are the writer's content colours (content-palette.css).
const tone = (color: Color) => ({ background: `var(--doc-${color}-bg)`, color: `var(--doc-${color}-fg)` })

export function Tag({ label, color }: { label: string; color: Color }) {
  return <span className="rdb-tag" style={tone(color)}>{label}</span>
}

export function StatusPill({ label, color }: { label: string; color: Color }) {
  return <span className="rdb-status-pill" style={tone(color)}><span className="rdb-status-dot" aria-hidden />{label}</span>
}

const itemText = (item: unknown): string => typeof item === 'string' ? item
  : item && typeof item === 'object' ? String((item as Record<string, unknown>).title ?? (item as Record<string, unknown>).name ?? (item as Record<string, unknown>).id ?? '')
    : String(item ?? '')

export function CellValue({ field, cell }: { field: DatabaseField | undefined; cell: Cell | undefined }) {
  if (!cell || !field || cell.status !== 'value') return <span className={cell && cell.status !== 'value' ? 'rdb-cell-issue' : 'rdb-cell-text'}>{cellText(cell)}</span>
  const value = cell.value
  if (value == null || value === '' || (Array.isArray(value) && !value.length)) return null
  switch (field.type) {
    case 'select':
      return isStatusField(field) ? <StatusPill label={String(value)} color={optionColor(field, String(value))} /> : <Tag label={String(value)} color={optionColor(field, String(value))} />
    case 'multi_select':
      return <span className="rdb-tags">{(Array.isArray(value) ? value : [value]).map(item => <Tag key={String(item)} label={String(item)} color={optionColor(field, String(item))} />)}</span>
    case 'number':
      return <span className="rdb-cell-num">{String(value)}</span>
    case 'checkbox':
      return <span className={`rdb-check${value ? ' is-on' : ''}`} role="img" aria-label={value ? '已勾选' : '未勾选'} />
    case 'url':
      return <span className="rdb-cell-link">{String(value).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</span>
    case 'date':
      return <span className="rdb-cell-text">{typeof value === 'string' ? dateText(value) : cellText(cell)}</span>
    case 'relation':
      return <span className="rdb-tags">{(Array.isArray(value) ? value : [value]).map((item, index) => <span key={index} className="rdb-rel-chip"><ArrowUpRight aria-hidden />{itemText(item)}</span>)}</span>
    default:
      return <span className="rdb-cell-text">{cellText(cell)}</span>
  }
}

const FIELD_ICONS: Record<DatabaseField['type'], LucideIcon> = {
  text: AlignLeft, number: Hash, select: CircleChevronDown, multi_select: ListChecks, date: Calendar, checkbox: SquareCheck,
  url: Link2, relation: ArrowUpRight, rollup: Search, formula: Sigma,
}

/** The header glyph: “Aa” for the title, the field type's icon otherwise. */
export function FieldIcon({ field }: { field: DatabaseField | 'title' }) {
  if (field === 'title') return <span className="rdb-field-aa" aria-hidden>Aa</span>
  const Glyph = FIELD_ICONS[field.type] ?? AlignLeft
  return <Glyph className="rdb-field-icon" aria-hidden />
}

const VIEW_ICONS: Record<DatabaseView['type'], LucideIcon> = {
  table: Table2, board: Columns3, list: List, gallery: LayoutGrid, calendar: CalendarDays, timeline: GanttChart, bookshelf: LibraryBig,
}

export function ViewIcon({ type }: { type: DatabaseView['type'] }) {
  const Glyph = VIEW_ICONS[type] ?? Table2
  return <Glyph className="rdb-view-icon" aria-hidden />
}
