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

  it('returns a visible delivered file artifact after document save succeeds', async () => {
    const result = await executeDocumentTool(
      'document_save_tab',
      {},
      {
        requestModuleToolAction: async () => ({
          summary: '已保存文档：/tmp/ready-report.md',
          documentSaved: true,
          documentPath: '/tmp/ready-report.md',
        }),
      },
    )

    assert.equal(typeof result, 'object')
    if (typeof result === 'string') throw new Error('expected structured document save output')
    const artifact = result.projectionPatch?.recentArtifacts as Array<Record<string, unknown>> | undefined
    assert.equal(result.data?.documentSaved, true)
    assert.equal(artifact?.[0]?.kind, 'delivered_file')
    assert.equal(artifact?.[0]?.path, '/tmp/ready-report.md')
    assert.equal(result.projectionPatch?.taskTitle, '文档已保存')
  })

  it('marks document save failures as failed progress, not running', async () => {
    const result = await executeDocumentTool(
      'document_save_tab',
      {},
      {
        requestModuleToolAction: async () => ({
          summary: '保存失败：权限不足',
          documentSaved: false,
          documentPath: '/tmp/ready-report.md',
        }),
      },
    )

    assert.equal(typeof result, 'object')
    if (typeof result === 'string') throw new Error('expected structured document save output')
    const steps = result.projectionPatch?.steps as Array<Record<string, unknown>> | undefined
    assert.equal(result.projectionPatch?.taskTitle, '文档保存失败')
    assert.equal(steps?.[0]?.status, 'error')
    assert.equal(result.projectionPatch?.recentArtifacts, undefined)
  })

  it('does not mint a verified artifact when save is skipped without structured save success', async () => {
    const result = await executeDocumentTool(
      'document_save_tab',
      {},
      {
        requestModuleToolAction: async () => ({
          summary: '文档未改动，已跳过保存：/tmp/ready-report.md',
          documentSaved: false,
          documentPath: '/tmp/ready-report.md',
        }),
      },
    )

    assert.equal(typeof result, 'object')
    if (typeof result === 'string') throw new Error('expected structured document save output')
    const steps = result.projectionPatch?.steps as Array<Record<string, unknown>> | undefined
    assert.equal(result.projectionPatch?.taskTitle, '文档未改动')
    assert.equal(steps?.[0]?.status, 'done')
    assert.equal(result.projectionPatch?.recentArtifacts, undefined)
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
    const steps = typeof result === 'string' ? null : result.projectionPatch?.steps as Array<Record<string, unknown>> | undefined
    assert.equal(typeof result === 'string' ? null : result.projectionPatch?.taskTitle, '文档写入失败')
    assert.equal(steps?.[0]?.status, 'error')
  })

  it('emits done progress for successful widget removal', async () => {
    const result = await executeDocumentTool(
      'document_remove_widget',
      { target: 'price_card' },
      {
        requestModuleToolAction: async () => ({
          summary: '已删除 widget：price_card',
          mutated: true,
          mutationReason: 'changed',
        }),
      },
    )

    assert.equal(typeof result, 'object')
    const steps = typeof result === 'string' ? null : result.projectionPatch?.steps as Array<Record<string, unknown>> | undefined
    assert.equal(typeof result === 'string' ? null : result.projectionPatch?.taskTitle, '正在写入文档')
    assert.equal(steps?.[0]?.status, 'done')
  })

  it('does not treat successful mutation titles containing failure words as failed progress', async () => {
    const result = await executeDocumentTool(
      'document_rewrite_section',
      { sectionTitle: '失败复盘', content: 'done' },
      {
        requestModuleToolAction: async () => ({
          summary: '已重写章节（失败复盘）',
          mutated: true,
          mutationReason: 'changed',
        }),
      },
    )

    assert.equal(typeof result, 'object')
    const steps = typeof result === 'string' ? null : result.projectionPatch?.steps as Array<Record<string, unknown>> | undefined
    assert.equal(typeof result === 'string' ? null : result.projectionPatch?.taskTitle, '正在写入文档')
    assert.equal(steps?.[0]?.status, 'done')
  })

  it('does not treat structured mutation summaries containing failure words as failed without an explicit failure', async () => {
    const result = await executeDocumentTool(
      'document_rewrite_section',
      { sectionTitle: '失败复盘', content: 'done' },
      {
        requestModuleToolAction: async () => ({
          summary: '已重写章节（失败复盘）',
          documentTabId: 'doc-1',
          documentTitle: '失败复盘.md',
          documentDirty: true,
          documentSaveState: 'dirty',
        }),
      },
    )

    assert.equal(typeof result, 'object')
    const steps = typeof result === 'string' ? null : result.projectionPatch?.steps as Array<Record<string, unknown>> | undefined
    assert.equal(typeof result === 'string' ? null : result.projectionPatch?.taskTitle, '正在写入文档')
    assert.equal(steps?.[0]?.status, 'done')
  })

  it('emits failed progress for unsuccessful widget removal', async () => {
    const result = await executeDocumentTool(
      'document_remove_widget',
      { target: 'price_card' },
      {
        requestModuleToolAction: async () => ({
          summary: '未找到 widget：price_card',
          mutated: false,
          mutationReason: 'no_match',
        }),
      },
    )

    assert.equal(typeof result, 'object')
    const steps = typeof result === 'string' ? null : result.projectionPatch?.steps as Array<Record<string, unknown>> | undefined
    assert.equal(typeof result === 'string' ? null : result.projectionPatch?.taskTitle, '文档写入失败')
    assert.equal(steps?.[0]?.status, 'error')
  })
})
