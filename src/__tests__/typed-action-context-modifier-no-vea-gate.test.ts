/**
 * Stage M (M5a-typed-gate) — typed-action contextModifier emission is not
 * gated to VEA tool names. The structural no-name-allowlist check lives in
 * `check-context-modifier-shape.cjs`; this file pins the behavior of the
 * pure context-modifier builder.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTypedActionContextModifier } from '../main/modules/tools/skills-tools'
import type { SkillRunContract } from '../main/modules/agent-control/run-contracts'

function makeContract(skillId: string): SkillRunContract {
  return {
    skillId,
    skillName: skillId,
    toolName: `skill_${skillId.replace(/-/g, '_')}_action`,
    action: 'rss_status',
    actionInput: {},
    originalInput: {},
    sourceUrl: null,
    taskRunId: 'task-1',
    detachedTaskId: null,
    jobId: null,
    outputDir: '/tmp/ready/non-vea-output',
    runStatePath: '/tmp/ready/non-vea-output/run_state.json',
    artifactRoots: ['/tmp/ready/non-vea-output'],
    artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
    status: 'running',
    liveness: 'running_process',
    progress: { stage: null, totalUnits: null, completedUnits: null, coverageRatio: null, fingerprint: null },
    blocker: { reason: null, stale: false },
    projectionIdentity: { stableKey: null, supersedesProjectionIds: [] },
    forceLoopGuard: {
      lastForceToolName: null,
      lastForceInputDigest: null,
      lastForceToolDispatchedAt: null,
      consecutiveForceCount: 0,
    },
    updatedAt: '2026-05-06T00:00:00.000Z',
  }
}

test('typed-action contextModifier is emitted for non-VEA skills when outputDir is set', () => {
  const contract = makeContract('lets-go-rss')
  const modifier = buildTypedActionContextModifier({
    outputDir: '/tmp/ready/non-vea-output',
    contract,
  })

  assert.deepEqual(modifier?.activeFrame?.activeArtifactRoots, ['/tmp/ready/non-vea-output'])
  assert.equal(modifier?.activeFrame?.runContract, contract)
})

test('typed-action contextModifier is omitted when outputDir is missing', () => {
  const modifier = buildTypedActionContextModifier({
    outputDir: null,
    contract: makeContract('lets-go-rss'),
  })

  assert.equal(modifier, null)
})
