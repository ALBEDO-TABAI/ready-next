import { workflowDigest } from '../../../repositories/browser-workflow-codec'
import type { ExecutionHostResult } from '../../contracts/run-contracts'
import { logAgentMetric } from '../../metrics'
import { collectToolOutputProofs } from '../../quality/proof-collector'
import { readExistingTerminalQualityPatch } from '../../runtime-core/run-finalizer-adjudication'
import { normalizeToolExecutionOutput } from '../../tools-runtime/tool-result-types'
import { verifyCodexAutomaticCompactionEvidence } from '../codex-automatic-compaction-evidence'
import { CodexBindingRepository, type CodexBrowserVerifierAttemptRead } from '../codex-binding-repository'
import { verifyCodexBrowserWorkflowCandidate, codexBrowserVerifierFailureCode } from '../codex-browser-workflow-verifier'
import { CodexModelGatewayRepository } from '../codex-model-gateway-authority'
import { finalizeCodexProductCloseout, resolveCodexUnownedNativeTerminalCloseout, type CodexProductCloseoutMode } from '../codex-product-closeout-support'
import { terminalEvent } from '../codex-product-lifecycle-store'
import { resolveCodexBrowserWorkflowTaskFacts } from '../codex-product-task-facts'
import { resolveCodexBrowserWorkflowVerifierBundle } from '../codex-product-turn-authorization'
import { codexTerminalPublicMessage } from '../codex-product-turn-presentation'
import type { ReadyClosedCodexProductRun } from '../codex-runtime-composition'
import { buildTerminalNativeReadbackReceipt, terminalEvidenceRef, terminalNativeReadbackEvidenceRef, terminalGatewayEvidenceRef, terminalIndeterminateEffectEvidenceRef, resolveCodexProductFailureKind, resolveCodexTerminalFacts, type CodexTerminalNativeReadbackReceipt, type CodexHistoryObservation } from '../codex-terminal-facts'
import { CODEX_TERMINAL_READBACK_RUNTIME_STOPPED, recoverCodexTerminalAfterInterrupt } from '../codex-terminal-readback-recovery'
import { CodexToolActionJournal } from '../codex-tool-action-journal'
import type { CoreTurnCandidate } from '../codex-turn-collector'
import type { CodexCompositionBase } from './base'
import type { CloseoutSupport } from './closeout-support'
import type { EngineTerminal } from './engine-terminal'
import type { CodexCompositionLive } from './live-state'
import { isoNow, codexFailureDiagnostics, stableErrorCode, codexBrowserVerifierIdentityDigest, codexBrowserVerifierBlockingVerdict, codexBrowserVerifierOutcome, isAbortFailure } from './support'

export type CandidateCloseoutDeps = Pick<CodexCompositionBase, 'actionJournal' | 'collector' | 'commitExpectedCodexCloseout' | 'credentialStore' | 'detailPrepared' | 'gatewayRepository' | 'loadedThreads' | 'materializeNativeFork' | 'materializedForkTargets' | 'nativeRuntime' | 'pendingNativeForkSeeds' | 'preparedDetails' | 'releaseBrowserTurnLease' | 'repository'>
  & Pick<EngineTerminal, 'buildNativeTerminalEvidence' | 'releaseUndispatchedForkReservation' | 'reserveNativeForkForDivergence'>
  & Pick<CloseoutSupport, 'closePersistedHostFailure' | 'observeTerminalHistory' | 'readAlreadyCommittedCloseout' | 'readProductTaskFacts' | 'releaseHostFailureReservationIfPresent'>
  & { readonly live: CodexCompositionLive }

