/**
 * Phase 4 — legacy → child-run migration acceptance tests.
 *
 * `loadSkillRunContract` must:
 *   1. Surface `legacyAdoptableHandles` when a legacy supervisor row has at
 *      least one of `outputDir` / `runStatePath` (so Phase 5 can mint a
 *      child run that adopts the legacy state).
 *   2. NEVER silently mark a legacy row `completed` when neither handle is
 *      present — instead pin to `recoverable_paused` and surface
 *      `blockerReason: 'no_usable_handles'`.
 *   3. Continue to work after Phase 5 explicitly adopts a legacy row by
 *      writing a child-run record (loader picks up the child handle
 *      instead of falling back to legacy adoption fields).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  loadSkillRunContract,
  type TaskProjectionRecord,
} from '../main/modules/agent-control/run-contracts'
import type { SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skills/skill-task-supervisor'
import { createSkillChildRunId } from '../main/modules/agent-control/skills/skill-child-run-id'
import type { SkillChildRunPayload } from '../main/modules/agent-control/skills/skill-child-run-types'
import type {
  SkillTaskRunRecord,
  SkillTaskRunRepository,
} from '../main/modules/repositories/skill-task-run-repository'

function makeSnapshot(
  overrides: Partial<SkillTaskSupervisorSnapshot> = {},
): SkillTaskSupervisorSnapshot {
  return {
    taskRunId: overrides.taskRunId ?? 'str-legacy-1',
    detachedTaskId: overrides.detachedTaskId ?? null,
    skillId: overrides.skillId ?? 'video-expert-analyzer',
    scopeId: overrides.scopeId ?? 'scope-legacy',
    sessionId: overrides.sessionId ?? 'session-legacy',
    action: overrides.action ?? 'video_expert_pipeline',
    status: overrides.status ?? 'recoverable_paused',
    liveness: overrides.liveness ?? null,
    hasLiveWork: overrides.hasLiveWork ?? false,
    hasRecentProgress: overrides.hasRecentProgress ?? false,
    closeAllowed: overrides.closeAllowed ?? false,
    ambiguous: overrides.ambiguous ?? false,
    stale: overrides.stale ?? false,
    outputDir: overrides.outputDir ?? null,
    runStatePath: overrides.runStatePath ?? null,
    sceneScoresPath: overrides.sceneScoresPath ?? null,
    deliveryReportPath: overrides.deliveryReportPath ?? null,
    progress: overrides.progress ?? {
      currentStage: null,
      totalScenes: null,
      completedScenes: null,
      coverageRatio: null,
      updatedAt: null,
    },
    blockers: overrides.blockers ?? [],
    pauseReason: overrides.pauseReason ?? null,
    resumePayload: overrides.resumePayload ?? null,
    sourceObservations: overrides.sourceObservations ?? [],
    progressFingerprint: overrides.progressFingerprint ?? null,
    observedAt: overrides.observedAt ?? '2026-04-30T01:00:00.000Z',
    lastProgressAt: overrides.lastProgressAt ?? null,
  }
}

/** Test-only fake repository — only `findLatestChildRunBySkill` is exercised. */
function makeFakeRepository(active: SkillTaskRunRecord | null): SkillTaskRunRepository {
  const fake = {
    findLatestChildRunBySkill: () => active,
  }
  return fake as unknown as SkillTaskRunRepository
}

test('Phase 4: legacy row with outputDir + runStatePath surfaces legacyAdoptableHandles', () => {
  const snapshot = makeSnapshot({
    outputDir: '/tmp/legacy-output',
    runStatePath: '/tmp/legacy-output/run_state.json',
  })
  const contract = loadSkillRunContract({
    skillId: 'video-expert-analyzer',
    supervisorSnapshot: snapshot,
    skillTaskRunRepository: makeFakeRepository(null),
  })
  assert.ok(contract, 'expected a contract for a legacy row with handles')
  assert.equal(contract!.outputDir, '/tmp/legacy-output')
  assert.equal(contract!.runStatePath, '/tmp/legacy-output/run_state.json')
  assert.deepEqual(contract!.legacyAdoptableHandles, {
    taskRunId: 'str-legacy-1',
    outputDir: '/tmp/legacy-output',
    runStatePath: '/tmp/legacy-output/run_state.json',
  })
  // Without a usable handle blocker, blockerReason should NOT be set.
  assert.equal(contract!.blockerReason, undefined)
  // No child-run row → no childRunId.
  assert.equal(contract!.childRunId, undefined)
})

