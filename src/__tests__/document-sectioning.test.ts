import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildFocusedDocumentContext } from '../shared/document-sectioning'

describe('document sectioning', () => {
  it('keeps markdown sections as the primary chunk boundaries', () => {
    const content = [
      '# 项目定位',
      '',
      'Ready 是一个集成式创作工作台，统一承载浏览、文稿、RSS、日程。',
      '',
      '## 核心能力',
      '',
      '多模式切换、Agent 协作、技能中心。',
      '',
      '## 商业模式',
      '',
      '订阅和高级工作流。',
    ].join('\n')

    const result = buildFocusedDocumentContext({
      question: '围绕项目定位和核心能力做一个信息卡',
      content,
      maxCharsPerChunk: 120,
      maxSelectedChunks: 2,
    })

    assert.equal(result.chunks.length >= 3, true)
    assert.equal(result.selectedChunks.length, 2)
    assert.deepEqual(
      result.selectedChunks.map((item) => item.sectionTitle),
      ['项目定位', '核心能力'],
    )
  })

  it('splits oversized sections into multiple chunks before selection', () => {
    const longParagraph = '这是一个很长的段落，用来模拟项目背景。'.repeat(40)
    const content = [
      '# 项目背景',
      '',
      longParagraph,
      '',
      '# 结论',
      '',
      '最终要做成项目定位信息卡。',
    ].join('\n')

    const result = buildFocusedDocumentContext({
      question: '根据结论做一个信息卡',
      content,
      maxCharsPerChunk: 180,
      maxSelectedChunks: 2,
    })

    assert.equal(
      result.chunks.filter((item) => item.sectionTitle === '项目背景').length > 1,
      true,
    )
    assert.equal(result.selectedChunks[0]?.sectionTitle, '结论')
  })

  it('falls back to paragraph windows when the document has no headings', () => {
    const content = [
      '第一段说明项目定位和产品方向。',
      '',
      '第二段说明核心能力和工作台模式。',
      '',
      '第三段说明风险与限制。',
    ].join('\n')

    const result = buildFocusedDocumentContext({
      question: '提炼核心能力做信息卡',
      content,
      maxCharsPerChunk: 40,
      maxSelectedChunks: 2,
    })

    assert.equal(result.chunks.length > 1, true)
    assert.equal(result.selectedChunks.length > 0, true)
    assert.match(result.promptText, /核心能力/)
  })
})
