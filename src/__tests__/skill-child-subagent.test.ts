import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSkillChildSubAgentFromPersisted } from '../main/modules/agent-control/skills/skill-child-sub-agent-factory'
import { mapSubAgentCloseToChildClose } from '../main/modules/agent-control/skills/skill-child-sub-agent-close-mapping'
import {
  createSkillChildSubAgent,
  getSkillChildCloseEventFromSubAgentClose,
  isSkillChildSubAgentProgressPayload,
  type SkillChildSubAgentActionExecutor,
} from '../main/modules/agent-control/skills/skill-child-sub-agent'
import { runSubAgent } from '../main/modules/agent-control/sub-agent/sub-agent-runner'
import type {
  SubAgentCleanupHandle,
  SubAgentCloseEvent,
  SubAgentEvent,
} from '../main/modules/agent-control/sub-agent/sub-agent-types'
import type { SkillRunResult } from '../main/modules/skills-runtime/runtime-manager'
import type { SkillChildDriver } from '../main/modules/agent-control/skills/skill-child-drivers'
import type {
  SkillChildCloseEvent,
  SkillChildDriverAction,
  SkillChildDriverState,
  SkillChildRunPayload,
} from '../main/modules/agent-control/skills/skill-child-run-types'

async function collectRun(
  generator: AsyncGenerator<SubAgentEvent, SubAgentCloseEvent, void>,
): Promise<{ events: SubAgentEvent[]; closeEvent: SubAgentCloseEvent }> {
  const events: SubAgentEvent[] = []
  while (true) {
    const next = await generator.next()
    if (next.done) return { events, closeEvent: next.value }
    events.push(next.value)
  }
}

function makeCleanup(): SubAgentCleanupHandle {
  return {
    register() {},
    async drain() {},
  }
}

function makeResult(overrides: Partial<SkillRunResult> = {}): SkillRunResult {
  return {
    success: true,
    skillId: 'test-child-skill',
    action: 'step_one',
    stdout: '',
    stderr: '',
    command: [],
    status: 'done',
    outputDir: '/tmp/ready-child-out',
    ...overrides,
  }
}

function makeClose(
  overrides: Partial<SkillChildCloseEvent> = {},
): SkillChildCloseEvent {
  return {
    childRunId: 'child-1',
    skillId: 'test-child-skill',
    status: 'completed',
    terminalReason: 'completed',
    outputDir: '/tmp/ready-child-out',
    runStatePath: '/tmp/ready-child-out/run_state.json',
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
    error: null,
    ...overrides,
  }
}

function makeDriver(options: {
  plans: Array<SkillChildDriverAction | SkillChildCloseEvent>
  observe?: (state: SkillChildDriverState, result: SkillRunResult) => Promise<SkillChildDriverState>
  closeAfterActionFailure?: (state: SkillChildDriverState, result: SkillRunResult) => Promise<SkillChildCloseEvent | null>
  planThrows?: boolean
}): SkillChildDriver {
  return {
    skillId: 'test-child-skill',
    canStart: () => true,
    canResume: () => true,
    async createInitialState(params) {
      return {
        requestedInput: params.requestedInput,
      }
    },
    async planNextAction() {
      if (options.planThrows) throw new Error('plan exploded')
      const next = options.plans.shift()
      return next ?? makeClose()
    },
    async closeAfterActionFailure(state, result) {
      return options.closeAfterActionFailure
        ? options.closeAfterActionFailure(state, result)
        : null
    },
    async observeAfterAction(state, result) {
      if (options.observe) return options.observe(state, result)
      return {
        ...state,
        lastStatus: result.status ?? null,
      }
    },
  }
}

function makeSubAgent(options: {
  driver: SkillChildDriver
  executeAction?: SkillChildSubAgentActionExecutor
  maxActions?: number
}) {
  return createSkillChildSubAgent({
    childRunId: 'child-1',
    outputDir: '/tmp/ready-child-out',
    runStatePath: '/tmp/ready-child-out/run_state.json',
    driver: options.driver,
    initialState: { phase: 'initial' },
    executeAction: options.executeAction ?? (async () => makeResult()),
    parentScopeId: 'scope-1',
    parentSessionId: 'session-1',
    maxActions: options.maxActions,
  })
}

