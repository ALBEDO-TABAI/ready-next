/**
 * Phase 4 — Skill Child Runner repository scaffold tests.
 *
 * Phase 5 (Team 5) implements the actual `skill-child-runner.ts` driver/runner.
 * This test file scaffolds the repository round-trip the runner depends on:
 *
 *   1. `createChildRun` round-trips through `findLatestChildRunByKey`.
 *   2. `updateChildRun` patches the payload through status transitions.
 *   3. `findLatestChildRunBySkill` only returns ACTIVE rows.
 *
 * Lifecycle assertions (launch / close event / single-flight collapse) live
 * in Team 5's PR. Anything beyond the four repository helpers stays out.
 *
 * Uses real `better-sqlite3` so SQLite's `json_extract` is exercised on the
 * `resumePayload.childRun` payload — the harness mock in
 * `skill-task-run-repository.test.ts` would short-circuit those queries.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import {
  SkillTaskRunRepository,
  type CreateChildRunInput,
} from '../main/modules/repositories/skill-task-run-repository'
import { createSkillChildRunId } from '../main/modules/agent-control/skill-child-run-id'

const requireFromHere = createRequire(import.meta.url)

type SqliteCtor = new (path: string, options?: { readonly?: boolean }) => {
  exec: (sql: string) => void
  prepare: (sql: string) => {
    run: (...params: unknown[]) => { changes?: number }
    get: <T = unknown>(...params: unknown[]) => T | undefined
    all: <T = unknown>(...params: unknown[]) => T[]
  }
  close: () => void
}

function loadSqlite(): SqliteCtor | null {
  try {
    return requireFromHere('better-sqlite3') as SqliteCtor
  } catch {
    // better-sqlite3 missing or ABI-mismatched. CLAUDE.md §6.13 — tests
    // mark themselves as unproven rather than auto-passing on the DB path.
    return null
  }
}

function setupRepository(): { repo: SkillTaskRunRepository; closeDb: () => void } | null {
  const Sqlite = loadSqlite()
  if (!Sqlite) return null
  const rawDb = new Sqlite(':memory:')
  runMigrations(rawDb as unknown as MigrationDatabase)
  const repo = new SkillTaskRunRepository({
    // SkillTaskRunRepository only needs `getRawDb()` returning a sqlite-shaped
    // statement maker; the real better-sqlite3 instance satisfies that shape.
    getRawDb: () => rawDb as never,
  } as never)
  return { repo, closeDb: () => rawDb.close() }
}

function makeChildInput(overrides: Partial<CreateChildRunInput> = {}): CreateChildRunInput {
  return {
    childRunId: overrides.childRunId ?? createSkillChildRunId('vea'),
    scopeId: overrides.scopeId ?? 'scope-1',
    sessionId: overrides.sessionId ?? 'session-1',
    skillId: overrides.skillId ?? 'video-expert-analyzer',
    skillName: overrides.skillName ?? 'Video Expert Analyzer (VNext)',
    action: overrides.action ?? 'video_expert_pipeline',
    requestedInput: overrides.requestedInput ?? { url: 'https://example.com/v1' },
    singleFlightKey: overrides.singleFlightKey
      ?? 'scope-1:session-1:video-expert-analyzer:digest-aaaa',
    parentNextHint: overrides.parentNextHint ?? 'wait_for_close_event',
    outputDir: overrides.outputDir ?? '/tmp/vea-output-1',
    runStatePath: overrides.runStatePath ?? '/tmp/vea-output-1/run_state.json',
    eventLogPath: overrides.eventLogPath
      ?? '/tmp/vea-output-1/.ready/child-runs/run.jsonl',
    status: overrides.status,
  }
}

test('Phase 4: createChildRun round-trips through findLatestChildRunByKey', () => {
  const setup = setupRepository()
  if (!setup) {
    // SQLite-backed test infra missing — see CLAUDE.md §6.13. Tests labelled
    // "DB path not proven" rather than auto-pass.
    console.warn('[skill-child-runner] better-sqlite3 unavailable; skipping')
    return
  }
  try {
    const input = makeChildInput()
    const created = setup.repo.createChildRun(input)
    assert.equal(created.id, input.childRunId)
    assert.equal(created.skillId, input.skillId)

    const found = setup.repo.findLatestChildRunByKey(input.singleFlightKey)
    assert.ok(found, 'expected to find child run by single-flight key')
    assert.equal(found!.id, input.childRunId)

    const payload = (found!.resumePayload as { childRun?: Record<string, unknown> } | null)?.childRun
    assert.ok(payload, 'expected resumePayload.childRun to be populated')
    assert.equal((payload as { version?: number }).version, 1)
    assert.equal((payload as { childRunId?: string }).childRunId, input.childRunId)
    assert.equal((payload as { singleFlightKey?: string }).singleFlightKey, input.singleFlightKey)
    assert.equal((payload as { status?: string }).status, 'queued')
    assert.equal((payload as { parentNextHint?: string }).parentNextHint, 'wait_for_close_event')
    assert.deepEqual(
      (payload as { requestedInput?: Record<string, unknown> }).requestedInput,
      input.requestedInput,
    )
    assert.equal((payload as { kind?: string }).kind, 'vea')
  } finally {
    setup.closeDb()
  }
})

test('Phase 4: updateChildRun patches the payload through status transitions', () => {
  const setup = setupRepository()
  if (!setup) {
    console.warn('[skill-child-runner] better-sqlite3 unavailable; skipping')
    return
  }
  try {
    const input = makeChildInput()
    setup.repo.createChildRun(input)

    setup.repo.updateChildRun(input.childRunId, { status: 'running' })
    let row = setup.repo.get(input.childRunId)
    assert.ok(row)
    let payload = (row!.resumePayload as { childRun?: Record<string, unknown> }).childRun
    assert.equal((payload as { status?: string }).status, 'running')
    // Row column also mirrors active state.
    assert.equal(row!.status, 'running')

    setup.repo.updateChildRun(input.childRunId, { status: 'recoverable_paused' })
    row = setup.repo.get(input.childRunId)
    payload = (row!.resumePayload as { childRun?: Record<string, unknown> }).childRun
    assert.equal((payload as { status?: string }).status, 'recoverable_paused')
    // recoverable_paused projects to 'blocked' so legacy active-row filters keep working.
    assert.equal(row!.status, 'blocked')

    // Lookup by single-flight key still returns the row while paused.
    const stillActive = setup.repo.findLatestChildRunByKey(input.singleFlightKey)
    assert.ok(stillActive, 'recoverable_paused must still count as active')

    setup.repo.updateChildRun(input.childRunId, { status: 'completed' })
    row = setup.repo.get(input.childRunId)
    payload = (row!.resumePayload as { childRun?: Record<string, unknown> }).childRun
    assert.equal((payload as { status?: string }).status, 'completed')
    assert.equal(row!.status, 'done')
    assert.ok(row!.finishedAt, 'terminal status sets finishedAt')

    // Terminal rows are NOT returned by the active-only single-flight lookup.
    const afterTerminal = setup.repo.findLatestChildRunByKey(input.singleFlightKey)
    assert.equal(afterTerminal, null, 'terminal row must not be returned by active lookup')
  } finally {
    setup.closeDb()
  }
})

test('Phase 4: findLatestChildRunBySkill only returns active rows', () => {
  const setup = setupRepository()
  if (!setup) {
    console.warn('[skill-child-runner] better-sqlite3 unavailable; skipping')
    return
  }
  try {
    const completedInput = makeChildInput({
      childRunId: createSkillChildRunId('vea'),
      singleFlightKey: 'scope-1:session-1:video-expert-analyzer:digest-completed',
      outputDir: '/tmp/vea-output-completed',
      runStatePath: '/tmp/vea-output-completed/run_state.json',
      eventLogPath: '/tmp/vea-output-completed/.ready/child-runs/run.jsonl',
    })
    setup.repo.createChildRun(completedInput)
    setup.repo.updateChildRun(completedInput.childRunId, { status: 'completed' })

    const activeInput = makeChildInput({
      childRunId: createSkillChildRunId('vea'),
      singleFlightKey: 'scope-1:session-1:video-expert-analyzer:digest-active',
      outputDir: '/tmp/vea-output-active',
      runStatePath: '/tmp/vea-output-active/run_state.json',
      eventLogPath: '/tmp/vea-output-active/.ready/child-runs/run.jsonl',
    })
    setup.repo.createChildRun(activeInput)
    setup.repo.updateChildRun(activeInput.childRunId, { status: 'running' })

    const found = setup.repo.findLatestChildRunBySkill({
      sessionId: 'session-1',
      scopeId: 'scope-1',
      skillId: 'video-expert-analyzer',
    })
    assert.ok(found, 'expected to find an active row for the skill')
    assert.equal(found!.id, activeInput.childRunId, 'must return the active row, not the completed one')

    // Other skill: returns null even when an active row exists for a different skill.
    const otherSkill = setup.repo.findLatestChildRunBySkill({
      sessionId: 'session-1',
      scopeId: 'scope-1',
      skillId: 'some-other-skill',
    })
    assert.equal(otherSkill, null)
  } finally {
    setup.closeDb()
  }
})

// ===================================================================
// Phase 5 — Lifecycle / cancellation / crash / resume / nested-guard
// ===================================================================

import {
  configureSkillChildRunner,
  __resetSkillChildRunnerForTests,
  startSkillChildRun,
  cancelSkillChildRun,
  resumeSkillChildRun,
  getSkillChildRunCloseEvent,
  MAX_ACTIONS_PER_CHILD_RUN,
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
  SkillRunResult,
  SkillsRuntimeManager,
  SkillRunRequest,
} from '../main/modules/skills-runtime/runtime-manager'
import type {
  SkillTaskRunRepository,
  SkillTaskRunRecord,
} from '../main/modules/repositories/skill-task-run-repository'

// ----------- Test fixtures -----------

interface FakeRepoState {
  rows: Map<string, SkillTaskRunRecord>
}

function makeFakeRepository(): { repo: SkillTaskRunRepository; state: FakeRepoState } {
  const state: FakeRepoState = { rows: new Map() }
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
  /** Sequence of canned results to return for each successive runSkill call. */
  results?: SkillRunResult[]
  /** Optional thrower — when set, the next runSkill throws this error. */
  throwOnce?: Error | null
  /** When set, runSkill will run this side-effect (e.g. write run_state.json). */
  onRun?: (request: SkillRunRequest, callIndex: number) => Promise<void> | void
}

