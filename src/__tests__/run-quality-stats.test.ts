/**
 * P0-4 (2026-07-02 P0 visibility batch) — run quality aggregation contract:
 * daily buckets from run_close, divergence/first-delta/fallback counters,
 * window filtering, malformed-line tolerance, and the IPC group handler.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { aggregateRunQualityStats } from '../main/modules/agent-control/quality/run-quality-stats'
import {
  runQualityGroup,
  _runQualityGroupChannelsForTest,
} from '../main/modules/claude-bridge/ipc/run-quality-group'

const NOW = new Date('2026-07-02T12:00:00.000Z')

function metricLine(at: string, metric: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ at, metric, ...extra })
}

test('run-quality-stats: buckets run_close by day and counts companion metrics', () => {
  const lines = [
    metricLine('2026-07-01T08:00:00.000Z', 'run_close', { terminalReason: 'done' }),
    metricLine('2026-07-01T09:00:00.000Z', 'run_close', { terminalReason: 'proof_gap' }),
    metricLine('2026-07-01T10:00:00.000Z', 'run_close', { terminalReason: 'adjudication_degraded' }),
    metricLine('2026-07-02T08:00:00.000Z', 'run_close', { terminalReason: 'browser_transaction_unconfirmed' }),
    metricLine('2026-07-02T09:00:00.000Z', 'adjudicator_enforce_divergence', {}),
    metricLine('2026-07-02T09:01:00.000Z', 'provider_stream_first_delta', { ms: 900 }),
    metricLine('2026-07-02T09:02:00.000Z', 'provider_stream_first_delta', { ms: 1500 }),
    metricLine('2026-07-02T09:03:00.000Z', 'provider_stream_fallback', { reason: 'non_sse_response' }),
    'not-json-at-all {',
    metricLine('2026-05-01T09:00:00.000Z', 'run_close', { terminalReason: 'proof_gap' }), // 窗口外
  ]
  const stats = aggregateRunQualityStats(lines, { now: NOW })
  assert.equal(stats.sampleSize, 4)
  assert.equal(stats.days.length, 2)
  assert.deepEqual(stats.days[0], { date: '2026-07-01', total: 3, done: 1, proofGap: 1, degraded: 1, unconfirmed: 0 })
  assert.deepEqual(stats.days[1], { date: '2026-07-02', total: 1, done: 0, proofGap: 0, degraded: 0, unconfirmed: 1 })
  assert.equal(stats.divergenceCount, 1)
  assert.equal(stats.firstDelta.count, 2)
  assert.equal(stats.firstDelta.p50Ms, 900)
  assert.equal(stats.firstDelta.avgMs, 1200)
  assert.deepEqual(stats.streamFallbacks, { non_sse_response: 1 })
})

test('run-quality-stats: empty input yields an empty-but-valid payload', () => {
  const stats = aggregateRunQualityStats([], { now: NOW })
  assert.equal(stats.sampleSize, 0)
  assert.deepEqual(stats.days, [])
  assert.equal(stats.firstDelta.p50Ms, null)
  assert.equal(stats.firstDelta.avgMs, null)
})

test('run-quality-group: handler registers the channel and serves aggregated stats', async () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const ipc = {
    handle(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) {
      handlers.set(channel, handler)
    },
    removeHandler(channel: string) {
      handlers.delete(channel)
    },
  } as unknown as IpcMain
  const dispose = runQualityGroup.register(ipc, {
    readMetricsLines: () => [
      metricLine('2026-07-02T08:00:00.000Z', 'run_close', { terminalReason: 'proof_gap' }),
    ],
    now: () => NOW,
  })
  assert.deepEqual([...handlers.keys()], [..._runQualityGroupChannelsForTest])
  const handler = handlers.get('agent:runQuality:stats')
  assert.ok(handler)
  const response = await handler({} as IpcMainInvokeEvent) as { success: boolean; data?: { sampleSize: number; days: Array<{ proofGap: number }> } }
  assert.equal(response.success, true)
  assert.equal(response.data?.sampleSize, 1)
  assert.equal(response.data?.days[0]?.proofGap, 1)
  dispose.dispose()
  assert.equal(handlers.size, 0)
})
