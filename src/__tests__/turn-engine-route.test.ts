import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRequestEnvelope } from '../main/modules/agent-control/request-envelope'
import { TurnEngine } from '../main/modules/agent-control/turn-engine'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import {
  rememberLastReferenceSkill,
  _resetLastReferenceSkillHintsForTests,
} from '../main/modules/agent-control/skill-reference-hints'
import { defaultToolRegistry } from '../main/modules/agent-control/tool-registry'
import type { IntentClassification } from '../main/modules/agent-control/intent-classifier'
import type { DomainAdapter } from '../main/modules/agent-control/domain-adapter'
import type { RunBudgetSeed, RunBudgetUsage, TurnEngineRequest, TurnEngineSession, TurnTranscriptEvent } from '../main/modules/agent-control/run-contracts'
import type { ToolDefinition } from '../main/modules/agent-control/tool-definition'

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
      emitOutput: (
        chunk: string,
        type: string,
        options?: { projectionPatch?: Record<string, unknown> | null },
      ) => {
        events.push({ kind: 'output', type, chunk, projectionPatch: options?.projectionPatch || null } as TurnTranscriptEvent)
      },
      emitStatus: (status: string) => {
        events.push({ kind: 'status', status })
      },
      emitRuntimeError: (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        events.push({ kind: 'error', error: message })
      },
      emitToolAction: (tool: string, args: Record<string, unknown>) => {
        events.push({ kind: 'tool_action', tool, args })
      },
    },
  }
}

