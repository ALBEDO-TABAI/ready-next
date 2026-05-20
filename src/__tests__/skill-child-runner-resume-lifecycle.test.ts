/**
 * A1 / B6 regression suite — resume lifecycle correctness.
 *
 * These tests pin down two architectural fixes in `skill-child-runner.ts`:
 *
 *   - A1: `finalizeRun` switched its dedup guard from
 *         `recentCloses.has(childRunId)` to identity-compare against the
 *         active map (`this.active.get(id) !== active`). The old guard
 *         silently swallowed the second-lifecycle finalize whenever resume
 *         reused the same childRunId — child stayed pinned at running, no
 *         close ever surfaced, cancel hung forever.
 *
 *   - B6: resume now calls `prepareResumeLifecycle(childRunId)` which clears
 *         `recentCloses[id]` AND the row's stored `closeEvent`. Without
 *         this, `loadSkillRunContract` could read the previous paused close
 *         on a cross-process reload as if it were the current state.
 *
 * The cardinal rule: NEVER call `setupRunner()` (or
 * `__resetSkillChildRunnerForTests()`) between two lifecycle events on the
 * SAME childRunId. Production singleton is configured once at boot and
 * never reset. Tests that mid-test reset can mask exactly the bug class
 * we're guarding against.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  configureSkillChildRunner,
  __resetSkillChildRunnerForTests,
  startSkillChildRun,
  resumeSkillChildRun,
  cancelSkillChildRun,
  getSkillChildRunCloseEvent,
  getSkillChildRunner,
} from '../main/modules/agent-control/skills/skill-child-runner'
import {
  registerSkillChildDriver,
  __resetSkillChildDriversForTests,
  type SkillChildDriver,
} from '../main/modules/agent-control/skills/skill-child-drivers'
import type {
  SkillChildCloseEvent,
  SkillChildDriverAction,
  SkillChildDriverState,
} from '../main/modules/agent-control/skills/skill-child-run-types'
import type {
  SkillRunResult,
  SkillsRuntimeManager,
  SkillRunRequest,
} from '../main/modules/skills-runtime/runtime-manager'
import { defaultToolRegistry } from '../main/modules/agent-control/tools-runtime/tool-registry'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import {
  SkillTaskRunRepository,
  type SkillTaskRunRecord,
} from '../main/modules/repositories/skill-task-run-repository'

export const __breaksInvariants = [
  'test-fixture.skill-child-runner-resume.setupRunner-resets-singleton',
] as const

// ----------- Local test fixtures -----------
//
// Helpers are intentionally inlined here rather than imported from
// `skill-child-runner.test.ts` because that file does not export them.
// Keep parity with the originals — minimum diff so behavior matches.

interface FakeRepoState {
  rows: Map<string, SkillTaskRunRecord>
  /** Number of times `updateChildRun` has been called per childRunId. */
  updateCalls: Map<string, number>
}

function makeFakeRepository(): { repo: SkillTaskRunRepository; state: FakeRepoState } {
  const state: FakeRepoState = { rows: new Map(), updateCalls: new Map() }
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
        status: 'running',
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
            kind: 'vea',
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
      state.rows.set(input.childRunId, record)
      return record
    },
    updateChildRun: (childRunId: string, patch: Record<string, unknown>) => {
      const existing = state.rows.get(childRunId)
      if (!existing) throw new Error(`no row ${childRunId}`)
      const payload = (existing.resumePayload as { childRun: Record<string, unknown> }).childRun
      const merged = { ...payload, ...patch }
      existing.resumePayload = { childRun: merged }
      if (typeof patch.status === 'string') existing.status = patch.status as SkillTaskRunRecord['status']
      existing.updatedAt = new Date().toISOString()
      state.updateCalls.set(childRunId, (state.updateCalls.get(childRunId) ?? 0) + 1)
    },
    findLatestChildRunByKey: (key: string): SkillTaskRunRecord | null => {
      const ACTIVE = new Set(['queued', 'running', 'recoverable_paused', 'budget_paused', 'blocked'])
      for (const row of state.rows.values()) {
        const child = (row.resumePayload as { childRun?: Record<string, unknown> } | null)?.childRun
        if (!child) continue
        if (child.singleFlightKey === key && ACTIVE.has(child.status as string)) return row
      }
      return null
    },
    findLatestChildRunBySkill: () => null,
    get: (id: string) => state.rows.get(id) ?? null,
  } as unknown as SkillTaskRunRepository
  return { repo, state }
}

