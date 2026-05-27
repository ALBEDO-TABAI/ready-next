import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import { RunCoordinator } from '../main/modules/agent-control/task-projection/run-coordinator'
import { RunProjection } from '../main/modules/agent-control/task-projection/run-projection'
import { syncTaskProjection } from '../main/modules/agent-control/task-projection/task-projection-sync'
import { buildBudgetWarningMessage, renderChildCommandOutcome, TurnEngine } from '../main/modules/agent-control/turn-engine'
import { SkillTaskSupervisor, type SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skills/skill-task-supervisor'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import {
  rememberLastReferenceSkill,
  _resetLastReferenceSkillHintsForTests,
} from '../main/modules/agent-control/skills/skill-reference-hints'
import { defaultToolRegistry } from '../main/modules/agent-control/tools-runtime/tool-registry'
import type { IntentClassification } from '../main/modules/agent-control/intent-classifier'
import type { DomainAdapter } from '../main/modules/agent-control/domain-adapters/domain-adapter'
import type { ConversationScope, ScopeRunEventPayload, ScopeRunSummary } from '../main/modules/agent-control/contracts/types'
import type { RunBudgetSeed, RunBudgetUsage, TaskProjectionRecord, TaskProjectionStore, TurnEngineRequest, TurnEngineSession, TurnTranscriptEvent } from '../main/modules/agent-control/contracts/run-contracts'
import type { TurnTerminalReason } from '../main/modules/agent-control/runtime-core/turn-frame'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import type { SkillChildCloseEvent } from '../main/modules/agent-control/skills/skill-child-run-types'

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

function makeSkillSnapshot(overrides?: Partial<SkillTaskSupervisorSnapshot>): SkillTaskSupervisorSnapshot {
  const progress = overrides?.progress || {}
  return {
    taskRunId: 'str-loop',
    detachedTaskId: 'dst-loop',
    skillId: 'video-expert-analyzer',
    scopeId: 'scope-test',
    sessionId: 'scope-test',
    action: 'video_expert_pipeline',
    status: 'running',
    liveness: 'background',
    hasLiveWork: true,
    hasRecentProgress: true,
    closeAllowed: false,
    ambiguous: false,
    stale: false,
    outputDir: '/tmp/ready/output',
    runStatePath: '/tmp/ready/output/run_state.json',
    sceneScoresPath: '/tmp/ready/output/scene_scores.json',
    deliveryReportPath: '/tmp/ready/output/delivery_report.json',
    progress: {
      currentStage: 'score_batches',
      totalScenes: 120,
      completedScenes: 0,
      coverageRatio: 0,
      updatedAt: '2026-04-28T02:00:00.000Z',
      ...progress,
    },
    blockers: [],
    pauseReason: null,
    resumePayload: {
      taskRunId: 'str-loop',
      detachedTaskId: 'dst-loop',
      outputDir: '/tmp/ready/output',
      runStatePath: '/tmp/ready/output/run_state.json',
    },
    sourceObservations: [],
    progressFingerprint: 'fp-loop',
    observedAt: '2026-04-28T02:00:00.000Z',
    lastProgressAt: '2026-04-28T02:00:00.000Z',
    ...overrides,
  }
}

function makeChildCloseEvent(
  status: SkillChildCloseEvent['status'],
  terminalReason: SkillChildCloseEvent['terminalReason'],
): SkillChildCloseEvent {
  return {
    childRunId: 'vchild001',
    skillId: 'video-expert-analyzer',
    status,
    terminalReason,
    outputDir: '/tmp/ready/output',
    runStatePath: '/tmp/ready/output/run_state.json',
    sceneScoresPath: '/tmp/ready/output/scene_scores.json',
    deliveryReportPath: '/tmp/ready/output/delivery_report.json',
    progress: {
      stage: 'score_batches',
      totalUnits: 120,
      completedUnits: 12,
      coverageRatio: 0.1,
      fingerprint: 'score_batches:12/120',
    },
    framePatch: null,
    projectionPatch: null,
    error: status === 'blocked'
      ? { kind: 'blocked_external', message: 'waiting for external input' }
      : null,
  }
}

function makeChildOwnedSnapshot(params: {
  status: SkillChildCloseEvent['status'] | 'running'
  closeEvent?: SkillChildCloseEvent | null
}): SkillTaskSupervisorSnapshot {
  return makeSkillSnapshot({
    status: params.status === 'running' ? 'running' : params.status as SkillTaskSupervisorSnapshot['status'],
    liveness: params.status === 'running' ? 'background' : null,
    hasLiveWork: params.status === 'running',
    hasRecentProgress: false,
    pauseReason: params.status === 'budget_paused' ? 'budget_exhausted' : null,
    resumePayload: {
      childRun: {
        version: 1,
        childRunId: 'vchild001',
        kind: 'vea',
        parentScopeId: 'scope-test',
        parentSessionId: 'scope-test',
        skillId: 'video-expert-analyzer',
        skillName: 'Video Expert Analyzer',
        requestedAction: 'video_expert_pipeline',
        requestedInput: { url: 'https://example.com/video.mp4', outputDir: '/tmp/ready/output' },
        singleFlightKey: 'scope-test|scope-test|video-expert-analyzer|video',
        parentNextHint: 'wait_for_close_event',
        outputDir: '/tmp/ready/output',
        runStatePath: '/tmp/ready/output/run_state.json',
        eventLogPath: '/tmp/ready/output/child-run.jsonl',
        status: params.status,
        closeEvent: typeof params.closeEvent === 'undefined' ? null : params.closeEvent,
      },
    },
  })
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

test('budget_paused child resumes through TurnEngine without presenting the running child as done', async () => {
  const engine = new TurnEngine()
  const calls: string[] = []
  const waits: Array<{ childRunId: string; timeoutMs: number }> = []
  const close = makeChildCloseEvent('budget_paused', 'checkpoint_budget')
  const { request } = createRequest({
    userText: '继续',
    host: {
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => makeChildOwnedSnapshot({ status: 'budget_paused', closeEvent: close }),
      },
      resumeSkillChildRun: async (childRunId: string) => {
        calls.push(childRunId)
        return {
          childRunId,
          status: 'running',
          outputDir: '/tmp/ready/output',
          runStatePath: '/tmp/ready/output/run_state.json',
          eventLogPath: '/tmp/ready/output/child-run.jsonl',
          parentNextHint: 'wait_for_close_event',
          closeEvent: null,
        }
      },
      waitForSkillChildCloseEvent: async (childRunId: string, timeoutMs: number) => {
        waits.push({ childRunId, timeoutMs })
        return null
      },
    },
  })

  const result = await engine.execute(request)

  assert.deepEqual(calls, ['vchild001'])
  assert.deepEqual(waits, [{ childRunId: 'vchild001', timeoutMs: 1_500 }])
  assert.equal(result.status, 'checkpoint')
  assert.equal(result.terminalReason, 'checkpoint_background')
  assert.match(result.finalText, /已继续/)
})

test('recoverable_paused child resumes through TurnEngine without sleeping in tests', async () => {
  const engine = new TurnEngine()
  const calls: string[] = []
  const waits: Array<{ childRunId: string; timeoutMs: number }> = []
  const close = makeChildCloseEvent('recoverable_paused', 'checkpoint_background')
  const { request } = createRequest({
    userText: '继续',
    host: {
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => makeChildOwnedSnapshot({ status: 'recoverable_paused', closeEvent: close }),
      },
      resumeSkillChildRun: async (childRunId: string) => {
        calls.push(childRunId)
        return {
          childRunId,
          status: 'running',
          outputDir: '/tmp/ready/output',
          runStatePath: '/tmp/ready/output/run_state.json',
          eventLogPath: '/tmp/ready/output/child-run.jsonl',
          parentNextHint: 'wait_for_close_event',
          closeEvent: null,
        }
      },
      waitForSkillChildCloseEvent: async (childRunId: string, timeoutMs: number) => {
        waits.push({ childRunId, timeoutMs })
        return null
      },
    },
  })

  const result = await engine.execute(request)

  assert.deepEqual(calls, ['vchild001'])
  assert.deepEqual(waits, [{ childRunId: 'vchild001', timeoutMs: 1_500 }])
  assert.equal(result.status, 'checkpoint')
  assert.equal(result.terminalReason, 'checkpoint_background')
  assert.match(result.finalText, /同一个 child run/)
})

test('blocked_config child is not directly resumable', async () => {
  const engine = new TurnEngine()
  let resumeCalls = 0
  const close = makeChildCloseEvent('blocked', 'blocked_config')
  const { request } = createRequest({
    userText: '继续',
    host: {
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => makeChildOwnedSnapshot({ status: 'blocked', closeEvent: close }),
      },
      resumeSkillChildRun: async () => {
        resumeCalls += 1
        throw new Error('blocked child must not resume')
      },
    },
  })

  const result = await engine.execute(request)

  assert.equal(resumeCalls, 0)
  assert.equal(result.status, 'checkpoint')
  assert.match(result.finalText, /不能直接继续/)
  assert.equal(result.terminalReason, 'blocked_config')
})

test('blocked_external child resume is delegated to runner with agent context', async () => {
  const engine = new TurnEngine()
  let resumeCalls = 0
  let capturedAgentContext: unknown = null
  const close = makeChildCloseEvent('blocked', 'blocked_external')
  const { request } = createRequest({
    userText: '继续',
    host: {
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => makeChildOwnedSnapshot({ status: 'blocked', closeEvent: close }),
      },
      resumeSkillChildRun: async (_childRunId: string, options?: { agentContext?: unknown }) => {
        resumeCalls += 1
        capturedAgentContext = options?.agentContext ?? null
        return {
          childRunId: 'vchild001',
          status: 'completed',
          outputDir: '/tmp/ready/output',
          runStatePath: '/tmp/ready/output/run_state.json',
          eventLogPath: '/tmp/ready/output/child-run.jsonl',
          parentNextHint: 'wait_for_close_event',
          freshContractFields: null,
          closeEvent: makeChildCloseEvent('completed', 'completed'),
        }
      },
    },
  })

  const result = await engine.execute(request)

  assert.equal(resumeCalls, 1)
  assert.equal((capturedAgentContext as { model_id?: string } | null)?.model_id, 'gpt-test')
  assert.equal(result.status, 'done')
  assert.equal(result.terminalReason, 'done')
})

test('running child self-await uses injectable wait and preserves blocked terminal reason', async () => {
  const engine = new TurnEngine()
  let modelCalls = 0
  const waits: Array<{ childRunId: string; timeoutMs: number }> = []
  const activeSnapshot = makeChildOwnedSnapshot({ status: 'running', closeEvent: null })
  const close = makeChildCloseEvent('blocked', 'blocked_config')
  const { request, events } = createRequest({
    userText: '继续',
    host: {
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => activeSnapshot,
      },
      requestToolLoopResponse: async () => {
        modelCalls += 1
        return {
          text: 'model should not run',
          toolCalls: [],
          stopReason: 'stop',
        }
      },
      waitForSkillChildCloseEvent: async (childRunId: string, timeoutMs: number) => {
        waits.push({ childRunId, timeoutMs })
        return close
      },
    },
  })

  const result = await engine.execute(request)

  assert.equal(modelCalls, 0)
  assert.deepEqual(waits, [{ childRunId: 'vchild001', timeoutMs: 1_500 }])
  assert.equal(result.status, 'checkpoint')
  assert.equal(result.terminalReason, 'blocked_config')
  assert.deepEqual(
    events
      .filter((event) => event.kind === 'status')
      .map((event) => ({ status: event.status, terminalReason: event.terminalReason }))
      .at(-1),
    { status: 'checkpoint', terminalReason: 'blocked_config' },
  )
})

test('running child checkpoints background instead of asking model when self-await times out', async () => {
  const engine = new TurnEngine()
  let modelCalls = 0
  const waits: Array<{ childRunId: string; timeoutMs: number }> = []
  const activeSnapshot = makeChildOwnedSnapshot({ status: 'running', closeEvent: null })
  const { request } = createRequest({
    userText: '看看进度',
    host: {
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => activeSnapshot,
      },
      requestToolLoopResponse: async () => {
        modelCalls += 1
        return {
          text: 'model should not be asked while child run is still active',
          toolCalls: [],
          stopReason: 'stop',
        }
      },
      waitForSkillChildCloseEvent: async (childRunId: string, timeoutMs: number) => {
        waits.push({ childRunId, timeoutMs })
        return null
      },
    },
  })

  const result = await engine.execute(request)

  assert.equal(modelCalls, 0)
  assert.deepEqual(waits, [{ childRunId: 'vchild001', timeoutMs: 1_500 }])
  assert.equal(result.status, 'checkpoint')
  assert.equal(result.terminalReason, 'checkpoint_background')
  assert.match(result.finalText, /后台仍在运行/)
})

