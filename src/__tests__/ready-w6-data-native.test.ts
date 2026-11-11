import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { fixture } from './utils/ready-object-fixture'
import { sourceNoteContent } from '../main/modules/library-engine/source-note'
import { formatHighlight } from '../main/modules/library-engine/highlight-markdown'
import { sourceHighlightCodec, webSource } from '../main/modules/library-engine/source-adapters'
import { readStoredObjectPreview } from '../main/modules/object-service/preview'
import { FastCardRepository } from '../main/modules/repositories/fastcard-repository'
import { rebuildObjectIndex } from '../main/modules/search-engine/object-index-rebuild'
import { toReadyUri } from '../shared/ready-ref'
import { DatabaseDefinitionSchema, writeDatabase } from '../shared/document-database'
import { DocumentDatabaseService } from '../main/modules/document-database/service'
import { DocumentPageService } from '../main/modules/document-pages/service'
import type { LibraryHighlight } from '../shared/library'

function bookFixture(f: ReturnType<typeof fixture>) {
  const h: LibraryHighlight = { id: 'hl-one', chapter: 0, from: 2, to: 6, chapterTitle: '第一章', text: '目标原文', note: '我的笔记', color: 'yellow', sourceLine: 1, location: { status: 'located', chapter: 0, from: 2, to: 6 } }
  writeFileSync(join(f.root, 'book.txt'), '前文目标原文后文')
  writeFileSync(join(f.root, 'cover.png'), 'fixture')
  const content = sourceNoteContent({ ready_id: 'book-one', 类型: '书', title: '测试书', 作者: '作者甲', 分类: 'unsorted', tags: [], 状态: '在读', 文件: 'book.txt', 封面: 'cover.png', 加入: '2026-11-12', 来源: { kind: 'local' } })
    .replace('## 标注\n', `## 标注\n\n${formatHighlight(h, 'book-one')}`)
  const path = join(f.root, '书.md'); writeFileSync(path, content); f.registry.register(path)
  return { path, content, h }
}

test('W6 book, highlight and FastCard search survives two C5 rebuilds without touching source records', async () => {
  skipIfSqliteUnavailable({ skip: reason => { throw new Error(reason) } }, 'W6 requires Electron SQLite')
  const f = fixture()
  try {
    const book = bookFixture(f)
    new FastCardRepository(f.db).add({ id: 'card', kind: 'translation', createdAt: 1, title: '收集标题', originalText: '原始内容', translatedText: '翻译结果' })
    const cardBefore = f.db.prepare('SELECT * FROM fastcard_items').all()
    await rebuildObjectIndex(f.engine, [f.root])
    const snapshot = async () => {
      const titles = await f.engine.search('测试书'), text = await f.engine.search('目标原文'), card = await f.engine.search('翻译结果')
      assert.ok(titles.items.some(item => item.sourceType === 'book' && item.typeLabel === '书' && item.title === '测试书'))
      assert.ok(text.items.some(item => item.sourceType === 'highlight' && item.typeLabel === '划线' && item.path === toReadyUri({ kind: 'page', id: 'book-one', anchor: '^hl-one' })))
      assert.ok(card.items.some(item => item.sourceType === 'fastcard' && item.typeLabel === '收集' && item.path === 'ready://fastcard/card'))
      return f.db.prepare("SELECT path,name,source_type FROM documents WHERE source_type IN ('book','highlight','fastcard') ORDER BY path").all()
    }
    const first = await snapshot()
    await rebuildObjectIndex(f.engine, [f.root]); assert.deepEqual(await snapshot(), first)
    assert.equal(readFileSync(book.path, 'utf8'), book.content)
    assert.deepEqual(f.db.prepare('SELECT * FROM fastcard_items').all(), cardBefore)
    new FastCardRepository(f.db).remove('card')
    writeFileSync(book.path, book.content.replace(formatHighlight(book.h, 'book-one'), ''))
    await rebuildObjectIndex(f.engine, [f.root])
    assert.equal((await f.engine.search('翻译结果')).items.length, 0)
    assert.equal((await f.engine.search('目标原文')).items.filter(item => item.sourceType === 'highlight').length, 0)
  } finally { f.close() }
})

