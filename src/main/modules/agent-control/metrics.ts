import { appendFileSync } from 'fs'
import { getLogPath } from '../../utils/platform'

const METRIC_LOG = getLogPath('ready-agent-metrics.log')

export interface AgentMetricEvent {
  at: string
  metric: string
  [key: string]: unknown
}

export type AgentMetricSink = (event: AgentMetricEvent) => void

let testSink: AgentMetricSink | null = null

/**
 * Test-only hook — production code must not read this. When set, emitted
 * metrics are forwarded to the sink INSTEAD OF writing the rotating log.
 * Reset to `null` to restore production behavior.
 */
export function __setMetricSinkForTests(sink: AgentMetricSink | null): void {
  testSink = sink
}

export function logAgentMetric(
  name: string,
  payload: Record<string, unknown> = {},
): void {
  const event: AgentMetricEvent = {
    at: new Date().toISOString(),
    metric: name,
    ...payload,
  }
  if (testSink) {
    try { testSink(event) } catch { /* test sink errors never break control path */ }
    return
  }
  try {
    appendFileSync(METRIC_LOG, `${JSON.stringify(event)}\n`, 'utf8')
  } catch {
    // Metrics must never break the control path.
  }
}
