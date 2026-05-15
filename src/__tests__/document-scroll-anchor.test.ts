import assert from 'node:assert/strict'
import test from 'node:test'

import {
  captureMarkdownLineAnchor,
  resolveMarkdownLineFromAnchor,
} from '../renderer/modules/document/documentScrollAnchor'

function makeChapter(title: string, lines: number): string {
  return [
    `# ${title}`,
    ...Array.from({ length: lines }, (_, index) => `${title} 正文 ${index + 1}`),
  ].join('\n')
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
