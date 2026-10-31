import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, statSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from './utils/ready-object-fixture'
import { CalendarStore } from '../main/modules/database/calendar-store'
import { LibraryReadSources, libraryHash } from '../main/modules/agent-control/codex-runtime/library-read-sources'
import { LibraryReadResources, libraryBindingsMatch, libraryTools } from '../main/modules/agent-control/codex-runtime/library-read-resources'
import { LIBRARY_READ_TOOL_NAMES, type LibraryReadTool } from '../main/modules/agent-control/codex-runtime/library-read-tools'
import { resolveCodexExplicitResources } from '../main/modules/agent-control/codex-runtime/codex-explicit-resources'
import { toReadyUri } from '../shared/ready-ref'
import { writeDatabase } from '../shared/document-database'
import { sourceNoteContent } from '../main/modules/library-engine/source-note'
import { type LibraryResourceSelection, libraryResourceSelectionSchema } from '../shared/ipc-contracts/agent-runtime'
import { ObjectLinkRepository } from '../main/modules/search-engine/object-links'
import { textNode } from './utils/canvas-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

type DocumentSelection = Extract<LibraryResourceSelection, { kind: 'document_selection' }>
function setup() {
  const f = fixture(), calendar = new CalendarStore(() => f.db)
  let writeCalls = 0
  const prepare = f.db.prepare.bind(f.db), exec = f.db.exec.bind(f.db)
  Object.defineProperty(f.db, 'prepare', { value: (sql: string) => {
    const statement = prepare(sql), run = statement.run.bind(statement)
    Object.defineProperty(statement, 'run', { value: (...args: unknown[]) => { writeCalls++; return run(...args) } })
    return statement
  } })
  Object.defineProperty(f.db, 'exec', { value: (sql: string) => { writeCalls++; return exec(sql) } })
  const sources = new LibraryReadSources(f.registry, f.root, calendar), reader = new LibraryReadResources(sources)
  function page(path: string, content: string, access: DocumentSelection['access'] = 'text'): DocumentSelection {
    const file = join(f.root, path); writeFileSync(file, content)
    const object = f.registry.register(file)
    return { kind: 'document_selection', id: object.id, name: path, libraryId: sources.libraryId, target: { kind: 'object', uri: toReadyUri({ kind: 'page', id: object.id }) }, version: libraryHash(content), range: { start: 0, end: content.length }, summary: { characters: content.length, digest: libraryHash(content) }, access }
  }
  function disk(path = f.root): unknown {
    return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
      const child = join(path, entry.name)
      return [entry.name, entry.isDirectory() ? disk(child) : [libraryHash(readFileSync(child)), statSync(child).mtimeMs]]
    })
  }
  const snapshot = () => ({ writeCalls, disk: disk(), database: f.db.serialize(), changes: f.db.prepare('SELECT total_changes() AS n').get() })
  return { ...f, calendar, sources, reader, page, snapshot }
}

