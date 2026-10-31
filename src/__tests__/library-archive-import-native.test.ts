import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { runMigrations } from '../main/modules/migrations'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { applyDocumentOperation } from '../main/modules/document-engine/document-write-service'
import { LibraryEngine } from '../main/modules/library-engine/library-engine'
import { LibraryHighlightService } from '../main/modules/library-engine/highlight-service'
import { LibraryReadingRepository } from '../main/modules/library-engine/reading-repository'
import { LibraryArchiveImporter, archiveStatus } from '../main/modules/library-engine/archive-import'
import { readDocumentSource } from '../shared/document-operations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

// L5 contract: Main owns the selected-directory boundary and the serialized import.
// Source md + anchors + SQLite readback, retry after partial failure, no source writes.
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ready-archive-'))
  const source = join(dir, 'old'), root = join(dir, 'vault')
  await mkdir(join(source, 'files'), { recursive: true }); await mkdir(join(source, 'covers')); await mkdir(root)
  const zip = new JSZip()
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>')
  zip.file('OPS/book.opf', '<package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>EPUB</dc:title></metadata><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>')
  zip.file('OPS/c.xhtml', '<html><body><h2>第一章</h2><p>甲乙丙丁戊己庚辛</p></body></html>')
  await writeFile(join(source, 'files', 'epub.epub'), await zip.generateAsync({ type: 'nodebuffer' }))
  await writeFile(join(source, 'files', 'txt.txt'), '第一章\n春天来了。花开满山。')
  await writeFile(join(source, 'covers', 'epub.png'), Buffer.from('fixture cover'))
  const books = [
    { id: 'epub', title: '原书名', author: '原作者', year: 2020, publisher: '原出版社', language: 'zh', description: '简介', tags: ['原标签'], topic: 'unsorted', favorite: true, source: 'local', status: 'ready', addedAt: 1700000000000, finishedAt: 1700100000000, file: { name: '原书.epub', ext: 'epub', size: 1 }, cover: 'file',
      progress: { chapter: 0, offset: 5, pct: 0.4, at: 1700010000000 }, bookmarks: [{ chapter: 0, offset: 6, label: '书签', at: 1700010000000 }],
      highlights: [{ id: 'one', chapter: 0, from: 3, to: 5, text: '甲乙', color: 'pink', note: '原批注', at: 1700010000000 }, { id: 'two', chapter: 0, from: 99, to: 101, text: '丙丁', color: 'pen', at: 1700010000000 }, { id: 'three', chapter: 0, from: 40, to: 43, text: '不存在', color: 'blue', note: '仍保留', at: 1700010000000 }] },
    { id: 'txt', title: '文字书', author: '', tags: [], favorite: true, source: 'treasure', sourceRef: 'old-ref', sourceUrl: 'https://example.invalid/book', status: 'wish', addedAt: 1700000000000, file: { name: '文字书.txt', ext: 'txt', size: 1 }, progress: { chapter: 0, offset: 4, pct: 0.2, at: 1700010000000 }, bookmarks: [{ chapter: 0, offset: 4, label: 'TXT书签', at: 1700010000000 }] },
  ]
  const save = () => writeFile(join(source, 'library.json'), JSON.stringify({ version: 1, books }))
  await save()
  const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
  const db = new Database(join(dir, 'ready.db')); runMigrations(db)
  const search = new SearchEngine(db, { fts5Available: false })
  let rejectWrite = false
  const write: typeof applyDocumentOperation = input => {
    if (rejectWrite && input.origin === 'library-highlights') input = { ...input, expectedVersion: 'stale-fixture-version' }
    assert.ok(input.expectedVersion, 'migration writes bind a version')
    return applyDocumentOperation(input, { index: async (path, content) => {
      const result = await search.indexDocument(root, path, content)
      assert.equal(result.ok, true, result.error)
    } })
  }
  const engine = new LibraryEngine({ vault: () => ({ status: 'ready', root, defaultSuggestion: root }), write })
  const reading = new LibraryReadingRepository(db), highlights = new LibraryHighlightService(engine, { write })
  const importer = new LibraryArchiveImporter(engine, reading, highlights)
  return { dir, source, root, books, save, db, engine, reading, importer, reject: (value: boolean) => { rejectWrite = value }, close: async () => { db.close(); await rm(dir, { recursive: true, force: true }) } }
}
async function bytes(root: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {}
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (item.isDirectory()) for (const [key, value] of Object.entries(await bytes(join(root, item.name)))) entries[`${item.name}/${key}`] = value
    else entries[item.name] = (await readFile(join(root, item.name))).toString('base64')
  }
  return entries
}

