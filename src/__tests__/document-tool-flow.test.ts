import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  accumulateDocumentToolProgress,
  buildDocumentToolCompletionText,
  inspectDocumentToolCall,
} from '../main/modules/claude-bridge/document-tool-flow'

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

  it('completes when mutation and save happen across separate iterations', () => {
    const afterMutation = accumulateDocumentToolProgress(undefined, {
      executedMutatingDocActionCount: 1,
      executedSaveDocActionCount: 0,
      toolResults: ['已插入 widget：weekly_focus_card（新文档.md）'],
    })

    const textAfterMutation = buildDocumentToolCompletionText({
      forceDocumentTool: true,
      executedMutatingDocActionCount: afterMutation.executedMutatingDocActionCount,
      executedSaveDocActionCount: afterMutation.executedSaveDocActionCount,
      lastWidgetValidationError: null,
      toolResults: afterMutation.toolResults,
    })

    assert.equal(textAfterMutation, null)

    const afterSave = accumulateDocumentToolProgress(afterMutation, {
      executedMutatingDocActionCount: 0,
      executedSaveDocActionCount: 1,
      toolResults: ['已保存文档：/Users/user/新文档.md'],
    })

    const textAfterSave = buildDocumentToolCompletionText({
      forceDocumentTool: true,
      executedMutatingDocActionCount: afterSave.executedMutatingDocActionCount,
      executedSaveDocActionCount: afterSave.executedSaveDocActionCount,
      lastWidgetValidationError: null,
      toolResults: afterSave.toolResults,
    })

    assert.match(textAfterSave || '', /已插入 widget/)
    assert.match(textAfterSave || '', /已保存文档/)
  })

  it('does not count skipped widget updates as real content mutation', () => {
    const inspection = inspectDocumentToolCall(
      'document_update_widget',
      'widget 内容未变化，已跳过：新文档.md',
    )

    assert.equal(inspection.executedMutatingDocActionCount, 0)
    assert.equal(inspection.executedSaveDocActionCount, 0)
  })
})