test('M7 admission rejects forged, ambiguous, cross-library, stale, unsupported-buffer, unidentified, out-of-range and malformed selections without disclosure or writes', async t => {
  if (skipIfSqliteUnavailable(t, 'M7 library resources')) return
  const f = setup()
  try {
    const selection = f.page('private.md', 'PRIVATE_FULL_BODY')
    const before = f.snapshot()
    const invalid: unknown[] = [
      { ...selection, target: { kind: 'object', uri: 'ready://doc/page/missing' } },
      { ...selection, target: { kind: 'object', uri: 'file:///secret' } },
      { ...selection, libraryId: 'f'.repeat(64) }, { ...selection, version: '0'.repeat(64) },
      { ...selection, target: { kind: 'draft', draftId: '' } },
      { ...selection, range: { start: 0, end: 100000 } },
      { ...selection, summary: { characters: 17, digest: '0'.repeat(64) } },
      { ...selection, text: 'PRIVATE_FULL_BODY' },
      { kind: 'quoted_text', id: 'old', name: 'private', text: 'PRIVATE_FULL_BODY' },
      { ...selection, buffer: { kind: 'current_document', logicalResourceId: 'ready-current-document:scope:closed', tabId: 'closed', title: 'private', pane: 'primary', pathDigest: 'a'.repeat(64), incarnationKey: 'b'.repeat(64), currentVersion: `sha256:${selection.version}`, currentDigest: selection.version, supersedesVersion: null, policyEpoch: 1, readScope: { operation: 'read_section', maxChars: 30000 } } },
    ]
    for (const input of invalid) await assert.rejects(f.reader.admit(input), error => {
      assert.equal(String(error), 'Error: library_resource_unavailable'); return true
    })
    assert.deepEqual(f.snapshot(), before)
    f.db.prepare("UPDATE objects SET identity_state='conflict',embedded_ready_id='duplicate' WHERE id=?").run(selection.id)
    const conflict = f.snapshot(); await assert.rejects(f.reader.admit(selection), /library_resource_unavailable/); assert.deepEqual(f.snapshot(), conflict)
    f.db.prepare("UPDATE objects SET identity_state='local',embedded_ready_id=NULL WHERE id=?").run(selection.id)
    writeFileSync(join(f.root, 'private.md'), 'newer content')
    const changed = f.snapshot(); await assert.rejects(f.reader.admit(selection), /library_resource_unavailable/); assert.deepEqual(f.snapshot(), changed)
  } finally { f.close() }
})

test('M7 actual model input carries identity, scope, version and read method, never selected body; frozen binding cannot be widened', async t => {
  if (skipIfSqliteUnavailable(t, 'M7 library resources')) return
  const f = setup()
  try {
    const selection = f.page('selected.md', 'SECRET_FULL_TEXT unique')
    const result = await resolveCodexExplicitResources({ selections: [selection], resolveSkill: () => null, resolveLibrary: raw => f.reader.admit(raw) })
    assert.equal(JSON.stringify(result.input).includes('SECRET_FULL_TEXT'), false)
    assert.equal(JSON.stringify(result.input).includes(f.root), false)
    assert.match(JSON.stringify(result.input), /library_read_page/)
    assert.equal(result.requestResources[0].text, '')
    const grant = result.libraryResources[0]
    assert.equal(libraryBindingsMatch([grant], result.resourceRefs, libraryTools(selection)), true)
    assert.equal(libraryBindingsMatch([grant], result.resourceRefs, []), false)
    assert.equal(libraryBindingsMatch([{ ...grant, selection: { ...selection, range: { start: 0, end: 1 } } }], result.resourceRefs, libraryTools(selection)), false)
    assert.equal(libraryBindingsMatch([grant, grant], result.resourceRefs, libraryTools(selection)), false)
    const unavailable = await resolveCodexExplicitResources({ selections: [selection], resolveSkill: () => null })
    assert.equal(unavailable.requestResources[0].canRead, false)
    assert.equal(unavailable.libraryResources.length, 0)
  } finally { f.close() }
})

