import type {
  CodexBindingRepository,
  CodexLifecycleAction,
  CodexProductTurnRuntimeRead,
} from './codex-binding-repository'
import type { CodexPendingInteractionRestartPlan } from './codex-pending-interaction-restart'
import type { CodexRuntimeHostPort } from './codex-runtime-composition'
import { ReadyCodexLifecyclePortError } from './ready-codex-lifecycle-adapter'
import type { CanonicalCoreCloseoutInput } from '../../repositories/agent-session-checkpoint-types'
import type { TaskProjectionRecord } from '../contracts/run-contracts'
import { finalizePreparedRunOutcome, writeRunCloseMetric, type RunOutcome, type RunFinalizerDeps } from '../runtime-core/run-finalizer'
import { prepareTerminalOutcome } from '../runtime-core/run-finalizer-persistence'
import { appendProofRefs, type ProofRef } from '../quality/proof-collector'
import type { CodexTerminalCloseoutEvidence } from './codex-binding-repository'

export type CodexProductCloseoutMode = 'product' | 'verifier_accepted' | 'verifier_rejected' | 'publication_diverged' | 'history_reset_required' | 'recovery_failure' | 'lifecycle_stop' | 'lifecycle_close' | 'lifecycle_reset'

export function resolveCodexUnownedNativeTerminalCloseout(input: {
  engineOutcome: 'completed' | 'interrupted' | 'failed'
  publicationDiverged: boolean
}): {
  status: 'error'
  terminalReason: 'blocked_external' | 'persistence_failed'
  errorCode: string
  closeoutMode: 'product' | 'publication_diverged'
} {
  return {
    status: 'error',
    terminalReason: input.engineOutcome === 'completed'
      ? 'persistence_failed'
      : 'blocked_external',
    errorCode: input.publicationDiverged
      ? 'codex_tool_publication_diverged'
      : input.engineOutcome === 'interrupted'
        ? 'codex_unowned_runtime_interrupt'
        : 'codex_native_terminal_rejected',
    closeoutMode: input.publicationDiverged ? 'publication_diverged' : 'product',
  }
}

export class CodexProductCloseoutExpectationGuard {
  private readonly expected = new Map<string, {
    mode: CodexProductCloseoutMode
    token: symbol
    recoveryFailure: null | {
      code: string
      evidenceDigest: string
      pendingInteractionRestart: CodexPendingInteractionRestartPlan | null
    }
    terminalEvidence: CodexTerminalCloseoutEvidence | null
  }>()

  acquire(readyRunId: string, mode: CodexProductCloseoutMode): symbol {
    if (this.expected.has(readyRunId)) {
      throw new Error('codex_product_closeout_in_flight')
    }
    const token = Symbol(readyRunId)
    this.expected.set(readyRunId, {
      mode,
      token,
      recoveryFailure: null,
      terminalEvidence: null,
    })
    return token
  }

  acquireRecoveryFailure(
    readyRunId: string,
    input: {
      code: string
      evidenceDigest: string
      pendingInteractionRestart?: CodexPendingInteractionRestartPlan | null
    },
  ): symbol {
    const token = this.acquire(readyRunId, 'recovery_failure')
    const expected = this.expected.get(readyRunId)
    if (!expected || expected.token !== token) throw new Error('codex_product_closeout_in_flight')
    expected.recoveryFailure = {
      ...input,
      pendingInteractionRestart: input.pendingInteractionRestart || null,
    }
    return token
  }

  release(readyRunId: string, token: symbol): void {
    if (this.expected.get(readyRunId)?.token === token) this.expected.delete(readyRunId)
  }

  readMode(readyRunId: string): CodexProductCloseoutMode | null {
    return this.expected.get(readyRunId)?.mode ?? null
  }

  readRecoveryFailure(readyRunId: string): {
    code: string
    evidenceDigest: string
    pendingInteractionRestart: CodexPendingInteractionRestartPlan | null
  } | null {
    const expected = this.expected.get(readyRunId)
    return expected?.mode === 'recovery_failure' ? expected.recoveryFailure : null
  }

  setTerminalEvidence(
    readyRunId: string,
    evidence: CodexTerminalCloseoutEvidence,
  ): void {
    const expected = this.expected.get(readyRunId)
    if (!expected) throw new Error('codex_product_closeout_expectation_missing')
    if (expected.terminalEvidence) throw new Error('codex_terminal_evidence_already_set')
    expected.terminalEvidence = evidence
  }

  readTerminalEvidence(readyRunId: string): CodexTerminalCloseoutEvidence | null {
    return this.expected.get(readyRunId)?.terminalEvidence || null
  }
}

export class CodexCloseCandidateInFlightOwner<T> {
  private readonly inFlight = new Map<string, {
    candidateIdentityDigest: string
    promise: Promise<T>
  }>()

