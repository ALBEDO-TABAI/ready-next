import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildContinuationStateFromProjection,
  parseContinuationControlText,
  selectContinuationProjection,
} from '../main/modules/agent-control/continuation-state'
import type { TaskProjectionRecord } from '../main/modules/agent-control/run-contracts'

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

test('parseContinuationControlText strips continuation control lines and keeps only the real user instruction', () => {
  const parsed = parseContinuationControlText([
    '继续当前任务。',
    'Task ID: task-prev',
    'Execution ID: exec-prev',
    'Step ID: approve',
    '继续前上下文：等待确认后继续执行',
    '我的回复：可以继续',
  ].join('\n'))

  assert.equal(parsed.explicitTaskId, 'task-prev')
  assert.equal(parsed.executionId, 'exec-prev')
  assert.equal(parsed.stepId, 'approve')
  assert.equal(parsed.blockedReason, '等待确认后继续执行')
  assert.equal(parsed.responseText, '可以继续')
  assert.equal(parsed.sanitizedUserText, '继续当前任务。\n可以继续')
})

test('selectContinuationProjection falls back to the active blocked task when the message does not include an explicit task id', () => {
  const blocked = createProjection()
  const done = createProjection({
    taskId: 'task-done',
    status: 'done',
    interactionState: 'running',
    resumableActions: ['cancel'],
    blockedReason: null,
  })

  const selected = selectContinuationProjection({
    projections: [done, blocked],
    userText: '继续刚才那个任务',
  })

  assert.equal(selected?.taskId, 'task-prev')
})

test('selectContinuationProjection prefers the most recently updated continuation candidate when multiple blocked tasks exist', () => {
  const older = createProjection({
    taskId: 'task-older',
    updatedAt: '2026-04-17T00:00:01.000Z',
    blockedReason: '旧任务待继续',
  })
  const newer = createProjection({
    taskId: 'task-newer',
    updatedAt: '2026-04-17T00:00:03.000Z',
    blockedReason: '新任务待继续',
  })

  const selected = selectContinuationProjection({
    projections: [older, newer],
    userText: '继续刚才那个任务',
  })

  assert.equal(selected?.taskId, 'task-newer')
})

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
