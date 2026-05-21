import assert from 'node:assert/strict'
import test from 'node:test'

import {
  advanceTaskStepProgress,
  detectTaskStepCompletionCue,
  initializeTaskStepProgress,
} from '../main/modules/agent-control/runtime-core/task-step-runtime'

test('task step runtime initializes planner steps with the first step running', () => {
  const initial = initializeTaskStepProgress([
    { id: 'step-1', title: '收集', description: '收集输入', budget: 8 },
    { id: 'step-2', title: '整理', description: '整理输出', budget: 8 },
  ])

  assert.equal(initial.currentStepId, 'step-1')
  assert.equal(initial.steps[0]?.status, 'running')
  assert.equal(initial.steps[1]?.status, 'pending')
})

test('task step runtime advances to the next step and records per-step summary output', () => {
  const initial = initializeTaskStepProgress([
    { id: 'step-1', title: '收集', description: '收集输入', budget: 8 },
    { id: 'step-2', title: '整理', description: '整理输出', budget: 10 },
  ])

  const next = advanceTaskStepProgress({
    steps: initial.steps,
    currentStepId: initial.currentStepId,
    totalIterations: 24,
    summary: '步骤 1 完成，已收齐输入。',
    timestamp: '2026-04-16T00:00:00.000Z',
  })

  assert.equal(next.advanced, true)
  assert.equal(next.currentStepId, 'step-2')
  assert.equal(next.steps[0]?.status, 'done')
  assert.equal(next.steps[0]?.detail, '步骤 1 完成，已收齐输入。')
  assert.equal(next.steps[0]?.updatedAt, '2026-04-16T00:00:00.000Z')
  assert.equal(next.steps[1]?.status, 'running')
  assert.equal(next.stepBudget?.stepId, 'step-2')
  assert.equal(next.stepBudget?.maxIterations, 10)
})

test('task step runtime detects explicit model completion cues', () => {
  assert.equal(detectTaskStepCompletionCue('步骤 2 完成，请继续下一步。'), true)
  assert.equal(
    detectTaskStepCompletionCue('当前步骤已完成。', { id: 'step-2', title: '整理输出', description: '整理输出' }),
    true,
  )
  assert.equal(detectTaskStepCompletionCue('我还在处理中。'), false)
})