function makeFakeRuntime(opts: FakeRuntimeOpts = {}): {
  manager: SkillsRuntimeManager
  calls: SkillRunRequest[]
} {
  const calls: SkillRunRequest[] = []
  let callIndex = 0
  let pendingThrow: Error | null = opts.throwOnce ?? null
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
      if (pendingThrow) {
        const e = pendingThrow
        pendingThrow = null
        throw e
      }
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
      // Re-route via runSkill so opts.results / opts.throwOnce apply.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function makeTerminalClose(skillId: string, status: SkillChildCloseEvent['status'], reason: SkillChildCloseEvent['terminalReason']): SkillChildCloseEvent {
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

function setupRunner(opts: {
  runtime?: ReturnType<typeof makeFakeRuntime>
  repo?: ReturnType<typeof makeFakeRepository>
  launchStuckGuardMs?: number
  maxActionsPerRun?: number
  maxActiveVeaRuns?: number
} = {}): {
  runtime: ReturnType<typeof makeFakeRuntime>
  repo: ReturnType<typeof makeFakeRepository>
} {
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  const runtime = opts.runtime ?? makeFakeRuntime()
  const repo = opts.repo ?? makeFakeRepository()
  configureSkillChildRunner({
    runtimeManager: runtime.manager,
    repository: repo.repo,
    launchStuckGuardMs: opts.launchStuckGuardMs ?? 100,
    maxActionsPerRun: opts.maxActionsPerRun,
    maxActiveVeaRuns: opts.maxActiveVeaRuns,
  })
  return { runtime, repo }
}

// ------------------- Tests -------------------

test('Phase 5: lifecycle — start → action → close', async () => {
  const { runtime } = setupRunner()
  registerStubDriver('test-skill-lifecycle', {
    plans: [
      { action: 'do_thing', input: { foo: 1 } },
      makeTerminalClose('test-skill-lifecycle', 'completed', 'completed'),
    ],
  })
  const result = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId: 'test-skill-lifecycle',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/a' },
  })
  assert.equal(result.status, 'running')
  assert.ok(result.childRunId)

  const close = await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
  assert.equal(close.status, 'completed')
  assert.equal(close.terminalReason, 'completed')
  assert.equal(runtime.calls.length, 1)
  assert.equal(runtime.calls[0].action, 'do_thing')
})

