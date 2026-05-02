import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { buildRequestEnvelope } from '../main/modules/agent-control/request-envelope'
import { TurnEngine } from '../main/modules/agent-control/turn-engine'
import {
  configureSkillChildRunner,
  __resetSkillChildRunnerForTests,
  resumeSkillChildRun,
} from '../main/modules/agent-control/skill-child-runner'
import {
  registerSkillChildDriver,
  __resetSkillChildDriversForTests,
  type SkillChildDriver,
} from '../main/modules/agent-control/skill-child-drivers'
import type {
  SkillChildCloseEvent,
  SkillChildDriverAction,
  SkillChildDriverState,
} from '../main/modules/agent-control/skill-child-run-types'
import type {
  SkillRunRequest,
  SkillRunResult,
  SkillsRuntimeManager,
} from '../main/modules/skills-runtime/runtime-manager'
import type {
  SkillTaskRunRecord,
  SkillTaskRunRepository,
} from '../main/modules/repositories/skill-task-run-repository'
import type {
  IntentClassification,
} from '../main/modules/agent-control/intent-classifier'
import type { DomainAdapter } from '../main/modules/agent-control/domain-adapter'
import type {
  SkillTaskSupervisorSnapshot,
} from '../main/modules/agent-control/skill-task-supervisor'
import type {
  RunBudgetSeed,
  RunBudgetUsage,
  TurnEngineRequest,
  TurnEngineSession,
  TurnTranscriptEvent,
} from '../main/modules/agent-control/run-contracts'

function makeFakeRepository(): {
  repo: SkillTaskRunRepository
  rows: Map<string, SkillTaskRunRecord>
} {
  const rows = new Map<string, SkillTaskRunRecord>()
  const repo = {
    createChildRun: (input: Parameters<SkillTaskRunRepository['createChildRun']>[0]) => {
      const now = new Date().toISOString()
      const record: SkillTaskRunRecord = {
        id: input.childRunId,
        scopeId: input.scopeId ?? null,
        sessionId: input.sessionId ?? null,
        agent: null,
        runId: null,
        skillId: input.skillId,
        skillName: input.skillName ?? null,
        action: input.action,
        toolName: null,
        runKind: 'child_run',
        status: input.status ?? 'running',
        interactionState: 'running',
        goalText: null,
        resourceRefs: [],
        params: input.requestedInput,
        steps: [],
        currentStepId: null,
        artifacts: [],
        outputDir: input.outputDir,
        runStatePath: input.runStatePath,
        sceneScoresPath: null,
        deliveryReportPath: null,
        failureKind: null,
        failureDetail: null,
        jobId: null,
        detachedTaskId: null,
        resumePayload: {
          childRun: {
            version: 1,
            childRunId: input.childRunId,
            kind: 'skill',
            parentScopeId: input.scopeId,
            parentSessionId: input.sessionId,
            skillId: input.skillId,
            skillName: input.skillName,
            requestedAction: input.action,
            requestedInput: input.requestedInput,
            singleFlightKey: input.singleFlightKey,
            parentNextHint: input.parentNextHint,
            outputDir: input.outputDir,
            runStatePath: input.runStatePath,
            eventLogPath: input.eventLogPath,
            status: input.status ?? 'running',
            closeEvent: null,
            legacy: { taskRunId: null, detachedTaskId: null, projectionTaskId: null },
          },
        },
        createdAt: now,
        startedAt: null,
        updatedAt: now,
        finishedAt: null,
      }
      rows.set(input.childRunId, record)
      return record
    },
    updateChildRun: (childRunId: string, patch: Record<string, unknown>) => {
      const existing = rows.get(childRunId)
      if (!existing) throw new Error(`no row ${childRunId}`)
      const payload = (existing.resumePayload as { childRun: Record<string, unknown> }).childRun
      existing.resumePayload = { childRun: { ...payload, ...patch } }
      if (typeof patch.status === 'string') existing.status = patch.status as SkillTaskRunRecord['status']
      existing.updatedAt = new Date().toISOString()
    },
    findLatestChildRunByKey: () => null,
    findLatestChildRunBySkill: () => null,
    get: (id: string) => rows.get(id) ?? null,
  } as unknown as SkillTaskRunRepository
  return { repo, rows }
}

