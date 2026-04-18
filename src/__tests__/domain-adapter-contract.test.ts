import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserDomainAdapter } from '../main/modules/agent-control/browser-domain-adapter'
import { DocumentDomainAdapter } from '../main/modules/agent-control/document-domain-adapter'
import { SkillDomainAdapter } from '../main/modules/agent-control/skill-domain-adapter'
import { RSSDomainAdapter } from '../main/modules/agent-control/rss-domain-adapter'
import { CalendarDomainAdapter } from '../main/modules/agent-control/calendar-domain-adapter'
import { FeishuDomainAdapter } from '../main/modules/agent-control/feishu-domain-adapter'
import { selectDomainAdapter, type DomainAdapter } from '../main/modules/agent-control/domain-adapter'
import { createToolExecutionOutput } from '../main/modules/agent-control/tool-result-types'

function createRoute(executor: 'browser' | 'document' | 'skill' | 'rss' | 'calendar' | 'feishu') {
  return {
    taskId: 'task-1',
    taskType: 'short_task' as const,
    chain: executor === 'browser' || executor === 'document' || executor === 'skill' ? 'domain_executor' as const : 'tool_loop' as const,
    executor,
    steps: [],
    continuation: null,
  }
}

function createAdapterApplyParams(executor: 'skill' | 'rss' | 'calendar' | 'feishu') {
  return {
    route: createRoute(executor),
    request: {
      sessionId: 'scope-1',
      runId: 'run-1',
      taskId: 'task-1',
      agentName: 'ready',
      abortSignal: new AbortController().signal,
      emitters: {
        emitOutput: () => undefined,
        emitStatus: () => undefined,
        emitRuntimeError: () => undefined,
        emitToolAction: () => undefined,
      },
    } as never,
    host: {
      providerContext: {},
      log: () => undefined,
    } as never,
    session: {
      messages: [],
    } as never,
    userText: `${executor} task`,
    pureUserInput: `${executor} task`,
    requestEnvelope: {} as never,
    executionIntentContext: {} as never,
    hasTools: true,
    toolPolicy: {} as never,
    allowedToolNames: null,
    emitStructuredTaskPayload: () => undefined,
  } as const
}

test('every phase4 domain adapter implements the unified lifecycle contract', () => {
  const adapters: DomainAdapter[] = [
    new BrowserDomainAdapter({} as never),
    new DocumentDomainAdapter({
      orchestrator: {} as never,
      toolLoopOrchestrator: {} as never,
    }),
    new SkillDomainAdapter(),
    new RSSDomainAdapter(),
    new CalendarDomainAdapter(),
    new FeishuDomainAdapter(),
  ]

  for (const adapter of adapters) {
    assert.equal(typeof adapter.shouldHandle, 'function')
    assert.equal(typeof adapter.prepare, 'function')
    assert.equal(typeof adapter.dispatch, 'function')
    assert.equal(typeof adapter.applyResult, 'function')
    assert.equal(typeof adapter.buildProjectionPatch, 'function')
  }
})

test('domain adapter selector picks the matching adapter for the resolved executor', () => {
  const adapters: DomainAdapter[] = [
    new SkillDomainAdapter(),
    new RSSDomainAdapter(),
    new CalendarDomainAdapter(),
    new FeishuDomainAdapter(),
  ]

  const selected = selectDomainAdapter(adapters, {
    route: createRoute('calendar'),
    userText: '安排今天下午的日程',
    hasTools: true,
    executionIntentContext: {} as never,
  })

  assert.equal(selected?.id, 'calendar')
})