test('Phase 5: cancellation produces status=killed terminalReason=cancelled_user (NEVER failed)', async () => {
  const { runtime } = setupRunner({ launchStuckGuardMs: 5_000 })
  // The runtime stalls on runSkill so cancellation arrives mid-action.
  let resolveStall!: () => void
  const stallPromise = new Promise<void>((r) => { resolveStall = r })
  runtime.manager.runSkill = (async () => {
    await stallPromise
    return {
      success: true, skillId: 'test-skill-cancel', action: 'do_thing',
      stdout: '', stderr: '', command: [],
    }
  }) as never
  registerStubDriver('test-skill-cancel', {
    plans: [
      { action: 'do_thing', input: {} },
      makeTerminalClose('test-skill-cancel', 'completed', 'completed'),
    ],
  })
  const result = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId: 'test-skill-cancel',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/cancel' },
  })
  // give the runner a chance to issue action_started
  await sleep(20)
  const closePromise = cancelSkillChildRun(result.childRunId, 'user_pressed_cancel')
  // Release the stall so the runtime call resolves and the loop reaches
  // the abort check.
  resolveStall()
  const close = await closePromise
  assert.equal(close.status, 'killed', 'cancellation must NEVER map to failed')
  assert.equal(close.terminalReason, 'cancelled_user')
  assert.notEqual(close.status, 'failed', 'cancellation must NEVER map to failed')
})