test('Phase 4: legacy row with neither handle pins to recoverable_paused with blockerReason', () => {
  const snapshot = makeSnapshot({
    status: 'running', // wide-open running snapshot, but no usable handles
    outputDir: null,
    runStatePath: null,
  })
  const contract = loadSkillRunContract({
    skillId: 'video-expert-analyzer',
    supervisorSnapshot: snapshot,
    skillTaskRunRepository: makeFakeRepository(null),
  })
  assert.ok(contract, 'expected a contract anchored by skillId + taskRunId')
  // Loader MUST NOT silently complete this row.
  assert.notEqual(contract!.status, 'completed')
  // Pinned to recoverable_paused per Phase 4 rule.
  assert.equal(contract!.status, 'recoverable_paused')
  assert.equal(contract!.blockerReason, 'no_usable_handles')
  assert.equal(contract!.blocker.reason, 'no_usable_handles')
  assert.equal(contract!.legacyAdoptableHandles, undefined)
})

test('Phase 4: terminal legacy row is NOT silently re-completed by the loader', () => {
  const snapshot = makeSnapshot({
    status: 'failed',
    outputDir: null,
    runStatePath: null,
  })
  const contract = loadSkillRunContract({
    skillId: 'video-expert-analyzer',
    supervisorSnapshot: snapshot,
    skillTaskRunRepository: makeFakeRepository(null),
  })
  assert.ok(contract)
  // Terminal failed must remain failed; loader does not weaken or change it.
  assert.equal(contract!.status, 'failed')
  // No usable handle override applies to terminal rows.
  assert.equal(contract!.blockerReason, undefined)
})

test('Phase 7: cancellation surfaces as killed, NOT failed (status normalization rule)', () => {
  // Source plan §3 rule 7 — `cancelled` MUST map to `killed`, never to
  // `failed`. Supervisor's public surface uses the new vocabulary; the
  // contract loader must preserve `killed` end-to-end.
  const snapshot = makeSnapshot({
    status: 'killed',
    blockers: ['user cancelled the run'],
    outputDir: '/tmp/legacy-output',
    runStatePath: '/tmp/legacy-output/run_state.json',
  })
  const contract = loadSkillRunContract({
    skillId: 'video-expert-analyzer',
    supervisorSnapshot: snapshot,
    skillTaskRunRepository: makeFakeRepository(null),
  })
  assert.ok(contract)
  // Contract status MUST be 'killed' — NEVER collapsed to 'failed'.
  assert.equal(contract!.status, 'killed', 'cancellation must NOT map to failed')
  assert.notEqual(contract!.status, 'failed')
})

