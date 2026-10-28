import { getEphemeralExecutionStore } from '../../../tools/skill-primitives/ephemeral-execution-store'
import type { TaskProjectionRecord, ExecutionHostResult } from '../../contracts/run-contracts'
import { READY_MEMORY_SEARCH_TOOL_NAME } from '../../ready-memory'
import type { CodexLifecycleAction, CodexProductTurnRuntimeRead, CodexHostFailureRecovery } from '../codex-binding-repository'
import { readCodexFolderOutputActivation } from '../codex-folder-output-activation'
import { completeCodexPendingInteractionRestartInOpenTransaction } from '../codex-pending-interaction-restart'
import { terminalEvent } from '../codex-product-lifecycle-store'
import { resolveCodexProductCloseoutTaskFacts } from '../codex-product-task-facts'
import { codexTerminalPublicMessage } from '../codex-product-turn-presentation'
import type { CodexRuntimeHostPort, ReadyClosedCodexProductRun } from '../codex-runtime-composition'
import type { CodexStartIdentityRegistry } from '../codex-start-identity-registry'
import { resolveCodexHistoryObservation, type CodexTerminalNativeReadbackReceipt, type CodexHistoryObservation } from '../codex-terminal-facts'
import type { CoreTurnCandidate } from '../codex-turn-collector'
import type { CodexCompositionBase } from './base'
import type { CodexCompositionLive } from './live-state'
import { isoNow, codexFailureDiagnostics } from './support'

export type HostFailureSettlement = {
  readyRunId: string
  reservationSetId: string
  productTerminalDigest: string
  closeoutAt: string
  result: ReadyClosedCodexProductRun
}

export type CloseoutSupportDeps = Pick<CodexCompositionBase, 'detailPrepared' | 'expectedCodexCloseouts' | 'materializedForkTargets' | 'memoryRuntime' | 'ownerMainBootId' | 'pendingNativeForkSeeds' | 'preparedDetails' | 'publishCodexActionSurfaceInvalidation' | 'rawDb' | 'readyMemoryRepository' | 'repository' | 'scheduleThreadArchiveCleanup'>
  & { readonly live: CodexCompositionLive }

