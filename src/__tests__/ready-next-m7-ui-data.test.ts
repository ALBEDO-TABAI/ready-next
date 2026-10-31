import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import type { IpcMain } from 'electron'
import { fixture } from './utils/ready-object-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { textNode } from './utils/canvas-fixture'
import { CalendarStore } from '../main/modules/database/calendar-store'
import { LibraryReadSources, libraryHash } from '../main/modules/agent-control/codex-runtime/library-read-sources'
import { LibraryReadResources } from '../main/modules/agent-control/codex-runtime/library-read-resources'
import { resolveCodexExplicitResources } from '../main/modules/agent-control/codex-runtime/codex-explicit-resources'
import { registerLibraryAgentSelectionIPC } from '../main/modules/library-engine/agent-selection-ipc'
import { sourceNoteContent } from '../main/modules/library-engine/source-note'
import { writeDatabase } from '../shared/document-database'
import { toReadyUri } from '../shared/ready-ref'
import { libraryResourceSelectionSchema } from '../shared/ipc-contracts/agent-runtime'
import type { LibrarySelectionRequest } from '../renderer/modules/agent/libraryResourceSelection'

// Only transport is substituted: registered IPC, Renderer stores, files, SQLite and admission are real.
export const __breaksInvariants = ['renderer.agent-store.reset-for-isolated-selection-test'] as const

