import { fieldValue, type DatabaseField } from '../../../../shared/document-database'

export function moveGroup(field: DatabaseField, value: unknown, from: unknown, to: unknown): unknown {
  if (field.type === 'multi_select') {
    const current = fieldValue(field, value)
    const values = Array.isArray(current) ? current.filter(option => option !== from) : []
    return fieldValue(field, [...new Set([...values, ...(to == null ? [] : [to])])])
  }
  return fieldValue(field, to)
}
export function dateRange(value: unknown): { start: string; end: string } | null {
  if (value == null) return null
  const parsed = fieldValue({ id: 'date', name: 'date', type: 'date' }, value)
  if (typeof parsed === 'string') return { start: parsed, end: parsed }
  // fieldValue validated the range at the external-value boundary.
  if (typeof parsed === 'object' && parsed && 'start' in parsed && 'end' in parsed && typeof parsed.start === 'string' && typeof parsed.end === 'string') return { start: parsed.start, end: parsed.end }
  throw new Error('无效日期')
}
const dayMs = 86400000
export function shiftDate(value: unknown, target: string): unknown {
  fieldValue({ id: 'date', name: 'date', type: 'date' }, target)
  const range = dateRange(value)
  if (!range) return target
  const delta = Date.parse(target) - Date.parse(range.start.slice(0, 10))
  const shift = (point: string) => {
    const day = new Date(Date.parse(point.slice(0, 10)) + delta).toISOString().slice(0, 10)
    return day + point.slice(10) // Preserve wall time and explicit timezone; date-only stays date-only.
  }
  return typeof value === 'string' ? shift(range.start) : { start: shift(range.start), end: shift(range.end) }
}
export function addDays(day: string, count: number): string { return new Date(Date.parse(day) + count * dayMs).toISOString().slice(0, 10) }
export function dayDistance(start: string, end: string): number { return Math.round((Date.parse(end.slice(0, 10)) - Date.parse(start.slice(0, 10))) / dayMs) }
