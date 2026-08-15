/**
 * 阅读位置桥接合同：行号换算、ratio↔页索引映射、
 * 与 documentScrollAnchor 存储的往返（ratio + 章节锚点透传）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  pageIndexForRatio,
  readBookReadingRatio,
  resolveBookEntryPage,
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

test('进入阅读模式总是先显示封面，保存进度只决定开书后的目标页', () => {
  assert.equal(resolveBookEntryPage(null, 10), 0)
  assert.equal(resolveBookEntryPage(0.6, 6), 3)
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
    const ratio = readBookReadingRatio('/tmp/book.md')
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
  assert.equal(readBookReadingRatio(''), null)
})