function makeFakeRuntime(): SkillsRuntimeManager {
  return {
    getRuntimeInfo: () => ({
      runtimeRoot: '/tmp/fake-runtime',
      skillsRoot: '/tmp/fake-runtime/skills',
      customSkillsRoot: '/tmp/fake-runtime/custom',
      outputsRoot: '/tmp/fake-runtime/outputs',
      venvRoot: '/tmp/fake-runtime/venv',
    }),
    runSkill: async (request: SkillRunRequest): Promise<SkillRunResult> => ({
      success: true,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
    }),
    runSkillFromChildRunner: async (request: SkillRunRequest): Promise<SkillRunResult> => ({
      success: true,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
    }),
  } as unknown as SkillsRuntimeManager
}

function registerHangingDriver(
  skillId: string,
  hangPromise: Promise<SkillChildDriverAction | SkillChildCloseEvent>,
): void {
  const driver: SkillChildDriver = {
    skillId,
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params): Promise<SkillChildDriverState> => ({
      skillId,
      requestedInput: params.requestedInput,
    }),
    planNextAction: async () => hangPromise,
    observeAfterAction: async (state) => state,
  }
  registerSkillChildDriver(driver)
}

function makeCloseEvent(
  status: SkillChildCloseEvent['status'],
  terminalReason: SkillChildCloseEvent['terminalReason'],
): SkillChildCloseEvent {
  return {
    childRunId: 'child-fresh-contract',
    skillId: 'test-skill-fresh-contract',
    status,
    terminalReason,
    outputDir: '/tmp/fake-runtime/outputs/test-skill-fresh-contract/run',
    runStatePath: '/tmp/fake-runtime/outputs/test-skill-fresh-contract/run/run_state.json',
    sceneScoresPath: null,
    deliveryReportPath: null,
    progress: { stage: null, totalUnits: null, completedUnits: null, coverageRatio: null, fingerprint: null },
    framePatch: null,
    projectionPatch: null,
    error: null,
  }
}

test('clean resume returns freshContractFields with running state and null close', async () => {
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  const { repo, rows } = makeFakeRepository()
  configureSkillChildRunner({
    runtimeManager: makeFakeRuntime(),
    repository: repo,
    launchStuckGuardMs: 5_000,
  })

  let release!: (value: SkillChildDriverAction | SkillChildCloseEvent) => void
  const hangPromise = new Promise<SkillChildDriverAction | SkillChildCloseEvent>((resolve) => {
    release = resolve
  })
  registerHangingDriver('test-skill-fresh-contract', hangPromise)

  const childRunId = 'child-fresh-contract'
  const url = 'https://example.com/fresh-contract'
  const targetDigest = createHash('sha256').update(`url:${url}`).digest('hex').slice(0, 16)
  const outputDir = '/tmp/fake-runtime/outputs/test-skill-fresh-contract/run'
  repo.createChildRun({
    childRunId,
    scopeId: 'scope-fresh-contract',
    sessionId: 'session-fresh-contract',
    skillId: 'test-skill-fresh-contract',
    skillName: null,
    action: 'do_thing',
    requestedInput: { url },
    singleFlightKey: `scope-fresh-contract|session-fresh-contract|test-skill-fresh-contract|${targetDigest}`,
    parentNextHint: 'wait_for_close_event',
    outputDir,
    runStatePath: `${outputDir}/run_state.json`,
    eventLogPath: `${outputDir}/child-run.jsonl`,
    status: 'budget_paused',
  })
  repo.updateChildRun(childRunId, {
    status: 'budget_paused',
    closeEvent: makeCloseEvent('budget_paused', 'checkpoint_budget'),
  })

  const result = await resumeSkillChildRun(childRunId)

  assert.equal(result.status, 'running')
  assert.deepEqual(result.freshContractFields, {
    childCloseEvent: null,
    childStatus: 'running',
    parentNextHint: 'wait_for_close_event',
  })
  const payload = (rows.get(childRunId)!.resumePayload as { childRun: { closeEvent: unknown; status: unknown } }).childRun
  assert.equal(payload.status, 'running')
  assert.equal(payload.closeEvent, null)

  release(makeCloseEvent('completed', 'completed'))
  await new Promise((resolve) => setTimeout(resolve, 0))
})

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
        events.push({ kind: 'output', type, chunk, projectionPatch: null } as TurnTranscriptEvent)
      },
      emitStatus: (status: string) => {
        events.push({ kind: 'status', status })
      },
      emitRuntimeError: (error: unknown) => {
        events.push({ kind: 'error', error: error instanceof Error ? error.message : String(error) })
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
      runDeterministicExecution: async () => ({ handled: false, state: 'done', message: '' }),
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
    requestToolLoopResponse: async () => ({ text: 'tool loop result', toolCalls: [], stopReason: 'stop' }),
    executeToolBatch: async () => ({ results: [], budgetLimited: false, recoveryHistory: [] }),
    ...overrides,
  }
}

