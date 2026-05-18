import assert from 'node:assert/strict'
import test from 'node:test'

import {
  captureMarkdownLineAnchor,
  DOCUMENT_READING_POSITIONS_KEY,
  loadDocumentReadingPosition,
  readDocumentReadingPositionMap,
  readDocumentReadingPositions,
  resolveMarkdownLineFromAnchor,
  saveDocumentReadingPosition,
} from '../renderer/modules/document/documentScrollAnchor'

function makeChapter(title: string, lines: number): string {
  return [
    `# ${title}`,
    ...Array.from({ length: lines }, (_, index) => `${title} 正文 ${index + 1}`),
  ].join('\n')
}

function createStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
}

test('markdown scroll anchor keeps position inside a long chapter', () => {
  const content = [
    makeChapter('第一章', 120),
    makeChapter('第二章', 80),
  ].join('\n')
  const anchor = captureMarkdownLineAnchor(content, 91)
  assert.deepEqual(anchor?.title, '第一章')
  assert.equal(anchor?.ordinal, 0)

  const restored = resolveMarkdownLineFromAnchor(content, {
    anchorTitle: anchor?.title || null,
    anchorOrdinal: anchor?.ordinal ?? null,
    anchorProgress: anchor?.progress ?? null,
  })
  assert.ok(restored)
  assert.ok(Math.abs(restored - 91) <= 1)
})

test('markdown scroll anchor distinguishes duplicate chapter titles', () => {
  const content = [
    makeChapter('重复标题', 20),
    makeChapter('重复标题', 50),
  ].join('\n')
  const anchor = captureMarkdownLineAnchor(content, 40)
  assert.equal(anchor?.title, '重复标题')
  assert.equal(anchor?.ordinal, 1)

  const restored = resolveMarkdownLineFromAnchor(content, {
    anchorTitle: '重复标题',
    anchorOrdinal: 1,
    anchorProgress: anchor?.progress ?? null,
  })
  assert.ok(restored)
  assert.ok(restored >= 35)
})

test('document reading positions round-trip through persistent storage', () => {
  const storage = createStorage()

  saveDocumentReadingPosition('/tmp/a.md', {
    top: 240,
    ratio: 0.4,
    maxScroll: 600,
    anchorTitle: 'Chapter 2',
    anchorOrdinal: 1,
    anchorProgress: 0.25,
  }, storage)

  assert.deepEqual(loadDocumentReadingPosition('/tmp/a.md', storage), {
    top: 240,
    ratio: 0.4,
    maxScroll: 600,
    anchorTitle: 'Chapter 2',
    anchorOrdinal: 1,
    anchorProgress: 0.25,
  })
})

test('document reading position cache ignores corrupt rows and exposes a restore map', () => {
  const storage = createStorage()
  storage.setItem(DOCUMENT_READING_POSITIONS_KEY, JSON.stringify([
    { key: '/tmp/a.md', top: 10, ratio: 2, maxScroll: 50, updatedAt: 2 },
    { key: '', top: 5, ratio: 0.1, maxScroll: 20, updatedAt: 3 },
    { key: '/tmp/b.md', top: 'bad', ratio: 0.1, maxScroll: 20, updatedAt: 4 },
  ]))

  const records = readDocumentReadingPositions(storage)
  assert.equal(records.length, 1)
  assert.equal(records[0].key, '/tmp/a.md')
  assert.equal(records[0].ratio, 1)

  const map = readDocumentReadingPositionMap(storage)
  assert.deepEqual(map.get('/tmp/a.md'), {
    top: 10,
    ratio: 1,
    maxScroll: 50,
    anchorTitle: null,
    anchorOrdinal: null,
    anchorProgress: null,
  })
})