function installLongSkillToolDefinitionForTest(toolName = 'skill_video_expert_pipeline'): () => void {
  const registry = defaultToolRegistry as unknown as {
    getToolDefinitionForExecution: (name: string) => ToolDefinition | null
  }
  const original = registry.getToolDefinitionForExecution.bind(defaultToolRegistry)
  registry.getToolDefinitionForExecution = (name: string): ToolDefinition | null => {
    const base = original(name)
    if (name !== toolName) return base
    return {
      ...(base || {
        name,
        groupId: 'skills',
        domain: 'skill',
        kind: 'interactive',
        concurrency: 'serialized',
        interruptBehavior: 'host_managed',
        timeoutProfile: 'skill',
        supportsTextBridge: true,
        projectionHint: { emitsProjectionPatch: true },
        description: name,
        schema: null,
        resultShape: 'projection_patch',
      }),
      executionTimeoutMs: 30 * 60 * 1000,
      requiresExplicitAllowlist: true,
    }
  }
  return () => {
    registry.getToolDefinitionForExecution = original
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

test('TurnEngine records tool snapshots and clears browser text-bridge nudges after one request', async () => {
  const engine = new TurnEngine()
  const preferTextBridgeFlags: boolean[] = []
  let noToolCallPasses = 0
  const browserAdapter: DomainAdapter = {
    id: 'browser',
    shouldHandle: () => true,
    prepare: () => ({
      allowedToolNames: ['browser_search', 'browser_read_page'],
      sessionMessages: [],
      domainState: {
        preparedBrowserExecution: {
          browserDecision: {
            mode: 'browser_upload_workflow',
          },
        },
        browserToolLoopState: {
          isBrowserTask: true,
        },
      },
    }),
    dispatch: async ({ domainState }) => ({ domainState }),
    applyResult: ({ phase, domainState }) => {
      if (phase !== 'no_tool_call') {
        return { domainState }
      }
      noToolCallPasses += 1
      if (noToolCallPasses < 3) {
        return {
          domainState,
          nextUserMessage: `继续第 ${noToolCallPasses} 轮`,
        }
      }
      return {
        domainState,
        finalText: '浏览器任务已完成',
      }
    },
    buildProjectionPatch: () => null,
  }

  const { request } = createRequest({
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
          provider: 'openai-compatible',
          model: 'gpt-test',
          apiKey: 'test',
          baseUrl: 'https://example.com/v1',
        },
        baseUrl: 'https://example.com/v1',
        provider: undefined,
        isKimi: false,
        isKimiCoding: false,
        useAnthropicProtocol: false,
        supportsToolCalls: true,
        supportsVideoBlock: true,
        hasRawVideoInIncoming: false,
      },
      domainAdapters: [browserAdapter],
      requestToolLoopResponse: async (params: { preferTextToolBridgeOnce?: boolean }) => {
        preferTextBridgeFlags.push(Boolean(params.preferTextToolBridgeOnce))
        const toolSnapshots = [
          {
            stage: 'provider_request',
            source: 'provider',
            iteration: preferTextBridgeFlags.length,
            provider: 'openai-compatible',
            baseUrl: 'https://example.com/v1',
            model: 'gpt-test',
            wireApi: 'chat/completions',
            browserDecisionMode: 'browser_search_sequence',
            browserHostAvailable: true,
            hasTools: true,
            allowBrowserTools: true,
            visibleCapabilityGroupIds: ['browser_interaction'],
            suppressedCapabilityGroupIds: [],
            allowedToolNames: ['browser_search', 'browser_read_page'],
            requestedTransport: Boolean(params.preferTextToolBridgeOnce) ? 'text' : 'native',
            effectiveTransport: Boolean(params.preferTextToolBridgeOnce) ? 'text' : 'native',
            supportsNativeTools: true,
            preferTextToolBridge: Boolean(params.preferTextToolBridgeOnce),
            fallbackReason: null,
            toolCallsCount: 0,
          },
          {
            stage: 'provider_response',
            source: 'provider',
            iteration: preferTextBridgeFlags.length,
            provider: 'openai-compatible',
            baseUrl: 'https://example.com/v1',
            model: 'gpt-test',
            wireApi: 'chat/completions',
            browserDecisionMode: 'browser_search_sequence',
            browserHostAvailable: true,
            hasTools: true,
            allowBrowserTools: true,
            visibleCapabilityGroupIds: ['browser_interaction'],
            suppressedCapabilityGroupIds: [],
            allowedToolNames: ['browser_search', 'browser_read_page'],
            requestedTransport: Boolean(params.preferTextToolBridgeOnce) ? 'text' : 'native',
            effectiveTransport: 'text',
            supportsNativeTools: true,
            preferTextToolBridge: Boolean(params.preferTextToolBridgeOnce),
            fallbackReason: preferTextBridgeFlags.length === 1 ? 'missing_native_tools' : null,
            toolCallsCount: 0,
          },
        ]
        if (preferTextBridgeFlags.length === 1) {
          return {
            text: '这轮实际开放给我的工具里，没有 browser_* 工具。',
            rawText: '这轮实际开放给我的工具里，没有 browser_* 工具。',
            toolCalls: [],
            stopReason: 'stop',
            toolTransport: 'text',
            toolSnapshots,
          }
        }
        if (preferTextBridgeFlags.length === 2) {
          return {
            text: '我继续查看页面。',
            rawText: '我继续查看页面。',
            toolCalls: [],
            stopReason: 'stop',
            toolTransport: 'text',
            toolSnapshots,
          }
        }
        return {
          text: '我已经拿到结果。',
          rawText: '我已经拿到结果。',
          toolCalls: [],
          stopReason: 'stop',
          toolTransport: 'text',
          toolSnapshots,
        }
      },
    },
  })

  const result = await engine.execute(request)

  assert.equal(result.finalText, '浏览器任务已完成')
  assert.deepEqual(preferTextBridgeFlags, [false, true, false, false])
  const toolSnapshots = result.executionDiagnostics?.toolSnapshots || []
  assert.deepEqual(toolSnapshots.slice(0, 5).map((snapshot) => snapshot.stage), [
    'host_prepared',
    'host_effective',
    'tool_loop_request',
    'provider_request',
    'provider_response',
  ])
  assert.equal(
    (toolSnapshots.find((snapshot) => snapshot.stage === 'tool_loop_request')?.allowedToolNames || []).includes('browser_search'),
    true,
  )
  assert.equal(toolSnapshots.some((snapshot) => snapshot.stage === 'provider_response'), true)
  assert.equal(Array.isArray(result.executionDiagnostics?.toolResolution?.usedStaticFallbackGroups), true)
})

