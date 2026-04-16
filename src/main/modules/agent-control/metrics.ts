import { appendFileSync } from 'fs'
import { getLogPath } from '../../utils/platform'

const METRIC_LOG = getLogPath('ready-agent-metrics.log')

export function logAgentMetric(
  name: string,
  payload: Record<string, unknown> = {},
): void {
  try {
    appendFileSync(
      METRIC_LOG,
      `${JSON.stringify({
        at: new Date().toISOString(),
        metric: name,
        ...payload,
      })}\n`,
      'utf8',
    )
  } catch {
    // Metrics must never break the control path.
  }
}