test('SkillChildSubAgent.run yields action lifecycle progress for driver actions', async () => {
  let executorState: SkillChildDriverState | null = null
  const driver = makeDriver({
    plans: [
      { action: 'step_one', input: { n: 1 } },
      makeClose(),
    ],
    observe: async (state, result) => ({
      ...state,
      lastStatus: result.status ?? null,
      parsedRunState: { currentStage: 'score_batches' },
      progress: { fingerprint: 'fp-1' },
    }),
  })
  const subagent = makeSubAgent({
    driver,
    executeAction: async (_action, state) => {
      executorState = state
      return makeResult()
    },
  })

  const { events, closeEvent } = await collectRun(runSubAgent(subagent, {
    abortSignal: new AbortController().signal,
    cleanup: makeCleanup(),
  }))

  const progressPayloads = events
    .filter((event) => event.type === 'progress')
    .map((event) => event.payload)
    .filter(isSkillChildSubAgentProgressPayload)

  assert.deepEqual(progressPayloads, [
    { kind: 'action_started', actionName: 'step_one', actionInput: { n: 1 }, actionIndex: 1 },
    { kind: 'action_completed', actionName: 'step_one', success: true, durationMs: progressPayloads[1]?.durationMs },
    { kind: 'state_observed', stage: 'score_batches', fingerprint: 'fp-1' },
  ])
  assert.equal(executorState?.phase, 'initial')
  assert.equal(closeEvent.state, 'completed')
  assert.equal(getSkillChildCloseEventFromSubAgentClose(closeEvent)?.terminalReason, 'completed')
})

test('SkillChildSubAgent.run yields budget pause and preserves checkpoint_budget close', async () => {
  const driver = makeDriver({
    plans: [
      { action: 'step_one', input: {} },
      { action: 'step_two', input: {} },
    ],
  })
  const subagent = makeSubAgent({ driver, maxActions: 1 })

  const { events, closeEvent } = await collectRun(runSubAgent(subagent, {
    abortSignal: new AbortController().signal,
    cleanup: makeCleanup(),
  }))

  const paused = events.find((event) => event.type === 'paused')
  const childClose = getSkillChildCloseEventFromSubAgentClose(closeEvent)
  assert.equal(paused?.type, 'paused')
  assert.equal(childClose?.status, 'budget_paused')
  assert.equal(childClose?.terminalReason, 'checkpoint_budget')
})

test('SkillChildSubAgent.run preserves recoverable close events from the driver', async () => {
  const driver = makeDriver({
    plans: [
      makeClose({
        status: 'recoverable_paused',
        terminalReason: 'checkpoint_background',
        error: { kind: 'missing_inputs', message: 'missing URL' },
      }),
    ],
  })
  const subagent = makeSubAgent({ driver })

  const { closeEvent } = await collectRun(runSubAgent(subagent, {
    abortSignal: new AbortController().signal,
    cleanup: makeCleanup(),
  }))

  const childClose = getSkillChildCloseEventFromSubAgentClose(closeEvent)
  assert.equal(closeEvent.state, 'blocked')
  assert.equal(closeEvent.terminalReason, 'checkpoint_background')
  assert.equal(childClose?.error?.kind, 'missing_inputs')
})

test('SkillChildSubAgent.run returns completed terminal for driver completion', async () => {
  const subagent = makeSubAgent({
    driver: makeDriver({ plans: [makeClose({ status: 'completed', terminalReason: 'completed' })] }),
  })

  const { closeEvent } = await collectRun(runSubAgent(subagent, {
    abortSignal: new AbortController().signal,
    cleanup: makeCleanup(),
  }))

  assert.equal(closeEvent.state, 'completed')
  assert.equal(closeEvent.terminalReason, 'completed')
  assert.equal(getSkillChildCloseEventFromSubAgentClose(closeEvent)?.status, 'completed')
})