/** Closing one owned terminal candidate into the canonical product closeout. */
export function createCandidateCloseout(deps: CandidateCloseoutDeps) {
  const { live, actionJournal, buildNativeTerminalEvidence, closePersistedHostFailure, collector, commitExpectedCodexCloseout, credentialStore, detailPrepared, gatewayRepository, loadedThreads, materializeNativeFork, materializedForkTargets, nativeRuntime, observeTerminalHistory, pendingNativeForkSeeds, preparedDetails, readAlreadyCommittedCloseout, readProductTaskFacts, releaseBrowserTurnLease, releaseHostFailureReservationIfPresent, releaseUndispatchedForkReservation, repository, reserveNativeForkForDivergence } = deps
  const runtimeActive = () => live.lifecycle !== 'stopping' && live.lifecycle !== 'stopped'

  const closeCandidateOwned = async (candidate: CoreTurnCandidate): Promise<ReadyClosedCodexProductRun> => {
    let publicationReceiptRefs: string[] = []
    let publicationDiverged = false
    let terminalReadbackReceipt: CodexTerminalNativeReadbackReceipt | null = null
    let historyObservation: CodexHistoryObservation | null = null
    let terminalReadbackThread: import('../codex-native-runtime').CodexThread | null = null
    let gatewayEvidence: ReturnType<CodexModelGatewayRepository['readTurnGatewayEvidence']> = []
    let lifecycleAction: ReturnType<CodexBindingRepository['readProductLifecycleAction']> = null
    let settledProductEffects: ReturnType<CodexToolActionJournal['readSettledProductEffects']> = []
    const product = repository.readProductTurnRuntime(candidate.readyRunId)
    if (candidate.readyTaskId !== product.readyTaskId
      || candidate.scopeId !== product.readyScopeId
      || (candidate.codexThreadId && candidate.codexThreadId !== product.codexThreadId)
      || (candidate.codexTurnId && candidate.codexTurnId !== product.codexTurnId)) {
      throw new Error('codex_candidate_durable_identity_mismatch')
    }
    const alreadyCommitted = readAlreadyCommittedCloseout(product, candidate)
    if (alreadyCommitted) {
      releaseBrowserTurnLease(product.readyRunId)
      return alreadyCommitted
    }
    releaseBrowserTurnLease(product.readyRunId)
    if (candidate.kind === 'native_terminal') {
      lifecycleAction = repository.readProductLifecycleAction(product.readyRunId)
      if (!lifecycleAction) {
        try {
          const readback = await nativeRuntime.threadRead({
            threadId: candidate.codexThreadId,
            includeTurns: true,
          })
          terminalReadbackThread = readback.thread
          terminalReadbackReceipt = buildTerminalNativeReadbackReceipt({
            candidate,
            prepared: product.prepared,
            aliasGeneration: product.aliasGeneration,
            messageVisibilityEpoch: product.messageVisibilityEpoch,
            connectionEpoch: product.turnStartConnectionEpoch,
            turnRevision: product.turnRevision,
            thread: readback.thread,
          })
          if (candidate.engineOutcome === 'completed') {
            const automaticCompactionEvidence = verifyCodexAutomaticCompactionEvidence({
              gatewayRepository,
              readyRunId: product.readyRunId,
              codexThreadId: candidate.codexThreadId,
              codexTurnId: candidate.codexTurnId,
              upstreamProfileSnapshotDigest: product.upstreamProfileSnapshotDigest,
              productRequestToolsDigest: product.requestToolsDigest,
              thread: readback.thread,
            })
            candidate.contextState = {
              ...candidate.contextState,
              automaticCompactionExchanges: automaticCompactionEvidence,
            }
          }
        } catch (error) {
          lifecycleAction = repository.readProductLifecycleAction(product.readyRunId)
          if (!lifecycleAction && candidate.engineOutcome === 'completed') throw error
        }
      }
      repository.recordEngineTerminalCandidate({
        readyRunId: candidate.readyRunId,
        codexThreadId: candidate.codexThreadId,
        codexTurnId: candidate.codexTurnId,
        engineOutcome: candidate.engineOutcome,
        candidate,
        recordedAt: isoNow(),
      })
      settledProductEffects = actionJournal.settleProductEffectsForCloseout({
        readyRunId: candidate.readyRunId,
        closeoutAt: isoNow(),
      })
      if (terminalReadbackThread) {
        const refreshedProduct = repository.readProductTurnRuntime(candidate.readyRunId)
        terminalReadbackReceipt = buildTerminalNativeReadbackReceipt({
          candidate,
          prepared: refreshedProduct.prepared,
          aliasGeneration: refreshedProduct.aliasGeneration,
          messageVisibilityEpoch: refreshedProduct.messageVisibilityEpoch,
          connectionEpoch: refreshedProduct.turnStartConnectionEpoch,
          turnRevision: refreshedProduct.turnRevision,
          thread: terminalReadbackThread,
        })
      }
      lifecycleAction = repository.readProductLifecycleAction(product.readyRunId)
      const publication = repository.readToolPublicationBarrier({
        readyRunId: candidate.readyRunId,
        codexThreadId: candidate.codexThreadId,
        codexTurnId: candidate.codexTurnId,
        candidateCalls: candidate.usedToolCalls,
        effectSettlementOnly: lifecycleAction !== null,
      })
      if (publication.kind === 'accepted') {
        if (!lifecycleAction) {
          publicationReceiptRefs = repository.recordToolPublicationReceipt({
            readyRunId: candidate.readyRunId,
            recordedAt: isoNow(),
          }).verifiedReceiptRefs
        }
      } else if (publication.kind === 'diverged') {
        publicationDiverged = true
      } else {
        throw new Error(`codex_tool_publication_${publication.kind}:${publication.code}`)
      }
      gatewayEvidence = gatewayRepository.readTurnGatewayEvidence({
        readyRunId: product.readyRunId,
        codexThreadId: candidate.codexThreadId,
        codexTurnId: candidate.codexTurnId,
      })
      historyObservation = terminalReadbackThread && terminalReadbackReceipt
        ? observeTerminalHistory({
            candidate,
            prepared: product.prepared,
            expectedClientUserMessageId: product.turnRequestId,
            thread: terminalReadbackThread,
            publicationDiverged,
            gatewayEvidence,
          }, terminalReadbackReceipt)
        : {
            kind: 'unknown_reset_required',
            reason: 'native_readback_identity_unknown',
          }
    } else {
      lifecycleAction = repository.readProductLifecycleAction(product.readyRunId)
    }
    const boundHost = live.host
    if (!boundHost) throw new Error('codex_runtime_host_unbound')
    const scope = boundHost.getScope(product.readyScopeId)
    if (!scope) throw new Error('codex_scope_missing_during_closeout')
    const durationMs = Math.max(1, Date.now() - Date.parse(product.admittedAt))
    const taskFacts = readProductTaskFacts(boundHost, product)
    if (lifecycleAction) {
      if (candidate.kind !== 'native_terminal') {
        throw new Error('codex_lifecycle_action_engine_terminal_missing')
      }
      if (repository.readProductCloseout(product.readyRunId)) {
        throw new Error('codex_product_closeout_already_committed')
      }
      const action = lifecycleAction.lifecycleAction
      const lifecycleTerminalEvidence = await buildNativeTerminalEvidence({
        product,
        candidate,
        status: 'interrupted',
        terminalReason: 'cancelled_user',
        lifecycleAction: action,
        forcePublicationDiverged: action === 'stop' && candidate.engineOutcome === 'completed',
      })
      const forkReservationSetId = lifecycleTerminalEvidence.history.kind === 'diverged'
        ? reserveNativeForkForDivergence(product, lifecycleTerminalEvidence.evidence.nativeReadback)
        : null
      let committed: Awaited<ReturnType<typeof boundHost.commitCodexProductTurnCloseout>>
      try {
        committed = await commitExpectedCodexCloseout(
          product.readyRunId,
          `lifecycle_${action}`,
          () => boundHost.commitCodexProductTurnCloseout({
            parentTaskId: product.readyTaskId,
            ownerRunId: product.readyRunId,
            conversationId: scope.id,
            status: 'interrupted',
            terminalReason: 'cancelled_user',
            initiator: `user_${action}`,
            durationMs,
            ...taskFacts,
            finalText: codexTerminalPublicMessage('interrupted'),
            contextUsage: candidate.contextUsage,
            providerDiagnostics: codexFailureDiagnostics({ error: 'cancelled_user', module: taskFacts.module }),
            now: isoNow(),
          }),
          lifecycleTerminalEvidence.evidence,
        )
      } catch (error) {
        releaseUndispatchedForkReservation(
          product.readyRunId,
          forkReservationSetId,
          'lifecycle_closeout_rolled_back',
        )
        throw error
      }
      const forkTargetThreadBindingId = materializedForkTargets.get(product.readyRunId) || null
      pendingNativeForkSeeds.delete(product.readyRunId)
      materializedForkTargets.delete(product.readyRunId)
      if (forkTargetThreadBindingId && repository.readNativeForkMaterialization(forkTargetThreadBindingId)) {
        await materializeNativeFork(forkTargetThreadBindingId).catch((error: unknown) => {
          logAgentMetric('codex_native_fork_materialization_pending', {
            readyRunId: product.readyRunId,
            reason: stableErrorCode(error, 'fork_materialization_unknown'),
          })
        })
      } else if (forkReservationSetId && live.registry?.snapshot().members.some(
        (member) => member.reservationSetId === forkReservationSetId && member.state === 'held',
      )) {
        throw new Error('codex_native_fork_target_missing')
      }
      const closeout = repository.readLifecycleActionCloseout(product.readyRunId)
      if (closeout.closeoutDigest !== committed.productTerminalDigest) {
        throw new Error('codex_lifecycle_action_closeout_readback_mismatch')
      }
      if (product.codexThreadId && lifecycleTerminalEvidence.history.kind !== 'continuation_safe') {
        loadedThreads.delete(product.codexThreadId)
      }
      const reservationSnapshot = live.registry?.snapshot()
      if (reservationSnapshot?.members.some(
        (member) => member.reservationSetId === product.reservationSetId,
      )) {
        live.registry?.releaseAfterHostFailure({
          reservationSetId: product.reservationSetId,
          productTerminalDigest: committed.productTerminalDigest,
        })
      }
      const execution: ExecutionHostResult = {
        success: false,
        finalText: committed.canonicalMessage.content,
        cancelled: true,
        usedTools: candidate.usedToolCalls.map((call) => call.tool),
        error: 'cancelled_user',
        taskId: product.readyTaskId,
        taskProjectionId: product.readyTaskId,
        taskType: taskFacts.taskType,
        interactionState: 'suspended',
        terminalReason: 'cancelled_user',
        canonicalMessage: committed.canonicalMessage,
        canonicalMessageDigest: committed.canonicalMessageDigest,
        contextUsage: candidate.contextUsage,
        productTurnReceipt: repository.readProductTurnPresentation(product.readyRunId),
      }
      preparedDetails.delete(product.readyRunId)
      detailPrepared.delete(product.readyRunId)
      return {
        execution,
        productOutcomeDigest: closeout.closeoutDigest,
        candidateBodyDigest: null,
        committedTerminalEvent: terminalEvent({
          scope,
          product,
          execution,
          terminalAt: committed.closeoutAt,
        }),
      }
    }
    if (
      candidate.kind === 'native_terminal'
      && !publicationDiverged
      && historyObservation?.kind === 'continuation_safe'
      && terminalReadbackThread !== null
      && candidate.engineOutcome === 'completed'
      && candidate.candidateSelection.kind === 'accepted'
      && candidate.candidateText !== null
      && candidate.candidateDigest !== null
    ) {
      const acceptedCandidateText = candidate.candidateText
      const completedThreadReadback = terminalReadbackThread
      const workflowInspection = boundHost.runtime
        .getAgentSessionCheckpointRepository()
        .readWorkflowVerifierBundle(product.readyTaskId)
      const workflowBundle = resolveCodexBrowserWorkflowVerifierBundle(workflowInspection)
      const closeoutTaskFacts = resolveCodexBrowserWorkflowTaskFacts(
        taskFacts,
        Boolean(workflowBundle),
      )
      const projection = workflowBundle
        ? boundHost.getTaskProjectionStore().get(product.readyTaskId)
        : null
      if (workflowBundle && !projection) throw new Error('codex_browser_workflow_projection_missing')
      let verifierAttempt: CodexBrowserVerifierAttemptRead | null = null
      let verifierAbortSignal: AbortSignal | null = null
      if (workflowBundle && projection) {
        if (!product.codexThreadId || !product.codexTurnId) {
          throw new Error('codex_browser_verifier_native_identity_missing')
        }
        const frozenIdentityDigest = codexBrowserVerifierIdentityDigest({
          product,
          workflowBundle,
          projection,
        })
        const workflowCloseoutSealDigest = workflowDigest(workflowBundle.seal)
        const begun = repository.beginBrowserVerifierAttempt({
          readyRunId: product.readyRunId,
          readyTaskId: product.readyTaskId,
          readyScopeId: product.readyScopeId,
          readyAliasId: product.readyAliasId,
          aliasGeneration: product.aliasGeneration,
          threadBindingId: product.threadBindingId,
          codexThreadId: product.codexThreadId,
          codexTurnId: product.codexTurnId,
          candidateDigest: candidate.candidateDigest,
          frozenIdentityDigest,
          upstreamProfileSnapshotRef: product.upstreamProfileSnapshotRef,
          upstreamProfileSnapshotDigest: product.upstreamProfileSnapshotDigest,
          workflowCloseoutSealDigest,
          dispatchedAt: isoNow(),
        })
        verifierAttempt = begun.attempt
        if (!begun.created && begun.attempt.status === 'dispatching') {
          const settledAt = isoNow()
          verifierAttempt = repository.settleBrowserVerifierAttempt({
            readyRunId: product.readyRunId,
            attemptId: begun.attempt.attemptId,
            outcome: 'result_unknown',
            verdict: codexBrowserVerifierBlockingVerdict(
              '上一次独立复核的远端结果未能确认，本次未重复请求。',
              '独立复核结果不可确认，已安全阻止交付。',
            ),
            sealedCandidateDigest: null,
            verificationUsage: null,
            verifiedAt: settledAt,
            settledAt,
          })
        } else if (begun.created) {
          try {
            const snapshot = gatewayRepository.readSnapshot(
              product.upstreamProfileSnapshotRef,
              product.upstreamProfileSnapshotDigest,
            )
            const credential = credentialStore.resolve({
              credentialReferenceId: snapshot.credentialReferenceId,
              snapshot,
            })
            verifierAbortSignal = boundHost.getActiveRunAbortSignal({
              readyRunId: product.readyRunId,
              readyScopeId: product.readyScopeId,
              readyAliasId: product.readyAliasId,
            })
            if (!verifierAbortSignal) throw new Error('codex_browser_verifier_abort_signal_missing')
            if (verifierAbortSignal.aborted) {
              throw verifierAbortSignal.reason ?? new DOMException('aborted', 'AbortError')
            }
            const verification = await verifyCodexBrowserWorkflowCandidate({
              readyRunId: product.readyRunId,
              readyTaskId: product.readyTaskId,
              transportModel: product.codexModel,
              runStartedAtMs: Date.parse(product.admittedAt),
              candidateText: acceptedCandidateText,
              workflowBundle,
              projection,
              requestEnvelope: product.ingress,
              snapshot,
              snapshotDigest: product.upstreamProfileSnapshotDigest,
              credential,
              signal: verifierAbortSignal,
            })
            if (verifierAbortSignal.aborted) {
              throw verifierAbortSignal.reason ?? new DOMException('aborted', 'AbortError')
            }
            const currentVerifierSignal = boundHost.getActiveRunAbortSignal({
              readyRunId: product.readyRunId,
              readyScopeId: product.readyScopeId,
              readyAliasId: product.readyAliasId,
            })
            let identityStable = false
            try {
              const currentProduct = repository.readProductTurnRuntime(product.readyRunId)
              const currentWorkflowBundle = resolveCodexBrowserWorkflowVerifierBundle(
                boundHost.runtime.getAgentSessionCheckpointRepository()
                  .readWorkflowVerifierBundle(product.readyTaskId),
              )
              const currentProjection = boundHost.getTaskProjectionStore().get(product.readyTaskId)
              identityStable = Boolean(
                currentVerifierSignal === verifierAbortSignal
                && currentWorkflowBundle
                && currentProjection
                && codexBrowserVerifierIdentityDigest({
                  product: currentProduct,
                  workflowBundle: currentWorkflowBundle,
                  projection: currentProjection,
                }) === frozenIdentityDigest
              )
            } catch {
              // silent-catch: an identity readback failure is treated as drift and settles the verifier attempt as identity_drift
              identityStable = false
            }
            const settledAt = isoNow()
            verifierAttempt = repository.settleBrowserVerifierAttempt({
              readyRunId: product.readyRunId,
              attemptId: begun.attempt.attemptId,
              outcome: identityStable
                ? codexBrowserVerifierOutcome(verification)
                : 'identity_drift',
              verdict: identityStable
                ? verification.verdict
                : codexBrowserVerifierBlockingVerdict(
                    '独立复核期间任务身份或浏览器证据已变化。',
                    '复核输入已变化，已安全阻止交付。',
                  ),
              sealedCandidateDigest: workflowDigest(verification.sealed),
              verificationUsage: verification.verificationUsage,
              verifiedAt: settledAt,
              settledAt,
            })
          } catch (error) {
            if (isAbortFailure(error, verifierAbortSignal)) throw error
            logAgentMetric('codex_browser_verifier_failed', { readyRunId: product.readyRunId, reason: codexBrowserVerifierFailureCode(error) })
            const settledAt = isoNow()
            verifierAttempt = repository.settleBrowserVerifierAttempt({
              readyRunId: product.readyRunId,
              attemptId: begun.attempt.attemptId,
              outcome: 'provider_unavailable',
              verdict: codexBrowserVerifierBlockingVerdict(
                '独立复核服务暂时不可用。',
                '独立复核未完成，已安全阻止交付。',
              ),
              sealedCandidateDigest: null,
              verificationUsage: null,
              verifiedAt: settledAt,
              settledAt,
            })
          }
        }
        if (
          verifierAttempt.status !== 'settled'
          || !verifierAttempt.outcome
          || !verifierAttempt.verdict
          || !verifierAttempt.receiptDigest
        ) throw new Error('codex_browser_verifier_settlement_missing')
        if (verifierAttempt.outcome !== 'accept') {
          const verifierReceiptDigest = verifierAttempt.receiptDigest
          const unavailable = verifierAttempt.outcome === 'provider_unavailable'
          const resultUnknown = verifierAttempt.outcome === 'result_unknown'
          const identityDrift = verifierAttempt.outcome === 'identity_drift'
          const invalid = verifierAttempt.outcome === 'invalid'
          const errorCode = resultUnknown
            ? 'codex_browser_verifier_result_unknown'
            : unavailable
              ? 'codex_browser_verifier_unavailable'
              : identityDrift
                ? 'codex_browser_verifier_identity_drift'
                : invalid
                  ? 'codex_browser_verifier_invalid_output'
                  : 'codex_browser_verifier_rejected'
          const publicMessage = resultUnknown
            ? '上一次独立复核的结果无法确认，本轮没有交付候选结果。'
            : unavailable
              ? '独立复核服务暂时不可用，本轮没有交付候选结果。'
              : identityDrift
                ? '独立复核期间任务依据已变化，本轮没有交付候选结果。'
                : invalid
                  ? '独立复核未能得出可信结论，本轮没有交付候选结果。'
                  : '独立复核未通过，本轮没有交付候选结果。'
          const verifierTerminalReason = identityDrift
            ? 'persistence_failed' as const
            : unavailable || resultUnknown || invalid
              ? 'blocked_external' as const
              : 'proof_gap' as const
          if (repository.readProductCloseout(product.readyRunId)) {
            throw new Error('codex_product_closeout_already_committed')
          }
          const verifierTerminalEvidence = await buildNativeTerminalEvidence({
            product,
            candidate,
            thread: completedThreadReadback,
            status: 'error',
            terminalReason: verifierTerminalReason,
            verifierReceipt: {
              attemptId: verifierAttempt.attemptId,
              digest: verifierReceiptDigest,
            },
            forcePublicationDiverged: true,
          })
          const forkReservationSetId = verifierTerminalEvidence.history.kind === 'diverged'
            ? reserveNativeForkForDivergence(product, verifierTerminalEvidence.evidence.nativeReadback)
            : null
          let committedFailure: Awaited<ReturnType<typeof boundHost.commitCodexProductTurnCloseout>>
          try {
            committedFailure = await commitExpectedCodexCloseout(
              product.readyRunId,
              'verifier_rejected',
              () => boundHost.commitCodexProductTurnCloseout({
                parentTaskId: product.readyTaskId,
                ownerRunId: product.readyRunId,
                conversationId: scope.id,
                status: 'error',
                terminalReason: verifierTerminalReason,
                initiator: 'codex_browser_verifier',
                durationMs,
                ...closeoutTaskFacts,
                finalText: publicMessage,
                contextUsage: candidate.contextUsage,
                providerDiagnostics: codexFailureDiagnostics({
                  error: errorCode,
                  module: closeoutTaskFacts.module,
                  verifierReceiptDigest,
                }),
                now: isoNow(),
              }),
              verifierTerminalEvidence.evidence,
            )
          } catch (error) {
            releaseUndispatchedForkReservation(
              product.readyRunId,
              forkReservationSetId,
              'verifier_closeout_rolled_back',
            )
            throw error
          }
          const forkTargetThreadBindingId = materializedForkTargets.get(product.readyRunId) || null
          pendingNativeForkSeeds.delete(product.readyRunId)
          materializedForkTargets.delete(product.readyRunId)
          if (forkTargetThreadBindingId && repository.readNativeForkMaterialization(forkTargetThreadBindingId)) {
            await materializeNativeFork(forkTargetThreadBindingId).catch((error: unknown) => {
              logAgentMetric('codex_native_fork_materialization_pending', {
                readyRunId: product.readyRunId,
                reason: stableErrorCode(error, 'fork_materialization_unknown'),
              })
            })
          } else if (forkReservationSetId && live.registry?.snapshot().members.some(
            (member) => member.reservationSetId === forkReservationSetId && member.state === 'held',
          )) {
            throw new Error('codex_native_fork_target_missing')
          }
          const reservationSnapshot = live.registry?.snapshot()
          if (reservationSnapshot?.members.some(
            (member) => member.reservationSetId === product.reservationSetId,
          )) {
            live.registry?.releaseAfterHostFailure({
              reservationSetId: product.reservationSetId,
              productTerminalDigest: committedFailure.productTerminalDigest,
            })
          }
          const productCloseout = repository.readProductCloseout(product.readyRunId)
          if (
            !productCloseout
            || productCloseout.productTerminalDigest !== committedFailure.productTerminalDigest
          ) throw new Error('codex_verifier_rejected_closeout_readback_missing')
          if (workflowBundle) boundHost.browserController?.notifyTaskAttention(workflowBundle.browserTaskId)
          const execution: ExecutionHostResult = {
            success: false,
            finalText: publicMessage,
            cancelled: false,
            usedTools: candidate.usedToolCalls.map((call) => call.tool),
            error: errorCode,
            taskId: product.readyTaskId,
            taskProjectionId: product.readyTaskId,
            taskType: closeoutTaskFacts.taskType,
            interactionState: 'suspended',
            terminalReason: verifierTerminalReason,
            canonicalMessage: committedFailure.canonicalMessage,
            canonicalMessageDigest: committedFailure.canonicalMessageDigest,
            contextUsage: candidate.contextUsage,
            productTurnReceipt: repository.readProductTurnPresentation(product.readyRunId),
          }
          preparedDetails.delete(product.readyRunId)
          detailPrepared.delete(product.readyRunId)
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
      }
      const terminalQualityPatch = workflowBundle && projection
        ? readExistingTerminalQualityPatch(projection)
        : null
      const currentAcceptSignal = workflowBundle
        ? boundHost.getActiveRunAbortSignal({
            readyRunId: product.readyRunId,
            readyScopeId: product.readyScopeId,
            readyAliasId: product.readyAliasId,
          })
        : null
      if (currentAcceptSignal?.aborted || verifierAbortSignal?.aborted) {
        throw currentAcceptSignal?.reason
          ?? verifierAbortSignal?.reason
          ?? new DOMException('aborted', 'AbortError')
      }
      const completionVerifierReceipt = workflowBundle && terminalQualityPatch && verifierAttempt
        ? {
            version: 1 as const,
            verdict: 'accept' as const,
            parentTaskId: product.readyTaskId,
            ownerRunId: product.readyRunId,
            candidateDigest: workflowDigest(candidate.candidateText),
            workflowCloseoutSealDigest: workflowDigest(workflowBundle.seal),
            sealedCandidateDigest: verifierAttempt.sealedCandidateDigest as string,
            terminalQualityPatchDigest: workflowDigest(terminalQualityPatch),
            durableVerifierReceiptDigest: verifierAttempt.receiptDigest as string,
            verifiedAt: verifierAttempt.verifiedAt as string,
          }
        : null
      if (repository.readProductCloseout(product.readyRunId)) {
        throw new Error('codex_product_closeout_already_committed')
      }
      const publishedToolEvidence = repository.readPublishedToolOutputs(product.readyRunId)
        .map((tool) => ({
          itemId: tool.itemId,
          tool: tool.toolName,
          proofs: collectToolOutputProofs(
            tool.toolName,
            normalizeToolExecutionOutput(tool.output),
            new Date(tool.completedAt),
            { runId: product.readyRunId },
          ),
        }))
      const requestedCloseout = {
        parentTaskId: product.readyTaskId,
        ownerRunId: product.readyRunId,
        status: 'done' as const,
        terminalReason: 'done',
        initiator: 'done',
        durationMs,
        finalText: acceptedCandidateText,
        contextUsage: candidate.contextUsage,
        conversationId: scope.id,
        ...closeoutTaskFacts,
        providerDiagnostics: {
          provider: 'ready_gateway',
          agentProtocol: 'openai',
          wireApi: 'responses',
          actionReceiptRefs: publicationReceiptRefs,
        },
        workflowCloseoutSeal: workflowBundle?.seal ?? null,
        terminalQualityPatch,
        completionVerifierReceipt,
      }
      const commitAdjudicatedCloseout = async (
        closeout: Parameters<typeof boundHost.commitCodexProductTurnCloseout>[0],
      ) => {
        const terminalEvidence = await buildNativeTerminalEvidence({
          product,
          candidate,
          status: closeout.status,
          terminalReason: closeout.terminalReason,
          forcePublicationDiverged: closeout.status !== 'done',
          thread: completedThreadReadback,
          verifierReceipt: verifierAttempt?.receiptDigest
            ? { attemptId: verifierAttempt.attemptId, digest: verifierAttempt.receiptDigest }
            : undefined,
        })
        const forkReservationSetId = terminalEvidence.history.kind === 'diverged'
          ? reserveNativeForkForDivergence(product, terminalEvidence.evidence.nativeReadback)
          : null
        const mode: CodexProductCloseoutMode = terminalEvidence.history.kind === 'unknown_reset_required'
          ? 'history_reset_required'
          : closeout.status === 'done'
            ? workflowBundle ? 'verifier_accepted' : 'product'
            : terminalEvidence.history.kind === 'diverged'
              ? 'publication_diverged'
              : 'history_reset_required'
        let committed: Awaited<ReturnType<typeof boundHost.commitCodexProductTurnCloseout>>
        try {
          committed = await commitExpectedCodexCloseout(
            product.readyRunId,
            mode,
            () => boundHost.commitCodexProductTurnCloseout(closeout),
            terminalEvidence.evidence,
          )
        } catch (error) {
          releaseUndispatchedForkReservation(
            product.readyRunId, forkReservationSetId, 'adjudicated_closeout_rolled_back',
          )
          throw error
        }
        const forkTargetThreadBindingId = materializedForkTargets.get(product.readyRunId) || null
        pendingNativeForkSeeds.delete(product.readyRunId)
        materializedForkTargets.delete(product.readyRunId)
        if (forkTargetThreadBindingId && repository.readNativeForkMaterialization(forkTargetThreadBindingId)) {
          await materializeNativeFork(forkTargetThreadBindingId).catch((error: unknown) => {
            logAgentMetric('codex_native_fork_materialization_pending', {
              readyRunId: product.readyRunId,
              reason: stableErrorCode(error, 'fork_materialization_unknown'),
            })
          })
        } else if (forkReservationSetId && live.registry?.snapshot().members.some(
          (member) => member.reservationSetId === forkReservationSetId && member.state === 'held',
        )) {
          throw new Error('codex_native_fork_target_missing')
        }
        if (closeout.status !== 'done') {
          loadedThreads.delete(candidate.codexThreadId)
          if (live.registry?.snapshot().members.some(
            (member) => member.reservationSetId === product.reservationSetId,
          )) {
            live.registry.releaseAfterHostFailure({
              reservationSetId: product.reservationSetId,
              productTerminalDigest: committed.productTerminalDigest,
            })
          }
        }
        return { ...committed, status: closeout.status, terminalReason: closeout.terminalReason }
      }
      const committed = workflowBundle
        ? await commitAdjudicatedCloseout(requestedCloseout)
        : await finalizeCodexProductCloseout({
            closeout: requestedCloseout,
            toolCalls: candidate.usedToolCalls,
            publishedToolEvidence,
            taskProjectionStore: boundHost.getTaskProjectionStore(),
            commitCanonicalCoreCloseout: commitAdjudicatedCloseout,
          })
      const productCloseout = repository.readProductCloseout(product.readyRunId)
      if (!productCloseout) throw new Error('codex_product_closeout_readback_missing')
      const successful = committed.status === 'done'
      const execution: ExecutionHostResult = {
        success: successful,
        finalText: committed.canonicalMessage.content,
        cancelled: false,
        usedTools: candidate.usedToolCalls.map((call) => call.tool),
        ...(successful ? {} : { error: committed.terminalReason }),
        taskId: product.readyTaskId,
        taskProjectionId: product.readyTaskId,
        taskType: closeoutTaskFacts.taskType,
        interactionState: successful ? 'running' : 'suspended',
        terminalReason: committed.terminalReason as ExecutionHostResult['terminalReason'],
        canonicalMessage: committed.canonicalMessage,
        canonicalMessageDigest: committed.canonicalMessageDigest,
        contextUsage: candidate.contextUsage,
        productTurnReceipt: repository.readProductTurnPresentation(product.readyRunId),
      }
      preparedDetails.delete(product.readyRunId)
      detailPrepared.delete(product.readyRunId)
      return {
        execution,
        productOutcomeDigest: productCloseout.productTerminalDigest,
        candidateBodyDigest: successful ? candidate.candidateDigest : null,
        committedTerminalEvent: terminalEvent({
          scope, product, execution, terminalAt: productCloseout.productCloseoutAt,
        }),
      }
    }

    if (candidate.kind === 'host_failure') {
      const start = repository.readProductStartState(product.readyRunId)
      if (start.codexTurnId && start.codexThreadId) {
        // After stop nothing can read the turn back; leave the run to the next boot instead of writing a new request.
        if (!runtimeActive()) throw new Error(CODEX_TERMINAL_READBACK_RUNTIME_STOPPED)
        const requestedAt = isoNow()
        repository.requestProductInterrupt({
          aliasId: product.readyAliasId,
          aliasGeneration: product.aliasGeneration,
          readyRunId: product.readyRunId,
          codexThreadId: start.codexThreadId,
          codexTurnId: start.codexTurnId,
          requestedAt,
        })
        boundHost.abortActiveProductRun({
          readyRunId: product.readyRunId,
          readyScopeId: product.readyScopeId,
          readyAliasId: product.readyAliasId,
        })
        const recovered = await recoverCodexTerminalAfterInterrupt({
          runtime: nativeRuntime,
          collector,
          product,
          timedOutCandidate: candidate,
          acknowledgeInterrupt() {
            repository.acknowledgeProductInterrupt({
              readyRunId: product.readyRunId,
              acknowledgedAt: isoNow(),
            })
          },
          markInterruptUnknown() {
            repository.markProductInterruptUnknown({
              readyRunId: product.readyRunId,
              unknownAt: isoNow(),
            })
          },
          isRuntimeActive: runtimeActive,
        })
        return live.closeCandidate(recovered)
      }
      if (!start.codexTurnId) {
        const deliveryWasNeverAttempted = start.codexThreadId
          ? start.turnStartDispatchIntentAt === null
          : start.threadStartDispatchIntentAt === null
        if (!deliveryWasNeverAttempted && !start.hostFailureKind) {
          throw new Error('codex_start_delivery_unknown')
        }
        if (!start.hostFailureKind) {
          repository.recordHostFailureEvidence({
            readyRunId: product.readyRunId,
            kind: start.codexThreadId
              ? 'turn_start_delivery_proven_absent'
              : 'thread_start_delivery_proven_absent',
            evidenceDigest: candidate.hostFailure.evidenceDigest,
            recordedAt: isoNow(),
          })
        }
        const failure = repository.readRecoverySnapshot(
          (epoch) => live.sidecarSession?.isConnectionLive(epoch) || false,
        ).hostFailureCloseouts.find((entry) => entry.readyRunId === product.readyRunId)
        if (!failure) throw new Error('codex_host_failure_readback_missing')
        const settlement = await closePersistedHostFailure(failure)
        releaseHostFailureReservationIfPresent(live.registry, settlement)
        return settlement.result
      }
    }
    const nativeFailure = candidate.kind === 'native_terminal'
      ? resolveCodexUnownedNativeTerminalCloseout({
          engineOutcome: candidate.engineOutcome,
          publicationDiverged,
        })
      : null
    const status = nativeFailure?.status || 'error'
    const terminalReason = nativeFailure?.terminalReason || 'persistence_failed'
    const errorCode = candidate.kind === 'host_failure'
      ? `codex_${candidate.hostFailure.stage}_failed`
      : nativeFailure!.errorCode
    let closeoutMode: CodexProductCloseoutMode = historyObservation?.kind === 'unknown_reset_required'
      ? 'history_reset_required'
      : historyObservation?.kind === 'diverged'
        ? 'publication_diverged'
        : nativeFailure?.closeoutMode || 'product'
    const forkReservationSetId = closeoutMode === 'publication_diverged'
      ? reserveNativeForkForDivergence(product, terminalReadbackReceipt!)
      : null
    const terminalEvidence = candidate.kind === 'native_terminal'
      && nativeFailure
      && historyObservation
      && terminalReadbackReceipt
      ? (() => {
          const engineReceipt = repository.readEngineTerminalCandidate(product.readyRunId)
          if (!engineReceipt) throw new Error('codex_engine_terminal_receipt_missing')
          const nativeTurnRef = terminalEvidenceRef({
            kind: 'native_turn',
            readyRunId: product.readyRunId,
            readyScopeId: product.readyScopeId,
            messageVisibilityEpoch: product.messageVisibilityEpoch,
            aliasGeneration: product.aliasGeneration,
            codexThreadId: candidate.codexThreadId,
            codexTurnId: candidate.codexTurnId,
            receiptId: `engine-terminal:${product.readyRunId}`,
            digest: engineReceipt.candidateDigest,
            ownerIdentity: {
              nativeTurnId: candidate.codexTurnId,
              terminalStatus: candidate.engineOutcome,
            },
          })
          const nativeReadbackRef = terminalNativeReadbackEvidenceRef({
            readyRunId: product.readyRunId,
            readyScopeId: product.readyScopeId,
            messageVisibilityEpoch: product.messageVisibilityEpoch,
            aliasGeneration: product.aliasGeneration,
            codexThreadId: candidate.codexThreadId,
            codexTurnId: candidate.codexTurnId,
            revision: terminalReadbackReceipt.turnRevision,
            receiptId: terminalReadbackReceipt.receiptId,
            digest: terminalReadbackReceipt.digest,
            ownerIdentity: {
              connectionEpoch: terminalReadbackReceipt.connectionEpoch,
              readRevision: terminalReadbackReceipt.turnRevision,
              verifiedThreadId: terminalReadbackReceipt.codexThreadId,
              verifiedTurnId: terminalReadbackReceipt.codexTurnId,
            },
          })
          const gatewayFailures = gatewayEvidence.filter((row) => row.failure !== null)
          const gatewayRefs = gatewayEvidence.map((row) => terminalGatewayEvidenceRef({
            readyRunId: product.readyRunId,
            readyScopeId: product.readyScopeId,
            messageVisibilityEpoch: product.messageVisibilityEpoch,
            aliasGeneration: product.aliasGeneration,
            codexThreadId: candidate.codexThreadId,
            codexTurnId: candidate.codexTurnId,
            revision: row.responseSequence ?? row.requestSequence,
            receiptId: row.receiptId,
            digest: row.responseEvidenceDigest ?? row.requestEvidenceDigest,
            ownerIdentity: {
              gatewayRequestReceiptId: row.receiptId,
              eventSequence: row.responseSequence ?? row.requestSequence,
            },
          }))
          const effectRefs = settledProductEffects.map((effect) => {
            return terminalIndeterminateEffectEvidenceRef({
            readyRunId: product.readyRunId,
            readyScopeId: product.readyScopeId,
            messageVisibilityEpoch: product.messageVisibilityEpoch,
            aliasGeneration: product.aliasGeneration,
            codexThreadId: candidate.codexThreadId,
            codexTurnId: candidate.codexTurnId,
              revision: effect.revision,
              digest: effect.evidenceDigest,
              effectEvidence: effect.state === 'confirmed'
                ? {
                    state: 'confirmed',
                    readyActionId: effect.readyActionId,
                    actionIdentityDigest: effect.actionIdentityDigest,
                    receiptId: effect.receiptId as string,
                  }
                : {
                    state: 'indeterminate',
                    readyActionId: effect.readyActionId,
                    actionIdentityDigest: effect.actionIdentityDigest,
                    sourceRevision: effect.revision,
                    resolutionEvidenceDigest: effect.evidenceDigest,
                  },
            })
          })
          const effectState = effectRefs.length === 0
            ? 'none' as const
            : settledProductEffects.some((effect) => effect.state === 'indeterminate')
              ? 'indeterminate' as const
              : 'confirmed' as const
          const latestGatewayFailure = gatewayFailures.at(-1)?.failure || null
          const failureKind = resolveCodexProductFailureKind({
            terminal: status,
            terminalReason,
            gatewayFailureClass: latestGatewayFailure?.failureClass,
          })
          const facts = resolveCodexTerminalFacts({
            product: {
              terminal: status,
              terminalReason,
              failureKind,
              evidence: [nativeTurnRef, nativeReadbackRef, ...gatewayRefs],
            },
            history: historyObservation,
            historyEvidence: [nativeTurnRef, nativeReadbackRef, ...gatewayRefs],
            effect: effectState === 'none'
              ? { state: 'none', evidence: [] }
              : { state: effectState, evidence: effectRefs },
          })
          return { nativeReadback: terminalReadbackReceipt, terminalFacts: facts }
        })()
      : undefined
    if (repository.readProductCloseout(product.readyRunId)) {
      throw new Error('codex_product_closeout_already_committed')
    }
    let committed: Awaited<ReturnType<typeof boundHost.commitCodexProductTurnCloseout>>
    try {
      committed = await commitExpectedCodexCloseout(product.readyRunId, closeoutMode, () => (
        boundHost.commitCodexProductTurnCloseout({
        parentTaskId: product.readyTaskId,
        ownerRunId: product.readyRunId,
        conversationId: scope.id,
        status,
        terminalReason,
        initiator: 'codex_native',
        durationMs,
        ...taskFacts,
        finalText: codexTerminalPublicMessage(status, candidate.kind === 'native_terminal'
          ? terminalReadbackThread?.turns.find((turn) => turn.id === candidate.codexTurnId)?.error
          : null, { historySeam: terminalEvidence?.terminalFacts.history.kind === 'continuation_safe'
            ? terminalEvidence.terminalFacts.history.seamId : null }),
        contextUsage: candidate.contextUsage,
        providerDiagnostics: codexFailureDiagnostics({ error: errorCode, module: taskFacts.module }),
        now: isoNow(),
        })
      ), terminalEvidence)
    } catch (error) {
      releaseUndispatchedForkReservation(
        product.readyRunId,
        forkReservationSetId,
        'canonical_closeout_rolled_back',
      )
      throw error
    }
    const forkTargetThreadBindingId = materializedForkTargets.get(product.readyRunId) || null
    pendingNativeForkSeeds.delete(product.readyRunId)
    materializedForkTargets.delete(product.readyRunId)
    if (forkTargetThreadBindingId) {
      const forkMaterialization = repository.readNativeForkMaterialization(forkTargetThreadBindingId)
      if (forkMaterialization) await materializeNativeFork(forkTargetThreadBindingId).catch((error: unknown) => {
        logAgentMetric('codex_native_fork_materialization_pending', {
          readyRunId: product.readyRunId,
          reason: stableErrorCode(error, 'fork_materialization_unknown'),
        })
      })
    }
    const reservationSnapshot = live.registry?.snapshot()
    if (reservationSnapshot?.members.some((member) => member.reservationSetId === product.reservationSetId)) {
      live.registry?.releaseAfterHostFailure({
        reservationSetId: product.reservationSetId,
        productTerminalDigest: committed.productTerminalDigest,
      })
    }
    const execution: ExecutionHostResult = {
      success: false,
      finalText: committed.canonicalMessage.content,
      cancelled: false,
      usedTools: candidate.usedToolCalls.map((call) => call.tool),
      error: errorCode,
      taskId: product.readyTaskId,
      taskProjectionId: product.readyTaskId,
      taskType: taskFacts.taskType,
      interactionState: 'suspended',
      terminalReason,
      canonicalMessage: committed.canonicalMessage,
      canonicalMessageDigest: committed.canonicalMessageDigest,
      contextUsage: candidate.contextUsage,
      productTurnReceipt: repository.readProductTurnPresentation(product.readyRunId),
    }
    preparedDetails.delete(product.readyRunId)
    detailPrepared.delete(product.readyRunId)
    const productCloseout = repository.readProductCloseout(product.readyRunId)
    if (!productCloseout || productCloseout.productTerminalDigest !== committed.productTerminalDigest) {
      throw new Error('codex_product_closeout_readback_missing')
    }
    return {
      execution,
      productOutcomeDigest: productCloseout.productTerminalDigest,
      candidateBodyDigest: candidate.candidateDigest,
      committedTerminalEvent: terminalEvent({
        scope, product, execution, terminalAt: productCloseout.productCloseoutAt,
      }),
    }
  }

  return {
    closeCandidateOwned,
  }
}

export type CandidateCloseout = ReturnType<typeof createCandidateCloseout>
