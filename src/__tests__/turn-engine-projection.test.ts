import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRequestEnvelope } from '../main/modules/agent-control/request-envelope'
import { RSSDomainAdapter } from '../main/modules/agent-control/domain-adapters/rss-domain-adapter'
import { TurnEngine } from '../main/modules/agent-control/turn-engine'
import { TurnTranscript } from '../main/modules/agent-control/turn-transcript'
import type { DomainAdapter } from '../main/modules/agent-control/domain-adapters/domain-adapter'
import type { IntentClassification } from '../main/modules/agent-control/intent-classifier'
import type { TurnEngineRequest, TurnEngineSession, TurnTranscriptEvent } from '../main/modules/agent-control/run-contracts'

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

function createHost(overrides?: Record<string, unknown>) {
  return {
    log: () => {},
    maxToolIterations: 6,
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
      supportsToolCalls: true,
      supportsVideoBlock: true,
      hasRawVideoInIncoming: false,
    },
    isBrowserAgentV3Enabled: () => false,
    resolveContinuationProjection: () => null,
    getIncomingAttachmentHints: () => ({ count: 0 }),
    collectRecentPureUserInputs: () => [],
    sessionHasMediaInputs: () => false,
    sessionHasVideoInputs: () => false,
    skillContextOrchestrator: {
      shouldKeepToolsWithVideo: () => false,
      findExplicitlyRequestedSkills: () => [],
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
      createState: () => ({ iteration: 0 }),
      getBudgetHint: () => null,
      handleNoToolCall: ({ state }: { state: { iteration: number } }) => ({
        state: { iteration: state.iteration + 1 },
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
    taskBudgetRuntime: params.taskBudgetRuntime || null,
    abortSignal: new AbortController().signal,
    ensureNotAborted: () => {},
    emitters: events.emitters,
    host: createHost(params.host),
  }
  return { request, events: events.events }
}

test('TurnTranscript preserves tool/text event order and aggregates final text plus used tools', () => {
  const events = createEvents()
  const transcript = new TurnTranscript(events.emitters)

  transcript.emitToolUse('document_replace_exact', { query: '原文' })
  transcript.emitOutput('{"ok":true}', 'tool_result')
  transcript.emitStructuredPayload({ module: 'document', taskSummary: '需要确认目标段落' })
  transcript.emitOutput('文档已完成', 'text')

  assert.deepEqual(
    events.events.filter((event) => event.kind === 'output').map((event) => event.type),
    ['tool_use', 'tool_result', 'tool_result', 'text'],
  )
  assert.deepEqual(
    transcript.listEvents().filter((event) => event.kind === 'structured_payload').map((event) => event.projectionPatch),
    [{ module: 'document', taskSummary: '需要确认目标段落' }],
  )
  assert.equal(transcript.getFinalText(), '文档已完成')
  assert.deepEqual(transcript.getUsedTools(), ['document_replace_exact'])
})

test('TurnEngine returns projection truth aggregated from structured transcript payloads', async () => {
  const engine = new TurnEngine()
  const documentAdapter = {
    id: 'document',
    shouldHandle: () => true,
    prepare: () => ({
      allowedToolNames: ['document_replace_exact'],
      sessionMessages: [],
      domainState: {
        taskTitle: '章节改写',
        toolLoopState: {
          phase: 'drafting',
        },
      },
    }),
    dispatch: async () => ({
      domainState: {
        taskTitle: '章节改写',
        toolLoopState: {
          phase: 'drafting',
        },
      },
      projection: {
        phase: 'blocked',
        summary: '请先确认要替换的段落',
      },
    }),
    applyResult: () => ({
      domainState: null,
    }),
    buildProjectionPatch: () => ({
      module: 'document',
      taskTitle: '章节改写',
      taskSummary: '请先确认要替换的段落',
      steps: [{
        id: 'execute',
        title: '章节改写',
        status: 'blocked',
        updatedAt: '2026-04-17T10:00:00.000Z',
      }],
      currentStepId: 'execute',
      blockedReason: '请先确认要替换的段落',
      resumableActions: ['continue', 'cancel'],
    }),
  }
  const { request } = createRequest({
    userText: '帮我改文档',
    intentClassification: createIntent({
      primaryDomain: 'document',
      mentionedDomains: ['document'],
      objectSignals: ['document-object'],
      actionSignals: ['document-action'],
      confidence: 'high',
    }),
    host: {
      domainAdapters: [documentAdapter],
      providerContext: {
        ...createHost().providerContext,
        supportsToolCalls: true,
      },
      requestToolLoopResponse: async () => ({
        text: '',
        toolCalls: [],
        stopReason: 'stop',
      }),
    },
  })

  const result = await engine.execute(request)

  assert.equal(result.projectionTruth?.projectionPatch?.taskTitle, '章节改写')
  assert.equal(result.projectionTruth?.projectionPatch?.taskSummary, '请先确认要替换的段落')
  assert.equal(result.projectionTruth?.transcriptEvents?.some((event) => event.kind === 'structured_payload'), true)
})

test('TurnEngine emits blocked and done document payloads before finishing the turn', async () => {
  const engine = new TurnEngine()
  let noToolCalls = 0
  const documentToolLoopOrchestrator = {
    ...createHost().documentToolLoopOrchestrator,
    handleNoToolCall: ({ state }: { state: { iteration?: number } }) => {
      noToolCalls += 1
      if (noToolCalls === 1) {
        return {
          state: { iteration: 1 },
          nextUserMessage: '请先确认要修改的段落',
          finalText: null,
          preserveAssistantText: false,
        }
      }
      return {
        state: { iteration: 2 },
        nextUserMessage: null,
        finalText: '文档已更新',
        preserveAssistantText: false,
      }
    },
  }
  const documentAdapter: DomainAdapter = {
    id: 'document',
    shouldHandle: () => true,
    prepare: () => ({
      allowedToolNames: ['document_replace_exact'],
      sessionMessages: [],
      domainState: {
        taskTitle: '文档修改',
        toolLoopState: documentToolLoopOrchestrator.createState(),
      },
    }),
    dispatch: async ({ domainState }) => ({
      domainState,
    }),
    applyResult: ({ domainState, phase, responseText, toolTransport, toolPolicy }) => {
      if (phase !== 'no_tool_call') {
        return {
          domainState,
        }
      }
      const state = domainState as { taskTitle: string; toolLoopState: { iteration?: number } }
      const decision = documentToolLoopOrchestrator.handleNoToolCall({
        state: state.toolLoopState,
        forceDocumentTool: toolPolicy.forceDocumentTool,
        responseText: responseText || undefined,
        toolTransport,
      })
      const nextState = {
        ...state,
        toolLoopState: decision.state,
      }
      if (decision.nextUserMessage) {
        return {
          domainState: nextState,
          nextUserMessage: decision.nextUserMessage,
          preserveAssistantText: decision.preserveAssistantText,
          projection: {
            phase: 'blocked',
            summary: decision.nextUserMessage,
          },
        }
      }
      if (decision.finalText) {
        return {
          domainState: nextState,
          finalText: decision.finalText,
          projection: {
            phase: 'done',
            summary: decision.finalText,
          },
        }
      }
      return {
        domainState: nextState,
      }
    },
    buildProjectionPatch: ({ domainState, projection }) => documentToolLoopOrchestrator.buildStructuredTaskPayload({
      taskTitle: (domainState as { taskTitle: string }).taskTitle,
      taskSummary: projection.summary,
      state: (domainState as { toolLoopState: unknown }).toolLoopState as any,
      phase: projection.phase,
    }),
  }
  const { request, events } = createRequest({
    userText: '帮我改一下这段文档',
    intentClassification: createIntent({
      primaryDomain: 'document',
      mentionedDomains: ['document'],
      objectSignals: ['document-object'],
      actionSignals: ['document-action'],
      confidence: 'high',
    }),
    host: {
      documentToolLoopOrchestrator,
      domainAdapters: [documentAdapter],
      requestToolLoopResponse: async () => ({
        text: '',
        toolCalls: [],
        stopReason: 'stop',
      }),
    },
  })

  const result = await engine.execute(request)
  const toolResults = events.filter((event) => event.kind === 'output' && event.type === 'tool_result')

  assert.equal(noToolCalls, 2)
  assert.equal(result.finalText, '文档已更新')
  assert.equal(toolResults.length, 2)
  assert.match(toolResults[0].chunk || '', /请先确认要修改的段落/)
  assert.match(toolResults[1].chunk || '', /文档已更新/)
})

test('TurnEngine promotes tool projection patches into structured transcript truth', async () => {
  const engine = new TurnEngine()
  let toolLoopCalls = 0
  const { request, events } = createRequest({
    userText: '继续执行 skill workflow',
    intentClassification: createIntent({
      primaryDomain: 'skill',
      mentionedDomains: ['skill'],
      actionSignals: ['skill-action'],
      confidence: 'high',
    }),
    host: {
      requestToolLoopResponse: async () => {
        toolLoopCalls += 1
        if (toolLoopCalls === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'tool-1', name: 'skill_get_state', input: {} }],
            stopReason: 'tool_use',
          }
        }
        return {
          text: '已记录当前 blocker',
          toolCalls: [],
          stopReason: 'stop',
        }
      },
      executeToolBatch: async () => ({
        results: [
          {
            id: 'tool-1',
            name: 'skill_get_state',
            input: {},
            result: {
              text: '请选择视频风格',
              shape: 'projection_patch',
              data: null,
              projectionPatch: {
                module: 'skill',
                message: '请选择视频风格',
                taskTitle: '技能执行 · video-copy-analyzer',
                taskSummary: '请选择视频风格',
                steps: [
                  {
                    id: 'collect_input',
                    title: 'collect_input',
                    status: 'blocked',
                    updatedAt: '2026-04-17T11:00:00.000Z',
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
            },
            recoveryHistory: [],
          },
        ],
        budgetLimited: false,
        recoveryHistory: [],
      }),
    },
  })

  const result = await engine.execute(request)
  const structuredEvents = result.projectionTruth?.transcriptEvents?.filter((event) => event.kind === 'structured_payload') || []
  const toolResults = events.filter((event) => event.kind === 'output' && event.type === 'tool_result')

  assert.equal(structuredEvents.length > 0, true)
  assert.equal(result.projectionTruth?.projectionPatch?.module, 'skill')
  assert.equal(result.projectionTruth?.projectionPatch?.taskTitle, '技能执行 · video-copy-analyzer')
  assert.equal(result.projectionTruth?.projectionPatch?.waitingFor, 'input')
  assert.equal(toolResults.some((event) => /"module":"skill"/.test(event.chunk || '')), true)
})

test('TurnEngine lets rss domain adapters turn executed tool batches into structured projection truth', async () => {
  const engine = new TurnEngine()
  let toolLoopCalls = 0
  const { request } = createRequest({
    userText: '刷新 RSS 最新内容',
    intentClassification: createIntent({
      primaryDomain: 'rss',
      mentionedDomains: ['rss'],
      actionSignals: ['rss-action'],
      confidence: 'high',
    }),
    host: {
      domainAdapters: [new RSSDomainAdapter()],
      requestToolLoopResponse: async () => {
        toolLoopCalls += 1
        if (toolLoopCalls === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'tool-1', name: 'rss_fetch_updates', input: {} }],
            stopReason: 'tool_use',
          }
        }
        return {
          text: 'RSS 已刷新',
          toolCalls: [],
          stopReason: 'stop',
        }
      },
      executeToolBatch: async () => ({
        results: [
          {
            id: 'tool-1',
            name: 'rss_fetch_updates',
            input: {},
            result: {
              text: JSON.stringify({
                module: 'rss',
                action: 'rss.fetchUpdates',
                message: 'rss.fetchUpdates 已排队执行。',
              }),
              shape: 'text',
              data: null,
              projectionPatch: null,
              interactionHint: null,
            },
            recoveryHistory: [],
          },
        ],
        budgetLimited: false,
        recoveryHistory: [],
      }),
    },
  })

  const result = await engine.execute(request)

  assert.equal(result.projectionTruth?.projectionPatch?.module, 'rss')
  assert.equal(result.projectionTruth?.projectionPatch?.taskTitle, 'RSS 任务')
  assert.equal(result.projectionTruth?.projectionPatch?.currentStepId, 'rss_fetch_updates')
  assert.equal(Array.isArray(result.projectionTruth?.projectionPatch?.steps), true)
})