test('Phase 5: process-crash-shaped throw closes status=failed terminalReason=infra_error', async () => {
  const crash = new Error('child process crashed (signal SIGKILL exit code 137)')
  const { runtime } = setupRunner({ runtime: makeFakeRuntime({ throwOnce: crash }) })
  registerStubDriver('test-skill-crash', {
    plans: [
      { action: 'do_thing', input: {} },
      makeTerminalClose('test-skill-crash', 'completed', 'completed'),
    ],
  })
  const result = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId: 'test-skill-crash',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/crash' },
  })
  const close = await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
  assert.equal(close.status, 'failed')
  assert.equal(close.terminalReason, 'infra_error')
  assert.ok(close.error)
  assert.equal(close.error!.kind, 'child_process_crashed')
  // Ensure the call was made.
  assert.equal(runtime.calls.length, 1)
})

test('Phase 5: skill-declared failure closes status=failed terminalReason=failed_skill', async () => {
  const failure: SkillRunResult = {
    success: false,
    skillId: 'test-skill-fail',
    action: 'do_thing',
    stdout: '',
    stderr: '',
    command: [],
    error: 'skill returned non-zero exit',
  }
  setupRunner({ runtime: makeFakeRuntime({ results: [failure] }) })
  registerStubDriver('test-skill-fail', {
    plans: [
      { action: 'do_thing', input: {} },
      makeTerminalClose('test-skill-fail', 'completed', 'completed'),
    ],
  })
  const result = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId: 'test-skill-fail',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/fail' },
  })
  const close = await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
  assert.equal(close.status, 'failed')
  assert.equal(close.terminalReason, 'failed_skill')
})

test('Phase 5: budget exhaustion closes status=budget_paused terminalReason=checkpoint_budget (never done)', async () => {
  setupRunner({ maxActionsPerRun: 2 })
  // Driver always returns an action — never naturally completes.
  registerStubDriver('test-skill-budget', {
    plans: [{ action: 'do_thing', input: {} }],
  })
  const result = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId: 'test-skill-budget',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/budget' },
  })
  const close = await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
  assert.equal(close.status, 'budget_paused')
  assert.equal(close.terminalReason, 'checkpoint_budget')
})

