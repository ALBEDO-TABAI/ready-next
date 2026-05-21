import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { describe, it } from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return {
        url: [
          'data:text/javascript,',
          'export const ipcMain={};',
          'export const dialog={};',
          'export const shell={};',
          'export const BrowserWindow=class{};',
          'export const WebContents=class{};',
        ].join(''),
        shortCircuit: true,
      }
    }
    return nextResolve(specifier, context)
  },
})

const { DocumentTaskPipelineExecutor } = await import(
  '../main/modules/agent-control/document-pipeline/document-task-pipeline-executor'
)

function buildExecutor(responses: string[]) {
  const logs: string[] = []
  const executor = new DocumentTaskPipelineExecutor({
    log: (message: string) => logs.push(message),
    requestKimiCodingSimple: async () => responses.shift() || '{}',
    requestAnthropicSimple: async () => responses.shift() || '{}',
    requestOpenAISimple: async () => responses.shift() || '{}',
  } as any)
  return { executor: executor as any, logs }
}

const snapshot = {
  tabId: 'tab-1',
  title: 'Guide.md',
  path: '/tmp/Guide.md',
  content: '# Guide\n正文',
  isDirty: false,
  charCount: 12,
}

const createPlan = {
  taskType: 'document_read_then_widget_create',
  operation: 'create',
  question: '根据当前文档做一张信息卡',
  documentPath: snapshot.path,
  deepRead: false,
  preferredWidget: 'info_card',
  maxChars: 16000,
}

function buildInsight() {
  return {
    question: '根据文档做信息卡',
    documentPath: snapshot.path,
    documentTitle: snapshot.title,
    summary: '文档说明了当前项目指引。',
    keyPoints: ['先读文档', '再生成卡片', '最后保存结果', '保留证据', '多余点会被裁剪'],
    evidence: [{ quote: '项目指引' }],
    recommendedWidget: 'stats_card',
  }
}

describe('document pipeline widget draft fallback behavior', () => {
  it('uses an info_card summary fallback for create mode when both draft attempts are invalid', async () => {
    const insight = buildInsight()
    const { executor, logs } = buildExecutor(['not json', 'still not json'])

    const result = await executor.buildDocumentPipelineWidgetDraft({
      question: '根据当前文档做一张信息卡',
      snapshot,
      insight,
      plan: createPlan,
      timeoutMs: 1000,
      providerContext: { isKimiCoding: false, useAnthropicProtocol: false, isKimi: false, config: {}, baseUrl: '' },
      signal: new AbortController().signal,
    })

    assert.equal(result.cacheable, false)
    assert.equal(result.draft.insertionMode, 'append_end')
    assert.equal(result.draft.componentSpec.component, 'info_card')
    assert.deepEqual(result.draft.componentSpec.props.points, insight.keyPoints.slice(0, 4))
    assert.match(result.draft.title, /guide_summary_card/)
    assert.ok(logs.includes('document pipeline widget draft fallback=applied mode=create'))
  })

  it('annotates the insight warnings with the fallback reason', async () => {
    const insight = buildInsight()
    const { executor } = buildExecutor(['not json', 'still not json'])

    await executor.buildDocumentPipelineWidgetDraft({
      question: '根据当前文档做一张信息卡',
      snapshot,
      insight,
      plan: createPlan,
      timeoutMs: 1000,
      providerContext: { isKimiCoding: false, useAnthropicProtocol: false, isKimi: false, config: {}, baseUrl: '' },
      signal: new AbortController().signal,
    })

    assert.ok(insight.warnings?.some((warning: string) => warning.includes('已使用兜底摘要卡')))
    assert.ok(insight.warnings?.some((warning: string) => warning.includes('Widget 草稿未返回可解析 JSON')))
  })
})
