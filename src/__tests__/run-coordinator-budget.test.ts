import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyRunBudgetHint,
  canUseParallelToolGroup,
  consumeIterationBudget,
  consumeParallelGroupBudget,
  consumeToolCallBudget,
  createRunBudgetSeed,
  getRemainingToolCallBudget,
} from '../main/modules/agent-control/run-budget-policy'

test('run budget policy seeds defaults and applies hints conservatively', () => {
  const seed = createRunBudgetSeed()
  const hinted = applyRunBudgetHint(seed, {
    maxIterations: seed.maxIterations + 4,
    reserveToolCalls: 3,
  })

  assert.equal(typeof seed.maxIterations, 'number')
  assert.equal(typeof seed.maxToolCalls, 'number')
  assert.equal(typeof seed.maxParallelToolGroups, 'number')
  assert.equal(hinted.maxIterations, seed.maxIterations + 4)
  assert.equal(hinted.maxToolCalls, seed.maxToolCalls + 3)
  assert.equal(hinted.maxParallelToolGroups, seed.maxParallelToolGroups)
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