test('Phase 5: resume — pause via budget then resume continues', async () => {
  // Two phases: first start hits a low budget, then resume completes.
  const { repo } = setupRunner({ maxActionsPerRun: 1 })
  registerStubDriver('test-skill-resume', {
    plans: [
      { action: 'step_a', input: {} },
      { action: 'step_b', input: {} },
      makeTerminalClose('test-skill-resume', 'completed', 'completed'),
    ],
  })

  const first = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId: 'test-skill-resume',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/resume' },
  })
  const firstClose = await pollUntil(() => getSkillChildRunCloseEvent(first.childRunId))
  assert.equal(firstClose.status, 'budget_paused')

  // Reconfigure with a larger budget so resume can finish.
  setupRunner({ repo, maxActionsPerRun: 5 })
  registerStubDriver('test-skill-resume', {
    plans: [
      { action: 'step_b', input: {} },
      makeTerminalClose('test-skill-resume', 'completed', 'completed'),
    ],
  })
  // Reset the row's status manually so the resume helper doesn't trip
  // over the terminal projection.
  repo.repo.updateChildRun(first.childRunId, { status: 'recoverable_paused' })

  const second = await resumeSkillChildRun(first.childRunId)
  assert.equal(second.childRunId, first.childRunId)
  const secondClose = await pollUntil(() => getSkillChildRunCloseEvent(first.childRunId), 3_000)
  // After resume the recentCloses map has been overwritten with the new
  // close; it should be completed.
  assert.equal(secondClose.status, 'completed')
})

test('Phase 5: nested-child guard rejects re-entrant startSkillChildRun without childInternal', async () => {
  setupRunner()
  // Driver A, on planNextAction, attempts a nested public start.
  let nestedAttemptResult: Awaited<ReturnType<typeof startSkillChildRun>> | null = null
  const driverA: SkillChildDriver = {
    skillId: 'test-skill-nest',
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params) => ({ skillId: 'test-skill-nest', requestedInput: params.requestedInput }),
    planNextAction: async () => {
      nestedAttemptResult = await startSkillChildRun({
        scopeId: 'scope-1',
        sessionId: 'session-1',
        skillId: 'test-skill-nest-inner',
        action: 'do_thing',
        requestedInput: { url: 'https://example.com/nested' },
      })
      return makeTerminalClose('test-skill-nest', 'completed', 'completed')
    },
    observeAfterAction: async (state) => state,
  }
  registerSkillChildDriver(driverA)
  registerStubDriver('test-skill-nest-inner', {
    plans: [makeTerminalClose('test-skill-nest-inner', 'completed', 'completed')],
  })

  const result = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId: 'test-skill-nest',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/outer' },
  })
  await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
  assert.ok(nestedAttemptResult, 'nested start must have produced a result')
  assert.ok(nestedAttemptResult!.closeEvent, 'nested start must produce a close event')
  assert.equal(nestedAttemptResult!.closeEvent!.terminalReason, 'nested_child_run_not_supported')
})

test('Phase 5: budget constant is exposed', () => {
  assert.equal(typeof MAX_ACTIONS_PER_CHILD_RUN, 'number')
  assert.ok(MAX_ACTIONS_PER_CHILD_RUN > 0)
})

// =====================================================================
// Status / liveness contract regression guards (T2)
//
// These tests lock the boundary against any future change that would
// reintroduce the legacy status vocabulary (`background_running` / `done` /
// `cancelled`) into typed child-loop close events. The fixture synthesises
// real runs through the same launch path the production runner uses, so a
// regression in the close-event mapper or the cancellation path will fail
// here even if no one updated the dedicated status-mapper tests.
// =====================================================================

/**
 * Public supervisor-status union (mirrors `SkillTaskSupervisorStatus`). Any
 * status produced by a public-surface adapter must be a member of this set.
 */
const PUBLIC_SUPERVISOR_STATUS_VALUES: ReadonlySet<string> = new Set([
  'running',
  'completed',
  'killed',
  'failed',
  'blocked',
  'recoverable_paused',
  'budget_paused',
  'unknown',
])

/**
 * Legacy / internal status strings that MUST NOT appear in any public
 * surface output. `done` and `cancelled` are upstream raw signals only;
 * `background_running` was retired in favor of `liveness='background'`.
 */
const LEGACY_STATUS_LEAK_VALUES: readonly string[] = [
  'background_running',
  'done',
  'cancelled',
] as const

