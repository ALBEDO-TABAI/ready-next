import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRequestEnvelope } from '../main/modules/agent-control/request-envelope'
import { TurnEngine } from '../main/modules/agent-control/turn-engine'
import type { IntentClassification } from '../main/modules/agent-control/intent-classifier'
import type { DomainAdapter } from '../main/modules/agent-control/domain-adapter'
import type { RunBudgetSeed, RunBudgetUsage, TurnEngineRequest, TurnEngineSession, TurnTranscriptEvent } from '../main/modules/agent-control/run-contracts'

function createSession(userText: string): TurnEngineSession {
  return {
    messages: [{ role: 'user', content: userText }],
    abortController: null,
    systemPrompt: 'system',
    generation: 1,
    activeRunId: 'run-test',
    preferTextToolBridge: false,
    lastDocumentContextInput: null,
  }
}

function createIntent(overrides?: Partial<IntentClassification>): IntentClassification {
  return {
    primaryDomain: 'generic',
    mentionedDomains: [],
    excludedDomains: [],
    objectSignals: [],
    actionSignals: [],
    crossDomain: false,
    confidence: 'low',
    ...overrides,
  }
}

function createEvents() {
  const events: TurnTranscriptEvent[] = []
  return {
    events,
    emitters: {
      emitOutput: (chunk: string, type: string) => {
        events.push({ kind: 'output', type, chunk })
      },
      emitStatus: (status: string) => {
        events.push({ kind: 'status', status })
      },
      emitRuntimeError: (error: string) => {
        events.push({ kind: 'error', error })
      },
      emitToolAction: (tool: string, args: Record<string, unknown>) => {
        events.push({ kind: 'tool_action', tool, args })
      },
    },
  }
}

function createHost(overrides?: Record<string, unknown>) {
  return {
    log: () => {},
    maxToolIterations: 8,
    browserController: null,
    sidecarManager: null,
    runtime: {
      isChannelTypeAvailable: () => false,
      getConversationScope: () => null,
    },
    requestModuleToolAction: undefined,
    registerRunCleanup: () => {},
    providerContext: {
      config: {
        provider: 'openai',
        model: 'gpt-test',
        apiKey: 'test',
        baseUrl: 'https://api.openai.com/v1',
      },
      baseUrl: 'https://api.openai.com/v1',
      provider: undefined,
      isKimi: false,
      isKimiCoding: false,
      useAnthropicProtocol: false,
      supportsToolCalls: false,
      supportsVideoBlock: true,
      hasRawVideoInIncoming: false,
    },
    isBrowserAgentV3Enabled: () => false,
    resolveContinuationProjection: () => null,
    getIncomingAttachmentHints: () => ({ count: 0 }),
    collectRecentPureUserInputs: () => [],
    sessionHasMediaInputs: () => false,
    sessionHasVideoInputs: () => false,
    maybeRunDocumentTaskPlan: async () => null,
    maybeRunDocumentWidgetPipeline: async () => null,
    domainAdapters: [] as DomainAdapter[],
    skillContextOrchestrator: {
      shouldKeepToolsWithVideo: () => false,
      findExplicitlyRequestedSkills: () => [],
      hasActiveSkillExecution: () => false,
      buildPreferredSkillToolNames: () => null,
      maybeInjectExplicitSkillContext: async () => {},
    },
    browserDomainOrchestrator: {
      prepareBrowserExecution: async () => ({
        browserDecision: { mode: 'free_tool_loop', reason: 'browser_disabled' },
        browserContinuityInstruction: null,
        clarifyText: null,
        canUseDeterministicBrowserRunner: false,
        shouldInspectAmbiguousModeEntry: false,
      }),
      resolveExecutionDispatch: () => ({
        kind: 'none',
        continuityInstruction: null,
        responseText: null,
        toolLoopMessage: null,
        fallbackLog: null,
      }),
      runDeterministicExecution: async () => ({
        handled: false,
        state: 'done',
        message: '',
      }),
      createToolLoopState: () => ({ isBrowserTask: false, steps: [], stepIndex: 0 }),
      recordToolLoopProgress: ({ state }: { state: unknown }) => ({
        state,
        advancedStepIndex: null,
        checkpointMessage: null,
      }),
      buildToolLoopLimitMessage: () => null,
      getBudgetHint: () => null,
      getRecommendedToolLoopIterations: (_userText: string, _decision: unknown, base: number) => base,
    },
    documentToolLoopOrchestrator: {
      createState: () => ({}),
      getBudgetHint: () => null,
      handleNoToolCall: ({ state }: { state: unknown }) => ({
        state,
        nextUserMessage: null,
        finalText: null,
        preserveAssistantText: false,
      }),
      applyToolInspection: (state: unknown) => state,
      handleIterationResult: ({ state }: { state: unknown }) => ({
        state,
        nextUserMessage: null,
        completionText: null,
      }),
      buildStructuredTaskPayload: (payload: Record<string, unknown>) => payload,
    },
    designToolLoopOrchestrator: {
      createState: () => ({ primaryArtifactProduced: false }),
      getBudgetHint: () => null,
      filterToolCalls: ({ toolCalls }: { toolCalls: unknown[] }) => ({
        toolCalls,
        droppedCount: 0,
        nextUserMessage: null,
      }),
      applySourceInput: (toolCall: unknown) => toolCall,
      recordToolResult: ({ state }: { state: Record<string, unknown> }) => ({
        state,
        isPrimaryArtifact: false,
      }),
      buildCompletionText: () => null,
      buildStructuredTaskPayload: (payload: Record<string, unknown>) => payload,
    },
    hostCapabilityDispatcher: {
      dispatch: async () => ({ handled: false }),
    },
    executeToolCall: async () => ({ text: 'ok' }),
    requestSimpleText: async () => ({ text: 'simple result' }),
    requestToolLoopResponse: async () => ({
      text: 'tool loop result',
      toolCalls: [],
      stopReason: 'stop',
    }),
    executeToolBatch: async () => ({
      results: [],
      budgetLimited: false,
      recoveryHistory: [],
    }),
    ...overrides,
  }
}