test('TurnEngine self-awaits a same-turn launched child before asking the model again', async () => {
  const engine = new TurnEngine()
  let modelCalls = 0
  const waits: Array<{ childRunId: string; timeoutMs: number }> = []
  const close = {
    ...makeChildCloseEvent('blocked', 'blocked_config'),
    childRunId: 'vchild-launch',
    error: { kind: 'blocked_config', message: 'provider vision preflight blocked' },
  } as SkillChildCloseEvent
  const veaSkill = {
    id: 'video-expert-analyzer',
    name: 'Video Expert Analyzer (VNext)',
    actions: [{
      name: 'video_expert_pipeline',
      visibility: 'internal',
      params: [{ name: 'url', required: true }],
    }],
    hostRequirements: {
      expose_when_hint_armed: ['video_expert_pipeline'],
    },
  }

  _resetLastReferenceSkillHintsForTests()
  const restorePipelineToolDefinition = installLongSkillToolDefinitionForTest('skill_video_expert_pipeline')
  try {
    const { request } = createRequest({
      userText: '使用 Video Expert Analyzer 分析 https://example.com/video.mp4，输出到测试目录',
      intentClassification: createIntent({ primaryDomain: 'skill', confidence: 'high' }),
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
          shouldKeepToolsWithVideo: () => true,
          findExplicitlyRequestedSkills: (text: string) =>
            /video[-_\s]?expert|Video Expert Analyzer/i.test(text) ? [veaSkill] : [],
          getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'Video Expert Analyzer (VNext)' }),
          rememberExplicitReferenceSkillHint: () => {
            rememberLastReferenceSkill('scope-test', { id: 'video-expert-analyzer', name: 'Video Expert Analyzer (VNext)' })
            return true
          },
          buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer', 'Video Expert Analyzer'],
        },
        requestToolLoopResponse: async () => {
          modelCalls += 1
          if (modelCalls === 1) {
            return {
              text: '准备启动 pipeline',
              toolCalls: [{
                id: 'tool-vea',
                name: 'skill_video_expert_pipeline',
                input: { url: 'https://example.com/video.mp4', outputDir: '/tmp/ready/output' },
              }],
              stopReason: 'tool_calls',
              toolTransport: 'native',
            }
          }
          return {
            text: 'model should not be asked again after child launch',
            toolCalls: [],
            stopReason: 'stop',
            toolTransport: 'native',
          }
        },
        executeToolBatch: async () => ({
          results: [{
            id: 'tool-vea',
            name: 'skill_video_expert_pipeline',
            input: { url: 'https://example.com/video.mp4', outputDir: '/tmp/ready/output' },
            result: {
              text: '{"status":"child_launched","childRunId":"vchild-launch"}',
              framePatch: {
                activeArtifactRoots: ['/tmp/ready/output'],
                livenessHint: 'running_process',
                runContract: {
                  skillId: 'video-expert-analyzer',
                  skillName: 'Video Expert Analyzer (VNext)',
                  toolName: 'skill_video_expert_pipeline',
                  action: 'video_expert_pipeline',
                  actionInput: { url: 'https://example.com/video.mp4', outputDir: '/tmp/ready/output' },
                  originalInput: { url: 'https://example.com/video.mp4', outputDir: '/tmp/ready/output' },
                  sourceUrl: 'https://example.com/video.mp4',
                  outputDir: '/tmp/ready/output',
                  runStatePath: '/tmp/ready/output/run_state.json',
                  artifactRoots: ['/tmp/ready/output'],
                  artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
                  status: 'running',
                  liveness: 'running_process',
                  childRunId: 'vchild-launch',
                  childStatus: 'running',
                  parentNextHint: 'wait_for_close_event',
                },
              },
            },
          }],
          budgetLimited: false,
          recoveryHistory: [],
        }),
        waitForSkillChildCloseEvent: async (childRunId: string, timeoutMs: number) => {
          waits.push({ childRunId, timeoutMs })
          return close
        },
      },
    })

    const result = await engine.execute(request)

    assert.equal(modelCalls, 1)
    assert.deepEqual(waits, [{ childRunId: 'vchild-launch', timeoutMs: 1_500 }])
    assert.equal(result.status, 'checkpoint')
    assert.equal(result.terminalReason, 'blocked_config')
  } finally {
    restorePipelineToolDefinition()
    _resetLastReferenceSkillHintsForTests()
  }
})

test('child cancel from TurnEngine writes cancelled_user only for explicit user cancel', async () => {
  const engine = new TurnEngine()
  const cancelReasons: string[] = []
  const activeSnapshot = makeChildOwnedSnapshot({ status: 'running', closeEvent: null })
  const { request: continueRequest } = createRequest({
    userText: '继续',
    host: {
      maxToolIterations: 1,
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => activeSnapshot,
      },
      cancelSkillChildRun: async (_childRunId: string, options?: { reason?: string; source?: string }) => {
        cancelReasons.push(`${options?.reason || ''}:${options?.source || ''}`)
        return makeChildCloseEvent('killed', 'cancelled_user')
      },
      waitForSkillChildCloseEvent: async () => null,
    },
  })
  await engine.execute(continueRequest)
  assert.deepEqual(cancelReasons, [], 'observer/wait path must not cancel the child')

  const { request: cancelRequest } = createRequest({
    userText: '取消',
    host: {
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => activeSnapshot,
      },
      cancelSkillChildRun: async (childRunId: string, options?: { reason?: string; source?: string }) => {
        cancelReasons.push(`${childRunId}:${options?.reason || ''}:${options?.source || ''}`)
        return makeChildCloseEvent('killed', 'cancelled_user')
      },
    },
  })
  const result = await engine.execute(cancelRequest)

  assert.deepEqual(cancelReasons, ['vchild001:cancelled_user:nlp'])
  assert.equal(result.status, 'cancelled')
  assert.equal(result.terminalReason, 'cancelled_user')
})

test('terminal runtime errors do not emit a done output event', async () => {
  const engine = new TurnEngine()
  const { request, events } = createRequest({
    userText: '触发失败',
    host: {
      requestSimpleText: async () => {
        throw new Error('model transport failed')
      },
    },
  })

  const result = await engine.execute(request)
  const outputTypes = events
    .filter((event) => event.kind === 'output')
    .map((event) => event.type)

  assert.equal(result.status, 'error')
  assert.equal(outputTypes.at(-1), 'error')
  assert.ok(!outputTypes.includes('done'), `error path must not emit done, got ${outputTypes.join(',')}`)
})

test('budget warning does not mention typed skill action', () => {
  const warning = buildBudgetWarningMessage({
    iterations: 56,
    effectiveMaxIterations: 80,
    level: 'warning',
    isLongSkillContext: true,
  })
  const converge = buildBudgetWarningMessage({
    iterations: 76,
    effectiveMaxIterations: 80,
    level: 'converge',
    isLongSkillContext: true,
  })

  assert.ok(!/typed skill action/i.test(warning))
  assert.ok(!/typed skill action/i.test(converge))
})

test('TurnEngine injects 70 percent budget reminder immediately before the model call that consumes it', async () => {
  const engine = new TurnEngine()
  const capturedMessages: TurnEngineSessionMessage[][] = []
  let loopPass = 0
  const { request } = createRequest({
    userText: '帮我修改这段文档',
    intentClassification: createIntent({
      primaryDomain: 'document',
      mentionedDomains: ['document'],
      objectSignals: ['document-object'],
      actionSignals: ['document-action'],
      confidence: 'high',
    }),
    budget: {
      maxIterations: 3,
      maxToolCalls: 3,
      maxParallelToolGroups: 3,
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
      requestToolLoopResponse: async (params: { session: TurnEngineSession }) => {
        capturedMessages.push(params.session.messages.map((message) => ({ ...message })))
        loopPass += 1
        if (loopPass === 1) {
          return {
            text: '先查一下',
            toolCalls: [{ id: 'tool-1', name: 'document_replace_text', input: { text: 'step one' } }],
            stopReason: 'tool_calls',
          }
        }
        return {
          text: '完成',
          toolCalls: [],
          stopReason: 'stop',
        }
      },
      executeToolBatch: async () => ({
        results: [{
          id: 'tool-1',
          name: 'document_replace_text',
          input: { text: 'step one' },
          result: { text: 'saved' },
        }],
        budgetLimited: false,
        recoveryHistory: [],
      }),
    },
  })

  await engine.execute(request)

  assert.equal(capturedMessages.length, 2)
  assert.equal(
    capturedMessages[0].some((message) =>
      typeof message.content === 'string' && message.content.includes('系统提醒：已用 2/3 次工具调用'),
    ),
    false,
  )
  assert.equal(
    capturedMessages[1].at(-1)?.content,
    buildBudgetWarningMessage({
      iterations: 2,
      effectiveMaxIterations: 3,
      level: 'warning',
      isLongSkillContext: false,
    }),
  )
})

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

test('TurnEngine fires user_prompt_submit hook before direct model request', async () => {
  const engine = new TurnEngine()
  const calls: Array<{ userText: string; sessionId: string | null; timestamp: number }> = []
  let hookCallsBeforeModel = 0
  const { request } = createRequest({
    userText: '解释一下这个概念',
    host: {
      hookRegistry: {
        fire: async (name: string, payload: { userText: string; sessionId: string | null; timestamp: number }) => {
          if (name === 'user_prompt_submit') {
            calls.push(payload)
          }
        },
      },
      requestSimpleText: async () => {
        hookCallsBeforeModel = calls.length
        return { text: 'simple result' }
      },
    },
  })

  await engine.execute(request)

  assert.equal(hookCallsBeforeModel, 1)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.userText, '解释一下这个概念')
  assert.equal(calls[0]?.sessionId, 'scope-test')
  assert.equal(typeof calls[0]?.timestamp, 'number')
})

test('TurnEngine compacts string-only model session without mutating persisted messages', async () => {
  const engine = new TurnEngine()
  let modelMessages: TurnEngineSessionMessage[] = []
  const { request } = createRequest({
    userText: '请总结以上内容',
    host: {
      requestSimpleText: async (params: { session: TurnEngineSession }) => {
        modelMessages = params.session.messages.map((message) => ({ ...message }))
        return { text: 'simple result' }
      },
    },
  })
  request.session.messages = [
    { role: 'user', content: 'alpha '.repeat(6_000) },
    { role: 'assistant', content: 'bravo '.repeat(6_000) },
    { role: 'user', content: 'charlie '.repeat(6_000) },
    { role: 'assistant', content: 'delta '.repeat(6_000) },
    { role: 'user', content: 'echo '.repeat(6_000) },
  ]
  const originalMessages = request.session.messages.map((message) => ({ ...message }))

  await engine.execute(request)

  assert.ok(modelMessages.length < originalMessages.length)
  assert.equal(modelMessages[0]?.role, 'system')
  assert.match(String(modelMessages[0]?.content || ''), /\[ready:l1-compacted\]/)
  assert.deepEqual(request.session.messages.slice(0, originalMessages.length), originalMessages)
})

