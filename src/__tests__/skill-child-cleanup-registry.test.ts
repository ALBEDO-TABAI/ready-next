import assert from 'node:assert/strict'
import test from 'node:test'

import { RunCleanupRegistry } from '../main/modules/agent-control/run-cleanup-registry'
import {
  __resetSkillChildRunnerForTests,
  cancelSkillChildRun,
  configureSkillChildRunner,
  getSkillChildRunCloseEvent,
  startSkillChildRun,
} from '../main/modules/agent-control/skill-child-runner'
import {
  __resetSkillChildDriversForTests,
  registerSkillChildDriver,
  type SkillChildDriver,
} from '../main/modules/agent-control/skill-child-drivers'
import type {
  SkillChildCloseEvent,
  SkillChildDriverAction,
  SkillChildRunPayload,
  SkillChildRunStatus,
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

test('launchStuckTimer registers cleanup via SubAgentCleanupHandle (no manual clearTimeout in finalize)', async () => {
  const guardMs = 4_321
  const parent = new AbortController()
  const timerTracker = trackLaunchStuckTimer(guardMs)
  const listenerTracker = trackAbortListeners(parent.signal)
  try {
    setup({
      parentSignal: parent.signal,
      runtime: makeRuntime(),
      launchStuckGuardMs: guardMs,
    })
    registerActionDriver('test-skill-cleanup-normal', [
      { action: 'do_thing', input: {} },
      makeTerminalClose('test-skill-cleanup-normal'),
    ])

    const launch = await startSkillChildRun({
      scopeId: 'scope-cleanup-normal',
      sessionId: 'session-cleanup-normal',
      skillId: 'test-skill-cleanup-normal',
      action: 'do_thing',
      requestedInput: { url: 'https://example.com/cleanup-normal' },
    })

    const close = await waitForClose(launch.childRunId)
    assert.equal(close.status, 'completed')
    assert.equal(timerTracker.unrefCount(), 1)
    assert.equal(timerTracker.clearCount(), 1)
    assert.equal(listenerTracker.count(), 0)
  } finally {
    listenerTracker.restore()
    timerTracker.restore()
  }
})

test('SubAgent.run() abort path drains all registered cleanups exactly once', async () => {
  const guardMs = 4_322
  const parent = new AbortController()
  const timerTracker = trackLaunchStuckTimer(guardMs)
  const listenerTracker = trackAbortListeners(parent.signal)
  try {
    setup({
      parentSignal: parent.signal,
      runtime: makeStallingRuntime(),
      launchStuckGuardMs: guardMs,
    })
    registerActionDriver('test-skill-cleanup-cancel', [
      { action: 'do_thing', input: {} },
    ])

    const launch = await startSkillChildRun({
      scopeId: 'scope-cleanup-cancel',
      sessionId: 'session-cleanup-cancel',
      skillId: 'test-skill-cleanup-cancel',
      action: 'do_thing',
      requestedInput: { url: 'https://example.com/cleanup-cancel' },
    })

    await sleep(10)
    const close = await cancelSkillChildRun(launch.childRunId, 'cancelled_user')
    assert.equal(close.status, 'killed')
    assert.equal(close.terminalReason, 'cancelled_user')
    assert.equal(timerTracker.unrefCount(), 1)
    assert.equal(timerTracker.clearCount(), 1)
    assert.equal(listenerTracker.count(), 0)
  } finally {
    listenerTracker.restore()
    timerTracker.restore()
  }
})

test('multiple cleanups register and drain in registration order', async () => {
  const registry = new RunCleanupRegistry()
  const calls: string[] = []

  registry.register('cleanup-run-1', () => {
    calls.push('first')
  })
  registry.register('cleanup-run-1', () => {
    calls.push('second')
  })
  registry.register('cleanup-run-1', () => {
    calls.push('third')
  })

  await registry.drain('cleanup-run-1')
  await registry.drain('cleanup-run-1')

  assert.deepEqual(calls, ['first', 'second', 'third'])
})

function setup(opts: {
  parentSignal: AbortSignal | null
  runtime: ReturnType<typeof makeRuntime>
  launchStuckGuardMs: number
}): void {
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  configureSkillChildRunner({
    runtimeManager: opts.runtime.manager,
    repository: makeRepository(opts.parentSignal),
    launchStuckGuardMs: opts.launchStuckGuardMs,
  })
}

function makeRuntime(): {
  manager: SkillsRuntimeManager
  calls: SkillRunRequest[]
} {
  const calls: SkillRunRequest[] = []
  const manager = {
    getRuntimeInfo: () => ({
      runtimeRoot: '/tmp/cleanup-runtime',
      skillsRoot: '/tmp/cleanup-runtime/skills',
      customSkillsRoot: '/tmp/cleanup-runtime/custom',
      outputsRoot: '/tmp/cleanup-runtime/outputs',
      venvRoot: '/tmp/cleanup-runtime/venv',
    }),
    runSkill: async (request: SkillRunRequest): Promise<SkillRunResult> => {
      calls.push(request)
      return {
        success: true,
        skillId: request.skillId,
        action: request.action,
        stdout: '',
        stderr: '',
        command: [],
      }
    },
    runSkillFromChildRunner: async (request: SkillRunRequest): Promise<SkillRunResult> =>
      manager.runSkill(request),
  } as unknown as SkillsRuntimeManager
  return { manager, calls }
}

function makeStallingRuntime(): ReturnType<typeof makeRuntime> {
  const runtime = makeRuntime()
  runtime.manager.runSkill = (async (request: SkillRunRequest): Promise<SkillRunResult> => {
    runtime.calls.push(request)
    await new Promise<void>(() => {})
    return {
      success: true,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
    }
  }) as SkillsRuntimeManager['runSkill']
  runtime.manager.runSkillFromChildRunner = (async (request: SkillRunRequest): Promise<SkillRunResult> =>
    runtime.manager.runSkill(request)) as SkillsRuntimeManager['runSkillFromChildRunner']
  return runtime
}

function registerActionDriver(
  skillId: string,
  plans: Array<SkillChildDriverAction | SkillChildCloseEvent>,
): void {
  let index = 0
  const driver: SkillChildDriver = {
    skillId,
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params) => ({ skillId, requestedInput: params.requestedInput }),
    planNextAction: async () => {
      const plan = plans[Math.min(index, plans.length - 1)]
      index += 1
      return plan
    },
    observeAfterAction: async (state) => state,
  }
  registerSkillChildDriver(driver)
}

