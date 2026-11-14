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
  | { kind: 'task'; start: number; end: number; text: string; whole?: boolean }
export interface LayerEntry {
  id: string; layer: Exclude<CalendarLayer, 'events'>; title: string; date: string; lastDate: string
  ref: ReadyRef; objectId?: string; version?: string; edit?: LayerEdit; value?: unknown
  /** Tasks layer only: whether the checkbox is ticked. */
  checked?: boolean
  start?: number; end?: number; sessionStart?: number; sessionEnd?: number
  readOnlyReason?: string
}
export const LayerMoveSchema = z.object({ range: LayerRangeSchema, id: z.string().min(1), expectedVersion: z.string().min(1), date: calendarDate }).strict()
export type LayerMove = z.infer<typeof LayerMoveSchema>
export const ReadingBeginSchema = z.object({ id: z.string().min(1), objectId: z.string().min(1), bookId: z.string().min(1), loc: z.string().regex(/^c\d+:\d+\+[1-9]\d*$/), startedAt: z.number().int().nonnegative() }).strict()
export const ReadingEndSchema = z.object({ id: z.string().min(1), endedAt: z.number().int().nonnegative() }).strict()
export type ReadingBegin = z.infer<typeof ReadingBeginSchema>
export type ReadingEnd = z.infer<typeof ReadingEndSchema>
export type LayerReply<T> = { ok: true; value: T } | { ok: false; message: string; code?: string }
export interface CalendarLayersAPI {
  listTodos(): Promise<LayerReply<TodoEntry[]>>
  toggleTodo(input: ToggleTodo): Promise<LayerReply<TodoWriteReceipt>>
  scheduleTodo(input: ScheduleTodo): Promise<LayerReply<TodoWriteReceipt>>
  query(range: LayerRange): Promise<LayerReply<LayerEntry[]>>
  move(input: LayerMove): Promise<LayerReply<{ state: 'saved' | 'unsaved' }>>
  beginReading(input: ReadingBegin): Promise<LayerReply<void>>
  endReading(input: ReadingEnd): Promise<LayerReply<void>>
  onChanged(callback: () => void): () => void
}

export interface TodoRange { start: number; end: number; text: string }
/** A Ready date link whose label is the date itself ([2026-11-12](ready://calendar/day/2026-11-12)) is rewritten
 * whole when the date changes, so the label never shows the old date; a custom label keeps its text. */
export type ReadyDateRange = TodoRange & { whole: boolean }
export function rescheduledDate(range: ReadyDateRange, date: string): string {
  return range.whole ? `[${date}](ready://calendar/day/${date})` : date
}
export interface ParsedTodo {
  title: string; heading: string | null; checked: boolean
  /** UTF-16 offsets for document operations, plus half-open UTF-8 byte offsets. */
  checkbox: TodoRange & { byteStart: number; byteEnd: number }
  firstLineEnd: number
  date: { source: 'ready'; value: string; range: ReadyDateRange } | { source: 'obsidian'; value: string; range: TodoRange } | null
}
export interface TodoEntry {
  id: string; title: string; heading: string | null; version: string
  page: { objectId: string; title: string; ref: ReadyRef }
  date: string | null; dateSource: 'ready' | 'obsidian' | null
}
const TodoIdentitySchema = z.object({ id: z.string().min(1), expectedVersion: z.string().min(1) })
export const ToggleTodoSchema = TodoIdentitySchema.extend({ checked: z.boolean() }).strict()
export const ScheduleTodoSchema = TodoIdentitySchema.extend({ date: calendarDate, rewriteObsidianDate: z.boolean().optional() }).strict()
export type ToggleTodo = z.infer<typeof ToggleTodoSchema>
export type ScheduleTodo = z.infer<typeof ScheduleTodoSchema>
/** `version` is the page's version after the write, so the same line can be written again (a tick taken back)
 * without listing the to-dos first. An unsaved page keeps its disk version: the change is only in its open buffer. */
