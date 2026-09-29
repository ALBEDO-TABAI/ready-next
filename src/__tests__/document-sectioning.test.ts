import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildDocumentSectionIndex, resolveDocumentSectionAnchor
} from '../shared/document-sectioning'

describe('document sectioning', () => {

  it('recognizes top-level numbered headings with a trailing dot', () => {
    const content = [
      '1. 总览',
      '',
      '第一部分正文。',
      '',
      '2. 文本通道',
      '',
      '第二部分正文。',
      '',
      '3. 意图理解规格',
      '',
      '第三部分正文。',
      '',
      '3.1 意图阅读三要素',
      '',
      '第三部分子段。',
    ].join('\n')

    const index = buildDocumentSectionIndex(content)
    const third = resolveDocumentSectionAnchor(index, '意图理解规格')

    assert.equal(third?.displayTitle, '意图理解规格')
    assert.equal(third?.line, 8)
    assert.equal(third?.endLine, 12)
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

  it('treats markdown part headings as part anchors before numbered chapters', () => {
    const content = [
      '# 白痴',
      '',
      '## 第一部',
      '',
      '### 一',
      '',
      '第一部第一章正文。',
      '',
      '### 二',
      '',
      '第一部第二章正文。',
      '',
      '## 第二部',
      '',
      '### 一',
      '',
      '第二部第一章正文，真正目标。',
      '',
      '### 二',
      '',
      '第二部第二章正文。',
    ].join('\n')

    const index = buildDocumentSectionIndex(content)
    const secondPartFirst = resolveDocumentSectionAnchor(index, '第二部第一章')

    assert.equal(secondPartFirst?.displayTitle, '第二部第一章')
    assert.equal(secondPartFirst?.line, 14)
    assert.equal(secondPartFirst?.endLine, 18)
  })
})
