import assert from 'node:assert/strict'
import test from 'node:test'

import { createToolExecutionOutput } from '../main/modules/agent-control/tool-result-types'
import { scoreSkillProgress } from '../main/modules/agent-control/progress-scorer'
import { scoreSkillWaste } from '../main/modules/agent-control/waste-scorer'
import {
  createSkillBudgetLeaseState,
  evaluateSkillBudgetLease,
} from '../main/modules/agent-control/skill-budget-lease-controller'
import type { SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skill-task-supervisor'

function snapshot(overrides: Partial<SkillTaskSupervisorSnapshot>): SkillTaskSupervisorSnapshot {
  return {
    taskRunId: null,
    detachedTaskId: null,
    skillId: 'video-expert-analyzer',
    scopeId: 'scope',
    sessionId: 'scope',
    action: 'video_expert_pipeline',
    status: 'background_running',
    hasLiveWork: false,
    hasRecentProgress: false,
    closeAllowed: false,
    ambiguous: false,
    stale: false,
    outputDir: '/tmp/out',
    runStatePath: '/tmp/out/run_state.json',
    sceneScoresPath: null,
    deliveryReportPath: null,
    progress: {},
    blockers: [],
    pauseReason: null,
    resumePayload: null,
    sourceObservations: [],
    progressFingerprint: null,
    observedAt: '2026-04-28T00:00:00.000Z',
    lastProgressAt: null,
    ...overrides,
  }
}

test('progress scorer rewards real stage, scene, coverage, artifact, and fingerprint changes', () => {
  const previous = snapshot({
    progressFingerprint: 'stage:a:1',
    progress: { currentStage: 'prepare', completedScenes: 1, coverageRatio: 0.1, updatedAt: 't1' },
  })
  const current = snapshot({
    progressFingerprint: 'stage:b:2',
    progress: { currentStage: 'score', completedScenes: 2, coverageRatio: 0.2, updatedAt: 't2' },
  })
  const score = scoreSkillProgress({
    previousFingerprint: previous.progressFingerprint,
    previousSnapshot: previous,
    currentSnapshot: current,
    executedTools: [{
      name: 'skill_video_expert_pipeline',
      result: createToolExecutionOutput('', {
        data: { runStatePath: '/tmp/out/run_state.json', currentStage: 'score' },
      }),
    }],
  })

  assert.ok(score.score >= 2)
  assert.equal(score.fingerprintChanged, true)
  assert.equal(score.milestoneChanged, true)
  assert.ok(score.reasons.includes('completed_scenes_increased'))
  assert.ok(score.reasons.includes('artifact_path_returned'))
})

test('progress scorer builds a stable fingerprint from typed milestone outputs', () => {
  const score = scoreSkillProgress({
    previousFingerprint: null,
    currentSnapshot: snapshot({ progressFingerprint: null }),
    executedTools: [{
      name: 'skill_video_expert_pipeline',
      result: createToolExecutionOutput('', {
        data: {
          status: 'running',
          currentStage: 'score_batches',
          outputDir: '/tmp/vea/out',
          runStatePath: '/tmp/vea/out/run_state.json',
        },
      }),
    }],
  })

  assert.equal(score.fingerprintChanged, true)
  assert.equal(score.milestoneChanged, true)
  assert.match(score.fingerprint || '', /skill_video_expert_pipeline:score_batches/)
  assert.match(score.fingerprint || '', /\/tmp\/vea\/out\/run_state\.json/)
})
test('waste scorer flags repeated tools, unchanged observations, and recoverable errors', () => {
  const waste = scoreSkillWaste({
    recentToolCalls: [
      { name: 'skill_inspect_run_state', argsHash: 'same' },
      { name: 'skill_inspect_run_state', argsHash: 'same' },
    ],
    toolCalls: [{ name: 'skill_inspect_run_state', input: { outputDir: '/tmp/out' } }],
    executedTools: [{
      name: 'skill_inspect_run_state',
      input: { outputDir: '/tmp/out' },
      result: createToolExecutionOutput('', {
        data: { errorKind: 'input_validation' },
      }),
    }],
    currentFingerprint: 'same-fingerprint',
    previousFingerprint: 'same-fingerprint',
  })

  assert.ok(waste.score >= 2)
  assert.equal(waste.repeatedUnchangedObservation, true)
  assert.equal(waste.repeatedRecoverableError, true)
  assert.ok(waste.reasons.includes('unchanged_run_state_or_artifact'))
})

test('lease controller renews on progress, pauses loops, and hands off weak live work', () => {
  let lease = createSkillBudgetLeaseState({ iteration: 0 })
  const progress = {
    score: 2,
    reasons: ['fingerprint_changed'],
    fingerprint: 'fp-1',
    fingerprintChanged: true,
    milestoneChanged: true,
  }
  const noWaste = {
    score: 0,
    reasons: [],
    repeatedUnchangedObservation: false,
    repeatedRecoverableError: false,
  }
  const renewed = evaluateSkillBudgetLease({
    state: lease,
    iteration: 19,
    progress,
    waste: noWaste,
    snapshot: snapshot({ progressFingerprint: 'fp-1' }),
  })
  assert.equal(renewed.decision, 'renew')
  assert.equal(renewed.state.currentLeaseEndIteration, 40)

  lease = renewed.state
  for (let i = 0; i < 3; i += 1) {
    lease = evaluateSkillBudgetLease({
      state: lease,
      iteration: 20 + i,
      progress: { ...progress, score: 0, fingerprintChanged: false, milestoneChanged: false },
      waste: { ...noWaste, score: 2, repeatedUnchangedObservation: true },
      snapshot: snapshot({ progressFingerprint: 'fp-1' }),
    }).state
  }
  assert.equal(lease.decision, 'pause')
  assert.equal(lease.reason, 'unchanged_observation_repeated')

  const handoff = evaluateSkillBudgetLease({
    state: createSkillBudgetLeaseState({ iteration: 0 }),
    iteration: 20,
    progress: { ...progress, score: 0, fingerprint: 'fp-live', fingerprintChanged: false, milestoneChanged: false },
    waste: noWaste,
    snapshot: snapshot({
      hasLiveWork: true,
      hasRecentProgress: true,
      detachedTaskId: 'dst-live',
      resumePayload: { detachedTaskId: 'dst-live' },
    }),
  })
  assert.equal(handoff.decision, 'handoff_background')
})