test('TurnEngine skips compaction when session contains rich content blocks', async () => {
  const engine = new TurnEngine()
  let modelMessages: TurnEngineSessionMessage[] = []
  const { request } = createRequest({
    userText: '描述图片',
    host: {
      requestSimpleText: async (params: { session: TurnEngineSession }) => {
        modelMessages = params.session.messages.map((message) => ({ ...message }))
        return { text: 'simple result' }
      },
    },
  })
  request.session.messages = [
    { role: 'user', content: 'alpha '.repeat(6_000) },
    { role: 'user', content: [{ type: 'image', mimeType: 'image/png', base64: 'abc' }] },
    { role: 'assistant', content: 'bravo '.repeat(6_000) },
    { role: 'user', content: 'charlie '.repeat(6_000) },
  ] as TurnEngineSessionMessage[]

  await engine.execute(request)

  assert.equal(modelMessages.length, 4)
  assert.deepEqual(modelMessages[1]?.content, [{ type: 'image', mimeType: 'image/png', base64: 'abc' }])
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
    arbitrateRunCapabilities: ({ route }) =>
      route?.chain === 'direct' ? null : { hideAssistantProcessText: true },
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

test('TurnEngine does not carry stale skill context into unrelated browser turns', async () => {
  const engine = new TurnEngine()
  let capturedAllowedToolNames: string[] = []
  let supervisorInspections = 0
  const browserAdapter: DomainAdapter = {
    id: 'browser',
    shouldHandle: ({ route }) => route.executor === 'browser',
    prepare: () => ({
      allowedToolNames: ['browser_search', 'browser_read_page'],
      sessionMessages: [],
      domainState: {},
    }),
    dispatch: async ({ domainState }) => ({ domainState }),
    applyResult: ({ phase, domainState }) => {
      if (phase === 'no_tool_call') {
        return { domainState, finalText: '天气查询已完成' }
      }
      return { domainState }
    },
    buildProjectionPatch: () => null,
  }

  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill('scope-test', { id: 'video-expert-analyzer', name: 'Video Expert Analyzer (VNext)' })
  const { request } = createRequest({
    userText: '广州未来两天天气怎么样',
    intentClassification: createIntent({
      primaryDomain: 'browser',
      mentionedDomains: ['browser'],
      objectSignals: ['weather'],
      actionSignals: ['query'],
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
      skillContextOrchestrator: {
        shouldKeepToolsWithVideo: () => false,
        findExplicitlyRequestedSkills: () => [],
        getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'Video Expert Analyzer (VNext)' }),
        rememberExplicitReferenceSkillHint: () => false,
        buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline', 'skill_video_expert_ai_analyze'],
        maybeInjectExplicitSkillContext: async () => {},
        listRegisteredSkillTokens: () => ['video-expert-analyzer', 'Video Expert Analyzer'],
      },
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => {
          supervisorInspections += 1
          return makeSkillSnapshot({
            status: 'blocked',
            liveness: 'blocked',
            hasLiveWork: false,
            hasRecentProgress: false,
          })
        },
      },
      requestToolLoopResponse: async (params: { allowedToolNames?: string[] }) => {
        capturedAllowedToolNames = params.allowedToolNames || []
        return {
          text: '我已经查询到天气。',
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    },
  })

  const result = await engine.execute(request)

  assert.equal(result.finalText, '天气查询已完成')
  assert.equal(supervisorInspections, 0, 'unrelated browser turns should not bind supervisor skill context')
  assert.deepEqual(
    capturedAllowedToolNames.filter((name) => name.startsWith('skill_')),
    [],
    `browser turn must not expose stale skill tools: ${capturedAllowedToolNames.join(',')}`,
  )
  _resetLastReferenceSkillHintsForTests()
})

test('TurnEngine recovers leaked text tool calls in the generic tool loop before treating the turn as no-tool', async () => {
  const engine = new TurnEngine()
  let loopPasses = 0
  let executedToolNames: string[] = []
  let capturedAllowedToolNames: string[] = []
  const { request } = createRequest({
    userText: '查一下文件',
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
      requestToolLoopResponse: async (params: { allowedToolNames?: string[] }) => {
        capturedAllowedToolNames = params.allowedToolNames || []
        loopPasses += 1
        if (loopPasses === 1) {
          return {
            text: '<tool_call><function=file_search><parameter=query>配置</parameter></function></tool_call>',
            toolCalls: [],
            stopReason: 'stop',
            toolTransport: 'native',
          }
        }
        return {
          text: '完成',
          toolCalls: [],
          stopReason: 'stop',
          toolTransport: 'native',
        }
      },
      executeToolBatch: async ({ toolCalls }: { toolCalls: Array<{ name: string }> }) => {
        executedToolNames = toolCalls.map((call) => call.name)
        return {
          results: toolCalls.map((call) => ({
            id: 'call-recovered',
            name: call.name,
            input: {},
            result: { text: 'page text' },
          })),
          budgetLimited: false,
          recoveryHistory: [],
        }
      },
    },
  })

  const result = await engine.execute(request)

  assert.deepEqual(executedToolNames, ['file_search'], `allowed tools: ${capturedAllowedToolNames.join(',')}`)
  assert.equal(result.finalText, '完成')
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
  assert.equal(
    request.session.messages.some((message) =>
      message.role === 'user'
      && String(message.content).includes('工具调用因参数损坏被丢弃')),
    false,
  )
})

test('TurnEngine injects provider corrupt args reminder and retries without leaking raw details', async () => {
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
        if (toolLoopRequests === 1) {
          return {
            text: '',
            toolCalls: [],
            stopReason: 'tool_calls',
            toolCallParseErrors: [
              {
                route: 'chat_completions',
                toolName: 'browser_search',
                callId: 'call_bad',
                reason: 'corrupt',
              },
            ],
          }
        }
        return {
          text: 'recovered final',
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    },
  })

  const result = await engine.execute(request)
  const reminderMessages = request.session.messages
    .filter((message) =>
      message.role === 'user'
      && String(message.content).includes('工具调用因参数损坏被丢弃'))
    .map((message) => String(message.content))

  assert.equal(toolLoopRequests, 2)
  assert.equal(result.finalText, 'recovered final')
  assert.equal(reminderMessages.length, 1)
  assert.match(reminderMessages[0], /上一轮有 1 个工具调用因参数损坏被丢弃/)
  assert.doesNotMatch(reminderMessages[0], /rawSample|arguments|callId/)
})

test('TurnEngine does not inject provider corrupt args reminder when parse errors are empty', async () => {
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
          toolCallParseErrors: [],
        }
      },
    },
  })

  const result = await engine.execute(request)

  assert.equal(toolLoopRequests, 1)
  assert.equal(result.finalText, 'tool loop finished')
  assert.equal(
    request.session.messages.some((message) =>
      message.role === 'user'
      && String(message.content).includes('工具调用因参数损坏被丢弃')),
    false,
  )
})

test('TurnEngine injects provider corrupt args reminder after executing mixed valid and corrupt tool calls', async () => {
  const engine = new TurnEngine()
  let toolLoopRequests = 0
  let executedBatches = 0
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
        if (toolLoopRequests === 1) {
          return {
            text: '',
            toolCalls: [{ id: 'tool-1', name: 'document_replace_text', input: { text: 'valid tool' } }],
            stopReason: 'tool_calls',
            toolCallParseErrors: [
              {
                route: 'responses',
                toolName: 'browser_search',
                callId: 'call_bad_1',
                reason: 'corrupt',
              },
              {
                route: 'responses',
                toolName: 'browser_read_page',
                callId: 'call_bad_2',
                reason: 'corrupt',
              },
            ],
          }
        }
        return {
          text: 'mixed recovered',
          toolCalls: [],
          stopReason: 'stop',
        }
      },
      executeToolBatch: async () => {
        executedBatches += 1
        return {
          results: [{
            id: 'tool-1',
            name: 'document_replace_text',
            input: { text: 'valid tool' },
            result: { text: 'saved' },
          }],
          budgetLimited: false,
          recoveryHistory: [],
        }
      },
    },
  })

  const result = await engine.execute(request)
  const reminderMessages = request.session.messages
    .filter((message) =>
      message.role === 'user'
      && String(message.content).includes('工具调用因参数损坏被丢弃'))
    .map((message) => String(message.content))

  assert.equal(executedBatches, 1)
  assert.equal(toolLoopRequests, 2)
  assert.equal(result.finalText, 'mixed recovered')
  assert.equal(reminderMessages.length, 1)
  assert.match(reminderMessages[0], /上一轮有 2 个工具调用因参数损坏被丢弃/)
  assert.doesNotMatch(reminderMessages[0], /rawSample|arguments|callId/)
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
        const preferTextBridge = params.preferTextToolBridgeOnce === true
        preferTextBridgeFlags.push(preferTextBridge)
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
            requestedTransport: preferTextBridge ? 'text' : 'native',
            effectiveTransport: preferTextBridge ? 'text' : 'native',
            supportsNativeTools: true,
            preferTextToolBridge: preferTextBridge,
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
            requestedTransport: preferTextBridge ? 'text' : 'native',
            effectiveTransport: 'text',
            supportsNativeTools: true,
            preferTextToolBridge: preferTextBridge,
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