test('L5 imports EPUB/TXT metadata, annotations, anchors and reading records without changing source bytes; repeats skip', async t => {
  if (skipIfSqliteUnavailable(t, 'L5 archive import')) return
  const f = await fixture(); t.after(f.close)
  const before = await bytes(f.source), progress: number[] = []
  const report = await f.importer.run(f.source, p => progress.push(p.completed))
  assert.deepEqual([report.success.length, report.skipped.length, report.failed.length, report.unlocated], [2, 0, 0, 1])
  assert.deepEqual(progress, [0, 1, 2])
  const state = await f.engine.get(); assert.equal(state.status, 'ready'); if (state.status !== 'ready') return
  const epub = state.books.find(b => b.title === '原书名')!, txt = state.books.find(b => b.title === '文字书')!
  assert.equal(epub.status, '读完'); assert.equal(txt.status, '在读')
  assert.deepEqual(epub.source, { kind: 'import', ref: '藏书阁:epub' })
  assert.equal(epub.author, '原作者'); assert.deepEqual(epub.tags, ['原标签']); assert.equal(epub.addedAt, f.books[0].addedAt)
  assert.equal(epub.finishedAt, f.books[0].finishedAt)
  assert.equal((await readFile(epub.coverPath!)).toString(), 'fixture cover')
  const md = await readFile(epub.notePath, 'utf8'), fields = readDocumentSource(md).frontmatter
  assert.equal(fields['收藏'], true); assert.equal(fields['简介'], '简介')
  assert.match(md, /\[!quote\|pink\]/); assert.match(md, /原批注/); assert.match(md, /未定位/); assert.match(md, /仍保留/)
  const anchors = JSON.parse(await readFile(join(f.root, '.ready', 'anchors', `${epub.id}.highlights.json`), 'utf8'))
  assert.equal(Object.keys(anchors.highlights).length, 3)
  assert.ok(Object.values<{ createdAt: number }>(anchors.highlights).every(h => h.createdAt === 1700010000000))
  assert.ok(Object.values<{ from: number; quote: { exact: string } }>(anchors.highlights).some(h => h.from === 5 && h.quote.exact === '丙丁'))
  assert.deepEqual(f.reading.getPosition(epub.id), { bookId: epub.id, chapter: 0, offset: 5, pct: 0.4, updatedAt: 1700010000000 })
  assert.equal(f.reading.listBookmarks(epub.id)[0].label, '书签'); assert.equal(f.reading.listBookmarks(txt.id)[0].offset, 4)
  const vaultBefore = await bytes(f.root)
  const again = await f.importer.run(f.source)
  assert.deepEqual([again.success.length, again.skipped.length, again.failed.length], [0, 2, 0])
  assert.deepEqual(await bytes(f.root), vaultBefore); assert.deepEqual(await bytes(f.source), before)
  // A different old id with identical bytes must not create a second shelf item.
  f.books[1].id = 'copy'; await writeFile(join(f.source, 'files', 'copy.txt'), await readFile(txt.filePath)); await f.save()
  assert.equal((await f.importer.run(f.source)).skipped.length, 2)
})

