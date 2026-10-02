/**
 * 阅读位置桥接合同：行号换算、ratio↔页索引映射、
 * 与 documentScrollAnchor 存储的往返（ratio + 章节锚点透传）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  pageIndexForRatio,
  saveBookReadingPosition,
  sourceLineForCharOffset,
} from '../renderer/modules/document/book/bookReadingPosition'
import { readDocumentReadingPositionMap } from '../renderer/modules/document/documentScrollAnchor'

test('sourceLineForCharOffset：逐行计数与越界夹取', () => {
  const content = 'aa\nbb\ncc'
  assert.equal(sourceLineForCharOffset(content, 0), 1)
  assert.equal(sourceLineForCharOffset(content, 3), 2)
  assert.equal(sourceLineForCharOffset(content, 6), 3)
  assert.equal(sourceLineForCharOffset(content, 999), 3)
})

test('pageIndexForRatio：端点、取整与单页文档', () => {
  assert.equal(pageIndexForRatio(0, 10), 0)
  assert.equal(pageIndexForRatio(1, 10), 9)
  assert.equal(pageIndexForRatio(0.5, 10), 5)
  assert.equal(pageIndexForRatio(0.51, 10), 5)
  assert.equal(pageIndexForRatio(0.9, 1), 0)
  assert.equal(pageIndexForRatio(2, 10), 9, '越界夹取')
})

test('位置保存/读取往返：ratio 与章节锚点透传', () => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
  }
  const previous = (globalThis as { localStorage?: unknown }).localStorage
  ;(globalThis as { localStorage?: unknown }).localStorage = storage
  try {
    const content = '# 第一章\n正文第一页。\n# 第二章\n后半部分。'
    saveBookReadingPosition({
      key: '/tmp/book.md',
      content,
      pageIndex: 3,
      pageCount: 6,
      anchorLine: 3,
    })
    const ratio = readDocumentReadingPositionMap().get('/tmp/book.md')?.ratio ?? null
    assert.ok(ratio !== null && Math.abs(ratio - 0.6) < 1e-9, `ratio 应≈0.6，实际 ${ratio}`)
    const snapshot = readDocumentReadingPositionMap().get('/tmp/book.md')
    assert.equal(snapshot?.anchorTitle, '第二章')
    assert.equal(snapshot?.top, 3)
    assert.equal(snapshot?.maxScroll, 5)
  } finally {
    ;(globalThis as { localStorage?: unknown }).localStorage = previous
  }
})

test('空键与无记录安全返回', () => {
  assert.doesNotThrow(() => {
    saveBookReadingPosition({ key: '', content: '', pageIndex: 0, pageCount: 1, anchorLine: null })
  })
})

test('正文位置优先于整篇比例，无标题且跨页的段落也能定位', async () => {
  const { resolveBookPageForPosition } = await import('../renderer/modules/document/book/bookReadingPosition')
  const { buildBookPageModel } = await import('../renderer/modules/document/book/bookPagination')
  const content = '短段落\n\n很长的正文段落\n\n最后一段'
  const blocks = [0, 5, 14].map((start, i) => ({
    id: String(i), type: 'markdown' as const, markdown: '', source: { start, end: [3, 12, 18][i] },
  }))
  const model = buildBookPageModel([
    { blockIdx: 0, startCol: 0, endCol: 0, offsetY: 0, height: 100 },
    { blockIdx: 1, startCol: 1, endCol: 8, offsetY: 0, height: 600 },
    { blockIdx: 2, startCol: 9, endCol: 9, offsetY: 0, height: 100 },
  ], 400, 600)
  const position = { top: 50, maxScroll: 100, ratio: 0.01, anchorTitle: null, anchorOrdinal: null, anchorProgress: null, sourceLine: 3, sourceProgress: 0.7 }
  assert.equal(resolveBookPageForPosition(position, content, blocks, model), 6)
  assert.equal(resolveBookPageForPosition({ ...position, sourceProgress: 0 }, content, blocks, model), 1)
  assert.equal(resolveBookPageForPosition(null, content, blocks, model), 0)
})
