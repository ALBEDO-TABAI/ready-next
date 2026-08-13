import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// @ts-expect-error -- the live-proof helper intentionally stays directly executable by Node.
import {
  aggregateGroundedPerformance,
  compareGroundedPerformance,
  enrichProviderPerformanceEvidence,
} from '../../scripts/browser-grounded-performance-evidence.mjs'

function proofCase(runId: string, durationMs: number, inputTokens: number) {
  return {
    runId,
    ok: true,
    duplicateDispatches: 0,
    latePageWrites: [],
    diagnostics: [],
    metrics: {
      durationMs,
      toolCalls: 1,
      inputTokens,
      firstProgressMs: null,
    },
  }
}

function metric(at: string, event: Record<string, unknown>) {
  return JSON.stringify({ at, ...event })
}

test('live performance gate separates deterministic workflow shape from cross-window provider latency', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-grounded-performance-'))
  try {
    const baselineLog = join(root, 'baseline.log')
    const currentLog = join(root, 'current.log')
    writeFileSync(baselineLog, [
      metric('2026-07-18T20:00:00.000Z', { metric: 'provider_request_bill', runId: 'base-1', agentName: 'owner' }),
      metric('2026-07-18T20:00:01.000Z', { metric: 'provider_request_bill', runId: 'base-1', agentName: 'owner' }),
      metric('2026-07-18T20:00:02.000Z', { metric: 'provider_estimate_reconciliation', runId: 'base-1', agentName: 'owner', actualInputTokens: 50 }),
      metric('2026-07-18T20:00:02.100Z', { metric: 'provider_estimate_reconciliation', runId: 'base-1', agentName: 'owner', actualInputTokens: 50 }),
      metric('2026-07-18T20:00:02.200Z', { metric: 'run_close', runId: 'base-1', durationMs: 2_200 }),
    ].join('\n'))
    writeFileSync(currentLog, [
      metric('2026-07-19T04:00:00.000Z', { metric: 'provider_request_bill', runId: 'live-1', agentName: 'owner' }),
      metric('2026-07-19T04:00:03.000Z', { metric: 'provider_request_bill', runId: 'live-1', agentName: 'owner' }),
      metric('2026-07-19T04:00:06.000Z', { metric: 'provider_estimate_reconciliation', runId: 'live-1', agentName: 'owner', actualInputTokens: 52 }),
      metric('2026-07-19T04:00:06.100Z', { metric: 'provider_estimate_reconciliation', runId: 'live-1', agentName: 'owner', actualInputTokens: 53 }),
      metric('2026-07-19T04:00:06.200Z', { metric: 'provider_request_bill', runId: 'live-1:verifier', agentName: 'codex-browser-verifier', toolSchemaCount: 0 }),
      metric('2026-07-19T04:00:08.000Z', { metric: 'provider_estimate_reconciliation', runId: 'live-1:verifier', agentName: 'codex-browser-verifier', actualInputTokens: 4 }),
      metric('2026-07-19T04:00:08.100Z', { metric: 'run_close', runId: 'live-1', durationMs: 8_100 }),
    ].join('\n'))

    const baselineCases = [proofCase('base-1', 2_500, 100)]
    const currentCases = [proofCase('live-1', 8_500, 109)]
    enrichProviderPerformanceEvidence(baselineCases, baselineLog)
    enrichProviderPerformanceEvidence(currentCases, currentLog)
    const comparison = compareGroundedPerformance(
      aggregateGroundedPerformance(currentCases),
      aggregateGroundedPerformance(baselineCases),
      { requiredSamples: 1 },
    )

    assert.equal(comparison.ok, true)
    assert.equal(comparison.checks.ownerProviderRequestsP95, true)
    assert.equal(comparison.checks.verifierProviderRequestsP95, true)
    assert.equal(comparison.checks.verifierHasNoTools, true)
    assert.equal(comparison.wallClockDiagnostics.gate, 'reported_not_cross_window_gated')
    assert.equal(comparison.wallClockDiagnostics.runtimeDurationMs.legacyP95WithinThreshold, false)

    const duplicatedVerifier = {
      ...aggregateGroundedPerformance(currentCases),
      verifierProviderRequests: { p50: 2, p95: 2 },
    }
    assert.equal(compareGroundedPerformance(
      duplicatedVerifier,
      aggregateGroundedPerformance(baselineCases),
      { requiredSamples: 1 },
    ).ok, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