function createRequest(params: {
  userText: string
  host?: Record<string, unknown>
  intentClassification?: IntentClassification
  budget?: RunBudgetSeed
  budgetState?: RunBudgetUsage
  taskBudgetRuntime?: TurnEngineRequest['taskBudgetRuntime']
}) {
  const events = createEvents()
  const request: TurnEngineRequest = {
    runId: 'run-test',
    taskId: 'task-test',
    agentName: 'agent-test',
    sessionId: 'scope-test',
    session: createSession(params.userText),
    content: params.userText,
    requestEnvelope: buildRequestEnvelope({ userText: params.userText }),
    intentClassification: params.intentClassification,
    budget: params.budget,
    budgetState: params.budgetState,
    taskBudgetRuntime: params.taskBudgetRuntime || null,
    abortSignal: new AbortController().signal,
    ensureNotAborted: () => {},
    emitters: events.emitters,
    host: createHost(params.host),
  }
  return { request, events: events.events }
}

test('TurnEngine uses the direct simple-response path for non-tool runs', async () => {
  const engine = new TurnEngine()
  const { request, events } = createRequest({
    userText: '解释一下这个概念',
  })

  const result = await engine.execute(request)

  assert.equal(result.success, true)
  assert.equal(result.cancelled, false)
  assert.equal(result.finalText, 'simple result')
  assert.deepEqual(result.usedTools, [])
  assert.equal(result.taskProjectionId, 'task-test')
  assert.equal(events.filter((event) => event.kind === 'output' && event.type === 'text').length, 1)
})