test('M7 every read tool enforces resource authority, pagination, versions and no disk/database mutation', async t => {
  if (skipIfSqliteUnavailable(t, 'M7 library resources')) return
  const f = setup()
  try {
    mkdirSync(join(f.root, 'rows'))
    const a = f.page('rows/a.md', '---\nvalue: 1\n---\nAlpha body'), b = f.page('rows/b.md', '---\nvalue: 2\n---\nBeta body')
    const database = f.page('data.md', writeDatabase('# Data\n', { version: 1, source: 'rows', fields: { value: { id: 'value', name: 'value', type: 'number' } }, views: [{ id: 'table', name: 'Table', type: 'table' }] }), 'database')
    const boardContent = JSON.stringify({ ready: { id: 'board', schemaVersion: 1 }, nodes: [textNode('n1'), textNode('n2'), textNode('hidden')], edges: [{ id: 'edge', fromNode: 'n1', toNode: 'n2' }, { id: 'outside', fromNode: 'n1', toNode: 'hidden' }] })
    writeFileSync(join(f.root, 'board.canvas'), boardContent); f.registry.register(join(f.root, 'board.canvas'))
    const board: LibraryResourceSelection = { kind: 'board_selection', id: 'board-selection', name: 'Board', libraryId: f.sources.libraryId, uri: toReadyUri({ kind: 'canvas', id: 'board' }), version: libraryHash(boardContent), nodeIds: ['n1', 'n2'] }
    writeFileSync(join(f.root, 'book.txt'), 'Book secret chapter content')
    const note = sourceNoteContent({ ready_id: 'book', 类型: '书', 作者: '', 分类: 'unsorted', tags: [], 状态: '想读', 文件: 'book.txt', 加入: '2026-10-31', 来源: { kind: 'local' } }).replace('## 我的笔记', '> [!quote|yellow] Chapter · [原文](ready://read/book/book#c0:0+4)\n> Book\n^hl-one\n\n## 我的笔记')
    const source = f.page('source.md', note, 'highlights')
    const bookData = await f.sources.book('book')
    const bookStart = bookData.chapters[0].text.indexOf('Book secret')
    assert.ok(bookStart >= 0)
    const book: LibraryResourceSelection = { kind: 'book_location', id: 'book-selection', name: 'Book', libraryId: f.sources.libraryId, uri: toReadyUri({ kind: 'book-location', book: 'book', loc: `c0:${bookStart}+8` }), version: bookData.version, chapter: 0, range: { start: bookStart, end: bookStart + 8 } }
    f.calendar.putCalendar({ id: 'local', accountId: 'local', name: 'Local', color: '#123456', visible: true })
    const start = Date.parse('2026-10-30T16:00:00Z')
    for (const id of ['e1', 'e2', 'hidden']) f.calendar.mutate({ type: 'create', event: { id, uid: id, calendarId: 'local', title: `Private event ${id}`, start, end: start + 60000, timeZone: 'Asia/Tokyo', allDay: false, status: 'confirmed', transparency: 'opaque', createdAt: start, updatedAt: start } }, {})
    const day: LibraryResourceSelection = { kind: 'calendar_day', id: 'day', name: 'Day', libraryId: f.sources.libraryId, date: '2026-10-31', timeZone: 'Asia/Tokyo', categories: ['events'], items: ['e1', 'e2'].map(id => ({ id: `event:${id}`, uri: toReadyUri({ kind: 'event', id }) })) }
    new ObjectLinkRepository(f.db).replace({ objectId: a.id }, [{ kind: 'ready-ref', rawTarget: toReadyUri({ kind: 'page', id: b.id }), targetText: '', fragment: null, sourceLine: 1, sourceOffset: 0 }], a.version)
    const grants = await Promise.all([a, b, database, board, source, book, day].map(s => f.reader.admit(s)))
    const model = await resolveCodexExplicitResources({ selections: [a, board, book, day], resolveSkill: () => null, resolveLibrary: raw => f.reader.admit(raw) })
    for (const body of ['Alpha body', 'hello world', 'Book secret', 'Private event']) assert.equal(JSON.stringify(model.input).includes(body), false)
    const toolResource: Record<LibraryReadTool, string> = { library_list_pages: a.id, library_read_page: a.id, library_read_database: database.id, library_query_database: database.id, library_read_board: board.id, library_read_book: book.id, library_read_highlights: source.id, library_query_links: a.id, library_read_calendar: day.id }
    for (const tool of LIBRARY_READ_TOOL_NAMES) await t.test(tool, async () => {
      const grant = grants.find(g => g.selection.id === toolResource[tool])!
      const params = { resourceId: grant.selection.id, expectedVersion: grant.version,
        ...(tool === 'library_read_database' ? {} : tool === 'library_read_page' || tool === 'library_read_book' ? { offset: 0, length: 2 } : { offset: 0, limit: 1 }),
        ...(tool === 'library_query_database' ? { viewId: 'table' } : {}), ...(tool === 'library_query_links' ? { direction: 'outgoing' } : {}) }
      const before = f.snapshot()
      const result = await f.reader.execute(tool, params, grants)
      assert.equal(result.ok, true); assert.equal(result.version, grant.version); assert.equal(result.coverage, 'selected_objects')
      assert.equal(result.complete, result.nextOffset === null)
      const list = result.items as Array<Record<string, unknown>> | undefined
      switch (tool) {
        case 'library_list_pages': assert.deepEqual(list, [{ id: a.id, target: a.target, name: a.name, version: a.version }]); break
        case 'library_read_page': assert.equal(result.text, '--'); assert.equal(result.total, 27); break
        case 'library_read_book': assert.equal(result.text, 'Bo'); assert.equal(result.total, 8); break
        case 'library_read_database': assert.deepEqual(result.definition, f.sources.database(database.id, []).definition); assert.deepEqual(list, []); break
        case 'library_query_database': {
          const first = [a, b].sort((x, y) => x.id < y.id ? -1 : 1)[0]
          assert.equal(list?.[0].id, first.id)
          assert.deepEqual(list?.[0].values, { value: first.id === a.id ? 1 : 2 })
          assert.deepEqual({ ...list?.[0].cells as Record<string, unknown> }, { $id: { status: 'value', value: first.id }, $title: { status: 'value', value: first.id === a.id ? 'a' : 'b' }, value: { status: 'value', value: first.id === a.id ? 1 : 2 } })
          break
        }
        case 'library_read_board': assert.deepEqual(list, [textNode('n1')]); assert.deepEqual(result.edges, [{ id: 'edge', fromNode: 'n1', toNode: 'n2' }]); break
        case 'library_read_highlights': assert.equal(list?.[0].id, 'hl-one'); assert.equal(list?.[0].text, 'Book'); break
        case 'library_query_links': assert.equal(list?.[0].source_id, a.id); assert.equal(list?.[0].target_id, b.id); break
        case 'library_read_calendar': assert.deepEqual(list, [{ id: 'event:e1', kind: 'events', title: 'Private event e1', ref: { kind: 'event', id: 'e1' }, detail: '01:00' }]); break
      }
      if (result.nextOffset !== null) {
        const next = await f.reader.execute(tool, { ...params, offset: result.nextOffset }, grants)
        assert.equal(next.offset, result.nextOffset)
      }
      if (tool === 'library_read_page' || tool === 'library_read_book') {
        let text = String(result.text), offset = result.nextOffset
        while (offset !== null) {
          const next = await f.reader.execute(tool, { ...params, offset }, grants)
          text += String(next.text); offset = next.nextOffset
        }
        assert.equal(text, tool === 'library_read_page' ? '---\nvalue: 1\n---\nAlpha body' : 'Book sec')
      }
      await assert.rejects(f.reader.execute(tool, { ...params, resourceId: 'outside' }, grants), /library_resource_unavailable/)
      await assert.rejects(f.reader.execute(tool, { ...params, expectedVersion: '0'.repeat(64) }, grants), /library_resource_unavailable/)
      await assert.rejects(f.reader.execute(tool, { ...params, extra: true }, grants), /library_resource_unavailable/)
      if (tool !== 'library_read_database') await assert.rejects(f.reader.execute(tool, { ...params, offset: 100000 }, grants), /library_resource_unavailable/)
      if (tool === 'library_read_highlights') { assert.equal(result.total, 1); assert.match(JSON.stringify(result.items), /Book/) }
      assert.deepEqual(f.snapshot(), before)
      if (tool === 'library_read_board') { assert.equal(result.total, 2); assert.equal(JSON.stringify(result).includes('outside'), false) }
      if (tool === 'library_read_calendar') { assert.equal(result.total, 2); assert.equal(JSON.stringify(result).includes('hidden'), false) }
    })
    const onlyA = grants.find(g => g.selection.id === a.id)!
    const links = await f.reader.execute('library_query_links', { resourceId: a.id, expectedVersion: onlyA.version, direction: 'outgoing', offset: 0, limit: 10 }, [onlyA])
    assert.equal(links.targetsAuthorized, false)
    await assert.rejects(f.reader.execute('library_read_page', { resourceId: b.id, expectedVersion: b.version, offset: 0, length: 2 }, [onlyA]), /library_resource_unavailable/)
    const dbGrant = grants.find(g => g.selection.id === database.id)!
    const empty = await f.reader.execute('library_query_database', { resourceId: database.id, expectedVersion: dbGrant.version, viewId: 'table', offset: 0, limit: 10 }, [dbGrant])
    assert.equal(empty.total, 0); assert.equal(empty.complete, true)
    f.db.prepare("INSERT INTO document_database_operations(id,database_id,request_json,plan_json,state) VALUES(?,?,?,?,'prepared')").run('pending', database.id, '{}', '{}')
    const pending = f.snapshot()
    await assert.rejects(f.reader.execute('library_read_database', { resourceId: database.id, expectedVersion: dbGrant.version }, grants), /library_resource_unavailable/)
    assert.deepEqual(f.snapshot(), pending)
    f.db.prepare('DELETE FROM document_database_operations WHERE id=?').run('pending')

    f.db.prepare('DELETE FROM object_links WHERE source_id=?').run(a.id)
    const afterLinks = f.snapshot()
    await assert.rejects(f.reader.execute('library_query_links', { resourceId: a.id, expectedVersion: onlyA.version, direction: 'outgoing', offset: 0, limit: 1 }, [onlyA]), /library_resource_unavailable/)
    assert.deepEqual(f.snapshot(), afterLinks)
    writeFileSync(join(f.root, 'rows/a.md'), 'new body')
    const afterEdit = f.snapshot()
    await assert.rejects(f.reader.execute('library_read_page', { resourceId: a.id, expectedVersion: onlyA.version, offset: 2, length: 2 }, [onlyA]), /library_resource_unavailable/)
    assert.deepEqual(f.snapshot(), afterEdit)

  } finally { f.close() }
})