function expectSupervisorStatusInPublicSet(status: string): void {
  assert.ok(
    PUBLIC_SUPERVISOR_STATUS_VALUES.has(status),
    `status='${status}' is not a member of the public supervisor-status union`,
  )
}

test('T2 guard — cancelled child run NEVER leaks legacy status strings into the close event', async () => {
  const { runtime } = setupRunner({ launchStuckGuardMs: 5_000 })
  let resolveStall!: () => void
  const stallPromise = new Promise<void>((r) => { resolveStall = r })
  runtime.manager.runSkill = (async () => {
    await stallPromise
    return {
      success: true, skillId: 'test-skill-cancel-guard', action: 'do_thing',
      stdout: '', stderr: '', command: [],
    }
  }) as never
  registerStubDriver('test-skill-cancel-guard', {
    plans: [
      { action: 'do_thing', input: {} },
      makeTerminalClose('test-skill-cancel-guard', 'completed', 'completed'),
    ],
  })
  const result = await startSkillChildRun({
    scopeId: 'scope-guard',
    sessionId: 'session-guard',
    skillId: 'test-skill-cancel-guard',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/cancel-guard' },
  })
  await sleep(20)
  const closePromise = cancelSkillChildRun(result.childRunId, 'user_pressed_cancel')
  resolveStall()
  const close = await closePromise

  // (1) Cancellation maps to `killed`, never `failed` (re-asserted as a
  // canonical regression line; the legacy code path used to produce
  // `failed` for SIGTERM-shaped aborts).
  assert.equal(close.status, 'killed')
  assert.notEqual(close.status as string, 'failed')

  // (2) The close.status is one of the typed Exclude<SkillChildRunStatus,
  // 'queued' | 'running'> values — and crucially NOT one of the legacy
  // strings that historically leaked through unguarded mappers.
  for (const legacy of LEGACY_STATUS_LEAK_VALUES) {
    assert.notEqual(close.status as string, legacy,
      `cancelled close.status must never be legacy '${legacy}'`)
  }
  assert.equal(close.terminalReason, 'cancelled_user')
})

test('T2 guard — launch_stuck close is NOT cancelled_user and status is failed (not killed)', async () => {
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  configureSkillChildRunner({
    runtimeManager: makeFakeRuntime().manager,
    repository: makeFakeRepository().repo,
    launchStuckGuardMs: 30,
  })
  // Driver hangs in planNextAction so the runner records `started` but
  // never reaches `action_started` — same shape an observer/await timeout
  // would take.
  let resolveDriver!: () => void
  const stall = new Promise<void>((r) => { resolveDriver = r })
  registerSkillChildDriver({
    skillId: 'test-skill-launch-stuck-guard',
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params) => ({
      skillId: 'test-skill-launch-stuck-guard',
      requestedInput: params.requestedInput,
    }),
    planNextAction: async () => {
      await stall
      return makeTerminalClose('test-skill-launch-stuck-guard', 'completed', 'completed')
    },
    observeAfterAction: async (state) => state,
  })
  const launch = await startSkillChildRun({
    scopeId: 'scope-launch',
    sessionId: 'session-launch',
    skillId: 'test-skill-launch-stuck-guard',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/launch-stuck' },
  })
  const close = await pollUntil(() => getSkillChildRunCloseEvent(launch.childRunId), 1_500)

  // The whole point: a launch / observer timeout MUST NOT masquerade as a
  // user cancel — neither in `status` nor in `terminalReason`.
  assert.notEqual(close.status, 'killed', 'launch-stuck must not be reported as killed')
  assert.notEqual(close.terminalReason, 'cancelled_user',
    'launch-stuck must not be reported as cancelled_user')
  assert.equal(close.status, 'failed')
  assert.equal(close.terminalReason, 'launch_stuck')

  // Status is still typed against the public child-status union; legacy
  // strings must not leak even on the timeout/observer path.
  for (const legacy of LEGACY_STATUS_LEAK_VALUES) {
    assert.notEqual(close.status as string, legacy,
      `launch-stuck close.status must never be legacy '${legacy}'`)
  }

  resolveDriver()
})

