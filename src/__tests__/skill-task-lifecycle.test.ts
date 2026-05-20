import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSkillTaskLifecycleSignal,
  isRelevantSkillTaskSnapshot,
} from '../main/modules/agent-control/skills/skill-task-lifecycle'
import type { SkillTaskSupervisorSnapshot } from '../main/modules/agent-control/skills/skill-task-supervisor'

function makeSnapshot(overrides: Partial<SkillTaskSupervisorSnapshot>): SkillTaskSupervisorSnapshot {
  return {
    taskRunId: null,
    detachedTaskId: null,
    skillId: null,
    scopeId: null,
    sessionId: null,
    action: null,
    status: 'unknown',
    liveness: null,
    hasLiveWork: false,
    hasRecentProgress: false,
    closeAllowed: false,
    ambiguous: false,
    stale: false,
    outputDir: null,
    runStatePath: null,
    sceneScoresPath: null,
    deliveryReportPath: null,
    progress: {},
    blockers: [],
    pauseReason: null,
    resumePayload: null,
    sourceObservations: [],
    progressFingerprint: null,
    observedAt: '2026-04-28T02:00:00.000Z',
    lastProgressAt: null,
    ...overrides,
  }
}

test('empty supervisor snapshots are not relevant lifecycle signals', () => {
  const snapshot = makeSnapshot({})

  assert.equal(isRelevantSkillTaskSnapshot(snapshot), false)
  assert.equal(buildSkillTaskLifecycleSignal({ snapshot, reason: 'budget_exhausted' }), null)
})

test('background running skill tasks map to checkpoint background with resume handle', () => {
  const signal = buildSkillTaskLifecycleSignal({
    reason: 'background_running',
    snapshot: makeSnapshot({
      taskRunId: 'str-1',
      detachedTaskId: 'dst-1',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      status: 'running',
      liveness: 'background',
      hasLiveWork: true,
      outputDir: '/tmp/ready/output',
      runStatePath: '/tmp/ready/output/run_state.json',
      pauseReason: 'background_running',
      progressFingerprint: 'fp-1',
      resumePayload: {
        jobId: 'job-1',
        outputDir: '/tmp/ready/output',
        runStatePath: '/tmp/ready/output/run_state.json',
      },
    }),
  })

  assert.ok(signal)
  assert.equal(signal.phase, 'checkpoint')
  assert.equal(signal.waitingFor, 'background')
  assert.equal(signal.interactionState, 'suspended')
  assert.deepEqual(signal.resumableActions, ['continue', 'cancel'])
  assert.deepEqual(signal.taskContinuation, {
    taskId: 'str-1',
    taskRunId: 'str-1',
    detachedTaskId: 'dst-1',
    skillId: 'video-expert-analyzer',
    action: 'video_expert_pipeline',
    jobId: 'job-1',
    outputDir: '/tmp/ready/output',
    runStatePath: '/tmp/ready/output/run_state.json',
    pauseReason: 'background_running',
    progressFingerprint: 'fp-1',
    blockerType: 'background_running',
    todoTitle: 'video_expert_pipeline',
  })
})

test('budget paused recoverable skill tasks stay checkpoint instead of done', () => {
  const signal = buildSkillTaskLifecycleSignal({
    reason: 'budget_exhausted',
    snapshot: makeSnapshot({
      taskRunId: 'str-budget',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      status: 'running',
      hasLiveWork: false,
      runStatePath: '/tmp/ready/run_state.json',
      resumePayload: {
        taskRunId: 'str-budget',
        runStatePath: '/tmp/ready/run_state.json',
      },
    }),
  })

  assert.ok(signal)
  assert.equal(signal.state, 'budget_paused')
  assert.equal(signal.phase, 'checkpoint')
  assert.equal(signal.waitingFor, 'background')
  assert.equal(signal.taskContinuation?.pauseReason, 'budget_exhausted')
  assert.deepEqual(signal.resumableActions, ['continue', 'retry', 'cancel'])
})

test('terminal close-allowed snapshots can close as done', () => {
  const signal = buildSkillTaskLifecycleSignal({
    reason: 'background_running',
    snapshot: makeSnapshot({
      taskRunId: 'str-done',
      skillId: 'video-expert-analyzer',
      status: 'completed',
      closeAllowed: true,
    }),
  })

  assert.ok(signal)
  assert.equal(signal.phase, 'done')
  assert.equal(signal.waitingFor, 'none')
  assert.equal(signal.taskContinuation, null)
})

test('failed and cancelled close-allowed snapshots keep recovery handles out of the success path', () => {
  const failed = buildSkillTaskLifecycleSignal({
    reason: 'budget_exhausted',
    snapshot: makeSnapshot({
      taskRunId: 'str-failed',
      detachedTaskId: 'dst-failed',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      status: 'failed',
      closeAllowed: true,
      outputDir: '/tmp/failed',
      runStatePath: '/tmp/failed/run_state.json',
      blockers: ['provider rejected request'],
    }),
  })

  assert.ok(failed)
  assert.equal(failed.phase, 'error')
  assert.deepEqual(failed.resumableActions, ['retry', 'cancel'])
  assert.equal(failed.taskContinuation?.taskRunId, 'str-failed')
  assert.equal(failed.taskContinuation?.detachedTaskId, 'dst-failed')
  assert.equal(failed.taskContinuation?.runStatePath, '/tmp/failed/run_state.json')

  const cancelled = buildSkillTaskLifecycleSignal({
    reason: 'budget_exhausted',
    snapshot: makeSnapshot({
      taskRunId: 'str-cancelled',
      skillId: 'video-expert-analyzer',
      status: 'killed',
      closeAllowed: true,
      outputDir: '/tmp/cancelled',
    }),
  })

  assert.ok(cancelled)
  assert.equal(cancelled.phase, 'cancelled')
  assert.equal(cancelled.taskContinuation?.taskRunId, 'str-cancelled')
  assert.equal(cancelled.taskContinuation?.outputDir, '/tmp/cancelled')
})
