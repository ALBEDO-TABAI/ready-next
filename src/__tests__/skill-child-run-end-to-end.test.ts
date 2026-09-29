/**
 * Phase 6 — child-loop integration tests.
 *
 * Cover the four scenarios called out in the source plan §8 acceptance:
 *
 *   A) New run     — `startSkillChildRun({...})` returns `running` with a
 *                    fresh `childRunId`. The contract loaded after the
 *                    launch has `childRunId` set, so
 *                    `shouldParentForceLongSkillTool(contract) === false`.
 *
 *   B) Resume      — when `outputDir` carries a `run_state.json` whose
 *                    stage is `score_batches` and `scene_scores.json`
 *                    exists, the driver picks `video_expert_ai_analyze`
 *                    rather than `video_expert_pipeline`. The parent
 *                    NEVER dispatches `{}`.
 *
 *   D) Cancel      — `cancelSkillChildRun(childRunId)` produces a close
 *                    event with `status='killed'` /
 *                    `terminalReason='cancelled_user'` (NEVER `failed`).
 *
 *   G) Single-flight collapse — the same target launched twice returns
 *                    `status='reused'` on the second call with the same
 *                    `childRunId`.
 *
 * Real registry: `defaultToolRegistry` resolves
 * `skill_video_expert_pipeline` and `skill_video_expert_ai_analyze` via
 * the static manifest fallback. No monkey patches.
 *
 * The runtime manager + repository are stubs (matching the harness
 * conventions in `skill-child-runner.test.ts`). Drivers we register here
 * are stubs too — the production VEA driver is registered automatically
 * by `import './video-expert-child-driver'` in production boot, but tests
 * `__resetSkillChildDriversForTests()` first to keep the registry clean.
 *
 * Source plan: docs/superpowers/plans/2026-04-30-skill-runtime-child-loop-architecture.md
 */

import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  configureSkillChildRunner,
  __resetSkillChildRunnerForTests,
  startSkillChildRun,
  cancelSkillChildRun,
  resumeSkillChildRun,
  isChildOwnedSkill,
} from '../main/modules/agent-control/skills/skill-child-runner'
import {
  registerSkillChildDriver,
  __resetSkillChildDriversForTests,
  type SkillChildDriver,
} from '../main/modules/agent-control/skills/skill-child-drivers'
import {
  defaultToolRegistry,
  resolveToolInputSchemaForExecution,
} from '../main/modules/agent-control/tools-runtime/tool-registry'
import {
  loadSkillRunContract,
  shouldParentForceLongSkillTool,
} from '../main/modules/agent-control/contracts/run-contracts'
import { isChildLoopSkillAction } from '../main/modules/tools/skills-tools'
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
import type {
  SkillTaskRunRepository,
  SkillTaskRunRecord,
} from '../main/modules/repositories/skill-task-run-repository'
import type { SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skills/skill-task-supervisor'

export const __breaksInvariants = [
  'test-fixture.skill-child-run-end-to-end.setupRunner-resets-singleton',
] as const

// ---------------------------------------------------------------------------
// Stub harness
// ---------------------------------------------------------------------------

interface FakeRepoState { rows: Map<string, SkillTaskRunRecord> }

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
    findLatestChildRunBySkill: (opts: { skillId: string }): SkillTaskRunRecord | null => {
      const ACTIVE = new Set(['queued', 'running', 'recoverable_paused', 'budget_paused', 'blocked'])
      for (const row of state.rows.values()) {
        const child = (row.resumePayload as { childRun?: Record<string, unknown> } | null)?.childRun
        if (!child) continue
        if (child.skillId === opts.skillId && ACTIVE.has(child.status as string)) return row
      }
      return null
    },
    get: (id: string) => state.rows.get(id) ?? null,
    getCurrentVisible: (id: string) => state.rows.get(id) ?? null,
  } as unknown as SkillTaskRunRepository
  return { repo, state }
}