function makeRepository(parentSignal: AbortSignal | null): SkillTaskRunRepository {
  const rows = new Map<string, SkillTaskRunRecord>()
  const repo = {
    createChildRun: (input: {
      childRunId: string
      scopeId: string | null
      sessionId: string | null
      skillId: string
      skillName: string | null
      action: string
      requestedInput: Record<string, unknown>
      singleFlightKey: string
      parentNextHint: string
      outputDir: string
      runStatePath: string
      eventLogPath: string
      status?: SkillChildRunStatus
    }): SkillTaskRunRecord => {
      const now = new Date().toISOString()
      const payload: SkillChildRunPayload = {
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
        parentNextHint: input.parentNextHint as SkillChildRunPayload['parentNextHint'],
        outputDir: input.outputDir,
        runStatePath: input.runStatePath,
        eventLogPath: input.eventLogPath,
        status: input.status ?? 'running',
        closeEvent: null,
      }
      const row = {
        id: input.childRunId,
        scopeId: input.scopeId,
        sessionId: input.sessionId,
        agent: null,
        runId: null,
        skillId: input.skillId,
        skillName: input.skillName,
        action: input.action,
        toolName: null,
        runKind: 'child_run',
        status: payload.status as SkillTaskRunRecord['status'],
        interactionState: 'running',
        steps: [],
        artifacts: [],
        outputDir: input.outputDir,
        runStatePath: input.runStatePath,
        resumePayload: { childRun: payload },
        createdAt: now,
        startedAt: null,
        updatedAt: now,
        finishedAt: null,
      } satisfies SkillTaskRunRecord
      rows.set(input.childRunId, row)
      return row
    },
    updateChildRun: (childRunId: string, patch: Partial<SkillChildRunPayload>): void => {
      const row = rows.get(childRunId)
      if (!row) throw new Error(`missing row ${childRunId}`)
      const payload = (row.resumePayload as { childRun: SkillChildRunPayload }).childRun
      const next = { ...payload, ...patch }
      row.resumePayload = { childRun: next }
      if (patch.status) row.status = patch.status as SkillTaskRunRecord['status']
      row.updatedAt = new Date().toISOString()
    },
    get: (childRunId: string): SkillTaskRunRecord | null => rows.get(childRunId) ?? null,
    findLatestChildRunByKey: () => null,
    findLatestChildRunBySkill: () => null,
    getSessionAbortSignal: () => parentSignal,
  }
  return repo as unknown as SkillTaskRunRepository
}

