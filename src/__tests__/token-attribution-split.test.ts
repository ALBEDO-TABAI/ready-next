import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TOKEN_ATTRIBUTION_NAMESPACES,
  buildTokenUsageRecord,
  type TokenAttributionNamespace,
  type TokenUsageRecord,
} from '../main/modules/agent-control/token-usage-middleware'
import {
  TOKEN_ATTRIBUTION_DIMENSIONS,
  emptyAttribution,
  type TokenAttributionByDimension,
  type TokenAttributionDimension,
} from '../main/modules/agent-control/token-attribution-dimensions'

test('TOKEN_ATTRIBUTION_NAMESPACES is exactly the 2-element model_call/task_card_step tuple', () => {
  assert.deepEqual([...TOKEN_ATTRIBUTION_NAMESPACES], ['model_call', 'task_card_step'])
  assert.equal(TOKEN_ATTRIBUTION_NAMESPACES.length, 2)
  // Type-level smoke: the union must accept both literals.
  const a: TokenAttributionNamespace = 'model_call'
  const b: TokenAttributionNamespace = 'task_card_step'
  assert.equal(a, 'model_call')
  assert.equal(b, 'task_card_step')
})

test('buildTokenUsageRecord fills zero defaults and a present timestamp', () => {
  const before = Date.now()
  const record = buildTokenUsageRecord({ namespace: 'model_call' })
  const after = Date.now()

  assert.equal(record.namespace, 'model_call')
  assert.equal(record.inputTokens, 0)
  assert.equal(record.outputTokens, 0)
  assert.equal(record.totalTokens, 0)
  assert.equal(record.modelId, undefined)
  assert.equal(record.stepId, undefined)
  assert.equal(record.runId, undefined)
  assert.ok(record.timestamp >= before && record.timestamp <= after)
})

test('buildTokenUsageRecord lets caller override every field including timestamp', () => {
  const record: TokenUsageRecord = buildTokenUsageRecord({
    namespace: 'task_card_step',
    inputTokens: 12,
    outputTokens: 34,
    totalTokens: 46,
    modelId: 'claude-opus-4-7',
    stepId: 'step-001',
    runId: 'run-abc',
    timestamp: 1700000000000,
  })

  assert.deepEqual(record, {
    namespace: 'task_card_step',
    inputTokens: 12,
    outputTokens: 34,
    totalTokens: 46,
    modelId: 'claude-opus-4-7',
    stepId: 'step-001',
    runId: 'run-abc',
    timestamp: 1700000000000,
  })
})

test('TOKEN_ATTRIBUTION_DIMENSIONS is exactly the 6-element registry in canonical order', () => {
  assert.deepEqual([...TOKEN_ATTRIBUTION_DIMENSIONS], [
    'search',
    'fetch',
    'subagent',
    'present',
    'clarification',
    'todo',
  ])
  assert.equal(TOKEN_ATTRIBUTION_DIMENSIONS.length, 6)
})

test('emptyAttribution returns a fresh zeroed record covering every dimension', () => {
  const a: TokenAttributionByDimension = emptyAttribution()
  for (const dim of TOKEN_ATTRIBUTION_DIMENSIONS) {
    const key: TokenAttributionDimension = dim
    assert.equal(a[key], 0, `dimension '${key}' should default to 0`)
  }
  // Independence: mutating one record must not bleed into the next.
  a.search = 999
  const b = emptyAttribution()
  assert.equal(b.search, 0)
})