test('Phase 7: two skills sharing one outputDir do not supersede each other', () => {
  // Source plan §8 Scenario H — at the contract layer, two child runs on
  // the same outputDir should produce different `childRunId` handles. A
  // VEA child run and an "other" skill child run never alias.
  const veaChildRunId = createSkillChildRunId('vea')
  const otherChildRunId = createSkillChildRunId('skill')
  assert.notEqual(veaChildRunId, otherChildRunId, 'distinct child-run ids')

  const veaPayload: SkillChildRunPayload = {
    version: 1,
    childRunId: veaChildRunId,
    kind: 'vea',
    parentScopeId: 'scope-shared',
    parentSessionId: 'session-shared',
    skillId: 'video-expert-analyzer',
    skillName: 'VEA',
    requestedAction: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/v1' },
    singleFlightKey: 'k1',
    parentNextHint: 'wait_for_close_event',
    outputDir: '/tmp/shared',
    runStatePath: '/tmp/shared/run_state.json',
    eventLogPath: '/tmp/shared/.ready/child-runs/v.jsonl',
    status: 'running',
    closeEvent: null,
    legacy: { taskRunId: null, detachedTaskId: null, projectionTaskId: null },
  }
  const veaRow: SkillTaskRunRecord = {
    id: veaChildRunId,
    scopeId: 'scope-shared',
    sessionId: 'session-shared',
    agent: null,
    runId: null,
    skillId: 'video-expert-analyzer',
    skillName: 'VEA',
    action: 'video_expert_pipeline',
    toolName: null,
    runKind: 'child_run',
    status: 'running',
    interactionState: 'running',
    goalText: null,
    resourceRefs: [],
    params: veaPayload.requestedInput,
    steps: [],
    currentStepId: null,
    artifacts: [],
    outputDir: veaPayload.outputDir,
    runStatePath: veaPayload.runStatePath,
    sceneScoresPath: null,
    deliveryReportPath: null,
    failureKind: null,
    failureDetail: null,
    jobId: null,
    detachedTaskId: null,
    resumePayload: { childRun: veaPayload as unknown as Record<string, unknown> },
    createdAt: '2026-04-30T01:00:00.000Z',
    startedAt: '2026-04-30T01:00:00.000Z',
    updatedAt: '2026-04-30T01:00:00.000Z',
    finishedAt: null,
  }

  const veaContract = loadSkillRunContract({
    skillId: 'video-expert-analyzer',
    supervisorSnapshot: makeSnapshot({
      outputDir: '/tmp/shared',
      runStatePath: '/tmp/shared/run_state.json',
    }),
    skillTaskRunRepository: makeFakeRepository(veaRow),
  })
  // The "other skill" lookup yields null from the same shared outputDir
  // — distinct skillId never returns the VEA row.
  const otherContract = loadSkillRunContract({
    skillId: 'skill-other',
    supervisorSnapshot: makeSnapshot({
      skillId: 'skill-other',
      outputDir: '/tmp/shared',
      runStatePath: '/tmp/shared/run_state.json',
    }),
    // Repository returns null for skill-other — so the contract falls back
    // to legacyAdoptableHandles instead of inheriting VEA's child-run id.
    skillTaskRunRepository: makeFakeRepository(null),
  })

  assert.ok(veaContract)
  assert.ok(otherContract)
  assert.equal(veaContract!.childRunId, veaChildRunId)
  // Cross-skill non-supersede: skill-other's contract MUST NOT inherit
  // VEA's childRunId even though they share outputDir.
  assert.notEqual(otherContract!.childRunId, veaChildRunId)
  assert.equal(otherContract!.childRunId, undefined)
})

// =====================================================================
// T4 — Legacy row reconciliation (Case F)
//
// A legacy row that pre-existed from before this branch (status `running`
// in the DB but no in-memory runner alive, and no `closeEvent` persisted)
// must reconcile cleanly when the new runner observes it via
// `startSkillChildRun`. The acceptance: it must NOT be silently claimed
// as live (`status: 'reused'`); it must either resume durably or mark
// the row as `recoverable_paused` with `terminalReason='process_restarted'`.
// =====================================================================

import {
  configureSkillChildRunner as configureRunnerForCaseF,
  startSkillChildRun as startSkillChildRunForCaseF,
  __resetSkillChildRunnerForTests as resetRunnerForCaseF,
} from '../main/modules/agent-control/skills/skill-child-runner'
import {
  registerSkillChildDriver as registerDriverForCaseF,
  __resetSkillChildDriversForTests as resetDriversForCaseF,
  type SkillChildDriver as SkillChildDriverForCaseF,
} from '../main/modules/agent-control/skills/skill-child-drivers'
import type {
  SkillChildCloseEvent as SkillChildCloseEventForCaseF,
  SkillChildDriverAction as SkillChildDriverActionForCaseF,
} from '../main/modules/agent-control/skills/skill-child-run-types'
import type {
  SkillRunResult as SkillRunResultForCaseF,
  SkillsRuntimeManager as SkillsRuntimeManagerForCaseF,
  SkillRunRequest as SkillRunRequestForCaseF,
} from '../main/modules/skills-runtime/runtime-manager'

interface CaseFRepoState { rows: Map<string, SkillTaskRunRecord> }

