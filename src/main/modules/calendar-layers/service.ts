import { randomUUID } from 'node:crypto'
import { toReadyUri } from '../../../shared/ready-ref'
import { DocumentPageService } from '../document-pages/service'
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { Temporal } from '@js-temporal/polyfill'
import { LayerRangeSchema, LayerMoveSchema, parseTodos, ToggleTodoSchema, ScheduleTodoSchema, type ParsedTodo, type TodoEntry, type ToggleTodo, type ScheduleTodo, splitReading, calendarDate, type LayerRange, type LayerEntry, type LayerMove } from '../../../shared/calendar-layers'
import { isoDate, parseIsoDate } from '../../../shared/calendar/dates'
import { dayOf, startOfDayMs } from '../../../shared/calendar/tz'
import { fieldValue } from '../../../shared/document-database'
import { readDocumentSource } from '../../../shared/document-operations'
import { ObjectRegistry, isInside } from '../object-service/registry'
import { checkedPath, vaultRoot } from '../document-drafts/files'
import { commitDocumentOperation, documentVersion, documentWriteError, type DocumentWriteDependencies } from '../document-engine/document-write-service'
import type { DocumentDatabaseService } from '../document-database/service'

type DateValue = string | { start: string; end: string }
function dateValue(value: unknown): DateValue {
  const valid = fieldValue({ id: 'date', name: '日期', type: 'date' }, value)
  if (typeof valid === 'string') return valid
  if (valid && typeof valid === 'object' && 'start' in valid && 'end' in valid && typeof valid.start === 'string' && typeof valid.end === 'string') return { start: valid.start, end: valid.end }
  throw new Error('Invalid date field')
}
function civil(value: string, zone: string): string { return value.length === 10 ? value : isoDate(dayOf(Date.parse(value), zone)) }
function shifted(value: DateValue, date: string, zone: string): DateValue {
  const first = typeof value === 'string' ? value : value.start
  const days = parseIsoDate(date) - parseIsoDate(civil(first, zone))
  const shift = (point: string) => point.length === 10 ? isoDate(parseIsoDate(point) + days)
    : Temporal.Instant.from(point).toZonedDateTimeISO(zone).add({ days }).toString({ timeZoneName: 'never', calendarName: 'never' })
  return typeof value === 'string' ? shift(value) : { start: shift(value.start), end: shift(value.end) }
}