interface FakeRuntimeOpts {
  results?: SkillRunResult[]
  onRun?: (request: SkillRunRequest, callIndex: number) => Promise<void> | void
}

function makeFakeRuntime(opts: FakeRuntimeOpts = {}): {
  manager: SkillsRuntimeManager
  calls: SkillRunRequest[]
} {
  const calls: SkillRunRequest[] = []
  let callIndex = 0
  const fake = {
    getRuntimeInfo: () => ({
      runtimeRoot: '/tmp/fake-runtime',
      skillsRoot: '/tmp/fake-runtime/skills',
      customSkillsRoot: '/tmp/fake-runtime/custom',
      outputsRoot: '/tmp/fake-runtime/outputs',
      venvRoot: '/tmp/fake-runtime/venv',
    }),
    runSkill: async (request: SkillRunRequest): Promise<SkillRunResult> => {
      const idx = callIndex++
      calls.push(request)
      if (opts.onRun) await opts.onRun(request, idx)
      const canned = opts.results?.[idx]
      if (canned) return canned
      return {
        success: true,
        skillId: request.skillId,
        action: request.action,
        stdout: '',
        stderr: '',
        command: [],
      }
    },
    runSkillFromChildRunner: async (request: SkillRunRequest): Promise<SkillRunResult> => {
      return (fake as unknown as { runSkill: (r: SkillRunRequest) => Promise<SkillRunResult> }).runSkill(request)
    },
  } as unknown as SkillsRuntimeManager
  return { manager: fake, calls }
}

interface StubDriverOpts {
  /** Sequence of plans to return; the last element repeats forever. */
  plans: Array<SkillChildDriverAction | SkillChildCloseEvent>
}

function registerStubDriver(skillId: string, opts: StubDriverOpts): void {
  let idx = 0
  const driver: SkillChildDriver = {
    skillId,
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params) => ({
      skillId,
      requestedInput: params.requestedInput,
    }),
    planNextAction: async () => {
      const plan = opts.plans[Math.min(idx, opts.plans.length - 1)]
      idx += 1
      return plan
    },
    observeAfterAction: async (state) => state,
  }
  registerSkillChildDriver(driver)
}

/** Register a driver whose `planNextAction` blocks on a controllable promise.
 *  Useful for staging tests that need to read in-flight state mid-resume. */
function registerHangingDriver(
  skillId: string,
  hangPromise: Promise<SkillChildDriverAction | SkillChildCloseEvent>,
): void {
  const driver: SkillChildDriver = {
    skillId,
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params) => ({ skillId, requestedInput: params.requestedInput }),
    planNextAction: async () => hangPromise,
    observeAfterAction: async (state) => state,
  }
  registerSkillChildDriver(driver)
}

