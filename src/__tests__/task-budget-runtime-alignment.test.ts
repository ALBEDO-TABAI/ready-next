import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyRunBudgetHint,
  createRunBudgetSeed,
  createTaskBudgetRuntime,
  ensureLongRunningTaskBudgetCapacity,
  getRemainingToolCallBudget,
  rebindTaskBudgetRuntime,
} from '../main/modules/agent-control/task-projection/run-budget-policy'

test('task budget runtime rebinds bootstrap budgets to the resolved task preset while preserving usage', () => {
  const bootstrap = createTaskBudgetRuntime('short_task', {
    budget: createRunBudgetSeed('short_task'),
    usage: {
      iterationsUsed: 2,
      toolCallsUsed: 1,
      parallelToolGroupsUsed: 0,
    },
    bootstrapBudget: true,
  })

  const rebound = rebindTaskBudgetRuntime(bootstrap, 'media_task', {
    bootstrapBudget: false,
  })

  assert.equal(rebound.taskType, 'media_task')
  assert.equal(rebound.bootstrapBudget, false)
  assert.equal(rebound.budget.maxIterations, 60)
  assert.equal(rebound.budget.maxToolCalls, 60)
  assert.deepEqual(rebound.usage, bootstrap.usage)
})

test('browser-capable bootstrap gets a high emergency ceiling without changing task semantics or usage', () => {
  const bootstrap = createTaskBudgetRuntime('short_task', {
    budget: createRunBudgetSeed('short_task'),
    usage: {
      iterationsUsed: 7,
      toolCallsUsed: 11,
      parallelToolGroupsUsed: 1,
    },
    bootstrapBudget: true,
  })

  const widened = ensureLongRunningTaskBudgetCapacity(bootstrap)

  assert.equal(widened.taskType, 'short_task')
  assert.equal(widened.bootstrapBudget, true)
  assert.equal(widened.budget.maxIterations, 220)
  assert.equal(widened.budget.maxToolCalls, 220)
  assert.deepEqual(widened.usage, bootstrap.usage)
  assert.equal(widened.warningLevel, 'none')
})

test('durable browser research rebinds the widened bootstrap to research without losing usage', () => {
  const bootstrap = ensureLongRunningTaskBudgetCapacity(createTaskBudgetRuntime('short_task', {
    budget: createRunBudgetSeed('short_task'),
    usage: {
      iterationsUsed: 7,
      toolCallsUsed: 11,
      parallelToolGroupsUsed: 1,
    },
    bootstrapBudget: true,
  }))

  const rebound = rebindTaskBudgetRuntime(bootstrap, 'research', { bootstrapBudget: false })

  assert.equal(rebound.taskType, 'research')
  assert.equal(rebound.bootstrapBudget, false)
  assert.equal(rebound.budget.maxIterations, 220)
  assert.equal(rebound.budget.maxToolCalls, 220)
  assert.deepEqual(rebound.usage, bootstrap.usage)
})

test('task budget runtime applies reserveToolCalls hints to remaining tool-call headroom', () => {
  const runtime = createTaskBudgetRuntime('multi_step_task', {
    budget: createRunBudgetSeed('multi_step_task'),
  })

  const hinted = applyRunBudgetHint(runtime, {
    reserveToolCalls: 3,
  })

  assert.equal(hinted.budget.reservedToolCalls, 3)
  // skill-resume C2: multi_step_task budget reduced 60→40, so remaining is 40-3=37
  assert.equal(getRemainingToolCallBudget(hinted), 37)
})
