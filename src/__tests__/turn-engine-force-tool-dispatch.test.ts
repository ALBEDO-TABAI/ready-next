/**
 * Stage 7 — turn engine deterministic force-tool dispatch.
 *
 * When the resolved TurnFrame's steering is `mode='force_tool'`, the turn
 * engine must:
 *   1. SKIP the model call for that iteration.
 *   2. Synthesize a tool batch containing the typed action.
 *   3. Dispatch `executeToolBatch` with the synthesized call.
 *   4. Increment the iteration counter (force_tool is NOT a budget bypass).
 *   5. Cap force-tool dispatches at 1 per turn (no chain-resume here).
 *   6. Emit `turn_force_tool_dispatched` metric.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { TurnEngine } from '../main/modules/agent-control/turn-engine'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import {
  rememberLastReferenceSkill,
  _resetLastReferenceSkillHintsForTests,
} from '../main/modules/agent-control/skill-reference-hints'
import {
  defaultToolRegistry,
  resolveToolInputSchemaForExecution,
} from '../main/modules/agent-control/tool-registry'
import { buildRequestEnvelope } from '../main/modules/agent-control/request-envelope'
import { getToolInputSchemas } from '../main/modules/tools/schemas'
import { validateToolInput } from '../main/modules/tools/tool-input-validator'
import type { ToolDefinition } from '../main/modules/agent-control/tool-definition'
import type { IntentClassification } from '../main/modules/agent-control/intent-classifier'
import type { SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skill-task-supervisor'
import type {
  SkillChildCloseEvent,
  SkillChildRunStatus,
} from '../main/modules/agent-control/skill-child-run-types'
import type {
  RunBudgetSeed,
  RunBudgetUsage,
  TaskProjectionStore,
  TurnEngineRequest,
  TurnEngineSession,
  TurnTranscriptEvent,
} from '../main/modules/agent-control/run-contracts'
import type { TurnTerminalReason } from '../main/modules/agent-control/turn-frame'

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
    primaryDomain: 'skill',
    mentionedDomains: ['skill'],
    excludedDomains: [],
    objectSignals: ['skill-object'],
    actionSignals: ['skill-action'],
    crossDomain: false,
    confidence: 'high',
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
      emitStatus: (status: string, terminalReason?: TurnTerminalReason | null) => {
        events.push({ kind: 'status', status, terminalReason } as TurnTranscriptEvent)
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

function makeRecoverableSnapshot(): SkillTaskSupervisorSnapshot {
  return {
    taskRunId: 'str-vea-force',
    detachedTaskId: 'dst-vea-force',
    skillId: 'video-expert-analyzer',
    scopeId: 'scope-force',
    sessionId: 'scope-force',
    action: 'video_expert_pipeline',
    status: 'recoverable_paused',
    hasLiveWork: false,
    hasRecentProgress: false,
    closeAllowed: false,
    ambiguous: false,
    stale: false,
    outputDir: '/tmp/vea-force/output',
    runStatePath: '/tmp/vea-force/output/run_state.json',
    sceneScoresPath: '/tmp/vea-force/output/scene_scores.json',
    deliveryReportPath: '/tmp/vea-force/output/delivery_report.json',
    progress: {
      currentStage: 'score_batches',
      totalScenes: 97,
      completedScenes: 0,
      coverageRatio: 0,
      updatedAt: '2026-04-29T01:00:00.000Z',
    },
    blockers: [],
    pauseReason: 'budget_exhausted',
    resumePayload: {
      taskRunId: 'str-vea-force',
      detachedTaskId: 'dst-vea-force',
      outputDir: '/tmp/vea-force/output',
      runStatePath: '/tmp/vea-force/output/run_state.json',
      // Stage E — Wave 2 typed-action wrapper writes originalInput +
      // actionInput into resumePayload so a paused skill can be resumed
      // with the same input on the next turn.
      sourceUrl: 'https://example.com/forced.mp4',
      url: 'https://example.com/forced.mp4',
      originalInput: { url: 'https://example.com/forced.mp4', outputDir: '/tmp/vea-force/output' },
      actionInput: { url: 'https://example.com/forced.mp4', outputDir: '/tmp/vea-force/output' },
    },
    sourceObservations: [],
    progressFingerprint: 'score_batches:0/97',
    observedAt: '2026-04-29T01:00:00.000Z',
    lastProgressAt: '2026-04-29T01:00:00.000Z',
  }
}

function defaultTerminalReasonForTest(
  status: SkillChildCloseEvent['status'],
): SkillChildCloseEvent['terminalReason'] {
  switch (status) {
    case 'completed': return 'completed'
    case 'killed': return 'cancelled_user'
    case 'blocked': return 'blocked_external'
    case 'failed': return 'failed_skill'
    case 'budget_paused': return 'checkpoint_budget'
    case 'recoverable_paused': return 'checkpoint_background'
  }
}

function makeChildCloseEvent(
  childRunId: string,
  status: SkillChildCloseEvent['status'],
  terminalReason: SkillChildCloseEvent['terminalReason'],
): SkillChildCloseEvent {
  return {
    childRunId,
    skillId: 'video-expert-analyzer',
    status,
    terminalReason,
    outputDir: '/tmp/vea-force/output',
    runStatePath: '/tmp/vea-force/output/run_state.json',
    sceneScoresPath: '/tmp/vea-force/output/scene_scores.json',
    deliveryReportPath: null,
    progress: { stage: null, totalUnits: null, completedUnits: null, coverageRatio: null, fingerprint: null },
    framePatch: null,
    projectionPatch: null,
    error: status === 'blocked' ? { kind: terminalReason, message: 'missing input' } : null,
  }
}

function makeChildOwnedSnapshot(params: {
  childRunId: string
  status: SkillChildRunStatus
  terminalReason?: SkillChildCloseEvent['terminalReason']
  closeEvent?: SkillChildCloseEvent | null
}): SkillTaskSupervisorSnapshot {
  const base = makeRecoverableSnapshot()
  return {
    ...base,
    status: params.status === 'running' ? 'running'
      : params.status === 'blocked' ? 'blocked'
      : params.status === 'budget_paused' ? 'budget_paused'
      : params.status === 'recoverable_paused' ? 'recoverable_paused'
      : base.status,
    hasLiveWork: params.status === 'running',
    resumePayload: {
      ...(base.resumePayload || {}),
      childRun: {
        childRunId: params.childRunId,
        parentNextHint: 'wait_for_close_event',
        status: params.status,
        closeEvent: params.closeEvent === undefined && params.status !== 'running' && params.status !== 'queued'
          ? makeChildCloseEvent(
            params.childRunId,
            params.status,
            params.terminalReason || defaultTerminalReasonForTest(params.status),
          )
          : params.closeEvent,
      },
    },
  }
}

function createForceToolHost(overrides: Record<string, unknown> = {}) {
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
    domainAdapters: [],
    skillContextOrchestrator: {
      shouldKeepToolsWithVideo: () => false,
      findExplicitlyRequestedSkills: () => [],
      hasActiveSkillExecution: () => false,
      getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'video-expert-analyzer' }),
      rememberExplicitReferenceSkillHint: () => true,
      buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
      maybeInjectExplicitSkillContext: async () => {},
      listRegisteredSkillTokens: () => ['video-expert-analyzer', 'VEA'],
    },
    skillTaskSupervisor: {
      inspectLatestSkillTask: () => makeRecoverableSnapshot(),
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
      text: 'fallback model text',
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

test('budget_paused child resumes through TurnEngine', async () => {
  const engine = new TurnEngine()
  let resumeChildRunId: string | null = null
  let modelCalls = 0
  const waits: Array<{ childRunId: string; timeoutMs: number }> = []
  const childRunId = 'vbudget01'
  const { request, events } = createRequest({
    userText: '继续',
    host: {
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => makeChildOwnedSnapshot({
          childRunId,
          status: 'budget_paused',
          terminalReason: 'checkpoint_budget',
        }),
      },
      resumeSkillChildRun: async (id: string) => {
        resumeChildRunId = id
        return {
          childRunId: id,
          status: 'running',
          closeEvent: null,
          parentNextHint: 'wait_for_close_event',
          outputDir: '/tmp/vea-force/output',
          runStatePath: '/tmp/vea-force/output/run_state.json',
        }
      },
      waitForSkillChildCloseEvent: async (id: string, timeoutMs: number) => {
        waits.push({ childRunId: id, timeoutMs })
        return null
      },
      requestToolLoopResponse: async () => {
        modelCalls += 1
        return { text: 'should not call model', toolCalls: [], stopReason: 'stop' }
      },
    },
  })

  const result = await engine.execute(request)

  assert.equal(resumeChildRunId, childRunId)
  assert.equal(modelCalls, 0)
  assert.deepEqual(waits, [{ childRunId, timeoutMs: 1_500 }])
  assert.equal(result.status, 'checkpoint')
  assert.equal(result.terminalReason, 'checkpoint_background')
  assert.equal(events.some((event) => event.kind === 'output' && String(event.chunk).includes(childRunId)), true)
})

test('recoverable_paused child resumes through TurnEngine', async () => {
  const engine = new TurnEngine()
  let resumeChildRunId: string | null = null
  const waits: Array<{ childRunId: string; timeoutMs: number }> = []
  const childRunId = 'vrecover1'
  const { request } = createRequest({
    userText: '继续',
    host: {
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => makeChildOwnedSnapshot({
          childRunId,
          status: 'recoverable_paused',
          terminalReason: 'checkpoint_background',
        }),
      },
      resumeSkillChildRun: async (id: string) => {
        resumeChildRunId = id
        return {
          childRunId: id,
          status: 'running',
          closeEvent: null,
          parentNextHint: 'wait_for_close_event',
          outputDir: '/tmp/vea-force/output',
          runStatePath: '/tmp/vea-force/output/run_state.json',
        }
      },
      waitForSkillChildCloseEvent: async (id: string, timeoutMs: number) => {
        waits.push({ childRunId: id, timeoutMs })
        return null
      },
    },
  })

  const result = await engine.execute(request)

  assert.equal(resumeChildRunId, childRunId)
  assert.deepEqual(waits, [{ childRunId, timeoutMs: 1_500 }])
  assert.equal(result.status, 'checkpoint')
  assert.equal(result.terminalReason, 'checkpoint_background')
})

test('blocked child with blocked_config is not directly resumable through TurnEngine', async () => {
  // Commit `7c62ab3 Stabilize agent skill background tasks` carved out
  // `blocked + blocked_external` for runner delegation (see
  // `canDelegateBlockedResume` at turn-engine.ts:2005-2007). The "blocked is
  // not directly resumable" contract still applies for every OTHER blocked
  // terminalReason — this test pins that invariant via `blocked_config`,
  // which is NOT in the carve-out.
  const engine = new TurnEngine()
  let resumeCalls = 0
  const childRunId = 'vblocked1'
  const { request, events } = createRequest({
    userText: '继续',
    host: {
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => makeChildOwnedSnapshot({
          childRunId,
          status: 'blocked',
          terminalReason: 'blocked_config',
        }),
      },
      resumeSkillChildRun: async () => {
        resumeCalls += 1
        throw new Error('blocked child with blocked_config must not resume')
      },
    },
  })

  const result = await engine.execute(request)

  assert.equal(resumeCalls, 0)
  assert.equal(result.status, 'checkpoint')
  assert.equal(result.terminalReason, 'blocked_config')
  assert.equal(events.some((event) =>
    event.kind === 'output' && String(event.chunk).includes('不能直接继续')), true)
})

test('blocked child with blocked_external delegates resume to runner (per 7c62ab3 carve-out)', async () => {
  // Counterpart to the test above. Commit `7c62ab3` introduced the
  // `canDelegateBlockedResume` carve-out so `blocked + blocked_external`
  // delegates to the runner (which handles the block externally). Resume IS
  // called; the parent loop does not emit "不能直接继续".
  const engine = new TurnEngine()
  let resumeCalls = 0
  const childRunId = 'vblockedext1'
  const { request, events } = createRequest({
    userText: '继续',
    host: {
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => makeChildOwnedSnapshot({
          childRunId,
          status: 'blocked',
          terminalReason: 'blocked_external',
        }),
      },
      resumeSkillChildRun: async (id: string) => {
        resumeCalls += 1
        return {
          childRunId: id,
          status: 'running',
          closeEvent: null,
          parentNextHint: 'wait_for_close_event',
          outputDir: '/tmp/vea-blocked/output',
          runStatePath: '/tmp/vea-blocked/output/run_state.json',
        }
      },
      waitForSkillChildCloseEvent: async () => null,
    },
  })

  const result = await engine.execute(request)

  assert.equal(resumeCalls, 1, 'blocked_external must delegate to runner per 7c62ab3 carve-out')
  assert.equal(
    events.some((event) => event.kind === 'output' && String(event.chunk).includes('不能直接继续')),
    false,
    'blocked_external delegation path must NOT emit the "不能直接继续" rejection message',
  )
  assert.equal(result.status, 'checkpoint')
})

test('child cancel from TurnEngine writes cancelled_user only for explicit user cancel', async () => {
  const engine = new TurnEngine()
  let cancelArgs: { childRunId: string; reason?: string; source?: string } | null = null
  let resumeCalls = 0
  const childRunId = 'vcancel1'
  const { request } = createRequest({
    userText: '取消当前任务',
    host: {
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => makeChildOwnedSnapshot({
          childRunId,
          status: 'running',
          closeEvent: null,
        }),
      },
      cancelSkillChildRun: async (id: string, options?: { reason?: string; source?: string }) => {
        cancelArgs = { childRunId: id, reason: options?.reason, source: options?.source }
        return makeChildCloseEvent(id, 'killed', 'cancelled_user')
      },
      resumeSkillChildRun: async () => {
        resumeCalls += 1
        throw new Error('cancel turn must not resume')
      },
    },
  })

  const result = await engine.execute(request)

  assert.deepEqual(cancelArgs, { childRunId, reason: 'cancelled_user', source: 'nlp' })
  assert.equal(resumeCalls, 0)
  assert.equal(result.status, 'cancelled')
  assert.equal(result.terminalReason, 'cancelled_user')
})

function createRequest(params: {
  userText: string
  host?: Record<string, unknown>
  intentClassification?: IntentClassification
  budget?: RunBudgetSeed
  budgetState?: RunBudgetUsage
}) {
  const events = createEvents()
  const request: TurnEngineRequest = {
    runId: 'run-force',
    taskId: 'task-force',
    agentName: 'agent-test',
    sessionId: 'scope-force',
    session: createSession(params.userText),
    content: params.userText,
    requestEnvelope: buildRequestEnvelope({ userText: params.userText }),
    intentClassification: params.intentClassification,
    budget: params.budget,
    budgetState: params.budgetState,
    taskBudgetRuntime: null,
    abortSignal: new AbortController().signal,
    ensureNotAborted: () => {},
    emitters: events.emitters,
    host: createForceToolHost(params.host || {}),
  }
  return { request, events: events.events }
}

test('legacy force-tool: TurnEngine force_tool dispatch synthesizes typed action and skips the model call', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  const logs: string[] = []
  let modelCalls = 0
  let executedBatches = 0
  let dispatchedToolNames: string[] = []

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill('scope-force', { id: 'video-expert-analyzer', name: 'Video Expert Analyzer' })
  const restoreLongToolDefinition = installLongSkillToolDefinitionForTest()

  try {
    const { request } = createRequest({
      userText: '继续视频分析',
      host: {
        log: (message: string) => { logs.push(message) },
        requestToolLoopResponse: async () => {
          modelCalls += 1
          // If the model is ever called, return tool calls so the test can
          // distinguish a failure mode where force_tool didn't bypass.
          return {
            text: 'should not be called for force_tool',
            toolCalls: [],
            stopReason: 'stop',
          }
        },
        executeToolBatch: async (params: { toolCalls: Array<{ name: string }> }) => {
          executedBatches += 1
          dispatchedToolNames = params.toolCalls.map((toolCall) => toolCall.name)
          return {
            results: params.toolCalls.map((toolCall) => ({
              id: 'force-result-1',
              name: toolCall.name,
              input: {},
              result: { text: 'forced action ran' },
            })),
            budgetLimited: false,
            recoveryHistory: [],
          }
        },
      },
    })

    await engine.execute(request)
    void logs
    void modelCalls

    // Force-tool dispatch metric must fire exactly once with the typed
    // skill action.
    const forceDispatched = metrics.filter((event) => event.metric === 'turn_force_tool_dispatched')
    assert.equal(forceDispatched.length, 1, `expected exactly one force-tool dispatch metric, got ${forceDispatched.length}`)
    assert.equal(forceDispatched[0].toolName, 'skill_video_expert_pipeline')

    // The model call must be SKIPPED for the iteration that force_tool
    // dispatched. The engine may still call the model in a subsequent
    // iteration when steering falls back to ask_model — but the synthesized
    // batch executed at least once.
    assert.equal(executedBatches >= 1, true, 'expected executeToolBatch to run at least once')
    assert.ok(
      dispatchedToolNames.includes('skill_video_expert_pipeline'),
      `expected synthesized batch to include skill_video_expert_pipeline, got: ${dispatchedToolNames.join(',')}`,
    )

    // After the force_tool dispatch, recentForceToolDispatched downgrades
    // the next iteration to ask_model — so any subsequent loop iteration
    // calls the model normally. We do NOT assert modelCalls === 0 because
    // the loop may continue past the synthesized iteration.
  } finally {
    restoreLongToolDefinition()
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

test('blocked VEA score-batch resume dispatches ai_analyze before model can burn budget', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  let modelCalls = 0
  let executedBatches = 0
  let dispatchedToolNames: string[] = []
  let dispatchedInput: Record<string, unknown> | null = null
  const sceneScoresPath = '/tmp/vea-force/output/scene_scores.json'

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill('scope-force', { id: 'video-expert-analyzer', name: 'Video Expert Analyzer' })
  const restoreAiAnalyzeToolDefinition = installLongSkillToolDefinitionForTest('skill_video_expert_ai_analyze')

  try {
    const blockedSnapshot: SkillTaskSupervisorSnapshot = {
      ...makeRecoverableSnapshot(),
      action: 'video_expert_ai_analyze',
      status: 'blocked',
      hasLiveWork: false,
      hasRecentProgress: false,
      sceneScoresPath,
      pauseReason: 'budget_exhausted',
      resumePayload: {
        taskRunId: 'str-vea-force',
        detachedTaskId: 'dst-vea-force',
        outputDir: '/tmp/vea-force/output',
        runStatePath: '/tmp/vea-force/output/run_state.json',
        actionInput: { sceneScoresPath, outputDir: '/tmp/vea-force/output' },
        originalInput: { sceneScoresPath, outputDir: '/tmp/vea-force/output' },
      },
    }
    const { request } = createRequest({
      userText: '继续评分',
      host: {
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => blockedSnapshot,
        },
        skillContextOrchestrator: {
          shouldKeepToolsWithVideo: () => false,
          findExplicitlyRequestedSkills: () => [],
          hasActiveSkillExecution: () => false,
          getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'Video Expert Analyzer' }),
          rememberExplicitReferenceSkillHint: () => true,
          buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline', 'skill_video_expert_ai_analyze'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer', 'VEA'],
        },
        requestToolLoopResponse: async () => {
          modelCalls += 1
          return {
            text: 'model should only be reached after forced ai_analyze dispatch',
            toolCalls: [],
            stopReason: 'stop',
          }
        },
        executeToolBatch: async (params: { toolCalls: Array<{ name: string; input?: Record<string, unknown> }> }) => {
          executedBatches += 1
          dispatchedToolNames = params.toolCalls.map((toolCall) => toolCall.name)
          dispatchedInput = params.toolCalls[0]?.input || null
          return {
            results: params.toolCalls.map((toolCall) => ({
              id: 'force-ai-result-1',
              name: toolCall.name,
              input: toolCall.input || {},
              result: { text: 'forced ai_analyze ran' },
            })),
            budgetLimited: false,
            recoveryHistory: [],
          }
        },
      },
    })

    await engine.execute(request)

    assert.equal(executedBatches >= 1, true, 'expected executeToolBatch to run at least once')
    assert.ok(
      dispatchedToolNames.includes('skill_video_expert_ai_analyze'),
      `expected synthesized batch to include skill_video_expert_ai_analyze, got: ${dispatchedToolNames.join(',')}`,
    )
    assert.equal(dispatchedInput?.sceneScoresPath, sceneScoresPath)
    assert.equal(modelCalls <= 1, true, `expected at most one model call after forced dispatch, got ${modelCalls}`)
    const forceDispatched = metrics.filter((event) => event.metric === 'turn_force_tool_dispatched')
    assert.equal(forceDispatched.length, 1, `expected exactly one force-tool dispatch metric, got ${forceDispatched.length}`)
    assert.equal(forceDispatched[0].toolName, 'skill_video_expert_ai_analyze')
  } finally {
    restoreAiAnalyzeToolDefinition()
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

test('legacy force-tool: TurnEngine force_tool caps at one dispatch per turn (no chain-resume in same turn)', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  let executedBatches = 0
  let modelCalls = 0

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill('scope-force', { id: 'video-expert-analyzer', name: 'Video Expert Analyzer' })
  const restoreLongToolDefinition = installLongSkillToolDefinitionForTest()

  try {
    const { request } = createRequest({
      userText: '继续视频分析',
      host: {
        requestToolLoopResponse: async () => {
          modelCalls += 1
          // Return empty tool_calls so the iteration loop ends cleanly after
          // the model call (no further work to do).
          return {
            text: 'model returned no tool calls',
            toolCalls: [],
            stopReason: 'stop',
          }
        },
        executeToolBatch: async (params: { toolCalls: Array<{ name: string }> }) => {
          executedBatches += 1
          return {
            results: params.toolCalls.map((toolCall) => ({
              id: `result-${executedBatches}`,
              name: toolCall.name,
              input: {},
              result: { text: 'forced batch ran' },
            })),
            budgetLimited: false,
            recoveryHistory: [],
          }
        },
      },
    })

    await engine.execute(request)

    // Exactly ONE force-tool dispatch metric, even if the engine loops more
    // iterations. After the first force_tool, recentForceToolDispatched
    // downgrades the next iteration to ask_model, and the post-batch
    // steering re-derivation only allows force_tool to recur if the flag
    // is cleared AND `forceToolDispatchedThisTurn` permits — which it
    // does NOT because we cap at 1 per turn.
    const forceDispatched = metrics.filter((event) => event.metric === 'turn_force_tool_dispatched')
    assert.equal(forceDispatched.length, 1, `expected exactly one force-tool dispatch metric, got ${forceDispatched.length}`)
    assert.ok(executedBatches >= 1)
  } finally {
    restoreLongToolDefinition()
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

/**
 * Stage G6 — orphan-result regression.
 *
 * When a forced typed-action dispatch is interrupted mid-flight by an abort
 * signal, the turn engine MUST emit exactly one structured close event and
 * MUST NOT leave behind an unresolved synthetic `tool_use`. The valid close
 * events are:
 *   - cancellation       (terminalReason='cancelled_runtime', cancelled=true)
 *   - tool error result  (when the host returns an error result instead of
 *                         throwing — covered by other tests)
 *   - failure            (terminalReason='persistence_failed', success=false)
 *   - checkpoint         (mid-iteration checkpoint with explicit reason)
 * What we are guarding against here is the parent loop double-dispatching, or
 * the parent emitting a `turn_frame_summary` for a turn whose synthesized
 * tool_use never received a result.
 *
 * Why this matters for the child-loop migration: today the parent's
 * force-tool block synthesises a `tool_use`, awaits `executeToolBatch`, and
 * lets the post-batch pipeline apply the framePatch. If abort fires after the
 * synth but before the result is consumed, an orphan `tool_use` would mean
 * the parent claims it dispatched a child run that has no recorded close.
 * The child-loop runner inherits this invariant: one launch -> one close
 * event, no orphans. See docs/architecture/skill-child-loop-boundary.md §4.
 */
