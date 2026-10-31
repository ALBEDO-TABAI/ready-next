import type { Cell } from '../../../../shared/document-database'

export function cellText(cell: Cell | undefined): string {
  if (!cell) return ''
  if (cell.status === 'error') return cell.message
  if (cell.status === 'incomplete') return `不完整：${cell.reasons.join('；')}`
  if (cell.value == null) return '—'
  if (Array.isArray(cell.value)) return cell.value.join(' · ')
  if (typeof cell.value === 'object') {
    const value = cell.value as Record<string, unknown>
    if (typeof value.start === 'string') {
      const start = dateText(value.start), end = typeof value.end === 'string' && value.end !== value.start ? dateText(value.end) : ''
      return end ? `${start} → ${end}` : start
    }
    for (const key of ['title', 'name', 'url'] as const) if (typeof value[key] === 'string') return value[key] as string
    return JSON.stringify(cell.value)
  }
  if (typeof cell.value === 'boolean') return cell.value ? '✓' : '否'
  return String(cell.value)
}

/** "2026-11-03" → "11月3日" (the year only when it is not this year), keeping the time when there is one. */
export function dateText(value: string, now = new Date()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(value)
  if (!match) return value
  const [, year, month, day, hour, minute] = match
  return `${Number(year) === now.getFullYear() ? '' : `${year}年`}${Number(month)}月${Number(day)}日${hour ? ` ${hour}:${minute}` : ''}`
}
