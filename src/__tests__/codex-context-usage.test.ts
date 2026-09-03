import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CodexTurnUsageAccumulator,
  normalizeCodexThreadTokenUsage,
  type CodexThreadTokenUsage,
  type CodexTokenUsageBreakdown,
} from '../main/modules/agent-control/codex-runtime/codex-context-usage'
import { normalizeContextUsageSnapshot } from '../shared/context-usage-types'

function breakdown(inputTokens: number, outputTokens: number): CodexTokenUsageBreakdown {
  return {
    totalTokens: inputTokens + outputTokens,
    inputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
  }
}

function usage(
  totalInput: number,
  totalOutput: number,
  lastInput: number,
  lastOutput: number,
  modelContextWindow: number | null = 258_400,
): CodexThreadTokenUsage {
  return {
    total: breakdown(totalInput, totalOutput),
    last: breakdown(lastInput, lastOutput),
    modelContextWindow,
  }
}

test('normalizer accepts only the exact app-server token usage contract', () => {
  const accepted = normalizeCodexThreadTokenUsage(usage(1_000, 120, 100, 20))
  assert.equal(accepted?.last.inputTokens, 100)
  assert.equal(accepted?.modelContextWindow, 258_400)

  const schemaDefaults = usage(1_000, 120, 100, 20) as unknown as Record<string, unknown>
  delete schemaDefaults.modelContextWindow
  for (const value of [schemaDefaults.total, schemaDefaults.last]) {
    delete (value as Record<string, unknown>).cacheWriteInputTokens
  }
  assert.deepEqual(normalizeCodexThreadTokenUsage(schemaDefaults), {
    total: breakdown(1_000, 120),
    last: breakdown(100, 20),
    modelContextWindow: null,
  })

  assert.equal(normalizeCodexThreadTokenUsage({
    ...usage(1_000, 120, 100, 20),
    futureField: true,
  }), null)
  assert.equal(normalizeCodexThreadTokenUsage({
    ...usage(1_000, 120, 100, 20),
    last: { ...breakdown(100, 20), cachedInputTokens: 101 },
  }), null)
  assert.equal(normalizeCodexThreadTokenUsage(usage(50, 20, 100, 10)), null)
})

test('opaque app-server totalTokens does not invent a context snapshot', () => {
  const accumulator = new CodexTurnUsageAccumulator()
  const observed = usage(1_000_012, 8, 0, 0)
  observed.last.totalTokens = 25_456
  accumulator.observe(observed, '2026-08-30T00:00:01.000Z')
  assert.equal(accumulator.snapshot(), null)
})

test('accumulator follows the last positive model request and ignores a zero tail', () => {
  const accumulator = new CodexTurnUsageAccumulator()
  accumulator.observe(usage(1_000, 120, 100, 20), '2026-08-30T00:00:01.000Z')
  accumulator.observe(usage(1_080, 135, 80, 15), '2026-08-30T00:00:02.000Z')
  accumulator.observe(usage(1_080, 135, 0, 0, null), '2026-08-30T00:00:03.000Z')

  assert.deepEqual(accumulator.snapshot(), {
    usedInputTokens: 80,
    windowTokens: 258_400,
    ratio: 80 / 258_400,
    windowSource: 'model',
    source: 'last_model_request',
    timestamp: '2026-08-30T00:00:02.000Z',
  })
})

test('a smaller post-compaction request is valid but cumulative token regression is not', () => {
  const accumulator = new CodexTurnUsageAccumulator()
  accumulator.observe(usage(120_000, 4_000, 118_000, 4_000), '2026-08-30T00:00:01.000Z')
  accumulator.observe(usage(126_000, 4_500, 6_000, 500), '2026-08-30T00:00:02.000Z')
  assert.equal(accumulator.snapshot()?.usedInputTokens, 6_000)

  assert.throws(
    () => accumulator.observe(usage(125_999, 4_500, 1, 0), '2026-08-30T00:00:03.000Z'),
    /codex_token_usage_total_regressed/,
  )
})

test('durable context usage accepts only the exact recomputable snapshot', () => {
  const snapshot = {
    usedInputTokens: 80,
    windowTokens: 258_400,
    ratio: 80 / 258_400,
    windowSource: 'model',
    source: 'last_model_request',
    timestamp: '2026-08-30T00:00:02.000Z',
  } as const
  assert.deepEqual(normalizeContextUsageSnapshot(snapshot), snapshot)
  assert.equal(normalizeContextUsageSnapshot({ ...snapshot, ratio: 0.5 }), null)
  assert.equal(normalizeContextUsageSnapshot({ ...snapshot, source: 'estimate' }), null)
  assert.equal(normalizeContextUsageSnapshot({ ...snapshot, extra: true }), null)
})
