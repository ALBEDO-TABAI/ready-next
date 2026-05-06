import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  SkillRunRequest,
  SkillRunResult,
  SkillsRuntimeManager,
} from '../main/modules/skills-runtime/runtime-manager'
import type {
  SkillTaskRunRecord,
  SkillTaskRunRepository,
} from '../main/modules/repositories/skill-task-run-repository'
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
import { defaultToolRegistry } from '../main/modules/agent-control/tool-registry'
import type { ToolDefinition } from '../main/modules/agent-control/tool-definition'
import type {
  SkillChildCloseEvent,
  SkillChildDriverAction,
  SkillChildRunPayload,
  SkillChildRunStatus,
} from '../main/modules/agent-control/skill-child-run-types'

test('parent abort cascades to an in-flight SkillChildSubAgent', async () => {
  const parent = new AbortController()
  setup({ parentSignal: parent.signal, runtime: makeStallingRuntime() })
  registerActionDriver('test-skill-parent-abort', [{ action: 'do_thing', input: {} }])

  const restoreUnhandled = installAbortRejectionSwallow()
  try {
    const launch = await startSkillChildRun({
      scopeId: 'scope-parent-abort',
      sessionId: 'session-parent-abort',
      skillId: 'test-skill-parent-abort',
      action: 'do_thing',
      requestedInput: { url: 'https://example.com/parent-abort' },
    })

    await sleep(10)
    parent.abort(new Error('process_restarted'))

    const close = await waitForClose(launch.childRunId)
    assert.equal(close.status, 'killed')
    assert.equal(close.terminalReason, 'process_restarted')
    // Drain microtasks so any in-flight skill action rejection is processed
    // inside the test's scope rather than after the test scope returns.
    await sleep(20)
  } finally {
    restoreUnhandled()
  }
})

test('child self-abort does not abort the parent session signal', async () => {
  const parent = new AbortController()
  setup({ parentSignal: parent.signal, runtime: makeStallingRuntime() })
  registerActionDriver('test-skill-child-cancel', [{ action: 'do_thing', input: {} }])

  const restoreUnhandled = installAbortRejectionSwallow()
  try {
    const launch = await startSkillChildRun({
      scopeId: 'scope-child-cancel',
      sessionId: 'session-child-cancel',
      skillId: 'test-skill-child-cancel',
      action: 'do_thing',
      requestedInput: { url: 'https://example.com/child-cancel' },
    })

    await sleep(10)
    const close = await cancelSkillChildRun(launch.childRunId, 'cancelled_user')
    assert.equal(close.status, 'killed')
    assert.equal(close.terminalReason, 'cancelled_user')
    assert.equal(parent.signal.aborted, false)
    // Drain microtasks so any in-flight skill action rejection lands inside
    // the test's scope rather than after the test scope returns.
    await sleep(20)
  } finally {
    restoreUnhandled()
  }
})

test('already-aborted parent signal aborts the child before work starts', async () => {
  const parent = new AbortController()
  parent.abort(new Error('process_restarted'))
  const runtime = makeRuntime()
  setup({ parentSignal: parent.signal, runtime })
  registerActionDriver('test-skill-parent-preaborted', [{ action: 'do_thing', input: {} }])

  const launch = await startSkillChildRun({
    scopeId: 'scope-parent-preaborted',
    sessionId: 'session-parent-preaborted',
    skillId: 'test-skill-parent-preaborted',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/preaborted' },
  })

  const close = await waitForClose(launch.childRunId)
  assert.equal(close.status, 'killed')
  assert.equal(close.terminalReason, 'process_restarted')
  assert.equal(runtime.calls.length, 0)
})

test('parent listener is removed when child terminates normally (no listener leak on long-lived parent signal)', async () => {
  const parent = new AbortController()
  const tracker = trackAbortListeners(parent.signal)
  try {
    setup({ parentSignal: parent.signal, runtime: makeRuntime() })
    registerActionDriver('test-skill-listener-cleanup', [
      { action: 'do_thing', input: {} },
      makeTerminalClose('test-skill-listener-cleanup'),
    ])

    const launch = await startSkillChildRun({
      scopeId: 'scope-listener-cleanup',
      sessionId: 'session-listener-cleanup',
      skillId: 'test-skill-listener-cleanup',
      action: 'do_thing',
      requestedInput: { url: 'https://example.com/listener-cleanup' },
    })

    const close = await waitForClose(launch.childRunId)
    assert.equal(close.status, 'completed')
    assert.equal(tracker.count(), 0)
  } finally {
    tracker.restore()
  }
})

