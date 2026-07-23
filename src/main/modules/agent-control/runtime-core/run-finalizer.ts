import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { logAgentMetric } from '../metrics'
import {
  collectResponseDigestProof,
  collectRunStateProof,
  collectArtifactProof,
  appendProofRefs
} from '../quality/proof-collector'
import { parseRunStateJson } from '../task-projection/run-state-schema'
import {
  adjudicateTerminalOutcome,
  appendCheckIns,
  type CheckInRecord
} from '../quality/task-adjudicator'
import {
  appendModelCriteria,
  normalizeDeliveryTarget,
  resolveCriteria,
  type SkillExecutionForm
} from '../quality/criteria-templates'
import type { TaskType } from '../../../../shared/task-types'
import {
  isRunMetaTerminalStatus,
  type RunMetaTerminalStatus
} from '../../../../shared/run-meta-terminal-status'
import type {
  BudgetWarningLevel,
  TaskBudget,
  TaskBudgetRuntime,
  TaskProjectionRecord,
} from '../contracts/run-contracts'
import { canResumeAsUserPoint } from '../contracts/resume-handle'
import type { DeliveryStateV1 } from '../../../../shared/dynamic-delivery'
import { assertDeliveryState } from '../../../../shared/dynamic-delivery'
import {
  getBudgetUsagePercent,
  rebindTaskBudgetRuntime,
} from '../task-projection/run-budget-policy'
import type { CanonicalAssistantMessageReceipt } from '../../../../shared/ipc-contracts/canonical-message'
import type {
  BrowserWorkflowCloseoutSeal,
  BrowserWorkflowCompletionVerifierReceipt,
} from '../../../../shared/browser-workflow-control'
import { workflowDigest } from '../../repositories/browser-workflow-codec'
import { closeoutBrowserTargetClaimsForRun } from '../../browser-engine/browser-target-claim-closeout'
import type {
  FinalizedRunOutcome,
  RunCloseMetric,
  RunFinalizerDeps,
  RunOutcome,
  RunOutcomeUsage,
  TerminalAdjudicationDecision,
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

import {
  deriveCoverageTargets,
  deriveLearningRefs,
  hasDocumentDeliveryProof,
  hasPlannedStepsRequiringProof,
  hasProofKind,
  isBrowserTransactionTask,
  resolveEffectiveTaskFacts,
  type EffectiveTaskFacts,
} from './run-finalizer-task-facts'
export { deriveCoverageTargets } from './run-finalizer-task-facts'

import {
  canKeepProofBearingDegradedVisible,
  continuationFromProjectionPatch,
  recordTerminalAdjudication,
  resolveDynamicDeliveryFinalizerBlocker,
  resolveTerminalFailureReason,
  runTerminalAdjudicationDerivedEffects,
  terminalTaskBudgetSnapshot,
} from './run-finalizer-adjudication'
export { resolveDynamicDeliveryFinalizerBlocker } from './run-finalizer-adjudication'
import {
  isValidContinuationHandle,
  requiresCheckpointContinuationHandle,
  toRunCloseMetric,
  writeRunMetaOutcome,
  writeTerminalOutcome,
} from './run-finalizer-persistence'

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

  if (outcome.kind === 'done') {
    const finalized = await writeTerminalOutcome(outcome, deps, 'done', outcome.terminalReason || 'done')
    closeoutBrowserClaimsIfOwned(outcome, deps, {
      ownerRunId: outcome.runId,
      resumable: false,
      suspensionCheckpointId: null,
      suspensionReason: null,
    })
    return finalized
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

    const finalized = await writeTerminalOutcome(outcome, deps, 'checkpoint', outcome.terminalReason || 'checkpoint')
    closeoutBrowserClaimsIfOwned(outcome, deps, {
      ownerRunId: outcome.runId,
      resumable: true,
      suspensionCheckpointId: outcome.continuationHandle,
      suspensionReason: outcome.terminalReason || 'checkpoint',
    })
    return finalized
  }

  const finalized = await writeTerminalOutcome(
    outcome,
    deps,
    statusFromOutcomeKind(outcome.kind),
    outcome.terminalReason
  )
  const recoverable = Boolean(
    outcome.projectionPatch
    && ['recoverable_paused', 'paused'].includes(String(outcome.projectionPatch.status || '')),
  )
  closeoutBrowserClaimsIfOwned(outcome, deps, {
    ownerRunId: outcome.runId,
    resumable: recoverable,
    suspensionCheckpointId: recoverable
      ? String(outcome.projectionPatch?.continuationHandle || outcome.projectionPatch?.checkpointId || '') || null
      : null,
    suspensionReason: recoverable ? outcome.terminalReason : null,
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
