import { isRunMetaTerminalStatus, type RunMetaTerminalStatus } from '../../../../shared/run-meta-terminal-status'
import { assertDeliveryState } from '../../../../shared/dynamic-delivery'
import { getBudgetUsagePercent } from '../task-projection/run-budget-policy'
import { canResumeAsUserPoint } from '../contracts/resume-handle'
import type { CanonicalAssistantMessageReceipt } from '../../../../shared/ipc-contracts/canonical-message'
import type { BrowserWorkflowCompletionVerifierReceipt } from '../../../../shared/browser-workflow-control'
import { workflowDigest } from '../../repositories/browser-workflow-codec'
import type { FinalizedRunOutcome, RunCloseMetric, RunFinalizerDeps, RunOutcome, RunOutcomeUsage } from './run-finalizer-contracts'
import { isBrowserTransactionTask, resolveEffectiveTaskFacts, type EffectiveTaskFacts } from './run-finalizer-task-facts'
import { canKeepProofBearingDegradedVisible, continuationFromProjectionPatch, recordTerminalAdjudication, resolveDynamicDeliveryFinalizerBlocker, resolveTerminalFailureReason, runTerminalAdjudicationDerivedEffects, terminalTaskBudgetSnapshot } from './run-finalizer-adjudication'

export async function writeTerminalOutcome(
  outcome: RunOutcome,
  deps: RunFinalizerDeps,
  status: RunMetaTerminalStatus,
  terminalReason: string
): Promise<FinalizedRunOutcome> {
  const facts = resolveEffectiveTaskFacts(outcome, deps)
  const deliveryState = (() => {
    const candidate = outcome.projectionPatch?.deliveryState
    if (candidate !== undefined) {
      assertDeliveryState(candidate)
      return candidate
    }
    if (!deps.taskProjectionStore || !outcome.taskId) return null
    return deps.taskProjectionStore.get(outcome.taskId)?.deliveryState ?? null
  })()
  const deliveryBlocker = status === 'done'
    ? resolveDynamicDeliveryFinalizerBlocker(deliveryState)
    : null
  const deliveryAccepted = Boolean(
    deliveryState
    && deliveryState.decision !== 'single_path'
    && deliveryState.verifier.status === 'accepted'
  )
  const handoffSuperseded = (() => {
    if (!deps.taskProjectionStore || !outcome.taskId) return false
    const projection = deps.taskProjectionStore.get(outcome.taskId)
    const continuation = projection?.continuationRef
    if (!continuation || typeof continuation !== 'object') return false
    const ref = continuation as Record<string, unknown>
    return ref.kind === 'handoff_takeover' && ref.priorRunId === outcome.runId
  })()
  const adjudication = handoffSuperseded || deliveryBlocker || status === 'checkpoint'
    ? null
    : recordTerminalAdjudication(outcome, deps, status, terminalReason, facts)
  let effectiveStatus: RunMetaTerminalStatus = status
  let effectiveTerminalReason = terminalReason
  if (deliveryBlocker) {
    effectiveStatus = 'error'
    effectiveTerminalReason = deliveryBlocker
  }
  if (!deliveryBlocker && !handoffSuperseded && status === 'done' && !adjudication && isBrowserTransactionTask(facts)) {
    effectiveStatus = 'error'
    effectiveTerminalReason = 'browser_transaction_unconfirmed'
  }
  if (
    !deliveryBlocker
    && !deliveryAccepted
    && !handoffSuperseded
    && status === 'done'
    && adjudication
    && adjudication.verdict !== 'accept'
  ) {
    const taskContinuation = continuationFromProjectionPatch(outcome.projectionPatch)
    if (isBrowserTransactionTask(facts)) {
      effectiveStatus = 'error'
      effectiveTerminalReason = resolveTerminalFailureReason(
        outcome.projectionPatch,
        adjudication,
        facts
      )
    } else if (canResumeAsUserPoint(taskContinuation)) {
      effectiveStatus = 'checkpoint'
      effectiveTerminalReason = 'checkpoint_budget'
    } else if (
      !(facts.taskType === 'research' && outcome.toolCallsUsed === 0)
      && canKeepProofBearingDegradedVisible(adjudication, outcome.projectionPatch, facts)
    ) {
      // P1: a run that DID satisfy part of its criteria stays
      // 'done' with a visible degraded reason — does not force-fail the run.
      // Proofs that satisfy no criteria are hard-converted in this mode.
      effectiveTerminalReason = 'adjudication_degraded'
    } else {
      effectiveStatus = 'error'
      effectiveTerminalReason = resolveTerminalFailureReason(
        outcome.projectionPatch,
        adjudication,
        facts
      )
    }
  }
  // P1 fix (2026-07-03, live regression) — a browser_transaction run that is
  // finalized DIRECTLY as kind:'error' (not via the done→adjudication path
  // above) previously kept a generic `proof_gap`/`adjudication_degraded`
  // reason, so the publish task surfaced as a hard "失败" instead of the
  // recoverable "网页操作还没有成功证据，可以继续". The ledger showed
  // browser_transaction + proof_gap rows for exactly this path. Normalize any
  // generic completion-evidence gap on a browser transaction to the
  // recoverable unconfirmed reason, regardless of which path set it.
  if (
    isBrowserTransactionTask(facts) &&
    effectiveStatus === 'error' &&
    (effectiveTerminalReason === 'proof_gap' || effectiveTerminalReason === 'adjudication_degraded')
  ) {
    effectiveTerminalReason = 'browser_transaction_unconfirmed'
  }
  let canonicalReceipt: CanonicalAssistantMessageReceipt | undefined = outcome.canonicalMessageReceipt || undefined
  const checkpointContinuation = continuationFromProjectionPatch(outcome.projectionPatch)
  const checkpointKind = checkpointContinuation
    && typeof checkpointContinuation === 'object'
    ? String((checkpointContinuation as Record<string, unknown>).kind || '')
    : ''
  if (
    effectiveStatus === 'checkpoint'
    && (checkpointKind === 'browser_checkpoint' || checkpointKind === 'human_takeover')
    && !canonicalReceipt
  ) throw new Error('browser_checkpoint_canonical_receipt_missing')
  const completionVerifierReceipt: BrowserWorkflowCompletionVerifierReceipt | null =
    outcome.workflowVerifierAcceptance
    && adjudication?.terminalQualityPatch
    && outcome.taskId
      ? {
          ...outcome.workflowVerifierAcceptance,
          parentTaskId: outcome.taskId,
          ownerRunId: outcome.runId,
          terminalQualityPatchDigest: workflowDigest(adjudication.terminalQualityPatch),
        }
      : null
  if (
    deps.commitCanonicalCoreCloseout
    && outcome.taskId
    && outcome.scopeId
    && effectiveStatus !== 'checkpoint'
    && typeof outcome.finalText === 'string'
    && outcome.finalText.trim()
  ) {
    canonicalReceipt = await deps.commitCanonicalCoreCloseout({
      parentTaskId: outcome.taskId,
      ownerRunId: outcome.runId,
      status: effectiveStatus === 'done'
        ? 'done'
        : effectiveStatus === 'cancelled'
          ? 'cancelled'
          : effectiveStatus === 'interrupted'
            ? 'interrupted'
            : 'error',
      terminalReason: effectiveTerminalReason,
      initiator: outcome.initiator,
      durationMs: outcome.durationMs,
      finalText: outcome.finalText,
      conversationId: outcome.scopeId,
      taskType: facts.taskType,
      module: facts.module,
      budget: terminalTaskBudgetSnapshot(outcome.taskBudgetRuntime),
      budgetUsagePercent: outcome.taskBudgetRuntime
        ? getBudgetUsagePercent(outcome.taskBudgetRuntime)
        : null,
      budgetWarningLevel: outcome.taskBudgetRuntime?.warningLevel ?? null,
      providerDiagnostics: outcome.providerDiagnostics
        ? { ...outcome.providerDiagnostics }
        : null,
      usage: outcome.usage || null,
      deliveryState,
      workflowCloseoutSeal: outcome.workflowCloseoutSeal || null,
      terminalQualityPatch: adjudication?.terminalQualityPatch || null,
      completionVerifierReceipt,
    })
  } else {
    writeRunMetaOutcome(outcome, deps, effectiveStatus, effectiveTerminalReason, facts)
  }
  if (adjudication) {
    runTerminalAdjudicationDerivedEffects({
      adjudication,
      deps,
      outcome,
      terminalStatus: effectiveStatus,
      terminalReason: effectiveTerminalReason,
    })
  }
  if (!handoffSuperseded && deps.writeProjectionTerminalPatch) {
    const terminalProjectionPatch = facts.taskType
      ? { ...(outcome.projectionPatch || {}), taskType: facts.taskType }
      : outcome.projectionPatch || null
    await deps.writeProjectionTerminalPatch(
      terminalProjectionPatch,
      effectiveTerminalReason,
      effectiveStatus,
      canonicalReceipt,
    )
  }
  deps.writeRunCloseMetric({
    ...toRunCloseMetric(outcome, effectiveTerminalReason),
    taskType: facts.taskType
  })
  return {
    status: effectiveStatus,
    terminalReason: effectiveTerminalReason,
    ...(canonicalReceipt || {}),
  }
}