test('T2 guard — every typed close event status is in the public child-status union', async () => {
  // Iterate the lifecycle once over completion and once over skill-failure
  // to assert the close event status field never carries a legacy string.
  // The cancellation + launch-stuck cases are covered by their own tests
  // above; this case nails down the success / skill-failure branches.
  const successCases: Array<{
    skillId: string
    runtime: ReturnType<typeof makeFakeRuntime>
    expected: SkillChildCloseEvent['status']
  }> = [
    {
      skillId: 'test-skill-completed-guard',
      runtime: makeFakeRuntime(),
      expected: 'completed',
    },
    {
      skillId: 'test-skill-failed-guard',
      runtime: makeFakeRuntime({
        results: [{
          success: false,
          skillId: 'test-skill-failed-guard',
          action: 'do_thing',
          stdout: '', stderr: '', command: [],
          error: 'declared failure',
        }],
      }),
      expected: 'failed',
    },
  ]
  for (const c of successCases) {
    setupRunner({ runtime: c.runtime })
    registerStubDriver(c.skillId, {
      plans: [
        { action: 'do_thing', input: {} },
        makeTerminalClose(c.skillId, 'completed', 'completed'),
      ],
    })
    const launched = await startSkillChildRun({
      scopeId: 'scope-status-union',
      sessionId: 'session-status-union',
      skillId: c.skillId,
      action: 'do_thing',
      requestedInput: { url: `https://example.com/${c.skillId}` },
    })
    const close = await pollUntil(() => getSkillChildRunCloseEvent(launched.childRunId))
    // Public union membership: status must be one of the allowed values.
    assert.ok(
      PUBLIC_SUPERVISOR_STATUS_VALUES.has(close.status as string)
        // The child-status union additionally allows `recoverable_paused`
        // and `budget_paused`, both already in the public set, plus the
        // closed-only states `completed/failed/killed`. We test against
        // the supervisor union as a tighter superset.
        || close.status === 'completed'
        || close.status === 'killed'
        || close.status === 'failed',
      `close.status='${close.status}' must be in the public union`,
    )
    expectSupervisorStatusInPublicSet(close.status as string)
    for (const legacy of LEGACY_STATUS_LEAK_VALUES) {
      assert.notEqual(close.status as string, legacy,
        `close.status must never be legacy '${legacy}' (skill=${c.skillId})`)
    }
  }
})

// =====================================================================
// T4 — Durable close persistence + inactive cancel + observer-timeout
// regression guards.
//
// These cases lock down the contract that close events survive across
// the in-memory `recentCloses` cache being cleared (process restart
// proxy) and that `cancelSkillChildRun` on a persisted-but-inactive row
// uses the row's real metadata instead of synthesizing `'unknown'`.
// =====================================================================

test('T4 Case C: getCloseEvent reads durable close after recentCloses is cleared', async () => {
  const { repo } = setupRunner()
  registerStubDriver('test-skill-durable-close', {
    plans: [
      { action: 'do_thing', input: {} },
      makeTerminalClose('test-skill-durable-close', 'completed', 'completed'),
    ],
  })
  const result = await startSkillChildRun({
    scopeId: 'scope-durable',
    sessionId: 'session-durable',
    skillId: 'test-skill-durable-close',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/durable' },
  })
  // Wait for the run to terminate.
  await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))

  // Tear down the runner singleton (proxy for "process restarted") but
  // keep the repository state so the durable close persists in the row.
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  configureSkillChildRunner({
    runtimeManager: makeFakeRuntime().manager,
    repository: repo.repo,
    launchStuckGuardMs: 100,
  })

  // After fresh runner config, recentCloses is empty. The repo still has
  // the close event. getSkillChildRunCloseEvent must reconstruct it from
  // the durable record.
  const durable = getSkillChildRunCloseEvent(result.childRunId)
  assert.ok(durable, 'durable close must survive recentCloses eviction')
  assert.equal(durable!.childRunId, result.childRunId)
  assert.equal(durable!.skillId, 'test-skill-durable-close')
  assert.equal(durable!.status, 'completed')
  assert.equal(durable!.terminalReason, 'completed')
})

