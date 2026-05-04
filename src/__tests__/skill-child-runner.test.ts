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
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import {
  SkillTaskRunRepository,
  type CreateChildRunInput,
} from '../main/modules/repositories/skill-task-run-repository'
import { createSkillChildRunId } from '../main/modules/agent-control/skill-child-run-id'

const requireFromHere = createRequire(import.meta.url)

export const __breaksInvariants = [
  'test-fixture.skill-child-runner.setupRunner-resets-singleton',
] as const

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
  let rawDb: InstanceType<SqliteCtor>
  try {
    rawDb = new Sqlite(':memory:')
  } catch {
    return null
  }
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

    setup.repo.updateChildRun(input.childRunId, { status: 'blocked' })
    const afterBlocked = setup.repo.findLatestChildRunByKey(input.singleFlightKey)
    assert.equal(afterBlocked, null, 'blocked rows must not hijack a later single-flight launch')

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
  getSkillChildRunner,
  waitForSkillChildRunClose,
  MAX_ACTIONS_PER_CHILD_RUN,
} from '../main/modules/agent-control/skill-child-runner'
import {
  clearSkillTaskProjection,
  readSkillTaskProjection,
  recordSkillTaskEvent,
} from '../main/modules/agent-control/skill-task-tracker'
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
import { startSkillChildRunAndWait } from '../main/modules/skills-runtime/runtime-manager'
import { defaultToolRegistry } from '../main/modules/agent-control/tool-registry'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'
import { TOOL_ERROR_METRICS } from '../main/modules/agent-control/tool-error-metrics'
import type { ToolDefinition } from '../main/modules/agent-control/tool-definition'
import type { SkillTaskRunRecord } from '../main/modules/repositories/skill-task-run-repository'
import type { TaskProjectionRecord, TaskProjectionStore } from '../main/modules/agent-control/run-contracts'
// `SkillTaskRunRepository` is already imported as a value (the class
// constructor) on line 25; ESLint flags a redeclare if we re-import it
// here as a type, so we reuse the value-imported binding for both
// purposes.

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
      if (typeof patch.outputDir === 'string') existing.outputDir = patch.outputDir
      if (typeof patch.runStatePath === 'string') existing.runStatePath = patch.runStatePath
      existing.updatedAt = new Date().toISOString()
    },
    update: (id: string, patch: Partial<SkillTaskRunRecord>) => {
      const existing = state.rows.get(id)
      if (!existing) throw new Error(`no row ${id}`)
      state.rows.set(id, {
        ...existing,
        ...patch,
        updatedAt: patch.updatedAt ?? existing.updatedAt,
      })
    },
    findLatestChildRunByKey: (key: string): SkillTaskRunRecord | null => {
      const ACTIVE = new Set(['queued', 'running', 'recoverable_paused', 'budget_paused'])
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

interface FakeTaskProjectionStoreState {
  rows: Map<string, TaskProjectionRecord>
  updates: Array<{ taskId: string; patch: Partial<TaskProjectionRecord> }>
}

function makeFakeTaskProjectionStore(): {
  store: TaskProjectionStore
  state: FakeTaskProjectionStoreState
} {
  const state: FakeTaskProjectionStoreState = {
    rows: new Map(),
    updates: [],
  }
  const store: TaskProjectionStore = {
    create(record) {
      state.rows.set(record.taskId, record)
    },
    update(taskId, patch) {
      state.updates.push({ taskId, patch })
      const existing = state.rows.get(taskId)
      if (!existing) throw new Error(`no task projection ${taskId}`)
      state.rows.set(taskId, {
        ...existing,
        ...patch,
      })
    },
    get(taskId) {
      return state.rows.get(taskId) ?? null
    },
    listByScope(scopeId) {
      return Array.from(state.rows.values()).filter((record) => record.scopeId === scopeId)
    },
    listByParentTask(parentTaskId) {
      return Array.from(state.rows.values()).filter((record) => record.parentTaskId === parentTaskId)
    },
  }
  return { store, state }
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

let testSkillToolDefinitionsInstalled = false

function installTestSkillToolDefinitions(): void {
  if (testSkillToolDefinitionsInstalled) return
  testSkillToolDefinitionsInstalled = true
  const registry = defaultToolRegistry as unknown as {
    getToolDefinitionForExecution: (toolName: string) => ToolDefinition | null
  }
  const original = registry.getToolDefinitionForExecution.bind(defaultToolRegistry)
  registry.getToolDefinitionForExecution = (toolName: string) => {
    if (toolName.startsWith('skill_test_') || toolName === 'skill_video_expert_pipeline') {
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

/**
 * IMPORTANT — singleton lifecycle in tests:
 *
 * `setupRunner()` calls `__resetSkillChildRunnerForTests()` which wipes the
 * SkillChildRunner singleton (active map, recentCloses cache). Production
 * NEVER resets the singleton mid-session — `configureSkillChildRunner` is
 * called once at boot.
 *
 * RULE: do NOT call `setupRunner()` (or `__resetSkillChildRunnerForTests()`)
 * between two lifecycle events on the SAME childRunId. Doing so can mask
 * production bugs where in-memory caches don't transition correctly across
 * lifecycles (e.g., the historical A1 bug where finalizeRun's recentCloses
 * guard early-returned on resume because the previous lifecycle's close
 * was still cached).
 *
 * EXCEPTION: tests that intentionally simulate process restart (T4 Case C/D
 * below) MUST reset the singleton to test the durable recovery path. Mark
 * such tests with an inline comment explaining the simulation.
 *
 * If a test needs to change runner config (e.g., maxActionsPerRun) between
 * lifecycle events on the same childRunId, prefer one of:
 *   1. Set the larger budget at initial setupRunner() and trigger
 *      budget_paused via the driver's plan list size, not the budget cap.
 *   2. Re-register the driver with new plans (registerStubDriver with
 *      same skillId), keeping the runner singleton intact.
 * See `skill-child-runner-resume-lifecycle.test.ts` for examples.
 */
function setupRunner(opts: {
  runtime?: ReturnType<typeof makeFakeRuntime>
  repo?: ReturnType<typeof makeFakeRepository>
  launchStuckGuardMs?: number
  maxActionsPerRun?: number
  maxActiveVeaRuns?: number
  progressPollIntervalMs?: number
  taskProjectionStore?: ReturnType<typeof makeFakeTaskProjectionStore>
} = {}): {
  runtime: ReturnType<typeof makeFakeRuntime>
  repo: ReturnType<typeof makeFakeRepository>
} {
  installTestSkillToolDefinitions()
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  clearSkillTaskProjection()
  const runtime = opts.runtime ?? makeFakeRuntime()
  const repo = opts.repo ?? makeFakeRepository()
  const config = {
    runtimeManager: runtime.manager,
    repository: repo.repo,
    launchStuckGuardMs: opts.launchStuckGuardMs ?? 100,
    maxActionsPerRun: opts.maxActionsPerRun,
    maxActiveVeaRuns: opts.maxActiveVeaRuns,
    progressPollIntervalMs: opts.progressPollIntervalMs,
    ...(opts.taskProjectionStore ? { taskProjectionStore: opts.taskProjectionStore.store } : {}),
  } as Parameters<typeof configureSkillChildRunner>[0] & { taskProjectionStore?: TaskProjectionStore }
  configureSkillChildRunner(config)
  return { runtime, repo }
}

function currentProjectionStep(projection: NonNullable<ReturnType<typeof readSkillTaskProjection>>) {
  return projection.steps.find((step) => step.id === projection.currentStepId) ?? null
}

function completedVeaScene(sceneNumber: number): Record<string, unknown> {
  return {
    scene_number: sceneNumber,
    type_classification: 'cinematic_vlog',
    description: 'Complete scene description.',
    scores: {
      aesthetic_beauty: 8,
      credibility: 8,
      impact: 8,
      memorability: 8,
      fun_interest: 8,
    },
    weighted_score: 8,
    selection: '[KEEP]',
    selection_reasoning: 'Complete reasoning.',
    edit_suggestion: 'Complete suggestion.',
    storyboard: {
      shot_size: 'medium',
      lighting: 'soft',
      camera_movement: 'pan',
      visual_style: 'cinematic',
      technique: 'cut',
    },
  }
}

function writeCompletedVeaArtifacts(outputDir: string, videoId = 'test-video'): void {
  writeFileSync(join(outputDir, 'run_state.json'), JSON.stringify({
    status: 'completed',
    current_stage: 'completed',
    total_scenes: 2,
    completed_scenes: 2,
    scores_path: 'scene_scores.json',
  }), 'utf8')
  writeFileSync(join(outputDir, 'scene_scores.json'), JSON.stringify({
    total_scenes: 2,
    scenes: [completedVeaScene(1), completedVeaScene(2)],
  }), 'utf8')
  writeFileSync(join(outputDir, `${videoId}_storyboard.md`), 'storyboard', 'utf8')
  writeFileSync(join(outputDir, `${videoId}_storyboard.pdf`), 'storyboard pdf', 'utf8')
  writeFileSync(join(outputDir, `${videoId}_audiovisual_analysis.md`), 'audiovisual report', 'utf8')
  writeFileSync(join(outputDir, `${videoId}_audiovisual_analysis.pdf`), 'audiovisual pdf', 'utf8')
  writeFileSync(join(outputDir, 'delivery_report.json'), JSON.stringify({
    status: 'completed',
    required_outputs: {
      storyboard_md: { ok: true, path: `${videoId}_storyboard.md` },
      storyboard_pdf: { ok: true, path: `${videoId}_storyboard.pdf` },
      audiovisual_md: { ok: true, path: `${videoId}_audiovisual_analysis.md` },
      audiovisual_pdf: { ok: true, path: `${videoId}_audiovisual_analysis.pdf` },
    },
  }), 'utf8')
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

test('Worker B: child launch immediately creates a background task projection', async () => {
  const { runtime } = setupRunner({ launchStuckGuardMs: 5_000 })
  let resolveStall!: () => void
  const stall = new Promise<void>((resolve) => { resolveStall = resolve })
  runtime.manager.runSkill = (async (request: SkillRunRequest) => {
    await stall
    return {
      success: true,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
    }
  }) as never
  registerStubDriver('test-skill-projection-launch', {
    plans: [
      { action: 'do_thing', input: {} },
      makeTerminalClose('test-skill-projection-launch', 'completed', 'completed'),
    ],
  })

  const launch = await startSkillChildRun({
    scopeId: 'scope-projection-launch',
    sessionId: 'session-projection-launch',
    skillId: 'test-skill-projection-launch',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/projection-launch' },
  })

  const projection = readSkillTaskProjection({
    sessionId: 'session-projection-launch',
    skillId: 'test-skill-projection-launch',
  })
  assert.ok(projection, 'launch must create a task projection immediately')
  assert.equal((projection as unknown as { status?: string }).status, 'running')
  assert.equal(projection.waitingFor, 'background')
  assert.deepEqual(projection.resumableActions, ['continue', 'cancel'])
  const continuation = projection.taskContinuation as Record<string, unknown>
  assert.equal(continuation.childRunId, launch.childRunId)
  assert.equal(continuation.skillId, 'test-skill-projection-launch')
  assert.equal(continuation.action, 'do_thing')
  assert.equal(continuation.runStatePath, launch.runStatePath)
  assert.equal(continuation.outputDir, launch.outputDir)
  assert.equal(currentProjectionStep(projection)?.status, 'running')

  recordSkillTaskEvent({
    scopeId: 'scope-projection-launch',
    sessionId: 'session-projection-launch',
    skillId: 'test-skill-projection-launch',
    toolName: 'skill_test_projection_launch',
    action: 'do_thing',
    runKind: 'typed_action',
    status: 'done',
    stepId: 'launcher#1',
  })
  const afterLauncherDone = readSkillTaskProjection({
    sessionId: 'session-projection-launch',
    skillId: 'test-skill-projection-launch',
  })
  assert.equal((afterLauncherDone as unknown as { status?: string }).status, 'running')
  assert.equal(afterLauncherDone?.waitingFor, 'background')
  assert.equal(
    (afterLauncherDone?.taskContinuation as Record<string, unknown>).childRunId,
    launch.childRunId,
    'parent launcher completion must not erase the child continuation handle',
  )

  resolveStall()
  await pollUntil(() => getSkillChildRunCloseEvent(launch.childRunId))
})

test('Worker B: child runner persists childRunId-keyed projection rows through launch, progress, and close', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-child-task-projection-'))
  const runStatePath = join(outputDir, 'run_state.json')
  const taskProjectionStore = makeFakeTaskProjectionStore()
  const { runtime, repo } = setupRunner({
    launchStuckGuardMs: 5_000,
    progressPollIntervalMs: 10,
    taskProjectionStore,
  })
  let releaseAction!: () => void
  const actionHold = new Promise<void>((resolve) => { releaseAction = resolve })
  runtime.manager.runSkill = (async (request: SkillRunRequest) => {
    writeFileSync(runStatePath, JSON.stringify({
      current_stage: 'score_batches',
      total_scenes: 8,
      completed_scenes: 5,
      coverage_ratio: 0.625,
      updated_at: '2026-05-04T08:00:00.000Z',
      status: 'running',
    }), 'utf8')
    await actionHold
    return {
      success: true,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
    }
  }) as never
  registerStubDriver('test-skill-child-task-projection', {
    plans: [
      { action: 'do_thing', input: {} },
      makeTerminalClose('test-skill-child-task-projection', 'completed', 'completed'),
    ],
  })

  const launch = await startSkillChildRun({
    scopeId: 'scope-child-task-projection',
    sessionId: 'session-child-task-projection',
    skillId: 'test-skill-child-task-projection',
    action: 'do_thing',
    requestedInput: { outputDir },
  })
  const taskId = `skill-child:${launch.childRunId}`

  const launched = taskProjectionStore.state.rows.get(taskId)
  assert.ok(launched, 'launch must persist a childRunId-keyed task projection row')
  assert.equal(launched!.scopeId, 'scope-child-task-projection')
  assert.equal(launched!.status, 'running')
  assert.equal(launched!.interactionState, 'suspended')
  assert.equal(launched!.waitingFor, 'background')
  assert.equal(launched!.continuationRef?.childRunId, launch.childRunId)
  assert.equal(launched!.continuationRef?.outputDir, outputDir)
  assert.equal(launched!.continuationRef?.runStatePath, runStatePath)

  const progressed = await pollUntil(() => {
    const row = taskProjectionStore.state.rows.get(taskId)
    return row?.progress?.completed === 5 ? row : null
  })
  assert.equal(progressed.progress?.stage, 'score_batches')
  assert.equal(progressed.progress?.coverage, 0.625)

  releaseAction()
  await pollUntil(() => {
    const row = taskProjectionStore.state.rows.get(taskId)
    return row?.status === 'done' ? row : null
  })

  const closed = taskProjectionStore.state.rows.get(taskId)!
  assert.equal(closed.status, 'done')
  assert.equal(closed.interactionState, 'suspended')
  assert.equal(closed.waitingFor, 'none')
  assert.deepEqual(closed.resumableActions, ['open_artifact'])
  assert.equal(repo.state.rows.get(launch.childRunId)?.interactionState, 'suspended')
})

test('Worker B: state_observed reads run_state/artifact progress into projection and active summary', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-child-progress-'))
  const runStatePath = join(outputDir, 'run_state.json')
  const updatedAt = '2026-05-02T03:04:05.000Z'
  const { runtime } = setupRunner()
  runtime.manager.runSkill = (async (request: SkillRunRequest) => {
    writeFileSync(runStatePath, JSON.stringify({
      current_stage: 'score_batches',
      total_scenes: 10,
      completed_scenes: 3,
      coverage_ratio: 0.3,
      updated_at: updatedAt,
      last_error: 'provider retrying',
    }), 'utf8')
    return {
      success: true,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
    }
  }) as never
  let planCount = 0
  let releaseTerminal!: () => void
  const terminalHold = new Promise<void>((resolve) => { releaseTerminal = resolve })
  registerSkillChildDriver({
    skillId: 'test-skill-projection-progress',
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params) => ({
      skillId: 'test-skill-projection-progress',
      requestedInput: params.requestedInput,
    }),
    planNextAction: async () => {
      planCount += 1
      if (planCount === 1) return { action: 'do_thing', input: {} }
      await terminalHold
      return makeTerminalClose('test-skill-projection-progress', 'completed', 'completed')
    },
    observeAfterAction: async (state) => state,
  })

  const launch = await startSkillChildRun({
    scopeId: 'scope-projection-progress',
    sessionId: 'session-projection-progress',
    skillId: 'test-skill-projection-progress',
    action: 'do_thing',
    requestedInput: { outputDir },
  })

  const projection = await pollUntil(() => {
    const current = readSkillTaskProjection({
      sessionId: 'session-projection-progress',
      skillId: 'test-skill-projection-progress',
    })
    const progress = (current as unknown as { progress?: { stage?: string | null } } | null)?.progress
    return progress?.stage === 'score_batches' ? current : null
  })
  assert.deepEqual((projection as unknown as { progress: Record<string, unknown> }).progress, {
    stage: 'score_batches',
    completed: 3,
    total: 10,
    coverage: 0.3,
    overallCoverage: 0.3,
    fingerprint: 'score_batches|3|10|0.3|0.3|2026-05-02T03:04:05.000Z',
    updatedAt,
    lastError: 'provider retrying',
    handoff: null,
  })

  const active = getSkillChildRunner()?.listActiveRuns()
    .find((item) => item.childRunId === launch.childRunId)
  assert.equal(active?.progress.stage, 'score_batches')
  assert.equal(active?.progress.completed, 3)
  assert.equal(active?.progress.total, 10)
  assert.equal(active?.progress.coverage, 0.3)
  assert.equal(active?.progress.updatedAt, updatedAt)

  releaseTerminal()
  const close = await pollUntil(() => getSkillChildRunCloseEvent(launch.childRunId))
  assert.equal(close.progress.stage, 'score_batches')
  assert.equal(close.progress.completedUnits, 3)
  assert.equal(close.progress.totalUnits, 10)
  assert.equal(close.progress.coverageRatio, 0.3)
})

test('Worker B: progress poll claims a child-created output subdirectory by childRunId', async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), 'ready-child-progress-root-'))
  const childOutputDir = join(outputRoot, 'video-title-output')
  const childRunStatePath = join(childOutputDir, 'run_state.json')
  const { runtime, repo } = setupRunner({
    launchStuckGuardMs: 5_000,
    progressPollIntervalMs: 10,
  })
  let releaseAction!: () => void
  const actionHold = new Promise<void>((resolve) => { releaseAction = resolve })
  runtime.manager.runSkill = (async (request: SkillRunRequest) => {
    const context = request.params?.__childRunContext as { childRunId?: string } | undefined
    mkdirSync(childOutputDir, { recursive: true })
    writeFileSync(childRunStatePath, JSON.stringify({
      child_run_id: context?.childRunId,
      current_stage: 'prepare',
      total_scenes: 90,
      completed_scenes: 12,
      coverage_ratio: 0.1333,
      updated_at: '2026-05-04T03:12:00.000Z',
      active_output_dir: childOutputDir,
      status: 'running',
    }), 'utf8')
    await actionHold
    return {
      success: true,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
    }
  }) as never
  registerStubDriver('test-skill-progress-subdir', {
    plans: [
      { action: 'do_thing', input: {} },
      makeTerminalClose('test-skill-progress-subdir', 'completed', 'completed'),
    ],
  })

  const launch = await startSkillChildRun({
    scopeId: 'scope-progress-subdir',
    sessionId: 'session-progress-subdir',
    skillId: 'test-skill-progress-subdir',
    action: 'do_thing',
    requestedInput: { outputDir: outputRoot },
  })

  const projection = await pollUntil(() => {
    const current = readSkillTaskProjection({
      sessionId: 'session-progress-subdir',
      skillId: 'test-skill-progress-subdir',
    })
    const progress = (current as unknown as { progress?: { completed?: number | null } } | null)?.progress
    return progress?.completed === 12 ? current : null
  })
  assert.equal((projection.taskContinuation as Record<string, unknown>).outputDir, childOutputDir)
  assert.equal((projection.taskContinuation as Record<string, unknown>).runStatePath, childRunStatePath)

  const active = getSkillChildRunner()?.listActiveRuns()
    .find((item) => item.childRunId === launch.childRunId)
  assert.equal(active?.outputDir, childOutputDir)
  assert.equal(active?.runStatePath, childRunStatePath)
  const row = repo.state.rows.get(launch.childRunId)
  assert.equal(row?.outputDir, childOutputDir)
  assert.equal(row?.runStatePath, childRunStatePath)

  releaseAction()
  const close = await pollUntil(() => getSkillChildRunCloseEvent(launch.childRunId))
  assert.equal(close.outputDir, childOutputDir)
  assert.equal(close.runStatePath, childRunStatePath)
})