test('TurnEngine treats retry-only armed long skill resumes as tool-loop runs with hard cap and lease budget', async () => {
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
    assert.equal(result.executionDiagnostics?.budget?.maxIterations, 20)
    assert.equal(result.executionDiagnostics?.budget?.maxToolCalls, 20)
    assert.equal(result.executionDiagnostics?.budgetLease?.currentLeaseEndIteration, 20)
    assert.ok(
      capturedAllowedToolNames.includes('skill_video_expert_pipeline'),
      `expected VEA pipeline in allowed tools, got: ${capturedAllowedToolNames.join(',')}`,
    )
    assert.ok(metrics.some((event) =>
      event.metric === 'preferred_skill_tools'
      && event.count >= 2
      && Array.isArray(event.tools)
      && event.tools.includes('skill_video_expert_pipeline'),
    ))
    assert.ok(metrics.some((event) =>
      event.metric === 'turn_frame_tool_policy'
      && Array.isArray(event.preferredToolNames)
      && event.preferredToolNames.includes('skill_video_expert_pipeline')
      && Array.isArray(event.allowedToolNames)
      && event.allowedToolNames.includes('skill_video_expert_pipeline'),
    ))
    assert.ok(metrics.some((event) => event.metric === 'skill_reference_hint_armed' && event.via === 'current'))
    assert.ok(logs.some((line) => line.includes('[skill_detection]')))
  } finally {
    restoreLongToolDefinition()
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

test('TurnEngine arms VEA continuation from an explicit run_state resource without same-session history', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  const logs: string[] = []
  let toolLoopRequests = 0
  let capturedAllowedToolNames: string[] = []
  let armedHint: { id: string; name: string } | null = null

  const outputDir = mkdtempSync(join(tmpdir(), 'ready-turn-run-state-resource-'))
  const sceneScoresPath = join(outputDir, 'scene_scores.json')
  const runStatePath = join(outputDir, 'run_state.json')
  writeFileSync(sceneScoresPath, '{"scenes":[]}', 'utf8')
  writeFileSync(
    runStatePath,
    JSON.stringify({
      version: 'vnext',
      status: 'running',
      current_stage: 'score_batches',
      scores_path: 'scene_scores.json',
      video_dir: outputDir,
      total_scenes: 97,
      completed_scenes: 0,
    }),
    'utf8',
  )
  const userText = [
    '继续，用 mimo-v2.5，输出到同一目录',
    '',
    '--- 引用文件: run_state.json ---',
    `- 路径: ${runStatePath}`,
    '- 类型: application/json',
    '--- 文档内容开始 ---',
    '{}',
    '--- 文档内容结束 ---',
  ].join('\n')

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  const restoreAiAnalyzeToolDefinition = installLongSkillToolDefinitionForTest('skill_video_expert_ai_analyze')
  try {
    const { request } = createRequest({
      userText,
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
          findExplicitlyRequestedSkills: (text: string) =>
            /video[-_\s]?expert|Video Expert Analyzer/i.test(text)
              ? [{ id: 'video-expert-analyzer', name: 'Video Expert Analyzer (VNext)' }]
              : [],
          getCurrentReferenceSkillHint: () => armedHint,
          rememberReferenceSkillFromRunStateResource: (skillId: string) => {
            if (skillId !== 'video-expert-analyzer') return { armed: false }
            armedHint = { id: 'video-expert-analyzer', name: 'Video Expert Analyzer (VNext)' }
            rememberLastReferenceSkill('scope-test', armedHint)
            return { armed: true, skillId: armedHint.id, skillName: armedHint.name }
          },
          rememberExplicitReferenceSkillHint: () => Boolean(armedHint),
          buildPreferredSkillToolNames: () => armedHint?.id === 'video-expert-analyzer'
            ? ['skill_video_expert_pipeline', 'skill_video_expert_ai_analyze']
            : [],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer', 'Video Expert Analyzer'],
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
    assert.ok(
      capturedAllowedToolNames.includes('skill_video_expert_ai_analyze'),
      [
        `expected VEA ai_analyze in allowed tools, got: ${capturedAllowedToolNames.join(',')}`,
        `logs=${logs.join('\n')}`,
        `metrics=${JSON.stringify(metrics)}`,
      ].join('\n'),
    )
    assert.ok(metrics.some((event) => event.metric === 'skill_reference_hint_armed' && event.via === 'resource'))
    assert.ok(metrics.some((event) =>
      event.metric === 'turn_frame_resolved'
      && event.mode === 'skill_resume'
      && event.skillId === 'video-expert-analyzer'
      && event.hasRunState === true
      && event.hasOutputDir === true,
    ))
    assert.ok(logs.some((line) =>
      line.includes('[turn_frame]')
      && line.includes('"mode":"skill_resume"')
      && line.includes('"skillId":"video-expert-analyzer"')
      && line.includes('"hasRunState":true'),
    ))
  } finally {
    restoreAiAnalyzeToolDefinition()
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

test('TurnEngine arms VEA continuation when the active document is run_state.json', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  let toolLoopRequests = 0
  let capturedAllowedToolNames: string[] = []
  let armedHint: { id: string; name: string } | null = null

  const outputDir = mkdtempSync(join(tmpdir(), 'ready-turn-run-state-document-'))
  const sceneScoresPath = join(outputDir, 'scene_scores.json')
  const runStatePath = join(outputDir, 'run_state.json')
  const runStateJson = JSON.stringify({
    version: 'vnext',
    status: 'running',
    current_stage: 'score_batches',
    scene_scores_path: 'scene_scores.json',
    video_dir: outputDir,
    total_scenes: 97,
    completed_scenes: 0,
  })
  writeFileSync(sceneScoresPath, '{"scenes":[]}', 'utf8')
  writeFileSync(runStatePath, runStateJson, 'utf8')
  const userText = [
    '继续，用 mimo-v2.5，输出到同一目录',
    '',
    '### 当前文档上下文',
    '- 标题: run_state.json',
    `- 路径: ${runStatePath}`,
    '--- 文档内容开始 ---',
    runStateJson,
    '--- 文档内容结束 ---',
  ].join('\n')

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  const restoreAiAnalyzeToolDefinition = installLongSkillToolDefinitionForTest('skill_video_expert_ai_analyze')
  try {
    const { request } = createRequest({
      userText,
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
          getCurrentReferenceSkillHint: () => armedHint,
          rememberReferenceSkillFromRunStateResource: (skillId: string) => {
            if (skillId !== 'video-expert-analyzer') return { armed: false }
            armedHint = { id: 'video-expert-analyzer', name: 'Video Expert Analyzer (VNext)' }
            rememberLastReferenceSkill('scope-test', armedHint)
            return { armed: true, skillId: armedHint.id, skillName: armedHint.name }
          },
          rememberExplicitReferenceSkillHint: () => Boolean(armedHint),
          buildPreferredSkillToolNames: () => armedHint?.id === 'video-expert-analyzer'
            ? ['skill_video_expert_pipeline', 'skill_video_expert_ai_analyze']
            : [],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer', 'Video Expert Analyzer'],
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
    assert.ok(capturedAllowedToolNames.includes('skill_video_expert_ai_analyze'))
    assert.ok(metrics.some((event) => event.metric === 'skill_reference_hint_armed' && event.via === 'resource'))
    assert.ok(metrics.some((event) =>
      event.metric === 'turn_frame_resolved'
      && event.mode === 'skill_resume'
      && event.skillId === 'video-expert-analyzer'
      && event.hasRunState === true
      && event.hasOutputDir === true,
    ))
  } finally {
    restoreAiAnalyzeToolDefinition()
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

test('TurnEngine arms VEA continuation from prior run_state path when user says try again', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  let toolLoopRequests = 0
  let capturedAllowedToolNames: string[] = []
  let armedHint: { id: string; name: string } | null = null

  const outputDir = mkdtempSync(join(tmpdir(), 'ready-turn-run-state-history-'))
  const sceneScoresPath = join(outputDir, 'scene_scores.json')
  const runStatePath = join(outputDir, 'run_state.json')
  writeFileSync(sceneScoresPath, '{"scenes":[]}', 'utf8')
  writeFileSync(
    runStatePath,
    JSON.stringify({
      version: 'vnext',
      status: 'running',
      current_stage: 'score_batches',
      scene_scores_path: 'scene_scores.json',
      video_dir: outputDir,
      total_scenes: 97,
      completed_scenes: 0,
    }),
    'utf8',
  )

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  const restoreAiAnalyzeToolDefinition = installLongSkillToolDefinitionForTest('skill_video_expert_ai_analyze')
  try {
    const { request } = createRequest({
      userText: '你再试一次',
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
          getCurrentReferenceSkillHint: () => armedHint,
          rememberReferenceSkillFromRunStateResource: (skillId: string) => {
            if (skillId !== 'video-expert-analyzer') return { armed: false }
            armedHint = { id: 'video-expert-analyzer', name: 'Video Expert Analyzer (VNext)' }
            rememberLastReferenceSkill('scope-test', armedHint)
            return { armed: true, skillId: armedHint.id, skillName: armedHint.name }
          },
          rememberExplicitReferenceSkillHint: () => Boolean(armedHint),
          buildPreferredSkillToolNames: () => armedHint?.id === 'video-expert-analyzer'
            ? ['skill_video_expert_pipeline', 'skill_video_expert_ai_analyze']
            : [],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer', 'Video Expert Analyzer'],
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
    request.session.messages = [
      { role: 'user', content: '@[4qkyxm4jppc] 这个目录下有之前未完成的任务，看看能不能找回任务进度然后继续推进' },
      { role: 'assistant', content: `tool execute: document_open_tab, result=已打开并载入文档：${runStatePath}（1207 字）` },
      { role: 'assistant', content: '好，让我先确认当前状态，然后尝试继续执行。' },
      { role: 'user', content: '你再试一次' },
    ]

    const result = await engine.execute(request)

    assert.equal(toolLoopRequests, 1)
    assert.equal(result.taskType, 'multi_step_task')
    assert.ok(capturedAllowedToolNames.includes('skill_video_expert_ai_analyze'))
    assert.ok(metrics.some((event) => event.metric === 'skill_reference_hint_armed' && event.via === 'resource_history'))
    assert.ok(metrics.some((event) =>
      event.metric === 'turn_frame_resolved'
      && event.mode === 'skill_resume'
      && event.skillId === 'video-expert-analyzer'
      && event.hasRunState === true
      && event.hasOutputDir === true,
    ))
  } finally {
    restoreAiAnalyzeToolDefinition()
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

test('TurnEngine treats an explicit skill URL request as a fresh start instead of resuming stale supervisor context', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  let toolLoopRequests = 0
  let capturedAllowedToolNames: string[] = []
  let armedHint: { id: string; name: string } | null = null
  let resumeCalls = 0
  const veaSkill = {
    id: 'video-expert-analyzer',
    name: 'Video Expert Analyzer (VNext)',
    actions: [
      {
        name: 'video_expert_pipeline',
        visibility: 'internal',
        params: [{ name: 'url', required: true }],
      },
      {
        name: 'video_expert_ai_analyze',
        visibility: 'internal',
        params: [{ name: 'sceneScoresPath', required: true }],
      },
    ],
    hostRequirements: {
      expose_when_hint_armed: ['video_expert_pipeline', 'video_expert_ai_analyze'],
    },
  }

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  const restorePipelineToolDefinition = installLongSkillToolDefinitionForTest('skill_video_expert_pipeline')
  const restoreAiAnalyzeToolDefinition = installLongSkillToolDefinitionForTest('skill_video_expert_ai_analyze')
  try {
    const { request } = createRequest({
      userText: '使用 @[Video Expert Analyzer (VNext)] 分析 https://www.youtube.com/watch?v=p4ahGSFTY-c，输出到 @[测试]，并一直跟进直到完成',
      intentClassification: createIntent({ primaryDomain: 'skill', confidence: 'high' }),
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
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => makeSkillSnapshot({
            outputDir: '/tmp/ready/old-4qkyxm4jppc',
            runStatePath: '/tmp/ready/old-4qkyxm4jppc/run_state.json',
            sceneScoresPath: '/tmp/ready/old-4qkyxm4jppc/scene_scores.json',
            hasLiveWork: false,
            hasRecentProgress: true,
          }),
        },
        resumeSkillChildRun: async () => {
          resumeCalls += 1
          throw new Error('fresh URL requests must not resume the old child')
        },
        skillContextOrchestrator: {
          shouldKeepToolsWithVideo: () => true,
          findExplicitlyRequestedSkills: (text: string) =>
            /video[-_\s]?expert|Video Expert Analyzer/i.test(text)
              ? [veaSkill]
              : [],
          getCurrentReferenceSkillHint: () => armedHint,
          rememberExplicitReferenceSkillHint: () => {
            armedHint = { id: 'video-expert-analyzer', name: 'Video Expert Analyzer (VNext)' }
            rememberLastReferenceSkill('scope-test', armedHint)
            return true
          },
          buildPreferredSkillToolNames: () => armedHint?.id === 'video-expert-analyzer'
            ? ['skill_video_expert_pipeline', 'skill_video_expert_ai_analyze']
            : [],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer', 'Video Expert Analyzer'],
        },
        requestToolLoopResponse: async (params: { allowedToolNames?: string[] }) => {
          toolLoopRequests += 1
          capturedAllowedToolNames = params.allowedToolNames || []
          return {
            text: '准备开始新任务',
            toolCalls: [],
            stopReason: 'stop',
          }
        },
      },
    })

    const result = await engine.execute(request)

    assert.equal(resumeCalls, 0)
    assert.equal(toolLoopRequests, 1)
    assert.equal(result.taskType, 'multi_step_task')
    assert.ok(capturedAllowedToolNames.includes('skill_video_expert_pipeline'))
    assert.ok(!capturedAllowedToolNames.includes('skill_video_expert_ai_analyze'))
    assert.ok(metrics.some((event) =>
      event.metric === 'turn_frame_resolved'
      && event.mode === 'skill_start'
      && event.source === 'explicit'
      && event.skillId === 'video-expert-analyzer',
    ))
    assert.ok(metrics.some((event) =>
      event.metric === 'explicit_skill_fresh_start_detected'
      && event.skillId === 'video-expert-analyzer'
      && event.action === 'video_expert_pipeline',
    ))
  } finally {
    restorePipelineToolDefinition()
    restoreAiAnalyzeToolDefinition()
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

test('TurnEngine treats restart-same-goal text as a skill start instead of resuming live supervisor context', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  let toolLoopRequests = 0
  let resumeCalls = 0
  let capturedAllowedToolNames: string[] = []
  const humanizerSkill = {
    id: 'humanizer-zh',
    name: 'Humanizer',
    actions: [
      {
        name: 'humanize',
        visibility: 'internal',
        params: [{ name: 'input', required: true }],
      },
    ],
    hostRequirements: {
      expose_when_hint_armed: ['humanize'],
    },
  }

  __setMetricSinkForTests((event) => metrics.push(event))
  const restoreToolDefinition = installLongSkillToolDefinitionForTest('skill_humanizer_zh_humanize')
  try {
    const { request } = createRequest({
      userText: '从头来过，再跑一遍这次任务',
      intentClassification: createIntent({ primaryDomain: 'document', confidence: 'medium' }),
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
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => makeSkillSnapshot({
            skillId: 'humanizer-zh',
            action: 'humanize',
            taskRunId: 'str-humanizer',
            detachedTaskId: null,
            outputDir: null,
            runStatePath: null,
            sceneScoresPath: null,
            deliveryReportPath: null,
            resumePayload: null,
            hasLiveWork: true,
            hasRecentProgress: false,
          }),
        },
        resumeSkillChildRun: async () => {
          resumeCalls += 1
          throw new Error('restart-same-goal must not resume the old child')
        },
        skillContextOrchestrator: {
          shouldKeepToolsWithVideo: () => false,
          findExplicitlyRequestedSkills: (text: string) =>
            /humanizer[-_\s]?zh|Humanizer/i.test(text)
              ? [humanizerSkill]
              : [],
          getCurrentReferenceSkillHint: () => null,
          rememberExplicitReferenceSkillHint: () => false,
          buildPreferredSkillToolNames: (text: string) =>
            /humanizer|Humanizer/i.test(text)
              ? ['skill_humanizer_zh_humanize']
              : [],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['humanizer-zh', 'Humanizer'],
        },
        requestToolLoopResponse: async (params: { allowedToolNames?: string[] }) => {
          toolLoopRequests += 1
          capturedAllowedToolNames = params.allowedToolNames || []
          return {
            text: '准备从头重新执行',
            toolCalls: [],
            stopReason: 'stop',
          }
        },
      },
    })

    const result = await engine.execute(request)

    assert.equal(resumeCalls, 0)
    assert.equal(toolLoopRequests, 1)
    assert.notEqual(result.taskType, 'continuation')
    assert.notEqual(result.terminalReason, 'checkpoint_background')
    // Stage Q (Stage 11) — skill identity is preserved across restart
    // (the `skill_history` source path still fires for relation='new'),
    // so `skill_humanizer_zh_humanize` is still in `allowedToolNames`.
    // The Q.5 fix targets LIVENESS, not tool exposure: stale supervisor
    // status / liveness no longer leaks into `frame.liveness` for
    // userIntent='start' (see `restart-frame-no-stale-liveness.test.ts`).
    assert.ok(capturedAllowedToolNames.includes('skill_humanizer_zh_humanize'))
    assert.ok(metrics.some((event) =>
      event.metric === 'turn_frame_resolved'
      && event.mode === 'skill_start'
      && event.skillId === 'humanizer-zh'
      && event.hasRunState === false
      && event.hasOutputDir === false,
    ))
    assert.ok(!metrics.some((event) =>
      event.metric === 'turn_frame_resolved'
      && event.mode === 'skill_resume'
      && event.skillId === 'humanizer-zh',
    ))
  } finally {
    restoreToolDefinition()
    __setMetricSinkForTests(null)
  }
})

test('TurnEngine lets an explicit advisory skill override stale supervisor and continuation context', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  let capturedAllowedToolNames: string[] = []
  let armedHint: { id: string; name: string } | null = null
  const videoCopySkill = {
    id: 'video-copy-analyzer',
    name: 'Video Copy Analyzer',
    actions: [
      {
        name: 'read_skill',
        visibility: 'internal',
        runtime: 'reference',
        params: [],
      },
      {
        name: 'video_copy_analyze',
        visibility: 'internal',
        params: [{ name: 'input', required: true }],
      },
    ],
    hostRequirements: {
      expose_when_hint_armed: ['video_copy_analyze'],
    },
  }

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  try {
    const { request } = createRequest({
      userText: '@[Video Copy Analyzer] 分析https://www.youtube.com/watch?v=4OOYrelo12w 输出到 @[测试]',
      intentClassification: createIntent({ primaryDomain: 'skill', confidence: 'high' }),
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
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => makeSkillSnapshot({
            skillId: 'video-expert-analyzer',
            outputDir: '/tmp/ready/old-4qkyxm4jppc',
            runStatePath: '/tmp/ready/old-4qkyxm4jppc/run_state.json',
            sceneScoresPath: '/tmp/ready/old-4qkyxm4jppc/scene_scores.json',
            hasLiveWork: true,
            hasRecentProgress: true,
          }),
        },
        skillContextOrchestrator: {
          shouldKeepToolsWithVideo: () => true,
          findExplicitlyRequestedSkills: (text: string) =>
            /video[-_\s]?copy|Video Copy Analyzer/i.test(text)
              ? [videoCopySkill]
              : [],
          getCurrentReferenceSkillHint: () => armedHint,
          rememberExplicitReferenceSkillHint: () => {
            armedHint = { id: 'video-copy-analyzer', name: 'Video Copy Analyzer' }
            rememberLastReferenceSkill('scope-test', armedHint)
            return true
          },
          buildPreferredSkillToolNames: () => [
            'skill_video_copy_analyze',
            'skill_ask_user',
            'skill_run_shell',
            'skill_write_artifact',
            'skill_read_artifact',
            'skill_start_detached',
            'skill_inspect_detached',
            'skill_cancel_detached',
          ],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-copy-analyzer', 'Video Copy Analyzer'],
        },
        requestToolLoopResponse: async (params: { allowedToolNames?: string[] }) => {
          capturedAllowedToolNames = params.allowedToolNames || []
          return {
            text: '准备按 Video Copy Analyzer 执行',
            toolCalls: [],
            stopReason: 'stop',
          }
        },
      },
    })
    ;(request as unknown as { continuationState?: Record<string, unknown> }).continuationState = {
      taskId: 'old-vea-task',
      skillId: 'video-expert-analyzer',
      outputDir: '/tmp/ready/old-4qkyxm4jppc',
    }

    const result = await engine.execute(request)

    assert.equal(result.taskType, 'multi_step_task')
    assert.ok(capturedAllowedToolNames.includes('skill_video_copy_analyze'))
    assert.ok(capturedAllowedToolNames.includes('skill_run_shell'))
    assert.ok(!capturedAllowedToolNames.includes('skill_video_expert_pipeline'))
    assert.ok(!capturedAllowedToolNames.includes('skill_video_expert_ai_analyze'))
    assert.ok(metrics.some((event) =>
      event.metric === 'turn_frame_resolved'
      && event.mode === 'skill_start'
      && event.source === 'explicit'
      && event.skillId === 'video-copy-analyzer',
    ))
  } finally {
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

test('TurnEngine does not infer VEA from a fresh URL just because VEA is active in the background', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  let capturedAllowedToolNames: string[] = []
  let armedHint: { id: string; name: string } | null = null
  const veaSkill = {
    id: 'video-expert-analyzer',
    name: 'Video Expert Analyzer (VNext)',
    actions: [
      {
        name: 'video_expert_pipeline',
        visibility: 'internal',
        params: [{ name: 'url', required: true }],
      },
      {
        name: 'video_expert_ai_analyze',
        visibility: 'internal',
        params: [{ name: 'sceneScoresPath', required: true }],
      },
    ],
    hostRequirements: {
      expose_when_hint_armed: ['video_expert_pipeline', 'video_expert_ai_analyze'],
    },
  }

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  const restorePipelineToolDefinition = installLongSkillToolDefinitionForTest('skill_video_expert_pipeline')
  const restoreAiAnalyzeToolDefinition = installLongSkillToolDefinitionForTest('skill_video_expert_ai_analyze')
  try {
    const { request } = createRequest({
      userText: 'https://www.youtube.com/watch?v=p4ahGSFTY-c',
      intentClassification: createIntent({ primaryDomain: 'browser', confidence: 'medium' }),
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
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => makeSkillSnapshot({
            outputDir: '/tmp/ready/old-4qkyxm4jppc',
            runStatePath: '/tmp/ready/old-4qkyxm4jppc/run_state.json',
            sceneScoresPath: '/tmp/ready/old-4qkyxm4jppc/scene_scores.json',
            hasLiveWork: true,
            hasRecentProgress: true,
          }),
        },
        skillContextOrchestrator: {
          shouldKeepToolsWithVideo: () => true,
          findExplicitlyRequestedSkills: (text: string) =>
            /video-expert-analyzer|Video Expert Analyzer/i.test(text)
              ? [veaSkill]
              : [],
          getCurrentReferenceSkillHint: () => armedHint,
          rememberExplicitReferenceSkillHint: (text: string) => {
            if (!/video-expert-analyzer|Video Expert Analyzer/i.test(text)) return false
            armedHint = { id: 'video-expert-analyzer', name: 'Video Expert Analyzer (VNext)' }
            rememberLastReferenceSkill('scope-test', armedHint)
            return true
          },
          buildPreferredSkillToolNames: () => armedHint?.id === 'video-expert-analyzer'
            ? ['skill_video_expert_pipeline', 'skill_video_expert_ai_analyze']
            : [],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer', 'Video Expert Analyzer'],
        },
        requestToolLoopResponse: async (params: { allowedToolNames?: string[] }) => {
          capturedAllowedToolNames = params.allowedToolNames || []
          return {
            text: '准备开始新任务',
            toolCalls: [],
            stopReason: 'stop',
          }
        },
      },
    })

    const result = await engine.execute(request)

    assert.ok(result)
    assert.ok(!capturedAllowedToolNames.some((name) => name.startsWith('skill_')))
    assert.ok(!metrics.some((event) =>
      event.metric === 'turn_frame_resolved'
      && event.mode === 'skill_start'
      && event.skillId === 'video-expert-analyzer',
    ))
  } finally {
    restorePipelineToolDefinition()
    restoreAiAnalyzeToolDefinition()
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

test('TurnEngine refreshes skill tool policy after run_state patch changes VEA stage into ai_analyze action', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  const outputDir = '/tmp/ready/output'
  const runStatePath = `${outputDir}/run_state.json`
  const sceneScoresPath = `${outputDir}/scene_scores.json`
  const requestedModelAllowedToolNames: string[][] = []
  const executedToolNames: string[] = []
  let toolLoopRequests = 0

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  const restorePipelineToolDefinition = installLongSkillToolDefinitionForTest('skill_video_expert_pipeline')
  const restoreAiAnalyzeToolDefinition = installLongSkillToolDefinitionForTest('skill_video_expert_ai_analyze')
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
          getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'video-expert-analyzer' }),
          rememberExplicitReferenceSkillHint: () => true,
          buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer'],
        },
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => makeSkillSnapshot({
            status: 'blocked',
            liveness: 'blocked',
            hasLiveWork: false,
            hasRecentProgress: false,
            closeAllowed: false,
            action: 'video_expert_pipeline',
            outputDir,
            runStatePath,
            sceneScoresPath,
            deliveryReportPath: null,
            progress: {
              currentStage: 'score_batches',
              totalScenes: 97,
              completedScenes: 0,
              coverageRatio: 0,
              updatedAt: '2026-05-03T07:24:17.000Z',
            },
            resumePayload: {
              taskRunId: 'str-loop',
              detachedTaskId: 'dst-loop',
              outputDir,
              runStatePath,
            },
          }),
        },
        requestToolLoopResponse: async (params: { allowedToolNames?: string[] }) => {
          toolLoopRequests += 1
          requestedModelAllowedToolNames.push([...(params.allowedToolNames || [])])
          if (toolLoopRequests === 1) {
            return {
              text: '先检查 run_state',
              toolCalls: [{
                id: 'inspect-1',
                name: 'skill_inspect_run_state',
                input: { runStatePath },
              }],
              stopReason: 'tool_calls',
            }
          }
          return {
            text: '恢复完成',
            toolCalls: [],
            stopReason: 'stop',
          }
        },
        executeToolBatch: async ({ toolCalls }: { toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> }) => {
          executedToolNames.push(...toolCalls.map((call) => call.name))
          if (toolCalls.some((call) => call.name === 'skill_inspect_run_state')) {
            return {
              results: toolCalls.map((call) => ({
                id: call.id,
                name: call.name,
                input: call.input,
                result: {
                  text: 'score_batches: 0/97',
                  framePatch: {
                    activeArtifactRoots: [outputDir],
                    livenessHint: 'blocked',
                    skillStatusUpdates: {
                      status: 'blocked',
                      action: 'score_batches',
                      outputDir,
                      runStatePath,
                      artifactPaths: {
                        sceneScoresPath,
                        deliveryReportPath: null,
                      },
                      staleBlockerReason: null,
                    },
                    runContract: {
                      skillId: 'video-expert-analyzer',
                      action: 'score_batches',
                      outputDir,
                      runStatePath,
                      artifactPaths: {
                        sceneScoresPath,
                        deliveryReportPath: null,
                      },
                      status: 'blocked',
                      liveness: 'blocked',
                      progress: {
                        stage: 'score_batches',
                        totalUnits: 97,
                        completedUnits: 0,
                        coverageRatio: 0,
                        fingerprint: 'score_batches:0/97',
                      },
                    },
                  },
                },
              })),
              budgetLimited: false,
              recoveryHistory: [],
            }
          }
          return {
            results: toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              input: call.input,
              result: { text: 'done' },
            })),
            budgetLimited: false,
            recoveryHistory: [],
          }
        },
      },
    })

    await engine.execute(request)

    // Stage N (Phase 1.2) — VEA without childRunId is now blocked by the
    // manifest fence. ai_analyze MUST NOT execute; pipeline MUST NOT
    // execute. The legacy "refresh forces ai_analyze" contract is retired.
    assert.equal(
      executedToolNames.includes('skill_video_expert_ai_analyze'),
      false,
      `Stage N: VEA ai_analyze must NOT be parent-forced (manifest fence active); executed: ${executedToolNames.join(',')}; model allowed snapshots: ${JSON.stringify(requestedModelAllowedToolNames)}`,
    )
    assert.equal(
      executedToolNames.includes('skill_video_expert_pipeline'),
      false,
      `Stage N: VEA pipeline must NOT be parent-forced (manifest fence active); executed: ${executedToolNames.join(',')}`,
    )
    // Stage N — at least one manifest-fence metric must fire (the
    // refresh after inspect would have surfaced ai_analyze as
    // requiredToolName, then the manifest fence catches it). VEA tool
    // names must never appear in the model's allowed list during this
    // run, because steering removes them when the manifest fence is in
    // play.
    const blockedMetrics = metrics.filter((event) =>
      event.metric === 'turn_force_tool_blocked_child_owned',
    )
    assert.ok(
      blockedMetrics.length >= 1,
      `Stage N: expected at least one turn_force_tool_blocked_child_owned metric; metrics seen: ${metrics.map((m) => m.metric).join(',')}`,
    )
  } finally {
    restoreAiAnalyzeToolDefinition()
    restorePipelineToolDefinition()
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

test('TurnEngine routes active skill progress-followup turns through the skill loop', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  let toolLoopRequests = 0
  let simpleTextRequests = 0

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  try {
    const { request } = createRequest({
      userText: '你要一直跟进，及时汇报最新进度，直到跑完整个任务',
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
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => makeSkillSnapshot({
            status: 'running',
            liveness: 'background',
            hasLiveWork: true,
            hasRecentProgress: true,
          }),
        },
        skillContextOrchestrator: {
          shouldKeepToolsWithVideo: () => false,
          findExplicitlyRequestedSkills: () => [],
          getCurrentReferenceSkillHint: () => null,
          rememberExplicitReferenceSkillHint: () => false,
          buildPreferredSkillToolNames: () => [],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer', 'Video Expert Analyzer'],
        },
        requestSimpleText: async () => {
          simpleTextRequests += 1
          return { text: 'simple result' }
        },
        requestToolLoopResponse: async () => {
          toolLoopRequests += 1
          return {
            text: '已检查进度',
            toolCalls: [],
            stopReason: 'stop',
          }
        },
      },
    })

    const result = await engine.execute(request)

    assert.equal(simpleTextRequests, 0)
    assert.equal(toolLoopRequests, 1)
    assert.equal(result.taskType, 'multi_step_task')
    assert.ok(metrics.some((event) =>
      event.metric === 'turn_frame_resolved'
      && event.mode === 'skill_resume'
      && event.skillId === 'video-expert-analyzer',
    ))
  } finally {
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

test('RunCoordinator drives TurnEngine budget lifecycle through scope event and task projection sync', async () => {
  const engine = new TurnEngine()
  const scope: ConversationScope = {
    id: 'scope-main-chain',
    agent: 'butler',
    title: '主链路验收',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'scope-main-chain',
    meta: {},
    createdAt: '2026-04-28T00:00:00.000Z',
    updatedAt: '2026-04-28T00:00:00.000Z',
    lastMessageAt: '2026-04-28T00:00:00.000Z',
  }
  const summaries = new Map<string, ScopeRunSummary>()
  const projectionRecords = new Map<string, TaskProjectionRecord>()
  const projectionSyncs: Promise<unknown>[] = []
  const scopeEvents: ScopeRunEventPayload[] = []
  const runProjection = new RunProjection({
    getScope: (scopeId) => (scopeId === scope.id ? scope : null),
    getPrevious: (scopeId) => summaries.get(scopeId),
    setSummary: (scopeId, summary) => {
      summaries.set(scopeId, summary)
    },
    toChannelKey: () => 'local:app',
  })
  const projectionStore: TaskProjectionStore = {
    create(record) {
      projectionRecords.set(record.taskId, record)
    },
    update(taskId, patch) {
      projectionRecords.set(taskId, {
        ...projectionRecords.get(taskId)!,
        ...patch,
      })
    },
    get(taskId) {
      return projectionRecords.get(taskId) || null
    },
    listByScope(scopeId) {
      return Array.from(projectionRecords.values()).filter((record) => record.scopeId === scopeId)
    },
    listByParentTask(parentTaskId) {
      return Array.from(projectionRecords.values()).filter((record) => record.parentTaskId === parentTaskId)
    },
  }

  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: [],
        memoryRefs: [],
        triggerHits: [{ id: 'skill', label: '技能任务', module: 'skill', blocking: true }],
        contextBudget: { totalChars: 0, l0Chars: 0, l1Chars: 0, l2Chars: 0, droppedRefs: [] },
        requestEnvelope: buildRequestEnvelope({ userText: '继续视频分析' }),
        intentClassification: createIntent({ primaryDomain: 'skill', confidence: 'high' }),
      }),
      applyToMessage: (message) => message,
      recordRunOutcome: () => {},
    },
    executeAndCollect: async (request) => engine.execute({
      runId: request.requestId,
      taskId: request.taskId,
      agentName: request.agent,
      sessionId: request.sessionId,
      session: createSession(String(request.message)),
      content: request.message,
      requestEnvelope: request.requestEnvelope,
      intentClassification: request.intentClassification,
      budget: request.budget,
      budgetState: request.budgetState,
      taskBudgetRuntime: request.taskBudgetRuntime,
      abortSignal: new AbortController().signal,
      ensureNotAborted: () => {},
      emitters: {
        emitOutput: () => {},
        emitStatus: () => {},
        emitRuntimeError: () => {},
        emitToolAction: () => {},
      },
      host: createHost({
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
          findExplicitlyRequestedSkills: () => [{ id: 'video-expert-analyzer', name: 'video-expert-analyzer' }],
          getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'video-expert-analyzer' }),
          rememberExplicitReferenceSkillHint: () => true,
          buildPreferredSkillToolNames: () => ['skill_get_state'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer'],
        },
        requestToolLoopResponse: async () => ({
          text: '继续检查技能任务状态',
          toolCalls: [
            { id: 'tool-skill-state', name: 'skill_get_state', input: {} },
            { id: 'tool-memory', name: 'memory_create', input: { text: '技能仍在运行' } },
          ],
          stopReason: 'tool_calls',
        }),
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => ({
            status: 'running',
            closeAllowed: false,
            hasLiveWork: true,
            hasRecentProgress: true,
            blockers: ['后台视频分析仍在运行'],
            progress: {
              currentStage: 'scoring',
              sceneIndex: 12,
              totalScenes: 200,
              completedScenes: 12,
              coverageRatio: 0.06,
            },
            skillId: 'video-expert-analyzer',
            action: 'video_expert_pipeline',
            taskRunId: 'task-run-main-chain',
            detachedTaskId: 'detached-main-chain',
            outputDir: '/tmp/vea-main-chain',
            runStatePath: '/tmp/vea-main-chain/run_state.json',
            progressFingerprint: 'stage:scoring|12/200',
            resumePayload: {
              taskId: 'task-run-main-chain',
              detachedTaskId: 'detached-main-chain',
              outputDir: '/tmp/vea-main-chain',
              runStatePath: '/tmp/vea-main-chain/run_state.json',
            },
          }),
        },
      }),
    }),
    emitScopeRunEvent: (payload, projectionTruth) => {
      scopeEvents.push(payload)
      const summary = runProjection.recordEvent(payload, projectionTruth)
      if (summary) {
        projectionSyncs.push(syncTaskProjection(projectionStore, summary, payload, projectionTruth))
      }
    },
    reflectOnConversation: async () => null,
  })

  const result = await coordinator.runScoped({
    scope,
    message: '继续视频分析',
    requestId: 'run-main-chain',
    taskId: 'task-main-chain',
    budget: {
      maxIterations: 1,
      maxToolCalls: 1,
      maxParallelToolGroups: 1,
      reservedToolCalls: 0,
    },
    coordinators: []
  })
  await Promise.all(projectionSyncs)

  const finalEvent = scopeEvents[scopeEvents.length - 1]
  const projected = projectionRecords.get('task-main-chain')
  assert.equal(result.success, true)
  assert.equal(finalEvent?.phase, 'checkpoint')
  assert.equal(finalEvent?.waitingFor, 'background')
  assert.deepEqual(finalEvent?.resumableActions, ['continue', 'retry', 'cancel'])
  assert.equal(finalEvent?.taskContinuation?.detachedTaskId, 'detached-main-chain')
  assert.equal(finalEvent?.taskContinuation?.runStatePath, '/tmp/vea-main-chain/run_state.json')
  assert.equal(projected?.status, 'blocked')
  assert.equal(projected?.interactionState, 'suspended')
  assert.equal(projected?.continuationRef?.detachedTaskId, 'detached-main-chain')
  assert.equal(projected?.continuationRef?.pauseReason, 'budget_exhausted')
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
        executeToolBatch: async (params: {
          hooks?: {
            onToolStart?: (payload: unknown) => void
            onToolResult?: (payload: unknown) => void
          }
        }) => {
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
        executeToolBatch: async (params: {
          hooks?: {
            onToolStart?: (payload: unknown) => void
            onToolResult?: (payload: unknown) => void
          }
        }) => {
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
      .find((projection) => projection?.module === 'skill' && String(projection.taskSummary || '').includes('正在执行技能工具'))

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

test('TurnEngine keeps a live skill task as checkpoint when tool budget is exhausted', async () => {
  const engine = new TurnEngine()
  const { request } = createRequest({
    userText: '继续视频分析',
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
        getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'video-expert-analyzer' }),
        rememberExplicitReferenceSkillHint: () => true,
        buildPreferredSkillToolNames: () => ['skill_run_shell'],
        maybeInjectExplicitSkillContext: async () => {},
        listRegisteredSkillTokens: () => ['video-expert-analyzer'],
      },
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => ({
          taskRunId: 'str-budget',
          detachedTaskId: 'dst-budget',
          skillId: 'video-expert-analyzer',
          scopeId: 'scope-test',
          sessionId: 'scope-test',
          action: 'video_expert_pipeline',
          status: 'running',
          liveness: 'background',
          hasLiveWork: true,
          hasRecentProgress: true,
          closeAllowed: false,
          ambiguous: false,
          stale: false,
          outputDir: '/tmp/ready/output',
          runStatePath: '/tmp/ready/output/run_state.json',
          sceneScoresPath: '/tmp/ready/output/scene_scores.json',
          deliveryReportPath: '/tmp/ready/output/delivery_report.json',
          progress: { currentStage: 'score_batches', updatedAt: '2026-04-28T02:00:00.000Z' },
          blockers: [],
          pauseReason: null,
          resumePayload: {
            taskRunId: 'str-budget',
            detachedTaskId: 'dst-budget',
            outputDir: '/tmp/ready/output',
            runStatePath: '/tmp/ready/output/run_state.json',
          },
          sourceObservations: [],
          progressFingerprint: 'fp-budget',
          observedAt: '2026-04-28T02:00:00.000Z',
          lastProgressAt: '2026-04-28T02:00:00.000Z',
        }),
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
          result: { text: 'monitor exited 0' },
        }],
        budgetLimited: false,
        recoveryHistory: [],
      }),
    },
  })

  const result = await engine.execute(request)

  assert.equal(result.success, true)
  assert.equal(result.skillTaskLifecycle?.state, 'budget_paused')
  assert.equal(result.skillTaskLifecycle?.phase, 'checkpoint')
  assert.equal(result.terminalReason, 'checkpoint_background')
  assert.equal(result.interactionState, 'suspended')
  assert.equal(result.projectionTruth?.projectionPatch?.waitingFor, 'background')
  assert.equal((result.projectionTruth?.projectionPatch?.taskContinuation as Record<string, unknown>)?.taskRunId, 'str-budget')
})

