/**
 * Stage A4 — restart/rebuild SkillRunContract fixture.
 *
 * After a long skill pauses, the next turn must rebuild a `SkillRunContract`
 * purely from durable sources (no `turn-engine.ts` locals): synthetic
 * `<outputDir>/run_state.json` + projection sibling row + supervisor snapshot.
 * The contract must surface enough information that the next steering pass
 * can derive a force_tool action input deterministically.
 *
 * This is currently a FAILING fixture. The plan §6 Stage A4 expected current
 * result is "FAIL because SkillRunContract and loadSkillRunContract do not
 * exist yet." Beta (Wave 1) defined the types and a Wave-1-minimum loader
 * that synthesises from supervisor snapshot + projection + reference hint
 * but does NOT yet parse `<outputDir>/run_state.json` — Zeta lands that in
 * Wave 3 (see `// TODO(zeta)` in run-contracts.ts). Until Zeta's PR lands,
 * the assertion that the loader exposes `progress.stage === 'score_batches'`
 * derived FROM run_state.json (not the supervisor snapshot, which we leave
 * intentionally light) cannot pass.
 *
 * Wave 3 (Zeta) flips A4 GREEN by extending `loadSkillRunContract` to read
 * the run_state file when `outputDir` is provided.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Note: Beta has already landed `SkillRunContract` and `loadSkillRunContract`
// in this worktree, so no `@ts-expect-error` markers are needed. The
// orchestration plan permitted markers as a fallback for the case where
// Beta hadn't shipped yet; here the failure mode is "loader does not yet
// parse run_state.json" rather than "imports missing."
import {
  loadSkillRunContract,
  type SkillRunContract,
} from '../main/modules/agent-control/run-contracts'
import type { SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skills/skill-task-supervisor'
import type { TaskProjectionRecord } from '../main/modules/agent-control/run-contracts'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ready-skill-contract-'))
}

function writeRunState(outputDir: string, payload: Record<string, unknown>): string {
  const runStatePath = join(outputDir, 'run_state.json')
  writeFileSync(runStatePath, JSON.stringify(payload), 'utf-8')
  return runStatePath
}

function makeMinimalSupervisorSnapshot(overrides?: Partial<SkillTaskSupervisorSnapshot>): SkillTaskSupervisorSnapshot {
  return {
    taskRunId: overrides?.taskRunId ?? 'str-vea-restart',
    detachedTaskId: overrides?.detachedTaskId ?? 'dst-vea-restart',
    skillId: overrides?.skillId ?? 'video-expert-analyzer',
    scopeId: overrides?.scopeId ?? 'scope-restart',
    sessionId: overrides?.sessionId ?? 'scope-restart',
    action: overrides?.action ?? 'video_expert_pipeline',
    status: overrides?.status ?? 'recoverable_paused',
    hasLiveWork: overrides?.hasLiveWork ?? false,
    hasRecentProgress: overrides?.hasRecentProgress ?? false,
    closeAllowed: overrides?.closeAllowed ?? false,
    ambiguous: overrides?.ambiguous ?? false,
    stale: overrides?.stale ?? false,
    outputDir: overrides?.outputDir ?? null,
    runStatePath: overrides?.runStatePath ?? null,
    // Intentionally null — these would normally be populated by the
    // supervisor's run_state read, but the contract-rebuild fixture proves
    // the loader can fall back on raw run_state.json itself.
    sceneScoresPath: overrides?.sceneScoresPath ?? null,
    deliveryReportPath: overrides?.deliveryReportPath ?? null,
    progress: overrides?.progress ?? {
      currentStage: null,
      totalScenes: null,
      completedScenes: null,
      coverageRatio: null,
      updatedAt: null,
    },
    blockers: overrides?.blockers ?? [],
    pauseReason: overrides?.pauseReason ?? 'budget_exhausted',
    resumePayload: overrides?.resumePayload ?? null,
    sourceObservations: overrides?.sourceObservations ?? [],
    progressFingerprint: overrides?.progressFingerprint ?? null,
    observedAt: overrides?.observedAt ?? '2026-04-29T01:00:00.000Z',
    lastProgressAt: overrides?.lastProgressAt ?? null,
  }
}

function makeProjectionSibling(overrides?: Partial<TaskProjectionRecord>): TaskProjectionRecord {
  return {
    taskId: overrides?.taskId ?? 'task-vea-projection',
    scopeId: overrides?.scopeId ?? 'scope-restart',
    runId: overrides?.runId ?? 'run-vea-projection',
    parentTaskId: overrides?.parentTaskId ?? null,
    parentStepId: overrides?.parentStepId ?? null,
    taskType: overrides?.taskType ?? 'multi_step_task',
    module: overrides?.module ?? 'skill:detached:video-expert-analyzer',
    taskTitle: overrides?.taskTitle ?? '视频深度分析',
    taskSummary: overrides?.taskSummary ?? null,
    status: overrides?.status ?? 'blocked',
    interactionState: overrides?.interactionState ?? 'suspended',
    waitingFor: overrides?.waitingFor ?? 'background',
    steps: overrides?.steps ?? [],
    currentStepId: overrides?.currentStepId ?? null,
    budget: overrides?.budget ?? null,
    budgetUsagePercent: overrides?.budgetUsagePercent ?? null,
    budgetWarningLevel: overrides?.budgetWarningLevel ?? null,
    recoveryHistory: overrides?.recoveryHistory ?? [],
    degradationReason: overrides?.degradationReason ?? null,
    blockedReason: overrides?.blockedReason ?? 'budget_exhausted',
    resumableActions: overrides?.resumableActions ?? [],
    continuationRef: overrides?.continuationRef ?? null,
    recentArtifacts: overrides?.recentArtifacts ?? [],
    createdAt: overrides?.createdAt ?? '2026-04-29T00:30:00.000Z',
    updatedAt: overrides?.updatedAt ?? '2026-04-29T01:00:00.000Z',
  }
}

test('A4: loadSkillRunContract rebuilds SkillRunContract from synthetic run_state.json + projection + supervisor', () => {
  const outputDir = makeTempDir()
  try {
    // Synthetic VEA `run_state.json` is the AUTHORITATIVE source for stage /
    // progress. The supervisor snapshot in this fixture deliberately leaves
    // those fields empty so the assertion proves the loader fell back on
    // run_state.json itself (Zeta's Wave 3 contract).
    const runStatePath = writeRunState(outputDir, {
      version: 'vnext',
      task_id: 'dst-vea-restart',
      status: 'running',
      current_stage: 'score_batches',
      completed_stages: ['prepare'],
      total_scenes: 97,
      completed_scenes: 12,
      coverage_ratio: 12 / 97,
      updated_at: '2026-04-29T01:00:00Z',
    })

    const snapshot = makeMinimalSupervisorSnapshot({
      outputDir,
      runStatePath,
    })
    const projection = makeProjectionSibling()

    const contract: SkillRunContract | null = loadSkillRunContract({
      scopeId: 'scope-restart',
      sessionId: 'scope-restart',
      skillId: 'video-expert-analyzer',
      outputDir,
      runStatePath,
      supervisorSnapshot: snapshot,
      projectionSibling: projection,
    })

    assert.ok(contract, 'A4 regression: loadSkillRunContract returned null when given a paused VEA fixture with handles + outputDir')
    assert.equal(contract!.skillId, 'video-expert-analyzer')
    assert.equal(contract!.action, 'video_expert_pipeline')
    assert.equal(contract!.outputDir, outputDir)
    assert.equal(contract!.runStatePath, runStatePath)
    assert.equal(contract!.taskRunId, 'str-vea-restart')
    assert.equal(contract!.detachedTaskId, 'dst-vea-restart')

    // Stage A4 core assertion — progress fields MUST be derived from the
    // synthetic run_state.json. The supervisor snapshot left them null on
    // purpose. Without Zeta's Wave 3 run_state parser, the loader can only
    // fall back on `progressFromSnapshot(snapshot)` which produces nulls.
    assert.equal(
      contract!.progress.stage,
      'score_batches',
      'A4 regression: contract.progress.stage was not rebuilt from run_state.json — Zeta\'s Wave 3 loader extension is required.',
    )
    assert.equal(
      contract!.progress.totalUnits,
      97,
      'A4 regression: contract.progress.totalUnits was not rebuilt from run_state.json.total_scenes',
    )
    assert.equal(
      contract!.progress.completedUnits,
      12,
      'A4 regression: contract.progress.completedUnits was not rebuilt from run_state.json.completed_scenes',
    )

    // The contract must also retain the projection identity so cross-skill
    // non-supersede lookups have a stable key (Stage F4 builds on this).
    assert.equal(
      contract!.projectionIdentity.stableKey,
      projection.taskId,
      'A4: contract.projectionIdentity.stableKey should derive from the projection sibling row',
    )
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('A4: loadSkillRunContract returns null when no anchoring signal is present', () => {
  // Sanity check on the loader contract: without any of (skillId, outputDir,
  // taskRunId, detachedTaskId), the loader cannot anchor a real run.
  const contract = loadSkillRunContract({})
  assert.equal(contract, null)
})

test('A4: loadSkillRunContract preserves caller-supplied originalInput / actionInput / sourceUrl for resume', () => {
  // Verifies the loader's caller-supplied passthrough fields. These are the
  // hooks Delta's typed action wrapper (Wave 2) and Epsilon's force-tool
  // dispatch (Wave 3) both depend on.
  const snapshot = makeMinimalSupervisorSnapshot()
  const contract = loadSkillRunContract({
    skillId: 'video-expert-analyzer',
    supervisorSnapshot: snapshot,
    originalInput: { url: 'https://example.com/video' },
    actionInput: { url: 'https://example.com/video', outputDir: '/tmp/x' },
    sourceUrl: 'https://example.com/video',
    toolName: 'skill_video_expert_pipeline',
  })

  assert.ok(contract, 'expected contract for valid anchoring signal')
  assert.equal(contract!.toolName, 'skill_video_expert_pipeline')
  assert.deepEqual(contract!.originalInput, { url: 'https://example.com/video' })
  assert.deepEqual(contract!.actionInput, { url: 'https://example.com/video', outputDir: '/tmp/x' })
  assert.equal(contract!.sourceUrl, 'https://example.com/video')
})