test('browser domain adapter preserves upload prompt refinement before building browser state', async () => {
  const adapter = new BrowserDomainAdapter({
    async prepareBrowserExecution(params: Record<string, unknown>) {
      return {
        browserDecision: (params.decision as { mode: string; promptIntent?: { refined?: string } } | undefined) || {
          mode: 'browser_upload_workflow',
          promptIntent: { refined: '初始提示词' },
        },
        browserContinuity: null,
        browserContinuityInstruction: null,
        clarifyText: null,
        shouldInspectAmbiguousModeEntry: false,
        canUseDeterministicBrowserRunner: false,
      }
    },
    async refineUploadDecision(params: {
      decision: { mode: string; promptIntent?: { refined?: string } }
      requestPromptDraft: (planningPrompt: string) => Promise<string>
    }) {
      const draft = await params.requestPromptDraft('请补全提示词')
      return {
        ...params.decision,
        promptIntent: {
          refined: draft,
        },
      }
    },
    resolveExecutionDispatch() {
      return {
        kind: 'none' as const,
        continuityInstruction: null,
        responseText: null,
        toolLoopMessage: null,
        fallbackLog: null,
      }
    },
    async runDeterministicExecution() {
      return { handled: false, state: 'done' as const, message: '' }
    },
    createToolLoopState(decision: unknown) {
      return {
        isBrowserTask: true,
        steps: [],
        stepIndex: 0,
        browserToolCallCount: Number((decision as { promptIntent?: { refined?: string } }).promptIntent?.refined === '更具体的提示词'),
      }
    },
    recordToolLoopProgress() {
      return {
        state: { isBrowserTask: true, steps: [], stepIndex: 0, browserToolCallCount: 0 },
        advancedStepIndex: null,
        checkpointMessage: null,
      }
    },
    buildToolLoopLimitMessage() {
      return null
    },
    getBudgetHint() {
      return null
    },
    buildStructuredTaskPayload() {
      return {
        module: 'browser',
        taskTitle: '浏览器任务',
        taskSummary: '执行中',
        steps: [],
        currentStepId: null,
        waitingFor: 'none',
        resumableActions: ['cancel'],
        recentArtifacts: [],
        message: '执行中',
      }
    },
  } as never)

  const result = await adapter.prepare({
    route: createRoute('browser'),
    request: {
      sessionId: 'session-1',
      abortSignal: new AbortController().signal,
    } as never,
    host: {
      browserController: {} as never,
      providerContext: {} as never,
      skillContextOrchestrator: {
        findExplicitlyRequestedSkills: () => [],
      },
      isBrowserAgentV3Enabled: () => true,
      requestSimpleText: async () => ({ text: '更具体的提示词' }),
      log: () => undefined,
    } as never,
    session: {
      messages: [],
    } as never,
    userText: '上传图片并生成',
    pureUserInput: '上传图片并生成',
    requestEnvelope: {} as never,
    executionIntentContext: {} as never,
    hasTools: true,
    toolPolicy: {} as never,
    allowedToolNames: ['browser_open'],
  })

  assert.equal(
    (result.domainState as { preparedBrowserExecution: { browserDecision: { promptIntent?: { refined?: string } } } })
      .preparedBrowserExecution.browserDecision.promptIntent?.refined,
    '更具体的提示词',
  )
})

test('document domain adapter still handles deterministic format and rewrite flows after host shortcut cleanup', async () => {
  const calls: string[] = []
  const adapter = new DocumentDomainAdapter({
    orchestrator: {
      async tryDeterministicSectionFormatFlow() {
        calls.push('format')
        return true
      },
      async tryDeterministicSectionRewriteFlow() {
        calls.push('rewrite')
        return true
      },
    },
    toolLoopOrchestrator: {
      createState: () => ({ stepId: null }),
      applyToolInspection: (state: unknown) => state,
      handleNoToolCall: () => ({ state: { stepId: null } }),
      handleIterationResult: () => ({ state: { stepId: null } }),
      buildStructuredTaskPayload: () => ({}),
      getBudgetHint: () => null,
    },
  } as never)

  const baseParams = {
    route: createRoute('document'),
    request: {
      agentName: 'ready',
      sessionId: 'scope-doc',
      abortSignal: new AbortController().signal,
    },
    host: {
      browserController: null,
      sidecarManager: null,
      runtime: {
        getConversationScope: () => null,
      },
      requestModuleToolAction: async () => ({}),
      providerContext: {
        config: {},
        baseUrl: 'https://example.com/v1',
        provider: undefined,
        isKimi: false,
        isKimiCoding: false,
        useAnthropicProtocol: false,
      },
    },
    session: {
      messages: [],
    },
    userText: '把第一段排版一下',
    pureUserInput: '把第一段排版一下',
    requestEnvelope: {} as never,
    executionIntentContext: {
      hasDocumentEnvironment: true,
    } as never,
    hasTools: true,
    allowedToolNames: ['document_format_section', 'document_rewrite_section'],
    emitStructuredTaskPayload: () => undefined,
    domainState: {
      toolLoopState: { stepId: null },
      taskTitle: '文档修改',
    },
  } as const

  const formatResult = await adapter.dispatch({
    ...baseParams,
    toolPolicy: {
      forceDocumentTool: true,
      preferFormatOnly: true,
      preferSectionRewrite: false,
      documentWidgetTaskKind: null,
    } as never,
  } as never)

  const rewriteResult = await adapter.dispatch({
    ...baseParams,
    toolPolicy: {
      forceDocumentTool: true,
      preferFormatOnly: false,
      preferSectionRewrite: true,
      documentWidgetTaskKind: null,
    } as never,
    userText: '把这一节改写成更正式的版本',
    pureUserInput: '把这一节改写成更正式的版本',
  } as never)

  assert.deepEqual(calls, ['format', 'rewrite'])
  assert.equal(formatResult.finish?.success, true)
  assert.equal(rewriteResult.finish?.success, true)
})