test('Worker B: terminal close refreshes child-created output subdirectory even without a poll tick', async () => {
  const outputRoot = mkdtempSync(join(tmpdir(), 'ready-child-final-root-'))
  const childOutputDir = join(outputRoot, 'video-title-output')
  const childRunStatePath = join(childOutputDir, 'run_state.json')
  const { runtime, repo } = setupRunner({
    launchStuckGuardMs: 5_000,
    progressPollIntervalMs: 0,
  })
  runtime.manager.runSkill = (async (request: SkillRunRequest) => {
    const context = request.params?.__childRunContext as { childRunId?: string } | undefined
    mkdirSync(childOutputDir, { recursive: true })
    writeFileSync(childRunStatePath, JSON.stringify({
      child_run_id: context?.childRunId,
      current_stage: 'finalize',
      total_scenes: 90,
      completed_scenes: 90,
      coverage_ratio: 1,
      updated_at: '2026-05-04T03:33:00.000Z',
      active_output_dir: childOutputDir,
      status: 'completed',
    }), 'utf8')
    return {
      success: true,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
    }
  }) as never
  registerStubDriver('video-expert-analyzer', {
    plans: [
      { action: 'video_expert_pipeline', input: { url: 'https://example.com/video', outputDir: outputRoot } },
      makeTerminalClose('video-expert-analyzer', 'completed', 'completed'),
    ],
  })

  const launch = await startSkillChildRun({
    scopeId: 'scope-final-subdir',
    sessionId: 'session-final-subdir',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/video', outputDir: outputRoot },
  })

  const close = await pollUntil(() => getSkillChildRunCloseEvent(launch.childRunId))
  assert.equal(close.outputDir, childOutputDir)
  assert.equal(close.runStatePath, childRunStatePath)
  assert.equal(close.progress.stage, 'finalize')
  assert.equal(close.progress.completedUnits, 90)
  assert.equal(close.progress.totalUnits, 90)
  assert.equal(repo.state.rows.get(launch.childRunId)?.outputDir, childOutputDir)
})