test('TurnEngine short-circuits browser deterministic work before the model tool loop', async () => {
  const engine = new TurnEngine()
  let deterministicRuns = 0
  let simpleRequests = 0
  const browserAdapter: DomainAdapter = {
    id: 'browser',
    shouldHandle: () => true,
    prepare: () => ({ allowedToolNames: null, sessionMessages: [], domainState: { mode: 'deterministic' } }),
    dispatch: async () => {
      deterministicRuns += 1
      return {
        domainState: { mode: 'done' },
        finalText: 'browser deterministic result',
        finish: { status: 'done', success: true },
      }
    },
    applyResult: () => ({ domainState: null }),
    buildProjectionPatch: () => null,
  }
  const { request } = createRequest({
    userText: '打开网页并点击发送',
    intentClassification: createIntent({
      primaryDomain: 'browser',
      mentionedDomains: ['browser'],
      objectSignals: ['browser-object'],
      actionSignals: ['browser-action'],
      confidence: 'high',
    }),
    host: {
      browserController: {},
      providerContext: {
        config: {
          provider: 'openai',
          model: 'gpt-test',
          apiKey: 'test',
          baseUrl: 'https://api.openai.com/v1',
        },
        baseUrl: 'https://api.openai.com/v1',
        provider: undefined,
        isKimi: false,
        isKimiCoding: false,
        useAnthropicProtocol: false,
        supportsToolCalls: true,
        supportsVideoBlock: true,
        hasRawVideoInIncoming: false,
      },
      domainAdapters: [browserAdapter],
      requestSimpleText: async () => {
        simpleRequests += 1
        return { text: 'should not be used' }
      },
    },
  })

  const result = await engine.execute(request)

  assert.equal(result.finalText, 'browser deterministic result')
  assert.equal(deterministicRuns, 1)
  assert.equal(simpleRequests, 0)
})

test('TurnEngine keeps browser process narration out of final text when the browser adapter finalizes the answer', async () => {
  const engine = new TurnEngine()
  let loopPasses = 0
  const browserAdapter: DomainAdapter = {
    id: 'browser',
    shouldHandle: ({ route }) => route.executor === 'browser',
    prepare: () => ({
      allowedToolNames: ['browser_read_page'],
      sessionMessages: [],
      domainState: {
        evidence: [] as string[],
      },
    }),
    dispatch: async ({ domainState }) => ({ domainState }),
    applyResult: ({ phase, domainState, toolBatch }) => {
      if (phase === 'tool_batch') {
        return {
          domainState: {
            evidence: (toolBatch?.browserToolResultsThisIteration || []).map((item) => item.resultText),
          },
          projection: { phase: 'blocked', summary: '已读取网页结果，正在整理最终答复' },
        }
      }
      if (phase === 'no_tool_call') {
        return {
          domainState,
          finalText: '广州明天雷阵雨转多云，28/24℃。',
          projection: { phase: 'done', summary: '已完成网页查询' },
        }
      }
      return { domainState }
    },
    buildProjectionPatch: ({ projection }) => ({
      module: 'browser',
      message: projection.summary,
      taskTitle: '最新信息查询',
      taskSummary: projection.summary,
      steps: [
        {
          id: 'resolve_target_page',
          title: '确认目标页',
          status: projection.phase === 'done' ? 'done' : 'running',
          updatedAt: '2026-04-17T11:30:00.000Z',
        },
      ],
      currentStepId: 'resolve_target_page',
      waitingFor: 'none',
      resumableActions: projection.phase === 'done' ? ['none'] : ['cancel'],
      blockedReason: null,
    }),
  }
  const { request, events } = createRequest({
    userText: '明天广州天气怎么样',
    intentClassification: createIntent({
      primaryDomain: 'browser',
      mentionedDomains: ['browser'],
      objectSignals: ['browser-object'],
      actionSignals: ['browser-action'],
      confidence: 'high',
    }),
    host: {
      browserController: {},
      providerContext: {
        config: {
          provider: 'openai',
          model: 'gpt-test',
          apiKey: 'test',
          baseUrl: 'https://api.openai.com/v1',
        },
        baseUrl: 'https://api.openai.com/v1',
        provider: undefined,
        isKimi: false,
        isKimiCoding: false,
        useAnthropicProtocol: false,
        supportsToolCalls: true,
        supportsVideoBlock: true,
        hasRawVideoInIncoming: false,
      },
      domainAdapters: [browserAdapter],
      requestToolLoopResponse: async () => {
        loopPasses += 1
        if (loopPasses === 1) {
          return {
            text: '第 1 步：先读取页面确认天气信息。',
            toolCalls: [
              {
                id: 'call-1',
                name: 'browser_read_page',
                input: {},
              },
            ],
            stopReason: 'tool_calls',
            toolTransport: 'native',
          }
        }
        return {
          text: '收到。后续我会直接按文本桥接格式调用真实工具，不再重复说“没有工具”。',
          toolCalls: [],
          stopReason: 'stop',
          toolTransport: 'native',
        }
      },
      executeToolBatch: async () => ({
        results: [
          {
            id: 'call-1',
            name: 'browser_read_page',
            input: {},
            result: {
              text: '18日（明天）雷阵雨转多云 28/24℃ <3级',
            },
          },
        ],
        budgetLimited: false,
        recoveryHistory: [],
      }),
    },
  })

  const result = await engine.execute(request)

  assert.equal(result.finalText, '广州明天雷阵雨转多云，28/24℃。')
  assert.deepEqual(
    events
      .filter((event) => event.kind === 'output' && event.type === 'text')
      .map((event) => event.chunk),
    ['广州明天雷阵雨转多云，28/24℃。'],
  )
})

