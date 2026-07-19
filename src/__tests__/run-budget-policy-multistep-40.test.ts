import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createRunBudgetSeed } from '../main/modules/agent-control/task-projection/run-budget-policy'

/**
 * skill-resume plan C2 — assert multi_step_task budget reduced 60→40.
 *
 * Background: prior to C2, multi_step_task had maxIterations:60. The RSS-loop
 * bug ran iter 35+ without progress because (a) no dedup detector, (b) ceiling
 * was high. C2 drops to 40 so loops surface sooner; C1's dedup intervention
 * fires inside the new range.
 *
 * Other presets unchanged: short_task=24, continuation=24, direct_answer=8,
 * media_task=60.
 */
describe('run-budget-policy multi_step_task budget', () => {
  it('multi_step_task is capped at 40 iterations / 40 tool calls', () => {
    const seed = createRunBudgetSeed('multi_step_task')
    assert.equal(seed.maxIterations, 40, 'maxIterations should be 40')
    assert.equal(seed.maxToolCalls, 40, 'maxToolCalls should be 40')
  })

  it('short_task remains at 24 (unchanged)', () => {
    const seed = createRunBudgetSeed('short_task')
    assert.equal(seed.maxIterations, 24)
    assert.equal(seed.maxToolCalls, 24)
  })

  it('media_task remains at 60 (unchanged — long video flows are legit)', () => {
    const seed = createRunBudgetSeed('media_task')
    assert.equal(seed.maxIterations, 60)
    assert.equal(seed.maxToolCalls, 60)
  })

  it('research uses the long-running emergency ceiling', () => {
    const seed = createRunBudgetSeed('research')
    assert.equal(seed.maxIterations, 220)
    assert.equal(seed.maxToolCalls, 220)
  })

  it('continuation remains at 24 (unchanged)', () => {
    const seed = createRunBudgetSeed('continuation')
    assert.equal(seed.maxIterations, 24)
    assert.equal(seed.maxToolCalls, 24)
  })

  it('direct_answer remains at 8 (unchanged)', () => {
    const seed = createRunBudgetSeed('direct_answer')
    assert.equal(seed.maxIterations, 8)
    assert.equal(seed.maxToolCalls, 8)
  })

  it('unknown task type falls back to short_task preset', () => {
    // @ts-expect-error testing fallback
    const seed = createRunBudgetSeed('not_a_real_task')
    assert.equal(seed.maxIterations, 24)
    assert.equal(seed.maxToolCalls, 24)
  })
})