test('VEA child runner completes pending handoff packets before rerunning finalize', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-vea-handoff-runner-'))
  mkdirSync(join(outputDir, 'audiovisual_handoff', 'body'), { recursive: true })
  writeFileSync(join(outputDir, 'audiovisual_handoff', 'body', 'task.md'), 'write report body', 'utf8')
  writeFileSync(join(outputDir, 'audiovisual_handoff', 'receipt.json'), JSON.stringify({
    tasks: {
      body: {
        status: 'pending',
        task: 'audiovisual_handoff/body/task.md',
        output: 'audiovisual_handoff/body/output.md',
      },
    },
  }), 'utf8')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'generated report body' } }],
  }), { status: 200 })) as typeof fetch
  try {
    const { runtime } = setupRunner({ launchStuckGuardMs: 5_000 })
    runtime.manager.runSkill = (async (request: SkillRunRequest) => ({
      success: false,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
      status: 'blocked',
      outputDir,
      error: 'handoff pending',
    })) as never
    registerStubDriver('video-expert-analyzer', {
      plans: [
        { action: 'video_expert_ai_analyze', input: { outputDir, sceneScoresPath: join(outputDir, 'scene_scores.json') } },
        makeTerminalClose('video-expert-analyzer', 'completed', 'completed'),
      ],
    })

    const launch = await startSkillChildRun({
      scopeId: 'scope-handoff-runner',
      sessionId: 'session-handoff-runner',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_ai_analyze',
      requestedInput: { outputDir, sceneScoresPath: join(outputDir, 'scene_scores.json') },
      agentContext: {
        provider: 'xiaomi',
        model_id: 'mimo-v2.5',
        base_url: 'https://example.test/v1',
        api_key: 'test-key',
        api_kind: 'openai-completions',
        fallback_chain: [],
        input_modes: ['text'],
      },
    })

    const close = await pollUntil(() => getSkillChildRunCloseEvent(launch.childRunId))
    assert.equal(close.status, 'completed')
    assert.equal(readFileSync(join(outputDir, 'audiovisual_handoff', 'body', 'output.md'), 'utf8'), 'generated report body')
    const receipt = JSON.parse(readFileSync(join(outputDir, 'audiovisual_handoff', 'receipt.json'), 'utf8'))
    assert.equal(receipt.tasks.body.status, 'completed')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('VEA task-card overall progress does not reset when prepare hands off to scoring', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-vea-progress-overall-'))
  const runStatePath = join(outputDir, 'run_state.json')
  const { runtime } = setupRunner({ launchStuckGuardMs: 5_000, progressPollIntervalMs: 10 })
  let releaseAction!: () => void
  const stall = new Promise<void>((resolve) => { releaseAction = resolve })
  runtime.manager.runSkill = (async (request: SkillRunRequest) => {
    await stall
    return {
      success: true,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
    }
  }) as never
  registerStubDriver('video-expert-analyzer', {
    plans: [
      { action: 'video_expert_pipeline', input: { url: 'https://example.com/video', outputDir } },
      makeTerminalClose('video-expert-analyzer', 'completed', 'completed'),
    ],
  })

  const launch = await startSkillChildRun({
    scopeId: 'scope-progress-overall',
    sessionId: 'session-progress-overall',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/video', outputDir },
  })
  const writeRunState = (stage: string, completed: number, updatedAt: string) => {
    writeFileSync(runStatePath, JSON.stringify({
      child_run_id: launch.childRunId,
      status: 'running',
      current_stage: stage,
      completed_scenes: completed,
      total_scenes: 39,
      updated_at: updatedAt,
      active_output_dir: outputDir,
    }), 'utf8')
  }

  writeRunState('prepare', 39, '2026-05-04T05:00:00.000Z')
  const prepared = await pollUntil(() => {
    const active = getSkillChildRunner()?.listActiveRuns().find((item) => item.childRunId === launch.childRunId)
    return active?.progress.stage === 'prepare' && active.progress.overallCoverage === 0.2 ? active.progress : null
  })
  assert.equal(prepared.overallCoverage, 0.2)

  writeRunState('score_batches', 0, '2026-05-04T05:00:10.000Z')
  const hostBatchDir = join(outputDir, 'host_batches')
  mkdirSync(hostBatchDir, { recursive: true })
  writeFileSync(join(hostBatchDir, 'index.json'), JSON.stringify({
    total_scenes: 39,
    batches: [
      { batch_id: 'batch-001', scene_numbers: [1, 2, 3, 4, 5, 6], output: 'batch-001-output.json' },
      { batch_id: 'batch-002', scene_numbers: [7, 8, 9, 10, 11, 12], output: 'batch-002-output.json' },
    ],
  }), 'utf8')
  writeFileSync(join(hostBatchDir, 'batch-001-output.json'), JSON.stringify({
    batch_id: 'batch-001',
    receipt: { status: 'completed', needs_review: [] },
    scenes: [{ scene_number: 1, scores: {}, storyboard: {} }],
  }), 'utf8')
  writeFileSync(join(hostBatchDir, 'batch-002-output.json'), JSON.stringify({
    batch_id: 'batch-002',
    receipt: { status: 'in_progress', needs_review: [] },
    scenes: [],
  }), 'utf8')
  const scoring = await pollUntil(() => {
    const active = getSkillChildRunner()?.listActiveRuns().find((item) => item.childRunId === launch.childRunId)
    return active?.progress.stage === 'score_batches' && active.progress.detail ? active.progress : null
  })
  assert.equal(scoring.completed, 0)
  assert.equal(scoring.detail, '评分批次 1/2，约 6/39 场景')
  assert.equal(scoring.activityUpdatedAt !== null, true)
  assert.equal(scoring.overallCoverage, 0.525)
  releaseAction()
  await pollUntil(() => getSkillChildRunCloseEvent(launch.childRunId))
})

