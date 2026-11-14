import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rename, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runMigrations } from '../main/modules/migrations'
import { ObjectRegistry } from '../main/modules/object-service/registry'
import { SearchEngine } from '../main/modules/search-engine/indexer'
import { buildSearchIndexContentHash } from '../main/modules/search-engine/adapters'
import { RSSStore } from '../main/modules/database/rss-store'
import { SourceDocumentService } from '../main/modules/library-engine/source-documents'
import { registerSourceAnnotationsIPC } from '../main/modules/library-engine/source-document-ipc'
import { rssSource, webSource } from '../main/modules/library-engine/source-adapters'
import { documentVersion } from '../main/modules/document-engine/document-write-service'
import { createDocumentOperationSync } from '../renderer/modules/document/documentOperationSync'
import type { SourceReply, SourceHighlightRemoval } from '../shared/source-annotations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

async function fixture(t: test.TestContext) {
  const db = new Database(':memory:'); runMigrations(db); t.after(() => db.close())
  const root = await realpath(await mkdtemp(join(tmpdir(), 'source-highlight-removal-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const registry = new ObjectRegistry(db), search = new SearchEngine(db, { fts5Available: false })
  let tab = { id: 'source', path: '', content: '', isDirty: false }
  const sync = createDocumentOperationSync({ tabs: () => tab.path ? [tab] : [], replace: next => { tab = { ...tab, ...next } } })
  const writer = { index: async (path: string, text: string) => {
    const result = await search.indexDocument(root, path, text); assert.equal(result.ok, true, result.error)
  }, tabs: sync }
  const service = new SourceDocumentService(root, registry, writer)
  const handlers = new Map<string, Parameters<import('electron').IpcMain['handle']>[1]>()
  // Substitute only Electron's unused event envelope; storage, writing, indexing and buffer sync are real.
  registerSourceAnnotationsIPC({ handle: (name, handler) => { handlers.set(name, handler) } }, {
    service: async () => new SourceDocumentService(root, registry, writer),
    rss: () => { throw new Error('deletion must not read live RSS') }, browser: () => { throw new Error('deletion must not read a browser') },
    readTab: async () => { throw new Error('deletion must not read a tab') },
  })
  const remove = async (raw: unknown): Promise<SourceReply<SourceHighlightRemoval>> => {
    const handler = handlers.get('sourceAnnotations:removeHighlight'); assert.ok(handler, 'source deletion IPC is registered')
    return handler({} as import('electron').IpcMainInvokeEvent, raw)
  }
  const text = '甲乙丙丁戊己庚辛', rss = new RSSStore(() => db)
  const feed = rss.addRSSSource({ name: '离线来源', url: 'https://example.test/feed' })
  rss.upsertRSSItems([{ id: 'article', source_id: feed, guid: 'article', title: '文章', link: 'https://example.test/article', summary: text }])
  const pdf = join(root, '文档.pdf'), bytes = '%PDF-1.7\nfixture'; await writeFile(pdf, bytes)
  const pdfId = registry.register(pdf).id, expectedHash = createHash('sha256').update(bytes).digest('hex')
  const annotate = (kind: 'web' | 'rss' | 'pdf', start: number) => {
    if (kind === 'pdf') return service.annotatePdf({ id: pdfId, expectedHash, page: start ? 2 : 1, text, start, end: start + 2, exact: text.slice(start, start + 2) })
    if (kind === 'web') return service.annotate(webSource({ url: 'https://example.test/web', title: '网页', text, start, end: start + 2, exact: text.slice(start, start + 2) }, 'snapshot'))
    return service.annotate(rssSource(rss.content.getArticle('article')!, { start: { run: 0, offset: start }, end: { run: 0, offset: start + 2 } }))
  }
  return { root, db, registry, service, remove, annotate, setTab: (next: typeof tab) => { tab = next }, getTab: () => tab }
}

test('source deletion IPC removes only the selected web/RSS/PDF mark after a move and refreshes the real index', async t => {
  if (skipIfSqliteUnavailable(t, 'source highlight removal')) return
  const f = await fixture(t)
  for (const kind of ['web', 'rss', 'pdf'] as const) {
    const first = await f.annotate(kind, 0), second = await f.annotate(kind, 4)
    const id = first.highlights[0].id, kept = second.highlights.find(mark => mark.id !== id)!
    const sourceId = f.registry.find(first.sourcePath)!.id
    const path = join(f.root, `${kind}-改名.md`); await rename(first.sourcePath, path)
    const before = (await readFile(path, 'utf8')).replace('## 我的笔记', '## 我的笔记\n\n手写笔记保持原样。')
    await writeFile(path, before)
    const reply = await f.remove({ sourceId, id, expectedVersion: documentVersion(before) })
    assert.ok(reply.success, reply.success ? '' : reply.error)
    const after = await readFile(path, 'utf8')
    assert.deepEqual(reply.data, { sourcePath: path, version: documentVersion(after), persistence: 'saved' })
    assert.ok(!after.includes(`^${id}`)); assert.ok(after.includes(`^${kept.id}`)); assert.ok(after.includes(kept.text))
    assert.equal(after.slice(0, after.indexOf('## 标注')), before.slice(0, before.indexOf('## 标注')))
    assert.equal(after.slice(after.indexOf('## 我的笔记')), before.slice(before.indexOf('## 我的笔记')))
    assert.equal(f.db.prepare('SELECT content_hash AS hash FROM documents WHERE path=?').get<{ hash: string }>(path)?.hash, buildSearchIndexContentHash(after))
    assert.equal((await f.remove({ sourceId, id, expectedVersion: reply.data.version })).success, false)
    assert.equal(await readFile(path, 'utf8'), after, 'a repeated deletion must preserve the other mark')
  }
})

test('source deletion rejects stale versions, foreign marks, invalid input, ambiguous ids and changed source identity', async t => {
  if (skipIfSqliteUnavailable(t, 'source highlight removal boundaries')) return
  const f = await fixture(t), web = await f.annotate('web', 0), rss = await f.annotate('rss', 0)
  const sourceId = f.registry.find(web.sourcePath)!.id, id = web.highlights[0].id
  const before = await readFile(web.sourcePath, 'utf8'), input = { sourceId, id, expectedVersion: web.version }
  for (const raw of [{ ...input, expectedVersion: 'stale' }, { ...input, id: rss.highlights[0].id }, { ...input, sourceId: '../escape' }, { ...input, extra: true }]) {
    assert.equal((await f.remove(raw)).success, false); assert.equal(await readFile(web.sourcePath, 'utf8'), before)
  }
  for (const content of [before + `\n^${id}\n`, before.replace('来源引用:', '其他引用:')]) {
    await writeFile(web.sourcePath, content)
    assert.equal((await f.remove({ ...input, expectedVersion: documentVersion(content) })).success, false)
    assert.equal(await readFile(web.sourcePath, 'utf8'), content)
  }
})

test('source deletion merges into a dirty buffer without claiming a disk save and refuses a shifted target', async t => {
  if (skipIfSqliteUnavailable(t, 'source highlight removal dirty buffer')) return
  const f = await fixture(t), state = await f.annotate('web', 0), disk = await readFile(state.sourcePath, 'utf8')
  const input = { sourceId: f.registry.find(state.sourcePath)!.id, id: state.highlights[0].id, expectedVersion: state.version }
  f.setTab({ id: 'source', path: state.sourcePath, content: disk + '\n未保存的笔记\n', isDirty: true })
  const reply = await f.remove(input); assert.ok(reply.success, reply.success ? '' : reply.error)
  assert.equal(reply.data.persistence, 'pending_save'); assert.equal(reply.data.version, documentVersion(f.getTab().content))
  assert.ok(!f.getTab().content.includes(`^${input.id}`)); assert.ok(f.getTab().content.includes('未保存的笔记'))
  assert.equal(await readFile(state.sourcePath, 'utf8'), disk)
  const shifted = '前面新增一段\n\n' + disk
  f.setTab({ ...f.getTab(), content: shifted })
  assert.equal((await f.remove(input)).success, false)
  assert.equal(f.getTab().content, shifted); assert.equal(await readFile(state.sourcePath, 'utf8'), disk)
})
