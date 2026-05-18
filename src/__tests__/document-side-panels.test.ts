import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildDocumentOutline,
  resolveDocumentMarkLocation,
  type DocumentMarkRecord,
} from '../shared/document-side-panels'

function mark(overrides: Partial<DocumentMarkRecord>): DocumentMarkRecord {
  return {
    id: 'dm-test',
    kind: 'bookmark',
    documentPath: '/tmp/doc.md',
    title: 'Anchor',
    groupName: '默认',
    noteText: null,
    excerpt: null,
    lineStart: null,
    lineEnd: null,
    anchorTitle: null,
    anchorOrdinal: null,
    anchorProgress: null,
    anchorStatus: 'linked',
    sortOrder: 0,
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
    ...overrides,
  }
}

describe('document side panels', () => {
  it('builds a compact outline from headings and list groups', () => {
    const outline = buildDocumentOutline(`# 标题

开场摘要

## 方案

- 第一条
- 第二条

## 结论

完成。`, new Date('2026-05-18T00:00:00.000Z'))

    assert.equal(outline.lineCount, 12)
    assert.equal(outline.nodes[0].title, '标题')
    assert.equal(outline.nodes[1].title, '方案')
    assert.equal(outline.nodes.some((node) => node.kind === 'list' && node.summary.includes('第一条')), true)
    assert.equal(outline.nodes.at(-1)?.title, '结论')
  })

  it('resolves marks by heading anchors after content moves', () => {
    const moved = `# 新标题

新增内容

## 目标

正文。`
    const location = resolveDocumentMarkLocation(mark({
      anchorTitle: '目标',
      anchorOrdinal: 0,
      anchorProgress: 0,
      lineStart: 1,
      excerpt: '正文。',
    }), moved)

    assert.equal(location.status, 'linked')
    assert.equal(location.lineStart, 5)
  })

  it('marks durable anchors stale instead of jumping to an old line', () => {
    const location = resolveDocumentMarkLocation(mark({
      anchorTitle: '已删除',
      anchorOrdinal: 0,
      lineStart: 2,
      excerpt: '已经不存在的摘录',
    }), '# 还在\n\n别的正文')

    assert.deepEqual(location, {
      status: 'stale',
      lineStart: null,
      lineEnd: null,
    })
  })
})