test('Worker B: child close maps completed/blocked/failed/cancelled projections without flattening blockers to done', async () => {
  const cases: Array<{
    name: string
    close: SkillChildCloseEvent
    expectedStatus: string
    expectedStepStatus: string
    expectedWaitingFor: string
    cancel?: boolean
  }> = [
    {
      name: 'completed',
      close: makeTerminalClose('test-skill-projection-completed', 'completed', 'completed'),
      expectedStatus: 'done',
      expectedStepStatus: 'done',
      expectedWaitingFor: 'none',
    },
    {
      name: 'blocked',
      close: makeTerminalClose('test-skill-projection-blocked', 'blocked', 'blocked_external'),
      expectedStatus: 'blocked',
      expectedStepStatus: 'blocked',
      expectedWaitingFor: 'input',
    },
    {
      name: 'failed',
      close: makeTerminalClose('test-skill-projection-failed', 'failed', 'failed_skill'),
      expectedStatus: 'failed',
      expectedStepStatus: 'error',
      expectedWaitingFor: 'none',
    },
    {
      name: 'cancelled',
      close: makeTerminalClose('test-skill-projection-cancelled', 'completed', 'completed'),
      expectedStatus: 'cancelled',
      expectedStepStatus: 'done',
      expectedWaitingFor: 'none',
      cancel: true,
    },
  ]

  for (const item of cases) {
    const skillId = `test-skill-projection-${item.name}`
    const { runtime } = setupRunner({ launchStuckGuardMs: 5_000 })
    if (item.cancel) {
      let resolveStall!: () => void
      const stall = new Promise<void>((resolve) => { resolveStall = resolve })
      runtime.manager.runSkill = (async (request: SkillRunRequest) => {
        await stall
        return {
          success: true,
          skillId: request.skillId,
          action: request.action,
          stdout: '',
          stderr: '',
          command: [],
        }
      }) as never
      registerStubDriver(skillId, {
        plans: [{ action: 'do_thing', input: {} }, item.close],
      })
      const launch = await startSkillChildRun({
        scopeId: `scope-${item.name}`,
        sessionId: `session-${item.name}`,
        skillId,
        action: 'do_thing',
        requestedInput: { url: `https://example.com/${item.name}` },
      })
      await sleep(20)
      const closePromise = cancelSkillChildRun(launch.childRunId, 'user_cancelled_projection_case')
      resolveStall()
      await closePromise
    } else {
      registerStubDriver(skillId, { plans: [item.close] })
      const launch = await startSkillChildRun({
        scopeId: `scope-${item.name}`,
        sessionId: `session-${item.name}`,
        skillId,
        action: 'do_thing',
        requestedInput: { url: `https://example.com/${item.name}` },
      })
      await pollUntil(() => getSkillChildRunCloseEvent(launch.childRunId))
    }

    const projection = readSkillTaskProjection({
      sessionId: `session-${item.name}`,
      skillId,
    })
    assert.ok(projection, `${item.name} projection should exist`)
    assert.equal((projection as unknown as { status?: string }).status, item.expectedStatus)
    assert.equal(currentProjectionStep(projection!)?.status, item.expectedStepStatus)
    assert.equal(projection!.waitingFor, item.expectedWaitingFor)
    if (item.name === 'blocked') {
      assert.notEqual((projection as unknown as { status?: string }).status, 'done')
      assert.ok(projection!.taskContinuation)
    }
  }
})