  run(input: {
    readyRunId: string
    candidateIdentityDigest: string
    close: () => Promise<T>
  }): Promise<T> {
    const existing = this.inFlight.get(input.readyRunId)
    if (existing) {
      if (existing.candidateIdentityDigest !== input.candidateIdentityDigest) {
        return Promise.reject(new Error('codex_closeout_in_flight_candidate_conflict'))
      }
      return existing.promise
    }
    const promise = input.close()
    this.inFlight.set(input.readyRunId, {
      candidateIdentityDigest: input.candidateIdentityDigest,
      promise,
    })
    const release = () => {
      if (this.inFlight.get(input.readyRunId)?.promise === promise) {
        this.inFlight.delete(input.readyRunId)
      }
    }
    void promise.then(release, release)
    return promise
  }
}

export async function finalizeCodexProductCloseout(input: {
  closeout: Omit<CanonicalCoreCloseoutInput, 'repairDerivedState'>
  toolCalls: ReadonlyArray<{
    itemId: string
    tool: string
    status: string
    success: boolean | null
  }>
  durableProofs?: readonly ProofRef[]
  publishedToolEvidence?: ReadonlyArray<{
    itemId: string
    tool: string
    proofs: readonly ProofRef[]
  }>
  taskProjectionStore: {
    get(taskId: string): TaskProjectionRecord | null
    update(
      taskId: string,
      patch: Partial<TaskProjectionRecord>,
      options?: { silent?: boolean; reasonHint?: string },
    ): void
  }
  commitCanonicalCoreCloseout(
    closeout: Omit<CanonicalCoreCloseoutInput, 'repairDerivedState'>,
  ): Promise<{
    canonicalMessage: import('../../../../shared/ipc-contracts/canonical-message').CanonicalAssistantMessage
    canonicalMessageDigest: string
  }>
}): Promise<{
  status: string
  terminalReason: string
  productTerminalDigest: string
  closeoutAt: string
  canonicalMessage: import('../../../../shared/ipc-contracts/canonical-message').CanonicalAssistantMessage
  canonicalMessageDigest: string
}> {
  const durableProofs = input.publishedToolEvidence
    ? input.publishedToolEvidence.flatMap((entry) => entry.proofs)
    : input.durableProofs ?? []
  const requested = adjudicateCodexProductCloseout({
    closeout: input.closeout,
    toolCalls: input.toolCalls,
    publishedToolEvidence: input.publishedToolEvidence ?? [],
  })
  if (durableProofs.length) {
    const projection = input.taskProjectionStore.get(requested.parentTaskId)
    if (!projection || projection.runId !== requested.ownerRunId) {
      throw new Error('codex_product_task_projection_missing')
    }
    const existingDigests = new Set(
      (projection.proofRefs || []).flatMap((proof) => (
        proof && typeof proof === 'object' && typeof (proof as { digest?: unknown }).digest === 'string'
          ? [(proof as { digest: string }).digest]
          : []
      )),
    )
    const additions = durableProofs.filter((proof) => !existingDigests.has(proof.digest))
    if (additions.length > 0) {
      input.taskProjectionStore.update(requested.parentTaskId, {
        proofRefs: appendProofRefs(projection.proofRefs ?? [], additions),
      }, { silent: true, reasonHint: 'codex_terminal_tool_proof' })
    }
  }
  let outcome: RunOutcome = {
    kind: requested.status,
    runId: requested.ownerRunId,
    taskId: requested.parentTaskId,
    scopeId: requested.conversationId,
    durationMs: requested.durationMs,
    toolCallsUsed: input.toolCalls.length,
    initiator: requested.initiator,
    terminalReason: requested.terminalReason,
    finalText: requested.finalText,
    projectionPatch: {
      ...(requested.taskType ? { taskType: requested.taskType } : {}),
      ...(requested.module ? { module: requested.module } : {}),
      ...(requested.deliveryState ? { deliveryState: requested.deliveryState } : {}),
    },
    providerDiagnostics: requested.providerDiagnostics || null,
    usage: requested.usage || null,
    contextUsage: requested.contextUsage || null,
  }
  const deps: RunFinalizerDeps = {
    taskProjectionStore: input.taskProjectionStore,
    commitCanonicalCoreCloseout: (closeout) => input.commitCanonicalCoreCloseout({
      ...closeout,
      ...(requested.now ? { now: requested.now } : {}),
    }),
    writeRunCloseMetric,
  }
  const prepared = prepareTerminalOutcome(outcome, deps, requested.status, requested.terminalReason)
  // A partially satisfied QC verdict is not an accepted Codex history boundary.
  if (requested.status === 'done' && (prepared.effectiveStatus !== 'done'
    || prepared.adjudication?.verdict !== 'accept')) {
    prepared.effectiveStatus = 'error'
    if (prepared.effectiveTerminalReason === 'done'
      || prepared.effectiveTerminalReason === 'adjudication_degraded') {
      prepared.effectiveTerminalReason = 'proof_gap'
    }
    outcome = {
      ...outcome,
      kind: 'error',
      terminalReason: prepared.effectiveTerminalReason,
      finalText: '本轮还没有满足全部完成要求，未将候选回复作为完成结果交付。已完成的操作和文件状态均已保留。',
    }
  }
  const finalized = await finalizePreparedRunOutcome(outcome, deps, prepared)
  if (!finalized.canonicalMessage || !finalized.canonicalMessageDigest) {
    throw new Error('codex_product_finalizer_canonical_receipt_missing')
  }
  return {
    ...finalized,
    productTerminalDigest: finalized.canonicalMessageDigest,
    closeoutAt: finalized.canonicalMessage.timestamp,
    canonicalMessage: finalized.canonicalMessage,
    canonicalMessageDigest: finalized.canonicalMessageDigest,
  }
}