test('M7 invalid calendar zones/dates, foreign paths and selection-body fields fail closed', async t => {
  if (skipIfSqliteUnavailable(t, 'M7 library resources')) return
  const f = setup(), other = setup()
  try {
    const target = other.page('foreign.md', 'FOREIGN')
    symlinkSync(join(other.root, 'foreign.md'), join(f.root, 'alias.md'))
    const base = f.page('local.md', 'LOCAL')
    f.db.prepare('UPDATE objects SET current_path=? WHERE id=?').run(join(f.root, 'alias.md'), base.id)
    const before = f.snapshot()
    await assert.rejects(f.reader.admit(base), /library_resource_unavailable/)
    assert.equal(libraryResourceSelectionSchema.safeParse({ ...base, body: 'forged' }).success, false)
    await assert.rejects(f.reader.admit({ kind: 'calendar_day', id: 'day', name: 'Day', libraryId: f.sources.libraryId, date: '2026-02-30', timeZone: 'Invalid/Zone', categories: [], items: [] }), /library_resource_unavailable/)
    await assert.rejects(f.reader.admit({ ...target, libraryId: f.sources.libraryId }), /library_resource_unavailable/)
    assert.deepEqual(f.snapshot(), before)
  } finally { f.close(); other.close() }
})


test('M7 day preserves moved documents, tasks and reading; deleted and unreadable objects are individually unavailable', async t => {
  if (skipIfSqliteUnavailable(t, 'M7 library resources')) return
  const f = setup()
  try {
    const content = '---\ntitle: Moved page\ndate: 2026-10-31\n---\n- [ ] Finish [today](ready://calendar/day/2026-10-31)'
    const page = f.page('old.md', content), deleted = f.page('deleted.md', 'gone'), unreadable = f.page('unreadable.md', 'indexed')
    const invalidDate = f.page('2026-02-30.md', '---\ndate: 2026-10-31\n---\nValid frontmatter date')
    const start = Date.parse('2026-10-31T10:00:00Z')
    for (const [id, objectId] of [['read', page.id], ['gone', deleted.id]]) {
      f.db.prepare('INSERT INTO document_reading_sessions(id,path_at_event,source,active_ms,workspace_root,object_id,started_at,ended_at) VALUES(?,?,?,?,?,?,?,?)').run(id, 'old.md', 'document', 60000, f.root, objectId, start, start + 60000)
    }
    renameSync(join(f.root, 'old.md'), join(f.root, 'moved.md'))
    unlinkSync(join(f.root, 'deleted.md'))
    f.registry.reconcile([join(f.root, 'old.md'), join(f.root, 'moved.md'), join(f.root, 'deleted.md')])
    writeFileSync(join(f.root, 'unreadable.md'), 'unindexed new body')
    for (const [id, objectId] of [['saved', page.id], ['saved-deleted', deleted.id]]) {
      f.db.prepare('INSERT INTO file_activity_events(id,path_at_event,workspace_root,event_type,source,created_at,object_id) VALUES(?,?,?,?,?,?,?)').run(id, 'old.md', f.root, 'save', 'document', start, objectId)
    }
    const { datedTasks } = await import('../shared/calendar-layers')
    const task = datedTasks(content)[0]
    const items = [
      { id: `page:${page.id}`, uri: toReadyUri({ kind: 'page', id: page.id }) },
      { id: `task:${page.id}:${task.start}`, uri: toReadyUri({ kind: 'page', id: page.id }) },
      { id: 'reading:document:read:2026-10-31', uri: toReadyUri({ kind: 'file', id: page.id }) },
      { id: 'reading:document:gone:2026-10-31', uri: toReadyUri({ kind: 'file', id: deleted.id }) },
      { id: `page:${unreadable.id}`, uri: toReadyUri({ kind: 'page', id: unreadable.id }) },
      { id: `page:${invalidDate.id}`, uri: toReadyUri({ kind: 'page', id: invalidDate.id }) },
      { id: `activity:${page.id}`, uri: toReadyUri({ kind: 'page', id: page.id }) },
      { id: `activity:${deleted.id}`, uri: toReadyUri({ kind: 'page', id: deleted.id }) },
    ]
    const selection: LibraryResourceSelection = { kind: 'calendar_day', id: 'day', name: 'Day', libraryId: f.sources.libraryId, date: '2026-10-31', timeZone: 'UTC', categories: ['documents', 'tasks', 'footprints', 'activity'], items }
    const before = f.snapshot(), grant = await f.reader.admit(selection)
    const result = await f.reader.execute('library_read_calendar', { resourceId: 'day', expectedVersion: grant.version, offset: 0, limit: 100 }, [grant])
    assert.deepEqual(result.items, [
      { id: items[0].id, kind: 'documents', title: 'Moved page', ref: { kind: 'page', id: page.id } },
      { id: items[1].id, kind: 'tasks', title: '☐ Finish today', ref: { kind: 'page', id: page.id } },
      { id: items[2].id, kind: 'footprints', title: '阅读 · moved.md', ref: { kind: 'file', id: page.id } },
      { ...items[3], status: 'unavailable', message: '此项已删除、已变化或无法读取' },
      { ...items[4], status: 'unavailable', message: '此项已删除、已变化或无法读取' },
      { id: items[5].id, kind: 'documents', title: '2026-02-30', ref: { kind: 'page', id: invalidDate.id } },
      { id: items[6].id, kind: 'activity', title: 'moved.md', ref: { kind: 'page', id: page.id }, detail: '创建或修改' },
      { ...items[7], status: 'unavailable', message: '此项已删除、已变化或无法读取' },
    ])
    assert.equal(result.complete, true)
    assert.deepEqual(f.snapshot(), before)
  } finally { f.close() }
})