test('document domain adapter dispatches structured widget pipeline through the extracted executor without host shortcuts', async () => {
  const adapter = new DocumentDomainAdapter({
    orchestrator: {
      async tryDeterministicSectionFormatFlow() {
        return false
      },
      async tryDeterministicSectionRewriteFlow() {
        return false
      },
    },
    toolLoopOrchestrator: {
      createState: () => ({ stepId: null }),
      applyToolInspection: (state: unknown) => state,
      handleNoToolCall: () => ({ state: { stepId: null } }),
      handleIterationResult: () => ({ state: { stepId: null } }),
      buildStructuredTaskPayload: () => ({}),
      getBudgetHint: () => null,
    },
    pipelineExecutor: {
      async tryExecute() {
        return {
          handled: true,
          result: {
            domainState: {
              toolLoopState: { stepId: null },
              taskTitle: '文档组件操作',
            },
            finalText: '已更新现有信息卡',
            finish: {
              status: 'done',
              success: true,
            },
          },
        }
      },
    },
  } as never)

  const result = await adapter.dispatch({
    route: createRoute('document'),
    request: {
      agentName: 'ready',
      sessionId: 'scope-doc',
      runId: 'run-doc',
      taskId: 'task-doc',
      abortSignal: new AbortController().signal,
      emitters: {
        emitOutput: () => undefined,
        emitStatus: () => undefined,
        emitRuntimeError: () => undefined,
        emitToolAction: () => undefined,
      },
    },
    host: {
      browserController: null,
      sidecarManager: null,
      runtime: {
        getConversationScope: () => null,
      },
      requestModuleToolAction: async () => ({}),
      providerContext: {
        config: {},
        baseUrl: 'https://example.com/v1',
        provider: undefined,
        isKimi: false,
        isKimiCoding: false,
        useAnthropicProtocol: false,
      },
    },
    session: {
      messages: [],
    },
    userText: '把这个信息卡改成极简风格',
    pureUserInput: '把这个信息卡改成极简风格',
    requestEnvelope: {} as never,
    executionIntentContext: {
      hasDocumentEnvironment: true,
      structuredDocumentIntent: 'document_read_then_widget_update',
      userInstructionText: '把这个信息卡改成极简风格',
    } as never,
    hasTools: true,
    toolPolicy: {
      forceDocumentTool: true,
      preferFormatOnly: false,
      preferSectionRewrite: false,
      documentWidgetTaskKind: 'update',
    } as never,
    allowedToolNames: ['document_list_widgets', 'document_update_widget'],
    emitStructuredTaskPayload: () => undefined,
    domainState: {
      toolLoopState: { stepId: null },
      taskTitle: '文档组件操作',
    },
  } as never)

  assert.equal(result.finish?.success, true)
  assert.equal(result.finalText, '已更新现有信息卡')
})