test('TurnEngine treats retry-only armed long skill resumes as tool-loop runs with 80 iteration budget', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  const logs: string[] = []
  let toolLoopRequests = 0
  let capturedAllowedToolNames: string[] = []

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill('scope-test', { id: 'video-expert-analyzer', name: 'video-expert-analyzer' })
  const restoreLongToolDefinition = installLongSkillToolDefinitionForTest()
  try {
    const { request } = createRequest({
      userText: '继续',
      host: {
        log: (message: string) => { logs.push(message) },
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
        skillContextOrchestrator: {
          shouldKeepToolsWithVideo: () => false,
          findExplicitlyRequestedSkills: () => [],
          hasActiveSkillExecution: () => false,
          getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'video-expert-analyzer' }),
          rememberExplicitReferenceSkillHint: () => true,
          buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline', 'skill_video_expert_ai_analyze'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer', 'VEA'],
        },
        requestToolLoopResponse: async (params: { allowedToolNames?: string[] }) => {
          toolLoopRequests += 1
          capturedAllowedToolNames = params.allowedToolNames || []
          return {
            text: '恢复完成',
            toolCalls: [],
            stopReason: 'stop',
          }
        },
      },
    })

    const result = await engine.execute(request)

    assert.equal(toolLoopRequests, 1)
    assert.equal(result.taskType, 'multi_step_task')
    assert.equal(result.executionDiagnostics?.budget?.maxIterations, 80)
    assert.equal(result.executionDiagnostics?.budget?.maxToolCalls, 80)
    assert.ok(
      capturedAllowedToolNames.includes('skill_video_expert_pipeline'),
      `expected VEA pipeline in allowed tools, got: ${capturedAllowedToolNames.join(',')}`,
    )
    assert.ok(metrics.some((event) => event.metric === 'preferred_skill_tools' && event.count === 2))
    assert.ok(metrics.some((event) => event.metric === 'skill_reference_hint_armed' && event.via === 'current'))
    assert.ok(logs.some((line) => line.includes('[skill_detection]')))
  } finally {
    restoreLongToolDefinition()
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

test('TurnEngine emits a typed skill action duration metric from tool hooks', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  let loopPass = 0

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill('scope-test', { id: 'video-expert-analyzer', name: 'video-expert-analyzer' })
  const restoreLongToolDefinition = installLongSkillToolDefinitionForTest()
  try {
    const { request } = createRequest({
      userText: '继续',
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
        skillContextOrchestrator: {
          shouldKeepToolsWithVideo: () => false,
          findExplicitlyRequestedSkills: () => [],
          hasActiveSkillExecution: () => false,
          getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'video-expert-analyzer' }),
          rememberExplicitReferenceSkillHint: () => true,
          buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer'],
        },
        requestToolLoopResponse: async () => {
          loopPass += 1
          if (loopPass === 1) {
            return {
              text: '继续执行 VEA',
              toolCalls: [{ id: 'tool-1', name: 'skill_video_expert_pipeline', input: {} }],
              stopReason: 'tool_calls',
            }
          }
          return {
            text: '已完成恢复总结',
            toolCalls: [],
            stopReason: 'stop',
          }
        },
        executeToolBatch: async (params: { hooks?: { onToolStart?: Function; onToolResult?: Function } }) => {
          const toolCall = { id: 'tool-1', name: 'skill_video_expert_pipeline', input: {} }
          params.hooks?.onToolStart?.({ toolCall })
          params.hooks?.onToolResult?.({
            toolCall,
            result: {
              text: JSON.stringify({
                status: 'done',
                outputs: {
                  outputDir: '/tmp/vea-output',
                  runStatePath: '/tmp/vea-output/run_state.json',
                  sceneScoresPath: '/tmp/vea-output/scene_scores.json',
                },
              }),
            },
          })
          return {
            results: [{
              id: 'tool-1',
              name: 'skill_video_expert_pipeline',
              input: {},
              result: {
                text: JSON.stringify({
                  status: 'done',
                  outputs: {
                    outputDir: '/tmp/vea-output',
                    runStatePath: '/tmp/vea-output/run_state.json',
                    sceneScoresPath: '/tmp/vea-output/scene_scores.json',
                  },
                }),
              },
            }],
            budgetLimited: false,
            recoveryHistory: [],
          }
        },
      },
    })

    const result = await engine.execute(request)

    assert.match(result.finalText, /已完成恢复总结/)
    assert.ok(metrics.some((event) =>
      event.metric === 'skill_typed_action_duration_ms'
      && event.toolName === 'skill_video_expert_pipeline'
      && typeof event.durationMs === 'number'
    ))
  } finally {
    restoreLongToolDefinition()
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

test('TurnEngine emits a generic running projection as soon as a long skill action starts', async () => {
  const engine = new TurnEngine()
  let loopPass = 0

  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill('scope-test', { id: 'video-expert-analyzer', name: 'video-expert-analyzer' })
  const restoreLongToolDefinition = installLongSkillToolDefinitionForTest()
  try {
    const { request, events } = createRequest({
      userText: '继续',
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
        skillContextOrchestrator: {
          shouldKeepToolsWithVideo: () => false,
          findExplicitlyRequestedSkills: () => [],
          hasActiveSkillExecution: () => false,
          getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'video-expert-analyzer' }),
          rememberExplicitReferenceSkillHint: () => true,
          buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer'],
        },
        requestToolLoopResponse: async () => {
          loopPass += 1
          if (loopPass === 1) {
            return {
              text: '开始执行',
              toolCalls: [{ id: 'tool-1', name: 'skill_video_expert_pipeline', input: {} }],
              stopReason: 'tool_calls',
            }
          }
          return { text: '完成', toolCalls: [], stopReason: 'stop' }
        },
        executeToolBatch: async (params: { hooks?: { onToolStart?: Function; onToolResult?: Function } }) => {
          const toolCall = { id: 'tool-1', name: 'skill_video_expert_pipeline', input: {} }
          params.hooks?.onToolStart?.({ toolCall })
          params.hooks?.onToolResult?.({ toolCall, result: { text: 'done' } })
          return {
            results: [{
              id: 'tool-1',
              name: 'skill_video_expert_pipeline',
              input: {},
              result: { text: 'done' },
            }],
            budgetLimited: false,
            recoveryHistory: [],
          }
        },
      },
    })

    await engine.execute(request)

    const runningProjection = events
      .map((event) => (event as TurnTranscriptEvent & { projectionPatch?: Record<string, unknown> | null }).projectionPatch)
      .find((projection) => projection?.module === 'skill' && projection.taskSummary === '正在执行技能工具，已运行 0 秒')

    assert.equal(runningProjection?.currentStepId, 'skill_video_expert_pipeline')
    assert.equal((runningProjection?.steps as Array<{ status?: string }> | undefined)?.[0]?.status, 'running')
  } finally {
    restoreLongToolDefinition()
    _resetLastReferenceSkillHintsForTests()
  }
})