test('SkillChildSubAgent.run maps driver throw to failed_skill without losing child close', async () => {
  const subagent = makeSubAgent({
    driver: makeDriver({ plans: [], planThrows: true }),
  })

  const { closeEvent } = await collectRun(runSubAgent(subagent, {
    abortSignal: new AbortController().signal,
    cleanup: makeCleanup(),
  }))

  const childClose = getSkillChildCloseEventFromSubAgentClose(closeEvent)
  assert.equal(closeEvent.state, 'failed')
  assert.equal(childClose?.terminalReason, 'failed_skill')
  assert.equal(childClose?.error?.kind, 'driver_plan_failed')
})

test('SkillChildSubAgent.run preserves blocked close and handles from blocked action result', async () => {
  const outputDir = '/tmp/ready-child-blocked-action'
  const runStatePath = '/tmp/ready-child-blocked-action/run_state.json'
  const sceneScoresPath = '/tmp/ready-child-blocked-action/scene_scores.json'
  const subagent = makeSubAgent({
    driver: makeDriver({
      plans: [
        { action: 'step_one', input: {} },
        makeClose(),
      ],
    }),
    executeAction: async () => makeResult({
      success: false,
      status: 'blocked',
      error: 'waiting on external review',
      outputDir,
      outputs: {
        outputDir,
        runStatePath,
        sceneScoresPath,
      },
    }),
  })

  const { closeEvent } = await collectRun(runSubAgent(subagent, {
    abortSignal: new AbortController().signal,
    cleanup: makeCleanup(),
  }))

  const childClose = getSkillChildCloseEventFromSubAgentClose(closeEvent)
  assert.equal(closeEvent.state, 'blocked')
  assert.equal(closeEvent.terminalReason, 'blocked_external')
  assert.equal(childClose?.status, 'blocked')
  assert.equal(childClose?.terminalReason, 'blocked_external')
  assert.equal(childClose?.outputDir, outputDir)
  assert.equal(childClose?.runStatePath, runStatePath)
  assert.equal(childClose?.sceneScoresPath, sceneScoresPath)
  assert.equal(childClose?.error?.kind, 'blocked_external')
})

test('SkillChildSubAgent.run preserves disk blocked run_state during failed action normalization', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'ready-child-blocked-run-state-'))
  const runStatePath = join(outputDir, 'run_state.json')
  const sceneScoresPath = join(outputDir, 'scene_scores.json')
  await writeFile(
    runStatePath,
    JSON.stringify({
      status: 'blocked',
      current_stage: 'merge_validate',
      scene_scores_path: sceneScoresPath,
    }),
    'utf8',
  )
  await writeFile(sceneScoresPath, JSON.stringify({ scenes: [] }), 'utf8')
  const subagent = makeSubAgent({
    driver: makeDriver({
      plans: [
        { action: 'step_one', input: {} },
        makeClose(),
      ],
    }),
    executeAction: async () => makeResult({
      success: false,
      error: 'script exited while waiting for review',
      outputDir,
      outputs: {
        outputDir,
        runStatePath,
        sceneScoresPath,
      },
    }),
  })

  const { closeEvent } = await collectRun(runSubAgent(subagent, {
    abortSignal: new AbortController().signal,
    cleanup: makeCleanup(),
  }))

  const childClose = getSkillChildCloseEventFromSubAgentClose(closeEvent)
  assert.equal(closeEvent.state, 'blocked')
  assert.equal(childClose?.status, 'blocked')
  assert.equal(childClose?.terminalReason, 'blocked_external')
  assert.notEqual(childClose?.terminalReason, 'failed_skill')
  assert.equal(childClose?.runStatePath, runStatePath)
  assert.equal(childClose?.sceneScoresPath, sceneScoresPath)
})

test('SkillChildSubAgent.run keeps true failed action results as failed_skill', async () => {
  const subagent = makeSubAgent({
    driver: makeDriver({
      plans: [
        { action: 'step_one', input: {} },
        makeClose(),
      ],
    }),
    executeAction: async () => makeResult({
      success: false,
      status: 'error',
      error: 'runtime crashed',
    }),
  })

  const { closeEvent } = await collectRun(runSubAgent(subagent, {
    abortSignal: new AbortController().signal,
    cleanup: makeCleanup(),
  }))

  const childClose = getSkillChildCloseEventFromSubAgentClose(closeEvent)
  assert.equal(closeEvent.state, 'failed')
  assert.equal(childClose?.status, 'failed')
  assert.equal(childClose?.terminalReason, 'failed_skill')
})

