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
  '../main/modules/agent-control/document-task-pipeline-executor'
)

function buildExecutor(responses: string[]) {
  const requests: Array<{ session: { messages: Array<{ role: string; content: string }> } }> = []
  const logs: string[] = []
  const executor = new DocumentTaskPipelineExecutor({
    log: (message: string) => logs.push(message),
    requestKimiCodingSimple: async () => responses.shift() || '{}',
    requestAnthropicSimple: async () => responses.shift() || '{}',
    requestOpenAISimple: async (request: any) => {
      requests.push(request)
      return responses.shift() || '{}'
    },
  } as any)
  return { executor: executor as any, requests, logs }
}

const snapshot = {
  tabId: 'tab-1',
  title: 'Guide.md',
  path: '/tmp/Guide.md',
  content: '# Guide\n正文',
  isDirty: false,
  charCount: 12,
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

const createPlan = {
  taskType: 'document_read_then_widget_create',
  operation: 'create',
  question: '根据当前文档做一张信息卡',
  documentPath: snapshot.path,
  deepRead: false,
  preferredWidget: 'info_card',
  maxChars: 16000,
}

const validDraft = JSON.stringify({
  title: 'guide_summary',
  insertionMode: 'append_end',
  componentSpec: {
    component: 'info_card',
    props: { heading: '项目指引', body: '文档说明了当前项目指引。', tone: 'info' },
  },
})

async function buildDraft(executor: any, overrides: Record<string, unknown> = {}) {
  return executor.buildDocumentPipelineWidgetDraft({
    question: '根据当前文档做一张信息卡',
    snapshot,
    insight,
    plan: createPlan,
    timeoutMs: 1000,
    providerContext: { isKimiCoding: false, useAnthropicProtocol: false, isKimi: false, config: {}, baseUrl: '' },
    signal: new AbortController().signal,
    ...overrides,
  })
}

describe('document pipeline widget draft reprompt behavior', () => {
  it('returns after a schema-valid first attempt without requesting a retry', async () => {
    const { executor, requests, logs } = buildExecutor([validDraft])

    const result = await buildDraft(executor)

    assert.equal(requests.length, 1)
    assert.equal(result.cacheable, true)
    assert.equal(result.draft.title, 'guide_summary')
    assert.ok(logs.some((line) => line.includes('attempt=1 rawChars=')))
    assert.ok(!logs.some((line) => line.includes('attempt=2 rawChars=')))
  })

  it('turns an invalid first attempt into one reprompt that carries the original answer and validation errors', async () => {
    const firstRaw = JSON.stringify({
      title: 'bad_card',
      insertionMode: 'append_end',
      componentSpec: { component: 'info_card', props: { heading: '缺 body' } },
    })
    const { executor, requests, logs } = buildExecutor([firstRaw, validDraft])

    const result = await buildDraft(executor)

    assert.equal(requests.length, 2)
    assert.equal(result.cacheable, true)
    assert.equal(result.draft.title, 'guide_summary')
    assert.ok(logs.some((line) => line.includes('attempt=1 invalid errors=')))
    assert.ok(logs.some((line) => line.includes('attempt=2 rawChars=')))

    const repromptMessages = requests[1].session.messages
    assert.deepEqual(repromptMessages.map((message) => message.role), ['system', 'user', 'assistant', 'user'])
    assert.equal(repromptMessages[2].content, firstRaw)
    assert.match(repromptMessages[3].content, /上一次输出的 componentSpec 未通过校验/)
    assert.match(repromptMessages[3].content, /body/)
  })

  it('treats unparseable JSON as a validation failure so the retry path still runs', async () => {
    const { executor, requests } = buildExecutor(['not json', validDraft])

    const result = await buildDraft(executor)

    assert.equal(requests.length, 2)
    assert.equal(result.cacheable, true)
    assert.match(requests[1].session.messages[3].content, /Widget 草稿未返回可解析 JSON/)
  })

  it('throws after the single retry in update mode when both attempts fail', async () => {
    const content = [
      '# Guide',
      '',
      '```show-widget',
      JSON.stringify({
        title: '指引',
        component_spec: {
          component: 'info_card',
          props: { heading: '旧标题', body: '旧正文' },
        },
      }),
      '```',
    ].join('\n')
    const { executor, requests } = buildExecutor(['not json', 'still not json'])

    await assert.rejects(
      () => buildDraft(executor, {
        question: '更新现有信息卡',
        snapshot: { ...snapshot, content },
        plan: {
          taskType: 'document_read_then_widget_update',
          operation: 'update',
          question: '更新现有信息卡',
          documentPath: snapshot.path,
          deepRead: false,
          preferredWidget: 'info_card',
          maxChars: 16000,
        },
        preferredTargetWidgetTitle: '指引',
      }),
      /Widget componentSpec 两次校验失败/,
    )
    assert.equal(requests.length, 2)
  })
})
