import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildDocumentToolCompletionText } from '../main/modules/claude-bridge/document-tool-flow'

describe('document tool flow completion', () => {
  it('completes after a real mutation and save pair', () => {
    const text = buildDocumentToolCompletionText({
      forceDocumentTool: true,
      executedMutatingDocActionCount: 1,
      executedSaveDocActionCount: 1,
      lastWidgetValidationError: null,
      toolResults: [
        '已更新 widget：stock_price_chart（新文档.md）',
        '已保存文档：/Users/user/新文档.md',
      ],
    })

    assert.match(text || '', /已更新 widget/)
    assert.match(text || '', /已保存文档/)
  })

  it('does not complete on queued placeholders alone', () => {
    const text = buildDocumentToolCompletionText({
      forceDocumentTool: true,
      executedMutatingDocActionCount: 1,
      executedSaveDocActionCount: 1,
      lastWidgetValidationError: null,
      toolResults: [
        'Document content mutation queued: document.updateWidget',
        'Document save queued: document.saveTab',
      ],
    })

    assert.equal(text, null)
  })
})
