import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  accumulateDocumentToolProgress,
  buildDocumentToolCompletionText,
  inspectDocumentToolCall,
  shouldPreferDocumentInspectionResult,
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

describe('shouldPreferDocumentInspectionResult · transport gating and regex tightening', () => {
  const inspectionResult = '当前文档共有 2 个 widget（x.md）：\n1. A · id=widget_a\n'

  it('returns false when inspectionResult is null', () => {
    assert.equal(shouldPreferDocumentInspectionResult('anything', null), false)
    assert.equal(shouldPreferDocumentInspectionResult('anything', null, 'native'), false)
  })

  it('empty responseText + native transport → true', () => {
    assert.equal(shouldPreferDocumentInspectionResult('', inspectionResult, 'native'), true)
    assert.equal(shouldPreferDocumentInspectionResult(undefined, inspectionResult, 'native'), true)
  })

  it('empty responseText + undefined transport → true (back-compat)', () => {
    assert.equal(shouldPreferDocumentInspectionResult('', inspectionResult), true)
  })

  it('empty responseText + text transport → false (bridge gates fallback)', () => {
    assert.equal(shouldPreferDocumentInspectionResult('', inspectionResult, 'text'), false)
    assert.equal(shouldPreferDocumentInspectionResult(undefined, inspectionResult, 'text'), false)
  })

  it('containing "调用了 document_list_widgets" still hits on native', () => {
    const responseText = '我刚才调用了 document_list_widgets，仅此而已。'
    assert.equal(shouldPreferDocumentInspectionResult(responseText, inspectionResult, 'native'), true)
  })

  it('containing "调用了 document_list_widgets" is suppressed on text transport', () => {
    const responseText = '我刚才调用了 document_list_widgets。'
    assert.equal(shouldPreferDocumentInspectionResult(responseText, inspectionResult, 'text'), false)
  })

  it('standalone "任务已完成。" no longer hits (regex tightened)', () => {
    assert.equal(shouldPreferDocumentInspectionResult('任务已完成。', inspectionResult, 'native'), false)
  })

  it('standalone "这是一个查询操作。" no longer hits (regex tightened)', () => {
    assert.equal(shouldPreferDocumentInspectionResult('这是一个查询操作。', inspectionResult, 'native'), false)
  })

  it('retains /如果用户需要我执行其他文档修改操作/ as a strong signal on native', () => {
    const responseText = '如果用户需要我执行其他文档修改操作，请告知。'
    assert.equal(shouldPreferDocumentInspectionResult(responseText, inspectionResult, 'native'), true)
  })

  it('returns false when responseText already includes inspectionResult', () => {
    const responseText = `抄了一份工具原文：${inspectionResult}`
    assert.equal(shouldPreferDocumentInspectionResult(responseText, inspectionResult, 'native'), false)
  })
})