test('skill domain adapter reuses the latest structured skill patch when the turn stops before a new tool result arrives', () => {
  const adapter = new SkillDomainAdapter()
  const prepared = adapter.prepare({
    route: createRoute('skill'),
    allowedToolNames: ['skill_get_state'],
    hasTools: true,
    userText: '继续 skill workflow',
    executionIntentContext: {} as never,
  } as never)

  const toolBatchResult = adapter.applyResult({
    ...createAdapterApplyParams('skill'),
    domainState: prepared.domainState,
    phase: 'tool_batch',
    toolBatch: {
      executedTools: [
        {
          id: 'tool-1',
          name: 'skill_get_state',
          input: {},
          result: createToolExecutionOutput('请选择视频风格', {
            projectionPatch: {
              module: 'skill',
              taskTitle: '技能执行 · video-copy-analyzer',
              taskSummary: '请选择视频风格',
              steps: [
                {
                  id: 'collect_input',
                  title: 'collect_input',
                  status: 'blocked',
                  updatedAt: '2026-04-18T00:00:00.000Z',
                },
              ],
              currentStepId: 'collect_input',
              waitingFor: 'input',
              resumableActions: ['continue', 'cancel'],
              blockedReason: '请选择视频风格',
              taskContinuation: {
                executionId: 'exec-1',
                stepId: 'collect_input',
                blockerType: 'need_input',
              },
            },
            interactionHint: 'awaiting_clarification',
          }),
        },
      ],
    } as never,
  } as never)

  const limitResult = adapter.applyResult({
    ...createAdapterApplyParams('skill'),
    domainState: toolBatchResult.domainState,
    phase: 'budget_limit',
  } as never)

  const patch = adapter.buildProjectionPatch({
    route: createRoute('skill'),
    request: {} as never,
    executionIntentContext: {} as never,
    toolPolicy: {} as never,
    domainState: limitResult.domainState,
    projection: limitResult.projection || null,
  } as never)

  assert.equal(patch?.taskTitle, '技能执行 · video-copy-analyzer')
  assert.equal(patch?.taskSummary, '请选择视频风格')
  assert.equal(patch?.currentStepId, 'collect_input')
  assert.equal(patch?.waitingFor, 'input')
  assert.deepEqual(patch?.resumableActions, ['continue', 'cancel'])
  assert.equal((patch?.taskContinuation as { executionId?: string } | undefined)?.executionId, 'exec-1')
})

test('rss, calendar, and feishu domain adapters mirror executed tools into structured task projection patches', () => {
  const cases = [
    {
      adapter: new RSSDomainAdapter(),
      executor: 'rss' as const,
      toolName: 'rss_fetch_updates',
      resultText: JSON.stringify({
        module: 'rss',
        action: 'rss.fetchUpdates',
        message: 'rss.fetchUpdates 已排队执行。',
      }),
      expectedModule: 'rss',
      expectedTitle: 'RSS 任务',
    },
    {
      adapter: new CalendarDomainAdapter(),
      executor: 'calendar' as const,
      toolName: 'calendar_create_event',
      resultText: JSON.stringify({
        module: 'calendar',
        action: 'calendar.createEvent',
        message: 'calendar.createEvent 已排队执行。',
      }),
      expectedModule: 'calendar',
      expectedTitle: '日程任务',
    },
    {
      adapter: new FeishuDomainAdapter(),
      executor: 'feishu' as const,
      toolName: 'feishu_message_send',
      resultText: JSON.stringify({
        module: 'feishu',
        action: 'feishu.messageSend',
        message: 'Success',
        message_id: 'om_123',
      }),
      expectedModule: 'feishu',
      expectedTitle: '飞书任务',
    },
  ]

  for (const item of cases) {
    const prepared = item.adapter.prepare({
      route: createRoute(item.executor),
      allowedToolNames: [item.toolName],
      hasTools: true,
      userText: `${item.executor} task`,
      executionIntentContext: {} as never,
    } as never)

    const applied = item.adapter.applyResult({
      ...createAdapterApplyParams(item.executor),
      domainState: prepared.domainState,
      phase: 'tool_batch',
      toolBatch: {
        executedTools: [
          {
            id: 'tool-1',
            name: item.toolName,
            input: item.executor === 'calendar' ? { title: '周会' } : {},
            result: createToolExecutionOutput(item.resultText),
          },
        ],
      } as never,
    } as never)

    assert.equal(
      applied.projection,
      undefined,
      `${item.executor} 不应在单次 tool_batch 后立即 finalize`,
    )

    const finalized = item.adapter.applyResult({
      ...createAdapterApplyParams(item.executor),
      domainState: applied.domainState,
      phase: 'no_tool_call',
      responseText: '',
    } as never)

    assert.ok(finalized.projection, `${item.executor} 应在 no_tool_call 时 finalize projection`)
    assert.equal(finalized.projection?.phase, 'done')

    const patch = item.adapter.buildProjectionPatch({
      route: createRoute(item.executor),
      request: {} as never,
      executionIntentContext: {} as never,
      toolPolicy: {} as never,
      domainState: finalized.domainState,
      projection: finalized.projection || null,
    } as never)

    assert.equal(patch?.module, item.expectedModule)
    assert.equal(patch?.taskTitle, item.expectedTitle)
    assert.equal(patch?.currentStepId, item.toolName)
    assert.equal(Array.isArray(patch?.steps), true)
    assert.equal((patch?.steps as Array<{ id: string; status: string }>)[0]?.id, item.toolName)
    assert.equal((patch?.steps as Array<{ id: string; status: string }>)[0]?.status, 'done')
    assert.match(String(patch?.taskSummary || ''), /已排队执行|Success/)
  }
})

