import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildContinuationStateFromProjection
} from '../main/modules/agent-control/contracts/continuation-state'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'

function createProjection(overrides?: Partial<TaskProjectionRecord>): TaskProjectionRecord {
  return {
    taskId: 'task-prev',
    scopeId: 'scope-test',
    runId: 'run-prev',
    taskType: 'short_task',
    module: 'skill',
    taskTitle: '继续技能任务',
    taskSummary: '等待确认后继续执行',
    status: 'blocked',
    interactionState: 'awaiting_confirmation',
    steps: [
      {
        id: 'approve',
        title: '确认继续执行',
        description: '确认当前技能执行可以继续',
        status: 'running',
        updatedAt: '2026-04-17T00:00:00.000Z',
      },
    ],
    currentStepId: 'approve',
    budget: {
      taskType: 'short_task',
      maxIterations: 24,
      maxToolCalls: 24,
      maxParallelToolGroups: 5,
      iterationsUsed: 9,
      toolCallsUsed: 3,
      parallelToolGroupsUsed: 1,
      stepBudget: {
        stepId: 'approve',
        maxIterations: 6,
        remainingIterations: 2,
      },
    },
    budgetUsagePercent: 42,
    budgetWarningLevel: 'none',
    recoveryHistory: [],
    degradationReason: null,
    blockedReason: '等待确认后继续执行',
    resumableActions: ['continue', 'cancel'],
    continuationRef: {
      taskId: 'task-prev',
      executionId: 'exec-prev',
      stepId: 'approve',
      blockerType: 'need_confirmation',
    },
    recentArtifacts: [],
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
    ...overrides,
  }
}

test('buildContinuationStateFromProjection keeps a single continuation identity across projection and restore data', () => {
  const projection = createProjection()

  const continuationState = buildContinuationStateFromProjection(projection, {
    executionId: 'exec-prev',
    stepId: 'approve',
    blockedReason: '等待确认后继续执行',
  })

  assert.equal(continuationState.taskId, 'task-prev')
  assert.equal(continuationState.currentStepId, 'approve')
  assert.equal(continuationState.continuationRef?.taskId, 'task-prev')
  assert.equal(continuationState.continuationRef?.executionId, 'exec-prev')
  assert.equal(continuationState.blockedReason, '等待确认后继续执行')
  assert.deepEqual(continuationState.resumableActions, ['continue', 'cancel'])
})

test('buildContinuationStateFromProjection preserves durable skill handles without execution id', () => {
  const projection = createProjection({
    continuationRef: {
      taskId: 'task-prev',
      resumeKind: 'paused',
      blockerType: 'background_running',
      pauseReason: 'budget_exhausted',
      detachedTaskId: 'dst-1234',
      taskRunId: 'e-1234',
      jobId: 'job-1234',
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      runStatePath: '/tmp/vea/run_state.json',
      outputDir: '/tmp/vea',
      progressFingerprint: 'fp-1234',
    },
  })

  const continuationState = buildContinuationStateFromProjection(projection)

  assert.equal(continuationState.continuationRef?.taskId, 'task-prev')
  assert.equal(continuationState.continuationRef?.executionId, null)
  assert.equal(continuationState.continuationRef?.detachedTaskId, 'dst-1234')
  assert.equal(continuationState.continuationRef?.taskRunId, 'e-1234')
  assert.equal(continuationState.continuationRef?.runStatePath, '/tmp/vea/run_state.json')
  assert.equal(continuationState.continuationRef?.outputDir, '/tmp/vea')
  assert.equal(continuationState.continuationRef?.resumeKind, 'paused')
  assert.equal(continuationState.continuationRef?.pauseReason, 'budget_exhausted')
})