test('TurnEngine routes failed close-allowed skill snapshots to lifecycle error instead of done', async () => {
  const engine = new TurnEngine()
  const restoreLongToolDefinition = installLongSkillToolDefinitionForTest()
  let executedBatches = 0
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
          buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer'],
        },
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => makeSkillSnapshot({
            status: 'failed',
            hasLiveWork: false,
            hasRecentProgress: false,
            closeAllowed: true,
            blockers: ['provider rejected request'],
            outputDir: '/tmp/failed',
            runStatePath: '/tmp/failed/run_state.json',
            progressFingerprint: 'failed-fp',
          }),
        },
        requestToolLoopResponse: async () => ({
          text: '继续执行',
          toolCalls: [{ id: `tool-${executedBatches + 1}`, name: 'skill_video_expert_pipeline', input: { batch: executedBatches + 1 } }],
          stopReason: 'tool_calls',
        }),
        executeToolBatch: async () => {
          executedBatches += 1
          return {
            results: [{
              id: `tool-${executedBatches}`,
              name: 'skill_video_expert_pipeline',
              input: { batch: executedBatches },
              result: { text: 'failed' },
            }],
            budgetLimited: false,
            recoveryHistory: [],
          }
        },
      },
    })

    const result = await engine.execute(request)

    assert.equal(result.skillTaskLifecycle?.state, 'failed')
    assert.equal(result.skillTaskLifecycle?.phase, 'error')
    assert.equal(result.status, 'checkpoint')
    assert.notEqual(result.status, 'done')
    assert.equal(result.skillTaskLifecycle?.taskContinuation?.runStatePath, '/tmp/failed/run_state.json')
  } finally {
    restoreLongToolDefinition()
  }
})

