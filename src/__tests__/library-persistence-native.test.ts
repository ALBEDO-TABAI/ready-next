import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm, rename, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { runMigrations } from '../main/modules/migrations'
import { LibraryReadingRepository } from '../main/modules/library-engine/reading-repository'
import { LibraryEngine } from '../main/modules/library-engine/library-engine'
import { registerLibraryIPC } from '../main/modules/library-engine/ipc-handler'
import { applyDocumentOperation } from '../main/modules/document-engine/document-write-service'
import type { LibraryState } from '../shared/library'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection

// Host Node skips with an [ABI-SKIP] token; verify:native runs this file under Electron.
test('C6 positions/bookmarks survive restart and note moves; writes do not touch the note', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Library reading persistence')) return
  const dir = await mkdtemp(join(tmpdir(), 'ready-library-db-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'vault')
  await mkdir(root)
  const txt = join(dir, 'book.txt')
  await writeFile(txt, 'book')
  const engine = new LibraryEngine({ vault: () => ({ status: 'ready', root, defaultSuggestion: root }) })
  const book = (await engine.importFiles([txt])).imported[0]
  const original = await readFile(book.notePath, 'utf8')
  let db = new Database(join(dir, 'ready.db'))
  try {
    runMigrations(db)
    const repo = new LibraryReadingRepository(db)
    const position = { bookId: book.id, chapter: 2, offset: 99, pct: 0.4, updatedAt: 10 }
    const bookmarks = [{ id: 'mark-1', chapter: 2, offset: 99, label: '笔记', createdAt: 10 }]
    assert.equal(repo.getPosition(book.id), null)
    assert.deepEqual(repo.setPosition(position), position)
    assert.deepEqual(repo.setBookmarks(book.id, bookmarks), bookmarks)
    assert.deepEqual(repo.setBookmarks(book.id, bookmarks), bookmarks)
    assert.throws(() => repo.setPosition({ ...position, offset: -1 }))
    assert.throws(() => repo.setBookmarks(book.id, [...bookmarks, ...bookmarks]))
    db.close()
    db = new Database(join(dir, 'ready.db'))
    runMigrations(db)
    const reopened = new LibraryReadingRepository(db)
    const moved = join(root, '阅读', 'renamed.md')
    await rename(book.notePath, moved)
    assert.equal((await engine.findBook(book.id)).notePath, moved)
    assert.deepEqual(reopened.getPosition(book.id), position)
    assert.deepEqual(reopened.listBookmarks(book.id), bookmarks)
    assert.deepEqual(reopened.listBookmarks('another-book'), [])
    assert.equal(await readFile(moved, 'utf8'), original)
    db.exec('PRAGMA query_only = ON')
    assert.throws(() => reopened.setBookmarks(book.id, []))
    assert.deepEqual(reopened.listBookmarks(book.id), bookmarks)
  } finally { db.close() }
})

test('all library IPC methods return receipts, report invalid inputs and publish changed state', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Library IPC persistence')) return
  const dir = await mkdtemp(join(tmpdir(), 'ready-library-ipc-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  let ready = false
  const txt = join(dir, '书.txt')
  await writeFile(txt, '内容')
  const root = join(dir, 'vault')
  await mkdir(root)
  const engine = new LibraryEngine({
    vault: () => ready ? { status: 'ready', root, defaultSuggestion: root } : { status: 'unconfigured', defaultSuggestion: root },
    write: input => applyDocumentOperation(input, { index: async () => {} }),
  })
  const db = new Database(':memory:')
  t.after(() => db.close())
  runMigrations(db)
  const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()
  const events: LibraryState[] = []
  registerLibraryIPC({ handle: (name, fn) => { handlers.set(name, fn) } }, {
    engine, reading: new LibraryReadingRepository(db), pickFiles: async () => [txt], changed: state => { events.push(state) },
  })
  const invoke = async (name: string, payload?: unknown) => {
    const handler = handlers.get(`library:${name}`)
    assert.ok(handler)
    return await handler({}, payload)
  }
  assert.deepEqual(await invoke('get'), { success: true, data: { status: 'no_vault' } })
  assert.partialDeepStrictEqual(await invoke('importFiles', [txt]), { success: false, code: 'no_vault' })
  ready = true
  assert.partialDeepStrictEqual(await invoke('importFiles', 'bad'), { success: false })
  const imported = await invoke('pickAndImport')
  assert.partialDeepStrictEqual(imported, { success: true })
  const state = await engine.get()
  if (state.status !== 'ready') throw new Error('expected ready')
  const id = state.books[0].id
  assert.deepEqual(events.at(-1), state)
  assert.deepEqual(await invoke('getPosition', id), { success: true, data: null })
  const position = { bookId: id, chapter: 0, offset: 4, pct: 0.25, updatedAt: 100 }
  assert.deepEqual(await invoke('setPosition', position), { success: true, data: position })
  assert.deepEqual(await invoke('getPosition', id), { success: true, data: position })
  assert.deepEqual(await invoke('setBookmarks', { bookId: id, bookmarks: [] }), { success: true, data: [] })
  assert.deepEqual(await invoke('listBookmarks', id), { success: true, data: [] })
  assert.partialDeepStrictEqual(await invoke('setPosition', { ...position, pct: 2 }), { success: false })
  assert.partialDeepStrictEqual(await invoke('getPosition', 'not-in-vault'), { success: false })
  assert.partialDeepStrictEqual(await invoke('updateBook', { id, patch: { status: '读完' } }), { success: true, data: { status: '读完' } })
  assert.deepEqual(events.at(-1), await engine.get())
  assert.partialDeepStrictEqual(await invoke('updateBook', { id, patch: { title: '改名' } }), { success: false })
  assert.partialDeepStrictEqual(await invoke('updateBook', { id, patch: { status: 'bad' } }), { success: false })
})
