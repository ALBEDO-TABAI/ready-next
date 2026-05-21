import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyStructuredDocumentIntent } from '../main/modules/document-engine/pipeline/document-task-types'

describe('structured document task intent', () => {
  it('detects read-then-widget create requests', () => {
    assert.equal(
      classifyStructuredDocumentIntent('先阅读当前文档，然后做一个项目定位信息卡'),
      'document_read_then_widget_create',
    )
  })

  it('keeps direct widget update requests on the existing flow', () => {
    assert.equal(
      classifyStructuredDocumentIntent('把这个信息卡改成 warning 风格，并保留原来的内容'),
      'document_read_then_widget_update',
    )
  })

  it('detects document card creation requests even when the prompt does not literally say to read first', () => {
    assert.equal(
      classifyStructuredDocumentIntent('请为@[storyboard.pdf]在@[新文档.md]生成一张信息卡'),
      'document_read_then_widget_create',
    )
  })
})