export function writeRunMetaOutcome(
  outcome: RunOutcome,
  deps: RunFinalizerDeps,
  status: RunMetaTerminalStatus,
  terminalReason: string,
  facts?: EffectiveTaskFacts | null
): void {
  if (!isRunMetaTerminalStatus(status)) {
    throw new Error(`Invalid terminal run_meta status: ${status}`)
  }
  const repository = deps.runMetaRepository
  if (!repository) return
  const providerDiagnostics = outcome.providerDiagnostics || null
  const taskBudgetRuntime = outcome.taskBudgetRuntime || null
  const usage = outcome.usage || null
  const patch: Record<string, unknown> = {
    runId: outcome.runId,
    taskId: outcome.taskId ?? null,
    scopeId: outcome.scopeId ?? null,
    status,
    terminalReason,
    initiator: outcome.initiator,
    durationMs: outcome.durationMs
  }
  // run_meta 行内 task_type 必须与同行写入的 budget 同源——两者都来自实际
  // 管辖本 run 的 budget runtime（显式传入或 checkpoint 续跑恢复），否则
  // research 档预算配 direct_answer 类型的自相矛盾行会落库；facts 的推断
  // patch 只在没有 budget runtime 时兜底。taskTypeSource:'missing' 一律
  // 降级为不写（EP2-T1 07 §1.3）：stamping null 会经 spread-merge 清掉旧值。
  const closeoutTaskType = taskBudgetRuntime?.taskType || facts?.taskType || null
  if (closeoutTaskType) {
    patch.taskType = closeoutTaskType
  }
  if (taskBudgetRuntime) {
    patch.budget = {
      ...taskBudgetRuntime.budget,
      ...taskBudgetRuntime.usage
    }
  }
  const usageDiagnostics = usage && typeof usage === 'object'
    ? {
      usageSource: (usage as RunOutcomeUsage & { usageSource?: 'provider' | 'estimated' | 'missing' }).usageSource,
      providerCallCount: (usage as RunOutcomeUsage & { providerCallCount?: number }).providerCallCount,
      missingCallCount: (usage as RunOutcomeUsage & { missingCallCount?: number }).missingCallCount,
    }
    : null
  const persistedProviderDiagnostics = providerDiagnostics || usageDiagnostics
    ? { ...(providerDiagnostics || {}), ...(usageDiagnostics || {}) }
    : null
  if (providerDiagnostics) {
    patch.providerProtocol = providerDiagnostics.agentProtocol || null
    patch.wireApi = providerDiagnostics.wireApi || null
    patch.contextWindow = providerDiagnostics.contextWindow || null
  }
  if (persistedProviderDiagnostics) patch.providerDiagnostics = persistedProviderDiagnostics
  if (usage) {
    patch.inputTokens = usage.inputTokens ?? 0
    patch.outputTokens = usage.outputTokens ?? 0
    patch.totalTokens = usage.totalTokens ?? 0
  }
  if (repository.get(outcome.runId)) {
    repository.update(outcome.runId, patch)
  } else {
    repository.create(patch)
  }
}

export function toRunCloseMetric(outcome: RunOutcome, terminalReason: string): RunCloseMetric {
  const metric: RunCloseMetric = {
    runId: outcome.runId,
    terminalReason,
    initiator: outcome.initiator,
    toolCallsUsed: outcome.toolCallsUsed,
    durationMs: outcome.durationMs,
  }
  if (outcome.providerDiagnostics?.lastProviderFailureHttpStatus !== undefined) {
    metric.lastProviderFailureHttpStatus = outcome.providerDiagnostics.lastProviderFailureHttpStatus
  }
  if (outcome.providerDiagnostics?.lastProviderFailureErrorKind !== undefined) {
    metric.lastProviderFailureErrorKind = outcome.providerDiagnostics.lastProviderFailureErrorKind
  }
  return metric
}

export function isValidContinuationHandle(handle: string | null): handle is string {
  return typeof handle === 'string' && handle.trim().length > 0
}

export function requiresCheckpointContinuationHandle(terminalReason?: string | null): boolean {
  return terminalReason !== 'checkpoint_user_input' && terminalReason !== 'manual_suspend'
}
