import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifyStructuredDocumentIntent } from '../main/modules/agent-control/document-task-types'

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
      null,
    )
  })
})
