/**
 * Stage 7 — single per-turn `turn_frame_summary` diagnostic.
 *
 * Every turn closure (done, checkpoint_budget, checkpoint_background,
 * cancelled_runtime, etc.) must emit EXACTLY ONE structured `turn_frame_summary`
 * metric with all required fields. Existing scattered metrics
 * (`turn_terminal_reason`, `turn_budget_exhausted`, `turn_frame_resolved`)
 * stay for telemetry — this is a single comprehensive aggregate.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TurnEngine,
  detectAllowedPreferredMismatch,
  shouldResumeContinuationForTurn,
} from '../main/modules/agent-control/turn-engine'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import {
  rememberLastReferenceSkill,
  _resetLastReferenceSkillHintsForTests,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import { defaultToolRegistry } from '../main/modules/agent-control/tools-runtime/tool-registry'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import type { IntentClassification } from '../main/modules/agent-control/intent-classifier'
import type {
  TurnEngineRequest,
  TurnEngineSession,
  TurnTranscriptEvent,
} from '../main/modules/agent-control/contracts/run-contracts'

function createSession(userText: string): TurnEngineSession {
  return {
    messages: [{ role: 'user', content: userText }],
    abortController: null,
    systemPrompt: 'system',
    generation: 1,
    activeRunId: 'run-summary',
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

function createBaseHost(overrides: Record<string, unknown> = {}) {
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
    domainAdapters: [],
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
}) {
  const events = createEvents()
  const request: TurnEngineRequest = {
    runId: 'req-summary-1',
    taskId: 'task-summary-1',
    agentName: 'agent-test',
    sessionId: 'scope-summary',
    session: createSession(params.userText),
    content: params.userText,
    requestEnvelope: buildRequestEnvelope({ userText: params.userText }),
    intentClassification: params.intentClassification,
    abortSignal: new AbortController().signal,
    ensureNotAborted: () => {},
    emitters: events.emitters,
    host: createBaseHost(params.host || {}),
  }
  return { request, events: events.events }
}

test('TurnEngine emits exactly one turn_frame_summary metric on a generic done turn', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []

  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const { request } = createRequest({
      userText: '解释一下这个概念',
    })

    const result = await engine.execute(request)

    const summaries = metrics.filter((event) => event.metric === 'turn_frame_summary')
    assert.equal(summaries.length, 1, `expected exactly one turn_frame_summary, got ${summaries.length}`)

    const summary = summaries[0]
    // Required fields per Stage 7 spec.
    assert.equal(summary.sessionId, 'scope-summary')
    assert.equal(summary.requestId, 'req-summary-1')
    assert.equal(summary.terminalReason, 'done')
    assert.equal(summary.mode, 'ask_model')
    assert.equal(summary.budgetExhausted, false)
    assert.equal(summary.iterations, 0, 'simple-text path runs 0 iteration loops')
    assert.ok(Array.isArray(summary.allowedToolNames))
    assert.ok(Array.isArray(summary.preferredToolNames))
    assert.equal(typeof summary.allowedPreferredMismatch, 'boolean')
    assert.equal(typeof summary.longSkillResume, 'boolean')

    // Sanity: the summary log should not break the engine result.
    assert.equal(result.success, true)
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('TurnEngine emits turn_frame_summary on budget-exhaustion checkpoint with skill context', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  let modelCalls = 0

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill('scope-summary', { id: 'video-expert-analyzer', name: 'video-expert-analyzer' })
  const restoreLongToolDefinition = installLongSkillToolDefinitionForTest()

  try {
    const { request } = createRequest({
      userText: '继续视频分析',
      intentClassification: createIntent({
        primaryDomain: 'skill',
        mentionedDomains: ['skill'],
        objectSignals: ['skill-object'],
        actionSignals: ['skill-action'],
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
        skillContextOrchestrator: {
          shouldKeepToolsWithVideo: () => false,
          findExplicitlyRequestedSkills: () => [],
          getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'video-expert-analyzer' }),
          rememberExplicitReferenceSkillHint: () => true,
          buildPreferredSkillToolNames: () => ['skill_run_shell'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer'],
        },
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => {
            // Throw to force the engine into the supervisor-throws checkpoint
            // path (yields terminalReason='checkpoint_budget'). This mirrors
            // the existing "TurnEngine keeps skill budget exhaustion as
            // checkpoint when supervisor throws" route test.
            throw new Error('supervisor unavailable')
          },
        },
        requestToolLoopResponse: async () => {
          modelCalls += 1
          return {
            text: '继续执行',
            toolCalls: [{ id: 'tool-1', name: 'skill_run_shell', input: {} }],
            stopReason: 'tool_calls',
          }
        },
        executeToolBatch: async () => ({
          results: [{
            id: 'tool-1',
            name: 'skill_run_shell',
            input: {},
            result: { text: 'monitor exited 0' },
          }],
          budgetLimited: false,
          recoveryHistory: [],
        }),
      },
    })

    const minimalBudget = {
      maxIterations: 1,
      maxToolCalls: 1,
      maxParallelToolGroups: 1,
      reservedToolCalls: 0,
    }
    request.budget = minimalBudget
    request.budgetState = {
      iterationsUsed: 0,
      toolCallsUsed: 0,
      parallelToolGroupsUsed: 0,
    }

    const result = await engine.execute(request)

    const summaries = metrics.filter((event) => event.metric === 'turn_frame_summary')
    assert.equal(summaries.length, 1, `expected exactly one turn_frame_summary, got ${summaries.length}`)

    const summary = summaries[0]
    assert.equal(summary.sessionId, 'scope-summary')
    assert.equal(summary.terminalReason, 'checkpoint_budget')
    assert.equal(summary.skillId, 'video-expert-analyzer')
    assert.equal(summary.iterations >= 1, true)

    // Stage G5 — budget exhaustion with a recoverable skill MUST NOT close
    // the turn as `done`. The valid terminal reasons are `checkpoint_budget`
    // (parent budget exhausted, work pausable) and `checkpoint_background`
    // (work handed off to a detached child). Closing as `done` here would
    // claim the long skill finished when in fact the parent only ran out of
    // its own budget — that misclassification is the regression this guards
    // against.
    assert.notEqual(
      summary.terminalReason,
      'done',
      'Stage G5: recoverable skill with budget exhausted must NOT terminate as done',
    )
    assert.ok(
      summary.terminalReason === 'checkpoint_budget'
        || summary.terminalReason === 'checkpoint_background',
      `Stage G5: terminalReason must be checkpoint_budget or checkpoint_background, got ${summary.terminalReason}`,
    )

    // Result-level assertions (sanity — confirms terminal reason path fired).
    assert.equal(result.terminalReason, 'checkpoint_budget')
    assert.notEqual(result.terminalReason, 'done')
    assert.equal(modelCalls >= 1, true)
  } finally {
    restoreLongToolDefinition()
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

test('turn_frame_summary reports allowedPreferredMismatch=false when preferred is empty', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []

  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const { request } = createRequest({
      userText: '说一下今天天气',
    })
    await engine.execute(request)
    const summaries = metrics.filter((event) => event.metric === 'turn_frame_summary')
    assert.equal(summaries.length, 1)
    const summary = summaries[0]
    assert.equal(typeof summary.allowedPreferredMismatch, 'boolean')
    // Empty preferred list cannot mismatch — false.
    assert.equal(summary.allowedPreferredMismatch, false)
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('detectAllowedPreferredMismatch: returns true when preferred contains a tool not in allowed', () => {
  // Pure helper directly testable. The integration paths (turn-engine route
  // tests) cover the mismatch=false case where prepareInitialRun adds the
  // typed action to the allowed surface; this test exercises the genuine
  // mismatch case where the frame steers toward a tool that is NOT
  // in the model's allowed-tools surface.
  assert.equal(
    detectAllowedPreferredMismatch(
      ['skill_run_shell', 'skill_inspect_run_state'],
      ['skill_video_expert_pipeline', 'skill_inspect_run_state'],
    ),
    true,
    'skill_video_expert_pipeline missing from allowed → mismatch',
  )
})

test('detectAllowedPreferredMismatch: returns false when preferred is a subset of allowed', () => {
  assert.equal(
    detectAllowedPreferredMismatch(
      ['skill_video_expert_pipeline', 'skill_run_shell', 'skill_inspect_run_state'],
      ['skill_video_expert_pipeline', 'skill_inspect_run_state'],
    ),
    false,
  )
})

test('detectAllowedPreferredMismatch: returns false when preferred is empty', () => {
  assert.equal(
    detectAllowedPreferredMismatch(['skill_video_expert_pipeline'], []),
    false,
    'empty preferred cannot mismatch',
  )
})

test('shouldResumeContinuationForTurn lets explicit map requests escape stale continuation context', () => {
  assert.equal(
    shouldResumeContinuationForTurn({
      continuationTaskId: 'task-old-research',
      mapSemanticIntent: {
        isMapIntent: true,
        primaryTask: 'multi_point_order',
        secondarySignals: [],
        confidence: 0.8,
      },
      retryOnlyTurnDetected: false,
    }),
    false,
  )
  assert.equal(
    shouldResumeContinuationForTurn({
      continuationTaskId: 'task-old-research',
      mapSemanticIntent: {
        isMapIntent: true,
        primaryTask: 'multi_point_order',
        secondarySignals: [],
        confidence: 0.8,
      },
      retryOnlyTurnDetected: true,
    }),
    true,
  )
})