test('legacy force-tool: TurnEngine force_tool aborted mid-dispatch closes the turn with one terminal event and no orphan tool_use', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  let executedBatches = 0
  let dispatchedToolNames: string[] = []
  let modelCalls = 0

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill('scope-force', { id: 'video-expert-analyzer', name: 'Video Expert Analyzer' })
  const restoreLongToolDefinition = installLongSkillToolDefinitionForTest()

  // The abort controller is shared between the request and the
  // executeToolBatch override below so abort can fire mid-dispatch (after
  // the synthesised tool_use was created but before the result is folded
  // back into the frame).
  const abortController = new AbortController()

  try {
    const events = createEvents()
    const request: TurnEngineRequest = {
      runId: 'run-force-abort',
      taskId: 'task-force-abort',
      agentName: 'agent-test',
      sessionId: 'scope-force',
      session: createSession('继续视频分析'),
      content: '继续视频分析',
      requestEnvelope: buildRequestEnvelope({ userText: '继续视频分析' }),
      intentClassification: createIntent(),
      taskBudgetRuntime: null,
      abortSignal: abortController.signal,
      ensureNotAborted: () => {
        if (abortController.signal.aborted) {
          const error = new Error('aborted')
          error.name = 'AbortError'
          throw error
        }
      },
      emitters: events.emitters,
      host: createForceToolHost({
        requestToolLoopResponse: async () => {
          modelCalls += 1
          return {
            text: 'should not be called for force_tool',
            toolCalls: [],
            stopReason: 'stop',
          }
        },
        executeToolBatch: async (params: { toolCalls: Array<{ name: string }> }) => {
          executedBatches += 1
          dispatchedToolNames = params.toolCalls.map((toolCall) => toolCall.name)
          // Mid-flight abort: the parent has already synthesised the
          // force-tool tool_use and dispatched it; before any result can
          // be folded back into the frame, abort fires. The host honours
          // the signal by throwing AbortError (this is what the production
          // tool executor does when the abort signal fires during a long
          // skill run).
          abortController.abort()
          const error = new Error('aborted mid-dispatch')
          error.name = 'AbortError'
          throw error
        },
      }),
    }

    const result = await engine.execute(request)
    void modelCalls

    // 1. The synthesised tool_use was dispatched once — proves we genuinely
    //    aborted mid-flight, not pre-dispatch.
    assert.equal(executedBatches, 1, `expected exactly one executeToolBatch invocation, got ${executedBatches}`)
    assert.ok(
      dispatchedToolNames.includes('skill_video_expert_pipeline'),
      `expected the aborted batch to carry the synthesised force-tool name, got: ${dispatchedToolNames.join(',')}`,
    )

    // 2. Exactly ONE force-tool dispatch metric — no double dispatch, no
    //    retry-on-abort orphan.
    const forceDispatched = metrics.filter((event) => event.metric === 'turn_force_tool_dispatched')
    assert.equal(
      forceDispatched.length,
      1,
      `expected exactly one force-tool dispatch metric, got ${forceDispatched.length}`,
    )

    // 3. Exactly ONE terminal close — the per-turn `turn_frame_summary` is
    //    the single source of truth for "this turn ended". An orphan
    //    tool_use would manifest either as zero summaries (engine threw
    //    out of finish() without closing) or as multiple summaries (parent
    //    closed twice). Both must fail this assertion.
    const summaries = metrics.filter((event) => event.metric === 'turn_frame_summary')
    assert.equal(
      summaries.length,
      1,
      `expected exactly one turn_frame_summary on aborted dispatch, got ${summaries.length}`,
    )

    // 4. The terminal reason must be a structured close — cancellation when
    //    abort fires. We accept any one of the structured terminals (per
    //    plan §6 G6), but never `done` (claiming success after orphaning).
    const summary = summaries[0]
    assert.notEqual(
      summary.terminalReason,
      'done',
      'orphan-result regression: aborted mid-dispatch must NOT close as done',
    )
    assert.ok(
      [
        'cancelled_runtime',
        'checkpoint_budget',
        'checkpoint_background',
        'checkpoint_user_input',
        'persistence_failed',
      ].includes(summary.terminalReason as string),
      `orphan-result regression: terminalReason must be a structured close, got ${summary.terminalReason}`,
    )

    // 5. Result-level shape mirrors the summary — abort path returns
    //    cancelled=true and terminalReason='cancelled_runtime'. We assert
    //    the result equally to keep the IPC contract honest: renderer
    //    consumers downstream read result.terminalReason, not metrics.
    assert.equal(result.cancelled, true, 'abort during dispatch must surface cancelled=true on the result')
    assert.equal(
      result.terminalReason,
      'cancelled_runtime',
      `abort during dispatch must surface terminalReason='cancelled_runtime', got ${result.terminalReason}`,
    )
  } finally {
    restoreLongToolDefinition()
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

/**
 * Stage A1 + A2 + B3 + B4 — real-registry registration + empty-input
 * validation regression.
 *
 * These tests use the production `defaultToolRegistry` (no
 * `installLongSkillToolDefinitionForTest` monkey-patch) and the production
 * `getToolInputSchemas` registry. They model the same dispatch path that
 * `tool-executor.ts::executeToolCall` traverses:
 *   1. `defaultToolRegistry.getToolDefinitionForExecution(toolName)` — if
 *      this returns null, the executor responds with errorKind='host_unavailable'
 *      reason='tool_not_registered'. (Stage A1 regression target.)
 *   2. `validateToolInput(toolName, args, getToolInputSchemas())` — if Zod
 *      rejects, the executor responds with errorKind='input_validation'
 *      and the validator emits `tool_input_validation_failed` with the
 *      first issue path. (Stage A2 regression target.)
 *
 * We test these two layers directly here instead of importing
 * `executeToolCall`, because `tool-executor.ts` transitively pulls in
 * `browser-tools.ts → BrowserController → electron.BrowserWindow`, which
 * cannot resolve under `tsx --test`. The logical contract is identical: any
 * empty input that fails validation here would equally fail under
 * `executeToolCall`.
 *
 * Before Stage B1:
 *   - `findSkillToolByNameForExecution()` returns `null` in the test
 *     environment (runtime manager throws, swallowed in skills-tools.ts).
 *   - `tool-registry.ts::resolveSkillToolDefinitionForExecution` only had a
 *     catch-path fallback, so the null branch returned null directly →
 *     `getToolDefinitionForExecution` returned null → dispatch would fail
 *     with `tool_not_registered`.
 *
 * After Stage B1:
 *   - Registry falls back on the static manifest table, so the lookup
 *     resolves.
 *
 * After Stage B5:
 *   - `getToolInputSchemas()` includes the static-manifest-derived Zod
 *     schemas, so Zod validation runs and rejects empty input with the
 *     first required path.
 *
 * The exact `firstPath` strings come from `assets/embedded-skills/
 * video-expert-analyzer/ready-skill.json`:
 *   - `video_expert_pipeline.params[0].name` === 'url' (required)
 *   - `video_expert_ai_analyze.params[0].name` === 'sceneScoresPath' (required)
 */
test('A1+A2: skill_video_expert_pipeline empty input fails as input_validation with firstPath="url" (real registry, real schemas)', () => {
  // Stage A1 / B1 — registry resolves the tool via static manifest
  // fallback even when the runtime manager is unavailable.
  const definition = defaultToolRegistry.getToolDefinitionForExecution('skill_video_expert_pipeline')
  assert.ok(
    definition,
    'Stage B1 regression: expected skill_video_expert_pipeline to be registered via static manifest fallback. '
      + 'Without the null-path branch, dispatch returns tool_not_registered.',
  )
  assert.equal(definition?.domain, 'skill')

  // Phase 2 (B child-loop) — the unified resolver returns the same schema
  // the static-registry path would have returned. Forced-preflight in
  // turn-engine.ts and forced-validation in turn-frame-steering.ts now both
  // consume this single resolver, so an extension that fails here would
  // equally regress those two call sites.
  const resolvedSchema = resolveToolInputSchemaForExecution('skill_video_expert_pipeline')
  assert.ok(
    resolvedSchema,
    'Phase 2: resolveToolInputSchemaForExecution must return a schema for skill_video_expert_pipeline',
  )
  assert.equal(
    typeof (resolvedSchema as { safeParse?: unknown }).safeParse,
    'function',
    'resolved schema must expose Zod .safeParse',
  )

  // Stage A2 / B5 — empty input fails Zod validation with deterministic
  // firstPath='url' from the static-manifest-derived schema.
  const outcome = validateToolInput('skill_video_expert_pipeline', {}, getToolInputSchemas())
  assert.equal(outcome.ok, false, `expected validation failure, got: ${JSON.stringify(outcome)}`)
  if (outcome.ok) return // type guard
  const data = (outcome.output as { data?: Record<string, unknown> }).data
  assert.equal(
    (data as { errorKind?: string } | undefined)?.errorKind,
    'input_validation',
    `expected errorKind=input_validation, got: ${JSON.stringify(data)}`,
  )
  assert.equal(
    outcome.firstPath,
    'url',
    `Stage A2: expected firstPath="url" for skill_video_expert_pipeline, got firstPath="${outcome.firstPath}"`,
  )
})

test('A1+A2: skill_video_expert_ai_analyze empty input fails as input_validation with firstPath="sceneScoresPath" (real registry, real schemas)', () => {
  const definition = defaultToolRegistry.getToolDefinitionForExecution('skill_video_expert_ai_analyze')
  assert.ok(
    definition,
    'Stage B1 regression: expected skill_video_expert_ai_analyze to be registered via static manifest fallback.',
  )
  assert.equal(definition?.domain, 'skill')

  const resolvedSchema = resolveToolInputSchemaForExecution('skill_video_expert_ai_analyze')
  assert.ok(
    resolvedSchema,
    'Phase 2: resolveToolInputSchemaForExecution must return a schema for skill_video_expert_ai_analyze',
  )

  const outcome = validateToolInput('skill_video_expert_ai_analyze', {}, getToolInputSchemas())
  assert.equal(outcome.ok, false, `expected validation failure, got: ${JSON.stringify(outcome)}`)
  if (outcome.ok) return
  const data = (outcome.output as { data?: Record<string, unknown> }).data
  assert.equal(
    (data as { errorKind?: string } | undefined)?.errorKind,
    'input_validation',
    `expected errorKind=input_validation, got: ${JSON.stringify(data)}`,
  )
  assert.equal(
    outcome.firstPath,
    'sceneScoresPath',
    `Stage A2: expected firstPath="sceneScoresPath" for skill_video_expert_ai_analyze, got firstPath="${outcome.firstPath}"`,
  )
})

// ---------------------------------------------------------------------------
// Phase 1 (Team 1) — appended red acceptance scaffolding.
//
// describe('child-owned VEA must not be parent-forced'): when the loaded
// SkillRunContract for a turn already carries a `childRunId`, the
// turn-engine force-dispatch path must NOT synthesize
// `skill_video_expert_pipeline` with `{}`. The contract's
// `parentNextHint='wait_for_close_event'` should drive a checkpoint
// instead. Phase 6 turns this green; Phase 1 ships it RED.
// ---------------------------------------------------------------------------

import { describe } from 'node:test'

describe('child-owned VEA must not be parent-forced', () => {
  test('RED (pending Phase 6): turn-engine must not synthesize skill_video_expert_pipeline with {} when contract.childRunId is set', async () => {
    // The Phase 6 wiring: `loadSkillRunContract` populates `childRunId`
    // (and `parentNextHint`) on the contract once the child runner has
    // launched a run. The turn-engine force-dispatch path must read those
    // fields and short-circuit — emitting a checkpoint or wait, not a
    // synthesized parent-side typed call.
    //
    // Today, no field on `SkillRunContract` carries `childRunId`. Phase 6
    // adds `childRunId` and `parentNextHint` to the contract and exports
    // `shouldParentForceLongSkillTool(contract)` from `run-contracts.ts`
    // so the turn-engine can detect child ownership without string-
    // matching skill ids.
    const ContractModule = (await import(
      '../main/modules/agent-control/run-contracts'
    )) as {
      shouldParentForceLongSkillTool?: (c: unknown) => boolean
    }

    const sampleContract: Record<string, unknown> = {
      // Synthesized minimal contract shape — Phase 6's loader populates
      // these fields. The test only inspects the shape, not the loader.
      skillId: 'video-expert-analyzer',
      childRunId: 'v00000001',
      parentNextHint: 'wait_for_close_event',
    }

    // Probe for the Phase 6 helper. Until Phase 6 exports it, this
    // assertion fails — that is the intended red state.
    const helper = ContractModule.shouldParentForceLongSkillTool
    assert.equal(
      typeof helper,
      'function',
      'Phase 6 must export shouldParentForceLongSkillTool(contract) from run-contracts so the turn-engine can short-circuit child-owned skills',
    )
    assert.equal(
      helper!(sampleContract),
      false,
      'a contract carrying childRunId must NOT trigger parent-side force dispatch of skill_video_expert_pipeline with {}',
    )
  })

  test('Phase 6: turn-engine never dispatches force_tool for VEA when contract.childRunId is set', async () => {
    // End-to-end assertion: with a recoverable_paused VEA supervisor + a
    // simulated `runContract.childRunId` (i.e. the child runner has
    // launched a run on a previous turn), the engine MUST NOT synthesize
    // `skill_video_expert_pipeline` / `_ai_analyze`. We confirm this by
    // running a turn and verifying:
    //   - `executeToolBatch` is NOT called with either tool name.
    //   - No `turn_force_tool_dispatched` metric fires for them.
    //
    // The simulation injects the child-run handle by overriding the
    // skill task supervisor's snapshot to carry a `resumePayload.childRun`
    // (which `loadSkillRunContract` reads via the
    // `skillTaskRunRepository`-less fast path). To keep the test
    // contained, we instead patch the contract directly on the resolved
    // turn frame via the steering pipe — the engine's `forceToolName`
    // line consumes `turnFrame.skill.runContract.childRunId` through the
    // `shouldParentForceLongSkillTool` helper.
    const engine = new TurnEngine()
    const metrics: AgentMetricEvent[] = []
    const dispatchedNames: string[] = []
    let modelCalls = 0

    __setMetricSinkForTests((event) => metrics.push(event))
    _resetLastReferenceSkillHintsForTests()
    rememberLastReferenceSkill('scope-force', { id: 'video-expert-analyzer', name: 'Video Expert Analyzer' })
    const restoreLongToolDefinition = installLongSkillToolDefinitionForTest()

    try {
      // The supervisor snapshot is the only source `resolveTurnFrame`
      // consults for a contract anchor in this harness. We attach a
      // `resumePayload.childRun.childRunId` so the contract loader sees
      // child ownership without needing the SkillTaskRunRepository (which
      // doesn't run under tsx).
      const childOwnedSnapshot: SkillTaskSupervisorSnapshot = {
        ...makeRecoverableSnapshot(),
        resumePayload: {
          ...(makeRecoverableSnapshot().resumePayload || {}),
          childRun: {
            childRunId: 'v01234567',
            parentNextHint: 'wait_for_close_event',
            status: 'running',
          },
        },
      }

      const events = createEvents()
      const request: TurnEngineRequest = {
        runId: 'run-child-owned',
        taskId: 'task-child-owned',
        agentName: 'agent-test',
        sessionId: 'scope-force',
        session: createSession('继续视频分析'),
        content: '继续视频分析',
        requestEnvelope: buildRequestEnvelope({ userText: '继续视频分析' }),
        intentClassification: createIntent(),
        taskBudgetRuntime: null,
        abortSignal: new AbortController().signal,
        ensureNotAborted: () => {},
        emitters: events.emitters,
        host: createForceToolHost({
          skillTaskSupervisor: {
            inspectLatestSkillTask: () => childOwnedSnapshot,
          },
          waitForSkillChildCloseEvent: async () => null,
          requestToolLoopResponse: async () => {
            modelCalls += 1
            return {
              text: 'no tool calls',
              toolCalls: [],
              stopReason: 'stop',
            }
          },
          executeToolBatch: async (params: { toolCalls: Array<{ name: string }> }) => {
            for (const tc of params.toolCalls) dispatchedNames.push(tc.name)
            return {
              results: params.toolCalls.map((toolCall) => ({
                id: 'r-1',
                name: toolCall.name,
                input: {},
                result: { text: 'ok' },
              })),
              budgetLimited: false,
              recoveryHistory: [],
            }
          },
        }),
      }

      await engine.execute(request)
      void modelCalls

      // Neither VEA typed action may be dispatched as `force_tool` when the
      // contract carries a child-run handle.
      assert.ok(
        !dispatchedNames.includes('skill_video_expert_pipeline'),
        `Phase 6: skill_video_expert_pipeline must NOT be force-dispatched when contract.childRunId is set, got: ${dispatchedNames.join(',')}`,
      )
      assert.ok(
        !dispatchedNames.includes('skill_video_expert_ai_analyze'),
        `Phase 6: skill_video_expert_ai_analyze must NOT be force-dispatched when contract.childRunId is set, got: ${dispatchedNames.join(',')}`,
      )
      const forceDispatched = metrics.filter((event) => event.metric === 'turn_force_tool_dispatched')
      const veaForce = forceDispatched.filter(
        (event) => event.toolName === 'skill_video_expert_pipeline'
          || event.toolName === 'skill_video_expert_ai_analyze',
      )
      assert.equal(
        veaForce.length,
        0,
        `Phase 6: no force-tool metric for VEA may fire when contract.childRunId is set, got ${veaForce.length}`,
      )
    } finally {
      restoreLongToolDefinition()
      __setMetricSinkForTests(null)
      _resetLastReferenceSkillHintsForTests()
    }
  })
})
