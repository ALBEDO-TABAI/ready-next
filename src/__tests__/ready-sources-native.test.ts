import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMigrations } from '../main/modules/migrations'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { RSSStore } from '../main/modules/database/rss-store'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { ObjectLinkRepository } from '../main/modules/search-engine/object-links'
import { rebuildObjectIndex } from '../main/modules/search-engine/object-index-rebuild'
import { LibraryEngine } from '../main/modules/library-engine/library-engine'
import { SourceDocumentService } from '../main/modules/library-engine/source-documents'
import { rssSource, webSource, pdfSource, bookSource } from '../main/modules/library-engine/source-adapters'
import { parseReadyUri } from '../shared/ready-ref'
import { readDocumentSource } from '../shared/document-operations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

async function fixture(t: test.TestContext) {
  const db: DatabaseConnection = new Database(':memory:'); runMigrations(db); t.after(() => db.close())
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ready-sources-'))); t.after(() => rm(root, { recursive: true, force: true }))
  db.prepare('INSERT INTO workspaces(root) VALUES (?)').run(root)
  const registry = new ObjectRegistry(db), search = new SearchEngine(db, { fts5Available: false })
  const writer = { index: async (path: string, text: string) => { const result = await search.indexDocument(root, path, text); assert.equal(result.ok, true, result.error) } }
  const service = new SourceDocumentService(root, registry, writer), rss = new RSSStore(() => db)
  const feed = rss.addRSSSource({ name: 'Offline fixture', url: 'https://example.test/feed' })
  rss.upsertRSSItems([{ id: 'article', source_id: feed, guid: 'article', title: '文章', link: 'https://example.test/article', summary: '甲乙丙丁戊己庚辛' }])
  return { root, db, registry, search, service, rss, writer }
}
const range = (from: number, to: number) => ({ start: { run: 0, offset: from }, end: { run: 0, offset: to } })

test('four sources retain metadata and excerpts; duplicate/overlapping marks merge through the book writer', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-F sources')) return
  const f = await fixture(t)
  const file = join(f.root, '书.txt'); await writeFile(file, '甲乙丙丁戊己庚辛')
  const books = new LibraryEngine({ vault: () => ({ status: 'ready', root: f.root, defaultSuggestion: f.root }) })
  const book = (await books.importFiles([file])).imported[0], bookMarks = SourceDocumentService.books(books)
  const context = { bookId: book.id, chapters: [{ title: '书', text: '甲乙丙丁戊己庚辛' }] }
  const before = await bookMarks.list(context)
  // Book writes use the same real index as the generic source service.
  const marks = SourceDocumentService.books(books, { write: input => import('../main/modules/document-engine/document-write-service').then(m => m.applyDocumentOperation(input, f.writer)) })
  assert.equal((await marks.create({ ...context, expectedVersion: before.version, chapter: 0, from: 1, to: 3, color: 'pink' })).highlights[0].text, '乙丙')
  assert.deepEqual(await f.service.ensure(bookSource(book)), { id: book.id, notePath: book.notePath })
  const article = f.rss.content.getArticle('article')!
  const first = await f.service.annotate(rssSource(article, range(1, 3)))
  const repeated = await f.service.annotate(rssSource(article, range(1, 3)))
  assert.equal(repeated.highlights.length, 1)
  assert.equal(repeated.highlights[0].id, first.highlights[0].id)
  const merged = await f.service.annotate(rssSource(article, range(2, 5)))
  assert.deepEqual(merged.highlights.map(h => h.text), ['乙丙丁戊'])
  const rssMarkdown = await readFile(merged.sourcePath, 'utf8')
  const uri = /\[原文\]\((ready:\/\/\S+)\) <!--/.exec(rssMarkdown)![1]
  const ref = parseReadyUri(uri); assert.ok(ref.ok && ref.ref.kind === 'rss-item' && ref.ref.excerpt)
  assert.equal(f.rss.content.readExcerpt({ itemId: ref.ref.id, ...ref.ref.excerpt }).text, '乙丙丁戊')
  const web = webSource({ url: 'http://127.0.0.1:4321/page', title: '网页', text: '前文 选中文字 后文', start: 3, end: 7, exact: '选中文字' }, 'snapshot')
  const webMark = await f.service.annotate(web)
  assert.equal(webMark.highlights[0].text, '选中文字')
  assert.equal((await f.service.annotate(web)).highlights.length, 1)
  const pdf = join(f.root, '文档.pdf'); await writeFile(pdf, '%PDF-1.7\nfixture')
  const pdfPage = await f.service.ensure(pdfSource({ id: f.registry.register(pdf).id, title: '文档', hash: 'fixture-hash' }))
  assert.equal((await f.service.ensure(pdfSource({ id: f.registry.find(pdf)!.id, title: '文档', hash: 'fixture-hash' }))).id, pdfPage.id)
  assert.ok(pdfPage.notePath.startsWith(join(f.root, '文章')))
  for (const path of [book.notePath, merged.sourcePath, webMark.sourcePath, pdfPage.notePath]) {
    const content = await readFile(path, 'utf8'), { frontmatter } = readDocumentSource(content)
    assert.equal(typeof frontmatter.来源引用, 'string'); assert.equal(typeof frontmatter.作者, 'string')
    assert.ok(frontmatter.加入); assert.match(content, /## 标注/); assert.match(content, /## 我的笔记/)
  }
  assert.match(await readFile(webMark.sourcePath, 'utf8'), /脱机阅读/)
  assert.ok((await readFile(webMark.sourcePath, 'utf8')).includes(encodeURIComponent(':~:text=')))
})

