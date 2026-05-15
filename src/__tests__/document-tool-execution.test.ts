import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { executeDocumentTool } from '../main/modules/tools/document-tools'

function toolText(result: Awaited<ReturnType<typeof executeDocumentTool>>): string {
  return typeof result === 'string' ? result : result.text
}

describe('document tool execution', () => {
  it('returns real renderer summaries when a requester is available', async () => {
    const result = await executeDocumentTool(
      'document_list_widgets',
      {},
      {
        requestModuleToolAction: async (tool, args) => {
          assert.equal(tool, 'document.listWidgets')
          assert.deepEqual(args, {})
          return {
            intent: 'document.listWidgets',
            summary: '当前文档共有 1 个 widget（新文档.md）：\n1. stock_price_chart [scripted]',
          }
        },
      },
    )

    assert.match(toolText(result), /当前文档共有 1 个 widget/)
  })

  it('falls back to queued summaries when renderer execution is unavailable', async () => {
    const result = await executeDocumentTool('document_save_tab', {})
    assert.equal(toolText(result), 'Document save queued: document.saveTab')
  })

  it('accepts componentSpec payloads for widget insertion tools', async () => {
    const result = await executeDocumentTool(
      'document_insert_widget',
      {
        title: 'today_schedule',
        position: 'append_end',
        componentSpec: {
          component: 'day_schedule_card',
          dataSource: { type: 'calendar', preset: 'today' },
        },
      },
      {
        requestModuleToolAction: async (tool, args) => {
          assert.equal(tool, 'document.insertWidget')
          assert.equal(typeof args.componentSpec, 'object')
          return {
            summary: '已在文档尾部插入 widget（新文档.md）',
          }
        },
      },
    )

    assert.match(toolText(result), /插入 widget/)
  })

  it('returns structured mutation metadata from renderer document actions', async () => {
    const result = await executeDocumentTool(
      'document_replace_text',
      { from: 'Old', to: 'New' },
      {
        requestModuleToolAction: async () => ({
          summary: '文本替换已拒绝：不能用普通文本替换工具修改 show-widget 代码块内部内容。请改用 document_update_widget。',
          mutated: false,
          mutationReason: 'rejected',
          errorKind: 'widget_boundary_violation',
          recoverable: true,
        }),
      },
    )

    assert.equal(typeof result, 'object')
    assert.equal(typeof result === 'string' ? null : result.data?.errorKind, 'widget_boundary_violation')
    assert.equal(typeof result === 'string' ? null : result.data?.mutated, false)
  })
})
