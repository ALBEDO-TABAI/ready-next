import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createLayeredCompactor,
  MAX_CONSECUTIVE_COMPACT_FAILURES,
  type LayeredCompactorMetricName,
  type LayeredCompactorMessage,
} from '../main/modules/agent-control/layered-compactor'

function makeMessages(): LayeredCompactorMessage[] {
  return [
    { role: 'user', content: 'alpha '.repeat(120) },
    { role: 'assistant', content: 'bravo '.repeat(120) },
    { role: 'user', content: 'charlie '.repeat(120) },
    { role: 'assistant', content: 'delta '.repeat(120) },
  ]
}

test('compactL1 is idempotent', () => {
  const compactor = createLayeredCompactor({ l1Budget: 260 })

  const once = compactor.compactL1(makeMessages())
  const twice = compactor.compactL1(once)

  assert.deepEqual(twice, once)
})

test('maybeCompact skips L2 when l2Threshold is 0', () => {
  const metrics: LayeredCompactorMetricName[] = []
  const compactor = createLayeredCompactor({
    l1Budget: 260,
    estimateTokens: () => 10_000,
    metric: (name) => metrics.push(name),
  })

  const output = compactor.maybeCompact(makeMessages())

  assert.deepEqual(output, compactor.compactL1(makeMessages()))
  assert.equal(compactor.circuitBroken(), false)
  assert.deepEqual(metrics, [])
})

test('maybeCompact triggers L2 when estimate exceeds threshold and returns L1 after stub failure', () => {
  const metrics: LayeredCompactorMetricName[] = []
  const compactor = createLayeredCompactor({
    l1Budget: 260,
    l2Threshold: 10,
    estimateTokens: () => 11,
    metric: (name) => metrics.push(name),
  })

  const output = compactor.maybeCompact(makeMessages())

  assert.deepEqual(output, compactor.compactL1(makeMessages()))
  assert.equal(compactor.circuitBroken(), false)
  assert.deepEqual(metrics, ['compactionL2Failed'])
})

test('after 3 consecutive L2 failures, circuitBroken is true and metric emitted once', () => {
  const metrics: LayeredCompactorMetricName[] = []
  const compactor = createLayeredCompactor({
    l1Budget: 260,
    l2Threshold: 10,
    estimateTokens: () => 11,
    metric: (name) => metrics.push(name),
  })

  for (let index = 0; index < MAX_CONSECUTIVE_COMPACT_FAILURES; index += 1) {
    compactor.maybeCompact(makeMessages())
  }
  compactor.maybeCompact(makeMessages())

  assert.equal(compactor.circuitBroken(), true)
  assert.deepEqual(metrics, [
    'compactionL2Failed',
    'compactionL2Failed',
    'compactionL2Failed',
    'compactionCircuitBreak',
  ])
})

test('once circuit broken, subsequent maybeCompact returns L1 and does not retry L2', () => {
  const metrics: LayeredCompactorMetricName[] = []
  let estimates = 0
  const compactor = createLayeredCompactor({
    l1Budget: 260,
    l2Threshold: 10,
    estimateTokens: () => {
      estimates += 1
      return 11
    },
    metric: (name) => metrics.push(name),
  })

  for (let index = 0; index < MAX_CONSECUTIVE_COMPACT_FAILURES; index += 1) {
    compactor.maybeCompact(makeMessages())
  }
  const beforeBrokenCallCount = estimates
  const output = compactor.maybeCompact(makeMessages())

  assert.equal(compactor.circuitBroken(), true)
  assert.deepEqual(output, compactor.compactL1(makeMessages()))
  assert.equal(estimates, beforeBrokenCallCount)
  assert.deepEqual(metrics, [
    'compactionL2Failed',
    'compactionL2Failed',
    'compactionL2Failed',
    'compactionCircuitBreak',
  ])
})