test('source identity and original links survive moving, cache deletion, restart and index rebuild', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-F source rebuild')) return
  const f = await fixture(t), selection = rssSource(f.rss.content.getArticle('article')!, range(1, 4))
  const initial = await f.service.annotate(selection), id = f.registry.find(initial.sourcePath)!.id
  const links = new ObjectLinkRepository(f.db)
  const before = links.outgoing({ objectId: id }).map(link => link.rawTarget).sort()
  assert.equal(before.length, 2)
  await mkdir(join(f.root, '移动')); const moved = join(f.root, '移动', '改名.md')
  await rename(initial.sourcePath, moved); f.registry.scan(f.root)
  await rm(join(f.root, '.ready', 'anchors', `${id}.highlights.json`))
  await rebuildObjectIndex(f.search, [f.root])
  const restarted = new SourceDocumentService(f.root, f.registry, f.writer)
  const page = await restarted.ensure(selection.source)
  assert.equal(page.notePath, moved); assert.equal(page.id, id)
  assert.deepEqual(links.outgoing({ objectId: id }).map(link => link.rawTarget).sort(), before)
  const after = await restarted.annotate(selection)
  assert.equal(after.sourcePath, moved); assert.equal(after.highlights.length, 1)
  assert.equal(after.highlights[0].location.status, 'located')
})

test('highlight cache migrates once and never overwrites document comment anchors', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-F anchor ownership')) return
  const f = await fixture(t), selection = rssSource(f.rss.content.getArticle('article')!, range(1, 4))
  const first = await f.service.annotate(selection), id = f.registry.find(first.sourcePath)!.id
  const cache = join(f.root, '.ready', 'anchors', `${id}.highlights.json`), old = join(f.root, '.ready', 'anchors', `${id}.json`)
  await rename(cache, old)
  const { migrateHighlightCaches } = await import('../main/modules/library-engine/highlight-cache-migration')
  migrateHighlightCaches(f.root)
  const { AnnotationStorage } = await import('../main/modules/document-annotations/storage')
  const { DocumentAnnotationService } = await import('../main/modules/document-annotations/service')
  const comments = new DocumentAnnotationService(new AnnotationStorage(f.root), f.registry)
  assert.equal((await comments.comments({ type: 'read', path: first.sourcePath })).threads.length, 0)
  await f.service.annotate(selection)
  await writeFile(old, JSON.stringify({ version: 1, anchors: [] }))
  const preserved = await readFile(old, 'utf8')
  await f.service.annotate(selection)
  assert.equal(await readFile(old, 'utf8'), preserved)
  assert.equal((await comments.comments({ type: 'read', path: first.sourcePath })).threads.length, 0)
})

test('changed RSS text preserves the old unavailable quote and its original version instead of retargeting it', async t => {
  if (skipIfSqliteUnavailable(t, 'M5-F stale source')) return
  const f = await fixture(t), first = f.rss.content.getArticle('article')!
  const saved = await f.service.annotate(rssSource(first, range(0, 3)))
  const original = /\[原文\]\((ready:\/\/\S+)\) <!--/.exec(await readFile(saved.sourcePath, 'utf8'))![1]
  f.rss.upsertRSSItems([{ id: 'article', source_id: first.sourceId, guid: 'article', title: first.title, link: first.link, summary: '完全不同的新文章正文' }])
  const changed = f.rss.content.getArticle('article')!
  assert.notEqual(changed.revision, first.revision)
  const next = await f.service.annotate(rssSource(changed, range(0, 3)))
  assert.equal(next.highlights.length, 2)
  assert.equal(next.highlights.find(h => h.id === saved.highlights[0].id)!.location.status, 'unlocated')
  assert.ok((await readFile(next.sourcePath, 'utf8')).includes(original))
  const parsed = parseReadyUri(original); assert.ok(parsed.ok && parsed.ref.kind === 'rss-item' && parsed.ref.excerpt)
  assert.throws(() => f.rss.content.readExcerpt({ itemId: parsed.ref.id, ...parsed.ref.excerpt }), /article_changed/)
})
