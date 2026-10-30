import { z } from 'zod'
import type { ReadyRef } from './ready-ref'
import { parseReadyUri } from './ready-ref'
import { isoDate, parseIsoDate } from './calendar/dates'
import { dayOf, startOfDayMs } from './calendar/tz'
import { markdownTree } from './document-blocks/markdown'
import { readDocumentSource } from './document-operations'
import type { Nodes } from 'mdast'

export const calendarLayers = [
  { id: 'events', label: '日程', color: '#3977bd' },
  { id: 'documents', label: '文档日期', color: '#b16b24' },
  { id: 'tasks', label: '待办', color: '#36836c' },
  { id: 'footprints', label: '阅读足迹', color: '#8c6aa6' },
] as const
export type CalendarLayer = typeof calendarLayers[number]['id']
export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => {
  try { return isoDate(parseIsoDate(s)) === s } catch { return false }
}, 'Invalid date')
export const LayerRangeSchema = z.object({ from: calendarDate, to: calendarDate, timeZone: z.string().refine(s => {
  try { new Intl.DateTimeFormat('en', { timeZone: s }); return true } catch { return false }
}) }).strict().refine(r => r.from < r.to, 'Empty date range')
export type LayerRange = z.infer<typeof LayerRangeSchema>
export type LayerEdit = { kind: 'page' } | { kind: 'diary' } | { kind: 'database'; databaseId: string; fieldId: string }
  | { kind: 'task'; start: number; end: number; text: string }
export interface LayerEntry {
  id: string; layer: Exclude<CalendarLayer, 'events'>; title: string; date: string; lastDate: string
  ref: ReadyRef; objectId?: string; version?: string; edit?: LayerEdit; value?: unknown
  start?: number; end?: number; sessionStart?: number; sessionEnd?: number
  readOnlyReason?: string
}
export const LayerMoveSchema = z.object({ range: LayerRangeSchema, id: z.string().min(1), expectedVersion: z.string().min(1), date: calendarDate }).strict()
export type LayerMove = z.infer<typeof LayerMoveSchema>
export const ReadingBeginSchema = z.object({ id: z.string().min(1), objectId: z.string().min(1), bookId: z.string().min(1), loc: z.string().regex(/^c\d+:\d+\+[1-9]\d*$/), startedAt: z.number().int().nonnegative() }).strict()
export const ReadingEndSchema = z.object({ id: z.string().min(1), endedAt: z.number().int().nonnegative() }).strict()
export type ReadingBegin = z.infer<typeof ReadingBeginSchema>
export type ReadingEnd = z.infer<typeof ReadingEndSchema>
export type LayerReply<T> = { ok: true; value: T } | { ok: false; message: string }
export interface CalendarLayersAPI {
  query(range: LayerRange): Promise<LayerReply<LayerEntry[]>>
  move(input: LayerMove): Promise<LayerReply<{ state: 'saved' | 'unsaved' }>>
  beginReading(input: ReadingBegin): Promise<LayerReply<void>>
  endReading(input: ReadingEnd): Promise<LayerReply<void>>
  onChanged(callback: () => void): () => void
}

/** Actual Markdown links in task paragraphs only; code and nested tasks are not double counted. */
export function datedTasks(content: string) {
  const { bodyStart } = readDocumentSource(content), body = content.slice(bodyStart)
  const result: Array<{ date: string; title: string; start: number; end: number; text: string }> = []
  const label = (node: Nodes): string => 'children' in node ? node.children.map(label).join('') : 'value' in node ? String(node.value) : ''
  function visit(node: Nodes, task?: string) {
    const title = node.type === 'listItem' ? (typeof node.checked === 'boolean' ? `${node.checked ? '☑' : '☐'} ${node.children[0] ? label(node.children[0]) : ''}` : undefined) : task
    if (title && node.type === 'link') {
      const parsed = parseReadyUri(node.url)
      if (parsed.ok && parsed.ref.kind === 'day') {
        const offset = node.position!.start.offset!, raw = body.slice(offset, node.position!.end.offset!)
        const urlOffset = raw.indexOf(node.url)
        const dateToken = /^ready:\/\/calendar\/day\/([^?#]+)/.exec(node.url)
        if (urlOffset >= 0 && dateToken) {
          const start = bodyStart + offset + urlOffset + 'ready://calendar/day/'.length
          result.push({ date: parsed.ref.date, title, start, end: start + dateToken[1].length, text: dateToken[1] })
        }
      }
    }
    if ('children' in node) for (const child of node.children) visit(child, title)
  }
  visit(markdownTree(body)); return result
}

/** Half-open sessions split by civil days in the calendar's timezone, including DST. */
export function splitReading(start: number, end: number, range: LayerRange) {
  const pieces: Array<{ date: string; start: number; end: number }> = []
  for (let day = Math.max(dayOf(start, range.timeZone), parseIsoDate(range.from)); day < parseIsoDate(range.to); day++) {
    const a = Math.max(start, startOfDayMs(day, range.timeZone)), b = Math.min(end, startOfDayMs(day + 1, range.timeZone))
    if (a >= end) break
    if (b > a) pieces.push({ date: isoDate(day), start: a, end: b })
  }
  return pieces
}
