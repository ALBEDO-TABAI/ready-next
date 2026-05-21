import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { describe, it } from 'node:test'

import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'

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
  const executor = new DocumentTaskPipelineExecutor({
    log: () => {},
    requestKimiCodingSimple: async () => responses.shift() || '{}',
    requestAnthropicSimple: async () => responses.shift() || '{}',
    requestOpenAISimple: async () => responses.shift() || '{}',
  } as any)
  return executor as any
}

function buildParams(overrides: Record<string, unknown> = {}) {
  return {
    route: {
      taskId: 'task-doc',
      chain: 'domain_executor',
      executor: 'document',
    },
    executionIntentContext: {
      structuredDocumentIntent: 'document_read_then_widget_create',
      requestEnvelope: buildRequestEnvelope({ userText: '根据当前文档做一张信息卡' }),
      shouldUseDocumentTaskPlan: false,
      documentTaskPlan: null,
    },
    hasTools: true,
    requestModuleToolAction: async () => ({}),
    signal: new AbortController().signal,
    sessionId: 'session-doc',
    session: { activeRunId: null },
    providerContext: { isKimiCoding: false, useAnthropicProtocol: false, isKimi: false, config: {}, baseUrl: '' },
    emitStructuredTaskPayload: () => {},
    toolPolicy: { preferredSkillToolNames: null },
    ...overrides,
  }
}

const snapshot = {
  tabId: 'tab-doc',
  title: 'Guide.md',
  path: '/tmp/Guide.md',
  content: [
    '# Guide',
    '',
    '```show-widget',
    JSON.stringify({
      id: 'widget_guide',
      title: '指引',
      component_spec: {
        component: 'info_card',
        props: { heading: '旧标题', body: '旧正文', tone: 'info' },
      },
    }),
    '```',
  ].join('\n'),
  isDirty: false,
  charCount: 240,
}

const insightResponse = JSON.stringify({
  summary: '文档说明了当前项目指引。',
  keyPoints: ['先读文档', '再生成卡片'],
  evidence: [{ quote: '项目指引' }],
  recommendedWidget: 'info_card',
})

describe('document task pipeline host behavior', () => {
  it('does not claim non-document routes or document routes already narrowed to skill tools', async () => {
    const executor = buildExecutor([])

    assert.deepEqual(
      await executor.tryExecute(buildParams({ route: { taskId: 'task-browser', chain: 'domain_executor', executor: 'browser' } })),
      { handled: false },
    )
    assert.deepEqual(
      await executor.tryExecute(buildParams({ toolPolicy: { preferredSkillToolNames: ['skill_demo_run'] } })),
      { handled: false },
    )
  })

  it('handles structured create intents through the document widget pipeline and keeps tabId on host calls', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    const executor = buildExecutor([
      insightResponse,
      JSON.stringify({
        title: 'guide_summary',
        insertionMode: 'append_end',
        componentSpec: {
          component: 'info_card',
          props: { heading: '项目指引', body: '文档说明了当前项目指引。', tone: 'info' },
        },
      }),
    ])

    const result = await executor.tryExecute(buildParams({
      requestModuleToolAction: async (tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args })
        if (tool === 'document.inspectActive') return { snapshot }
        if (tool === 'document.insertWidget') return { summary: '已写入信息卡' }
        if (tool === 'document.saveTab') return { summary: '已保存文档' }
        return {}
      },
    }))

    assert.equal(result.handled, true)
    assert.equal(result.result.finish.success, true)
    assert.deepEqual(
      calls.map((call) => [call.tool, call.args.tabId]),
      [
        ['document.inspectActive', undefined],
        ['document.insertWidget', 'tab-doc'],
        ['document.saveTab', 'tab-doc'],
      ],
    )
  })

  it('handles structured update intents with locate, update, and save calls scoped to the active tab', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    const executor = buildExecutor([
      insightResponse,
      JSON.stringify({
        title: 'guide_update',
        insertionMode: 'update_existing',
        targetWidgetTitle: '指引',
        componentSpecPatch: { props: { tone: 'warning' } },
      }),
    ])

    const result = await executor.tryExecute(buildParams({
      executionIntentContext: {
        structuredDocumentIntent: 'document_read_then_widget_update',
        requestEnvelope: buildRequestEnvelope({ userText: '把现有信息卡改成 warning' }),
        shouldUseDocumentTaskPlan: false,
        documentTaskPlan: null,
      },
      requestModuleToolAction: async (tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args })
        if (tool === 'document.inspectActive') return { snapshot }
        if (tool === 'document.listWidgets') return { summary: '1. 指引' }
        if (tool === 'document.updateWidget') return { summary: '已更新信息卡：指引' }
        if (tool === 'document.saveTab') return { summary: '已保存文档' }
        return {}
      },
    }))

    assert.equal(result.handled, true)
    assert.equal(result.result.finish.success, true)
    assert.deepEqual(
      calls.map((call) => [call.tool, call.args.tabId]),
      [
        ['document.inspectActive', undefined],
        ['document.listWidgets', 'tab-doc'],
        ['document.updateWidget', 'tab-doc'],
        ['document.saveTab', 'tab-doc'],
      ],
    )
    const updateCall = calls.find((call) => call.tool === 'document.updateWidget')
    assert.equal(updateCall?.args.target, '指引')
    assert.deepEqual((updateCall?.args.componentSpecPatch as any)?.props, { tone: 'warning' })
  })
})