function makeSkillSnapshot(overrides?: Partial<SkillTaskSupervisorSnapshot>): SkillTaskSupervisorSnapshot {
  return {
    taskRunId: 'task-child',
    detachedTaskId: 'detached-child',
    skillId: 'video-expert-analyzer',
    scopeId: 'scope-test',
    sessionId: 'scope-test',
    action: 'video_expert_pipeline',
    status: 'budget_paused',
    liveness: null,
    hasLiveWork: false,
    hasRecentProgress: false,
    closeAllowed: false,
    ambiguous: false,
    stale: false,
    outputDir: '/tmp/ready/output',
    runStatePath: '/tmp/ready/output/run_state.json',
    sceneScoresPath: null,
    deliveryReportPath: null,
    progress: {
      currentStage: 'score_batches',
      totalScenes: 120,
      completedScenes: 12,
      coverageRatio: 0.1,
      updatedAt: '2026-04-28T02:00:00.000Z',
    },
    blockers: [],
    pauseReason: 'budget_exhausted',
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
        status: 'budget_paused',
        closeEvent: makeCloseEvent('budget_paused', 'checkpoint_budget'),
        legacy: { taskRunId: 'task-child', detachedTaskId: 'detached-child', projectionTaskId: null },
      },
    },
    sourceObservations: [],
    progressFingerprint: 'fp-loop',
    observedAt: '2026-04-28T02:00:00.000Z',
    lastProgressAt: '2026-04-28T02:00:00.000Z',
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
    intentClassification: params.intentClassification ?? createIntent(),
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

test('TurnEngine applies resumed freshContractFields wholesale', async () => {
  const engine = new TurnEngine()
  const freshContractFields = {
    childCloseEvent: null,
    childStatus: 'running' as const,
    parentNextHint: 'wait_for_close_event' as const,
  }
  const originalAssign = Object.assign
  let capturedContract: Record<string, unknown> | null = null
  Object.assign = ((target: object, ...sources: object[]) => {
    if (sources.includes(freshContractFields)) {
      capturedContract = target as Record<string, unknown>
    }
    return originalAssign(target, ...sources)
  }) as ObjectConstructor['assign']
  try {
    const { request } = createRequest({
      userText: '继续',
      host: {
        skillTaskSupervisor: {
          inspectLatestSkillTask: () => makeSkillSnapshot(),
        },
        resumeSkillChildRun: async (childRunId: string) => ({
          childRunId,
          status: 'running',
          outputDir: '/tmp/ready/output',
          runStatePath: '/tmp/ready/output/run_state.json',
          eventLogPath: '/tmp/ready/output/child-run.jsonl',
          parentNextHint: 'continue_other_work',
          closeEvent: null,
          freshContractFields,
        }),
      },
    })

    const result = await engine.execute(request)

    assert.equal(result.status, 'done')
    assert.ok(capturedContract, 'resume branch must apply freshContractFields via Object.assign')
    assert.equal(capturedContract.childCloseEvent, null)
    assert.equal(capturedContract.childStatus, 'running')
    assert.equal(capturedContract.parentNextHint, 'wait_for_close_event')
  } finally {
    Object.assign = originalAssign
  }
})