export type TodoWriteReceipt = { state: 'saved' | 'unsaved'; version: string }

/** GFM task items only: frontmatter, code and nested list contents never become parent tasks. */
export function parseTodos(content: string): ParsedTodo[] {
  const { bodyStart, body } = readDocumentSource(content)
  const result: ParsedTodo[] = []
  const label = (node: Nodes): string => 'children' in node ? node.children.map(label).join('') : 'value' in node ? String(node.value) : ''
  let heading: string | null = null
  function visit(node: Nodes) {
    if (node.type === 'heading') heading = label(node)
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      const start = bodyStart + node.position!.start.offset!
      const line = content.slice(start).split(/\r?\n/, 1)[0]
      const marker = /^(?:[-+*]|\d+[.)])[ \t]+(\[[ xX]\])(?=[ \t]|$)/.exec(line)
      if (marker) {
        const at = start + marker[0].length - marker[1].length
        const byteStart = new TextEncoder().encode(content.slice(0, at)).length
        const task: ParsedTodo = { title: node.children[0] ? label(node.children[0]) : '', heading, checked: node.checked,
          checkbox: { start: at, end: at + 3, text: marker[1], byteStart, byteEnd: byteStart + 3 }, firstLineEnd: start + line.length, date: null }
        function dateIn(part: Nodes) {
          if (part.type === 'list' || part.type === 'code' || part.type === 'inlineCode') return
          if (part.type === 'link') {
            const parsed = parseReadyUri(part.url)
            const offset = bodyStart + part.position!.start.offset!, end = bodyStart + part.position!.end.offset!
            const raw = content.slice(offset, end)
            const labelEnd = bodyStart + (part.children.at(-1)?.position?.end.offset ?? part.position!.start.offset!)
            const urlAt = raw.indexOf(part.url, labelEnd - offset)
            if (parsed.ok && parsed.ref.kind === 'day' && urlAt >= 0 && task.date?.source !== 'ready') {
              const dateStart = offset + urlAt + 'ready://calendar/day/'.length
              const label = content.slice(offset + 1, labelEnd)
              task.date = { source: 'ready', value: parsed.ref.date, range: label === parsed.ref.date && raw === `[${label}](${part.url})`
                ? { start: offset, end, text: raw, whole: true }
                : { start: dateStart, end: dateStart + 10, text: parsed.ref.date, whole: false } }
            }
            return
          }
          if (part.type === 'text' && !task.date) {
            const offset = bodyStart + part.position!.start.offset!, raw = content.slice(offset, bodyStart + part.position!.end.offset!)
            const match = /📅[ \t]+(\d{4}-\d{2}-\d{2})(?![\d-])/.exec(raw)
            if (match && calendarDate.safeParse(match[1]).success) task.date = { source: 'obsidian', value: match[1], range: { start: offset + match.index, end: offset + match.index + match[0].length, text: match[0] } }
          }
          if ('children' in part) for (const child of part.children) dateIn(child)
        }
        for (const child of node.children) dateIn(child)
        // The list shows what to do, not when: drop the date Ready wrote ([2026-11-12](…)) or the 📅 token. A custom
        // label such as [明天](…) reads as part of the sentence and stays.
        const dateText = task.date?.source === 'obsidian' ? task.date.range.text : task.date?.source === 'ready' && task.date.range.whole ? task.date.value : null
        if (dateText) {
          const at = task.title.lastIndexOf(dateText)
          if (at >= 0) task.title = `${task.title.slice(0, at)}${task.title.slice(at + dateText.length)}`.replace(/\s{2,}/g, ' ').trim()
        }
        result.push(task)
      }
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(markdownTree(body)); return result
}

export function datedTasks(content: string) {
  return parseTodos(content).flatMap(task => task.date?.source === 'ready'
    ? [{ date: task.date.value, title: `${task.checked ? '☑' : '☐'} ${task.title}`, ...task.date.range }] : [])
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