/** Closeout pieces every terminal path uses: the canonical participant, host-failure closeout and history reads. */
export function createCloseoutSupport(deps: CloseoutSupportDeps) {
  const { live, detailPrepared, expectedCodexCloseouts, materializedForkTargets, memoryRuntime, ownerMainBootId, pendingNativeForkSeeds, preparedDetails, publishCodexActionSurfaceInvalidation, rawDb, readyMemoryRepository, repository, scheduleThreadArchiveCleanup } = deps
  const participant = {
    prepare(closeout: { readyRunId: string }) {
      const product = repository.readProductTurnRuntime(closeout.readyRunId)
      getEphemeralExecutionStore().prepareRunTerminalFence(
        product.readyScopeId,
        closeout.readyRunId,
      )
    },
    afterCommit(closeout: { readyRunId: string }) {
      const product = repository.readProductTurnRuntime(closeout.readyRunId)
      getEphemeralExecutionStore().commitRunTerminalFence(
        product.readyScopeId,
        closeout.readyRunId,
        new Error('waiting_task_gone'),
      )
      publishCodexActionSurfaceInvalidation(product.readyAliasId)
    },
    afterRollback(closeout: { readyRunId: string }) {
      const product = repository.readProductTurnRuntime(closeout.readyRunId)
      getEphemeralExecutionStore().rollbackRunTerminalFence(
        product.readyScopeId,
        closeout.readyRunId,
      )
    },
    complete(closeout: { readyRunId: string; productTerminalDigest: string; closeoutAt: string }) {
      const product = repository.readProductTurnRuntime(closeout.readyRunId)
      const snapshot = product.prepared.readyMemorySnapshot
      const readEntryIds = repository.readPublishedToolOutputs(closeout.readyRunId)
        .filter((output) => output.toolName === READY_MEMORY_SEARCH_TOOL_NAME)
        .flatMap((output) => {
          const data = output.output.data
          if (!data || data.snapshotDigest !== snapshot.snapshotDigest
            || !Array.isArray(data.readEntryIds)
            || data.readEntryIds.some((entryId) => typeof entryId !== 'string' || !entryId)) {
            throw new Error('ready_memory_published_read_invalid')
          }
          return data.readEntryIds as string[]
        })
      const readReceipt = readyMemoryRepository.createReadReceipt(
        snapshot,
        readEntryIds,
        closeout.closeoutAt,
      )
      readyMemoryRepository.recordReadReceiptForTurn(
        closeout.readyRunId,
        snapshot,
        readReceipt,
        closeout.closeoutAt,
      )
      scheduleThreadArchiveCleanup()
      const expected = expectedCodexCloseouts.readMode(closeout.readyRunId)
      if (!expected) {
        repository.completeCanonicalProductCloseoutInOpenTransaction(closeout)
        return
      }
      if (expected === 'recovery_failure') {
        const failure = expectedCodexCloseouts.readRecoveryFailure(closeout.readyRunId)
        if (!failure) throw new Error('codex_recovery_failure_expectation_missing')
        const result = repository.completeRecoveryFailureCloseoutInOpenTransaction({
          ...closeout,
          recoveryFailureCode: failure.code,
          recoveryFailureEvidenceDigest: failure.evidenceDigest,
        })
        if (!result.handled) throw new Error('codex_canonical_closeout_binding_missing')
        if (failure.pendingInteractionRestart) {
          completeCodexPendingInteractionRestartInOpenTransaction({
            db: rawDb,
            plan: failure.pendingInteractionRestart,
            readyRunId: closeout.readyRunId,
            closeoutAt: closeout.closeoutAt,
            recoveryEvidenceDigest: failure.evidenceDigest,
          })
        }
        return
      }
      if (expected === 'lifecycle_stop'
        || expected === 'lifecycle_close'
        || expected === 'lifecycle_reset') {
        const action = expected.slice('lifecycle_'.length) as CodexLifecycleAction
        const terminalEvidence = expectedCodexCloseouts.readTerminalEvidence(closeout.readyRunId)
        if (!terminalEvidence) throw new Error('codex_lifecycle_terminal_evidence_missing')
        const result = repository.completeLifecycleActionCloseoutInOpenTransaction({
          ...closeout,
          action,
          terminalEvidence,
          ...(pendingNativeForkSeeds.get(closeout.readyRunId)
            ? { forkSeed: pendingNativeForkSeeds.get(closeout.readyRunId) }
            : {}),
        })
        if (!result.handled) throw new Error('codex_lifecycle_action_closeout_binding_missing')
        if (typeof result.forkTargetThreadBindingId === 'string') {
          materializedForkTargets.set(closeout.readyRunId, result.forkTargetThreadBindingId)
        }
        if (action === 'close') {
          memoryRuntime.sealClosedConversationInOpenTransaction({
            conversationId: product.prepared.readyToolHostIdentity.scopeId,
            closedAt: closeout.closeoutAt,
          })
        }
        return
      }
      if (expected === 'verifier_rejected') {
        const terminalEvidence = expectedCodexCloseouts.readTerminalEvidence(closeout.readyRunId)
        if (!terminalEvidence) throw new Error('codex_verifier_terminal_evidence_missing')
        const result = repository.completeVerifierRejectedCloseoutInOpenTransaction({
          ...closeout,
          terminalEvidence,
          ...(pendingNativeForkSeeds.get(closeout.readyRunId)
            ? { forkSeed: pendingNativeForkSeeds.get(closeout.readyRunId) }
            : {}),
        })
        if (!result.handled) throw new Error('codex_verifier_rejected_closeout_binding_missing')
        if (result.forkTargetThreadBindingId) {
          materializedForkTargets.set(closeout.readyRunId, result.forkTargetThreadBindingId)
        }
        return
      }
      if (expected === 'verifier_accepted') {
        const terminalEvidence = expectedCodexCloseouts.readTerminalEvidence(closeout.readyRunId)
        if (!terminalEvidence) throw new Error('codex_verifier_terminal_evidence_missing')
        const result = repository.completeVerifierAcceptedCloseoutInOpenTransaction({
          ...closeout,
          terminalEvidence,
        })
        if (!result.handled) throw new Error('codex_verifier_accepted_closeout_binding_missing')
        return
      }
      const terminalEvidence = expectedCodexCloseouts.readTerminalEvidence(closeout.readyRunId)
      const result = expected === 'publication_diverged'
        ? repository.completePublicationDivergenceCloseoutInOpenTransaction({
            ...closeout,
            ...(terminalEvidence ? { terminalEvidence } : {}),
            ...(pendingNativeForkSeeds.get(closeout.readyRunId)
              ? { forkSeed: pendingNativeForkSeeds.get(closeout.readyRunId) }
              : {}),
          })
        : expected === 'history_reset_required'
          ? repository.completeHistoryResetRequiredCloseoutInOpenTransaction({
              ...closeout,
              terminalEvidence: terminalEvidence || (() => {
                throw new Error('codex_history_reset_terminal_evidence_missing')
              })(),
            })
        : repository.completeCanonicalProductCloseoutInOpenTransaction({
            ...closeout,
            ...(terminalEvidence ? { terminalEvidence } : {}),
          })
      if (!result.handled) throw new Error('codex_canonical_closeout_binding_missing')
      if ('forkTargetThreadBindingId' in result
        && typeof result.forkTargetThreadBindingId === 'string') {
        materializedForkTargets.set(closeout.readyRunId, result.forkTargetThreadBindingId)
      }
    },
  }

  const releaseHostFailureReservationIfPresent = (
    activeRegistry: CodexStartIdentityRegistry | null,
    settlement: HostFailureSettlement,
  ): void => {
    if (!activeRegistry?.snapshot().members.some(
      (member) => member.reservationSetId === settlement.reservationSetId,
    )) return
    activeRegistry.releaseAfterHostFailure({
      reservationSetId: settlement.reservationSetId,
      productTerminalDigest: settlement.productTerminalDigest,
    })
  }

  const readProductTaskFacts = (
    boundHost: CodexRuntimeHostPort,
    product: CodexProductTurnRuntimeRead,
  ): Pick<TaskProjectionRecord, 'taskType' | 'module'> => {
    const projection = boundHost.getTaskProjectionStore().get(product.readyTaskId)
    if (!projection || projection.runId !== product.readyRunId) {
      throw new Error('codex_product_task_projection_missing')
    }
    const facts = { taskType: projection.taskType, module: projection.module }
    if (
      facts.taskType !== 'direct_answer'
      || facts.module !== 'system'
      || !product.prepared.outputContract
    ) return facts
    return resolveCodexProductCloseoutTaskFacts(
      { taskType: facts.taskType, module: 'system' },
      readCodexFolderOutputActivation(rawDb, product.readyRunId),
    )
  }

  const closePersistedHostFailure = async (
    failure: CodexHostFailureRecovery,
  ): Promise<HostFailureSettlement> => {
    const fence = repository.readRecoverySnapshot(
      (epoch) => live.sidecarSession?.isConnectionLive(epoch) || false,
    ).productFences.find((entry) => entry.readyRunId === failure.readyRunId)
    if (fence && fence.ownerMainBootId !== ownerMainBootId) {
      repository.claimProductFenceForBoot({
        threadBindingId: fence.threadBindingId,
        readyRunId: fence.readyRunId,
        expectedOwnerMainBootId: fence.ownerMainBootId,
        newOwnerMainBootId: ownerMainBootId,
        claimedAt: isoNow(),
      })
    }
    const product = repository.readProductTurnRuntime(failure.readyRunId)
    const boundHost = live.host
    const scope = boundHost?.getScope(product.readyScopeId)
    if (!boundHost || !scope) throw new Error('codex_host_failure_scope_missing')
    const taskFacts = readProductTaskFacts(boundHost, product)
    const failureError = 'codex_start_delivery_failed'
    const committed = await boundHost.commitCodexProductTurnCloseout({
      parentTaskId: product.readyTaskId,
      ownerRunId: product.readyRunId,
      conversationId: product.readyScopeId,
      status: 'error',
      terminalReason: 'persistence_failed',
      initiator: 'codex_host_failure_recovery',
      durationMs: 0,
      ...taskFacts,
      finalText: codexTerminalPublicMessage('error'),
      providerDiagnostics: codexFailureDiagnostics({ error: failureError, module: taskFacts.module }),
      now: isoNow(),
    })
    const completed = repository.completeHostFailureCloseout({
      readyRunId: product.readyRunId,
      productTerminalDigest: committed.productTerminalDigest,
      continuationBlockedReason: failure.continuationBlockedReason,
      closeoutAt: committed.closeoutAt,
    })
    if (completed.reservationSetId !== failure.reservationSetId) {
      throw new Error('codex_host_failure_reservation_set_mismatch')
    }
    const productCloseout = repository.readProductCloseout(product.readyRunId)
    if (!productCloseout
      || productCloseout.productTerminalDigest !== committed.productTerminalDigest
      || productCloseout.productCloseoutAt !== committed.closeoutAt) {
      throw new Error('codex_host_failure_closeout_readback_missing')
    }
    const execution: ExecutionHostResult = {
      success: false,
      finalText: committed.canonicalMessage.content,
      cancelled: false,
      usedTools: [],
      error: 'codex_start_delivery_failed',
      taskId: product.readyTaskId,
      taskProjectionId: product.readyTaskId,
      taskType: taskFacts.taskType,
      interactionState: 'suspended',
      terminalReason: 'persistence_failed',
      canonicalMessage: committed.canonicalMessage,
      canonicalMessageDigest: committed.canonicalMessageDigest,
      productTurnReceipt: repository.readProductTurnPresentation(product.readyRunId),
    }
    preparedDetails.delete(product.readyRunId)
    detailPrepared.delete(product.readyRunId)
    return {
      readyRunId: product.readyRunId,
      reservationSetId: completed.reservationSetId,
      productTerminalDigest: productCloseout.productTerminalDigest,
      closeoutAt: productCloseout.productCloseoutAt,
      result: {
        execution,
        productOutcomeDigest: productCloseout.productTerminalDigest,
        candidateBodyDigest: null,
        committedTerminalEvent: terminalEvent({
          scope,
          product,
          execution,
          terminalAt: productCloseout.productCloseoutAt,
        }),
      },
    }
  }

  const readAlreadyCommittedCloseout = (
    product: CodexProductTurnRuntimeRead,
    candidate: CoreTurnCandidate,
  ): ReadyClosedCodexProductRun | null => {
    const committedCloseout = repository.readProductCloseout(product.readyRunId)
    if (!committedCloseout) return null
    const boundHost = live.host
    if (!boundHost) throw new Error('codex_runtime_host_unbound')
    const scope = boundHost.getScope(product.readyScopeId)
    if (!scope) throw new Error('codex_scope_missing_during_closeout')
    const taskFacts = readProductTaskFacts(boundHost, product)
    const receipt = repository.readProductTurnPresentation(product.readyRunId)
    const terminalReason = repository.readTerminalCloseoutEvidence(product.readyRunId)
      ?.terminalFacts.product.terminalReason ?? receipt.canonicalMessage.meta.terminalReason
    if (typeof terminalReason !== 'string' || !terminalReason) {
      throw new Error('codex_persisted_terminal_reason_missing')
    }
    const successful = receipt.terminal === 'done'
    const cancelled = receipt.terminal === 'cancelled' || receipt.terminal === 'interrupted'
    const execution: ExecutionHostResult = {
      success: successful,
      finalText: receipt.canonicalMessage.content,
      cancelled,
      usedTools: receipt.tools.map((tool) => tool.toolName),
      ...(successful ? {} : { error: receipt.failure?.kind || 'unknown' }),
      taskId: product.readyTaskId,
      taskProjectionId: product.readyTaskId,
      taskType: taskFacts.taskType,
      interactionState: successful ? 'running' : 'suspended',
      terminalReason: terminalReason as ExecutionHostResult['terminalReason'],
      canonicalMessage: receipt.canonicalMessage,
      canonicalMessageDigest: receipt.canonicalMessageDigest,
      contextUsage: receipt.contextUsage,
      productTurnReceipt: receipt,
    }
    preparedDetails.delete(product.readyRunId)
    detailPrepared.delete(product.readyRunId)
    return {
      execution,
      productOutcomeDigest: committedCloseout.productTerminalDigest,
      candidateBodyDigest: candidate.kind === 'native_terminal' ? candidate.candidateDigest : null,
      committedTerminalEvent: terminalEvent({
        scope,
        product,
        execution,
        terminalAt: committedCloseout.productCloseoutAt,
      }),
    }
  }

  const observeTerminalHistory = (
    input: Parameters<typeof resolveCodexHistoryObservation>[0],
    nativeReadback: CodexTerminalNativeReadbackReceipt,
  ): CodexHistoryObservation => {
    const observation = resolveCodexHistoryObservation(input)
    if (observation.kind === 'diverged') {
      const prefix = repository.readAcceptedNativePrefixResolution({
        readyRunId: input.candidate.readyRunId, nativeReadback,
      })
      if (prefix.kind === 'unknown') {
        return { kind: 'unknown_reset_required', reason: prefix.reason ?? 'formal_input_mapping_unknown' }
      }
    }
    return observation
  }

  return {
    participant,
    releaseHostFailureReservationIfPresent,
    readProductTaskFacts,
    closePersistedHostFailure,
    readAlreadyCommittedCloseout,
    observeTerminalHistory,
  }
}

export type CloseoutSupport = ReturnType<typeof createCloseoutSupport>