test('TurnEngine surfaces budget-limit text and diagnostics when tool-call budget is exhausted', async () => {
  const engine = new TurnEngine()
  const { request } = createRequest({
    userText: '继续修改文档',
    intentClassification: createIntent({
      primaryDomain: 'document',
      mentionedDomains: ['document'],
      objectSignals: ['document-object'],
      actionSignals: ['document-action'],
      confidence: 'high',
    }),
    taskBudgetRuntime: {
      taskType: 'short_task',
      budget: {
        maxIterations: 4,
        maxToolCalls: 0,
        maxParallelToolGroups: 1,
      },
      usage: {
        iterationsUsed: 0,
        toolCallsUsed: 0,
        parallelToolGroupsUsed: 0,
      },
      stepBudget: null,
      warningLevel: 'none',
      frozen: false,
      bootstrapBudget: false,
    },
    host: {
      requestToolLoopResponse: async () => ({
        text: '',
        toolCalls: [{ id: 'tool-1', name: 'document_replace_exact', input: { query: 'A' } }],
        stopReason: 'tool_use',
      }),
    },
  })

  const result = await engine.execute(request)

  assert.match(result.finalText, /预算上限|最大工具调用次数/)
  assert.equal(result.executionDiagnostics?.taskBudgetRuntime?.budget.maxToolCalls, 0)
})

test('TurnEngine converts runtime errors into error events and a failed execution result', async () => {
  const engine = new TurnEngine()
  const { request, events } = createRequest({
    userText: '解释一下这个报错',
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
        supportsToolCalls: false,
        supportsVideoBlock: true,
        hasRawVideoInIncoming: false,
      },
      requestSimpleText: async () => {
        throw new Error('boom')
      },
    },
  })

  const result = await engine.execute(request)

  assert.equal(result.success, false)
  assert.equal(events.some((event) => event.kind === 'error' && event.error === 'boom'), true)
  assert.equal(events.some((event) => event.kind === 'status' && event.status === 'error'), true)
})