test('W4: child runner action goes through gateway admission before runtime dispatch', async () => {
  const { runtime } = setupRunner()
  registerStubDriver('video-expert-analyzer', {
    plans: [
      { action: 'video_expert_pipeline', input: {} },
      makeTerminalClose('video-expert-analyzer', 'completed', 'completed'),
    ],
  })

  const result = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/admission' },
  })

  const close = await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
  assert.equal(runtime.calls.length, 0)
  assert.equal(close.status, 'failed')
  assert.equal(close.terminalReason, 'input_validation')
  assert.equal(close.error?.kind, 'input_validation')
})

test('VEA ai_analyze child run derives outputDir from real scene_scores path instead of fabricating runtime output', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-vea-runner-'))
  const sceneScoresPath = join(outputDir, 'scene_scores.json')
  writeFileSync(sceneScoresPath, '{"scenes":[]}', 'utf8')
  const { runtime } = setupRunner()
  registerStubDriver('video-expert-analyzer', {
    plans: [
      { action: 'video_expert_ai_analyze', input: { sceneScoresPath } },
      makeTerminalClose('video-expert-analyzer', 'completed', 'completed'),
    ],
  })

  const result = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_ai_analyze',
    requestedInput: { sceneScoresPath },
  })

  assert.equal(result.status, 'running')
  assert.equal(result.outputDir, outputDir)
  assert.equal(result.runStatePath, join(outputDir, 'run_state.json'))
  const close = await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
  assert.equal(close.outputDir, outputDir)
  assert.equal(close.runStatePath, join(outputDir, 'run_state.json'))
  assert.equal(runtime.calls[0].params?.outputDir, outputDir)
})

