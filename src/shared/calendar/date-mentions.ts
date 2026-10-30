import type { Nodes } from 'mdast'
import { markdownTree } from '../document-blocks/markdown'
import { readDocumentSource } from '../document-operations'
import { parseReadyUri, type ReadyRef } from '../ready-ref'
import { fromWall } from './tz'

export type DateMentionRef = Extract<ReadyRef, { kind: 'day' }>
export interface DateMention {
  objectId: string
  start: number
  end: number
  text: string
  title: string
  ref: DateMentionRef
}
export interface DateMentionReminder {
  id: string
  objectId: string
  start: number
  end: number
  text: string
  title: string
  date: string
  timeZone: string
  startTime: number
  offsetMinutes: number
  revision: number
  deliveredAt: number | null
}
export interface DateMentionTarget { path: string; content: string; start: number; end: number }
export interface DateMentionsAPI {
  list(): Promise<DateMentionReminder[]>
  locate(ref: ReadyRef): Promise<DateMentionTarget>
  takeOpen(): Promise<ReadyRef | null>
  onChanged(handler: () => void): () => void
  onOpen(handler: () => void): () => void
}
export function dateMentionReference(row: Pick<DateMentionReminder, 'id' | 'objectId'>): ReadyRef {
  return { kind: 'file', id: row.objectId, anchor: row.id }
}

/** Source ranges are locators, never durable identities. Main assigns and migrates identities. */
export function parseDateMentions(objectId: string, content: string): DateMention[] {
  const { bodyStart } = readDocumentSource(content)
  const body = content.slice(bodyStart), result: DateMention[] = []
  const label = (node: Nodes): string => 'children' in node ? node.children.map(label).join('') : 'value' in node ? String(node.value) : ''
  function visit(node: Nodes) {
    if (node.type === 'link') {
      const parsed = parseReadyUri(node.url)
      if (parsed.ok && parsed.ref.kind === 'day') {
        const start = bodyStart + node.position!.start.offset!, end = bodyStart + node.position!.end.offset!
        result.push({ objectId, start, end, text: content.slice(start, end), title: label(node), ref: parsed.ref })
      }
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(markdownTree(body))
  return result
}

export function dateMentionStart(ref: DateMentionRef, timeZone: string): number {
  const [y, m, d] = ref.date.split('-').map(Number), [h, mi] = (ref.at ?? '09:00').split(':').map(Number)
  return fromWall({ y, m, d, h, mi }, timeZone) / 1000
}

/** Move untouched ranges across a replacement, then match unique unchanged links.
 * A single edited link keeps its identity. Ambiguous replacement groups get no guessed mapping. */
export function matchDateMentionRanges(before: string, after: string, old: readonly DateMention[], next: readonly DateMention[]): Map<number, number> {
  let prefix = 0, suffix = 0
  while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++
  while (suffix < Math.min(before.length, after.length) - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
  const matched = new Map<number, number>(), used = new Set<number>()
  const take = (i: number, j: number) => { matched.set(j, i); used.add(i) }
  old.forEach((item, i) => {
    const start = item.end <= prefix ? item.start : item.start >= before.length - suffix ? item.start + after.length - before.length : -1
    const j = next.findIndex((candidate, index) => !matched.has(index) && candidate.start === start && candidate.text === item.text)
    if (j >= 0) take(i, j)
  })
  next.forEach((item, j) => {
    if (matched.has(j)) return
    const candidates = old.map((candidate, i) => ({ candidate, i })).filter(({ candidate, i }) => !used.has(i) && candidate.text === item.text)
    if (candidates.length === 1 && next.filter((candidate, index) => !matched.has(index) && candidate.text === item.text).length === 1) take(candidates[0].i, j)
  })
  const remainingOld = old.map((_, i) => i).filter(i => !used.has(i)), remainingNext = next.map((_, j) => j).filter(j => !matched.has(j))
  if (remainingOld.length === 1 && remainingNext.length === 1) take(remainingOld[0], remainingNext[0])
  // Never create fresh identities for an ambiguous relocation of existing links:
  // that would re-arm already delivered reminders. The caller must surface this conflict.
  if (next.some((item, j) => !matched.has(j) && remainingOld.some(i => old[i].text === item.text))) {
    throw new Error('日期提及有多处相同原文，无法唯一迁移提醒位置')
  }
  return matched
}
