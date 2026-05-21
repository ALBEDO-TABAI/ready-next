/**
 * Stage C — `SkillRunContract` shape + durable frame slot round-trip.
 *
 * Beta's Wave 1 interface lock test: synthesize a `TurnFramePatch` carrying
 * a `runContract` partial plus the durable `activeArtifactRoots` and
 * `configValidation` fields; apply via `applyTurnFramePatch`; assert that
 * all three persist into the next frame so Wave 2 producers (Gamma + Delta)
 * and Wave 3 consumers (Epsilon + Zeta) can rely on the durability
 * contract.
 *
 * Also drives the `forceLoopGuard.consecutiveForceCount` increment behavior
 * through `mergeTurnFramePatches` so Epsilon's force-loop guard read/write
 * has a known reference point.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyTurnFramePatch,
  mergeTurnFramePatches,
  type TurnFrame,
  type TurnFramePatch,
} from '../main/modules/agent-control/runtime-core/turn-frame'
import {
  FRAME_PATCH_EMITTING_TOOL_NAMES,
  buildContractFramePatch,
  isFramePatchEmittingToolName,
  loadSkillRunContract,
  type SkillRunContract,
} from '../main/modules/agent-control/contracts/run-contracts'
import type { SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skills/skill-task-supervisor'

function makeFrame(overrides?: Partial<TurnFrame>): TurnFrame {
  return {
    ids: { sessionId: 'scope-test', requestId: 'req-1' },
    mode: 'skill_resume',
    userIntent: 'continue',
    skill: {
      skillId: 'video-expert-analyzer',
      skillName: 'Video Expert Analyzer',
      source: 'supervisor',
      confidence: 80,
      taskRunId: null,
      detachedTaskId: null,
      action: 'video_expert_pipeline',
      runStatePath: null,
      outputDir: null,
      artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
      status: 'recoverable_paused',
      staleBlockerReason: null,
      runContract: null,
    },
    liveness: 'recoverable_paused',
    progress: { stage: null, totalUnits: null, completedUnits: null, coverageRatio: null, fingerprint: null },
    steering: {
      mode: 'ask_model',
      requiredToolName: null,
      preferredToolNames: [],
      systemReminder: null,
      action: null,
    },
    budget: { leaseEndIteration: null, hardCapIteration: null, exhausted: false },
    activeArtifactRoots: [],
    configValidation: null,
    terminalReason: null,
    ...overrides,
  }
}

function makeContract(overrides?: Partial<SkillRunContract>): SkillRunContract {
  return {
    skillId: 'video-expert-analyzer',
    skillName: 'Video Expert Analyzer',
    toolName: 'skill_video_expert_pipeline',
    action: 'video_expert_pipeline',
    actionInput: { url: 'https://example.com/video.mp4' },
    originalInput: { url: 'https://example.com/video.mp4' },
    sourceUrl: 'https://example.com/video.mp4',
    taskRunId: 'str-vea-1',
    detachedTaskId: 'dst-vea-1',
    jobId: null,
    outputDir: '/tmp/vea-output-1',
    runStatePath: '/tmp/vea-output-1/run_state.json',
    artifactRoots: ['/tmp/vea-output-1'],
    artifactPaths: {
      sceneScoresPath: '/tmp/vea-output-1/scene_scores.json',
      deliveryReportPath: null,
    },
    status: 'recoverable_paused',
    liveness: 'recoverable_paused',
    progress: {
      stage: 'score_batches',
      totalUnits: 97,
      completedUnits: 12,
      coverageRatio: 0.12,
      fingerprint: 'fp-1',
    },
    blocker: { reason: null, stale: false },
    projectionIdentity: { stableKey: 'task-1', supersedesProjectionIds: [] },
    forceLoopGuard: {
      lastForceToolName: null,
      lastForceInputDigest: null,
      lastForceToolDispatchedAt: null,
      consecutiveForceCount: 0,
    },
    updatedAt: '2026-04-29T00:00:00.000Z',
    ...overrides,
  }
}

test('SkillRunContract shape: round-trip durability through applyTurnFramePatch', () => {
  const frame = makeFrame()
  const contract = makeContract()
  const patch: TurnFramePatch = {
    runContract: contract,
    activeArtifactRoots: ['/tmp/vea-output-1'],
    configValidation: { valid: true, message: 'config ok' },
  }
  const next = applyTurnFramePatch(frame, patch)

  assert.notEqual(next, frame, 'patch produces a new frame')
  assert.deepEqual(
    next.activeArtifactRoots,
    ['/tmp/vea-output-1'],
    'activeArtifactRoots persists into the next frame',
  )
  assert.deepEqual(
    next.configValidation,
    { valid: true, reason: undefined, message: 'config ok' },
    'configValidation persists into the next frame',
  )
  assert.ok(next.skill?.runContract, 'frame.skill.runContract is non-null after apply')
  assert.equal(next.skill?.runContract?.skillId, 'video-expert-analyzer')
  assert.equal(next.skill?.runContract?.outputDir, '/tmp/vea-output-1')
  assert.equal(next.skill?.runContract?.runStatePath, '/tmp/vea-output-1/run_state.json')
  assert.equal(next.skill?.runContract?.artifactPaths.sceneScoresPath, '/tmp/vea-output-1/scene_scores.json')
})

test('SkillRunContract shape: activeArtifactRoots accumulate across patches without dropping prior roots', () => {
  const frame = makeFrame({ activeArtifactRoots: ['/tmp/initial-root'] })
  const next = applyTurnFramePatch(frame, {
    activeArtifactRoots: ['/tmp/initial-root', '/tmp/new-root'],
  })
  assert.deepEqual(next.activeArtifactRoots, ['/tmp/initial-root', '/tmp/new-root'])
})

test('SkillRunContract shape: forceLoopGuard.consecutiveForceCount increments through merge', () => {
  const patches: TurnFramePatch[] = [
    {
      runContract: {
        skillId: 'video-expert-analyzer',
        forceLoopGuard: {
          lastForceToolName: 'skill_video_expert_pipeline',
          lastForceInputDigest: 'digest-1',
          lastForceToolDispatchedAt: '2026-04-29T00:00:01.000Z',
          consecutiveForceCount: 1,
        },
      },
    },
    {
      runContract: {
        skillId: 'video-expert-analyzer',
        forceLoopGuard: {
          lastForceToolName: 'skill_video_expert_pipeline',
          lastForceInputDigest: 'digest-1',
          lastForceToolDispatchedAt: '2026-04-29T00:00:02.000Z',
          consecutiveForceCount: 2,
        },
      },
    },
  ]
  const merged = mergeTurnFramePatches(patches)
  assert.ok(merged.runContract, 'merged patch has runContract')
  assert.equal(
    merged.runContract?.forceLoopGuard?.consecutiveForceCount,
    2,
    'last-write-wins increment',
  )
  assert.equal(merged.runContract?.forceLoopGuard?.lastForceInputDigest, 'digest-1')
  assert.equal(
    merged.runContract?.forceLoopGuard?.lastForceToolDispatchedAt,
    '2026-04-29T00:00:02.000Z',
    'later timestamp wins',
  )
})

test('SkillRunContract shape: mergeTurnFramePatches field-by-field merges runContract scalars', () => {
  const patches: TurnFramePatch[] = [
    { runContract: { skillId: 'video-expert-analyzer', outputDir: '/tmp/a', taskRunId: 'str-1' } },
    { runContract: { skillId: 'video-expert-analyzer', runStatePath: '/tmp/a/run_state.json' } },
    { runContract: { skillId: 'video-expert-analyzer', actionInput: { url: 'https://example.com' } } },
  ]
  const merged = mergeTurnFramePatches(patches)
  assert.equal(merged.runContract?.outputDir, '/tmp/a')
  assert.equal(merged.runContract?.taskRunId, 'str-1')
  assert.equal(merged.runContract?.runStatePath, '/tmp/a/run_state.json')
  assert.deepEqual(merged.runContract?.actionInput, { url: 'https://example.com' })
})

test('SkillRunContract shape: mergeTurnFramePatches concat-dedupes runContract.artifactRoots', () => {
  const patches: TurnFramePatch[] = [
    { runContract: { skillId: 'video-expert-analyzer', artifactRoots: ['/tmp/a', '/tmp/b'] } },
    { runContract: { skillId: 'video-expert-analyzer', artifactRoots: ['/tmp/b', '/tmp/c'] } },
  ]
  const merged = mergeTurnFramePatches(patches)
  assert.deepEqual(merged.runContract?.artifactRoots, ['/tmp/a', '/tmp/b', '/tmp/c'])
})

test('loadSkillRunContract: returns non-null when supervisor snapshot has outputDir + taskRunId', () => {
  const snapshot: SkillTaskSupervisorSnapshot = {
    taskRunId: 'str-vea-2',
    detachedTaskId: 'dst-vea-2',
    skillId: 'video-expert-analyzer',
    scopeId: 'scope-1',
    sessionId: 'session-1',
    action: 'video_expert_pipeline',
    status: 'recoverable_paused',
    hasLiveWork: false,
    hasRecentProgress: true,
    closeAllowed: false,
    ambiguous: false,
    stale: false,
    outputDir: '/tmp/vea-output-2',
    runStatePath: '/tmp/vea-output-2/run_state.json',
    sceneScoresPath: '/tmp/vea-output-2/scene_scores.json',
    deliveryReportPath: null,
    progress: {
      currentStage: 'score_batches',
      totalScenes: 97,
      completedScenes: 32,
      coverageRatio: 0.33,
      updatedAt: '2026-04-29T00:00:00.000Z',
    },
    blockers: [],
    pauseReason: 'budget_exhausted',
    resumePayload: { url: 'https://example.com/video.mp4' },
    sourceObservations: [],
    progressFingerprint: 'fp-2',
    observedAt: '2026-04-29T00:00:00.000Z',
    lastProgressAt: '2026-04-29T00:00:00.000Z',
  }

  const contract = loadSkillRunContract({
    sessionId: 'session-1',
    skillId: 'video-expert-analyzer',
    supervisorSnapshot: snapshot,
  })

  assert.ok(contract, 'contract is non-null with full supervisor snapshot')
  assert.equal(contract?.skillId, 'video-expert-analyzer')
  assert.equal(contract?.action, 'video_expert_pipeline')
  assert.equal(contract?.taskRunId, 'str-vea-2')
  assert.equal(contract?.detachedTaskId, 'dst-vea-2')
  assert.equal(contract?.outputDir, '/tmp/vea-output-2')
  assert.equal(contract?.runStatePath, '/tmp/vea-output-2/run_state.json')
  assert.equal(contract?.artifactPaths.sceneScoresPath, '/tmp/vea-output-2/scene_scores.json')
  assert.equal(contract?.artifactPaths.deliveryReportPath, null)
  assert.equal(contract?.status, 'recoverable_paused')
  assert.equal(contract?.liveness, 'recent_progress')
  assert.equal(contract?.progress.stage, 'score_batches')
  assert.equal(contract?.progress.totalUnits, 97)
  assert.equal(contract?.progress.completedUnits, 32)
  assert.deepEqual(contract?.artifactRoots, ['/tmp/vea-output-2'])
  assert.equal(contract?.forceLoopGuard.consecutiveForceCount, 0)
})

test('loadSkillRunContract: returns null when neither supervisor snapshot nor caller-supplied handles are present', () => {
  const contract = loadSkillRunContract({
    sessionId: 'session-empty',
    supervisorSnapshot: null,
  })
  assert.equal(contract, null)
})

test('buildContractFramePatch: produces patch with runContract + activeArtifactRoots + livenessHint', () => {
  const contract = makeContract()
  const patch = buildContractFramePatch({
    contract,
    activeArtifactRoots: ['/tmp/extra-root'],
  })

  assert.ok(patch.runContract, 'patch carries runContract')
  assert.equal(patch.runContract?.skillId, 'video-expert-analyzer')
  assert.equal(patch.runContract?.outputDir, '/tmp/vea-output-1')
  assert.deepEqual(patch.activeArtifactRoots, ['/tmp/extra-root', '/tmp/vea-output-1'])
  assert.equal(patch.livenessHint, 'recoverable_paused')
  assert.equal(patch.discoveredHandles?.taskRunId, 'str-vea-1')
  assert.equal(patch.discoveredHandles?.detachedTaskId, 'dst-vea-1')
  assert.equal(patch.discoveredHandles?.outputDir, '/tmp/vea-output-1')
})

test('buildContractFramePatch: contract is null → patch is empty (or only carries explicit overrides)', () => {
  const patch = buildContractFramePatch({ contract: null })
  assert.equal(patch.runContract, undefined)
  assert.equal(patch.activeArtifactRoots, undefined)
  assert.equal(patch.livenessHint, undefined)
})

test('FRAME_PATCH_EMITTING_TOOL_NAMES: matches plan §5.5 rule 1 — covers all frame-mutating primitives', () => {
  // The canonical list MUST include all primitive tools that mutate the
  // frame so Gamma's parallelism gate can exclude them from the read-only
  // parallel-safe set.
  const expected = [
    'skill_inspect_run_state',
    'skill_patch_config',
    'skill_start_detached',
    'skill_cancel_detached',
    'skill_inspect_detached',
  ]
  for (const name of expected) {
    assert.ok(
      FRAME_PATCH_EMITTING_TOOL_NAMES.includes(name),
      `FRAME_PATCH_EMITTING_TOOL_NAMES must include ${name}`,
    )
  }
})

test('isFramePatchEmittingToolName: typed action wrappers (skill_<id>_<action>) are recognized', () => {
  assert.equal(isFramePatchEmittingToolName('skill_video_expert_pipeline'), true)
  assert.equal(isFramePatchEmittingToolName('skill_video_expert_ai_analyze'), true)
  assert.equal(isFramePatchEmittingToolName('skill_lets_go_rss_rss_update'), true)
  // primitives that are NOT frame-patch emitters (read-only / no contract update)
  assert.equal(isFramePatchEmittingToolName('skill_read_artifact'), false)
  assert.equal(isFramePatchEmittingToolName('skill_run_shell'), false)
  assert.equal(isFramePatchEmittingToolName('skill_write_artifact'), false)
  assert.equal(isFramePatchEmittingToolName('skill_ask_user'), false)
  // primitives that ARE frame-patch emitters
  assert.equal(isFramePatchEmittingToolName('skill_inspect_run_state'), true)
  assert.equal(isFramePatchEmittingToolName('skill_patch_config'), true)
  // non-skill tools
  assert.equal(isFramePatchEmittingToolName('browser_open'), false)
  assert.equal(isFramePatchEmittingToolName(''), false)
})
