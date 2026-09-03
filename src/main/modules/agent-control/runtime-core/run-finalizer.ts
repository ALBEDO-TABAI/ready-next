
import { logAgentMetric } from '../metrics'
import {
  type RunMetaTerminalStatus
} from '../../../../shared/run-meta-terminal-status'
import type {
  TaskBudgetRuntime
} from '../contracts/run-contracts'
import {
  rebindTaskBudgetRuntime
} from '../task-projection/run-budget-policy'
import { closeoutBrowserTargetClaimsForRun } from '../../browser-engine/browser-target-claim-closeout'
import type {
  FinalizedRunOutcome,
  RunCloseMetric,
  RunFinalizerDeps,
  RunOutcome
} from './run-finalizer-contracts'
export type {
  FinalizedRunOutcome,
  RunCloseMetric,
  RunFinalizerDeps,
  RunMetaRepositoryLike,
  RunOutcome,
} from './run-finalizer-contracts'

export { defaultVerifyRunStateTerminal } from './run-finalizer-adjudication'

export function writeRunCloseMetric(metric: RunCloseMetric): void {
  logAgentMetric('run_close', {
    runId: metric.runId,
    terminalReason: metric.terminalReason,
    initiator: metric.initiator,
    toolCallsUsed: metric.toolCallsUsed,
    durationMs: metric.durationMs,
    taskType: metric.taskType ?? null
  })
}

export const defaultRunFinalizerDeps: RunFinalizerDeps = {
  writeRunCloseMetric
}

export { deriveCoverageTargets } from './run-finalizer-task-facts'

import {
  isValidContinuationHandle,
  requiresCheckpointContinuationHandle,
  toRunCloseMetric,
  writeRunMetaOutcome,
  prepareTerminalOutcome,
  writePreparedTerminalOutcome,
  type PreparedTerminalOutcome,
} from './run-finalizer-persistence'
export { resolveDynamicDeliveryFinalizerBlocker } from './run-finalizer-adjudication'

export {
  buildManualSuspendProjectionPatch,
  buildSupersededChildTerminalProjectionPatch,
  buildTerminalProjectionPatch,
} from './run-finalizer-projection'

export async function finalizeRunOutcome(
  outcome: RunOutcome,
  deps: RunFinalizerDeps
): Promise<FinalizedRunOutcome> {
  const terminalBudgetRuntime = reconcileTerminalTaskBudgetRuntime(
    outcome.taskBudgetRuntime,
    outcome.projectionPatch,
    outcome.toolCallsUsed
  )
  if (terminalBudgetRuntime !== outcome.taskBudgetRuntime) {
    outcome = { ...outcome, taskBudgetRuntime: terminalBudgetRuntime } as RunOutcome
  }

  if (outcome.kind === 'checkpoint') {
    if (
      requiresCheckpointContinuationHandle(outcome.terminalReason) &&
      !isValidContinuationHandle(outcome.continuationHandle)
    ) {
      writeRunMetaOutcome(outcome, deps, 'error', 'checkpoint_degraded_error')
      deps.writeRunCloseMetric(toRunCloseMetric(outcome, 'checkpoint_degraded_error'))
      throw new Error('checkpoint outcome requires a valid continuation handle')
    }

  }
  const status = outcome.kind === 'done' || outcome.kind === 'checkpoint'
    ? outcome.kind : statusFromOutcomeKind(outcome.kind)
  return finalizePreparedRunOutcome(outcome, deps, prepareTerminalOutcome(
    outcome, deps, status, outcome.terminalReason || status,
  ))
}

export async function finalizePreparedRunOutcome(
  outcome: RunOutcome,
  deps: RunFinalizerDeps,
  prepared: PreparedTerminalOutcome,
): Promise<FinalizedRunOutcome> {
  const finalized = await writePreparedTerminalOutcome(outcome, deps, prepared)
  closeoutBrowserClaimsIfOwned(outcome, deps, {
    ownerRunId: outcome.runId,
    resumable: false,
    suspensionCheckpointId: null,
    suspensionReason: null,
  })
  return finalized
}

function closeoutBrowserClaimsIfOwned(
  outcome: RunOutcome,
  deps: RunFinalizerDeps,
  input: Parameters<typeof closeoutBrowserTargetClaimsForRun>[0],
): void {
  const projection = outcome.taskId && deps.taskProjectionStore
    ? deps.taskProjectionStore.get(outcome.taskId)
    : null
  const continuation = projection?.continuationRef
  const browserOwned = projection?.module === 'browser'
    || outcome.projectionPatch?.module === 'browser'
    || Boolean(
      continuation
      && typeof continuation === 'object'
      && (
        (continuation as Record<string, unknown>).kind === 'browser_checkpoint'
        || (continuation as Record<string, unknown>).browserTaskId
      ),
    )
  if (browserOwned) closeoutBrowserTargetClaimsForRun(input)
}

/**
 * A bootstrap budget is only a pre-run capacity guess. Once a zero-tool turn
 * closes with the terminal direct-answer patch, align that snapshot before
 * adjudication and persistence. Explicit task budgets remain authoritative so
 * research, browser transactions, continuations, and skill work cannot evade
 * their proof contract by returning prose without using their required tools.
 */
export function reconcileTerminalTaskBudgetRuntime(
  runtime: TaskBudgetRuntime | null | undefined,
  projectionPatch: Record<string, unknown> | null | undefined,
  toolCallsUsed: number
): TaskBudgetRuntime | null {
  if (!runtime) return null
  if (
    toolCallsUsed !== 0
    || projectionPatch?.taskType !== 'direct_answer'
    || !runtime.bootstrapBudget
  ) return runtime
  return rebindTaskBudgetRuntime(runtime, 'direct_answer', { bootstrapBudget: false })
}

function statusFromOutcomeKind(
  kind: Exclude<RunOutcome['kind'], 'done' | 'checkpoint'>
): RunMetaTerminalStatus {
  if (kind === 'error') return 'error'
  if (kind === 'interrupted') return 'interrupted'
  return 'cancelled'
}