for (const extension of ['txt', 'markdown']) test(`M7 ${extension} renderer selection reads the exact saved text`, async t => {
  if (skipIfSqliteUnavailable(t, 'M7 library resources')) return
  const f = setup()
  try {
    const { buildLibraryDocumentSelection } = await import('../renderer/modules/agent/libraryResourceSelection')
    const page = f.page(`plain.${extension}`, 'hello world')
    const selection = await buildLibraryDocumentSelection({ id: 'q', name: 'Q', path: '', type: 'text', size: 5, ext: '.quote', source: 'document-quote', selection: 'world' },
      { id: 'tab', objectId: page.id, path: join(f.root, `plain.${extension}`), content: 'hello world', isDirty: false }, f.root)
    const grant = await f.reader.admit(selection)
    const result = await f.reader.execute('library_read_page', { resourceId: 'q', expectedVersion: grant.version, offset: 0, length: 100 }, [grant])
    assert.equal(result.text, 'world'); assert.equal(result.total, 5); assert.equal(result.complete, true)
  } finally { f.close() }
})


test('M7 file/link cards return card data without opening their targets', async t => {
  if (skipIfSqliteUnavailable(t, 'M7 library resources')) return
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected_target_fetch') })
  const f = setup()
  try {
    const nodes = [
      { id: 'file', type: 'file', file: 'missing.md', x: 0, y: 0, width: 100, height: 100, ready: { kind: 'document', ref: { kind: 'page', id: 'missing' } } },
      { id: 'link', type: 'link', url: 'https://example.invalid/private', x: 100, y: 0, width: 100, height: 100, ready: { kind: 'link' } },
    ]
    const content = JSON.stringify({ ready: { id: 'cards', schemaVersion: 1 }, nodes, edges: [] })
    writeFileSync(join(f.root, 'cards.canvas'), content); f.registry.register(join(f.root, 'cards.canvas'))
    const read = f.sources.object.bind(f.sources), reads: string[] = []
    f.sources.object = id => { reads.push(id); return read(id) }
    const before = f.snapshot()
    const grant = await f.reader.admit({ kind: 'board_selection', id: 'cards', name: 'Cards', libraryId: f.sources.libraryId, uri: toReadyUri({ kind: 'canvas', id: 'cards' }), version: libraryHash(content), nodeIds: ['file', 'link'] })
    const result = await f.reader.execute('library_read_board', { resourceId: 'cards', expectedVersion: grant.version, offset: 0, limit: 100 }, [grant])
    assert.deepEqual(result.items, nodes); assert.deepEqual(result.edges, [])
    assert.deepEqual(reads, ['cards', 'cards']); assert.equal(fetch.mock.callCount(), 0); assert.deepEqual(f.snapshot(), before)
  } finally { f.close() }
})