function pollUntil<T>(fn: () => T | null | undefined, timeoutMs = 2_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      const value = fn()
      if (value) return resolve(value)
      if (Date.now() - start > timeoutMs) return reject(new Error('pollUntil timeout'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

function makeTerminalClose(
  skillId: string,
  status: SkillChildCloseEvent['status'],
  reason: SkillChildCloseEvent['terminalReason'],
): SkillChildCloseEvent {
  return {
    childRunId: '', // runner overrides
    skillId,
    status,
    terminalReason: reason,
    outputDir: null,
    runStatePath: null,
    sceneScoresPath: null,
    deliveryReportPath: null,
    progress: { stage: null, totalUnits: null, completedUnits: null, coverageRatio: null, fingerprint: null },
    framePatch: null,
    projectionPatch: null,
    error: null,
  }
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

function setupRunner(opts: {
  runtime?: ReturnType<typeof makeFakeRuntime>
  repo?: ReturnType<typeof makeFakeRepository>
  launchStuckGuardMs?: number
  maxActionsPerRun?: number
} = {}): {
  runtime: ReturnType<typeof makeFakeRuntime>
  repo: ReturnType<typeof makeFakeRepository>
} {
  installTestSkillToolDefinitions()
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  const runtime = opts.runtime ?? makeFakeRuntime()
  const repo = opts.repo ?? makeFakeRepository()
  configureSkillChildRunner({
    runtimeManager: runtime.manager,
    repository: repo.repo,
    launchStuckGuardMs: opts.launchStuckGuardMs ?? 5_000,
    maxActionsPerRun: opts.maxActionsPerRun,
  })
  return { runtime, repo }
}

// ====================================================================
// Tests
// ====================================================================

test('resume completes a second lifecycle without runner singleton reset', async () => {
  // First lifecycle: budget = 3. Plan emits 3 distinct actions, then the
  // budget guard fires before the 4th. Result: budget_paused.
  const { repo } = setupRunner({ maxActionsPerRun: 3 })
  registerStubDriver('test-skill-resume-no-reset', {
    plans: [
      { action: 'step_a', input: {} },
      { action: 'step_b', input: {} },
      { action: 'step_c', input: {} },
      { action: 'step_d', input: {} },
    ],
  })

  const first = await startSkillChildRun({
    scopeId: 'scope-resume-no-reset',
    sessionId: 'session-resume-no-reset',
    skillId: 'test-skill-resume-no-reset',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/no-reset' },
  })
  const firstClose = await pollUntil(() => getSkillChildRunCloseEvent(first.childRunId))
  assert.equal(firstClose.status, 'budget_paused')
  assert.equal(firstClose.terminalReason, 'checkpoint_budget')

  // Flip the row to recoverable_paused so resume's resumability check
  // accepts the row. This is what production does after a budget pause.
  repo.repo.updateChildRun(first.childRunId, { status: 'recoverable_paused' })

  // Re-register driver with a finite plan that completes naturally. Same
  // skillId — registerSkillChildDriver overwrites on duplicate. Crucially:
  // we do NOT touch the runner singleton.
  registerStubDriver('test-skill-resume-no-reset', {
    plans: [
      { action: 'step_e', input: {} },
      makeTerminalClose('test-skill-resume-no-reset', 'completed', 'completed'),
    ],
  })

  const second = await resumeSkillChildRun(first.childRunId)
  assert.equal(second.childRunId, first.childRunId)
  assert.equal(second.status, 'running')

  const secondClose = await pollUntil(
    () => getSkillChildRunCloseEvent(first.childRunId),
    5_000,
  )
  // A1 regression nail: the second-lifecycle close must surface, not be
  // swallowed by the legacy `recentCloses.has` guard.
  assert.equal(secondClose.status, 'completed')
  assert.equal(secondClose.terminalReason, 'completed')
  // The new close must NOT be the same object as the paused one.
  assert.notStrictEqual(secondClose, firstClose)
})

test('resume after pause clears the previous closeEvent in the row payload', async () => {
  // Stage 1: produce a budget_paused close as before.
  const { repo } = setupRunner({ maxActionsPerRun: 1 })
  registerStubDriver('test-skill-resume-clear-row', {
    plans: [
      { action: 'step_a', input: {} },
      { action: 'step_b', input: {} },
    ],
  })

  const first = await startSkillChildRun({
    scopeId: 'scope-resume-clear-row',
    sessionId: 'session-resume-clear-row',
    skillId: 'test-skill-resume-clear-row',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/clear-row' },
  })
  const firstClose = await pollUntil(() => getSkillChildRunCloseEvent(first.childRunId))
  assert.equal(firstClose.status, 'budget_paused')

  // Confirm the row currently carries the paused close.
  const rowBeforeResume = repo.state.rows.get(first.childRunId)!
  const childBeforeResume = (rowBeforeResume.resumePayload as { childRun: Record<string, unknown> }).childRun
  assert.ok(childBeforeResume.closeEvent, 'paused close must be persisted before resume')

  repo.repo.updateChildRun(first.childRunId, { status: 'recoverable_paused' })

  // Re-register driver whose planNextAction hangs forever. We want to read
  // row state mid-resume — after `prepareResumeLifecycle` has cleared the
  // closeEvent, but before the run can finalize on its own.
  let resolveHang!: (close: SkillChildCloseEvent) => void
  const hangPromise = new Promise<SkillChildCloseEvent>((resolve) => { resolveHang = resolve })
  registerHangingDriver('test-skill-resume-clear-row', hangPromise)

  const second = await resumeSkillChildRun(first.childRunId)
  assert.equal(second.status, 'running')

  // B6 regression nail: the row's closeEvent must be null while the
  // resumed lifecycle is in flight. If `prepareResumeLifecycle` were a
  // no-op or only updated status, the paused close would still leak.
  const rowDuringResume = repo.state.rows.get(first.childRunId)!
  const childDuringResume = (rowDuringResume.resumePayload as { childRun: Record<string, unknown> }).childRun
  assert.equal(childDuringResume.closeEvent, null,
    'row closeEvent must be cleared when resume starts')
  assert.equal(childDuringResume.status, 'running',
    'row status must flip to running atomically with the close clear')

  // Let the run finalize so the test doesn't leak a hung loop.
  resolveHang(makeTerminalClose('test-skill-resume-clear-row', 'completed', 'completed'))
  const finalClose = await pollUntil(
    () => getSkillChildRunCloseEvent(first.childRunId),
    3_000,
  )
  assert.equal(finalClose.status, 'completed')
})

test('resume followed immediately by cancel terminates cleanly without hanging', async () => {
  // Stage 1: hit budget_paused as usual.
  const { repo } = setupRunner({ maxActionsPerRun: 1, launchStuckGuardMs: 10_000 })
  registerStubDriver('test-skill-resume-cancel', {
    plans: [
      { action: 'step_a', input: {} },
      { action: 'step_b', input: {} },
    ],
  })

  const first = await startSkillChildRun({
    scopeId: 'scope-resume-cancel',
    sessionId: 'session-resume-cancel',
    skillId: 'test-skill-resume-cancel',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/resume-cancel' },
  })
  await pollUntil(() => getSkillChildRunCloseEvent(first.childRunId))

  repo.repo.updateChildRun(first.childRunId, { status: 'recoverable_paused' })

  // Stage 2: register a driver whose planNextAction hangs. Resume kicks
  // it off, then we cancel. The runLoop honors abort at the top of the
  // next iteration; with a hanging plan-call we rely on Promise.race so
  // the test itself can never deadlock.
  let resolveHang!: (close: SkillChildCloseEvent) => void
  const hangPromise = new Promise<SkillChildCloseEvent>((resolve) => { resolveHang = resolve })
  registerHangingDriver('test-skill-resume-cancel', hangPromise)

  const second = await resumeSkillChildRun(first.childRunId)
  assert.equal(second.status, 'running')

  const cancelP = cancelSkillChildRun(first.childRunId, 'test_cancel')

  const HANG_MS = 3_000
  const cancelClose = await Promise.race<SkillChildCloseEvent>([
    cancelP,
    new Promise<SkillChildCloseEvent>((_, reject) =>
      setTimeout(() => reject(new Error('cancel hung')), HANG_MS),
    ),
  ])

  // Free the still-hanging planNextAction so the runLoop can clean up.
  resolveHang(makeTerminalClose('test-skill-resume-cancel', 'completed', 'completed'))

  assert.equal(cancelClose.status, 'killed')
  assert.equal(cancelClose.terminalReason, 'cancelled_user')
  // The close-event read API must return the SAME cancelled close, not a
  // stale paused one.
  const lastClose = getSkillChildRunCloseEvent(first.childRunId)
  assert.ok(lastClose, 'close must be readable after cancel')
  assert.equal(lastClose!.terminalReason, 'cancelled_user')
})

test('two finalize attempts in the same lifecycle do not double-resolve', async () => {
  const { repo } = setupRunner({ launchStuckGuardMs: 10_000 })

  // Hanging driver — keeps the run alive while we drive finalizeRun
  // manually below to exercise the guard directly.
  let resolveHang!: (close: SkillChildCloseEvent) => void
  const hangPromise = new Promise<SkillChildCloseEvent>((resolve) => { resolveHang = resolve })
  registerHangingDriver('test-skill-double-finalize', hangPromise)

  const first = await startSkillChildRun({
    scopeId: 'scope-double-finalize',
    sessionId: 'session-double-finalize',
    skillId: 'test-skill-double-finalize',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/double-finalize' },
  })
  assert.equal(first.status, 'running')

  // Reach into the runner to grab the active record. This intentionally
  // skips the public surface because we want to test the private guard.
  const runner = getSkillChildRunner() as unknown as {
    active: Map<string, unknown>
    finalizeRun: (active: unknown, close: SkillChildCloseEvent) => Promise<void>
    recentCloses: Map<string, SkillChildCloseEvent>
  }
  const activeRef = runner.active.get(first.childRunId)
  assert.ok(activeRef, 'active map must contain the in-flight run')

  // Reset the per-row update counter so we measure only finalize writes.
  repo.state.updateCalls.set(first.childRunId, 0)

  const closeA = makeTerminalClose('test-skill-double-finalize', 'completed', 'completed')
  closeA.childRunId = first.childRunId
  await runner.finalizeRun(activeRef, closeA)

  const updatesAfterFirst = repo.state.updateCalls.get(first.childRunId) ?? 0
  const cachedAfterFirst = runner.recentCloses.get(first.childRunId)
  assert.ok(cachedAfterFirst, 'first finalize must populate recentCloses')
  assert.equal(cachedAfterFirst!.terminalReason, 'completed')
  assert.equal(runner.active.get(first.childRunId), undefined,
    'active entry must be removed by the first finalize')

  // Second finalize: pass a DIFFERENT close. If the guard works, none of
  // the visible state should mutate.
  const closeB = makeTerminalClose('test-skill-double-finalize', 'failed', 'child_process_crashed')
  closeB.childRunId = first.childRunId
  await runner.finalizeRun(activeRef, closeB)

  const updatesAfterSecond = repo.state.updateCalls.get(first.childRunId) ?? 0
  assert.equal(updatesAfterSecond, updatesAfterFirst,
    'second finalize must not write to the repository')

  const cachedAfterSecond = runner.recentCloses.get(first.childRunId)
  assert.strictEqual(cachedAfterSecond, cachedAfterFirst,
    'second finalize must not overwrite the cached close')
  assert.equal(cachedAfterSecond!.status, 'completed',
    'cached close must remain the first finalize result')

  // Cleanup — let the still-hanging planNextAction wake up so the orphan
  // runLoop unblocks. Its eventual finalizeRun is also blocked by the
  // guard (active was deleted), so this is a no-op for state but
  // prevents an unhandled-rejection cascade.
  resolveHang(makeTerminalClose('test-skill-double-finalize', 'completed', 'completed'))
})

test('process_restarted reconciliation followed by user resume completes', async () => {
  // Build the row directly via createChildRun, simulating "row exists but
  // singleton has no in-memory active." The first startSkillChildRun call
  // will collide on `singleFlightKey` and hit reconcileExistingChildRun.
  const { repo } = setupRunner({ launchStuckGuardMs: 10_000 })

  const childRunId = 'vea-process-restart-test'
  const url = 'https://example.com/restart'
  // Mirror the runner's `computeTargetDigest` URL fallback so the
  // pre-created row collides with what `startSkillChildRun` will derive.
  const targetDigest = createHash('sha256').update(`url:${url}`).digest('hex').slice(0, 16)
  const singleFlightKey = `scope-restart|session-restart|test-skill-restart|${targetDigest}`

  repo.repo.createChildRun({
    childRunId,
    scopeId: 'scope-restart',
    sessionId: 'session-restart',
    skillId: 'test-skill-restart',
    skillName: null,
    action: 'do_thing',
    requestedInput: { url },
    singleFlightKey,
    parentNextHint: 'wait_for_close_event',
    outputDir: '/tmp/fake-runtime/outputs/test-skill-restart/restart',
    runStatePath: '/tmp/fake-runtime/outputs/test-skill-restart/restart/run_state.json',
    // Empty `eventLogPath` makes `canResume` false in
    // reconcileExistingChildRun, forcing the markRowProcessRestarted
    // path. (See `skill-child-runner.ts` ~line 593.)
    eventLogPath: '',
    status: 'running',
  })

  // Register a real driver so startSkillChildRun's up-front driver check
  // passes; reconcileExistingChildRun will still bail out of durable
  // resume because eventLogPath is empty, falling through to
  // markRowProcessRestarted. After that, recentCloses[id] holds the
  // process_restarted close.
  registerStubDriver('test-skill-restart', {
    plans: [
      { action: 'step_a', input: {} },
      makeTerminalClose('test-skill-restart', 'completed', 'completed'),
    ],
  })

  const restartResult = await startSkillChildRun({
    scopeId: 'scope-restart',
    sessionId: 'session-restart',
    skillId: 'test-skill-restart',
    action: 'do_thing',
    requestedInput: { url },
  })
  assert.equal(restartResult.childRunId, childRunId,
    'single-flight collapse must reuse the pre-existing row id')
  assert.equal(restartResult.status, 'recoverable_paused')
  assert.equal(restartResult.closeEvent?.terminalReason, 'process_restarted')

  // Confirm the runner has cached the process_restarted close.
  const runner = getSkillChildRunner() as unknown as {
    recentCloses: Map<string, SkillChildCloseEvent>
  }
  const restartCached = runner.recentCloses.get(restartResult.childRunId)
  assert.ok(restartCached, 'recentCloses must hold the process_restarted close')
  assert.equal(restartCached!.terminalReason, 'process_restarted')

  // Trigger a user resume. prepareResumeLifecycle must clear both the
  // recentCloses entry AND the row closeEvent. The driver registered at
  // the top of the test is reused; its plan index has not advanced because
  // `markRowProcessRestarted` returns before any planNextAction call.
  const second = await resumeSkillChildRun(restartResult.childRunId)
  assert.equal(second.childRunId, restartResult.childRunId)
  assert.equal(second.status, 'running')

  const secondClose = await pollUntil(
    () => getSkillChildRunCloseEvent(restartResult.childRunId),
    5_000,
  )
  assert.equal(secondClose.status, 'completed')
  assert.equal(secondClose.terminalReason, 'completed')
  assert.notStrictEqual(secondClose, restartCached,
    'second-lifecycle close must not be the cached process_restarted one')

  // Final row state — no stale process_restarted remnants.
  const finalRow = repo.state.rows.get(restartResult.childRunId)!
  const finalChild = (finalRow.resumePayload as { childRun: Record<string, unknown> }).childRun
  assert.equal(finalChild.status, 'completed')
  assert.equal((finalChild.closeEvent as SkillChildCloseEvent).terminalReason, 'completed')
})
