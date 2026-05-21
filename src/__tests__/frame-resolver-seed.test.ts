/**
 * Stage M (M0a) — `deriveSeedArtifactRoots` covers every input the legacy
 * `skill_read_artifact` fallback at `skills-tools.ts:1689-1695` consulted.
 *
 * After M0a, `turn-frame-resolver.ts:228` seeds `frame.activeArtifactRoots`
 * with this helper, which is the precondition for safely removing the
 * fallback (M4+M5).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveSeedArtifactRoots } from '../main/modules/agent-control/runtime-core/turn-frame-resolver'
import type { ActiveSkillContext } from '../main/modules/agent-control/active-skill-context'
import type { SkillRunContract } from '../main/modules/agent-control/contracts/run-contracts'

function makeContext(overrides: Partial<ActiveSkillContext>): ActiveSkillContext {
  return {
    skillId: 'video-expert-analyzer',
    skillName: 'video-expert-analyzer',
    taskRunId: null,
    detachedTaskId: null,
    runStatePath: null,
    outputDir: null,
    sceneScoresPath: null,
    deliveryReportPath: null,
    action: null,
    source: 'supervisor',
    confidence: 80,
    status: null,
    staleBlockerReason: null,
    ...overrides,
  }
}

function makeRunContract(overrides: Partial<SkillRunContract>): SkillRunContract {
  return {
    skillId: 'video-expert-analyzer',
    skillName: null,
    toolName: null,
    action: null,
    actionInput: null,
    originalInput: null,
    sourceUrl: null,
    taskRunId: null,
    detachedTaskId: null,
    jobId: null,
    outputDir: null,
    runStatePath: null,
    artifactRoots: [],
    artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
    status: 'unknown',
    liveness: 'unknown',
    progress: { stage: null, totalUnits: null, completedUnits: null, coverageRatio: null, fingerprint: null },
    blocker: { reason: null, stale: false },
    projectionIdentity: { stableKey: null, supersedesProjectionIds: [] },
    forceLoopGuard: { lastForceToolName: null, lastForceInputDigest: null, lastForceToolDispatchedAt: null, consecutiveForceCount: 0 },
    updatedAt: '2026-05-06T00:00:00.000Z',
    ...overrides,
  }
}

test('deriveSeedArtifactRoots: empty inputs return []', () => {
  assert.deepEqual(deriveSeedArtifactRoots({ context: null, runContract: null }), [])
})

test('deriveSeedArtifactRoots: ActiveSkillContext.outputDir alone seeds one root', () => {
  const roots = deriveSeedArtifactRoots({
    context: makeContext({ outputDir: '/tmp/vea/output' }),
    runContract: null,
  })
  assert.deepEqual(roots, ['/tmp/vea/output'])
})

test('deriveSeedArtifactRoots: covers all 4 ActiveSkillContext path fields (the legacy fallback set)', () => {
  const roots = deriveSeedArtifactRoots({
    context: makeContext({
      outputDir: '/tmp/vea/output',
      runStatePath: '/tmp/vea/output/run_state.json',
      sceneScoresPath: '/tmp/vea/output/scores/scene_scores.json',
      deliveryReportPath: '/tmp/vea/output/delivery/delivery_report.json',
    }),
    runContract: null,
  })
  // outputDir is added first; dirname of the 3 paths follows. /tmp/vea/output
  // is shared by runStatePath dirname and so deduped.
  assert.deepEqual(roots, [
    '/tmp/vea/output',
    '/tmp/vea/output/scores',
    '/tmp/vea/output/delivery',
  ])
})

test('deriveSeedArtifactRoots: runContract additive sources are merged', () => {
  const roots = deriveSeedArtifactRoots({
    context: makeContext({ outputDir: '/tmp/vea/output' }),
    runContract: makeRunContract({
      outputDir: '/tmp/vea/output', // dedupe with context
      runStatePath: '/tmp/vea/output/run_state.json',
      artifactRoots: ['/tmp/vea/output', '/tmp/extras/X'],
      artifactPaths: {
        sceneScoresPath: '/tmp/vea/output/scenes/scene_scores.json',
        deliveryReportPath: null,
      },
    }),
  })
  assert.deepEqual(roots, [
    '/tmp/vea/output',
    '/tmp/extras/X',
    '/tmp/vea/output/scenes',
  ])
})

test('deriveSeedArtifactRoots: ignores blank/whitespace strings', () => {
  const roots = deriveSeedArtifactRoots({
    context: makeContext({ outputDir: '   ', runStatePath: '' }),
    runContract: null,
  })
  assert.deepEqual(roots, [])
})

test('deriveSeedArtifactRoots: trims whitespace on real strings (input hygiene)', () => {
  const roots = deriveSeedArtifactRoots({
    context: makeContext({ outputDir: '  /tmp/vea/output  ' }),
    runContract: null,
  })
  assert.deepEqual(roots, ['/tmp/vea/output'])
})

test('deriveSeedArtifactRoots: preserves first-seen order across context + contract', () => {
  // Context-first ordering is load-bearing: its outputDir appears first,
  // followed by context-derived dirnames, then contract-derived additions.
  const roots = deriveSeedArtifactRoots({
    context: makeContext({
      outputDir: '/ctx/output',
      runStatePath: '/ctx/state/run_state.json',
    }),
    runContract: makeRunContract({
      outputDir: '/contract/output',
      artifactRoots: ['/contract/extra'],
    }),
  })
  assert.deepEqual(roots, [
    '/ctx/output',
    '/ctx/state',
    '/contract/output',
    '/contract/extra',
  ])
})