test('M7 UI data: three chat entries round-trip through read-only IPC and real Main admission', async t => {
  if (skipIfSqliteUnavailable(t, 'M7 UI data round-trip')) return
  const f = fixture(), dom = new JSDOM('', { url: 'http://localhost' })
  const globals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, CustomEvent: dom.window.CustomEvent, localStorage: dom.window.localStorage })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, value })
  }
  t.after(() => { dom.window.close(); f.close(); for (const [key, value] of globals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key) } })
  const sources = new LibraryReadSources(f.registry, f.root, new CalendarStore(() => f.db)), reader = new LibraryReadResources(sources)
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
  registerLibraryAgentSelectionIPC({ handle: (name, handler) => { handlers.set(name, handler) } }, async () => reader)
  let beforeReply: (() => void) | undefined
  const invoke = async (request: LibrarySelectionRequest) => {
    const reply = await handlers.get('library:prepareAgentSelection')!({} as Electron.IpcMainInvokeEvent, request)
    beforeReply?.()
    return reply
  }
  Object.defineProperty(dom.window, 'electronAPI', { value: { library: { prepareAgentSelection: invoke }, objects: { onMoved: () => () => {} } } })
  dom.window.localStorage.setItem('ready-object-presentation-migration-v1', JSON.stringify({ migrationId: 'test', applied: true, report: { state: 'completed', resolved: [], unresolved: [] } }))
  const { useAgent } = await import('../renderer/stores/useAgent')
  const { useWorkspace } = await import('../renderer/stores/useWorkspace')
  const bridge = await import('../renderer/modules/agent/chat-input-bridge')
  const builders = await import('../renderer/modules/agent/libraryResourceSelection')
  const { buildCodexIngressInputWithDiagnostics } = await import('../renderer/modules/agent/messageComposer')
  useAgent.setState({ attachments: [], filePool: [], sessions: {} })
  useWorkspace.setState({ chatPanelVisible: false })
  let focused = 0
  dom.window.addEventListener(bridge.READY_FOCUS_CHAT_INPUT_EVENT, () => focused++)
  const page = (name: string, content: string) => { const path = join(f.root, name); writeFileSync(path, content); return { title: name, objectId: f.registry.register(path).id } }
  const boardPath = join(f.root, 'ideas.canvas')
  writeFileSync(boardPath, JSON.stringify({ ready: { id: 'board', schemaVersion: 1 }, nodes: [textNode('a'), textNode('b'), textNode('c'), textNode('hidden')], edges: [] }, null, 2))
  f.registry.register(boardPath)
  mkdirSync(join(f.root, 'rows'))
  const rows = [page('rows/one.md', '---\nvalue: 1\n---\nFirst row'), page('rows/two.md', '---\nvalue: 2\n---\nSecond row')]
  page('rows/hidden.md', '---\nvalue: 99\n---\nUnselected row')
  const outside = page('outside.md', 'Outside database')
  const database = { ...page('tasks.md', writeDatabase('# Tasks\n', { version: 1, source: 'rows', fields: { value: { id: 'value', name: 'Value', type: 'number' } }, views: [{ id: 'table', name: 'Table', type: 'table' }] })), title: '任务库' }
  const bookPath = join(f.root, 'book.txt')
  writeFileSync(bookPath, '第一章\n\n甲 乙😀丙 丁\n尾声')
  page('book.md', sourceNoteContent({ ready_id: 'book', 类型: '书', 作者: '', 分类: 'unsorted', tags: [], 状态: '想读', 文件: 'book.txt', 加入: '2026-10-31', 来源: { kind: 'local' } }))
  const bookData = await sources.book('book')
  const chapter = bookData.chapters.findIndex(c => c.text.includes('甲'))
  assert.ok(chapter >= 0)
  const text = bookData.chapters[chapter].text, start = text.indexOf('乙'), end = text.indexOf('丁') + 1
  const location = { chapter, from: text.slice(0, start).replace(/\s/g, '').length, to: text.slice(0, end).replace(/\s/g, '').length }
  function disk(path = f.root): unknown {
    return readdirSync(path, { withFileTypes: true }).map(entry => [entry.name, entry.isDirectory() ? disk(join(path, entry.name)) : libraryHash(readFileSync(join(path, entry.name)))])
  }
  const before = { db: f.db.serialize(), disk: disk(), changes: f.db.prepare('SELECT total_changes() AS n').get() }
  await bridge.addBoardSelectionToAgentInput({ title: '灵感', path: boardPath }, ['a', 'b', 'c'])
  await bridge.addBookLocationToAgentInput('book', location, '书名', text.slice(start, end))
  await bridge.addDatabaseRowsToAgentInput(database, rows)
  const attachments = useAgent.getState().attachments
  assert.equal(attachments.length, 5)
  assert.deepEqual(attachments.map(a => a.libraryResource?.kind), ['board_selection', 'book_location', 'document_selection', 'document_selection', 'document_selection'])
  for (const attachment of attachments) {
    assert.ok(libraryResourceSelectionSchema.safeParse(attachment.libraryResource).success)
    assert.equal(attachment.libraryResource?.id, attachment.id)
    assert.equal(attachment.name, attachment.libraryResource?.name)
    assert.match(attachment.path, /^ready:\/\//)
  }
  assert.equal(attachments[0].name, '灵感 · 3 张卡')
  assert.equal(attachments[1].name, `《书名》第 ${chapter + 1} 章 · 乙😀丙 丁`)
  assert.equal(attachments[2].name, '任务库 · 2 行')
  assert.equal(attachments[1].path, toReadyUri({ kind: 'book-location', book: 'book', loc: `c${chapter}:${location.from}+${location.to - location.from}` }), 'chip navigation retains reader offsets; read authorization uses chapter source offsets')
  assert.equal(focused, 3); assert.equal(useWorkspace.getState().chatPanelVisible, true)
  const ingress = await buildCodexIngressInputWithDiagnostics({ content: '阅读选中资料', attachments })
  const admitted = await resolveCodexExplicitResources({ selections: ingress.resources, resolveSkill: () => null, resolveLibrary: raw => reader.admit(raw) })
  assert.equal(admitted.libraryResources.length, 5)
  assert.equal(admitted.requestResources.every(r => r.canRead), true)
  const board = admitted.libraryResources[0], book = admitted.libraryResources[1], db = admitted.libraryResources[2]
  assert.equal(board.version, libraryHash(readFileSync(boardPath)), 'version uses original file bytes, including formatting')
  assert.deepEqual(book.selection.kind === 'book_location' && book.selection.range, { start, end })
  const quote = await reader.execute('library_read_book', { resourceId: book.selection.id, expectedVersion: book.version, offset: 0, length: 100 }, admitted.libraryResources)
  assert.equal(quote.text, text.slice(start, end))
  const query = { resourceId: db.selection.id, expectedVersion: db.version, viewId: 'table', offset: 0, limit: 100 }
  const selected = await reader.execute('library_query_database', query, admitted.libraryResources)
  assert.equal(selected.total, 2)
  assert.equal((await reader.execute('library_query_database', query, [db])).total, 0)
  assert.equal(JSON.stringify(selected).includes('Unselected row'), false)
  assert.deepEqual({ db: f.db.serialize(), disk: disk(), changes: f.db.prepare('SELECT total_changes() AS n').get() }, before)

  await t.test('invalid selections and composer changes are readable failures with no partial chips', async () => {
    const count = attachments.length
    for (const attempt of [
      () => bridge.addBoardSelectionToAgentInput({ title: '灵感', objectId: 'board' }, []),
      () => bridge.addBoardSelectionToAgentInput({ title: '灵感', objectId: 'board' }, ['a', 'a']),
      () => bridge.addBoardSelectionToAgentInput({ title: '灵感', objectId: 'board' }, ['missing']),
      () => bridge.addBookLocationToAgentInput('book', { ...location, from: location.from + 2 }, '书名'),
      () => bridge.addBookLocationToAgentInput('book', { ...location, to: 100000 }, '书名'),
      () => bridge.addDatabaseRowsToAgentInput(database, [rows[0], outside]),
      () => bridge.addDatabaseRowsToAgentInput(database, [rows[0], rows[0]]),
      () => bridge.addDatabaseRowsToAgentInput(database, [database]),
    ]) await assert.rejects(attempt(), /[\u4e00-\u9fff]/)
    assert.equal(useAgent.getState().attachments.length, count)
    beforeReply = () => useAgent.setState(state => ({ composerAuthorityRevision: state.composerAuthorityRevision + 1 }))
    await assert.rejects(bridge.addBoardSelectionToAgentInput({ title: '灵感', objectId: 'board' }, ['a']), /会话/)
    beforeReply = undefined
    assert.equal(useAgent.getState().attachments.length, count); assert.equal(focused, 3)
    assert.equal((await builders.buildLibraryDatabaseRows(database, [])).length, 1)
    assert.equal((await builders.buildLibraryBoardSelection({ title: '灵感', objectId: 'board' }, ['a'])).libraryId, sources.libraryId)
    assert.equal((await builders.buildLibraryBookLocation('book', location, '书名')).libraryId, sources.libraryId)
  })

  await t.test('changed board, book asset, database and row reject old selections even after registry refresh', async () => {
    writeFileSync(boardPath, readFileSync(boardPath, 'utf8').replace('hello world', 'changed text'))
    writeFileSync(bookPath, 'Changed book asset')
    for (const path of ['tasks.md', 'rows/one.md']) writeFileSync(join(f.root, path), readFileSync(join(f.root, path), 'utf8') + '\nChanged')
    f.registry.reconcile([boardPath, join(f.root, 'tasks.md'), join(f.root, 'rows/one.md')])
    for (const index of [0, 1, 2, 3]) {
      await assert.rejects(reader.admit(attachments[index].libraryResource), /library_resource_unavailable/)
      const result = await resolveCodexExplicitResources({ selections: [attachments[index].libraryResource!], resolveSkill: () => null, resolveLibrary: raw => reader.admit(raw) })
      assert.equal(result.libraryResources.length, 0); assert.equal(result.requestResources[0].canRead, false)
    }
    assert.ok(await reader.admit(attachments[4].libraryResource))
  })
})
