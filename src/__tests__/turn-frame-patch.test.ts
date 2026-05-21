/**
 * Stage 5 — `TurnFramePatch` merge / apply contract.
 *
 * Patches let tools surface structured updates that the turn engine merges
 * across a single batch and applies to the next iteration's frame. The
 * apply rules:
 *   - `discoveredHandles` is ADDITIVE — only fills empty fields on the
 *     skill slice, so a higher-priority resolver win is never clobbered.
 *   - `skillStatusUpdates` is OVERRIDE — every key replaces the
 *     corresponding skill slice field.
 *   - `livenessHint` only upgrades concrete, non-terminal liveness states.
 *   - Empty patch returns the input frame unchanged.
 *   - `mergeTurnFramePatches` keeps last-write-wins for scalars and
 *     concat-and-dedupe for `activeArtifactRoots`.
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
  isFramePatchEmittingToolName,
} from '../main/modules/agent-control/contracts/run-contracts'
import {
  getToolResourceTag,
  isParallelSafeTool,
} from '../main/modules/agent-control/tools-runtime/tool-parallelism-policy'

function makeFrame(overrides?: Partial<TurnFrame>): TurnFrame {
  return {
    ids: { sessionId: 'scope-test', requestId: null },
    mode: 'skill_resume',
    userIntent: 'continue',
    skill: {
      skillId: 'video-expert-analyzer',
      skillName: 'video-expert-analyzer',
      source: 'supervisor',
      confidence: 80,
      taskRunId: null,
      detachedTaskId: null,
      action: 'video_expert_pipeline',
      runStatePath: null,
      outputDir: null,
      artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
      status: 'blocked',
      staleBlockerReason: null,
      runContract: null,
    },
    liveness: 'unknown',
    progress: { stage: null, totalUnits: null, completedUnits: null, coverageRatio: null, fingerprint: null },
    steering: { mode: 'ask_model', requiredToolName: null, preferredToolNames: [], systemReminder: null, action: null },
    budget: { leaseEndIteration: null, hardCapIteration: null, exhausted: false },
    activeArtifactRoots: [],
    configValidation: null,
    terminalReason: null,
    ...overrides,
  }
}

test('mergeTurnFramePatches: scalar last-write-wins, arrays concat-and-dedupe', () => {
  const patches: TurnFramePatch[] = [
    {
      activeArtifactRoots: ['/tmp/a', '/tmp/b'],
      configValidation: { valid: false, reason: 'missing_provider' },
      livenessHint: 'recoverable_paused',
    },
    {
      activeArtifactRoots: ['/tmp/b', '/tmp/c'],
      configValidation: { valid: true, message: 'ok' },
      livenessHint: 'running_process',
    },
  ]
  const merged = mergeTurnFramePatches(patches)
  assert.deepEqual(merged.activeArtifactRoots, ['/tmp/a', '/tmp/b', '/tmp/c'])
  assert.deepEqual(merged.configValidation, { valid: true, reason: undefined, message: 'ok' })
  assert.equal(merged.livenessHint, 'running_process')
})

test('mergeTurnFramePatches: handles partial overlap and empty input', () => {
  const empty = mergeTurnFramePatches([])
  assert.deepEqual(empty, {})

  const partial = mergeTurnFramePatches([
    { discoveredHandles: { taskRunId: 'str-1' } },
    { discoveredHandles: { detachedTaskId: 'dst-1' } },
    { skillStatusUpdates: { staleBlockerReason: null } },
  ])
  assert.deepEqual(partial.discoveredHandles, { taskRunId: 'str-1', detachedTaskId: 'dst-1' })
  assert.deepEqual(partial.skillStatusUpdates, { staleBlockerReason: null })
})

test('applyTurnFramePatch: discoveredHandles only fills empty fields', () => {
  const frame = makeFrame({
    skill: {
      ...makeFrame().skill!,
      skillId: 'generic-skill',
      skillName: 'generic-skill',
      taskRunId: 'str-already-set',
      detachedTaskId: null,
      runStatePath: null,
      outputDir: '/tmp/already-set',
      action: null,
    },
  })
  const next = applyTurnFramePatch(frame, {
    discoveredHandles: {
      taskRunId: 'str-new-attempt',
      detachedTaskId: 'dst-new',
      runStatePath: '/tmp/run_state.json',
      outputDir: '/tmp/new-output',
      action: 'fresh_action',
    },
  })
  assert.equal(next.skill?.taskRunId, 'str-already-set', 'preserved existing handle')
  assert.equal(next.skill?.detachedTaskId, 'dst-new', 'filled empty handle')
  assert.equal(next.skill?.runStatePath, '/tmp/run_state.json', 'filled empty path')
  assert.equal(next.skill?.outputDir, '/tmp/already-set', 'preserved existing output dir')
  assert.equal(next.skill?.action, 'fresh_action', 'filled empty action')
})

test('applyTurnFramePatch: skillStatusUpdates overrides existing skill slice fields', () => {
  const frame = makeFrame()
  const next = applyTurnFramePatch(frame, {
    skillStatusUpdates: {
      status: 'recoverable_paused',
      staleBlockerReason: 'cleared_by_validator',
    },
  })
  assert.equal(next.skill?.status, 'recoverable_paused')
  assert.equal(next.skill?.staleBlockerReason, 'cleared_by_validator')
})

test('applyTurnFramePatch: VEA progress stage cannot overwrite known executable action', () => {
  const frame = makeFrame({
    skill: {
      ...makeFrame().skill!,
      action: 'video_expert_pipeline',
      runContract: {
        skillId: 'video-expert-analyzer',
        skillName: 'video-expert-analyzer',
        toolName: 'skill_video_expert_pipeline',
        action: 'video_expert_pipeline',
        actionInput: null,
        originalInput: null,
        sourceUrl: null,
        taskRunId: null,
        detachedTaskId: null,
        jobId: null,
        outputDir: '/tmp/video-output',
        runStatePath: '/tmp/video-output/run_state.json',
        artifactRoots: ['/tmp/video-output'],
        artifactPaths: { sceneScoresPath: '/tmp/video-output/scene_scores.json', deliveryReportPath: null },
        status: 'recoverable_paused',
        liveness: 'recoverable_paused',
        progress: { stage: null, totalUnits: null, completedUnits: null, coverageRatio: null, fingerprint: null },
        blocker: { reason: null, stale: false },
        projectionIdentity: { stableKey: null, supersedesProjectionIds: [] },
        forceLoopGuard: {
          lastForceToolName: null,
          lastForceInputDigest: null,
          lastForceToolDispatchedAt: null,
          consecutiveForceCount: 0,
        },
        updatedAt: '2026-04-29T01:00:00.000Z',
      },
    },
  })

  const next = applyTurnFramePatch(frame, {
    skillStatusUpdates: { action: 'score_batches' },
    runContract: {
      action: 'score_batches',
      progress: { stage: 'score_batches', totalUnits: 5, completedUnits: 2, coverageRatio: 0.4, fingerprint: null },
    },
  })

  assert.equal(next.skill?.action, 'video_expert_ai_analyze')
  assert.equal(next.skill?.runContract?.action, 'video_expert_ai_analyze')
  assert.equal(next.skill?.runContract?.progress.stage, 'score_batches')
})

test('applyTurnFramePatch: livenessHint upgrades from unknown', () => {
  const frame = makeFrame({ liveness: 'unknown' })
  const next = applyTurnFramePatch(frame, { livenessHint: 'running_process' })
  assert.equal(next.liveness, 'running_process')
})

test('applyTurnFramePatch: blocked run_state evidence overrides stale running liveness', () => {
  const frame = makeFrame({
    liveness: 'running_process',
    skill: {
      ...makeFrame().skill!,
      status: 'running',
      runStatePath: '/tmp/video-output/run_state.json',
      outputDir: '/tmp/video-output',
    },
  })
  const next = applyTurnFramePatch(frame, {
    skillStatusUpdates: { status: 'blocked' },
    livenessHint: 'blocked',
    runContract: {
      skillId: 'video-expert-analyzer',
      outputDir: '/tmp/video-output',
      runStatePath: '/tmp/video-output/run_state.json',
      status: 'blocked',
      liveness: 'blocked',
    },
  })

  assert.equal(next.skill?.status, 'blocked')
  assert.equal(next.liveness, 'blocked')
})

test('applyTurnFramePatch: new runContract preserves child-run ownership fields', () => {
  const frame = makeFrame({
    skill: {
      ...makeFrame().skill!,
      runContract: null,
    },
  })

  const next = applyTurnFramePatch(frame, {
    livenessHint: 'running_process',
    runContract: {
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      outputDir: '/tmp/video-output',
      runStatePath: '/tmp/video-output/run_state.json',
      status: 'running',
      liveness: 'running_process',
      childRunId: 'vchild123',
      childStatus: 'running',
      parentNextHint: 'wait_for_close_event',
    },
  })

  assert.equal(next.skill?.runContract?.childRunId, 'vchild123')
  assert.equal(next.skill?.runContract?.childStatus, 'running')
  assert.equal(next.skill?.runContract?.parentNextHint, 'wait_for_close_event')
})

test('applyTurnFramePatch: livenessHint cannot downgrade from terminal done', () => {
  const frame = makeFrame({ liveness: 'done' })
  const next = applyTurnFramePatch(frame, { livenessHint: 'running_process' })
  assert.equal(next.liveness, 'done', 'terminal done is preserved')
})

test('applyTurnFramePatch: livenessHint cannot downgrade from terminal failed', () => {
  const frame = makeFrame({ liveness: 'failed' })
  const next = applyTurnFramePatch(frame, { livenessHint: 'recent_progress' })
  assert.equal(next.liveness, 'failed', 'terminal failed is preserved')
})

test('applyTurnFramePatch: empty patch returns input frame unchanged structurally', () => {
  const frame = makeFrame()
  const next = applyTurnFramePatch(frame, {})
  assert.equal(next, frame, 'same reference for empty patch')
})

test('applyTurnFramePatch: activeArtifactRoots-only patch persists to frame', () => {
  // After the Stage C/D schema lock, activeArtifactRoots has a durable
  // frame slot. apply() unions the new roots into frame.activeArtifactRoots
  // so same-turn skill_read_artifact calls see freshly-discovered roots.
  const frame = makeFrame()
  const next = applyTurnFramePatch(frame, {
    activeArtifactRoots: ['/tmp/extra-root'],
  })
  assert.notEqual(next, frame, 'frame is structurally updated')
  assert.deepEqual(next.activeArtifactRoots, ['/tmp/extra-root'])
})

// ──────────────────────────────────────────────────────────────────────────
// Step D9 — parallelism gate regression + deterministic merge by tool-call
// order. These tests guard the producer-side invariants Gamma owns.
// ──────────────────────────────────────────────────────────────────────────

test('D9: framePatch-emitting tools are never read-only parallel-safe', () => {
  // The static primitives in `FRAME_PATCH_EMITTING_TOOL_NAMES` plus the
  // dynamic `skill_<id>_<action>` typed actions (matched via
  // `isFramePatchEmittingToolName`) must all be flagged as `interactive`
  // (non-parallel-safe) by the parallelism policy. A regression here would
  // let two contract-emitting tools join the same parallel batch and
  // overwrite each other's runContract patches.
  for (const toolName of FRAME_PATCH_EMITTING_TOOL_NAMES) {
    const tag = getToolResourceTag(toolName)
    assert.equal(
      tag.accessMode,
      'interactive',
      `Static primitive ${toolName} must be interactive (non-parallel-safe)`,
    )
    assert.equal(
      isParallelSafeTool(toolName),
      false,
      `Static primitive ${toolName} must NOT be parallel-safe`,
    )
  }

  // Dynamic typed action wrapper — `skill_<id>_<action>` shape. Use a
  // synthetic name guaranteed not to collide with a real primitive.
  const dynamicTypedActionName = 'skill_video_expert_analyzer_score_batch'
  assert.equal(isFramePatchEmittingToolName(dynamicTypedActionName), true)
  const dynamicTag = getToolResourceTag(dynamicTypedActionName)
  assert.equal(
    dynamicTag.accessMode,
    'interactive',
    'Dynamic typed action wrapper must be interactive (non-parallel-safe)',
  )

  // Sanity check — actually-read-only skill tools (RSS reads) stay read-only
  // via the explicit `READ_ONLY_SKILL_TOOL_NAMES` override list. The static
  // `FRAME_PATCH_EMITTING_TOOL_NAMES` and the read-only set must never
  // overlap (enforced by the parallelism policy's module-load invariant),
  // so these stay parallel-safe even though Beta's catch-all predicate is
  // permissive about dynamic typed actions.
  for (const readOnlyName of ['skill_rss_status', 'skill_rss_list', 'skill_rss_stats']) {
    assert.equal(
      FRAME_PATCH_EMITTING_TOOL_NAMES.includes(readOnlyName),
      false,
      `${readOnlyName} must NOT be in the canonical FRAME_PATCH_EMITTING_TOOL_NAMES list`,
    )
    assert.equal(
      getToolResourceTag(readOnlyName).accessMode,
      'read',
      `${readOnlyName} must remain read-only parallel-safe`,
    )
  }
})

test('D9: synthetic patches merge deterministically in tool-call order', () => {
  // Two producers in the same batch — `skill_inspect_run_state` first,
  // typed action wrapper second. Later patch wins for scalars; arrays
  // concat-and-dedupe; runContract partials field-merge.
  const inspectPatch: TurnFramePatch = {
    activeArtifactRoots: ['/tmp/output-1'],
    livenessHint: 'recoverable_paused',
    discoveredHandles: {
      taskRunId: 'task-1',
      runStatePath: '/tmp/output-1/run_state.json',
      outputDir: '/tmp/output-1',
    },
    runContract: {
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      outputDir: '/tmp/output-1',
      runStatePath: '/tmp/output-1/run_state.json',
      artifactRoots: ['/tmp/output-1'],
      artifactPaths: { sceneScoresPath: '/tmp/output-1/scene_scores.json', deliveryReportPath: null },
      status: 'recoverable_paused',
      liveness: 'recoverable_paused',
    },
  }
  const typedActionPatch: TurnFramePatch = {
    activeArtifactRoots: ['/tmp/output-1', '/tmp/extra-root'],
    livenessHint: 'running_process',
    discoveredHandles: {
      detachedTaskId: 'dst-1',
      action: 'video_expert_score_batch',
    },
    runContract: {
      skillId: 'video-expert-analyzer',
      action: 'video_expert_score_batch',
      outputDir: '/tmp/output-1',
      runStatePath: '/tmp/output-1/run_state.json',
      artifactRoots: ['/tmp/output-1', '/tmp/extra-root'],
      artifactPaths: { sceneScoresPath: '/tmp/output-1/scene_scores.json', deliveryReportPath: '/tmp/output-1/delivery_report.json' },
      status: 'running',
      liveness: 'running_process',
    },
  }

  // Order A: inspect → typed action.
  const merged = mergeTurnFramePatches([inspectPatch, typedActionPatch])
  // Scalars: typed action wins.
  assert.equal(merged.livenessHint, 'running_process')
  assert.equal(merged.runContract?.status, 'running')
  assert.equal(merged.runContract?.action, 'video_expert_score_batch')
  // discoveredHandles shallow-merge; later override only fills new keys here.
  assert.equal(merged.discoveredHandles?.taskRunId, 'task-1')
  assert.equal(merged.discoveredHandles?.detachedTaskId, 'dst-1')
  assert.equal(merged.discoveredHandles?.action, 'video_expert_score_batch')
  // Arrays: concat-and-dedupe.
  assert.deepEqual(merged.activeArtifactRoots, ['/tmp/output-1', '/tmp/extra-root'])
  assert.deepEqual(merged.runContract?.artifactRoots, ['/tmp/output-1', '/tmp/extra-root'])
  // Nested artifactPaths: typed action's deliveryReportPath survives, sceneScoresPath unchanged.
  assert.equal(merged.runContract?.artifactPaths?.sceneScoresPath, '/tmp/output-1/scene_scores.json')
  assert.equal(merged.runContract?.artifactPaths?.deliveryReportPath, '/tmp/output-1/delivery_report.json')

  // Order B: typed action → inspect (reversed). Determinism check — the
  // result should differ predictably (later wins for scalars), proving the
  // merge is order-sensitive in a defined, deterministic way rather than
  // racy.
  const reversed = mergeTurnFramePatches([typedActionPatch, inspectPatch])
  assert.equal(reversed.livenessHint, 'recoverable_paused', 'reversed order: inspect wins for liveness')
  assert.equal(reversed.runContract?.status, 'recoverable_paused', 'reversed order: inspect wins for status')
  assert.equal(reversed.runContract?.action, 'video_expert_pipeline', 'reversed order: inspect wins for runContract.action')
  // discoveredHandles still merge cumulatively. inspectPatch.discoveredHandles
  // does not set `action` (typed-action defines it instead), so the merged
  // value still carries the typed action's `action` regardless of order —
  // documenting that absence is treated as "no opinion" rather than override.
  assert.equal(reversed.discoveredHandles?.taskRunId, 'task-1')
  assert.equal(reversed.discoveredHandles?.detachedTaskId, 'dst-1')
  assert.equal(reversed.discoveredHandles?.action, 'video_expert_score_batch')
  // Arrays still dedupe; final order reflects first-seen across both patches.
  assert.deepEqual(reversed.activeArtifactRoots, ['/tmp/output-1', '/tmp/extra-root'])
})