test('TurnEngine creates a skill lease from a recoverable supervisor snapshot even without a long typed action trigger', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const { request } = createRequest({
      userText: '继续之前的视频分析',
      intentClassification: createIntent({
        primaryDomain: 'skill',
        mentionedDomains: ['skill'],
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
          buildPreferredSkillToolNames: () => ['skill_get_state'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer'],
        },
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => makeSkillSnapshot({
            status: 'running',
            liveness: 'background',
            hasLiveWork: true,
            closeAllowed: false,
            detachedTaskId: 'dst-observed',
            taskRunId: 'str-observed',
          }),
        },
        requestToolLoopResponse: async () => ({
          text: '检查状态',
          toolCalls: [],
          stopReason: 'stop',
        }),
      },
    })

    await engine.execute(request)

    assert.ok(metrics.some((event) =>
      event.metric === 'skill_budget_lease_created'
      && event.reason === 'observed_supervisor_snapshot'
    ))
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('TurnEngine binds config repair turns to the blocked supervisor skill before a stale current hint', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  const preferredInputs: string[] = []
  const logs: string[] = []
  _resetLastReferenceSkillHintsForTests()
  rememberLastReferenceSkill('scope-test', {
    id: 'novel-writer-system',
    name: 'novel_writer_system',
  })
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const veaSkill = {
      id: 'video-expert-analyzer',
      name: 'video-expert-analyzer',
      executionMode: 'advisory',
      actions: [],
      hostRequirements: {},
    } as any
    const { request } = createRequest({
      userText: 'key 改成新的了，清掉 zai 的 5v turbo 后继续',
      intentClassification: createIntent({
        primaryDomain: 'generic',
        confidence: 'low',
      }),
      host: {
        log: (message: string) => logs.push(message),
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
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => makeSkillSnapshot({
            skillId: 'video-expert-analyzer',
            action: 'video_expert_pipeline',
            status: 'blocked',
            hasLiveWork: false,
            hasRecentProgress: true,
            closeAllowed: false,
            detachedTaskId: 'dst-vea-config',
            taskRunId: 'str-vea-config',
            failureKind: 'tool_error',
            progress: {
              currentStage: 'score_batches',
              completedScenes: 54,
              totalScenes: 97,
            },
          } as any),
        },
        skillContextOrchestrator: {
          shouldKeepToolsWithVideo: () => false,
          findExplicitlyRequestedSkills: (text: string) =>
            text.includes('video-expert-analyzer') ? [veaSkill] : [],
          getCurrentReferenceSkillHint: () => ({ id: 'novel-writer-system', name: 'novel_writer_system' }),
          rememberExplicitReferenceSkillHint: (text: string) => {
            if (!text.includes('video-expert-analyzer')) return false
            rememberLastReferenceSkill('scope-test', { id: 'video-expert-analyzer', name: 'video-expert-analyzer' })
            return true
          },
          buildPreferredSkillToolNames: (text: string) => {
            preferredInputs.push(text)
            return text.includes('video-expert-analyzer')
              ? ['skill_video_expert_pipeline', 'skill_run_shell']
              : ['skill_run_shell']
          },
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer', 'novel-writer-system'],
        },
        requestToolLoopResponse: async () => ({
          text: '检查配置',
          toolCalls: [],
          stopReason: 'stop',
        }),
      },
    })

    await engine.execute(request)

    assert.ok(
      preferredInputs.some((text) => text.includes('video-expert-analyzer')),
      'config repair should synthesize VEA resume context instead of stale hint context',
    )
    assert.ok(metrics.some((event) =>
      event.metric === 'skill_reference_hint_armed'
      && event.skillId === 'video-expert-analyzer'
      && event.via === 'history'
    ))
    assert.equal(
      logs.some((line) => line.includes('suppressed implicit continuation')),
      false,
      'recovered config repair should not suppress implicit continuation because of stale hint',
    )
  } finally {
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
})

