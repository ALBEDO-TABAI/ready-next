import assert from 'node:assert/strict'
import test from 'node:test'

import { addRunUsage, RunUsageAccumulator } from '../main/modules/agent-control/runtime-core/run-usage-accumulator'

test('run usage accumulates every provider call instead of keeping the last call', () => {
  const accumulator = new RunUsageAccumulator()
  accumulator.add({ inputTokens: 10, outputTokens: 2, totalTokens: 12 })
  accumulator.add({ inputTokens: 20, outputTokens: 4, totalTokens: 24 })
  accumulator.add({ inputTokens: 30, outputTokens: 6, totalTokens: 36 })
  assert.deepEqual(accumulator.snapshot(), {
    inputTokens: 60,
    outputTokens: 12,
    totalTokens: 72,
    usageSource: 'provider',
    providerCallCount: 3,
    missingCallCount: 0,
  })
})

test('missing usage does not erase the accumulated total and absent total is derived', () => {
  const first = addRunUsage(null, { inputTokens: 5, outputTokens: 3, totalTokens: 0 })
  assert.deepEqual(addRunUsage(first, null), {
    inputTokens: 5, outputTokens: 3, totalTokens: 8,
    usageSource: 'provider', providerCallCount: 1, missingCallCount: 1,
  })
})

test('a provider response without usage records missing without inventing tokens', () => {
  assert.deepEqual(addRunUsage(null, null), {
    inputTokens: 0, outputTokens: 0, totalTokens: 0,
    usageSource: 'missing', providerCallCount: 0, missingCallCount: 1,
  })
})