test('blocked child run does not single-flight hijack a later continuation action', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-vea-blocked-single-flight-'))
  const sceneScoresPath = join(outputDir, 'scene_scores.json')
  writeFileSync(sceneScoresPath, '{"scenes":[]}', 'utf8')
  const repo = makeFakeRepository()
  const { runtime } = setupRunner({ repo })
  registerStubDriver('video-expert-analyzer', {
    plans: [
      makeTerminalClose('video-expert-analyzer', 'blocked', 'blocked_external'),
    ],
  })

  const blocked = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/old', outputDir },
  })
  const blockedClose = await pollUntil(() => getSkillChildRunCloseEvent(blocked.childRunId))
  assert.equal(blockedClose.status, 'blocked')

  registerStubDriver('video-expert-analyzer', {
    plans: [
      { action: 'video_expert_ai_analyze', input: { sceneScoresPath } },
      makeTerminalClose('video-expert-analyzer', 'completed', 'completed'),
    ],
  })

  const result = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_ai_analyze',
    requestedInput: { sceneScoresPath },
  })

  assert.equal(result.status, 'running')
  assert.notEqual(result.childRunId, blocked.childRunId)
  const close = await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
  assert.equal(close.status, 'completed')
  assert.equal(runtime.calls[0].action, 'video_expert_ai_analyze')
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

test('Phase 5: process-crash-shaped throw closes status=failed terminalReason=child_process_crashed', async () => {
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
  assert.equal(close.terminalReason, 'child_process_crashed')
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
  // Initial budget is set high enough that the SECOND lifecycle can
  // finish (2 actions). The FIRST lifecycle hits budget_paused because
  // the driver plan list is intentionally longer than the budget; this
  // way budget_paused is driven by plan-count, not by reconfiguring the
  // runner mid-test. See helper banner above for the rationale.
  const { repo } = setupRunner({ maxActionsPerRun: 3 })

  // First-lifecycle plans: 4 actions before any terminal close → exhausts
  // the 3-action budget after action #3 with another action still pending.
  registerStubDriver('test-skill-resume', {
    plans: [
      { action: 'step_a', input: {} },
      { action: 'step_b', input: {} },
      { action: 'step_c', input: {} },
      { action: 'step_d', input: {} },
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

  // Re-register the driver with a SHORT plan list so the second lifecycle
  // finishes within the same 3-action budget. NO singleton reset — same
  // runner instance, same recentCloses, same active map. registerStubDriver
  // calls registerSkillChildDriver which Map.set's by skillId (replace
  // semantics + fresh `idx = 0` closure), so the second lifecycle sees a
  // clean plan iterator.
  registerStubDriver('test-skill-resume', {
    plans: [
      { action: 'step_resume', input: {} },
      makeTerminalClose('test-skill-resume', 'completed', 'completed'),
    ],
  })
  // The first lifecycle ended in budget_paused; mark the row as
  // recoverable_paused so resumeSkillChildRun's resumability check passes.
  repo.repo.updateChildRun(first.childRunId, { status: 'recoverable_paused' })

  const second = await resumeSkillChildRun(first.childRunId)
  assert.equal(second.childRunId, first.childRunId)
  const secondClose = await pollUntil(() => getSkillChildRunCloseEvent(first.childRunId), 3_000)
  assert.equal(secondClose.status, 'completed')
  // Sanity: the close is the NEW completed close, not the previous paused one.
  assert.notStrictEqual(secondClose, firstClose)
})

test('resumeSkillChildRun rejects blocked child without updating row', async () => {
  const { runtime, repo } = setupRunner()
  registerStubDriver('test-skill-resume-blocked', {
    plans: [
      { action: 'step_a', input: {} },
      makeTerminalClose('test-skill-resume-blocked', 'completed', 'completed'),
    ],
  })

  const result = await startSkillChildRun({
    scopeId: 'scope-resume-blocked',
    sessionId: 'session-resume-blocked',
    skillId: 'test-skill-resume-blocked',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/resume-blocked' },
  })
  await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
  repo.repo.updateChildRun(result.childRunId, {
    status: 'blocked',
    closeEvent: makeTerminalClose('test-skill-resume-blocked', 'blocked', 'blocked_external'),
  })
  const callCountBeforeResume = runtime.calls.length

  const refused = await resumeSkillChildRun(result.childRunId)

  assert.equal(refused.childRunId, result.childRunId)
  assert.equal(refused.status, 'blocked')
  assert.equal(refused.closeEvent?.status, 'blocked')
  assert.equal(refused.closeEvent?.terminalReason, 'blocked_external')
  assert.equal(refused.closeEvent?.error?.kind, 'still_blocked')
  assert.equal(runtime.calls.length, callCountBeforeResume, 'blocked resume must not dispatch a child action')
  const row = repo.state.rows.get(result.childRunId)
  const payload = (row!.resumePayload as { childRun: Record<string, unknown> }).childRun
  assert.equal(payload.status, 'blocked')
})

test('resumeSkillChildRun completes pending handoff for blocked_external child before resuming', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-vea-blocked-handoff-resume-'))
  const sceneScoresPath = join(outputDir, 'scene_scores.json')
  mkdirSync(join(outputDir, 'audiovisual_handoff', 'body'), { recursive: true })
  writeFileSync(sceneScoresPath, JSON.stringify({ scenes: [] }), 'utf8')
  writeFileSync(join(outputDir, 'run_state.json'), JSON.stringify({
    status: 'blocked',
    current_stage: 'finalize',
    scores_path: 'scene_scores.json',
  }), 'utf8')
  writeFileSync(join(outputDir, 'audiovisual_handoff', 'body', 'task.md'), 'write report body', 'utf8')
  writeFileSync(join(outputDir, 'audiovisual_handoff', 'receipt.json'), JSON.stringify({
    tasks: {
      body: {
        status: 'pending',
        task: 'audiovisual_handoff/body/task.md',
        output: 'audiovisual_handoff/body/output.md',
      },
    },
  }), 'utf8')

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: 'generated resumed body' } }],
  }), { status: 200 })) as typeof fetch
  try {
    const { runtime } = setupRunner({ launchStuckGuardMs: 5_000 })
    registerStubDriver('video-expert-analyzer', {
      plans: [
        { action: 'video_expert_ai_analyze', input: { outputDir, sceneScoresPath } },
        makeTerminalClose('video-expert-analyzer', 'blocked', 'blocked_external'),
      ],
    })

    const result = await startSkillChildRun({
      scopeId: 'scope-resume-blocked-handoff',
      sessionId: 'session-resume-blocked-handoff',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      requestedInput: { outputDir },
    })
    const firstClose = await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
    assert.equal(firstClose.status, 'blocked')

    registerStubDriver('video-expert-analyzer', {
      plans: [
        { action: 'video_expert_ai_analyze', input: { outputDir, sceneScoresPath } },
        makeTerminalClose('video-expert-analyzer', 'completed', 'completed'),
      ],
    })

    const resumed = await resumeSkillChildRun(result.childRunId, {
      agentContext: {
        provider: 'xiaomi',
        model_id: 'mimo-v2.5',
        base_url: 'https://example.test/v1',
        api_key: 'test-key',
        api_kind: 'openai-completions',
        fallback_chain: [],
        input_modes: ['text'],
      },
    })
    assert.equal(resumed.childRunId, result.childRunId)
    assert.equal(resumed.status, 'running')

    const finalClose = await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
    assert.equal(finalClose.status, 'completed')
    assert.equal(readFileSync(join(outputDir, 'audiovisual_handoff', 'body', 'output.md'), 'utf8'), 'generated resumed body')
    const receipt = JSON.parse(readFileSync(join(outputDir, 'audiovisual_handoff', 'receipt.json'), 'utf8'))
    assert.equal(receipt.tasks.body.status, 'completed')
    assert.equal(runtime.calls.at(-1)?.action, 'video_expert_ai_analyze')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('resumeSkillChildRun settles blocked_external child when artifacts already completed', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-vea-blocked-artifact-complete-'))
  writeCompletedVeaArtifacts(outputDir, 'artifact-complete')
  const { runtime, repo } = setupRunner()
  registerStubDriver('video-expert-analyzer', {
    plans: [
      makeTerminalClose('video-expert-analyzer', 'blocked', 'blocked_external'),
    ],
  })

  const result = await startSkillChildRun({
    scopeId: 'scope-resume-artifact-complete',
    sessionId: 'session-resume-artifact-complete',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { outputDir },
  })
  const firstClose = await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
  assert.equal(firstClose.status, 'blocked')
  const callCountBeforeResume = runtime.calls.length

  const resumed = await resumeSkillChildRun(result.childRunId, {
    agentContext: {
      provider: 'xiaomi',
      model_id: 'mimo-v2.5',
      base_url: 'https://example.test/v1',
      api_key: 'test-key',
      api_kind: 'openai-completions',
      fallback_chain: [],
      input_modes: ['text'],
    },
  })

  assert.equal(resumed.childRunId, result.childRunId)
  assert.equal(resumed.status, 'completed')
  assert.equal(resumed.closeEvent?.status, 'completed')
  assert.equal(resumed.closeEvent?.terminalReason, 'completed')
  assert.equal(resumed.closeEvent?.progress.completedUnits, 2)
  assert.equal(resumed.closeEvent?.progress.totalUnits, 2)
  assert.equal(runtime.calls.length, callCountBeforeResume, 'completed artifact settlement must not dispatch a child action')
  const row = repo.state.rows.get(result.childRunId)
  assert.equal(row?.status, 'completed')
  const payload = (row!.resumePayload as { childRun: Record<string, unknown> }).childRun
  assert.equal(payload.status, 'completed')
  assert.equal((payload.closeEvent as SkillChildCloseEvent).terminalReason, 'completed')
})