/** Derived entries are rebuilt from owners; neither calendar tables nor a second date cache own these fields. */
export class CalendarLayersService {
  readonly root: string
  private sources = new Map<string, { path: string; stamp: string; hash: string | null; content: string; version: string; fields: Record<string, unknown>; tasks: ParsedTodo[] }>()
  private readSources() {
    const objects = this.registry.list().filter(o => o.kind === 'markdown' && o.status === 'present' && o.identity_state !== 'conflict' && o.current_path && isInside(this.root, o.current_path))
    const ids = new Set(objects.map(o => o.id))
    for (const id of this.sources.keys()) if (!ids.has(id)) this.sources.delete(id)
    return objects.map(object => {
      const path = checkedPath(this.root, object.current_path!), stat = statSync(path, { bigint: true })
      const stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
      let source = this.sources.get(object.id)
      if (!source || source.path !== path || source.stamp !== stamp || source.hash !== object.content_hash) {
        const content = readFileSync(path, 'utf8'), version = documentVersion(content)
        const parsed = source?.version === version ? source : { fields: readDocumentSource(content).frontmatter, tasks: parseTodos(content) }
        source = { path, stamp, hash: object.content_hash, content, version, fields: parsed.fields, tasks: parsed.tasks }
        this.sources.set(object.id, source)
      }
      return { object, ...source }
    })
  }
  listTodos(): TodoEntry[] {
    return this.readSources().flatMap(({ object, path, fields, version, tasks }) => tasks.filter(task => !task.checked).map(task => ({
      id: `task:${object.id}:${task.checkbox.start}`, title: task.title, heading: task.heading, version,
      page: { objectId: object.id, title: typeof fields.title === 'string' ? fields.title : basename(path, '.md'), ref: { kind: 'page' as const, id: object.id } },
      date: task.date?.value ?? null, dateSource: task.date?.source ?? null,
    })))
  }
  private todo(id: string, expectedVersion: string) {
    for (const source of this.readSources()) {
      const task = source.tasks.find(task => `task:${source.object.id}:${task.checkbox.start}` === id)
      if (!task) continue
      if (source.version !== expectedVersion) throw documentWriteError('version_conflict', 'Document changed')
      return { source, task }
    }
    throw documentWriteError('version_conflict', 'Task no longer exists')
  }
  private async writeTodo(id: string, expectedVersion: string, edit: (task: ParsedTodo) => { start: number; end: number; text: string; replacement: string }) {
    const { source, task } = this.todo(id, expectedVersion), range = edit(task)
    const transport = this.writer.tabs
    const receipt = await commitDocumentOperation({ path: source.path, expectedVersion, origin: 'calendar_layers',
      operation: { type: 'replaceRange', start: range.start, end: range.end, expectedText: range.text, replacement: range.replacement } }, {
      ...this.writer,
      // A three-character marker (or empty insertion) alone cannot identify a task in an edited buffer.
      tabs: transport && (async request => {
        const reply = await transport(request)
        if (request.phase === 'prepare' && reply.ok) {
          const end = Math.max(task.firstLineEnd, range.end)
          if (reply.tabs.some(tab => tab.isDirty && tab.content.slice(0, end) !== source.content.slice(0, end))) throw documentWriteError('dirty_conflict', 'Task position or text changed in the unsaved document')
        }
        return reply
      }),
    })
    if (receipt.tab !== 'merged_dirty') this.registry.register(source.path)
    return { state: receipt.tab === 'merged_dirty' ? 'unsaved' as const : 'saved' as const }
  }
  toggleTodo(input: ToggleTodo) {
    const request = ToggleTodoSchema.parse(input)
    return this.writeTodo(request.id, request.expectedVersion, task => ({ ...task.checkbox, replacement: request.checked ? '[x]' : '[ ]' }))
  }
  scheduleTodo(input: ScheduleTodo) {
    const request = ScheduleTodoSchema.parse(input)
    return this.writeTodo(request.id, request.expectedVersion, task => {
      const link = `[${request.date}](${toReadyUri({ kind: 'day', date: request.date })})`
      if (task.date?.source === 'obsidian' && !request.rewriteObsidianDate) throw Object.assign(new Error('Rewriting an Obsidian date requires consent'), { code: 'obsidian_date_needs_consent' })
      if (task.date) return { ...task.date.range, replacement: task.date.source === 'ready' ? request.date : link }
      return { start: task.firstLineEnd, end: task.firstLineEnd, text: '', replacement: ` ${link}` }
    })
  }
  constructor(root: string, readonly registry: ObjectRegistry, private database: DocumentDatabaseService,
    private writer: DocumentWriteDependencies, private pages: DocumentPageService) { this.root = vaultRoot(root) }
  query(input: LayerRange): LayerEntry[] {
    const range = LayerRangeSchema.parse(input), entries: LayerEntry[] = []
    const sources = this.readSources()
    const ownedDates = new Set<string>()
    const addDate = (entry: Omit<LayerEntry, 'date' | 'lastDate'>, raw: unknown) => {
      if (raw === undefined || raw === null) return
      const value = dateValue(raw), first = typeof value === 'string' ? value : value.start, last = typeof value === 'string' ? value : value.end
      const date = civil(first, range.timeZone), lastDate = civil(last, range.timeZone)
      if (date < range.to && lastDate >= range.from) entries.push({ ...entry, value, date, lastDate })
    }
    for (const source of sources.filter(s => s.fields.ready_database !== undefined)) {
      const snapshot = this.database.read(source.object.id)
      for (const [key, field] of Object.entries(snapshot.definition.fields)) if (field.type === 'date') for (const row of snapshot.rows) {
        ownedDates.add(`${row.id}:${key}`)
        addDate({ id: `database:${source.object.id}:${row.id}:${field.id}`, layer: 'documents', title: `${row.title} · ${field.name}`, objectId: row.id, ref: { kind: 'page', id: row.id }, version: row.version, edit: { kind: 'database', databaseId: source.object.id, fieldId: field.id } }, row.values[key])
      }
    }
    for (const { object, path, tasks, fields, version } of sources) {
      const title = typeof fields.title === 'string' ? fields.title : basename(path, '.md')
      const base = { objectId: object.id, ref: { kind: 'page' as const, id: object.id }, version }
      const diaryDate = calendarDate.safeParse(basename(path, '.md'))
      if (diaryDate.success) {
        addDate({ ...base, id: `diary:${object.id}`, layer: 'documents', title, edit: { kind: 'diary' } }, diaryDate.data)
      } else if (!ownedDates.has(`${object.id}:date`)) addDate({ ...base, id: `page:${object.id}`, layer: 'documents', title, edit: { kind: 'page' } }, fields.date)
      for (const task of tasks) {
        const date = task.date
        if (date && date.value >= range.from && date.value < range.to) entries.push({ ...base,
          id: `task:${object.id}:${task.checkbox.start}`, layer: 'tasks', title: `${task.checked ? '☑' : '☐'} ${task.title}`, date: date.value, lastDate: date.value,
          ...(date.source === 'ready' ? { edit: { kind: 'task' as const, ...date.range } } : { readOnlyReason: 'obsidian_date_needs_consent' }),
        })
      }
    }
    const from = startOfDayMs(parseIsoDate(range.from), range.timeZone), to = startOfDayMs(parseIsoDate(range.to), range.timeZone)
    type Reading = { id: string; object_id: string; started_at: number; ended_at: number; book_id?: string; loc?: string }
    const sessions = [
      ...this.registry.db.prepare('SELECT id,object_id,started_at,ended_at FROM document_reading_sessions WHERE workspace_root=? AND started_at<? AND ended_at>?').all<Reading>(this.root, to, from),
      ...this.registry.db.prepare('SELECT id,object_id,started_at,ended_at,book_id,loc FROM library_reading_sessions WHERE workspace_root=? AND started_at<? AND ended_at>?').all<Reading>(this.root, to, from),
    ]
    for (const session of sessions) {
      const object = this.registry.get(session.object_id)
      if (!object || !isInside(this.root, object.current_path ?? object.last_known_path)) continue
      for (const piece of splitReading(session.started_at, session.ended_at, range)) entries.push({
        id: `reading:${session.book_id ? 'book' : 'document'}:${session.id}:${piece.date}`, layer: 'footprints', title: `阅读 · ${basename(object.current_path ?? object.last_known_path)}`,
        objectId: object.id, ref: session.book_id && session.loc ? { kind: 'book-location', book: session.book_id, loc: session.loc } : { kind: 'file', id: object.id },
        ...piece, lastDate: piece.date, sessionStart: session.started_at, sessionEnd: session.ended_at,
      })
    }
    return entries.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))
  }
  async move(input: LayerMove): Promise<{ state: 'saved' | 'unsaved' }> {
    const request = LayerMoveSchema.parse(input)
    const entry = this.query(request.range).find(e => e.id === request.id)
    if (!entry) throw new Error('version_conflict: date entry no longer exists')
    if (entry.edit?.kind === 'task') return this.scheduleTodo({ id: request.id, expectedVersion: request.expectedVersion, date: request.date })
    if (!entry.edit) throw new Error('read-only layer entry')
    if (entry.version !== request.expectedVersion) throw new Error('version_conflict: document changed')
    if (entry.edit.kind === 'diary') {
      await this.pages.operate({ type: 'rename', root: this.root, operationId: randomUUID(), objectId: entry.objectId!, title: request.date }, request.expectedVersion)
      const readback = this.query({ ...request.range, from: request.date, to: isoDate(parseIsoDate(request.date) + 1) }).find(e => e.id === entry.id)
      if (readback?.date !== request.date) throw new Error('Diary date readback mismatch')
      return { state: 'saved' }
    }
    if (entry.edit.kind === 'database') {
      const receipt = await this.database.request({ type: 'setFields', databaseId: entry.edit.databaseId, rowId: entry.objectId!, expectedVersion: request.expectedVersion, set: { [entry.edit.fieldId]: shifted(dateValue(entry.value), request.date, request.range.timeZone) } })
      if (!receipt || typeof receipt !== 'object' || !('state' in receipt) || (receipt.state !== 'saved' && receipt.state !== 'unsaved')) throw new Error('Missing database write receipt')
      return { state: receipt.state }
    }
    const object = this.registry.get(entry.objectId!)
    if (!object?.current_path || object.status !== 'present') throw new Error('Document unavailable')
    const receipt = await commitDocumentOperation({ path: checkedPath(this.root, object.current_path), expectedVersion: request.expectedVersion, origin: 'calendar_layers', operation: { type: 'setFrontmatterFields', set: { date: shifted(dateValue(entry.value), request.date, request.range.timeZone) } } }, this.writer)
    if (receipt.tab !== 'merged_dirty') this.registry.register(object.current_path)
    return { state: receipt.tab === 'merged_dirty' ? 'unsaved' : 'saved' }
  }
}