test('TurnEngine proves executeToolBatch budgetLimited through real run_state supervisor input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-turn-budget-limited-'))
  const restoreLongToolDefinition = installLongSkillToolDefinitionForTest()
  try {
    mkdirSync(root, { recursive: true })
    const runStatePath = join(root, 'run_state.json')
    writeFileSync(runStatePath, JSON.stringify({
      task_id: 'dst-budget-limited',
      status: 'running',
      current_stage: 'score_batches',
      completed_scenes: 5,
      total_scenes: 40,
      coverage_ratio: 0.125,
      updated_at: '2026-04-28T02:00:00.000Z',
    }), 'utf8')
    writeFileSync(join(root, 'scene_scores.json'), '{}', 'utf8')
    const supervisor = new SkillTaskSupervisor({
      now: () => Date.parse('2026-04-28T02:00:30.000Z'),
      listActiveTaskRuns: () => [{
        id: 'str-budget-limited',
        scopeId: 'scope-test',
        sessionId: 'scope-test',
        agent: 'butler',
        runId: 'run-test',
        skillId: 'video-expert-analyzer',
        skillName: 'Video Expert Analyzer',
        action: 'video_expert_pipeline',
        toolName: 'skill_video_expert_pipeline',
        runKind: 'typed_action',
        status: 'running',
        interactionState: 'running',
        goalText: null,
        resourceRefs: [],
        params: null,
        steps: [{ id: 'skill_video_expert_pipeline#1', title: '视频分析', status: 'running', updatedAt: '2026-04-28T02:00:00.000Z' }],
        currentStepId: 'skill_video_expert_pipeline#1',
        artifacts: [],
        outputDir: root,
        runStatePath,
        sceneScoresPath: join(root, 'scene_scores.json'),
        deliveryReportPath: join(root, 'delivery_report.json'),
        failureKind: null,
        failureDetail: null,
        jobId: null,
        detachedTaskId: 'dst-budget-limited',
        resumePayload: {
          taskRunId: 'str-budget-limited',
          detachedTaskId: 'dst-budget-limited',
          outputDir: root,
          runStatePath,
        },
        createdAt: '2026-04-28T01:59:00.000Z',
        startedAt: '2026-04-28T01:59:00.000Z',
        updatedAt: '2026-04-28T02:00:00.000Z',
        finishedAt: null,
      }],
      listDetachedTasks: () => [],
      findLatestRecoverableTaskRun: () => null,
    })
    const engine = new TurnEngine()
    const { request } = createRequest({
      userText: '继续视频分析',
      intentClassification: createIntent({
        primaryDomain: 'skill',
        mentionedDomains: ['skill'],
        objectSignals: ['skill-object'],
        actionSignals: ['skill-action'],
        confidence: 'high',
      }),
      budget: {
        maxIterations: 8,
        maxToolCalls: 8,
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
          getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'video-expert-analyzer' }),
          rememberExplicitReferenceSkillHint: () => true,
          buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer'],
        },
        skillTaskSupervisor: supervisor,
        requestToolLoopResponse: async () => ({
          text: '继续执行',
          toolCalls: [{ id: 'tool-1', name: 'skill_video_expert_pipeline', input: { outputDir: root } }],
          stopReason: 'tool_calls',
        }),
        executeToolBatch: async () => ({
          results: [{
            id: 'tool-1',
            name: 'skill_video_expert_pipeline',
            input: { outputDir: root },
            result: { text: '仍在运行', data: { status: 'running', runStatePath } },
          }],
          budgetLimited: true,
          recoveryHistory: [],
        }),
      },
    })

    const result = await engine.execute(request)

    assert.equal(result.success, true)
    assert.equal(result.skillTaskLifecycle?.state, 'budget_paused')
    assert.equal(result.interactionState, 'suspended')
    assert.equal(result.projectionTruth?.projectionPatch?.waitingFor, 'background')
    assert.equal((result.projectionTruth?.projectionPatch?.taskContinuation as Record<string, unknown>)?.taskRunId, 'str-budget-limited')
  } finally {
    restoreLongToolDefinition()
    rmSync(root, { recursive: true, force: true })
  }
})

test('TurnEngine evaluates skill budget leases two iterations before lease end', async () => {
  const engine = new TurnEngine()
  const restoreLongToolDefinition = installLongSkillToolDefinitionForTest()
  let executedBatches = 0
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
          buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer'],
        },
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => makeSkillSnapshot({
            ambiguous: true,
            progressFingerprint: 'fp-stalled',
          }),
        },
        requestToolLoopResponse: async () => {
          const nextBatch = executedBatches + 1
          return {
            text: '继续执行',
            toolCalls: [{ id: `tool-${nextBatch}`, name: 'skill_video_expert_pipeline', input: { batch: nextBatch } }],
            stopReason: 'tool_calls',
          }
        },
        executeToolBatch: async () => {
          executedBatches += 1
          return {
            results: [{
              id: `tool-${executedBatches}`,
              name: 'skill_video_expert_pipeline',
              input: { batch: executedBatches },
              result: {
                text: '仍在运行',
                data: { currentStage: 'score_batches', status: 'running' },
              },
            }],
            budgetLimited: false,
            recoveryHistory: [],
          }
        },
      },
    })

    const result = await engine.execute(request)

    assert.equal(executedBatches, 18)
    assert.equal(result.skillTaskLifecycle?.state, 'budget_paused')
    assert.equal(result.skillTaskLifecycle?.phase, 'checkpoint')
    assert.equal(result.terminalReason, 'checkpoint_background')
  } finally {
    restoreLongToolDefinition()
  }
})

test('TurnEngine renews a progressing long skill lease and closes only when supervisor allows', async () => {
  const engine = new TurnEngine()
  const metrics: AgentMetricEvent[] = []
  const restoreLongToolDefinition = installLongSkillToolDefinitionForTest()
  let executedBatches = 0
  __setMetricSinkForTests((event) => metrics.push(event))
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
          buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer'],
        },
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => {
            const closeAllowed = executedBatches >= 100
            return makeSkillSnapshot({
              status: closeAllowed ? 'completed' : 'running',
              liveness: closeAllowed ? null : 'background',
              hasLiveWork: !closeAllowed,
              closeAllowed,
              progress: {
                currentStage: closeAllowed ? 'completed' : 'score_batches',
                totalScenes: 120,
                completedScenes: executedBatches,
                coverageRatio: executedBatches / 120,
                updatedAt: new Date(Date.parse('2026-04-28T02:00:00.000Z') + executedBatches * 1000).toISOString(),
              },
              progressFingerprint: `fp-${executedBatches}`,
            })
          },
        },
        requestToolLoopResponse: async () => {
          const nextBatch = executedBatches + 1
          return {
            text: '继续执行',
            toolCalls: [{ id: `tool-${nextBatch}`, name: 'skill_video_expert_pipeline', input: { batch: nextBatch } }],
            stopReason: 'tool_calls',
          }
        },
        executeToolBatch: async () => {
          executedBatches += 1
          return {
            results: [{
              id: `tool-${executedBatches}`,
              name: 'skill_video_expert_pipeline',
              input: { batch: executedBatches },
              result: {
                text: '仍在运行',
                data: {
                  currentStage: 'score_batches',
                  completedScenes: executedBatches,
                  runStatePath: '/tmp/ready/output/run_state.json',
                },
              },
            }],
            budgetLimited: false,
            recoveryHistory: [],
          }
        },
      },
    })

    const result = await engine.execute(request)

    assert.equal(result.success, true)
    assert.equal(result.skillTaskLifecycle, null)
    assert.ok(executedBatches >= 100 && executedBatches < 220)
    assert.ok(metrics.filter((event) =>
      event.metric === 'skill_budget_lease_decision' && event.decision === 'renew'
    ).length >= 4)
    assert.ok(metrics.some((event) =>
      event.metric === 'skill_budget_lease_decision' && event.decision === 'close'
    ))
  } finally {
    restoreLongToolDefinition()
    __setMetricSinkForTests(null)
  }
})

test('TurnEngine pauses a stalled long skill lease before the hard cap', async () => {
  const engine = new TurnEngine()
  const restoreLongToolDefinition = installLongSkillToolDefinitionForTest()
  let executedBatches = 0
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
          buildPreferredSkillToolNames: () => ['skill_video_expert_pipeline'],
          maybeInjectExplicitSkillContext: async () => {},
          listRegisteredSkillTokens: () => ['video-expert-analyzer'],
        },
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => makeSkillSnapshot({
            progress: {
              currentStage: 'score_batches',
              totalScenes: 120,
              completedScenes: 12,
              coverageRatio: 0.1,
              updatedAt: '2026-04-28T02:00:00.000Z',
            },
            progressFingerprint: 'fp-static',
          }),
        },
        requestToolLoopResponse: async () => ({
          text: '继续检查',
          toolCalls: [{
            id: `tool-${executedBatches + 1}`,
            name: 'skill_inspect_run_state',
            input: { runStatePath: '/tmp/ready/output/run_state.json' },
          }],
          stopReason: 'tool_calls',
        }),
        executeToolBatch: async () => {
          executedBatches += 1
          return {
            results: [{
              id: `tool-${executedBatches}`,
              name: 'skill_inspect_run_state',
              input: { runStatePath: '/tmp/ready/output/run_state.json' },
              result: {
                text: '状态未变化',
                data: {
                  currentStage: 'score_batches',
                  runStatePath: '/tmp/ready/output/run_state.json',
                },
              },
            }],
            budgetLimited: false,
            recoveryHistory: [],
          }
        },
      },
    })

    const result = await engine.execute(request)

    assert.equal(result.skillTaskLifecycle?.state, 'budget_paused')
    assert.equal(result.interactionState, 'suspended')
    assert.ok(executedBatches < 20)
  } finally {
    restoreLongToolDefinition()
  }
})

test('TurnEngine keeps skill budget exhaustion as checkpoint when supervisor throws', async () => {
  const engine = new TurnEngine()
  const { request, events } = createRequest({
    userText: '继续视频分析',
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
        getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'video-expert-analyzer' }),
        rememberExplicitReferenceSkillHint: () => true,
        buildPreferredSkillToolNames: () => ['skill_run_shell'],
        maybeInjectExplicitSkillContext: async () => {},
        listRegisteredSkillTokens: () => ['video-expert-analyzer'],
      },
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => {
          throw new Error('supervisor unavailable')
        },
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
          result: { text: 'monitor exited 0' },
        }],
        budgetLimited: false,
        recoveryHistory: [],
      }),
    },
  })

  const result = await engine.execute(request)

  assert.equal(result.success, true)
  assert.equal(result.skillTaskLifecycle, null)
  assert.equal(result.terminalReason, 'checkpoint_budget')
  const checkpointStatus = events.find((event) => event.kind === 'status' && event.status === 'checkpoint')
  assert.equal(
    (checkpointStatus as TurnTranscriptEvent & { terminalReason?: TurnTerminalReason | null } | undefined)?.terminalReason,
    'checkpoint_budget',
  )
  assert.equal(result.interactionState, 'suspended')
  assert.equal(result.projectionTruth?.projectionPatch?.waitingFor, 'background')
  assert.equal(result.projectionTruth?.projectionPatch?.blockedReason, '本轮预算已用完，技能任务状态检查失败或暂时不可用')
})

// =====================================================================
// Team 2 — A2 / D3: resume outcome failure paths must surface
// `resume_launch_failed` terminalReason and "恢复失败" copy instead of silently lying as "已继续".
// `makeFailedClose` / `makeKilledClose` build close events `makeChildCloseEvent`
// can't (it hardcodes error=null for non-blocked statuses).
// =====================================================================