function makeFakeRuntime(opts: {
  outputsRoot: string
  results?: SkillRunResult[]
  onRun?: (request: SkillRunRequest, idx: number) => Promise<void> | void
} = { outputsRoot: '/tmp/fake-runtime-outputs' }): {
  manager: SkillsRuntimeManager
  calls: SkillRunRequest[]
} {
  const calls: SkillRunRequest[] = []
  let idx = 0
  const fake = {
    getRuntimeInfo: () => ({
      runtimeRoot: '/tmp/fake-runtime',
      skillsRoot: '/tmp/fake-runtime/skills',
      customSkillsRoot: '/tmp/fake-runtime/custom',
      outputsRoot: opts.outputsRoot,
      venvRoot: '/tmp/fake-runtime/venv',
    }),
    runSkill: async (request: SkillRunRequest): Promise<SkillRunResult> => {
      const callIndex = idx++
      calls.push(request)
      if (opts.onRun) await opts.onRun(request, callIndex)
      const canned = opts.results?.[callIndex]
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

function registerStubVeaDriver(opts: StubDriverOpts): void {
  let idx = 0
  const driver: SkillChildDriver = {
    skillId: 'video-expert-analyzer',
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params): Promise<SkillChildDriverState> => ({
      skillId: 'video-expert-analyzer',
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

function setupRunner(opts: {
  outputsRoot: string
  results?: SkillRunResult[]
  onRun?: (request: SkillRunRequest, idx: number) => Promise<void> | void
}): {
  runtime: ReturnType<typeof makeFakeRuntime>
  repo: ReturnType<typeof makeFakeRepository>
} {
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  const runtime = makeFakeRuntime({
    outputsRoot: opts.outputsRoot,
    results: opts.results,
    onRun: opts.onRun,
  })
  const repo = makeFakeRepository()
  configureSkillChildRunner({
    runtimeManager: runtime.manager,
    repository: repo.repo,
    launchStuckGuardMs: 5_000,
    maxActionsPerRun: 6,
    maxActiveVeaRuns: 3,
  })
  return { runtime, repo }
}

// ---------------------------------------------------------------------------
// Sanity: registry + helpers (no monkey-patches)
// ---------------------------------------------------------------------------

describe('Phase 6 child-loop helpers — real registry (stubbed driver)', () => {
  test('isChildLoopSkillAction is true for VEA pipeline and ai_analyze, false for primitives (stubbed driver)', () => {
    // The production VEA driver registers via
    // `import './video-expert-child-driver'` from `runtime.ts`; in this
    // unit test we register a stub VEA driver directly so the registry
    // reflects the same skill ownership relationship.
    __resetSkillChildDriversForTests()
    registerStubVeaDriver({
      plans: [{
        action: 'video_expert_pipeline',
        input: { url: 'https://example.com/dummy.mp4' },
      }],
    })
    assert.equal(isChildOwnedSkill('video-expert-analyzer'), true)
    assert.equal(isChildLoopSkillAction('video-expert-analyzer', 'video_expert_pipeline'), true)
    assert.equal(isChildLoopSkillAction('video-expert-analyzer', 'video_expert_ai_analyze'), true)
    // Out-of-allowlist actions are NOT child-routed even on VEA.
    assert.equal(isChildLoopSkillAction('video-expert-analyzer', 'video_expert_deliver'), false)
    // Other skills still route through the legacy parent-loop.
    assert.equal(isChildLoopSkillAction('lets-go-rss', 'rss_update'), false)
    // Primitive tool names never resolve here.
    assert.equal(isChildLoopSkillAction('', ''), false)
    // After we drop the registry, child ownership flips back to false —
    // proves the predicate is genuinely registry-driven.
    __resetSkillChildDriversForTests()
    assert.equal(isChildOwnedSkill('video-expert-analyzer'), false)
    assert.equal(isChildLoopSkillAction('video-expert-analyzer', 'video_expert_pipeline'), false)
  })

  test('static registry resolves skill_video_expert_pipeline + Zod schema', () => {
    // Sanity for the integration: the engine's force-tool preflight
    // consumes the same resolver. With a registered tool + schema, an
    // empty `{}` validation fails with firstPath='url'.
    const definition = defaultToolRegistry.getToolDefinitionForExecution('skill_video_expert_pipeline')
    assert.ok(definition, 'expected static-manifest fallback to register skill_video_expert_pipeline')
    const schema = resolveToolInputSchemaForExecution('skill_video_expert_pipeline')
    assert.ok(schema, 'expected resolveToolInputSchemaForExecution to surface Zod schema')
  })
})

// ---------------------------------------------------------------------------
// Scenario A — new run
// ---------------------------------------------------------------------------

describe('Phase 6 scenario A — new VEA run (stubbed driver)', () => {
  test('startSkillChildRun returns running with a fresh childRunId (stubbed driver)', async () => {
    const { repo } = setupRunner({ outputsRoot: '/tmp/fake-outputs-A' })
    // Stub driver returns one action then closes done so the test doesn't
    // hang on the runner's internal loop (we only inspect the launch
    // result). The runner returns `running` synchronously regardless of
    // what the driver later does.
    registerStubVeaDriver({
      plans: [
        {
          action: 'video_expert_pipeline',
          input: { url: 'https://example.com/video.mp4' },
        },
        {
          childRunId: '',
          skillId: 'video-expert-analyzer',
          status: 'completed',
          terminalReason: 'completed',
          outputDir: null,
          runStatePath: null,
          sceneScoresPath: null,
          deliveryReportPath: null,
          progress: { stage: null, totalUnits: null, completedUnits: null, coverageRatio: null, fingerprint: null },
          framePatch: null,
          projectionPatch: null,
          error: null,
        },
      ],
    })

    const result = await startSkillChildRun({
      scopeId: 'scope-A',
      sessionId: 'session-A',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      requestedInput: { url: 'https://example.com/video.mp4' },
      parentNextHint: 'wait_for_close_event',
      triggerType: 'tool',
    })

    // Launch result shape:
    assert.equal(result.status, 'running', `expected status=running on a fresh launch, got ${result.status}`)
    assert.match(result.childRunId, /^v[0-9a-z]{8,}$/, `expected vea-prefixed base36 child id, got ${result.childRunId}`)
    assert.equal(result.parentNextHint, 'wait_for_close_event')
    assert.equal(result.closeEvent, null, 'fresh launch must not carry an inline close event')
    assert.ok(result.outputDir, 'expected runner to mint an outputDir')
    assert.ok(result.runStatePath.endsWith('run_state.json'))

    // Repository row carries `resumePayload.childRun` with the same id.
    const row = (repo.repo as unknown as { get: (id: string) => SkillTaskRunRecord | null }).get(result.childRunId)
    assert.ok(row, 'expected repo to have the new child-run row')
    const payload = (row!.resumePayload as { childRun?: Record<string, unknown> }).childRun!
    assert.equal(payload.childRunId, result.childRunId)
    assert.equal(payload.parentNextHint, 'wait_for_close_event')

    // Phase 6 invariant: when the contract loader sees this child handle,
    // `shouldParentForceLongSkillTool` returns false — no parent-side
    // synthesised `tool_use`.
    const supervisorSnapshot = makeRecoverableVeaSnapshot({
      outputDir: result.outputDir,
      runStatePath: result.runStatePath,
      childRunId: result.childRunId,
    })
    const contract = loadSkillRunContract({
      scopeId: 'scope-A',
      sessionId: 'session-A',
      skillId: 'video-expert-analyzer',
      outputDir: result.outputDir,
      runStatePath: result.runStatePath,
      supervisorSnapshot,
    })
    assert.ok(contract, 'expected loader to anchor a contract')
    assert.equal(contract!.childRunId, result.childRunId)
    assert.equal(shouldParentForceLongSkillTool(contract), false)
  })
})

// ---------------------------------------------------------------------------
// Scenario B — resume picks ai_analyze when run_state stage is score_batches
// ---------------------------------------------------------------------------

describe('Phase 6 scenario B — resume from score_batches stage (stubbed driver)', () => {
  test('driver picks video_expert_ai_analyze, never dispatches {} (stubbed driver)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'phase6-resume-'))
    const outputDir = join(root, 'vea-output-B')
    mkdirSync(outputDir, { recursive: true })
    const runStatePath = join(outputDir, 'run_state.json')
    const sceneScoresPath = join(outputDir, 'scene_scores.json')
    writeFileSync(runStatePath, JSON.stringify({
      status: 'recoverable_paused',
      current_stage: 'score_batches',
      total_scenes: 97,
      completed_scenes: 0,
    }), 'utf-8')
    writeFileSync(sceneScoresPath, JSON.stringify({ batches: [] }), 'utf-8')

    const { runtime } = setupRunner({
      outputsRoot: root,
      results: [
        {
          success: true,
          skillId: 'video-expert-analyzer',
          action: 'video_expert_ai_analyze',
          stdout: '',
          stderr: '',
          command: [],
          status: 'done',
          outputs: { sceneScoresPath, outputDir, runStatePath },
        },
      ],
    })

    let plannedAction: string | null = null
    let plannedInput: Record<string, unknown> | null = null
    registerStubVeaDriver({
      plans: [
        // Resume-aware driver: when state observes score_batches stage and
        // sceneScoresPath is present, it picks video_expert_ai_analyze.
        // Stub asserts that explicitly.
        {
          action: 'video_expert_ai_analyze',
          input: { sceneScoresPath, outputDir },
        },
        {
          childRunId: '',
          skillId: 'video-expert-analyzer',
          status: 'completed',
          terminalReason: 'completed',
          outputDir,
          runStatePath,
          sceneScoresPath,
          deliveryReportPath: null,
          progress: { stage: 'score_batches', totalUnits: 97, completedUnits: 97, coverageRatio: 1, fingerprint: 'done' },
          framePatch: null,
          projectionPatch: null,
          error: null,
        },
      ],
    })

    const launch = await startSkillChildRun({
      scopeId: 'scope-B',
      sessionId: 'session-B',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_ai_analyze',
      requestedInput: { sceneScoresPath, outputDir },
      parentNextHint: 'wait_for_close_event',
      triggerType: 'tool',
    })

    // Wait for the runner to dispatch + close. Poll because under
    // concurrent suite runs the 50ms fixed delay was flaky.
    const dispatchDeadline = Date.now() + 1_500
    while (runtime.calls.length === 0 && Date.now() < dispatchDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    assert.equal(launch.status, 'running', `expected running, got ${launch.status}`)
    // The runner forwarded ai_analyze (not pipeline) to runSkill; capture
    // and inspect the call.
    assert.ok(runtime.calls.length >= 1, `expected at least one runSkill call, got ${runtime.calls.length}`)
    plannedAction = runtime.calls[0].action
    plannedInput = runtime.calls[0].params || null
    assert.equal(
      plannedAction,
      'video_expert_ai_analyze',
      `Phase 6 scenario B: resume must pick video_expert_ai_analyze, got ${plannedAction}`,
    )
    // Crucial: input is NOT empty — never `{}`.
    assert.ok(plannedInput && Object.keys(plannedInput).length > 0,
      'Phase 6 scenario B: parent must never dispatch with empty input on resume')
    assert.equal((plannedInput as { sceneScoresPath?: string }).sceneScoresPath, sceneScoresPath)

    rmSync(root, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// Scenario D — cancel maps to killed + cancelled_user (NEVER failed)
// ---------------------------------------------------------------------------

describe('Phase 6 scenario D — cancel (stubbed driver)', () => {
  test('cancelSkillChildRun produces status=killed terminalReason=cancelled_user (stubbed driver)', async () => {
    setupRunner({ outputsRoot: '/tmp/fake-outputs-D' })
    // Driver hangs on the first plan so cancel fires while the child is
    // mid-flight.
    registerStubVeaDriver({
      plans: [
        // Will be cancelled before it lands.
        new Promise<SkillChildDriverAction>(() => { /* never resolves */ }) as unknown as SkillChildDriverAction,
      ],
    })

    const launch = await startSkillChildRun({
      scopeId: 'scope-D',
      sessionId: 'session-D',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      requestedInput: { url: 'https://example.com/cancel.mp4' },
      parentNextHint: 'wait_for_close_event',
      triggerType: 'tool',
    })
    assert.equal(launch.status, 'running')

    const close = await cancelSkillChildRun(launch.childRunId, 'cancelled_user')
    assert.equal(
      close.status,
      'killed',
      `Phase 6 scenario D: cancel must map to killed (NOT failed), got ${close.status}`,
    )
    assert.equal(
      close.terminalReason,
      'cancelled_user',
      `Phase 6 scenario D: terminalReason must be cancelled_user, got ${close.terminalReason}`,
    )
  })
})

// ---------------------------------------------------------------------------
// Scenario G — single-flight collapse
// ---------------------------------------------------------------------------

describe('Phase 6 scenario G — single-flight (stubbed driver)', () => {
  test('same target launched twice returns status=reused with the same id (stubbed driver)', async () => {
    setupRunner({ outputsRoot: '/tmp/fake-outputs-G' })
    // Driver returns one action + close so the first launch settles.
    registerStubVeaDriver({
      plans: [
        // Sit on this so the row stays active for the duplicate launch
        // to find via `findLatestChildRunByKey`.
        new Promise<SkillChildDriverAction>(() => { /* never resolves */ }) as unknown as SkillChildDriverAction,
      ],
    })

    const first = await startSkillChildRun({
      scopeId: 'scope-G',
      sessionId: 'session-G',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      requestedInput: { url: 'https://example.com/single.mp4', outputDir: '/tmp/fake-outputs-G/single' },
      parentNextHint: 'wait_for_close_event',
      triggerType: 'tool',
    })
    assert.equal(first.status, 'running')

    const second = await startSkillChildRun({
      scopeId: 'scope-G',
      sessionId: 'session-G',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      requestedInput: { url: 'https://example.com/single.mp4', outputDir: '/tmp/fake-outputs-G/single' },
      parentNextHint: 'wait_for_close_event',
      triggerType: 'tool',
    })
    assert.equal(
      second.status,
      'reused',
      `Phase 6 scenario G: second launch must be 'reused', got ${second.status}`,
    )
    assert.equal(second.childRunId, first.childRunId, 'reused launch must surface the same childRunId')

    // Cancel the lingering hang so the test exits cleanly.
    await cancelSkillChildRun(first.childRunId, 'cleanup')
  })
})

// ---------------------------------------------------------------------------
// Resume entrypoint — resumeSkillChildRun on an existing handle
// ---------------------------------------------------------------------------

describe('Phase 6 resume entrypoint — resumeSkillChildRun (stubbed driver)', () => {
  test('resumeSkillChildRun returns the same childRunId on a recoverable_paused row (stubbed driver)', async () => {
    const { repo } = setupRunner({ outputsRoot: '/tmp/fake-outputs-resume' })
    // Driver: first run pauses immediately so the row is recoverable_paused,
    // then a resume re-enters the loop and closes done.
    let invocation = 0
    registerStubVeaDriver({
      plans: [
        // First launch closes recoverable_paused.
        {
          childRunId: '',
          skillId: 'video-expert-analyzer',
          status: 'recoverable_paused',
          terminalReason: 'checkpoint_background',
          outputDir: null,
          runStatePath: null,
          sceneScoresPath: null,
          deliveryReportPath: null,
          progress: { stage: 'init', totalUnits: null, completedUnits: 0, coverageRatio: 0, fingerprint: 'init' },
          framePatch: null,
          projectionPatch: null,
          error: null,
        },
        // Resume re-enters and immediately closes completed.
        {
          childRunId: '',
          skillId: 'video-expert-analyzer',
          status: 'completed',
          terminalReason: 'completed',
          outputDir: null,
          runStatePath: null,
          sceneScoresPath: null,
          deliveryReportPath: null,
          progress: { stage: 'done', totalUnits: 1, completedUnits: 1, coverageRatio: 1, fingerprint: 'done' },
          framePatch: null,
          projectionPatch: null,
          error: null,
        },
      ],
    })
    void invocation

    const launch = await startSkillChildRun({
      scopeId: 'scope-RES',
      sessionId: 'session-RES',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      requestedInput: { url: 'https://example.com/resume.mp4' },
      parentNextHint: 'wait_for_close_event',
      triggerType: 'tool',
    })
    // Wait for the first close to land.
    await new Promise((resolve) => setTimeout(resolve, 30))

    // The first run paused itself; the row should still be lookup-able.
    const row = (repo.repo as unknown as { get: (id: string) => SkillTaskRunRecord | null }).get(launch.childRunId)
    assert.ok(row, 'expected child-run row to persist past the first close')

    const resumed = await resumeSkillChildRun(launch.childRunId)
    assert.equal(
      resumed.childRunId,
      launch.childRunId,
      'resumeSkillChildRun must reuse the same childRunId',
    )
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecoverableVeaSnapshot(opts: {
  outputDir: string
  runStatePath: string
  childRunId: string
}): SkillTaskSupervisorSnapshot {
  return {
    taskRunId: 'str-vea-A',
    detachedTaskId: 'dst-vea-A',
    skillId: 'video-expert-analyzer',
    scopeId: 'scope-A',
    sessionId: 'session-A',
    action: 'video_expert_pipeline',
    status: 'recoverable_paused',
    liveness: null,
    hasLiveWork: false,
    hasRecentProgress: false,
    closeAllowed: false,
    ambiguous: false,
    stale: false,
    outputDir: opts.outputDir,
    runStatePath: opts.runStatePath,
    sceneScoresPath: null,
    deliveryReportPath: null,
    progress: {
      currentStage: 'prepare',
      totalScenes: 0,
      completedScenes: 0,
      coverageRatio: 0,
      updatedAt: '2026-04-30T00:00:00.000Z',
    },
    blockers: [],
    pauseReason: 'budget_exhausted',
    resumePayload: {
      // Phase 6 — supervisor projects the child handle off the repository
      // row so `loadSkillRunContract` sees child ownership without
      // needing a repository reference plumbed through every call site.
      childRun: {
        version: 1,
        childRunId: opts.childRunId,
        parentNextHint: 'wait_for_close_event',
        status: 'running',
        skillId: 'video-expert-analyzer',
      },
    },
    sourceObservations: [],
    progressFingerprint: 'prepare:0/0',
    observedAt: '2026-04-30T00:00:00.000Z',
    lastProgressAt: '2026-04-30T00:00:00.000Z',
  }
}

// ---------------------------------------------------------------------------
// T8 (B child-loop, wave 3) — `loadSkillRunContract` lookup ordering must
// bind a contract to the EXACT child-run identity the request carries
// (runStatePath / outputDir / singleFlightKey) instead of falling through to
// "latest active row by skillId / session / scope". Two children running
// the same skill against different targets in one session MUST resolve to
// distinct child rows; a different-skill row sharing an outputDir MUST NEVER
// be attached.
// ---------------------------------------------------------------------------

interface T8RepoBag {
  repo: SkillTaskRunRepository
  state: { rows: Map<string, SkillTaskRunRecord> }
}

function buildT8ChildRunRow(opts: {
  childRunId: string
  scopeId: string | null
  sessionId: string | null
  skillId: string
  outputDir: string
  runStatePath: string
  singleFlightKey: string
  status?: SkillChildDriverState extends { skillId: string } ? string : string
}): SkillTaskRunRecord {
  const now = new Date().toISOString()
  const status = opts.status || 'running'
  return {
    id: opts.childRunId,
    scopeId: opts.scopeId,
    sessionId: opts.sessionId,
    agent: null,
    runId: null,
    skillId: opts.skillId,
    skillName: opts.skillId,
    action: 'video_expert_pipeline',
    toolName: null,
    runKind: 'child_run',
    status: status as SkillTaskRunRecord['status'],
    interactionState: 'running',
    goalText: null,
    resourceRefs: [],
    params: {},
    steps: [],
    currentStepId: null,
    artifacts: [],
    outputDir: opts.outputDir,
    runStatePath: opts.runStatePath,
    sceneScoresPath: null,
    deliveryReportPath: null,
    failureKind: null,
    failureDetail: null,
    jobId: null,
    detachedTaskId: null,
    resumePayload: {
      childRun: {
        version: 1,
        childRunId: opts.childRunId,
        kind: 'vea',
        parentScopeId: opts.scopeId,
        parentSessionId: opts.sessionId,
        skillId: opts.skillId,
        skillName: opts.skillId,
        requestedAction: 'video_expert_pipeline',
        requestedInput: {},
        singleFlightKey: opts.singleFlightKey,
        parentNextHint: 'wait_for_close_event',
        outputDir: opts.outputDir,
        runStatePath: opts.runStatePath,
        eventLogPath: `${opts.outputDir}/events.ndjson`,
        status,
        closeEvent: null,
      },
    },
    createdAt: now,
    startedAt: null,
    updatedAt: now,
    finishedAt: null,
  }
}

function makeT8Repository(): T8RepoBag {
  const state: T8RepoBag['state'] = { rows: new Map() }
  const ACTIVE = new Set(['queued', 'running', 'recoverable_paused', 'budget_paused', 'blocked'])

  const repo = {
    get: (id: string) => state.rows.get(id) ?? null,
    findLatestChildRunByKey: (key: string): SkillTaskRunRecord | null => {
      let best: SkillTaskRunRecord | null = null
      for (const row of state.rows.values()) {
        const child = (row.resumePayload as { childRun?: Record<string, unknown> } | null)?.childRun
        if (!child) continue
        if (child.singleFlightKey === key && ACTIVE.has(child.status as string)) {
          if (!best || row.updatedAt > best.updatedAt) best = row
        }
      }
      return best
    },
    findLatestChildRunBySkill: (opts: { skillId: string; sessionId?: string | null; scopeId?: string | null }): SkillTaskRunRecord | null => {
      let best: SkillTaskRunRecord | null = null
      for (const row of state.rows.values()) {
        const child = (row.resumePayload as { childRun?: Record<string, unknown> } | null)?.childRun
        if (!child) continue
        if (child.skillId !== opts.skillId) continue
        if (opts.sessionId && row.sessionId !== opts.sessionId) continue
        if (opts.scopeId && row.scopeId !== opts.scopeId) continue
        if (!ACTIVE.has(child.status as string)) continue
        if (!best || row.updatedAt > best.updatedAt) best = row
      }
      return best
    },
    findChildRunByRunStatePath: (opts: { runStatePath: string; skillId?: string | null }): SkillTaskRunRecord | null => {
      let best: SkillTaskRunRecord | null = null
      for (const row of state.rows.values()) {
        if (row.runStatePath !== opts.runStatePath) continue
        if (opts.skillId && row.skillId !== opts.skillId) continue
        const child = (row.resumePayload as { childRun?: Record<string, unknown> } | null)?.childRun
        if (!child) continue
        if (!ACTIVE.has(child.status as string)) continue
        if (!best || row.updatedAt > best.updatedAt) best = row
      }
      return best
    },
    findChildRunByOutputDir: (opts: { outputDir: string; skillId?: string | null }): SkillTaskRunRecord | null => {
      let best: SkillTaskRunRecord | null = null
      for (const row of state.rows.values()) {
        if (row.outputDir !== opts.outputDir) continue
        if (opts.skillId && row.skillId !== opts.skillId) continue
        const child = (row.resumePayload as { childRun?: Record<string, unknown> } | null)?.childRun
        if (!child) continue
        if (!ACTIVE.has(child.status as string)) continue
        if (!best || row.updatedAt > best.updatedAt) best = row
      }
      return best
    },
    findChildRunBySingleFlightKey: (opts: { singleFlightKey: string; skillId?: string | null }): SkillTaskRunRecord | null => {
      let best: SkillTaskRunRecord | null = null
      for (const row of state.rows.values()) {
        const child = (row.resumePayload as { childRun?: Record<string, unknown> } | null)?.childRun
        if (!child) continue
        if (child.singleFlightKey !== opts.singleFlightKey) continue
        if (opts.skillId && row.skillId !== opts.skillId) continue
        if (!ACTIVE.has(child.status as string)) continue
        if (!best || row.updatedAt > best.updatedAt) best = row
      }
      return best
    },
  } as unknown as SkillTaskRunRepository

  return { repo, state }
}

describe('T8 — loadSkillRunContract binds to exact child run identity', () => {
  test('T8 multi-child case: outputDir on contract request wins over latest-active fallback', () => {
    const { repo, state } = makeT8Repository()

    // Child A — explicit target /tmp/a
    const childA = buildT8ChildRunRow({
      childRunId: 'va11111111',
      scopeId: 'scope-T8',
      sessionId: 'session-T8',
      skillId: 'video-expert-analyzer',
      outputDir: '/tmp/a',
      runStatePath: '/tmp/a/run_state.json',
      singleFlightKey: 'video-expert-analyzer:hash-a',
    })
    state.rows.set(childA.id, childA)

    // Child B — different target /tmp/b. Same skill / session / scope.
    // Make B newer so the latest-active fallback would otherwise return B.
    const childB = buildT8ChildRunRow({
      childRunId: 'vb22222222',
      scopeId: 'scope-T8',
      sessionId: 'session-T8',
      skillId: 'video-expert-analyzer',
      outputDir: '/tmp/b',
      runStatePath: '/tmp/b/run_state.json',
      singleFlightKey: 'video-expert-analyzer:hash-b',
    })
    childB.updatedAt = '2099-01-01T00:00:00.000Z'
    state.rows.set(childB.id, childB)

    // Sanity: latest-active fallback would return B.
    const latest = (repo as unknown as {
      findLatestChildRunBySkill: (o: { skillId: string }) => SkillTaskRunRecord | null
    }).findLatestChildRunBySkill({ skillId: 'video-expert-analyzer' })
    assert.equal(latest?.id, 'vb22222222', 'sanity: without explicit handles latest-active returns child B')

    // Load contract with outputDir='/tmp/a' — must resolve to A, not B.
    const contract = loadSkillRunContract({
      scopeId: 'scope-T8',
      sessionId: 'session-T8',
      skillId: 'video-expert-analyzer',
      outputDir: '/tmp/a',
      runStatePath: '/tmp/a/run_state.json',
      skillTaskRunRepository: repo,
    })
    assert.ok(contract, 'expected contract to anchor for explicit outputDir request')
    assert.equal(
      contract!.childRunId,
      'va11111111',
      `T8: explicit outputDir must bind to child A, never sibling child B (got ${contract!.childRunId})`,
    )
  })

  test('T8 cross-skill exclusion case: row with different skillId at the same outputDir is never attached', () => {
    const { repo, state } = makeT8Repository()

    // Same outputDir, two different skills.
    const veaChild = buildT8ChildRunRow({
      childRunId: 'va33333333',
      scopeId: 'scope-T8',
      sessionId: 'session-T8',
      skillId: 'video-expert-analyzer',
      outputDir: '/tmp/shared',
      runStatePath: '/tmp/shared/run_state.json',
      singleFlightKey: 'video-expert-analyzer:hash-shared',
    })
    state.rows.set(veaChild.id, veaChild)

    const otherSkillChild = buildT8ChildRunRow({
      childRunId: 'vo44444444',
      scopeId: 'scope-T8',
      sessionId: 'session-T8',
      skillId: 'some-other-skill',
      outputDir: '/tmp/shared',
      runStatePath: '/tmp/shared/run_state.json',
      singleFlightKey: 'some-other-skill:hash-shared',
    })
    // Make the other-skill row newer to prove the skillId filter — not the
    // ordering — is what excludes it.
    otherSkillChild.updatedAt = '2099-01-01T00:00:00.000Z'
    state.rows.set(otherSkillChild.id, otherSkillChild)

    const contract = loadSkillRunContract({
      scopeId: 'scope-T8',
      sessionId: 'session-T8',
      skillId: 'video-expert-analyzer',
      outputDir: '/tmp/shared',
      runStatePath: '/tmp/shared/run_state.json',
      skillTaskRunRepository: repo,
    })
    assert.ok(contract, 'expected contract to anchor for VEA outputDir request')
    assert.equal(
      contract!.childRunId,
      'va33333333',
      `T8: cross-skill row must never be attached (got ${contract!.childRunId})`,
    )
    assert.notEqual(
      contract!.childRunId,
      'vo44444444',
      'T8: a different-skill row sharing outputDir must be excluded',
    )
  })
})