test('W6 stored previews return book cover/context, canvas geometry and saved web excerpts without writes', async () => {
  skipIfSqliteUnavailable({ skip: reason => { throw new Error(reason) } }, 'W6 requires Electron SQLite')
  const f = fixture()
  try {
    const book = bookFixture(f)
    const at = await readStoredObjectPreview(f.registry, { kind: 'book-location', book: 'book-one', loc: 'c0:5+4' })
    assert.equal(at?.kind, 'book')
    if (at?.kind !== 'book') throw new Error('missing book')
    assert.equal(at.book.author, '作者甲'); assert.equal(at.book.coverPath, join(f.root, 'cover.png'))
    assert.equal(at.passage?.text, '目标原文'); assert.equal(at.passage?.prefix.replace(/\s/g, ''), '测试书前文'); assert.equal(at.passage?.suffix, '后文')
    const highlight = await readStoredObjectPreview(f.registry, { kind: 'page', id: 'book-one', anchor: '^hl-one' })
    assert.equal(highlight?.kind === 'book' && highlight.passage?.note, '我的笔记')
    const canvasPath = join(f.root, '板.canvas')
    writeFileSync(canvasPath, JSON.stringify({ ready: { schemaVersion: 1, id: 'canvas-one', title: '设计' }, nodes: [{ id: 'node-one', type: 'text', text: '卡片标题\n正文', x: 20, y: 30, width: 200, height: 100, ready: { kind: 'text' } }], edges: [] }))
    f.registry.register(canvasPath)
    const canvas = await readStoredObjectPreview(f.registry, { kind: 'canvas', id: 'canvas-one' })
    assert.deepEqual(canvas, { kind: 'canvas', title: '设计', nodes: [{ id: 'node-one', x: 20, y: 30, width: 200, height: 100, title: '卡片标题' }] })
    const selection = webSource({ url: 'https://example.com/article', title: '网页标题', text: '网页摘录', start: 0, end: 4, exact: '网页摘录' }, 'snapshot')
    const uri = toReadyUri(selection.source.ref), id = 'source-' + createHash('sha256').update(uri).digest('hex').slice(0, 32)
    const note = sourceNoteContent({ ready_id: id, title: '网页标题', 来源引用: uri }).replace('## 标注\n', `## 标注\n\n${formatHighlight({ ...book.h, text: '网页摘录', from: 0, to: 4 }, id, sourceHighlightCodec(selection))}`)
    const webPath = join(f.root, '网页.md'); writeFileSync(webPath, note); f.registry.register(webPath)
    const changes = f.db.prepare('SELECT total_changes() AS n').get()
    assert.deepEqual(await readStoredObjectPreview(f.registry, selection.source.ref), { kind: 'web', title: '网页标题', url: 'https://example.com/article', excerpts: [{ id: 'hl-one', text: '网页摘录', note: '我的笔记' }] })
    assert.deepEqual(f.db.prepare('SELECT total_changes() AS n').get(), changes)
    assert.equal(readFileSync(book.path, 'utf8'), book.content)
    await assert.rejects(readStoredObjectPreview(f.registry, { kind: 'book-location', book: 'book-one', loc: 'c9:0+1' }), /失效/)
    assert.equal(await readStoredObjectPreview(f.registry, { kind: 'canvas', id: 'deleted' }), null)
  } finally { f.close() }
})

test('W6 database preview uses the default view filtering/order and only its first five rows', async () => {
  skipIfSqliteUnavailable({ skip: reason => { throw new Error(reason) } }, 'W6 requires Electron SQLite')
  const f = fixture()
  try {
    mkdirSync(join(f.root, 'rows'))
    const definition = DatabaseDefinitionSchema.parse({ version: 1, source: 'rows', fields: { 分数: { id: 'score', name: '评分', type: 'number' } }, views: [
      { id: 'default', name: '高分', type: 'table', filters: [{ field: 'score', operator: 'gt', value: 1 }], sorts: [{ field: 'score', direction: 'desc' }] },
      { id: 'other', name: '其他', type: 'table' },
    ] })
    const path = join(f.root, '表.md'); writeFileSync(path, writeDatabase('# 表', definition))
    const id = f.registry.register(path).id
    for (let i = 0; i < 9; i++) { const row = join(f.root, 'rows', `${i}.md`); writeFileSync(row, `---\n分数: ${i}\n---\n正文`); f.registry.register(row) }
    const writer = { index: async () => { throw new Error('preview must not write') } }
    const service = new DocumentDatabaseService(f.root, f.registry, new DocumentPageService(f.registry, writer), writer)
    const changes = f.db.prepare('SELECT total_changes() AS n').get()
    const preview = service.preview(id)
    assert.deepEqual(f.db.prepare('SELECT total_changes() AS n').get(), changes)
    assert.equal(preview.view.id, 'default'); assert.equal(preview.total, 7)
    assert.deepEqual(preview.rows.map(row => row.title), ['8', '7', '6', '5', '4'])
    await f.engine.reindexAllSources({ root: f.root })
    const hit = (await f.engine.search('表')).items.find(item => item.path === path)
    assert.equal(hit?.typeLabel, '数据库'); assert.equal(hit?.title, '表')
  } finally { f.close() }
})