test('TurnEngine gives long typed skill results enough follow-up budget to summarize', async () => {
  const engine = new TurnEngine()
  let loopPass = 0

  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill('scope-test', { id: 'video-expert-analyzer', name: 'video-expert-analyzer' })
  const restoreLongToolDefinition = installLongSkillToolDefinitionForTest()
  try {
    const { request } = createRequest({
      userText: '继续',
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
        skillContextOrchestrator: {
          shouldKeepToolsWithVideo: () => false,
          findExplicitlyRequestedSkills: () => [],
          hasActiveSkillExecution: () => false,
          getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'video-expert-analyzer' }),
          rememberExplicitReferenceSkillHint: () => true,
          buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer'],
        },
        requestToolLoopResponse: async () => {
          loopPass += 1
          if (loopPass === 1) {
            return {
              text: '继续执行 VEA',
              toolCalls: [
                { id: 'tool-vea', name: 'skill_video_expert_pipeline', input: {} },
                { id: 'tool-memory', name: 'memory_create', input: { text: 'VEA 已完成' } },
              ],
              stopReason: 'tool_calls',
            }
          }
          return {
            text: 'VEA 已完成，输出目录 /tmp/vea-output。',
            toolCalls: [],
            stopReason: 'stop',
          }
        },
        executeToolBatch: async () => ({
          results: [
            {
              id: 'tool-vea',
              name: 'skill_video_expert_pipeline',
              input: {},
              result: {
                text: JSON.stringify({
                  status: 'done',
                  outputs: {
                    outputDir: '/tmp/vea-output',
                    runStatePath: '/tmp/vea-output/run_state.json',
                    sceneScoresPath: '/tmp/vea-output/scene_scores.json',
                  },
                }),
              },
            },
            {
              id: 'tool-memory',
              name: 'memory_create',
              input: { text: 'VEA 已完成' },
              result: { text: 'memory saved' },
            },
          ],
          budgetLimited: false,
          recoveryHistory: [],
        }),
      },
    })

    request.continuationState = {
      taskId: 'task-vea',
      scopeId: 'scope-test',
      runId: 'run-vea',
      module: 'skill',
      taskType: 'multi_step_task',
      interactionState: 'resuming',
      steps: [{ id: 'score', title: '继续评分', description: '继续评分', status: 'running' }],
      currentStepId: 'score',
      resumableActions: ['continue', 'cancel'],
      budgetRuntime: {
        taskType: 'continuation',
        budget: {
          maxIterations: 3,
          maxToolCalls: 3,
          maxParallelToolGroups: 5,
          reservedToolCalls: 0,
        },
        usage: {
          iterationsUsed: 1,
          toolCallsUsed: 1,
          parallelToolGroupsUsed: 0,
        },
        stepBudget: {
          stepId: 'score',
          maxIterations: 3,
          remainingIterations: 2,
        },
        warningLevel: 'warning',
        frozen: false,
        bootstrapBudget: false,
      },
    }

    const result = await engine.execute(request)

    assert.equal(loopPass, 2)
    assert.match(result.finalText, /VEA 已完成/)
    assert.doesNotMatch(result.finalText, /预算上限/)
  } finally {
    restoreLongToolDefinition()
    _resetLastReferenceSkillHintsForTests()
  }
})