test('SkillChildSubAgent.run lets a driver convert failed action results to recoverable close', async () => {
  const subagent = makeSubAgent({
    driver: makeDriver({
      plans: [
        { action: 'step_one', input: {} },
        makeClose(),
      ],
      closeAfterActionFailure: async () => makeClose({
        childRunId: 'wrong-id',
        status: 'recoverable_paused',
        terminalReason: 'checkpoint_background',
        error: { kind: 'download_video_unavailable', message: 'download failed' },
      }),
    }),
    executeAction: async () => makeResult({
      success: false,
      status: 'error',
      error: 'yt-dlp download failed',
    }),
  })

  const { closeEvent } = await collectRun(runSubAgent(subagent, {
    abortSignal: new AbortController().signal,
    cleanup: makeCleanup(),
  }))

  const childClose = getSkillChildCloseEventFromSubAgentClose(closeEvent)
  assert.equal(closeEvent.state, 'blocked')
  assert.equal(childClose?.childRunId, 'child-1')
  assert.equal(childClose?.status, 'recoverable_paused')
  assert.equal(childClose?.terminalReason, 'checkpoint_background')
  assert.equal(childClose?.error?.kind, 'download_video_unavailable')
})

test('createSkillChildSubAgentFromPersisted reconstructs from durable payload', async () => {
  const payload: SkillChildRunPayload = {
    version: 1,
    childRunId: 'child-persisted',
    kind: 'skill',
    parentScopeId: 'scope-persisted',
    parentSessionId: 'session-persisted',
    skillId: 'test-child-skill',
    skillName: 'Test Child Skill',
    requestedAction: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/video' },
    singleFlightKey: 'scope:test-child-skill:video',
    parentNextHint: 'wait_for_close_event',
    outputDir: '/tmp/ready-child-persisted',
    runStatePath: '/tmp/ready-child-persisted/run_state.json',
    eventLogPath: '/tmp/ready-child-persisted/child.jsonl',
    status: 'recoverable_paused',
    closeEvent: null,
  }
  const subagent = await createSkillChildSubAgentFromPersisted({
    payload,
    driver: makeDriver({ plans: [makeClose({ childRunId: 'child-persisted' })] }),
    executeAction: async () => makeResult(),
  })

  assert.equal(subagent.lifecycleId, 'child-persisted')
  assert.equal(subagent.durableRunId, 'child-persisted')
  assert.equal(subagent.artifactDir, '/tmp/ready-child-persisted')
})

function makeSubAgentClose(overrides: Partial<SubAgentCloseEvent> = {}): SubAgentCloseEvent {
  return {
    lifecycleId: 'child-1',
    durableRunId: 'child-1',
    subagentName: 'SkillChildSubAgent',
    state: 'completed',
    terminalReason: 'completed',
    terminalAt: '2026-05-01T00:00:00.000Z',
    artifactDir: '/tmp/ready-child-out',
    outputDir: '/tmp/ready-child-out',
    runStatePath: '/tmp/ready-child-out/run_state.json',
    progress: null,
    error: null,
    parentScopeId: 'scope-1',
    parentSessionId: 'session-1',
    ...overrides,
  }
}

const mappingContext = {
  childRunId: 'child-1',
  skillId: 'test-child-skill',
  outputDir: '/tmp/ready-child-out',
  runStatePath: '/tmp/ready-child-out/run_state.json',
}

test('mapSubAgentCloseToChildClose maps completed terminals', () => {
  const close = mapSubAgentCloseToChildClose(makeSubAgentClose(), mappingContext)
  assert.equal(close.status, 'completed')
  assert.equal(close.terminalReason, 'completed')
  assert.equal(close.error, null)
})

