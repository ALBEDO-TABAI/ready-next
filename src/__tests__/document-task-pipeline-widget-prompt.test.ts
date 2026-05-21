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
  const requests: Array<{ session: { systemPrompt: string; messages: Array<{ role: string; content: string }> } }> = []
  const executor = new DocumentTaskPipelineExecutor({
    log: () => {},
    requestKimiCodingSimple: async () => responses.shift() || '{}',
    requestAnthropicSimple: async () => responses.shift() || '{}',
    requestOpenAISimple: async (request: any) => {
      requests.push(request)
      return responses.shift() || '{}'
    },
  } as any)
  return { executor: executor as any, requests }
}

const snapshot = {
  tabId: 'tab-1',
  title: 'Guide.md',
  path: '/tmp/Guide.md',
  content: [
    '# Guide',
    '',
    '```show-widget',
    JSON.stringify({
      id: 'widget_guide',
      title: '指引',
      widget_code: '<div>current guide</div>',
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

const insight = {
  question: '根据文档做信息卡',
  documentPath: snapshot.path,
  documentTitle: snapshot.title,
  summary: '文档说明了当前项目指引。',
  keyPoints: ['先读文档', '再生成卡片'],
  evidence: [{ quote: '项目指引' }],
  recommendedWidget: 'info_card',
}

const validDraft = JSON.stringify({
  title: 'guide_summary',
  insertionMode: 'append_end',
  componentSpec: {
    component: 'info_card',
    props: { heading: '项目指引', body: '文档说明了当前项目指引。', tone: 'info' },
  },
})

describe('document pipeline widget draft prompt behavior', () => {
  it('builds the widget-draft system prompt from the approved component props contract', async () => {
    const { executor, requests } = buildExecutor([validDraft])

    await executor.buildDocumentPipelineWidgetDraft({
      question: '根据当前文档做一张信息卡',
      snapshot,
      insight,
      plan: {
        taskType: 'document_read_then_widget_create',
        operation: 'create',
        question: '根据当前文档做一张信息卡',
        documentPath: snapshot.path,
        deepRead: false,
        preferredWidget: 'info_card',
        maxChars: 16000,
      },
      timeoutMs: 1000,
      providerContext: { isKimiCoding: false, useAnthropicProtocol: false, isKimi: false, config: {}, baseUrl: '' },
      signal: new AbortController().signal,
    })

    assert.equal(requests.length, 1)
    const systemPrompt = requests[0].session.systemPrompt
    assert.match(systemPrompt, /每个允许的组件 props 字段/)
    assert.match(systemPrompt, /所有必填字段都必须出现且非空/)
    assert.match(systemPrompt, /info_card/)
    assert.match(systemPrompt, /body/)
  })

  it('puts existing update candidates before insight details and omits them for create mode', async () => {
    const updateResponse = JSON.stringify({
      title: 'guide_update',
      insertionMode: 'update_existing',
      targetWidgetTitle: '指引',
      componentSpecPatch: { props: { tone: 'warning' } },
    })
    const updateHarness = buildExecutor([updateResponse])

    await updateHarness.executor.buildDocumentPipelineWidgetDraft({
      question: '把现有信息卡改成 warning',
      snapshot,
      insight,
      plan: {
        taskType: 'document_read_then_widget_update',
        operation: 'update',
        question: '把现有信息卡改成 warning',
        documentPath: snapshot.path,
        deepRead: false,
        preferredWidget: 'info_card',
        maxChars: 16000,
      },
      timeoutMs: 1000,
      providerContext: { isKimiCoding: false, useAnthropicProtocol: false, isKimi: false, config: {}, baseUrl: '' },
      signal: new AbortController().signal,
      preferredTargetWidgetTitle: '指引',
    })

    const updatePrompt = updateHarness.requests[0].session.messages[0].content
    assert.ok(updatePrompt.indexOf('现有 widget（update 候选') > -1)
    assert.ok(updatePrompt.indexOf('现有 widget（update 候选') < updatePrompt.indexOf('insight JSON'))
    assert.match(updatePrompt, /"title": "指引"/)
    assert.match(updateHarness.requests[0].session.systemPrompt, /必须沿用同一组件/)

    const createHarness = buildExecutor([validDraft])
    await createHarness.executor.buildDocumentPipelineWidgetDraft({
      question: '根据当前文档做一张信息卡',
      snapshot,
      insight,
      plan: {
        taskType: 'document_read_then_widget_create',
        operation: 'create',
        question: '根据当前文档做一张信息卡',
        documentPath: snapshot.path,
        deepRead: false,
        preferredWidget: 'info_card',
        maxChars: 16000,
      },
      timeoutMs: 1000,
      providerContext: { isKimiCoding: false, useAnthropicProtocol: false, isKimi: false, config: {}, baseUrl: '' },
      signal: new AbortController().signal,
    })

    assert.doesNotMatch(createHarness.requests[0].session.messages[0].content, /现有 widget（update 候选/)
  })

  it('clips long widget code before placing existing widgets in the prompt', async () => {
    const longWidgetSnapshot = {
      ...snapshot,
      content: [
        '# Guide',
        '',
        '```show-widget',
        JSON.stringify({
          title: '长卡片',
          widget_code: `<div>${'x'.repeat(1500)}</div>`,
          component_spec: {
            component: 'info_card',
            props: { heading: '旧标题', body: '旧正文' },
          },
        }),
        '```',
      ].join('\n'),
    }
    const { executor, requests } = buildExecutor([
      JSON.stringify({
        title: 'long_update',
        insertionMode: 'update_existing',
        targetWidgetTitle: '长卡片',
        componentSpecPatch: { props: { heading: '新标题' } },
      }),
    ])

    await executor.buildDocumentPipelineWidgetDraft({
      question: '更新长卡片标题',
      snapshot: longWidgetSnapshot,
      insight,
      plan: {
        taskType: 'document_read_then_widget_update',
        operation: 'update',
        question: '更新长卡片标题',
        documentPath: snapshot.path,
        deepRead: false,
        preferredWidget: 'info_card',
        maxChars: 16000,
      },
      timeoutMs: 1000,
      providerContext: { isKimiCoding: false, useAnthropicProtocol: false, isKimi: false, config: {}, baseUrl: '' },
      signal: new AbortController().signal,
      preferredTargetWidgetTitle: '长卡片',
    })

    assert.match(requests[0].session.messages[0].content, /widgetCode 已截断/)
  })
})