function makeCaseFRepository(): { repo: SkillTaskRunRepository; state: CaseFRepoState } {
  const state: CaseFRepoState = { rows: new Map() }
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
      if (!existing) return
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

function makeCaseFRuntime(): SkillsRuntimeManagerForCaseF {
  let resolveStall!: () => void
  const stall = new Promise<void>((r) => { resolveStall = r })
  ;(globalThis as Record<string, unknown>).__casef_resolve = resolveStall
  return {
    getRuntimeInfo: () => ({
      runtimeRoot: '/tmp/casef', skillsRoot: '/tmp/casef/s',
      customSkillsRoot: '/tmp/casef/c', outputsRoot: '/tmp/casef/o',
      venvRoot: '/tmp/casef/v',
    }),
    runSkill: async (_request: SkillRunRequestForCaseF): Promise<SkillRunResultForCaseF> => {
      await stall
      return { success: true, skillId: '', action: '', stdout: '', stderr: '', command: [] }
    },
    runSkillFromChildRunner: async (request: SkillRunRequestForCaseF): Promise<SkillRunResultForCaseF> => {
      await stall
      return { success: true, skillId: request.skillId, action: request.action, stdout: '', stderr: '', command: [] }
    },
  } as unknown as SkillsRuntimeManagerForCaseF
}

function registerCaseFDriver(skillId: string): void {
  const driver: SkillChildDriverForCaseF = {
    skillId,
    canStart: () => true,
    canResume: () => true,
    createInitialState: async (params) => ({ skillId, requestedInput: params.requestedInput }),
    planNextAction: async (state): Promise<SkillChildDriverActionForCaseF | SkillChildCloseEventForCaseF> => ({
      action: 'video_expert_pipeline',
      input: state.requestedInput as Record<string, unknown>,
    }),
    observeAfterAction: async (state) => state,
  }
  registerDriverForCaseF(driver)
}

test('T4 Case F: legacy row pre-existing as running with missing close payload reconciles cleanly', async () => {
  const { repo } = makeCaseFRepository()
  resetRunnerForCaseF()
  resetDriversForCaseF()
  configureRunnerForCaseF({
    runtimeManager: makeCaseFRuntime(),
    repository: repo,
    launchStuckGuardMs: 60_000,
  })
  registerCaseFDriver('video-expert-analyzer')

  // Phase A — first runner mints a row with status `running`.
  const seeded = await startSkillChildRunForCaseF({
    scopeId: 'scope-legacy-recovery',
    sessionId: 'session-legacy-recovery',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/legacy-recovery' },
  })
  assert.equal(seeded.status, 'running')
  await new Promise((r) => setTimeout(r, 5))

  // Phase B — simulate process restart by tearing the runner down WITHOUT
  // touching the repository, then reconfigure with the same repo. The row
  // remains with status `running` but no in-memory runner is alive and
  // no closeEvent has been persisted.
  resetRunnerForCaseF()
  resetDriversForCaseF()
  configureRunnerForCaseF({
    runtimeManager: makeCaseFRuntime(),
    repository: repo,
    launchStuckGuardMs: 60_000,
  })
  registerCaseFDriver('video-expert-analyzer')

  // Confirm the legacy row is still in the repo with status 'running' AND
  // no closeEvent — this is the legacy shape the spec calls out.
  const seededRow = repo.get(seeded.childRunId)
  assert.ok(seededRow, 'legacy row must still be in the repository')
  assert.equal(seededRow!.status, 'running')

  // Phase C — startSkillChildRun for the SAME single-flight target. The
  // contract: never silently claim it as live (`reused`); reconcile by
  // either durable resume or marking process_restarted.
  const recovered = await startSkillChildRunForCaseF({
    scopeId: 'scope-legacy-recovery',
    sessionId: 'session-legacy-recovery',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/legacy-recovery' },
  })
  assert.notEqual(recovered.status, 'reused',
    'legacy reconciliation must never claim a stale row as live (reused)')
  assert.ok(
    recovered.status === 'running'
      || recovered.status === 'recoverable_paused',
    `unexpected reconcile status=${recovered.status}`,
  )
  if (recovered.status === 'recoverable_paused') {
    assert.ok(recovered.closeEvent, 'recoverable_paused result must carry a close event')
    assert.equal(recovered.closeEvent!.terminalReason, 'process_restarted')
  }
})

test('Phase 7: legacy row with no skillId remains adoptable (loader keeps legacyAdoptableHandles)', () => {
  // Source plan §8 Scenario H part 2 — legacy short-task row with no
  // `skillId` recording must still be adoptable. The contract surfaces
  // `legacyAdoptableHandles` so Phase 5 can mint a child run from it.
  const snapshot = makeSnapshot({
    outputDir: '/tmp/no-skill-id',
    runStatePath: '/tmp/no-skill-id/run_state.json',
  })
  const contract = loadSkillRunContract({
    skillId: 'video-expert-analyzer',
    supervisorSnapshot: snapshot,
    // No child-run row at all.
    skillTaskRunRepository: makeFakeRepository(null),
  })
  assert.ok(contract)
  assert.equal(contract!.childRunId, undefined)
  assert.deepEqual(contract!.legacyAdoptableHandles, {
    taskRunId: 'str-legacy-1',
    outputDir: '/tmp/no-skill-id',
    runStatePath: '/tmp/no-skill-id/run_state.json',
  })
})

test('Phase 4: child-run row takes precedence over legacy adoption fields', () => {
  // Phase 5 adoption simulation: a child run was minted with a stable
  // child-run id and adopted the legacy outputDir / runStatePath.
  const childRunId = createSkillChildRunId('vea')
  const childPayload: SkillChildRunPayload = {
    version: 1,
    childRunId,
    kind: 'vea',
    parentScopeId: 'scope-legacy',
    parentSessionId: 'session-legacy',
    skillId: 'video-expert-analyzer',
    skillName: 'Video Expert Analyzer (VNext)',
    requestedAction: 'video_expert_pipeline',
    requestedInput: { url: 'https://example.com/v1' },
    singleFlightKey: 'scope-legacy:session-legacy:video-expert-analyzer:digest-x',
    parentNextHint: 'wait_for_close_event',
    outputDir: '/tmp/legacy-output',
    runStatePath: '/tmp/legacy-output/run_state.json',
    eventLogPath: '/tmp/legacy-output/.ready/child-runs/run.jsonl',
    status: 'running',
    closeEvent: null,
    legacy: {
      taskRunId: 'str-legacy-1',
      detachedTaskId: null,
      projectionTaskId: null,
    },
  }
  const childRow: SkillTaskRunRecord = {
    id: childRunId,
    scopeId: 'scope-legacy',
    sessionId: 'session-legacy',
    agent: null,
    runId: null,
    skillId: 'video-expert-analyzer',
    skillName: 'Video Expert Analyzer (VNext)',
    action: 'video_expert_pipeline',
    toolName: null,
    runKind: 'child_run',
    status: 'running',
    interactionState: 'running',
    goalText: null,
    resourceRefs: [],
    params: childPayload.requestedInput,
    steps: [],
    currentStepId: null,
    artifacts: [],
    outputDir: childPayload.outputDir,
    runStatePath: childPayload.runStatePath,
    sceneScoresPath: null,
    deliveryReportPath: null,
    failureKind: null,
    failureDetail: null,
    jobId: null,
    detachedTaskId: null,
    resumePayload: { childRun: childPayload as unknown as Record<string, unknown> },
    createdAt: '2026-04-30T01:00:00.000Z',
    startedAt: '2026-04-30T01:00:00.000Z',
    updatedAt: '2026-04-30T01:00:00.000Z',
    finishedAt: null,
  }
  const snapshot = makeSnapshot({
    outputDir: '/tmp/legacy-output',
    runStatePath: '/tmp/legacy-output/run_state.json',
  })
  const contract = loadSkillRunContract({
    skillId: 'video-expert-analyzer',
    supervisorSnapshot: snapshot,
    skillTaskRunRepository: makeFakeRepository(childRow),
  })
  assert.ok(contract)
  assert.equal(contract!.childRunId, childRunId, 'contract must surface the adopted child run id')
  assert.equal(contract!.childStatus, 'running')
  assert.equal(contract!.parentNextHint, 'wait_for_close_event')
  assert.equal(contract!.childCloseEvent, null)
  // Phase 4 rule: a legacy row that gets adopted must NOT also produce
  // legacyAdoptableHandles (loader prefers the child run); blockerReason
  // also does not apply because handles are usable.
  assert.equal(contract!.legacyAdoptableHandles, undefined)
  assert.equal(contract!.blockerReason, undefined)
})
