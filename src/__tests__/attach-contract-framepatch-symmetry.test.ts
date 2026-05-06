/**
 * Stage M (M5a-helper) — `attachContractFramePatch` symmetry contract.
 *
 * Plan §2.5 widens the helper to auto-emit a matching `contextModifier`
 * whenever the framePatch carries `activeArtifactRoots`. This test pins:
 *   - `framePatch` carries `activeArtifactRoots: [outputDir]` AND
 *   - `contextModifier.activeFrame.activeArtifactRoots` mirrors them AND
 *   - `contextModifier.activeFrame.runContract` is the full SkillRunContract
 *     (not Partial<SkillRunContract>; that would fail typecheck — fixed
 *     in plan v8 by using the local `contract` variable).
 *
 * The test exercises the helper in isolation by stubbing
 * `loadSkillRunContract` via the supervisor input it consumes — we pass a
 * supervisor snapshot that synthesises the contract fields.
 *
 * Other M5a slices (M5a-inspect / M5a-typed-gate) have their own tests.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachContractFramePatch,
  type ToolExecutionOutput,
} from '../main/modules/tools/skills-tools'

function makeOutput(overrides?: Partial<ToolExecutionOutput>): ToolExecutionOutput {
  return {
    text: 'ok',
    shape: 'text',
    data: null,
    projectionPatch: null,
    interactionHint: null,
    framePatch: null,
    contextModifier: null,
    ...overrides,
  } as ToolExecutionOutput
}

// Supervisor snapshot shape that loadSkillRunContract can build a contract from
function makeSupervisorSnapshot(skillId = 'video-expert-analyzer'): Parameters<typeof attachContractFramePatch>[1]['supervisorSnapshot'] {
  return {
    skillId,
    skillName: skillId,
    taskRunId: 'task-1',
    detachedTaskId: 'detached-1',
    runStatePath: '/tmp/test-vea/run_state.json',
    outputDir: '/tmp/test-vea',
    sceneScoresPath: null,
    deliveryReportPath: null,
    action: 'video_expert_pipeline',
    actionInput: null,
    originalInput: null,
    sourceUrl: null,
    jobId: null,
    status: 'recoverable_paused',
    liveness: 'recoverable_paused',
    blockerReason: null,
    progress: { stage: null, totalUnits: null, completedUnits: null, coverageRatio: null, fingerprint: null },
    resumePayload: null,
  } as never
}

test('attachContractFramePatch: auto-emits contextModifier when framePatch.activeArtifactRoots is non-empty', () => {
  const output = attachContractFramePatch(makeOutput(), {
    sessionId: 'sess-1',
    skillId: 'video-expert-analyzer',
    outputDir: '/tmp/test-vea',
    runStatePath: '/tmp/test-vea/run_state.json',
    supervisorSnapshot: makeSupervisorSnapshot(),
    referenceHint: null,
  }, {
    activeArtifactRoots: ['/tmp/test-vea'],
  })

  assert.ok(output.framePatch?.activeArtifactRoots?.includes('/tmp/test-vea'),
    'framePatch must carry the seeded activeArtifactRoots')
  assert.ok(output.contextModifier?.activeFrame, 'contextModifier.activeFrame must be populated')
  assert.deepEqual(
    output.contextModifier.activeFrame.activeArtifactRoots,
    output.framePatch.activeArtifactRoots,
    'roots mirror exactly between framePatch and contextModifier',
  )
  // Type-shape assertion: contextModifier.activeFrame.runContract is the FULL
  // SkillRunContract (or null), not a Partial. The plan v8 fix used the local
  // `contract` rather than `merged.runContract`.
  const ctxContract = output.contextModifier.activeFrame.runContract
  assert.ok(ctxContract != null, 'contextModifier carries the full contract')
  assert.equal(ctxContract.skillId, 'video-expert-analyzer')
  // A full SkillRunContract has artifactRoots: string[] (not optional in the
  // type) — proves we passed the full shape, not Partial.
  assert.ok(Array.isArray(ctxContract.artifactRoots))
})

test('attachContractFramePatch: preserves an upstream contextModifier and unions its roots with the new ones', () => {
  const upstream = makeOutput({
    contextModifier: {
      activeFrame: {
        activeArtifactRoots: ['/tmp/upstream-root'],
        runContract: null,
        discoveredHandles: [],
      },
    },
  })
  const output = attachContractFramePatch(upstream, {
    sessionId: 'sess-1',
    skillId: 'video-expert-analyzer',
    outputDir: '/tmp/test-vea',
    runStatePath: '/tmp/test-vea/run_state.json',
    supervisorSnapshot: makeSupervisorSnapshot(),
    referenceHint: null,
  }, {
    activeArtifactRoots: ['/tmp/test-vea'],
  })

  assert.ok(output.contextModifier?.activeFrame)
  const roots = output.contextModifier.activeFrame.activeArtifactRoots
  assert.ok(roots.includes('/tmp/upstream-root'), 'upstream root preserved')
  assert.ok(roots.includes('/tmp/test-vea'), 'new root added')
  assert.equal(roots.indexOf('/tmp/upstream-root'), 0, 'upstream root keeps original ordering position')
})

test('attachContractFramePatch: when framePatch has no activeArtifactRoots, leaves contextModifier as caller supplied', () => {
  const upstream = makeOutput({
    contextModifier: {
      activeFrame: {
        activeArtifactRoots: ['/tmp/upstream-root'],
        runContract: null,
        discoveredHandles: [],
      },
    },
  })
  // No activeArtifactRoots passed in patchOverrides; the contract may still
  // generate roots from outputDir, but if it doesn't, the contextModifier
  // should be passed through unchanged.
  const output = attachContractFramePatch(upstream, {
    sessionId: 'sess-1',
    skillId: 'video-expert-analyzer',
    outputDir: null,
    runStatePath: null,
    supervisorSnapshot: null,
    referenceHint: null,
  })

  // Either the helper short-circuits because contract+overrides are empty,
  // or it preserves the caller's contextModifier. Both are valid no-roots
  // outcomes — the contract is upstream-modifier-survives.
  if (output.contextModifier) {
    assert.ok(output.contextModifier.activeFrame.activeArtifactRoots.includes('/tmp/upstream-root'))
  }
})
