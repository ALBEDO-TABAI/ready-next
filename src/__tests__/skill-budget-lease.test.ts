import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createToolExecutionOutput } from '../main/modules/agent-control/tool-result-types'
import { scoreSkillProgress } from '../main/modules/agent-control/progress-scorer'
import { scoreSkillWaste } from '../main/modules/agent-control/waste-scorer'
import {
  createSkillBudgetLeaseState,
  evaluateSkillBudgetLease,
} from '../main/modules/agent-control/skill-budget-lease-controller'
import type { SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skill-task-supervisor'

function hashInput(input: unknown): string {
  return createHash('sha1').update(JSON.stringify(input ?? null)).digest('hex').slice(0, 16)
}

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
  const input = { outputDir: '/tmp/out' }
  const argsHash = hashInput(input)
  const waste = scoreSkillWaste({
    recentToolCalls: [
      { name: 'skill_inspect_run_state', argsHash },
      { name: 'skill_inspect_run_state', argsHash },
    ],
    toolCalls: [{ name: 'skill_inspect_run_state', input }],
    executedTools: [{
      name: 'skill_inspect_run_state',
      input,
      result: createToolExecutionOutput('', {
        data: { errorKind: 'input_validation' },
      }),
    }],
    currentFingerprint: 'same-fingerprint',
    previousFingerprint: 'same-fingerprint',
  })

  assert.ok(waste.score >= 2)
  assert.equal(waste.repeatedToolCallStreak, 3)
  assert.equal(waste.repeatedUnchangedObservation, true)
  assert.equal(waste.recoverableErrorKind, 'input_validation')
  assert.equal(waste.recoverableErrorCount, 1)
  assert.equal(waste.repeatedRecoverableError, false)
  assert.ok(waste.reasons.includes('repeated_tool_call'))
  assert.ok(waste.reasons.includes('unchanged_run_state_or_artifact'))
})

test('waste scorer penalizes repeated shell inspection when a typed resume action is preferred', () => {
  const waste = scoreSkillWaste({
    preferredTypedSkillToolName: 'skill_video_expert_pipeline',
    recentToolCalls: [
      { name: 'skill_run_shell', argsHash: 'cat-run-state' },
    ],
    toolCalls: [
      { name: 'skill_run_shell', input: { command: 'cat /tmp/vea/run_state.json' } },
    ],
  })

  assert.ok(waste.score >= 2)
  assert.ok(waste.reasons.includes('shell_loop_while_typed_action_preferred'))
})

test('waste scorer only treats the third same recoverable error as repeated', () => {
  const first = scoreSkillWaste({
    executedTools: [{
      name: 'skill_run_shell',
      result: createToolExecutionOutput('', { data: { errorKind: 'input_validation' } }),
    }],
  })
  assert.equal(first.recoverableErrorKind, 'input_validation')
  assert.equal(first.recoverableErrorCount, 1)
  assert.equal(first.repeatedRecoverableError, false)
  assert.doesNotMatch(first.reasons.join(','), /recoverable_error_repeated/)

  let lease = createSkillBudgetLeaseState({ iteration: 0 })
  lease = evaluateSkillBudgetLease({
    state: lease,
    iteration: 1,
    progress: { score: 0, reasons: [], fingerprint: null, fingerprintChanged: false, milestoneChanged: false },
    waste: first,
  }).state
  lease = evaluateSkillBudgetLease({
    state: lease,
    iteration: 2,
    progress: { score: 0, reasons: [], fingerprint: null, fingerprintChanged: false, milestoneChanged: false },
    waste: scoreSkillWaste({
      executedTools: [{
        name: 'skill_run_shell',
        result: createToolExecutionOutput('', { data: { errorKind: 'cmd_not_allowlisted' } }),
      }],
    }),
  }).state
  assert.notEqual(lease.decision, 'pause')

  const sameKind = scoreSkillWaste({
    executedTools: [{
      name: 'skill_run_shell',
      result: createToolExecutionOutput('', { data: { errorKind: 'input_validation' } }),
    }],
  })
  lease = createSkillBudgetLeaseState({ iteration: 0 })
  for (let i = 0; i < 3; i += 1) {
    lease = evaluateSkillBudgetLease({
      state: lease,
      iteration: i + 1,
      progress: { score: 0, reasons: [], fingerprint: null, fingerprintChanged: false, milestoneChanged: false },
      waste: sameKind,
    }).state
  }
  assert.equal(lease.decision, 'pause')
  assert.equal(lease.reason, 'recoverable_error_repeated')
})

test('lease controller pauses repeated tool calls immediately', () => {
  const lease = createSkillBudgetLeaseState({ iteration: 0 })
  const input = { outputDir: '/tmp/out' }
  const argsHash = hashInput(input)
  const waste = scoreSkillWaste({
    recentToolCalls: [
      { name: 'skill_inspect_run_state', argsHash },
      { name: 'skill_inspect_run_state', argsHash },
    ],
    toolCalls: [{ name: 'skill_inspect_run_state', input }],
  })

  const evaluation = evaluateSkillBudgetLease({
    state: lease,
    iteration: 1,
    progress: { score: 0, reasons: [], fingerprint: null, fingerprintChanged: false, milestoneChanged: false },
    waste,
  })

  assert.equal(waste.repeatedToolCallStreak, 3)
  assert.equal(evaluation.decision, 'pause')
  assert.equal(evaluation.reason, 'tool_repetition')
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

test('lease controller does not close failed or cancelled terminal snapshots as success', () => {
  const noWaste = {
    score: 0,
    reasons: [],
    repeatedToolCallStreak: 0,
    repeatedUnchangedObservation: false,
    recoverableErrorKind: null,
    recoverableErrorCount: 0,
    repeatedRecoverableError: false,
  }
  for (const status of ['failed', 'cancelled'] as const) {
    const evaluation = evaluateSkillBudgetLease({
      state: createSkillBudgetLeaseState({ iteration: 0 }),
      iteration: 1,
      progress: { score: 0, reasons: [], fingerprint: null, fingerprintChanged: false, milestoneChanged: false },
      waste: noWaste,
      snapshot: snapshot({
        status,
        closeAllowed: true,
        hasLiveWork: false,
        hasRecentProgress: false,
      }),
    })

    assert.equal(evaluation.decision, 'pause')
    assert.equal(evaluation.reason, `supervisor_${status}`)
  }
})