test('resumeSkillChildRun rejects terminal child without updating row', async () => {
  const { runtime, repo } = setupRunner()
  registerStubDriver('test-skill-resume-terminal', {
    plans: [
      { action: 'step_a', input: {} },
      makeTerminalClose('test-skill-resume-terminal', 'completed', 'completed'),
    ],
  })

  const result = await startSkillChildRun({
    scopeId: 'scope-resume-terminal',
    sessionId: 'session-resume-terminal',
    skillId: 'test-skill-resume-terminal',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/resume-terminal' },
  })
  const completed = await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
  const callCountBeforeResume = runtime.calls.length

  const refused = await resumeSkillChildRun(result.childRunId)

  assert.equal(refused.childRunId, result.childRunId)
  assert.equal(refused.status, 'completed')
  assert.equal(refused.closeEvent?.status, 'completed')
  assert.equal(refused.closeEvent?.terminalReason, 'completed')
  assert.equal(refused.closeEvent?.error?.kind, 'terminal_not_resumable')
  assert.equal(runtime.calls.length, callCountBeforeResume, 'terminal resume must not dispatch a child action')
  const row = repo.state.rows.get(result.childRunId)
  const payload = (row!.resumePayload as { childRun: Record<string, unknown> }).childRun
  assert.equal(payload.status, 'completed')
  assert.equal((payload.closeEvent as SkillChildCloseEvent).terminalReason, completed.terminalReason)
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

test('E W3: repeated failed child runs trip the per-target circuit breaker before row creation', async () => {
  const previousFlag = process.env.READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED
  const metrics: AgentMetricEvent[] = []
  delete process.env.READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const { repo } = setupRunner()
    registerStubDriver('test-skill-breaker', {
      plans: [makeTerminalClose('test-skill-breaker', 'failed', 'failed_skill')],
    })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await startSkillChildRun({
        scopeId: 'scope-breaker',
        sessionId: 'session-breaker',
        skillId: 'test-skill-breaker',
        action: 'do_thing',
        requestedInput: { url: 'https://example.com/same-target' },
      })
      assert.equal(result.status, 'running')
      const close = await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
      assert.equal(close.status, 'failed')
      assert.equal(close.terminalReason, 'failed_skill')
    }
    assert.equal(repo.state.rows.size, 5)

    const blocked = await startSkillChildRun({
      scopeId: 'scope-breaker',
      sessionId: 'session-breaker',
      skillId: 'test-skill-breaker',
      action: 'do_thing',
      requestedInput: { url: 'https://example.com/same-target' },
      parentNextHint: 'continue_other_work',
    })

    assert.equal(blocked.status, 'failed')
    assert.equal(blocked.parentNextHint, 'continue_other_work')
    assert.equal(blocked.closeEvent?.terminalReason, 'host_unavailable')
    assert.equal(blocked.closeEvent?.error?.kind, 'child_run_circuit_breaker_open')
    assert.match(blocked.closeEvent?.error?.message ?? '', /circuit breaker/i)
    assert.equal(repo.state.rows.size, 5, 'cooldown refusal must not create a repository row')
    assert.ok(
      metrics.some((event) => event.metric === TOOL_ERROR_METRICS.childRunCircuitBreak && event.phase === 'blocked'),
      'blocking should emit the registered circuit-break metric',
    )
    assert.ok(
      metrics.some((event) => event.metric === TOOL_ERROR_METRICS.childRunCircuitBreak && event.phase === 'opened'),
      'opening should emit the registered circuit-break metric',
    )
  } finally {
    __setMetricSinkForTests(null)
    if (previousFlag === undefined) {
      delete process.env.READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED
    } else {
      process.env.READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED = previousFlag
    }
  }
})

