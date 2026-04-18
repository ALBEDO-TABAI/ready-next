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

function createDomainApplyParams(executor: 'skill' | 'rss' | 'calendar' | 'feishu', domainState: unknown, toolBatch: Record<string, unknown>) {
  return {
    route: createRoute(executor),
    request: {
      abortSignal: new AbortController().signal,
    } as never,
    host: {} as never,
    session: {
      messages: [],
    } as never,
    userText: '',
    pureUserInput: '',
    requestEnvelope: {} as never,
    executionIntentContext: {} as never,
    hasTools: true,
    toolPolicy: {} as never,
    allowedToolNames: null,
    emitStructuredTaskPayload: () => undefined,
    domainState,
    phase: 'tool_batch' as const,
    toolBatch,
  } as const
}

function createProjectionParams(
  executor: 'skill' | 'rss' | 'calendar' | 'feishu',
  domainState: unknown,
  projection: { phase: 'blocked' | 'done'; summary: string; waitingFor?: string; resumableActions?: string[]; blockedReason?: string | null },
) {
  return {
    route: createRoute(executor),
    request: {} as never,
    executionIntentContext: {} as never,
    toolPolicy: {} as never,
    domainState,
    projection,
  } as never
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

test('skill domain adapter turns structured skill tool results into adapter-owned projection truth', () => {
  const adapter = new SkillDomainAdapter()
  const prepared = adapter.prepare({
    route: createRoute('skill'),
    request: {
      abortSignal: new AbortController().signal,
    } as never,
    host: {} as never,
    session: {
      messages: [],
    } as never,
    userText: '继续 skill workflow',
    pureUserInput: '继续 skill workflow',
    requestEnvelope: {} as never,
    executionIntentContext: {} as never,
    hasTools: true,
    toolPolicy: {} as never,
    allowedToolNames: ['skill_get_state'],
  })
  const applied = adapter.applyResult(createDomainApplyParams('skill', prepared.domainState, {
    executedTools: [{
      toolName: 'skill_get_state',
      output: createToolExecutionOutput('请选择视频风格', {
        projectionPatch: {
          module: 'skill',
          message: '请选择视频风格',
          taskTitle: '技能执行 · video-copy-analyzer',
          taskSummary: '请选择视频风格',
          steps: [{
            id: 'collect_input',
            title: 'collect_input',
            status: 'blocked',
            updatedAt: '2026-04-18T12:00:00.000Z',
          }],
          currentStepId: 'collect_input',
          waitingFor: 'input',
          resumableActions: ['continue', 'cancel'],
          blockedReason: '请选择视频风格',
          taskContinuation: {
            executionId: 'exec-1',
            stepId: 'collect_input',
            blockerType: 'need_input',
          },
          recentArtifacts: [{
            id: 'artifact-1',
            module: 'skill',
            kind: 'skill-artifact',
            label: '风格提示',
            createdAt: '2026-04-18T12:00:00.000Z',
          }],
        },
        interactionHint: 'awaiting_clarification',
      }),
      resultText: '请选择视频风格',
      parsedJson: null,
    }],
  }))

  assert.equal(applied.interactionState, 'awaiting_clarification')
  assert.equal(applied.projection?.waitingFor, 'input')
  assert.equal(applied.projection?.summary, '请选择视频风格')

  const patch = adapter.buildProjectionPatch(createProjectionParams('skill', applied.domainState, applied.projection!))
  assert.equal(patch?.taskTitle, '技能执行 · video-copy-analyzer')
  assert.equal((patch?.taskContinuation as { executionId?: string } | undefined)?.executionId, 'exec-1')
  assert.equal(Array.isArray(patch?.recentArtifacts), true)
})

test('rss domain adapter builds a done projection from legacy json tool results', () => {
  const adapter = new RSSDomainAdapter()
  const prepared = adapter.prepare({
    route: createRoute('rss'),
    request: {
      abortSignal: new AbortController().signal,
    } as never,
    host: {} as never,
    session: {
      messages: [],
    } as never,
    userText: '添加一个 RSS 源',
    pureUserInput: '添加一个 RSS 源',
    requestEnvelope: {} as never,
    executionIntentContext: {} as never,
    hasTools: true,
    toolPolicy: {} as never,
    allowedToolNames: ['rss_add_source'],
  })
  const structured = {
    module: 'rss',
    intent: 'add_rss_source',
    executionKind: 'deterministic',
    action: 'rss.addSource',
    message: 'rss.addSource 已排队执行。',
    ownerResourceId: 'source-1',
  }
  const applied = adapter.applyResult(createDomainApplyParams('rss', prepared.domainState, {
    executedTools: [{
      toolName: 'rss_add_source',
      output: createToolExecutionOutput(JSON.stringify(structured)),
      resultText: JSON.stringify(structured),
      parsedJson: structured,
    }],
  }))

  assert.equal(applied.projection?.phase, 'done')
  assert.match(applied.projection?.summary || '', /source-1/)

  const patch = adapter.buildProjectionPatch(createProjectionParams('rss', applied.domainState, applied.projection!))
  assert.equal(patch?.taskTitle, 'RSS 任务')
  assert.equal((patch?.steps as Array<{ id: string; status: string }>)[0]?.id, 'rss_add_source')
  assert.equal((patch?.steps as Array<{ id: string; status: string }>)[0]?.status, 'done')
})

test('calendar domain adapter blocks when legacy tool results indicate missing user input', () => {
  const adapter = new CalendarDomainAdapter()
  const prepared = adapter.prepare({
    route: createRoute('calendar'),
    request: {
      abortSignal: new AbortController().signal,
    } as never,
    host: {} as never,
    session: {
      messages: [],
    } as never,
    userText: '创建一个会议',
    pureUserInput: '创建一个会议',
    requestEnvelope: {} as never,
    executionIntentContext: {} as never,
    hasTools: true,
    toolPolicy: {} as never,
    allowedToolNames: ['calendar_create_event'],
  })
  const applied = adapter.applyResult(createDomainApplyParams('calendar', prepared.domainState, {
    executedTools: [{
      toolName: 'calendar_create_event',
      output: createToolExecutionOutput('Error: title, startTime and endTime are required'),
      resultText: 'Error: title, startTime and endTime are required',
      parsedJson: null,
    }],
  }))

  assert.equal(applied.projection?.phase, 'blocked')
  assert.equal(applied.projection?.waitingFor, 'input')

  const patch = adapter.buildProjectionPatch(createProjectionParams('calendar', applied.domainState, applied.projection!))
  assert.equal(patch?.taskTitle, '日程任务')
  assert.equal(patch?.waitingFor, 'input')
  assert.match(String(patch?.blockedReason || ''), /required/)
})

test('feishu domain adapter summarizes legacy structured results with target identifiers', () => {
  const adapter = new FeishuDomainAdapter()
  const prepared = adapter.prepare({
    route: createRoute('feishu'),
    request: {
      abortSignal: new AbortController().signal,
    } as never,
    host: {} as never,
    session: {
      messages: [],
    } as never,
    userText: '把消息发到飞书',
    pureUserInput: '把消息发到飞书',
    requestEnvelope: {} as never,
    executionIntentContext: {} as never,
    hasTools: true,
    toolPolicy: {} as never,
    allowedToolNames: ['feishu_message_send'],
  })
  const structured = {
    module: 'feishu',
    intent: 'send_feishu_message',
    executionKind: 'deterministic',
    action: 'feishu.messageSend',
    message: 'Success',
    msg_id: 'om_dc13264520392913993dd051dba21dcf',
    chat_id: 'oc_a0553eda9014c201e6969b478895c230',
  }
  const applied = adapter.applyResult(createDomainApplyParams('feishu', prepared.domainState, {
    executedTools: [{
      toolName: 'feishu_message_send',
      output: createToolExecutionOutput(JSON.stringify(structured)),
      resultText: JSON.stringify(structured),
      parsedJson: structured,
    }],
  }))

  assert.equal(applied.projection?.phase, 'done')
  assert.match(applied.projection?.summary || '', /om_dc13264520392913993dd051dba21dcf/)

  const patch = adapter.buildProjectionPatch(createProjectionParams('feishu', applied.domainState, applied.projection!))
  assert.equal(patch?.taskTitle, '飞书任务')
  assert.equal((patch?.steps as Array<{ id: string; status: string }>)[0]?.status, 'done')
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