test('rss, calendar, and feishu domain adapters defer finalization across multiple tool batches', () => {
  const cases = [
    {
      adapter: new RSSDomainAdapter(),
      executor: 'rss' as const,
      toolName: 'rss_fetch_updates',
      resultText: JSON.stringify({
        module: 'rss',
        action: 'rss.fetchUpdates',
        message: 'rss.fetchUpdates 已排队执行。',
      }),
    },
    {
      adapter: new CalendarDomainAdapter(),
      executor: 'calendar' as const,
      toolName: 'calendar_create_event',
      resultText: JSON.stringify({
        module: 'calendar',
        action: 'calendar.createEvent',
        message: 'calendar.createEvent 已排队执行。',
      }),
    },
    {
      adapter: new FeishuDomainAdapter(),
      executor: 'feishu' as const,
      toolName: 'feishu_message_send',
      resultText: JSON.stringify({
        module: 'feishu',
        action: 'feishu.messageSend',
        message: 'Success',
      }),
    },
  ]

  for (const item of cases) {
    const prepared = item.adapter.prepare({
      route: createRoute(item.executor),
      allowedToolNames: [item.toolName],
      hasTools: true,
      userText: `${item.executor} task`,
      executionIntentContext: {} as never,
    } as never)

    const firstBatch = item.adapter.applyResult({
      ...createAdapterApplyParams(item.executor),
      domainState: prepared.domainState,
      phase: 'tool_batch',
      toolBatch: {
        executedTools: [
          {
            id: 'tool-1',
            name: item.toolName,
            input: item.executor === 'calendar' ? { title: '周会一' } : {},
            result: createToolExecutionOutput(item.resultText),
          },
        ],
      } as never,
    } as never)

    assert.equal(firstBatch.projection, undefined, `${item.executor} 第一次 tool_batch 不应 finalize`)

    const secondBatch = item.adapter.applyResult({
      ...createAdapterApplyParams(item.executor),
      domainState: firstBatch.domainState,
      phase: 'tool_batch',
      toolBatch: {
        executedTools: [
          {
            id: 'tool-2',
            name: item.toolName,
            input: item.executor === 'calendar' ? { title: '周会二' } : {},
            result: createToolExecutionOutput(item.resultText),
          },
        ],
      } as never,
    } as never)

    assert.equal(secondBatch.projection, undefined, `${item.executor} 多步 tool_batch 不应 finalize`)
    assert.equal((secondBatch.domainState as { steps: Array<{ id: string }> }).steps.length, 2)
  }
})