test('M7 relation fields preserve references and mark aggregates incomplete without reading targets', async t => {
  if (skipIfSqliteUnavailable(t, 'M7 library resources')) return
  const f = setup()
  try {
    mkdirSync(join(f.root, 'rows'))
    const row = f.page('rows/a.md', '---\nrelated: ["[[private]]"]\n---\nA')
    const target = f.page('private.md', '---\namount: 999\n---\nSECRET_TARGET')
    const database = f.page('db.md', writeDatabase('', { version: 1, source: 'rows', fields: {
      related: { id: 'related', name: 'Related', type: 'relation' }, total: { id: 'total', name: 'Total', type: 'rollup', relation: 'related', target: 'amount', operation: 'sum' },
    }, views: [{ id: 'table', name: 'Table', type: 'table' }] }), 'database')
    const reads: string[] = [], read = f.sources.object.bind(f.sources)
    f.sources.object = id => { reads.push(id); return read(id) }
    const before = f.snapshot(), grants = await Promise.all([database, row].map(s => f.reader.admit(s)))
    const result = await f.reader.execute('library_query_database', { resourceId: database.id, expectedVersion: grants[0].version, viewId: 'table', offset: 0, limit: 100 }, grants)
    const rows = result.items as Array<{ id: string; cells: Record<string, unknown> }>
    assert.equal(rows.length, 1); assert.equal(rows[0].id, row.id)
    assert.deepEqual(rows[0].cells.related, { status: 'value', value: ['[[private]]'] })
    assert.deepEqual(rows[0].cells.total, { status: 'incomplete', reasons: ['target_not_authorized'] })
    assert.equal(reads.includes(target.id), false); assert.equal(JSON.stringify(result).includes('SECRET_TARGET'), false)
    assert.deepEqual(f.snapshot(), before)
  } finally { f.close() }
})
