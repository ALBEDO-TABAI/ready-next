/**
 * Phase 5 — Skill Child Runner runtime-decision tests.
 *
 *   - MAX_ACTIVE_VEA_CHILD_RUNS = 3 (4th launch returns
 *     `recoverable_paused` + `terminalReason='queued_global_concurrency'`).
 *   - launch-stuck: child writes `started` but no `action_started`
 *     within the guard window → `terminalReason='launch_stuck'`.
 *   - skill-declared failure (`success: false`) vs infra throw
 *     (process crash) split between `failed_skill` and `child_process_crashed`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  configureSkillChildRunner,
  startSkillChildRun,
  getSkillChildRunCloseEvent,
  __resetSkillChildRunnerForTests,
  MAX_ACTIVE_VEA_CHILD_RUNS,
} from '../main/modules/agent-control/skill-child-runner'
import {
  registerSkillChildDriver,
  __resetSkillChildDriversForTests,
  type SkillChildDriver,
} from '../main/modules/agent-control/skill-child-drivers'
import type {
  SkillChildCloseEvent,
  SkillChildDriverAction,
} from '../main/modules/agent-control/skill-child-run-types'
import type {
  SkillRunResult,
  SkillRunRequest,
  SkillsRuntimeManager,
} from '../main/modules/skills-runtime/runtime-manager'
import type {
  SkillTaskRunRecord,
  SkillTaskRunRepository,
} from '../main/modules/repositories/skill-task-run-repository'

// --------- Fakes ---------

function makeFakeRepository(): SkillTaskRunRepository {
  const rows = new Map<string, SkillTaskRunRecord>()
  return {
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
      rows.set(input.childRunId, record)
      return record
    },
    updateChildRun: (childRunId: string, patch: Record<string, unknown>) => {
      const existing = rows.get(childRunId)
      if (!existing) return
      const payload = (existing.resumePayload as { childRun: Record<string, unknown> }).childRun
      const merged = { ...payload, ...patch }
      existing.resumePayload = { childRun: merged }
      if (typeof patch.status === 'string') existing.status = patch.status as SkillTaskRunRecord['status']
    },
    findLatestChildRunByKey: (key: string) => {
      const ACTIVE = new Set(['queued', 'running', 'recoverable_paused', 'budget_paused', 'blocked'])
      for (const row of rows.values()) {
        const child = (row.resumePayload as { childRun?: Record<string, unknown> } | null)?.childRun
        if (!child) continue
        if (child.singleFlightKey === key && ACTIVE.has(child.status as string)) return row
      }
      return null
    },
    findLatestChildRunBySkill: () => null,
    get: (id: string) => rows.get(id) ?? null,
  } as unknown as SkillTaskRunRepository
}

function makeStallingRuntime(): SkillsRuntimeManager {
  let resolveStall!: () => void
  const stall = new Promise<void>((r) => { resolveStall = r })
  ;(globalThis as Record<string, unknown>).__rt_resolve = resolveStall
  return {
    getRuntimeInfo: () => ({
      runtimeRoot: '/tmp/fake', skillsRoot: '/tmp/fake/s',
      customSkillsRoot: '/tmp/fake/c', outputsRoot: '/tmp/fake/o',
      venvRoot: '/tmp/fake/v',
    }),
    runSkill: async (_req: SkillRunRequest): Promise<SkillRunResult> => {
      await stall
      return { success: true, skillId: '', action: '', stdout: '', stderr: '', command: [] }
    },
  } as unknown as SkillsRuntimeManager
}

function registerLooping(skillId: string): void {
  const driver: SkillChildDriver = {
    skillId,
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params) => ({ skillId, requestedInput: params.requestedInput }),
    planNextAction: async (state): Promise<SkillChildDriverAction | SkillChildCloseEvent> => ({
      action: 'video_expert_pipeline',
      input: state.requestedInput as Record<string, unknown>,
    }),
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

// --------- Tests ---------

test('Phase 5: VEA concurrency cap — 4th run returns recoverable_paused + queued_global_concurrency', async () => {
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  configureSkillChildRunner({
    runtimeManager: makeStallingRuntime(),
    repository: makeFakeRepository(),
    launchStuckGuardMs: 60_000, // don't trip
  })
  registerLooping('video-expert-analyzer')

  const launches = []
  for (let i = 0; i < MAX_ACTIVE_VEA_CHILD_RUNS; i++) {
    launches.push(await startSkillChildRun({
      scopeId: `scope-${i}`,
      sessionId: `session-${i}`,
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      requestedInput: { url: `https://example.com/${i}` },
    }))
  }
  for (const result of launches) {
    assert.equal(result.status, 'running')
  }

  // Yield briefly so the runner registers each active run.
  await new Promise((r) => setTimeout(r, 10))

  const overflow = await startSkillChildRun({
    scopeId: 'scope-overflow',
    sessionId: 'session-overflow',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/overflow' },
  })
  assert.equal(overflow.status, 'recoverable_paused')
  assert.ok(overflow.closeEvent)
  assert.equal(overflow.closeEvent!.terminalReason, 'queued_global_concurrency')
})

test('Phase 5: launch-stuck — started but no action_started within guard window', async () => {
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  configureSkillChildRunner({
    runtimeManager: makeStallingRuntime(),
    repository: makeFakeRepository(),
    launchStuckGuardMs: 50,
  })
  // Driver that never returns an action plan — keeps planNextAction
  // hanging so the runner records `started` but never reaches
  // `action_started`.
  let resolveDriver!: () => void
  const stall = new Promise<void>((r) => { resolveDriver = r })
  registerSkillChildDriver({
    skillId: 'test-skill-stuck',
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params) => ({ skillId: 'test-skill-stuck', requestedInput: params.requestedInput }),
    planNextAction: async () => {
      await stall
      return { action: 'do_thing', input: {} } as SkillChildDriverAction
    },
    observeAfterAction: async (state) => state,
  })
  const launch = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId: 'test-skill-stuck',
    action: 'do_thing',
    requestedInput: { url: 'https://example.com/stuck' },
  })

  const close = await pollUntil(() => getSkillChildRunCloseEvent(launch.childRunId), 1_500)
  assert.equal(close.terminalReason, 'launch_stuck')
  // Now release the driver so the test can exit cleanly.
  resolveDriver()
})

test('Phase 5: skill_failure (success:false) vs process crash throw split correctly', async () => {
  // Skill-declared failure
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  configureSkillChildRunner({
    runtimeManager: {
      getRuntimeInfo: () => ({
        runtimeRoot: '/tmp/fake', skillsRoot: '/tmp/fake/s',
        customSkillsRoot: '/tmp/fake/c', outputsRoot: '/tmp/fake/o',
        venvRoot: '/tmp/fake/v',
      }),
      runSkill: async (): Promise<SkillRunResult> => ({
        success: false,
        skillId: 'test-skill-split',
        action: 'do_thing',
        stdout: '',
        stderr: '',
        command: [],
        error: 'skill said no',
      }),
    } as unknown as SkillsRuntimeManager,
    repository: makeFakeRepository(),
    launchStuckGuardMs: 5_000,
  })
  registerLooping('video-expert-analyzer')
  const a = await startSkillChildRun({
    scopeId: 'scope-1',
    sessionId: 'session-1',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/a' },
  })
  const closeA = await pollUntil(() => getSkillChildRunCloseEvent(a.childRunId))
  assert.equal(closeA.terminalReason, 'failed_skill')

  // Infra throw (process crash shape)
  __resetSkillChildRunnerForTests()
  __resetSkillChildDriversForTests()
  configureSkillChildRunner({
    runtimeManager: {
      getRuntimeInfo: () => ({
        runtimeRoot: '/tmp/fake', skillsRoot: '/tmp/fake/s',
        customSkillsRoot: '/tmp/fake/c', outputsRoot: '/tmp/fake/o',
        venvRoot: '/tmp/fake/v',
      }),
      runSkill: async () => {
        throw new Error('child process crashed (signal SIGKILL)')
      },
    } as unknown as SkillsRuntimeManager,
    repository: makeFakeRepository(),
    launchStuckGuardMs: 5_000,
  })
  registerLooping('video-expert-analyzer')
  const b = await startSkillChildRun({
    scopeId: 'scope-2',
    sessionId: 'session-2',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/b' },
  })
  const closeB = await pollUntil(() => getSkillChildRunCloseEvent(b.childRunId))
  assert.equal(closeB.terminalReason, 'child_process_crashed')
})

// =====================================================================
// Legacy status leakage guards (T2)
//
// Lock the adapter edge between the legacy `DetachedSkillTaskStatus` set
// (`running / done / cancelled / failed / blocked`) and the typed public
// supervisor vocabulary so a future change cannot silently reintroduce
// `background_running` / `done` / `cancelled` into a snapshot returned
// from `makeSupervisorSnapshotForContract` or its callers.
// =====================================================================

import { __skillsToolsInternalsForTests } from '../main/modules/tools/skills-tools'
import type { SkillTaskSupervisorStatus, SkillTaskSupervisorLiveness } from '../main/modules/agent-control/skill-task-supervisor'

const PUBLIC_SUPERVISOR_STATUS_VALUES: ReadonlySet<SkillTaskSupervisorStatus> = new Set<SkillTaskSupervisorStatus>([
  'running',
  'completed',
  'killed',
  'failed',
  'blocked',
  'recoverable_paused',
  'budget_paused',
  'unknown',
])

const LEGACY_STATUS_LEAK_VALUES = ['background_running', 'done', 'cancelled'] as const

const LEGACY_DETACHED_STATUSES = ['running', 'done', 'cancelled', 'failed', 'blocked'] as const

test('T2 guard — detachedStatusToSupervisorStatus maps the entire legacy set into the public union (no legacy leakage)', () => {
  const { detachedStatusToSupervisorStatus } = __skillsToolsInternalsForTests
  for (const legacy of LEGACY_DETACHED_STATUSES) {
    const mapped = detachedStatusToSupervisorStatus(legacy)
    assert.ok(
      PUBLIC_SUPERVISOR_STATUS_VALUES.has(mapped),
      `mapped status for legacy='${legacy}' must be in public union; got '${mapped}'`,
    )
    for (const leak of LEGACY_STATUS_LEAK_VALUES) {
      assert.notEqual(
        mapped as string, leak,
        `mapped status for legacy='${legacy}' must not be legacy '${leak}'`,
      )
    }
  }
})

test('T2 guard — cancellation maps to killed (NOT failed) — explicit assertion', () => {
  const { detachedStatusToSupervisorStatus } = __skillsToolsInternalsForTests
  const mapped = detachedStatusToSupervisorStatus('cancelled')
  assert.equal(mapped, 'killed')
  assert.notEqual(mapped as string, 'failed',
    'cancellation must NEVER collapse to `failed` (source plan §3 rule 7)')
  assert.notEqual(mapped as string, 'cancelled',
    'cancellation must be normalized to `killed`, never left as legacy `cancelled`')
})

test('T2 guard — done maps to completed; running maps to running (no legacy passthrough)', () => {
  const { detachedStatusToSupervisorStatus } = __skillsToolsInternalsForTests
  assert.equal(detachedStatusToSupervisorStatus('done'), 'completed')
  assert.notEqual(detachedStatusToSupervisorStatus('done') as string, 'done')
  assert.equal(detachedStatusToSupervisorStatus('running'), 'running')
  // failed / blocked are 1:1 (still in the public union).
  assert.equal(detachedStatusToSupervisorStatus('failed'), 'failed')
  assert.equal(detachedStatusToSupervisorStatus('blocked'), 'blocked')
})

test('T2 guard — detachedStatusToLiveness only sets background for live work, null otherwise', () => {
  const { detachedStatusToLiveness } = __skillsToolsInternalsForTests
  const validLiveness: ReadonlySet<SkillTaskSupervisorLiveness> = new Set<SkillTaskSupervisorLiveness>([
    'foreground',
    'background',
    null,
  ])
  for (const legacy of LEGACY_DETACHED_STATUSES) {
    const liveness = detachedStatusToLiveness(legacy)
    assert.ok(
      validLiveness.has(liveness),
      `liveness for legacy='${legacy}' must be in {foreground, background, null}; got '${String(liveness)}'`,
    )
  }
  // `running` is the only status that should produce `background` here —
  // the adapter's whole job is to preserve liveness while the supervisor
  // status loses the `background_running` channel.
  assert.equal(detachedStatusToLiveness('running'), 'background')
  for (const terminalLike of ['done', 'cancelled', 'failed', 'blocked'] as const) {
    assert.equal(detachedStatusToLiveness(terminalLike), null)
  }
})

test('T2 guard — makeSupervisorSnapshotForContract: liveness is populated when status === running', () => {
  const { makeSupervisorSnapshotForContract, detachedStatusToSupervisorStatus, detachedStatusToLiveness } = __skillsToolsInternalsForTests
  // Drive the helper through the same legacy → public adapter the production
  // call sites use, so any future change that drops `liveness` from the
  // path will fail this guard.
  const status = detachedStatusToSupervisorStatus('running')
  const liveness = detachedStatusToLiveness('running')
  const snapshot = makeSupervisorSnapshotForContract({
    skillId: 'test-skill-liveness-guard',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    action: 'video_expert_pipeline',
    status,
    liveness,
    detachedTaskId: 'detached-1',
  })
  assert.equal(snapshot.status, 'running')
  // Liveness completeness: when status is running, the snapshot must
  // surface a non-null liveness so consumers can distinguish foreground
  // from background work (the old `background_running` channel was
  // removed; this contract replaces it).
  assert.notEqual(snapshot.liveness, null,
    'liveness must be populated when status === running')
  assert.equal(snapshot.liveness, 'background')
})

test('T2 guard — makeSupervisorSnapshotForContract: legacy-string status inputs are rejected by the typed surface', () => {
  // The helper's TS signature constrains `status` to the public union;
  // this guard documents that the only legitimate way to feed it is via
  // the adapter. The runtime test just verifies the public union is
  // accepted and the produced fields stay typed — `background_running`
  // / `done` / `cancelled` are not callable inputs (TypeScript rejects
  // them at compile time; the typecheck step in CI is the second leg of
  // this guard).
  const { makeSupervisorSnapshotForContract } = __skillsToolsInternalsForTests
  for (const status of PUBLIC_SUPERVISOR_STATUS_VALUES) {
    const snapshot = makeSupervisorSnapshotForContract({
      skillId: 'test-skill-public-union',
      status,
      liveness: status === 'running' ? 'background' : null,
    })
    assert.equal(snapshot.status, status)
    for (const leak of LEGACY_STATUS_LEAK_VALUES) {
      assert.notEqual(snapshot.status as string, leak,
        `snapshot.status must never be legacy '${leak}' for any public input`)
    }
  }
})
