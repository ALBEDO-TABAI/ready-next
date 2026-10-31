import { z } from 'zod'
import { parseReadyUri, toReadyUri } from '../../../../shared/ready-ref'
import { readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { readDocumentSource } from '../../../../shared/document-operations'
import { readDatabase, projectView, fieldValue, type DatabaseRow, type Relations } from '../../../../shared/document-database'
import { ObjectRegistry, isInside } from '../../object-service/registry'
import { checkedPath, vaultRoot } from '../../document-drafts/files'
import { readBook } from '../../library-engine/source-note'
import type { CalendarStore } from '../../database/calendar-store'
import { CalendarLinkageService } from '../../calendar-linkage/service'
import { DateMentionService } from '../../calendar-engine/date-mentions/service'
import { calendarDate, datedTasks, splitReading, type LayerEntry } from '../../../../shared/calendar-layers'
import { parseIsoDate, isoDate } from '../../../../shared/calendar/dates'
import { startOfDayMs, dayOf } from '../../../../shared/calendar/tz'
import type { LibraryResourceSelection } from '../../../../shared/ipc-contracts/agent-runtime'

export function libraryHash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
export function libraryFailure(): never { throw new Error('library_resource_unavailable') }

/** Reads only registered identities. It never registers, repairs, scans or upgrades. */
export class LibraryReadSources {
  readonly root: string
  readonly libraryId: string
  constructor(readonly registry: ObjectRegistry, root: string, readonly calendar: CalendarStore) {
    this.root = vaultRoot(root); this.libraryId = libraryHash(this.root)
  }
  object(id: string) {
    const object = this.registry.get(id)
    const workspace = object && this.registry.db.prepare('SELECT root FROM workspaces WHERE id=?').get<{ root: string }>(object.workspace_id)
    if (!object?.current_path || object.status !== 'present' || object.identity_state === 'conflict' || workspace?.root !== this.root) libraryFailure()
    const path = checkedPath(this.root, object.current_path)
    const bytes = readFileSync(path), stat = statSync(path, { bigint: true }), version = libraryHash(bytes)
    if (version !== object.content_hash || String(stat.dev) !== object.device || String(stat.ino) !== object.inode) libraryFailure()
    return { object, path, content: bytes.toString('utf8'), version }
  }
  draft(id: string) {
    const row = this.registry.db.prepare("SELECT content,content_hash,title FROM document_drafts WHERE draft_id=? AND vault_root=? AND state='editing'").get<{ content: string; content_hash: string; title: string }>(id, this.root)
    if (!row || libraryHash(row.content) !== row.content_hash) libraryFailure()
    return { content: row.content, version: row.content_hash }
  }
  links(id: string, direction: 'outgoing' | 'incoming') {
    const source = this.object(id), column = direction === 'outgoing' ? 'source_id' : 'target_id'
    return this.registry.db.prepare(`SELECT l.id,l.source_id,l.target_id,l.kind FROM object_links l JOIN objects s ON s.id=l.source_id JOIN objects t ON t.id=l.target_id
      WHERE l.${column}=? AND l.resolved=1 AND s.workspace_id=? AND t.workspace_id=? AND s.status='present' AND t.status='present' AND s.identity_state<>'conflict' AND t.identity_state<>'conflict' ORDER BY l.id`)
      .all<{ id: string; source_id: string; target_id: string; kind: string }>(id, source.object.workspace_id, source.object.workspace_id)
  }
  async book(id: string) {
    const source = this.object(id)
    const book = await readBook(this.root, source.path)
    if (!book || book.id !== id || !['txt', 'md', 'epub'].includes(book.format)) libraryFailure()
    const bytes = readFileSync(checkedPath(this.root, book.filePath)), version = libraryHash(bytes)
    const { archiveChapters } = await import('../../library-engine/archive-chapters')
    const chapters = await archiveChapters(bytes, book.format, book.title)
    if (this.object(id).version !== source.version || libraryHash(readFileSync(checkedPath(this.root, book.filePath))) !== version) libraryFailure()
    return { chapters, version }
  }
  database(id: string, rows: Array<{ id: string; version: string }>) {
    if (this.registry.db.prepare("SELECT id FROM document_database_operations WHERE database_id=? AND state<>'committed'").get(id)) libraryFailure()
    const source = this.object(id), definition = readDatabase(source.content)
    const folder = checkedPath(this.root, join(dirname(source.path), definition.source))
    const selected: DatabaseRow[] = rows.filter(row => {
      const object = this.registry.get(row.id)
      return object?.current_path && row.id !== id && isInside(folder, object.current_path) && (definition.recursive || dirname(object.current_path) === folder)
    }).map(row => {
      const item = this.object(row.id)
      if (item.version !== row.version || row.id === id || !isInside(folder, item.path) || (!definition.recursive && dirname(item.path) !== folder)) libraryFailure()
      const values = readDocumentSource(item.content).frontmatter
      return { id: row.id, title: typeof values.title === 'string' ? values.title : basename(item.path, '.md'), version: item.version, values }
    })
    return { definition, rows: selected, version: source.version }
  }
  query(id: string, rows: Array<{ id: string; version: string }>, viewId: string, offset: number, limit: number) {
    const database = this.database(id, rows), view = database.definition.views.find(v => v.id === viewId)
    if (!view) libraryFailure()
    // Relationship values may name other objects, but never permit reading their fields.
    const relations: Relations = Object.fromEntries(database.rows.map(row => [row.id, Object.fromEntries(
      Object.values(database.definition.fields).filter(f => f.type === 'relation').map(f => [f.id, { rows: [], complete: false, reasons: ['target_not_authorized'] }]),
    )]))
    return projectView(database.definition, database.rows, view, relations, { offset, limit })
  }
  day(selection: Extract<LibraryResourceSelection, { kind: 'calendar_day' }>) {
    const day = parseIsoDate(selection.date), range = { from: selection.date, to: isoDate(day + 1), timeZone: selection.timeZone }
    if (new Set(selection.items.map(item => item.id)).size !== selection.items.length || new Set(selection.categories).size !== selection.categories.length) libraryFailure()
    const layers: LayerEntry[] = []
    const addDate = (entry: Omit<LayerEntry, 'date' | 'lastDate'>, raw: unknown) => {
      if (raw === undefined || raw === null) return
      const value = fieldValue({ id: 'date', name: '日期', type: 'date' }, raw)
      const valid = z.union([z.string(), z.object({ start: z.string(), end: z.string() })]).parse(value)
      const civil = (date: string) => date.length === 10 ? date : isoDate(dayOf(Date.parse(date), selection.timeZone))
      const date = civil(typeof valid === 'string' ? valid : valid.start), lastDate = civil(typeof valid === 'string' ? valid : valid.end)
      if (date < range.to && lastDate >= range.from) layers.push({ ...entry, date, lastDate })
    }
    // The selected reference, not a vault-wide layer scan, determines which pages may be read.
    const selectedObjects = new Map<string, ReturnType<LibraryReadSources['object']> | null>()
    const objectId = (uri: string): string | null => {
      const parsed = parseReadyUri(uri)
      if (!parsed.ok) return null
      const ref = parsed.ref
      return ref.kind === 'page' || ref.kind === 'file' || ref.kind === 'canvas' ? ref.id : ref.kind === 'book-location' ? ref.book : null
    }
    for (const requested of selection.items) {
      const id = objectId(requested.uri)
      if (!id || selectedObjects.has(id)) continue
      try { selectedObjects.set(id, this.object(id)) }
      catch {
        // silent-catch: the selected object is returned as unavailable below, with no body or path.
        selectedObjects.set(id, null)
      }
    }
    for (const [id, source] of selectedObjects) {
      if (!source || source.object.kind !== 'markdown') continue
      if (!selection.items.some(item => item.id === `page:${id}` || item.id === `diary:${id}` || item.id.startsWith(`task:${id}:`))) continue
      try {
        const fields = readDocumentSource(source.content).frontmatter
        const base = { objectId: id, ref: { kind: 'page' as const, id }, version: source.version }
        const title = typeof fields.title === 'string' ? fields.title : basename(source.path, '.md')
        const diaryDate = calendarDate.safeParse(basename(source.path, '.md'))
        addDate({ ...base, id: `${diaryDate.success ? 'diary' : 'page'}:${id}`, layer: 'documents', title }, diaryDate.success ? diaryDate.data : fields.date)
        for (const task of datedTasks(source.content)) if (task.date === selection.date) layers.push({ ...base, id: `task:${id}:${task.start}`, layer: 'tasks', title: task.title, date: task.date, lastDate: task.date })
      } catch {
        // silent-catch: invalid selected content becomes an unavailable item, preserving the rest of the day.
        selectedObjects.set(id, null)
      }

    }
    // Database date entries identify both the definition and row. Resolve only those selected pairs.
    for (const requested of selection.items.filter(item => item.id.startsWith('database:'))) {
      try {
        const parsed = parseReadyUri(requested.uri)
        if (!parsed.ok || parsed.ref.kind !== 'page') libraryFailure()
        const rowId = parsed.ref.id
        const candidates = this.registry.list().filter(object => requested.id.startsWith(`database:${object.id}:${rowId}:`))
        if (candidates.length !== 1) libraryFailure()
        const database = this.database(candidates[0].id, [{ id: rowId, version: this.object(rowId).version }])
        const fieldId = requested.id.slice(`database:${candidates[0].id}:${rowId}:`.length)
        const field = Object.entries(database.definition.fields).find(([, value]) => value.id === fieldId && value.type === 'date')
        const row = database.rows.find(item => item.id === rowId)
        if (!field || !row) libraryFailure()
        addDate({ id: requested.id, layer: 'documents', title: `${row.title} · ${field[1].name}`, ref: parsed.ref, objectId: rowId, version: row.version }, row.values[field[0]])
      } catch {
        // silent-catch: the requested database item has no matching result and is marked unavailable below.
      }
    }
    const from = startOfDayMs(day, selection.timeZone), to = startOfDayMs(day + 1, selection.timeZone)
    type Reading = { id: string; object_id: string; started_at: number; ended_at: number; book_id?: string; loc?: string }
    for (const table of ['document_reading_sessions', 'library_reading_sessions'] as const) {
      const rows = this.registry.db.prepare(`SELECT * FROM ${table} WHERE workspace_root=? AND started_at<? AND ended_at>?`).all<Reading>(this.root, to, from)
      for (const row of rows) {
        const id = `reading:${row.book_id ? 'book' : 'document'}:${row.id}:${selection.date}`
        if (!selection.items.some(item => item.id === id)) continue
        const source = selectedObjects.get(row.object_id)
        if (!source) continue
        for (const piece of splitReading(row.started_at, row.ended_at, range)) layers.push({ ...piece, id, layer: 'footprints', title: `阅读 · ${basename(source.path)}`, objectId: row.object_id, lastDate: piece.date,
          ref: row.book_id && row.loc ? { kind: 'book-location', book: row.book_id, loc: row.loc } : { kind: 'file', id: row.object_id } })
      }
    }
    const summary = new CalendarLinkageService(this.registry, this.root, this.calendar).day({ date: selection.date, timeZone: selection.timeZone }, layers, new DateMentionService(this.registry.db, this.calendar).list())
    const items = selection.items.map(requested => {
      const matches = summary.items.filter(item => item.id === requested.id && toReadyUri(item.ref) === requested.uri && selection.categories.includes(item.kind))
      const id = objectId(requested.uri)
      if (matches.length !== 1 || id && !selectedObjects.get(id)) {
        return { ...requested, status: 'unavailable' as const, message: '此项已删除、已变化或无法读取' }
      }
      return matches[0]
    })
    return { items, version: libraryHash(JSON.stringify(items)) }
  }
}