test('mapSubAgentCloseToChildClose maps abort by runtime context', () => {
  const userClose = mapSubAgentCloseToChildClose(
    makeSubAgentClose({ state: 'cancelled', terminalReason: 'aborted' }),
    { ...mappingContext, isUserCancel: true },
  )
  const parentClose = mapSubAgentCloseToChildClose(
    makeSubAgentClose({ state: 'cancelled', terminalReason: 'aborted' }),
    { ...mappingContext, isParentSessionAbort: true },
  )
  assert.equal(userClose.status, 'killed')
  assert.equal(userClose.terminalReason, 'cancelled_user')
  assert.equal(parentClose.status, 'killed')
  assert.equal(parentClose.terminalReason, 'process_restarted')
})

test('mapSubAgentCloseToChildClose maps failed_subagent error kinds', () => {
  const cases = [
    ['driver_plan_failed', 'failed_skill'],
    ['ProcessExitError', 'child_process_crashed'],
    ['ChildProcessTerminationError', 'child_process_crashed'],
    ['ZodError', 'input_validation'],
    ['SchemaValidationError', 'input_validation'],
    ['ToolHostUnavailableError', 'host_unavailable'],
  ] as const

  for (const [kind, expectedReason] of cases) {
    const close = mapSubAgentCloseToChildClose(
      makeSubAgentClose({
        state: 'failed',
        terminalReason: 'failed_subagent',
        error: { kind, message: kind },
      }),
      mappingContext,
    )
    assert.equal(close.status, 'failed')
    assert.equal(close.terminalReason, expectedReason)
  }
})

test('mapSubAgentCloseToChildClose lets launch_stuck context override failed_subagent error kind', () => {
  const close = mapSubAgentCloseToChildClose(
    makeSubAgentClose({
      state: 'failed',
      terminalReason: 'failed_subagent',
      error: { kind: 'ProcessExitError', message: 'stuck' },
    }),
    { ...mappingContext, isLaunchStuckFired: true },
  )
  assert.equal(close.status, 'failed')
  assert.equal(close.terminalReason, 'launch_stuck')
})

test('mapSubAgentCloseToChildClose passes through persistence failure', () => {
  const close = mapSubAgentCloseToChildClose(
    makeSubAgentClose({
      state: 'failed',
      terminalReason: 'persistence_failed',
      error: { kind: 'persistence_failed', message: 'disk' },
    }),
    mappingContext,
  )
  assert.equal(close.status, 'failed')
  assert.equal(close.terminalReason, 'persistence_failed')
})

test('mapSubAgentCloseToChildClose maps checkpoint pauses', () => {
  const budget = mapSubAgentCloseToChildClose(
    makeSubAgentClose({ state: 'blocked', terminalReason: 'checkpoint_budget' }),
    mappingContext,
  )
  const background = mapSubAgentCloseToChildClose(
    makeSubAgentClose({ state: 'blocked', terminalReason: 'checkpoint_background' }),
    mappingContext,
  )
  assert.equal(budget.status, 'budget_paused')
  assert.equal(budget.terminalReason, 'checkpoint_budget')
  assert.equal(background.status, 'budget_paused')
  assert.equal(background.terminalReason, 'checkpoint_background')
})

test('mapSubAgentCloseToChildClose maps blocked terminals', () => {
  const external = mapSubAgentCloseToChildClose(
    makeSubAgentClose({ state: 'blocked', terminalReason: 'blocked_external' }),
    mappingContext,
  )
  const config = mapSubAgentCloseToChildClose(
    makeSubAgentClose({ state: 'blocked', terminalReason: 'blocked_config' }),
    mappingContext,
  )
  assert.equal(external.status, 'blocked')
  assert.equal(external.terminalReason, 'blocked_external')
  assert.equal(config.status, 'blocked')
  assert.equal(config.terminalReason, 'blocked_config')
})

test('mapSubAgentCloseToChildClose preserves child close metadata', () => {
  const preserved = makeClose({
    childRunId: 'wrong-id',
    skillId: 'wrong-skill',
    status: 'failed',
    terminalReason: 'failed_skill',
  })
  const close = mapSubAgentCloseToChildClose(
    makeSubAgentClose({
      metadata: { skillChildCloseEvent: preserved },
    }),
    mappingContext,
  )
  assert.equal(close.childRunId, 'child-1')
  assert.equal(close.skillId, 'test-child-skill')
  assert.equal(close.terminalReason, 'failed_skill')
})
