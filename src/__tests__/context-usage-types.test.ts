import assert from 'node:assert/strict'
import test from 'node:test'

import { buildContextUsageSnapshot } from '../shared/context-usage-types'

test('context usage computes ratio for trusted context windows', () => {
  const usage = buildContextUsageSnapshot({
    inputTokens: 93,
    windowTokens: 100,
    windowSource: 'model',
    timestamp: '2026-06-27T00:00:00.000Z',
  })

  assert.deepEqual(usage, {
    usedInputTokens: 93,
    windowTokens: 100,
    ratio: 0.93,
    windowSource: 'model',
    source: 'last_model_request',
    timestamp: '2026-06-27T00:00:00.000Z',
  })
})

test('context usage keeps fallback windows as estimated usage', () => {
  const fallback = buildContextUsageSnapshot({
    inputTokens: 239_000,
    windowTokens: 258_000,
    windowSource: 'fallback',
    timestamp: '2026-06-27T00:00:00.000Z',
  })
  const unknown = buildContextUsageSnapshot({
    inputTokens: 12_000,
    windowTokens: null,
    windowSource: null,
    timestamp: '2026-06-27T00:00:01.000Z',
  })

  assert.equal(fallback?.windowTokens, 258_000)
  assert.equal(fallback?.ratio, 239_000 / 258_000)
  assert.equal(fallback?.windowSource, 'fallback')
  assert.equal(unknown?.windowTokens, null)
  assert.equal(unknown?.ratio, null)
})

test('context usage is absent without real input tokens', () => {
  assert.equal(buildContextUsageSnapshot({
    inputTokens: 0,
    windowTokens: 100,
    windowSource: 'explicit',
    timestamp: '2026-06-27T00:00:00.000Z',
  }), null)
  assert.equal(buildContextUsageSnapshot({
    inputTokens: Number.POSITIVE_INFINITY,
    windowTokens: 100,
    windowSource: 'explicit',
    timestamp: '2026-06-27T00:00:00.000Z',
  }), null)
})
