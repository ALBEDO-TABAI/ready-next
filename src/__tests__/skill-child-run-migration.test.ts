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
import type { SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skill-task-supervisor'
import { createSkillChildRunId } from '../main/modules/agent-control/skill-child-run-id'
import type { SkillChildRunPayload } from '../main/modules/agent-control/skill-child-run-types'
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
