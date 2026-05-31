import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildDocumentSectionIndex,
  buildFocusedDocumentContext,
  resolveDocumentSectionAnchor,
} from '../shared/document-sectioning'

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

  it('builds stable part + chapter anchors for imported ebook-style markdown', () => {
    const content = [
      '# 白痴',
      '',
      '## 目录',
      '',
      '- [第二部](#第二部)',
      '',
      '第一部',
      '',
      '### 一',
      '',
      '第一部第一章正文。',
      '',
      '### 二',
      '',
      '第一部第二章正文。',
      '',
      '第二部',
      '',
      '![cover](x.png)',
      '',
      '第二部',
      '',
      '### 一',
      '',
      '第二部第一章正文。',
      '',
      '### 二',
      '',
      '第二部第二章正文。',
      '',
      '第三部',
      '',
      '### 一',
      '',
      '第三部第一章正文。',
    ].join('\n')

    const index = buildDocumentSectionIndex(content)
    const secondPartFirst = resolveDocumentSectionAnchor(index, '第二部第一章')
    const secondPartFirstSpaced = resolveDocumentSectionAnchor(index, '第二部 一')
    const thirdPartFirst = resolveDocumentSectionAnchor(index, '第三部第一章')
    const bareFirst = resolveDocumentSectionAnchor(index, '一')

    assert.equal(secondPartFirst?.displayTitle, '第二部第一章')
    assert.equal(secondPartFirst?.line, 22)
    assert.equal(secondPartFirst?.endLine, 26)
    assert.equal(secondPartFirstSpaced?.line, secondPartFirst?.line)
    assert.equal(thirdPartFirst?.displayTitle, '第三部第一章')
    assert.equal(bareFirst?.displayTitle, '第一部第一章')
  })

  it('uses the shared section index when selecting focused document chunks', () => {
    const content = [
      '# 白痴',
      '',
      '第一部',
      '',
      '### 一',
      '',
      '第一部第一章正文，人物在第一部登场。',
      '',
      '第二部',
      '',
      '### 一',
      '',
      '第二部第一章正文，公爵和娜斯塔霞在这里发生关键转折。',
      '',
      '### 二',
      '',
      '第二部第二章正文。',
    ].join('\n')

    const result = buildFocusedDocumentContext({
      question: '看一下第二部第一章',
      content,
      maxCharsPerChunk: 120,
      maxSelectedChunks: 1,
    })

    assert.equal(result.selectedChunks[0]?.sectionTitle, '第二部第一章')
    assert.match(result.promptText, /关键转折/)
    assert.doesNotMatch(result.promptText, /第一部第一章正文/)
  })
})