test('TurnEngine lets a domain adapter block once and then finish a document tool loop', async () => {
  const engine = new TurnEngine()
  let toolLoopRequests = 0
  const phases: string[] = []
  const documentAdapter: DomainAdapter = {
    id: 'document',
    shouldHandle: ({ route }) => route.executor === 'document',
    prepare: () => ({ allowedToolNames: ['document_replace_text'], sessionMessages: [], domainState: { nudged: false } }),
    dispatch: async () => ({ domainState: { nudged: false } }),
    applyResult: ({ phase, domainState }) => {
      phases.push(phase)
      if (phase !== 'no_tool_call') {
        return { domainState }
      }
      if (!(domainState as { nudged?: boolean }).nudged) {
        return {
          domainState: { nudged: true },
          nextUserMessage: '系统检查：请继续执行真实文档修改。',
          projection: { phase: 'blocked', summary: '系统检查：请继续执行真实文档修改。' },
        }
      }
      return {
        domainState,
        finalText: '文档任务已完成',
        projection: { phase: 'done', summary: '文档任务已完成' },
      }
    },
    buildProjectionPatch: ({ projection }) => ({
      module: 'document',
      message: projection.summary,
      taskTitle: '文档修改',
      taskSummary: projection.summary,
      steps: [{
        id: 'execute',
        title: '文档修改',
        status: projection.phase === 'done' ? 'done' : 'blocked',
        updatedAt: '2026-04-17T00:00:00.000Z',
      }],
      currentStepId: 'execute',
      waitingFor: 'none',
      resumableActions: projection.phase === 'done' ? ['cancel'] : ['retry', 'cancel'],
      blockedReason: projection.phase === 'blocked' ? projection.summary : null,
    }),
  }
  const { request, events } = createRequest({
    userText: '帮我修改这段文档',
    intentClassification: createIntent({
      primaryDomain: 'document',
      mentionedDomains: ['document'],
      objectSignals: ['document-object'],
      actionSignals: ['document-action'],
      confidence: 'high',
    }),
    host: {
      providerContext: {
        config: {
          provider: 'openai',
          model: 'gpt-test',
          apiKey: 'test',
          baseUrl: 'https://api.openai.com/v1',
        },
        baseUrl: 'https://api.openai.com/v1',
        provider: undefined,
        isKimi: false,
        isKimiCoding: false,
        useAnthropicProtocol: false,
        supportsToolCalls: true,
        supportsVideoBlock: true,
        hasRawVideoInIncoming: false,
      },
      domainAdapters: [documentAdapter],
      requestToolLoopResponse: async () => {
        toolLoopRequests += 1
        return {
          text: `document response ${toolLoopRequests}`,
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    },
  })

  const result = await engine.execute(request)

  assert.equal(toolLoopRequests, 2)
  assert.equal(result.finalText, '文档任务已完成')
  assert.deepEqual(phases, ['no_tool_call', 'no_tool_call'])
  assert.equal(
    events.some((event) => event.kind === 'output' && /文档任务已完成/.test(String(event.chunk || ''))),
    true,
  )
})

test('TurnEngine short-circuits host shortcuts and returns their output text', async () => {
  const engine = new TurnEngine()
  let hostDispatches = 0
  const { request } = createRequest({
    userText: '查一下之前记住的偏好',
    host: {
      providerContext: {
        config: {
          provider: 'openai',
          model: 'gpt-test',
          apiKey: 'test',
          baseUrl: 'https://api.openai.com/v1',
        },
        baseUrl: 'https://api.openai.com/v1',
        provider: undefined,
        isKimi: false,
        isKimiCoding: false,
        useAnthropicProtocol: false,
        supportsToolCalls: true,
        supportsVideoBlock: true,
        hasRawVideoInIncoming: false,
      },
      hostCapabilityDispatcher: {
        dispatch: async () => {
          hostDispatches += 1
          return {
            handled: true,
            toolUseText: 'memory_search({"query":"偏好"})',
            outputText: '找到了相关偏好',
          }
        },
      },
    },
  })

  const result = await engine.execute(request)

  assert.equal(hostDispatches, 1)
  assert.equal(result.finalText, '找到了相关偏好')
})

test('TurnEngine restores continuation budgets before running the resumed turn', async () => {
  const engine = new TurnEngine()
  const { request } = createRequest({
    userText: '继续上次的任务',
    host: {
      resolveContinuationProjection: () => ({
        taskId: 'task-prev',
        scopeId: 'scope-test',
        runId: 'run-prev',
        taskType: 'short_task',
        module: 'system',
        status: 'blocked',
        interactionState: 'awaiting_confirmation',
        steps: [
          { id: 'step-1', description: '继续执行', title: '继续执行', status: 'running' },
        ],
        budget: {
          taskType: 'short_task',
          maxIterations: 12,
          maxToolCalls: 6,
          maxParallelToolGroups: 2,
          iterationsUsed: 3,
          toolCallsUsed: 1,
          parallelToolGroupsUsed: 0,
          stepBudget: {
            stepId: 'step-1',
            maxIterations: 4,
            remainingIterations: 2,
          },
        },
        budgetUsagePercent: 30,
        resumableActions: ['continue'],
        continuationRef: {
          taskId: 'task-prev',
          executionId: 'exec-prev',
          stepId: 'step-1',
          blockerType: 'need_confirmation',
        },
        recentArtifacts: [],
        createdAt: '2026-04-17T00:00:00.000Z',
        updatedAt: '2026-04-17T00:00:00.000Z',
      }),
    },
  })

  const result = await engine.execute(request)

  assert.equal(result.taskType, 'continuation')
  assert.equal(result.interactionState, 'resuming')
  assert.equal(result.executionDiagnostics?.continuationBudgetRestore?.inheritedBudget, true)
  assert.equal(result.executionDiagnostics?.taskBudgetRuntime?.budget.maxIterations, 12)
  assert.equal(result.executionDiagnostics?.taskBudgetRuntime?.usage.iterationsUsed, 3)
})

test('TurnEngine prefers the provided continuation state over legacy prompt-based continuation lookup', async () => {
  const engine = new TurnEngine()
  const { request } = createRequest({
    userText: '继续当前任务',
    host: {
      resolveContinuationProjection: () => {
        throw new Error('legacy continuation lookup should not run when continuationState is already provided')
      },
    },
  })

  ;(request as unknown as {
    continuationState?: Record<string, unknown>
  }).continuationState = {
    taskId: 'task-prev',
    scopeId: 'scope-test',
    runId: 'run-prev',
    module: 'system',
    taskType: 'short_task',
    interactionState: 'awaiting_confirmation',
    steps: [
      {
        id: 'approve',
        title: '确认继续执行',
        description: '等待确认',
        status: 'running',
        updatedAt: '2026-04-17T00:00:00.000Z',
      },
    ],
    currentStepId: 'approve',
    blockedReason: '等待确认',
    resumableActions: ['continue', 'cancel'],
    continuationRef: {
      taskId: 'task-prev',
      executionId: 'exec-prev',
      stepId: 'approve',
      blockerType: 'need_confirmation',
    },
    budget: {
      taskType: 'short_task',
      maxIterations: 12,
      maxToolCalls: 6,
      maxParallelToolGroups: 2,
      iterationsUsed: 3,
      toolCallsUsed: 1,
      parallelToolGroupsUsed: 0,
      stepBudget: {
        stepId: 'approve',
        maxIterations: 4,
        remainingIterations: 2,
      },
    },
  }

  const result = await engine.execute(request)

  assert.equal(result.taskType, 'continuation')
  assert.equal(result.executionDiagnostics?.taskBudgetRuntime?.usage.iterationsUsed, 3)
})

test('TurnEngine legacy continuation lookup uses requestEnvelope user text and does not inject control prompt lines back into session history', async () => {
  const engine = new TurnEngine()
  let capturedUserText = ''
  let capturedExplicitTaskId: string | null | undefined
  const { request } = createRequest({
    userText: '## L1 会话上下文\n- 已注入上下文\n\n继续当前任务',
    host: {
      resolveContinuationProjection: (_sessionId: string | undefined, userText: string, options?: { explicitTaskId?: string | null }) => {
        capturedUserText = userText
        capturedExplicitTaskId = options?.explicitTaskId
        return {
          taskId: 'task-prev',
          scopeId: 'scope-test',
          runId: 'run-prev',
          taskType: 'short_task',
          module: 'system',
          status: 'blocked',
          interactionState: 'awaiting_confirmation',
          steps: [
            { id: 'step-1', description: '继续执行', title: '继续执行', status: 'running' },
          ],
          budget: {
            taskType: 'short_task',
            maxIterations: 12,
            maxToolCalls: 6,
            maxParallelToolGroups: 2,
            iterationsUsed: 3,
            toolCallsUsed: 1,
            parallelToolGroupsUsed: 0,
            stepBudget: {
              stepId: 'step-1',
              maxIterations: 4,
              remainingIterations: 2,
            },
          },
          budgetUsagePercent: 30,
          resumableActions: ['continue'],
          continuationRef: {
            taskId: 'task-prev',
            executionId: 'exec-prev',
            stepId: 'step-1',
            blockerType: 'need_confirmation',
          },
          recentArtifacts: [],
          createdAt: '2026-04-17T00:00:00.000Z',
          updatedAt: '2026-04-17T00:00:00.000Z',
        }
      },
    },
  })
  request.requestEnvelope = buildRequestEnvelope({
    userText: [
      'Task ID: task-prev',
      '继续当前任务',
    ].join('\n'),
  })

  const result = await engine.execute(request)

  assert.equal(result.taskType, 'continuation')
  assert.equal(capturedExplicitTaskId, 'task-prev')
  assert.equal(capturedUserText.includes('## L1 会话上下文'), false)
  assert.equal(
    request.session.messages.some((message) =>
      message.role === 'user' && /Task ID:|Execution ID:|Step ID:|继续前上下文：/.test(String(message.content))
    ),
    false,
  )
})

test('TurnEngine enters the model tool-loop path when route and capability policy allow tools', async () => {
  const engine = new TurnEngine()
  let toolLoopRequests = 0
  const { request } = createRequest({
    userText: '帮我修改这段文档',
    intentClassification: createIntent({
      primaryDomain: 'document',
      mentionedDomains: ['document'],
      objectSignals: ['document-object'],
      actionSignals: ['document-action'],
      confidence: 'high',
    }),
    host: {
      providerContext: {
        config: {
          provider: 'openai',
          model: 'gpt-test',
          apiKey: 'test',
          baseUrl: 'https://api.openai.com/v1',
        },
        baseUrl: 'https://api.openai.com/v1',
        provider: undefined,
        isKimi: false,
        isKimiCoding: false,
        useAnthropicProtocol: false,
        supportsToolCalls: true,
        supportsVideoBlock: true,
        hasRawVideoInIncoming: false,
      },
      requestToolLoopResponse: async () => {
        toolLoopRequests += 1
        return {
          text: 'tool loop finished',
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    },
  })

  const result = await engine.execute(request)

  assert.equal(toolLoopRequests, 1)
  assert.equal(result.finalText, 'tool loop finished')
})