function makeFailedClose(errorKind: string, errorMessage: string): SkillChildCloseEvent {
  return {
    childRunId: 'vchild001',
    skillId: 'video-expert-analyzer',
    status: 'failed',
    terminalReason: 'resume_launch_failed',
    outputDir: '',
    runStatePath: '',
    sceneScoresPath: null,
    deliveryReportPath: null,
    progress: {
      stage: null,
      totalUnits: null,
      completedUnits: null,
      coverageRatio: null,
      fingerprint: null,
    },
    framePatch: null,
    projectionPatch: null,
    error: { kind: errorKind, message: errorMessage },
  }
}

function makeKilledClose(): SkillChildCloseEvent {
  return {
    childRunId: 'vchild001',
    skillId: 'video-expert-analyzer',
    status: 'killed',
    terminalReason: 'cancelled_user',
    outputDir: '/tmp/ready/output',
    runStatePath: '/tmp/ready/output/run_state.json',
    sceneScoresPath: '/tmp/ready/output/scene_scores.json',
    deliveryReportPath: '/tmp/ready/output/delivery_report.json',
    progress: {
      stage: 'score_batches',
      totalUnits: 120,
      completedUnits: 12,
      coverageRatio: 0.1,
      fingerprint: 'score_batches:12/120',
    },
    framePatch: null,
    projectionPatch: null,
    error: null,
  }
}

test('resume failure with no_record surfaces failed terminalReason and failure message', async () => {
  const engine = new TurnEngine()
  const pausedClose = makeChildCloseEvent('budget_paused', 'checkpoint_budget')
  let cancelCalls = 0
  const failedClose = makeFailedClose('no_record', 'No child-run record for id vchild001')
  const { request } = createRequest({
    userText: '继续',
    host: {
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => makeChildOwnedSnapshot({ status: 'budget_paused', closeEvent: pausedClose }),
      },
      cancelSkillChildRun: async () => {
        cancelCalls += 1
        return makeKilledClose()
      },
      resumeSkillChildRun: async (childRunId: string) => ({
        childRunId,
        status: 'failed',
        outputDir: '',
        runStatePath: '',
        eventLogPath: '',
        parentNextHint: 'wait_for_close_event',
        closeEvent: failedClose,
      }),
    },
  })

  const result = await engine.execute(request)

  assert.equal(cancelCalls, 0, 'resume failure path must not call cancel')
  assert.equal(result.terminalReason, 'resume_launch_failed')
  assert.equal(result.status, 'error')
  assert.match(result.finalText, /恢复.*失败/)
  assert.ok(!/已继续/.test(result.finalText), 'must not claim "已继续" on a failed resume')
})

test('resume failure with no_payload surfaces failed terminalReason', async () => {
  const engine = new TurnEngine()
  const pausedClose = makeChildCloseEvent('budget_paused', 'checkpoint_budget')
  const failedClose = makeFailedClose('no_payload', 'Missing child-run payload for vchild001')
  const { request } = createRequest({
    userText: '继续',
    host: {
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => makeChildOwnedSnapshot({ status: 'budget_paused', closeEvent: pausedClose }),
      },
      resumeSkillChildRun: async (childRunId: string) => ({
        childRunId,
        status: 'failed',
        outputDir: '',
        runStatePath: '',
        eventLogPath: '',
        parentNextHint: 'wait_for_close_event',
        closeEvent: failedClose,
      }),
    },
  })

  const result = await engine.execute(request)

  assert.equal(result.terminalReason, 'resume_launch_failed')
  assert.notEqual(result.terminalReason, 'done')
  assert.match(result.finalText, /恢复.*失败/)
})

test('resume that returns a killed close surfaces cancelled_user terminalReason', async () => {
  const engine = new TurnEngine()
  const pausedClose = makeChildCloseEvent('budget_paused', 'checkpoint_budget')
  const killedClose = makeKilledClose()
  const { request } = createRequest({
    userText: '继续',
    host: {
      skillTaskSupervisor: {
        inspectLatestSkillTask: () => makeChildOwnedSnapshot({ status: 'budget_paused', closeEvent: pausedClose }),
      },
      resumeSkillChildRun: async (childRunId: string) => ({
        childRunId,
        status: 'killed',
        outputDir: '/tmp/ready/output',
        runStatePath: '/tmp/ready/output/run_state.json',
        eventLogPath: '/tmp/ready/output/child-run.jsonl',
        parentNextHint: 'continue_other_work',
        closeEvent: killedClose,
      }),
    },
  })

  const result = await engine.execute(request)

  assert.equal(result.terminalReason, 'cancelled_user')
  assert.equal(result.cancelled, true)
  assert.equal(result.status, 'cancelled')
  assert.match(result.finalText, /被取消/)
})

test('cancel and resume share the renderChildCommandOutcome helper', () => {
  const killed = makeKilledClose()
  const cancelOutcome = renderChildCommandOutcome({
    childRunId: 'vchild001',
    command: 'cancel',
    close: killed,
  })
  const resumeOutcome = renderChildCommandOutcome({
    childRunId: 'vchild001',
    command: 'resume',
    close: killed,
  })

  // Same close → both routes converge on cancelled_user / cancelled.
  assert.equal(cancelOutcome.terminalReason, 'cancelled_user')
  assert.equal(resumeOutcome.terminalReason, 'cancelled_user')
  assert.equal(cancelOutcome.status, 'cancelled')
  assert.equal(resumeOutcome.status, 'cancelled')

  // Both messages are non-empty and distinct (cancel-vs-resume copy).
  assert.ok(cancelOutcome.message.length > 0)
  assert.ok(resumeOutcome.message.length > 0)
  assert.notEqual(cancelOutcome.message, resumeOutcome.message)
})

test('resume disabled by flag does not call resumeSkillChildRun and emits metric', async () => {
  // Production rollback gate: when READY_SKILL_CHILD_RESUME_ENABLED='0',
  // the TurnEngine must skip its automatic resume branch entirely, emit
  // `skill_child_resume_disabled_by_flag`, and let the turn proceed to
  // the normal model path. The runner's resume API is not invoked.
  const previousFlag = process.env.READY_SKILL_CHILD_RESUME_ENABLED
  process.env.READY_SKILL_CHILD_RESUME_ENABLED = '0'
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const engine = new TurnEngine()
    const pausedClose = makeChildCloseEvent('budget_paused', 'checkpoint_budget')
    const { request } = createRequest({
      userText: '继续',
      host: {
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => makeChildOwnedSnapshot({ status: 'budget_paused', closeEvent: pausedClose }),
        },
        resumeSkillChildRun: async () => {
          assert.fail('resumeSkillChildRun must not be called when READY_SKILL_CHILD_RESUME_ENABLED=0')
        },
      },
    })

    const result = await engine.execute(request)

    // Turn finished without crashing (fell through to normal model path).
    assert.equal(result.success, true)
    // Metric was emitted on the disabled path.
    const disabledMetrics = metrics.filter((event) => event.metric === 'skill_child_resume_disabled_by_flag')
    assert.equal(disabledMetrics.length, 1, 'expected exactly one skill_child_resume_disabled_by_flag emit')
    assert.equal(disabledMetrics[0].childRunId, 'vchild001')
    assert.equal(disabledMetrics[0].childStatus, 'budget_paused')
    // No resume-success metric was emitted (resume branch was skipped).
    const resumedMetrics = metrics.filter((event) => event.metric === 'turn_child_run_resumed')
    assert.equal(resumedMetrics.length, 0, 'turn_child_run_resumed must not be emitted on the disabled path')
  } finally {
    __setMetricSinkForTests(null)
    if (typeof previousFlag === 'undefined') {
      delete process.env.READY_SKILL_CHILD_RESUME_ENABLED
    } else {
      process.env.READY_SKILL_CHILD_RESUME_ENABLED = previousFlag
    }
  }
})

// =============================================================================
// Stage 4 W0 — Contract pinning (test-only, current-behavior baseline)
// =============================================================================
// These tests pin the CURRENT shape of turn-engine.ts so Stage 4 W2 cannot
// silently drift while collapsing the 6 parallel skill rearm sections into
// SkillTurnIdentity. Each test names exactly what later W must change.
// Behavioral contracts (e.g. preferred_skill_tools metric emission for explicit
// skill mention) are already pinned by existing route tests above.

test('Stage 4 W2: turn-engine.ts has 0 inline "用户希望继续使用 skill" rearm injection sites — collapsed into applySkillTurnIdentity', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: W2 collapsed the 5 parallel rearm sections (legacy lines 1468/1484/1497/1587/1598) through `applySkillTurnIdentity` in skill-turn-identity.ts. This pin guards against any regression that re-introduces inline rearm in turn-engine.ts.
  const source = readFileSync(resolve(process.cwd(), 'src/main/modules/agent-control/turn-engine.ts'), 'utf8')
  const matches = source.match(/用户希望继续使用 skill/g) || []
  assert.equal(matches.length, 0, `turn-engine.ts must not contain inline "用户希望继续使用 skill" rearm strings post-W2. Found ${matches.length}; the canonical home is skill-turn-identity.ts:applySkillTurnIdentity.`)
})

test('Stage 4 W0: turn-engine.ts gates clearLastReferenceSkill on !shouldBindSkillContextForTurn — W2 applySkillTurnIdentity must preserve this predicate (NOT simplify mode:none → clear)', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: per v6 plan v3→v4 修订表 #4, the actual hint clear predicate is !shouldBindSkillContextForTurn (turn-engine.ts:1628-1640), NOT identity.mode === 'none'. applySkillTurnIdentity must preserve this verbatim.
  const source = readFileSync(resolve(process.cwd(), 'src/main/modules/agent-control/turn-engine.ts'), 'utf8')
  assert.match(source, /const shouldBindSkillContextForTurn = Boolean\(/, 'shouldBindSkillContextForTurn predicate must remain — Stage 4 W2 must preserve verbatim, not simplify')
  assert.match(
    source,
    /if \(!shouldBindSkillContextForTurn && request\.sessionId\) \{\s*clearLastReferenceSkill\(request\.sessionId\)/,
    'clearLastReferenceSkill must remain gated on !shouldBindSkillContextForTurn (NOT on identity.mode === none)',
  )
})

test('Stage 4 W2: skill resume + force_tool checkpoint reminders route through SystemReminderRegistry topics', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: per v6 plan §4 W2, two specific reminders that previously lived as raw inline strings are now routed through SystemReminderRegistry with dedicated topics. This test pins the post-W2 invariant that future refactors must preserve the registry routing (changing the topic name without updating both ends would silently break taxonomy).
  const source = readFileSync(resolve(process.cwd(), 'src/main/modules/agent-control/turn-engine.ts'), 'utf8')

  // buildSkillResumeContextPrompt must call composeSystemReminderText with
  // the dedicated topic. Strings still appear inline because the function
  // body assembles the text — the routing happens at the return statement.
  assert.match(
    source,
    /composeSystemReminderText\(\{\s*topic:\s*['"]skill-resume-context-prompt['"]/,
    'buildSkillResumeContextPrompt must route through SystemReminderRegistry topic skill-resume-context-prompt',
  )

  // force_tool checkpoint must use the dedicated topic, not generic 'missing-input'.
  assert.match(
    source,
    /pushSystemReminderMessage\([\s\S]*?topic:\s*['"]force-tool-checkpoint-blocked['"]/,
    'force_tool checkpoint must use SystemReminderRegistry topic force-tool-checkpoint-blocked (not generic missing-input)',
  )
})

test('Stage 4 W2: SystemReminderRegistry exposes the two new topics', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: the topics added in W2 must be present in both the ReminderTopic union and the DEFAULT_CONFLICTS map. Without both, registration would either fail to typecheck or silently bypass conflict resolution.
  const registrySource = readFileSync(resolve(process.cwd(), 'src/main/modules/agent-control/system-reminders/system-reminder-registry.ts'), 'utf8')
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: see comment above; the assembly module's DEFAULT_CONFLICTS map is the second half of the topic registration that must stay in lock-step with the union.
  const assemblySource = readFileSync(resolve(process.cwd(), 'src/main/modules/agent-control/system-reminders/system-reminder-assembly.ts'), 'utf8')

  assert.match(registrySource, /'skill-resume-context-prompt'/, 'ReminderTopic union must include skill-resume-context-prompt')
  assert.match(registrySource, /'force-tool-checkpoint-blocked'/, 'ReminderTopic union must include force-tool-checkpoint-blocked')

  assert.match(assemblySource, /'skill-resume-context-prompt':\s*\[/, 'DEFAULT_CONFLICTS must list skill-resume-context-prompt entry')
  assert.match(assemblySource, /'force-tool-checkpoint-blocked':\s*\[/, 'DEFAULT_CONFLICTS must list force-tool-checkpoint-blocked entry')
})
