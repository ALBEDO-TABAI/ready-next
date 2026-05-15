import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyContinuationIntentToState,
  buildContinuationStateFromProjection,
  normalizeContinuationIntent,
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

test('selectContinuationProjection ignores blocked skill shells with no continuation anchor', () => {
  const emptyShell = createProjection({
    taskId: 'task-empty-shell',
    taskSummary: '本轮没有可用的 skill 工具',
    blockedReason: '未解析到可用的 skill_* 工具',
    resumableActions: ['retry', 'cancel'],
    continuationRef: null,
  })
  const reconciledShell = createProjection({
    taskId: 'task-reconciled-shell',
    taskSummary: '本轮没有可用的 skill 工具',
    blockedReason: '任务状态已过期，缺少可续跑句柄',
    resumableActions: ['none'],
    continuationRef: null,
    updatedAt: '2026-04-17T00:00:03.000Z',
  })

  const selected = selectContinuationProjection({
    projections: [emptyShell, reconciledShell],
    userText: '继续刚才那个任务',
  })

  assert.equal(selected, null)
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

test('buildContinuationStateFromProjection preserves durable skill handles without execution id', () => {
  const projection = createProjection({
    continuationRef: {
      taskId: 'task-prev',
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
  assert.equal(continuationState.continuationRef?.pauseReason, 'budget_exhausted')
})

test('normalizeContinuationIntent trims values and requires a task id', () => {
  const normalized = normalizeContinuationIntent({
    taskId: '  task-prev  ',
    executionId: '  exec-prev  ',
    stepId: '  approve  ',
    blockedReason: '  等待确认  ',
    responseText: '  可以继续  ',
    detachedTaskId: '  dst-1234  ',
    runStatePath: '  /tmp/vea/run_state.json  ',
    outputDir: '  /tmp/vea  ',
    pauseReason: '  budget_exhausted  ',
  })

  assert.deepEqual(normalized, {
    taskId: 'task-prev',
    executionId: 'exec-prev',
    stepId: 'approve',
    blockedReason: '等待确认',
    responseText: '可以继续',
    detachedTaskId: 'dst-1234',
    runStatePath: '/tmp/vea/run_state.json',
    outputDir: '/tmp/vea',
    pauseReason: 'budget_exhausted',
  })
  assert.equal(normalizeContinuationIntent({ taskId: '   ' }), null)
})

test('Stage Q: normalizeContinuationIntent preserves childRunId', () => {
  // Audit §F-6 / Stage Q PR-4: childRunId must survive
  // `normalizeContinuationIntent`, otherwise `runtime.buildContinuationIntent`
  // sees an empty handle and refuses (false negative).
  const normalized = normalizeContinuationIntent({
    taskId: 'task-123',
    childRunId: 'cr-q-test',
  })
  assert.ok(normalized)
  assert.equal(normalized!.childRunId, 'cr-q-test')
})

test('Stage Q: normalizeContinuationRef-via-applyContinuationIntent preserves childRunId-only handle', () => {
  // Pin: a childRunId-only intent does NOT collapse to null at the
  // continuationRef layer. Without this fix Codex round 2 found that
  // `applyContinuationIntentToState` discarded childRunId because the
  // condition didn't include it.
  const baseState = buildContinuationStateFromProjection(createProjection(), {})
  const applied = applyContinuationIntentToState(baseState, {
    taskId: baseState.taskId,
    childRunId: 'cr-q-only',
  })
  assert.ok(applied.continuationRef, 'childRunId alone must trigger continuationRef')
  assert.equal(applied.continuationRef!.childRunId, 'cr-q-only')
})

test('applyContinuationIntentToState keeps task identity while applying explicit continuation overrides', () => {
  const baseState = buildContinuationStateFromProjection(createProjection(), {
    executionId: 'exec-prev',
    stepId: 'approve',
    blockedReason: '等待确认后继续执行',
  })

  const resolved = applyContinuationIntentToState(baseState, {
    taskId: 'task-prev',
    executionId: 'exec-next',
    stepId: 'deliver',
    blockedReason: '已经补充完结果',
    responseText: '可以继续',
  })

  assert.equal(resolved.taskId, 'task-prev')
  assert.equal(resolved.currentStepId, 'deliver')
  assert.equal(resolved.blockedReason, '已经补充完结果')
  assert.equal(resolved.continuationRef?.taskId, 'task-prev')
  assert.equal(resolved.continuationRef?.executionId, 'exec-next')
  assert.equal(resolved.continuationRef?.stepId, 'deliver')
})
