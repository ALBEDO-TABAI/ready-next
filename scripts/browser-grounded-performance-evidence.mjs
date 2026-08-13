import { existsSync, readFileSync } from 'node:fs'

export function percentile(values, ratio) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))]
}

function readMetricEvents(path) {
  if (!path || !existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line)] : []
      } catch {
        return []
      }
    })
}

function elapsedMs(start, end) {
  const startedAt = Date.parse(start || '')
  const endedAt = Date.parse(end || '')
  return Number.isFinite(startedAt) && Number.isFinite(endedAt)
    ? Math.max(0, endedAt - startedAt)
    : null
}

export function enrichProviderPerformanceEvidence(cases, metricsLogPath) {
  const events = readMetricEvents(metricsLogPath)
  for (const item of cases) {
    const runId = String(item.runId || '')
    if (!runId) continue
    const ownerBills = events.filter((event) => (
      event.metric === 'provider_request_bill'
      && event.runId === runId
      && event.agentName !== 'codex-browser-verifier'
    ))
    const ownerReconciliations = events.filter((event) => (
      event.metric === 'provider_estimate_reconciliation'
      && event.runId === runId
      && event.agentName !== 'codex-browser-verifier'
    ))
    const verifierRunId = `${runId}:verifier`
    const verifierBills = events.filter((event) => (
      event.metric === 'provider_request_bill'
      && event.runId === verifierRunId
      && event.agentName === 'codex-browser-verifier'
    ))
    const verifierReconciliations = events.filter((event) => (
      event.metric === 'provider_estimate_reconciliation'
      && event.runId === verifierRunId
      && event.agentName === 'codex-browser-verifier'
    ))
    const runClose = events.find((event) => event.metric === 'run_close' && event.runId === runId)
    item.metrics = {
      ...item.metrics,
      runtimeDurationMs: Number(runClose?.durationMs) || item.metrics?.runtimeDurationMs || null,
      ownerProviderRequests: ownerBills.length,
      verifierProviderRequests: verifierBills.length,
      ownerInputTokens: ownerReconciliations.reduce((sum, event) => sum + (Number(event.actualInputTokens) || 0), 0),
      verifierInputTokens: verifierReconciliations.reduce((sum, event) => sum + (Number(event.actualInputTokens) || 0), 0),
      ownerProviderWindowMs: elapsedMs(ownerBills[0]?.at, ownerReconciliations.at(-1)?.at),
      verifierProviderWindowMs: elapsedMs(verifierBills[0]?.at, verifierReconciliations.at(-1)?.at),
      verifierToolSchemaCount: verifierBills.reduce(
        (maximum, event) => Math.max(maximum, Number(event.toolSchemaCount) || 0),
        0,
      ),
    }
  }
  return cases
}

function distribution(cases, field) {
  return {
    p50: percentile(cases.map((item) => item.metrics?.[field]), 0.5),
    p95: percentile(cases.map((item) => item.metrics?.[field]), 0.95),
  }
}

export function aggregateGroundedPerformance(cases) {
  return {
    samples: cases.length,
    successRate: cases.length ? cases.filter((item) => item.ok).length / cases.length : 0,
    durationMs: distribution(cases, 'durationMs'),
    runtimeDurationMs: distribution(cases, 'runtimeDurationMs'),
    canonicalDurationMs: distribution(cases, 'canonicalDurationMs'),
    firstProgressMs: distribution(cases, 'firstProgressMs'),
    toolCalls: distribution(cases, 'toolCalls'),
    inputTokens: distribution(cases, 'inputTokens'),
    ownerProviderRequests: distribution(cases, 'ownerProviderRequests'),
    verifierProviderRequests: distribution(cases, 'verifierProviderRequests'),
    ownerInputTokens: distribution(cases, 'ownerInputTokens'),
    verifierInputTokens: distribution(cases, 'verifierInputTokens'),
    ownerProviderWindowMs: distribution(cases, 'ownerProviderWindowMs'),
    verifierProviderWindowMs: distribution(cases, 'verifierProviderWindowMs'),
    verifierToolSchemaCount: distribution(cases, 'verifierToolSchemaCount'),
    duplicateDispatches: cases.reduce((sum, item) => sum + item.duplicateDispatches, 0),
    latePageWrites: cases.reduce((sum, item) => sum + item.latePageWrites.length, 0),
    unnecessaryInterruptions: cases.filter((item) => item.diagnostics.some((diagnostic) => (
      /takeover|waiting|interrupt/i.test(`${diagnostic.id} ${diagnostic.message}`)
    ))).length,
  }
}

