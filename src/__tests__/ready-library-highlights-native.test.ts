import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { runMigrations } from '../main/modules/migrations'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { buildSearchIndexContentHash } from '../main/modules/search-engine/adapters'
import { LibraryEngine } from '../main/modules/library-engine/library-engine'
import { LibraryHighlightService } from '../main/modules/library-engine/highlight-service'
import { LibraryReadingRepository } from '../main/modules/library-engine/reading-repository'
import { registerLibraryIPC } from '../main/modules/library-engine/ipc-handler'
import { applyDocumentOperation } from '../main/modules/document-engine/document-write-service'
import { createDocumentOperationSync } from '../renderer/modules/document/documentOperationSync'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

// No global singleton replacement: real SQLite index + real document synchronization participant.
test('highlight IPC writes indexed source, rejects stale edits, and keeps dirty-buffer marks pending without sidecar writes', async t => {
  if (skipIfSqliteUnavailable(t, 'Library highlights source/index')) return
  const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
  const db = new Database(':memory:'); t.after(() => db.close()); runMigrations(db)
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ready-highlight-native-'))); t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'vault'); await mkdir(root)
  const file = join(dir, '书.txt'); await writeFile(file, '甲乙丙丁戊己庚辛')
  const engine = new LibraryEngine({ vault: () => ({ status: 'ready', root, defaultSuggestion: root }) })
  const book = (await engine.importFiles([file])).imported[0]
  const search = new SearchEngine(db, { fts5Available: false })
  const index = async (path: string, content: string) => { const result = await search.indexDocument(root, path, content); assert.equal(result.ok, true, result.error) }
  let tab = { id: 'test-tab', path: book.notePath, content: await readFile(book.notePath, 'utf8'), isDirty: false }
  const sync = createDocumentOperationSync({ tabs: () => [tab], replace: next => { tab = { ...tab, ...next } } })
  const highlights = new LibraryHighlightService(engine, { write: input => applyDocumentOperation(input, { index, tabs: sync }) })
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
  registerLibraryIPC({ handle: (name, fn) => { handlers.set(name, fn) } }, { engine, highlights, reading: new LibraryReadingRepository(db), pickFiles: async () => [], changed: () => {} })
  const invoke = async (name: string, input: unknown) => {
    const fn = handlers.get(`library:${name}`); assert.ok(fn); return fn({}, input)
  }
  const context = { bookId: book.id, chapters: [{ title: '第一章', text: '甲乙丙丁戊己庚辛' }] }
  const before = await highlights.list(context)
  const create = { ...context, expectedVersion: before.version, chapter: 0, from: 0, to: 2, color: 'pink' }
  assert.partialDeepStrictEqual(await invoke('createHighlight', create), { success: true, data: { persistence: 'saved', anchors: 'synced' } })
  const state = await highlights.list(context), id = state.highlights[0].id
  const disk = await readFile(book.notePath, 'utf8')
  assert.equal(tab.content, disk)
  assert.equal(db.prepare('SELECT content_hash AS hash FROM documents WHERE path=?').get<{ hash: string }>(book.notePath)?.hash, buildSearchIndexContentHash(disk))
  assert.partialDeepStrictEqual(await invoke('createHighlight', create), { success: false })
  assert.partialDeepStrictEqual(await invoke('listHighlights', { ...context, bookId: '../escape' }), { success: false })
  assert.partialDeepStrictEqual(await invoke('updateHighlight', { ...context, expectedVersion: state.version, id, patch: { color: 'blue' } }), { success: true })
  const updated = await highlights.list(context)
  assert.equal(updated.highlights[0].color, 'blue')
  const anchorPath = join(root, '.ready', 'anchors', `${book.id}.json`)
  const original = await readFile(book.notePath, 'utf8'), anchors = await readFile(anchorPath, 'utf8')
  tab = { ...tab, isDirty: true, content: original + '\n用户还没保存的笔记\n' }
  const pending = await highlights.create({ ...context, expectedVersion: updated.version, chapter: 0, from: 4, to: 6, color: 'yellow' })
  assert.equal(pending.persistence, 'pending_save')
  assert.match(tab.content, /戊己/); assert.match(tab.content, /用户还没保存的笔记/)
  assert.equal(await readFile(book.notePath, 'utf8'), original)
  assert.equal(await readFile(anchorPath, 'utf8'), anchors)
  // A disk-version mismatch cannot be retried as a second successful operation.
  await assert.rejects(highlights.create({ ...context, expectedVersion: pending.version, chapter: 0, from: 4, to: 6, color: 'yellow' }), /version/)
  tab = { ...tab, content: original.replace('## 标注', '用户在标注前写了一段\n\n## 标注'), isDirty: true }
  const shifted = tab.content
  await assert.rejects(highlights.create({ ...context, expectedVersion: updated.version, chapter: 0, from: 4, to: 6, color: 'yellow' }), /expectedText|conflict/)
  assert.equal(tab.content, shifted)
  assert.equal(await readFile(book.notePath, 'utf8'), original)
  assert.equal(await readFile(anchorPath, 'utf8'), anchors)
  // Discarding the unsaved buffer keeps the previously committed mark intact.
  tab = { ...tab, content: original, isDirty: false }
  assert.partialDeepStrictEqual(await invoke('removeHighlight', { ...context, expectedVersion: updated.version, id }), { success: true, data: { highlights: [] } })
  assert.equal((await highlights.list(context)).highlights.length, 0)
})