test('L5 rejects malformed libraries and escaped files/covers; one missing file does not stop another book', async t => {
  if (skipIfSqliteUnavailable(t, 'L5 validation')) return
  const f = await fixture(); t.after(f.close)
  await writeFile(join(f.source, 'library.json'), JSON.stringify({ version: 1, books: [...f.books, { id: 'bad' }] }))
  await assert.rejects(f.importer.run(f.source), /library.json/)
  assert.deepEqual((await f.engine.get()).status, 'ready'); assert.equal((await readdir(f.root)).length, 0)
  await f.save()
  for (const path of [join(f.source, 'files', 'epub.epub'), join(f.source, 'covers', 'epub.png')]) {
    const original = await readFile(path), outside = join(f.dir, 'outside')
    await writeFile(outside, original); await rm(path); await symlink(outside, path)
    const report = await f.importer.run(f.source)
    assert.equal(report.failed.length, 1); assert.match(report.failed[0].reason, /范围|越界/)
    await rm(path); await writeFile(path, original)
  }
  await rm(join(f.source, 'files', 'epub.epub'))
  const report = await f.importer.run(f.source)
  assert.equal(report.failed.length, 1); assert.equal(report.skipped.length, 1)
  f.books[0].id = '../escape'; await f.save()
  await assert.rejects(f.importer.run(f.source), /library.json/)
})

test('L5 partial failure resumes missing annotations without duplicate books/bookmarks; concurrent repeats serialize', async t => {
  if (skipIfSqliteUnavailable(t, 'L5 retry')) return
  const f = await fixture(); t.after(f.close)
  f.reject(true)
  const failed = await f.importer.run(f.source)
  assert.equal(failed.failed.length, 1); assert.match(failed.failed[0].reason, /version has changed/)
  f.reject(false)
  const reports = await Promise.all([f.importer.run(f.source), f.importer.run(f.source)])
  assert.equal(reports[0].success.length, 1); assert.equal(reports[1].skipped.length, 2)
  const state = await f.engine.get(); if (state.status !== 'ready') throw new Error('no vault')
  assert.equal(state.books.length, 2)
  assert.equal(f.reading.listBookmarks(state.books.find(b => b.title === '原书名')!.id).length, 1)
})

test('L5 status mapping gives completion and actual reading precedence; favorites remain wanted without progress', t => {
  if (skipIfSqliteUnavailable(t, 'L5 status mapping')) return
  assert.equal(archiveStatus({ status: 'ready', finishedAt: 1 }), '读完')
  assert.equal(archiveStatus({ status: 'wish', progress: { pct: 1 } }), '读完')
  assert.equal(archiveStatus({ status: 'ready', openedAt: 1 }), '在读')
  assert.equal(archiveStatus({ status: 'wish', progress: { pct: 0.2 } }), '在读')
  for (const status of ['wish', 'ready', 'error'] as const) assert.equal(archiveStatus({ status, favorite: true }), '想读')
})

test('L5 Main requires directory selection and confirmation; sends progress and refreshed shelf only for confirmed imports', async t => {
  if (skipIfSqliteUnavailable(t, 'L5 confirmation')) return
  const f = await fixture(); t.after(f.close)
  const { registerLibraryArchiveIPC } = await import('../main/modules/library-engine/archive-ipc')
  const handlers = new Map<string, (event: unknown) => unknown>()
  let selected: string | null = null, confirmed = false, confirmations = 0, changed = 0
  const events: unknown[] = []
  registerLibraryArchiveIPC({ handle: (channel, handler) => { handlers.set(channel, handler) } }, {
    engine: f.engine, importer: f.importer, suggestion: '/suggestion-only',
    pickDirectory: async () => selected,
    confirm: async directory => { assert.equal(directory, f.source); confirmations++; return confirmed },
    changed: () => { changed++ },
  })
  const event = { sender: { isDestroyed: () => false, send: (_channel: string, data: unknown) => events.push(data) } }
  const invoke = (name: string) => handlers.get(`library:${name}`)!(event)
  assert.deepEqual(await invoke('archiveSuggestion'), { success: true, data: '/suggestion-only' })
  assert.deepEqual(await invoke('pickAndImportArchive'), { success: true, data: null }); assert.equal(confirmations, 0)
  selected = f.source
  assert.deepEqual(await invoke('pickAndImportArchive'), { success: true, data: null })
  assert.equal((await readdir(f.root)).length, 0); assert.equal(events.length, 0)
  confirmed = true
  assert.partialDeepStrictEqual(await invoke('pickAndImportArchive'), { success: true })
  assert.equal(changed, 1); assert.equal(events.length, 3)
})