function withinLegacyDurationThreshold(current, baseline, percentileName) {
  const currentValue = current.runtimeDurationMs?.[percentileName]
  const baselineValue = baseline.runtimeDurationMs?.[percentileName]
  if (currentValue == null || baselineValue == null) return null
  return percentileName === 'p50'
    ? currentValue <= Math.max(baselineValue * 1.15, baselineValue + 1_000)
    : currentValue <= baselineValue * 1.2
}

export function compareGroundedPerformance(current, baseline, options = {}) {
  const requiredSamples = Math.max(1, Number(options.requiredSamples) || 20)
  const checks = {
    samples: current.samples >= requiredSamples,
    correctness: current.successRate === 1,
    duplicateDispatches: current.duplicateDispatches === 0,
    latePageWrites: current.latePageWrites === 0,
    unnecessaryInterruptions: current.unnecessaryInterruptions === 0,
    toolCallsP50: current.toolCalls.p50 != null && baseline.toolCalls?.p50 != null
      && current.toolCalls.p50 <= baseline.toolCalls.p50,
    toolCallsP95: current.toolCalls.p95 != null && baseline.toolCalls?.p95 != null
      && current.toolCalls.p95 <= baseline.toolCalls.p95,
    inputTokensP50: current.inputTokens.p50 != null && baseline.inputTokens?.p50 != null
      && current.inputTokens.p50 <= baseline.inputTokens.p50 * 1.1,
    inputTokensP95: current.inputTokens.p95 != null && baseline.inputTokens?.p95 != null
      && current.inputTokens.p95 <= baseline.inputTokens.p95 * 1.1,
    ownerProviderRequestsP50: current.ownerProviderRequests.p50 != null
      && baseline.ownerProviderRequests?.p50 != null
      && current.ownerProviderRequests.p50 <= baseline.ownerProviderRequests.p50,
    ownerProviderRequestsP95: current.ownerProviderRequests.p95 != null
      && baseline.ownerProviderRequests?.p95 != null
      && current.ownerProviderRequests.p95 <= baseline.ownerProviderRequests.p95,
    verifierProviderRequestsP50: current.verifierProviderRequests.p50 === 1,
    verifierProviderRequestsP95: current.verifierProviderRequests.p95 === 1,
    verifierHasNoTools: current.verifierToolSchemaCount.p95 === 0,
    runtimeDurationReported: current.runtimeDurationMs.p50 != null && current.runtimeDurationMs.p95 != null,
  }
  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    wallClockDiagnostics: {
      gate: 'reported_not_cross_window_gated',
      reason: 'external_provider_latency_and_required_verifier_are_not_comparable_to_a_non-verifier_baseline_from_another_provider_window',
      runtimeDurationMs: {
        current: current.runtimeDurationMs,
        baseline: baseline.runtimeDurationMs || null,
        legacyP50WithinThreshold: withinLegacyDurationThreshold(current, baseline, 'p50'),
        legacyP95WithinThreshold: withinLegacyDurationThreshold(current, baseline, 'p95'),
      },
      ownerProviderWindowMs: {
        current: current.ownerProviderWindowMs,
        baseline: baseline.ownerProviderWindowMs || null,
      },
      verifierProviderWindowMs: current.verifierProviderWindowMs,
    },
  }
}
