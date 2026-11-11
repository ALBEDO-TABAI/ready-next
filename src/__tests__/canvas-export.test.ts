import assert from 'node:assert/strict'
import test from 'node:test'
import { boardMarkdown } from '../renderer/modules/canvas/export'
import type { ReadyCanvas } from '../shared/ready-canvas/schema'

// W4 §2.2 导出: a board as Markdown in reading order, links relative to the board's own folder.
test('board Markdown follows rows then columns, links relative to the board, leaves shapes and groups out', () => {
  const canvas = { ready: { schemaVersion: 1, id: 'board', title: '灵感' }, edges: [], nodes: [
    { id: 'b', type: 'text', text: '## 第二张\n\n右边', x: 400, y: 10, width: 260, height: 120, ready: { kind: 'text' } },
    { id: 'a', type: 'text', text: '# 第一张', x: 0, y: 0, width: 260, height: 120, ready: { kind: 'note' } },
    { id: 'link', type: 'link', url: 'https://example.com/a', x: 0, y: 300, width: 260, height: 195, ready: { kind: 'link', preview: { title: '例子' } } },
    { id: 'doc', type: 'file', file: '项目/会议 11-03.md', x: 400, y: 310, width: 260, height: 180, ready: { kind: 'document' } },
    { id: 'img', type: 'file', file: '灵感.assets/图.png', x: 0, y: 700, width: 260, height: 200, ready: { kind: 'image' } },
    { id: 'shape', type: 'file', file: '灵感.assets/s.svg', x: 0, y: 900, width: 100, height: 100, ready: { kind: 'graphic', graphic: { type: 'rect', fill: '#ffffff', stroke: '#000000', strokeWidth: 1 } } },
    { id: 'group', type: 'group', label: '组', x: -20, y: -20, width: 800, height: 600, ready: { kind: 'group' } },
  ] } as unknown as ReadyCanvas
  assert.equal(boardMarkdown(canvas, '灵感.canvas'),
    '# 灵感\n\n# 第一张\n\n## 第二张\n\n右边\n\n[例子](https://example.com/a)\n\n[会议 11-03](%E9%A1%B9%E7%9B%AE/%E4%BC%9A%E8%AE%AE%2011-03.md)\n\n![图.png](%E7%81%B5%E6%84%9F.assets/%E5%9B%BE.png)\n')
  // A nested board links back up; a selection keeps only its cards.
  assert.match(boardMarkdown(canvas, '项目/子画板.canvas', new Set(['doc'])), /\[会议 11-03\]\(%E4%BC%9A%E8%AE%AE%2011-03\.md\)/)
  assert.doesNotMatch(boardMarkdown(canvas, '灵感.canvas', new Set(['a'])), /第二张/)
})
