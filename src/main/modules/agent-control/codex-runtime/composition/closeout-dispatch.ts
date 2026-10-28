import { workflowDigest } from '../../../repositories/browser-workflow-codec'
import type { ExecutionHostResult } from '../../contracts/run-contracts'
import { digestCanonicalJson } from '../codex-model-gateway-contract'
import { settleCodexPendingInteractionsInMemoryAfterCommit, type CodexPendingInteractionRestartPlan } from '../codex-pending-interaction-restart'
import { CodexCloseCandidateInFlightOwner } from '../codex-product-closeout-support'
import { terminalEvent } from '../codex-product-lifecycle-store'
import { codexTerminalPublicMessage } from '../codex-product-turn-presentation'
import type { ReadyClosedCodexProductRun } from '../codex-runtime-composition'
import type { CoreTurnCandidate } from '../codex-turn-collector'
import type { CodexCompositionBase } from './base'
import type { CandidateCloseout } from './candidate-closeout'
import type { CloseoutSupport } from './closeout-support'
import type { CodexCompositionLive } from './live-state'
import { codexFailureDiagnostics, isoNow } from './support'

export type CloseoutDispatchDeps = Pick<CandidateCloseout, 'closeCandidateOwned'>
  & Pick<CodexCompositionBase, 'commitExpectedCodexRecoveryFailure' | 'detailPrepared' | 'preparedDetails' | 'releaseBrowserTurnLease' | 'repository'>
  & Pick<CloseoutSupport, 'readProductTaskFacts'>
  & { readonly live: CodexCompositionLive }

/** Single-flight dispatch of candidate closeouts and run-local recovery failures. */
export function createCloseoutDispatch(deps: CloseoutDispatchDeps) {
  const { live, closeCandidateOwned, commitExpectedCodexRecoveryFailure, detailPrepared, preparedDetails, readProductTaskFacts, releaseBrowserTurnLease, repository } = deps
  const closeCandidateInFlight = new CodexCloseCandidateInFlightOwner<ReadyClosedCodexProductRun>()

  const closeCandidateIdentityDigest = (candidate: CoreTurnCandidate): string => workflowDigest({
    kind: candidate.kind,
    readyRunId: candidate.readyRunId,
    readyTaskId: candidate.readyTaskId,
    scopeId: candidate.scopeId,
    codexThreadId: candidate.codexThreadId,
    codexTurnId: candidate.codexTurnId,
    ...(candidate.kind === 'native_terminal'
      ? {
          engineOutcome: candidate.engineOutcome,
          candidateSelection: candidate.candidateSelection,
          candidateDigest: candidate.candidateDigest,
        }
      : { hostFailure: candidate.hostFailure }),
  })

  const closeCandidate = (candidate: CoreTurnCandidate): Promise<ReadyClosedCodexProductRun> => {
    const candidateIdentityDigest = closeCandidateIdentityDigest(candidate)
    return closeCandidateInFlight.run({
      readyRunId: candidate.readyRunId,
      candidateIdentityDigest,
      close: () => closeCandidateOwned(candidate),
    })
  }
  live.closeCandidate = closeCandidate

  const closeRunLocalRecoveryFailure = async (
    readyRunId: string,
    errorCode: string,
    pendingInteractionRestart?: CodexPendingInteractionRestartPlan,
  ): Promise<ReadyClosedCodexProductRun> => {
    const product = repository.readProductTurnRuntime(readyRunId)
    const boundHost = live.host
    const scope = boundHost?.getScope(product.readyScopeId)
    if (!boundHost || !scope) throw new Error('codex_recovery_failure_scope_missing')
    const taskFacts = readProductTaskFacts(boundHost, product)
    const evidenceDigest = pendingInteractionRestart?.evidenceDigest || digestCanonicalJson({
      contract: 'codex_product_recovery_failure_v1',
      readyRunId: product.readyRunId,
      readyTaskId: product.readyTaskId,
      readyAliasId: product.readyAliasId,
      aliasGeneration: product.aliasGeneration,
      codexThreadId: product.codexThreadId,
      codexTurnId: product.codexTurnId,
      errorCode,
    })
    const committed = await commitExpectedCodexRecoveryFailure(
      product.readyRunId,
      { code: errorCode, evidenceDigest, pendingInteractionRestart },
      () => boundHost.commitCodexProductTurnCloseout({
        parentTaskId: product.readyTaskId,
        ownerRunId: product.readyRunId,
        conversationId: product.readyScopeId,
        status: pendingInteractionRestart ? 'interrupted' : 'error',
        terminalReason: pendingInteractionRestart ? 'cancelled_runtime' : 'persistence_failed',
        initiator: 'codex_recovery',
        durationMs: Math.max(1, Date.now() - Date.parse(product.admittedAt)),
        ...taskFacts,
        finalText: codexTerminalPublicMessage(
          pendingInteractionRestart ? 'interrupted' : 'error',
        ),
        providerDiagnostics: codexFailureDiagnostics({ error: errorCode, module: taskFacts.module }),
        now: pendingInteractionRestart?.cancelledAt || isoNow(),
      }),
    )
    if (pendingInteractionRestart) {
      settleCodexPendingInteractionsInMemoryAfterCommit(pendingInteractionRestart.interactions)
    }
    if (live.registry?.snapshot().members.some(
      (member) => member.reservationSetId === product.reservationSetId,
    )) {
      live.registry.releaseAfterHostFailure({
        reservationSetId: product.reservationSetId,
        productTerminalDigest: committed.productTerminalDigest,
      })
    }
    releaseBrowserTurnLease(product.readyRunId)
    preparedDetails.delete(product.readyRunId)
    detailPrepared.delete(product.readyRunId)
    const productCloseout = repository.readProductCloseout(product.readyRunId)
    if (!productCloseout
      || productCloseout.productTerminalDigest !== committed.productTerminalDigest
      || productCloseout.productCloseoutAt !== committed.closeoutAt) {
      throw new Error('codex_recovery_failure_closeout_readback_missing')
    }
    const execution: ExecutionHostResult = {
      success: false,
      finalText: committed.canonicalMessage.content,
      cancelled: Boolean(pendingInteractionRestart),
      usedTools: [],
      error: errorCode,
      taskId: product.readyTaskId,
      taskProjectionId: product.readyTaskId,
      taskType: taskFacts.taskType,
      interactionState: 'suspended',
      terminalReason: pendingInteractionRestart ? 'cancelled_runtime' : 'persistence_failed',
      canonicalMessage: committed.canonicalMessage,
      canonicalMessageDigest: committed.canonicalMessageDigest,
      productTurnReceipt: repository.readProductTurnPresentation(product.readyRunId),
    }
    return {
      execution,
      productOutcomeDigest: productCloseout.productTerminalDigest,
      candidateBodyDigest: null,
      committedTerminalEvent: terminalEvent({
        scope,
        product,
        execution,
        terminalAt: productCloseout.productCloseoutAt,
      }),
    }
  }

  return {
    closeCandidateInFlight,
    closeCandidateIdentityDigest,
    closeCandidate,
    closeRunLocalRecoveryFailure,
  }
}

export type CloseoutDispatch = ReturnType<typeof createCloseoutDispatch>