function makeTerminalClose(skillId: string): SkillChildCloseEvent {
  return {
    childRunId: '',
    skillId,
    status: 'completed',
    terminalReason: 'completed',
    outputDir: null,
    runStatePath: null,
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
  }
}

async function waitForClose(childRunId: string): Promise<SkillChildCloseEvent> {
  const deadline = Date.now() + 1_500
  while (Date.now() < deadline) {
    const close = getSkillChildRunCloseEvent(childRunId)
    if (close) return close
    await sleep(5)
  }
  throw new Error(`timeout waiting for ${childRunId}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function trackLaunchStuckTimer(guardMs: number): {
  clearCount: () => number
  unrefCount: () => number
  restore: () => void
} {
  const launchTimers = new Set<ReturnType<typeof setTimeout>>()
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  let clearCalls = 0
  let unrefCalls = 0

  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const timer = originalSetTimeout(handler, timeout, ...args)
    if (timeout === guardMs) {
      launchTimers.add(timer)
      const originalUnref = timer.unref?.bind(timer)
      if (originalUnref) {
        timer.unref = (() => {
          unrefCalls += 1
          return originalUnref()
        }) as typeof timer.unref
      }
    }
    return timer
  }) as typeof globalThis.setTimeout

  globalThis.clearTimeout = ((timeout?: string | number | NodeJS.Timeout) => {
    if (timeout && launchTimers.has(timeout as ReturnType<typeof setTimeout>)) {
      clearCalls += 1
    }
    return originalClearTimeout(timeout)
  }) as typeof globalThis.clearTimeout

  return {
    clearCount: () => clearCalls,
    unrefCount: () => unrefCalls,
    restore: () => {
      globalThis.setTimeout = originalSetTimeout
      globalThis.clearTimeout = originalClearTimeout
    },
  }
}

function trackAbortListeners(signal: AbortSignal): {
  count: () => number
  restore: () => void
} {
  const listeners = new Set<EventListenerOrEventListenerObject>()
  const originalAdd = signal.addEventListener.bind(signal)
  const originalRemove = signal.removeEventListener.bind(signal)
  signal.addEventListener = ((type, listener, options) => {
    if (type === 'abort' && listener) listeners.add(listener)
    originalAdd(type, listener, options)
  }) as AbortSignal['addEventListener']
  signal.removeEventListener = ((type, listener, options) => {
    if (type === 'abort' && listener) listeners.delete(listener)
    originalRemove(type, listener, options)
  }) as AbortSignal['removeEventListener']
  return {
    count: () => listeners.size,
    restore: () => {
      signal.addEventListener = originalAdd
      signal.removeEventListener = originalRemove
    },
  }
}