test('TurnEngine emits budget warning and exhaustion metrics with skill context fields', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill('scope-test', { id: 'video-expert-analyzer', name: 'video-expert-analyzer' })
  try {
    const { request } = createRequest({
      userText: '继续',
      intentClassification: createIntent({
        primaryDomain: 'skill',
        mentionedDomains: ['skill'],
        objectSignals: ['skill-object'],
        actionSignals: ['skill-action'],
        confidence: 'high',
      }),
      budget: {
        maxIterations: 1,
        maxToolCalls: 1,
        maxParallelToolGroups: 1,
        reservedToolCalls: 0,
      },
      budgetState: {
        iterationsUsed: 0,
        toolCallsUsed: 0,
        parallelToolGroupsUsed: 0,
      },
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
        skillContextOrchestrator: {
          shouldKeepToolsWithVideo: () => false,
          findExplicitlyRequestedSkills: () => [],
          hasActiveSkillExecution: () => false,
          getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'video-expert-analyzer' }),
          rememberExplicitReferenceSkillHint: () => true,
          buildPreferredSkillToolNames: () => ['skill_run_shell'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer'],
        },
        requestToolLoopResponse: async () => ({
          text: '继续执行',
          toolCalls: [{ id: 'tool-1', name: 'skill_run_shell', input: {} }],
          stopReason: 'tool_calls',
        }),
        executeToolBatch: async () => ({
          results: [{
            id: 'tool-1',
            name: 'skill_run_shell',
            input: {},
            result: { text: 'done' },
          }],
          budgetLimited: false,
          recoveryHistory: [],
        }),
      },
    })

    await engine.execute(request)

    const warning = metrics.find((event) => event.metric === 'turn_budget_warning')
    const exhausted = metrics.find((event) => event.metric === 'turn_budget_exhausted')
    assert.equal(warning?.referenceSkillId, 'video-expert-analyzer')
    assert.equal(exhausted?.referenceSkillId, 'video-expert-analyzer')
    assert.equal(exhausted?.budgetLimitedBeforeCompletion, true)
  } finally {
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})
