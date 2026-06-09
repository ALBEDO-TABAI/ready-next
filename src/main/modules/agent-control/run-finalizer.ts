import { logAgentMetric } from './metrics'

export interface RunCloseMetric {
  runId: string
  terminalReason: string
  initiator: string
  toolCallsUsed: number
  durationMs: number
}

export type RunOutcome =
  | {
    kind: 'done'
    runId: string
    durationMs: number
    toolCallsUsed: number
    initiator: string
  }
  | {
    kind: 'checkpoint'
    runId: string
    continuationHandle: string | null
    durationMs: number
    toolCallsUsed: number
    initiator: string
  }

export interface RunFinalizerDeps {
  writeRunCloseMetric: (metric: RunCloseMetric) => void
}

export function writeRunCloseMetric(metric: RunCloseMetric): void {
  logAgentMetric('run_close', {
    runId: metric.runId,
    terminalReason: metric.terminalReason,
    initiator: metric.initiator,
    toolCallsUsed: metric.toolCallsUsed,
    durationMs: metric.durationMs,
  })
}

export const defaultRunFinalizerDeps: RunFinalizerDeps = {
  writeRunCloseMetric,
}

// Future integration point: agent-sdk-runtime.ts:4470 currently emits the done
// completion; call finalizeRunOutcome() there once S1 wires the runtime path.
export async function finalizeRunOutcome(outcome: RunOutcome, deps: RunFinalizerDeps): Promise<void> {
  if (outcome.kind === 'done') {
    deps.writeRunCloseMetric(toRunCloseMetric(outcome, 'done'))
    return
  }

  if (!isValidContinuationHandle(outcome.continuationHandle)) {
    deps.writeRunCloseMetric(toRunCloseMetric(outcome, 'checkpoint_degraded_error'))
    throw new Error('checkpoint outcome requires a valid continuation handle')
  }

  deps.writeRunCloseMetric(toRunCloseMetric(outcome, 'checkpoint'))
}

function toRunCloseMetric(
  outcome: RunOutcome,
  terminalReason: string,
): RunCloseMetric {
  return {
    runId: outcome.runId,
    terminalReason,
    initiator: outcome.initiator,
    toolCallsUsed: outcome.toolCallsUsed,
    durationMs: outcome.durationMs,
  }
}

function isValidContinuationHandle(handle: string | null): handle is string {
  return typeof handle === 'string' && handle.trim().length > 0
}