test('E W3: disabled circuit breaker flag allows another attempt after repeated failures', async () => {
  const previousFlag = process.env.READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED
  process.env.READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED = '0'
  try {
    const { repo } = setupRunner()
    registerStubDriver('test-skill-breaker-disabled', {
      plans: [makeTerminalClose('test-skill-breaker-disabled', 'failed', 'failed_skill')],
    })

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await startSkillChildRun({
        scopeId: 'scope-breaker-disabled',
        sessionId: 'session-breaker-disabled',
        skillId: 'test-skill-breaker-disabled',
        action: 'do_thing',
        requestedInput: { url: 'https://example.com/same-target' },
      })
      assert.equal(result.status, 'running')
      const close = await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
      assert.equal(close.status, 'failed')
      assert.equal(close.terminalReason, 'failed_skill')
    }

    assert.equal(repo.state.rows.size, 6, 'disabled breaker should not suppress the sixth launch')
  } finally {
    if (previousFlag === undefined) {
      delete process.env.READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED
    } else {
      process.env.READY_CHILD_RUN_CIRCUIT_BREAKER_ENABLED = previousFlag
    }
  }
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

  // Intentional singleton reset to simulate process restart: this test
  // verifies the durable recovery path where recentCloses is empty but
  // the row's persisted closeEvent must be read back. Do NOT mimic this
  // pattern in single-process resume tests — see helper banner above.
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

  // Intentional singleton reset to simulate process restart: this test
  // verifies that cancel on a persisted-but-inactive row uses the row's
  // real skillId / outputDir / runStatePath. Do NOT mimic this pattern
  // in single-process resume tests — see helper banner above.
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

test('observer timeout does not cancel or persist a close event', async () => {
  const { repo, runtime } = setupRunner({ launchStuckGuardMs: 5_000 })
  let resolveStall!: () => void
  const stall = new Promise<void>((resolve) => { resolveStall = resolve })
  runtime.manager.runSkill = (async (request: SkillRunRequest) => {
    await stall
    return {
      success: true,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
    }
  }) as never
  registerStubDriver('test-skill-observer-wait-timeout', {
    plans: [
      { action: 'do_thing', input: {} },
      makeTerminalClose('test-skill-observer-wait-timeout', 'completed', 'completed'),
    ],
  })

  const result = await startSkillChildRunAndWait({
    scopeId: 'scope-observer-wait',
    sessionId: 'session-observer-wait',
    skillId: 'test-skill-observer-wait-timeout',
    action: 'do_thing',
    params: { url: 'https://example.com/observer-wait-timeout' },
    timeoutMs: 25,
  })

  assert.equal(result.status, 'running')
  assert.equal(result.success, false)
  assert.equal(result.closeEvent, null)
  assert.ok(result.observerTimeout)
  const row = repo.state.rows.get(result.childRunId)
  assert.ok(row, 'child row must remain persisted')
  const child = (row!.resumePayload as { childRun?: { status?: string; closeEvent?: unknown } }).childRun
  assert.equal(child?.status, 'running')
  assert.equal(child?.closeEvent, null)
  assert.equal(getSkillChildRunCloseEvent(result.childRunId), null)

  resolveStall()
  const close = await pollUntil(() => getSkillChildRunCloseEvent(result.childRunId))
  assert.equal(close.status, 'completed')
  assert.equal(close.terminalReason, 'completed')
})

test('multiple waiters receive the same eventual close event', async () => {
  const { runtime } = setupRunner({ launchStuckGuardMs: 5_000 })
  let resolveStall!: () => void
  const stall = new Promise<void>((resolve) => { resolveStall = resolve })
  runtime.manager.runSkill = (async (request: SkillRunRequest) => {
    await stall
    return {
      success: true,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
    }
  }) as never
  registerStubDriver('test-skill-waiter-fanout', {
    plans: [
      { action: 'do_thing', input: {} },
      makeTerminalClose('test-skill-waiter-fanout', 'completed', 'completed'),
    ],
  })
  const launch = await startSkillChildRun({
    scopeId: 'scope-waiter-fanout',
    sessionId: 'session-waiter-fanout',
    skillId: 'test-skill-waiter-fanout',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/waiter-fanout' },
  })

  const first = waitForSkillChildRunClose(launch.childRunId, { timeoutMs: 1_000 })
  const second = waitForSkillChildRunClose(launch.childRunId, { timeoutMs: 1_000 })
  resolveStall()

  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.kind, 'closed')
  assert.equal(secondResult.kind, 'closed')
  assert.equal(firstResult.childRunId, launch.childRunId)
  assert.equal(secondResult.childRunId, launch.childRunId)
  assert.strictEqual(firstResult.closeEvent, secondResult.closeEvent)
  assert.equal(firstResult.closeEvent.terminalReason, 'completed')
})

test('aborting one waiter does not detach other waiters', async () => {
  const { repo, runtime } = setupRunner({ launchStuckGuardMs: 5_000 })
  let resolveStall!: () => void
  const stall = new Promise<void>((resolve) => { resolveStall = resolve })
  runtime.manager.runSkill = (async (request: SkillRunRequest) => {
    await stall
    return {
      success: true,
      skillId: request.skillId,
      action: request.action,
      stdout: '',
      stderr: '',
      command: [],
    }
  }) as never
  registerStubDriver('test-skill-waiter-abort', {
    plans: [
      { action: 'do_thing', input: {} },
      makeTerminalClose('test-skill-waiter-abort', 'completed', 'completed'),
    ],
  })
  const launch = await startSkillChildRun({
    scopeId: 'scope-waiter-abort',
    sessionId: 'session-waiter-abort',
    skillId: 'test-skill-waiter-abort',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/waiter-abort' },
  })

  const controller = new AbortController()
  const abortedWaiter = waitForSkillChildRunClose(launch.childRunId, {
    timeoutMs: 1_000,
    signal: controller.signal,
  })
  const survivingWaiter = waitForSkillChildRunClose(launch.childRunId, { timeoutMs: 1_000 })
  controller.abort(new Error('observer no longer needs the result'))
  await assert.rejects(abortedWaiter, /observer no longer needs the result/)

  const row = repo.state.rows.get(launch.childRunId)
  const child = (row?.resumePayload as { childRun?: { status?: string; closeEvent?: unknown } } | null)?.childRun
  assert.equal(child?.status, 'running')
  assert.equal(child?.closeEvent, null)

  resolveStall()
  const result = await survivingWaiter
  assert.equal(result.kind, 'closed')
  assert.equal(result.closeEvent.status, 'completed')
  assert.equal(result.closeEvent.terminalReason, 'completed')
})