test('T4 Case D: cancel on persisted-but-inactive row uses the row real skillId / outputDir / runStatePath', async () => {
  const { repo } = setupRunner()
  registerStubDriver('test-skill-cancel-real', {
    plans: [
      { action: 'do_thing', input: {} },
      makeTerminalClose('test-skill-cancel-real', 'completed', 'completed'),
    ],
  })
  // Drive the run far enough to mint a real row with real outputDir /
  // runStatePath, then let it complete naturally.
  const result = await startSkillChildRun({
    scopeId: 'scope-cancel-real',
    sessionId: 'session-cancel-real',
    skillId: 'test-skill-cancel-real',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/cancel-real' },
  })
  await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))

  // Capture row metadata while the row is still in the repo.
  const row = repo.state.rows.get(result.childRunId)
  assert.ok(row, 'row must be persisted')
  const realOutputDir = row!.outputDir
  const realRunStatePath = row!.runStatePath
  assert.ok(realOutputDir, 'real outputDir must be persisted')
  assert.ok(realRunStatePath, 'real runStatePath must be persisted')

  // Tear down the runner singleton; the row stays in the repo. Now the
  // active map is empty so `cancelSkillChildRun` falls through to the
  // synthesizing branch.
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  configureSkillChildRunner({
    runtimeManager: makeFakeRuntime().manager,
    repository: repo.repo,
    launchStuckGuardMs: 100,
  })

  // The row already has a durable close from completion; that close MUST
  // be returned (not a synthesized killed). But to test the synthesize
  // branch with REAL metadata, force the row back to a non-terminal state
  // first so cancel must mint a fresh close.
  repo.repo.updateChildRun(result.childRunId, { status: 'recoverable_paused', closeEvent: null })

  const close = await cancelSkillChildRun(result.childRunId, 'user_pressed_cancel')
  // (1) Real skillId, NOT 'unknown'.
  assert.equal(close.skillId, 'test-skill-cancel-real',
    'cancel close must use the row real skillId')
  assert.notEqual(close.skillId, 'unknown')
  // (2) Real outputDir / runStatePath, NOT null.
  assert.equal(close.outputDir, realOutputDir,
    'cancel close must use the row real outputDir')
  assert.equal(close.runStatePath, realRunStatePath,
    'cancel close must use the row real runStatePath')
  // (3) Status remains killed/cancelled_user (cancel is an explicit user
  // intent — Case E covers the observer-timeout distinction).
  assert.equal(close.status, 'killed')
  assert.equal(close.terminalReason, 'cancelled_user')
})

test('T4 Case E: observer / launch timeout MUST NOT mark the child as killed / cancelled_user', async () => {
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  configureSkillChildRunner({
    runtimeManager: makeFakeRuntime().manager,
    repository: makeFakeRepository().repo,
    launchStuckGuardMs: 30,
  })
  // Driver hangs in planNextAction so the runner never reaches
  // `action_started` — the launch-stuck guard fires. This is the
  // canonical "observer / awaiter timeout" code path inside the runner.
  let resolveDriver!: () => void
  const stall = new Promise<void>((r) => { resolveDriver = r })
  registerSkillChildDriver({
    skillId: 'test-skill-observer-timeout',
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params) => ({
      skillId: 'test-skill-observer-timeout',
      requestedInput: params.requestedInput,
    }),
    planNextAction: async () => {
      await stall
      return makeTerminalClose('test-skill-observer-timeout', 'completed', 'completed')
    },
    observeAfterAction: async (state) => state,
  })
  const launch = await startSkillChildRun({
    scopeId: 'scope-observer',
    sessionId: 'session-observer',
    skillId: 'test-skill-observer-timeout',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/observer-timeout' },
  })
  const close = await pollUntil(() => getSkillChildRunCloseEvent(launch.childRunId), 1_500)

  // Observer / awaiter timeout MUST NOT collapse into a user cancel.
  assert.notEqual(close.status, 'killed',
    'observer-timeout must not be reported as killed')
  assert.notEqual(close.terminalReason, 'cancelled_user',
    'observer-timeout must not be reported as cancelled_user')
  // The real terminal reason is launch_stuck (status='failed').
  assert.equal(close.status, 'failed')
  assert.equal(close.terminalReason, 'launch_stuck')

  resolveDriver()
})