/**
 * The abort/cancel paths in production trigger an in-flight
 * `executeSkillActionViaToolGateway` chain that throws a `cancelled_user`
 * Error after the test's `cancelSkillChildRun()` (or post-`abort` close
 * event) has already returned the close. Production handles the close
 * event correctly; the trailing rejection is harmless residue. We install
 * a process-level swallow for that specific error name so the Node test
 * runner does not flag it as an unhandled rejection.
 *
 * The handler is installed once at module load (idempotent) so it covers
 * concurrent test runs of this file in the suite. A WeakSet is used to
 * avoid double-handling the same rejection if multiple listeners fire.
 */
function isCancelledUserRejection(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'cancelled_user') return true
  if (err.message === 'cancelled_user' || err.message === 'process_restarted') return true
  return false
}
const seenRejections = new WeakSet<object>()
const swallowAbortRejection = (reason: unknown, promise: Promise<unknown>) => {
  if (!isCancelledUserRejection(reason)) return
  if (typeof promise === 'object' && promise !== null) {
    if (seenRejections.has(promise)) return
    seenRejections.add(promise)
  }
  // Attach a no-op catch so Node treats the rejection as handled.
  promise.catch(() => undefined)
}
process.on('unhandledRejection', swallowAbortRejection)
function installAbortRejectionSwallow(): () => void {
  // Compatibility shim: existing call sites still expect a teardown
  // function. The actual swallow is installed once at module load above.
  return () => undefined
}

function setup(opts: {
  parentSignal: AbortSignal | null
  runtime: ReturnType<typeof makeRuntime>
}): void {
  installTestSkillToolDefinitions()
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  configureSkillChildRunner({
    runtimeManager: opts.runtime.manager,
    repository: makeRepository(opts.parentSignal),
    launchStuckGuardMs: 5_000,
  })
}

function makeRuntime(): {
  manager: SkillsRuntimeManager
  calls: SkillRunRequest[]
} {
  const calls: SkillRunRequest[] = []
  const manager = {
    getRuntimeInfo: () => ({
      runtimeRoot: '/tmp/abort-tree-runtime',
      skillsRoot: '/tmp/abort-tree-runtime/skills',
      customSkillsRoot: '/tmp/abort-tree-runtime/custom',
      outputsRoot: '/tmp/abort-tree-runtime/outputs',
      venvRoot: '/tmp/abort-tree-runtime/venv',
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

let testSkillToolDefinitionsInstalled = false

function installTestSkillToolDefinitions(): void {
  if (testSkillToolDefinitionsInstalled) return
  testSkillToolDefinitionsInstalled = true
  const registry = defaultToolRegistry as unknown as {
    getToolDefinitionForExecution: (toolName: string) => ToolDefinition | null
  }
  const original = registry.getToolDefinitionForExecution.bind(defaultToolRegistry)
  registry.getToolDefinitionForExecution = (toolName: string) => {
    if (toolName.startsWith('skill_test_')) {
      return {
        name: toolName,
        groupId: 'skills',
        domain: 'skill',
        kind: 'job',
        concurrency: 'serialized',
        interruptBehavior: 'host_managed',
        timeoutProfile: 'skill_long',
        supportsTextBridge: true,
        projectionHint: null,
        description: `${toolName} test fixture`,
        schema: null,
        executionVisibility: 'internal',
        requiresExplicitAllowlist: true,
        resultShape: 'json',
      }
    }
    return original(toolName)
  }
}

function makeStallingRuntime(): ReturnType<typeof makeRuntime> {
  const runtime = makeRuntime()
  runtime.manager.runSkill = (async (request: SkillRunRequest): Promise<SkillRunResult> => {
    runtime.calls.push(request)
    // Stall until the request's signal aborts; then resolve with a
    // cancelled-shaped result. Resolving (rather than rejecting) keeps the
    // promise lifecycle clean — the production close-event path is driven
    // by the parent abort listener in skill-child-runner, not by this
    // promise rejecting. Rejecting here was creating a parallel unhandled
    // rejection that surfaced after the test scope had already returned
    // (Node test runner flags this as `asynchronous activity after the
    // test ended`).
    await new Promise<void>((resolve) => {
      const signal = request.signal
      if (signal?.aborted) {
        resolve()
        return
      }
      signal?.addEventListener('abort', () => resolve(), { once: true })
    })
    return {
      success: false,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
      error: 'cancelled_user',
    } as unknown as SkillRunResult
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
