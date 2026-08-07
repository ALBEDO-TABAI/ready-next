import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyLongSkillTaskBudgetSeed,
  applyRunBudgetHint,
  canUseParallelToolGroup,
  consumeIterationBudget,
  consumeParallelGroupBudget,
  consumeToolCallBudget,
  createRunBudgetSeed,
  createStepBudgetState,
  createTaskBudgetRuntime,
  freezeBudgetRuntime,
  getBudgetUsagePercent,
  getBudgetWarningLevel,
  getRemainingToolCallBudget,
  refundIterationBudget,
  resumeBudgetRuntime,
} from '../main/modules/agent-control/task-projection/run-budget-policy'

test('run budget policy applies hints to the active step budget instead of inflating the global task seed', () => {
  const seed = createRunBudgetSeed()
  const runtime = createTaskBudgetRuntime('short_task', {
    budget: seed,
    stepBudget: createStepBudgetState({
      stepId: 'step-1',
      totalIterations: seed.maxIterations,
      suggestedMaxIterations: 8,
    }),
  })
  const hinted = applyRunBudgetHint(runtime, {
    maxIterations: 12,
    reserveToolCalls: 3,
  })

  assert.equal(hinted.budget.maxIterations, seed.maxIterations)
  assert.equal(hinted.budget.maxToolCalls, seed.maxToolCalls)
  assert.equal(hinted.stepBudget?.maxIterations, 12)
  assert.equal(hinted.stepBudget?.remainingIterations, 12)
})

test('run budget policy tracks iterations, tool calls, and parallel groups independently', () => {
  let usage = {
    iterationsUsed: 0,
    toolCallsUsed: 0,
    parallelToolGroupsUsed: 0,
  }

  usage = consumeIterationBudget(usage)
  usage = consumeToolCallBudget(usage, 2)
  usage = consumeParallelGroupBudget(usage)

  assert.deepEqual(usage, {
    iterationsUsed: 1,
    toolCallsUsed: 2,
    parallelToolGroupsUsed: 1,
  })
})

test('run budget policy exposes remaining tool capacity and parallel group availability', () => {
  const seed = createRunBudgetSeed()
  const usage = {
    iterationsUsed: 2,
    toolCallsUsed: seed.maxToolCalls - 1,
    parallelToolGroupsUsed: seed.maxParallelToolGroups,
  }

  assert.equal(getRemainingToolCallBudget(seed, usage), 1)
  assert.equal(canUseParallelToolGroup(seed, usage), false)
})

test('run budget policy seeds different iteration budgets for direct, short, and multi-step tasks', () => {
  const direct = createRunBudgetSeed('direct_answer')
  const short = createRunBudgetSeed('short_task')
  const multi = createRunBudgetSeed('multi_step_task')
  const media = createRunBudgetSeed('media_task')

  assert.equal(direct.maxIterations, 8)
  assert.equal(short.maxIterations, 24)
  assert.equal(multi.maxIterations, 40)
  assert.equal(media.maxIterations, 60)
  assert.equal(short.maxParallelToolGroups, 5)
})

test('run budget policy grants long skill resume tasks the hard cap without changing short task preset', () => {
  const short = createRunBudgetSeed('short_task')
  const longSkill = applyLongSkillTaskBudgetSeed(short)

  assert.equal(short.maxIterations, 24)
  assert.equal(short.maxToolCalls, 24)
  assert.equal(longSkill.maxIterations, 220)
  assert.equal(longSkill.maxToolCalls, 220)
})

test('run budget policy computes a stable usage percentage from the active budget counters', () => {
  const seed = createRunBudgetSeed('multi_step_task')
  const usage = {
    iterationsUsed: 20,
    toolCallsUsed: 10,
    parallelToolGroupsUsed: 2,
  }

  assert.equal(getBudgetUsagePercent(seed, usage), 50)
})

test('run budget policy creates and refunds step budget iterations', () => {
  const seed = createRunBudgetSeed('multi_step_task')
  let runtime = createTaskBudgetRuntime('multi_step_task', {
    budget: seed,
    stepBudget: createStepBudgetState({
      stepId: 'collect',
      totalIterations: seed.maxIterations,
      stepCount: 3,
    }),
  })

  runtime = consumeIterationBudget(runtime)
  assert.equal(runtime.stepBudget?.remainingIterations, 13)

  runtime = refundIterationBudget(runtime)
  assert.equal(runtime.stepBudget?.remainingIterations, 14)
  assert.equal(runtime.usage.iterationsUsed, 0)
})

test('run budget policy exposes warning levels and freeze/resume state', () => {
  const seed = createRunBudgetSeed('short_task')
  let runtime = createTaskBudgetRuntime('short_task', {
    budget: seed,
    usage: {
      iterationsUsed: 22,
      toolCallsUsed: 0,
      parallelToolGroupsUsed: 0,
    },
    stepBudget: createStepBudgetState({
      stepId: 'step-1',
      totalIterations: seed.maxIterations,
      suggestedMaxIterations: 24,
    }),
  })

  assert.equal(getBudgetWarningLevel(getBudgetUsagePercent(runtime)), 'converge')
  runtime = freezeBudgetRuntime(runtime)
  assert.equal(runtime.frozen, true)
  runtime = resumeBudgetRuntime(runtime)
  assert.equal(runtime.frozen, false)
})
