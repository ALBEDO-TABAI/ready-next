import type { Cell } from '../../../../shared/document-database'

export function cellText(cell: Cell | undefined): string {
  if (!cell) return ''
  if (cell.status === 'error') return cell.message
  if (cell.status === 'incomplete') return `不完整：${cell.reasons.join('；')}`
  if (cell.value == null) return '—'
  if (Array.isArray(cell.value)) return cell.value.join(' · ')
  if (typeof cell.value === 'object') return JSON.stringify(cell.value)
  if (typeof cell.value === 'boolean') return cell.value ? '✓' : '否'
  return String(cell.value)
}