function adjudicateCodexProductCloseout(input: {
  closeout: Omit<CanonicalCoreCloseoutInput, 'repairDerivedState'>
  toolCalls: ReadonlyArray<{
    itemId: string
    tool: string
    status: string
    success: boolean | null
  }>
  publishedToolEvidence: ReadonlyArray<{
    itemId: string
    tool: string
    proofs: readonly ProofRef[]
  }>
}): Omit<CanonicalCoreCloseoutInput, 'repairDerivedState'> {
  const skillToolFailure = input.closeout.module === 'skill'
    && hasUnresolvedCodexSkillToolFailure(input.toolCalls, input.publishedToolEvidence)
  return skillToolFailure
    ? {
        ...input.closeout,
        status: 'error',
        terminalReason: 'blocked_tool_error',
        initiator: 'tool_failure',
        finalText: '有关键工具在本轮被拦截或不可用，目标没有完成，已按未完成收口。',
      }
    : input.closeout
}

function hasUnresolvedCodexSkillToolFailure(
  calls: ReadonlyArray<{
    itemId: string
    tool: string
    status: string
    success: boolean | null
  }>,
  evidence: ReadonlyArray<{
    itemId: string
    tool: string
    proofs: readonly ProofRef[]
  }>,
): boolean {
  let lastFailure = -1
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    if (call.status === 'failed' || call.success === false) lastFailure = index
  }
  if (lastFailure < 0) return false

  const recoveredCalls = new Map(calls.slice(lastFailure + 1).flatMap((call) => (
    call.status === 'completed' && call.success === true
      ? [[call.itemId, call.tool] as const]
      : []
  )))
  return !evidence.some((entry) => {
    if (recoveredCalls.get(entry.itemId) !== entry.tool) return false
    const hasToolResult = entry.proofs.some((proof) => proof.kind === 'tool_result')
    const hasCompletion = entry.proofs.some((proof) => (
      proof.kind === 'artifact' || proof.kind === 'transaction_confirmed'
    ))
    return hasToolResult && hasCompletion
  })
}

export function runCodexEngineTerminalFinalization(input: {
  deliver: () => void
  cleanup: () => void
  onDeliveryFailure?: (error: unknown) => void
}): void {
  let deliveryError: unknown = null
  try {
    input.deliver()
  } catch (error) {
    deliveryError = error
  }
  input.cleanup()
  if (!deliveryError) return
  if (input.onDeliveryFailure) {
    input.onDeliveryFailure(deliveryError)
    return
  }
  throw deliveryError
}

export function buildCodexEngineTerminalFinalizationKey(input: {
  aliasId: string
  aliasGeneration: number
  readyRunId: string
}): string {
  return `${input.aliasId}\u0000${input.aliasGeneration}\u0000${input.readyRunId}`
}

export function requestCodexEngineTerminalLifecycleActionBeforeCloseout(input: {
  repository: Pick<CodexBindingRepository, 'requestProductInterrupt'>
  host: Pick<CodexRuntimeHostPort, 'abortActiveProductRun'>
  product: Pick<
    CodexProductTurnRuntimeRead,
    | 'readyRunId'
    | 'readyScopeId'
    | 'readyAliasId'
    | 'aliasGeneration'
    | 'codexThreadId'
    | 'codexTurnId'
  >
  action: CodexLifecycleAction
  requestedAt: string
}): void {
  if (!input.product.codexThreadId || !input.product.codexTurnId) {
    throw new ReadyCodexLifecyclePortError('persistence_failed')
  }
  input.repository.requestProductInterrupt({
    action: input.action,
    aliasId: input.product.readyAliasId,
    aliasGeneration: input.product.aliasGeneration,
    readyRunId: input.product.readyRunId,
    codexThreadId: input.product.codexThreadId,
    codexTurnId: input.product.codexTurnId,
    requestedAt: input.requestedAt,
  })
  const aborted = input.host.abortActiveProductRun({
    readyRunId: input.product.readyRunId,
    readyScopeId: input.product.readyScopeId,
    readyAliasId: input.product.readyAliasId,
  })
  if (!aborted) throw new ReadyCodexLifecyclePortError('persistence_failed')
}

export function requestCodexEngineTerminalUserStopBeforeCloseout(input: Omit<
  Parameters<typeof requestCodexEngineTerminalLifecycleActionBeforeCloseout>[0],
  'action'
>): void {
  requestCodexEngineTerminalLifecycleActionBeforeCloseout({ ...input, action: 'stop' })
}
