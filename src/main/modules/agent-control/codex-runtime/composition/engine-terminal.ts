import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { ExecutionHostResult } from '../../contracts/run-contracts'
import { logAgentMetric } from '../../metrics'
import type { CodexProductTurnRuntimeRead, CodexLifecycleAction } from '../codex-binding-repository'
import { digestCanonicalJson } from '../codex-model-gateway-contract'
import { buildCodexProductReadbackCandidate } from '../codex-product-boot-recovery'
import { buildCodexEngineTerminalFinalizationKey, runCodexEngineTerminalFinalization, requestCodexEngineTerminalLifecycleActionBeforeCloseout, type CodexProductCloseoutMode } from '../codex-product-closeout-support'
import { terminalEvent } from '../codex-product-lifecycle-store'
import { sha256 } from '../codex-product-surface-ingress'
import { codexTerminalPublicMessage } from '../codex-product-turn-presentation'
import type { ReadyClosedCodexProductRun } from '../codex-runtime-composition'
import { buildTerminalNativeReadbackReceipt, terminalEvidenceRef, terminalNativeReadbackEvidenceRef, terminalGatewayEvidenceRef, terminalIndeterminateEffectEvidenceRef, resolveCodexTerminalFacts, resolveCodexProductFailureKind, type CodexTerminalNativeReadbackReceipt, type CodexHistoryObservation } from '../codex-terminal-facts'
import type { CoreTurnCandidate } from '../codex-turn-collector'
import { ReadyCodexLifecyclePortError, type ProductTurnCloseoutEvidence } from '../ready-codex-lifecycle-adapter'
import type { CodexCompositionBase } from './base'
import type { CloseoutSupport } from './closeout-support'
import type { CodexCompositionLive } from './live-state'
import { stableErrorCode, isoNow, codexFailureDiagnostics } from './support'
import type { PendingEngineTerminalFinalization } from './types'

export type EngineTerminalDeps = Pick<CodexCompositionBase, 'actionJournal' | 'browserTurnLeases' | 'collector' | 'commitExpectedCodexCloseout' | 'detailPrepared' | 'gatewayRepository' | 'input' | 'materializeNativeFork' | 'materializedForkTargets' | 'nativeRuntime' | 'pendingEngineTerminalFinalizations' | 'pendingNativeForkSeeds' | 'preparedDetails' | 'releaseBrowserTurnLease' | 'repository'>
  & Pick<CloseoutSupport, 'closePersistedHostFailure' | 'observeTerminalHistory' | 'readProductTaskFacts' | 'releaseHostFailureReservationIfPresent'>
  & { readonly live: CodexCompositionLive }

/** Engine terminal settlement: native evidence, failure settlement, finalization and the lifecycle hooks. */
export function createEngineTerminal(deps: EngineTerminalDeps) {
  const { live, actionJournal, browserTurnLeases, closePersistedHostFailure, collector, commitExpectedCodexCloseout, detailPrepared, gatewayRepository, input, materializeNativeFork, materializedForkTargets, nativeRuntime, observeTerminalHistory, pendingEngineTerminalFinalizations, pendingNativeForkSeeds, preparedDetails, readProductTaskFacts, releaseBrowserTurnLease, releaseHostFailureReservationIfPresent, repository } = deps
  const finalizeEngineTerminalCloseout = (
    finalization: PendingEngineTerminalFinalization,
    onDeliveryFailure?: (error: unknown) => void,
  ): void => {
    const key = buildCodexEngineTerminalFinalizationKey({
      ...finalization.identity,
      readyRunId: finalization.product.readyRunId,
    })
    pendingEngineTerminalFinalizations.set(key, finalization)
    runCodexEngineTerminalFinalization({
      deliver: () => live.deliverRecoveredCloseout(
        finalization.product.readyRunId,
        finalization.recovered,
      ),
      cleanup: () => {
        try {
          releaseBrowserTurnLease(finalization.product.readyRunId)
        } catch (error) {
          browserTurnLeases.delete(finalization.product.readyRunId)
          logAgentMetric('codex_user_stop_memory_cleanup_failed', {
            readyRunId: finalization.product.readyRunId,
            stage: 'browser_turn_lease',
            errorCode: stableErrorCode(error, 'browser_turn_lease_release_failed'),
          })
        }
        try {
          if (live.registry?.snapshot().members.some(
            (member) => member.reservationSetId === finalization.product.reservationSetId,
          )) {
            live.registry.releaseAfterHostFailure({
              reservationSetId: finalization.product.reservationSetId,
              productTerminalDigest: finalization.productTerminalDigest,
            })
          }
        } catch (error) {
          logAgentMetric('codex_user_stop_memory_cleanup_failed', {
            readyRunId: finalization.product.readyRunId,
            stage: 'start_identity_registry',
            errorCode: stableErrorCode(error, 'start_identity_registry_release_failed'),
          })
        }
        preparedDetails.delete(finalization.product.readyRunId)
        detailPrepared.delete(finalization.product.readyRunId)
      },
      onDeliveryFailure,
    })
  }

  const readLifecycleCloseout = (
    identity: { aliasId: string; aliasGeneration: number; readyRunId?: string },
  ): ProductTurnCloseoutEvidence => {
    if (identity.readyRunId && repository.readProductLifecycleAction(identity.readyRunId)) {
      const lifecycle = repository.readLifecycleActionCloseout(identity.readyRunId)
      if (lifecycle.aliasId !== identity.aliasId
        || lifecycle.aliasGeneration !== identity.aliasGeneration) {
        throw new ReadyCodexLifecyclePortError('persistence_failed')
      }
      return {
        aliasId: lifecycle.aliasId,
        aliasGeneration: lifecycle.aliasGeneration,
        codexThreadId: lifecycle.codexThreadId,
        codexTurnId: lifecycle.codexTurnId,
        terminal: lifecycle.terminal,
        closeoutDigest: lifecycle.closeoutDigest,
        fenceReleaseRevision: lifecycle.fenceReleaseRevision,
        lifecycleAction: lifecycle.action,
        lifecycleActionEvidenceDigest: lifecycle.lifecycleActionEvidenceDigest,
        ...(lifecycle.retiredGeneration === null
          ? {} : { retiredGeneration: lifecycle.retiredGeneration }),
        ...(lifecycle.retirementTransactionDigest === null
          ? {} : { retirementTransactionDigest: lifecycle.retirementTransactionDigest }),
        ...(lifecycle.archiveIntentDigest === null
          ? {} : { archiveIntentDigest: lifecycle.archiveIntentDigest }),
        scopeClosureEvidenceDigest: lifecycle.scopeClosureEvidenceDigest,
        newGeneration: lifecycle.newGeneration,
        newThreadBindingId: lifecycle.newThreadBindingId,
      }
    }
    const read = repository.readLatestLifecycleCloseout(identity)
    return {
      aliasId: read.aliasId,
      aliasGeneration: read.aliasGeneration,
      codexThreadId: read.codexThreadId,
      codexTurnId: read.codexTurnId,
      terminal: read.terminal,
      closeoutDigest: read.closeoutDigest,
      fenceReleaseRevision: read.fenceReleaseRevision,
    }
  }

  const readEngineTerminalFinalization = (
    finalization: PendingEngineTerminalFinalization,
  ): ProductTurnCloseoutEvidence => {
    const productCloseout = repository.readProductCloseout(finalization.product.readyRunId)
    if (
      !productCloseout
      || productCloseout.productTerminalDigest !== finalization.productTerminalDigest
      || productCloseout.productCloseoutAt !== finalization.closeoutAt
    ) throw new ReadyCodexLifecyclePortError('persistence_failed')
    const action = repository.readProductLifecycleAction(finalization.product.readyRunId)
    const readback = action
      ? readLifecycleCloseout({
          ...finalization.identity,
          readyRunId: finalization.product.readyRunId,
        })
      : repository.readLatestLifecycleCloseout({
          aliasId: finalization.product.readyAliasId,
          aliasGeneration: finalization.product.aliasGeneration,
          readyRunId: finalization.product.readyRunId,
        })
    if (
      readback.terminal !== finalization.terminal
      || readback.codexThreadId !== finalization.product.codexThreadId
      || readback.codexTurnId !== finalization.product.codexTurnId
      || readback.closeoutDigest !== finalization.productTerminalDigest
    ) throw new ReadyCodexLifecyclePortError('persistence_failed')
    return readback
  }

  const reserveNativeForkForDivergence = (
    product: CodexProductTurnRuntimeRead,
    nativeReadback: CodexTerminalNativeReadbackReceipt,
  ): string | null => {
    const prefix = repository.readAcceptedNativePrefixResolution({
      readyRunId: product.readyRunId,
      nativeReadback,
    })
    if (prefix.kind !== 'accepted') return null
    if (!live.registry) throw new Error('codex_registry_unavailable')
    const requestedCwd = join(
      input.userDataPath,
      'codex-workspaces',
      `fork-${sha256(`${product.readyAliasId}\u0000${product.aliasGeneration + 1}`).slice(0, 24)}`,
    )
    mkdirSync(requestedCwd, { recursive: true, mode: 0o700 })
    const targetCwd = realpathSync(requestedCwd)
    const reservation = live.registry.reserveFork({ scopeId: product.readyScopeId })
    pendingNativeForkSeeds.set(product.readyRunId, {
      targetCwd,
      ...reservation,
    })
    return reservation.reservationSetId
  }

  const releaseUndispatchedForkReservation = (
    readyRunId: string,
    reservationSetId: string | null,
    reason: string,
  ): void => {
    if (reservationSetId && live.registry?.snapshot().members.some(
      (member) => member.reservationSetId === reservationSetId && member.state === 'held',
    )) {
      live.registry.releaseBeforeDispatch({
        reservationSetId,
        evidenceDigest: digestCanonicalJson({ readyRunId, reason }),
      })
    }
    pendingNativeForkSeeds.delete(readyRunId)
    materializedForkTargets.delete(readyRunId)
  }

  const buildNativeTerminalEvidence = async (input: {
    product: CodexProductTurnRuntimeRead
    candidate: Extract<CoreTurnCandidate, { kind: 'native_terminal' }>
    thread?: import('../codex-native-runtime').CodexThread
    status: 'done' | 'error' | 'cancelled' | 'interrupted'
    terminalReason: string
    lifecycleAction?: CodexLifecycleAction
    verifierReceipt?: { attemptId: string; digest: string }
    forcePublicationDiverged: boolean
    effectSettlementOnly?: boolean
  }): Promise<{
    evidence: import('../codex-binding-repository').CodexTerminalCloseoutEvidence
    history: CodexHistoryObservation | { kind: 'reset' | 'closed' }
  }> => {
    const thread = input.thread ?? (await nativeRuntime.threadRead({
      threadId: input.candidate.codexThreadId,
      includeTurns: true,
    })).thread
    const effects = actionJournal.settleProductEffectsForCloseout({
      readyRunId: input.product.readyRunId,
      closeoutAt: isoNow(),
    })
    const publication = repository.readToolPublicationBarrier({
      readyRunId: input.product.readyRunId,
      codexThreadId: input.candidate.codexThreadId,
      codexTurnId: input.candidate.codexTurnId,
      candidateCalls: input.candidate.usedToolCalls,
      effectSettlementOnly: Boolean(input.lifecycleAction) || input.effectSettlementOnly === true,
    })
    if (publication.kind !== 'accepted' && publication.kind !== 'diverged') {
      throw new Error(`codex_tool_publication_${publication.kind}:${publication.code}`)
    }
    const product = repository.readProductTurnRuntime(input.product.readyRunId)
    const nativeReadback = buildTerminalNativeReadbackReceipt({
      candidate: input.candidate,
      prepared: product.prepared,
      aliasGeneration: product.aliasGeneration,
      messageVisibilityEpoch: product.messageVisibilityEpoch,
      connectionEpoch: product.turnStartConnectionEpoch,
      turnRevision: product.turnRevision,
      thread,
    })
    const gatewayEvidence = gatewayRepository.readTurnGatewayEvidence({
      readyRunId: product.readyRunId,
      codexThreadId: input.candidate.codexThreadId,
      codexTurnId: input.candidate.codexTurnId,
    })
    let observation = observeTerminalHistory({
      candidate: input.candidate,
      prepared: product.prepared,
      expectedClientUserMessageId: product.turnRequestId,
      thread,
      publicationDiverged: input.forcePublicationDiverged || publication.kind === 'diverged',
      gatewayEvidence,
    }, nativeReadback)
    if (input.status === 'done' && observation.kind === 'continuation_safe'
      && repository.readNativeFormalInputCoverage({
        threadBindingId: product.threadBindingId, orderedNativeTurnIds: nativeReadback.orderedTurnIds,
      }).kind === 'unknown') {
      observation = { kind: 'unknown_reset_required', reason: 'formal_input_mapping_unknown' }
    }
    const lifecycle = input.lifecycleAction
      ? repository.readProductLifecycleAction(product.readyRunId)
      : null
    if (input.lifecycleAction && (!lifecycle || lifecycle.lifecycleAction !== input.lifecycleAction)) {
      throw new Error('codex_lifecycle_action_evidence_missing')
    }
    const engine = repository.readEngineTerminalCandidate(product.readyRunId)
    if (!engine) throw new Error('codex_engine_terminal_receipt_missing')
    const nativeTurnRef = terminalEvidenceRef({
      kind: 'native_turn',
      readyRunId: product.readyRunId,
      readyScopeId: product.readyScopeId,
      messageVisibilityEpoch: product.messageVisibilityEpoch,
      aliasGeneration: product.aliasGeneration,
      codexThreadId: input.candidate.codexThreadId,
      codexTurnId: input.candidate.codexTurnId,
      receiptId: `engine-terminal:${product.readyRunId}`,
      digest: engine.candidateDigest,
      ownerIdentity: {
        nativeTurnId: input.candidate.codexTurnId,
        terminalStatus: input.candidate.engineOutcome,
      },
    })
    const nativeReadbackRef = terminalNativeReadbackEvidenceRef({
      readyRunId: product.readyRunId,
      readyScopeId: product.readyScopeId,
      messageVisibilityEpoch: product.messageVisibilityEpoch,
      aliasGeneration: product.aliasGeneration,
      codexThreadId: input.candidate.codexThreadId,
      codexTurnId: input.candidate.codexTurnId,
      revision: nativeReadback.turnRevision,
      receiptId: nativeReadback.receiptId,
      digest: nativeReadback.digest,
      ownerIdentity: {
        connectionEpoch: nativeReadback.connectionEpoch,
        readRevision: nativeReadback.turnRevision,
        verifiedThreadId: nativeReadback.codexThreadId,
        verifiedTurnId: nativeReadback.codexTurnId,
      },
    })
    const lifecycleRef = lifecycle ? {
      kind: 'lifecycle' as const,
      evidenceRefId: `lifecycle:${product.readyRunId}:${lifecycle.lifecycleAction}`,
      readyRunId: product.readyRunId,
      readyScopeId: product.readyScopeId,
      messageVisibilityEpoch: product.messageVisibilityEpoch,
      aliasGeneration: product.aliasGeneration,
      codexThreadId: input.candidate.codexThreadId,
      codexTurnId: input.candidate.codexTurnId,
      revision: 1,
      receiptId: `lifecycle:${product.readyRunId}:${lifecycle.lifecycleAction}`,
      digest: lifecycle.lifecycleActionEvidenceDigest,
      ownerIdentity: { lifecycleActionId: `${product.readyRunId}:${lifecycle.lifecycleAction}` },
    } : null
    const verifierRef = input.verifierReceipt ? {
      kind: 'verifier' as const,
      evidenceRefId: `verifier:${input.verifierReceipt.attemptId}`,
      readyRunId: product.readyRunId,
      readyScopeId: product.readyScopeId,
      messageVisibilityEpoch: product.messageVisibilityEpoch,
      aliasGeneration: product.aliasGeneration,
      codexThreadId: input.candidate.codexThreadId,
      codexTurnId: input.candidate.codexTurnId,
      revision: 1,
      receiptId: input.verifierReceipt.attemptId,
      digest: input.verifierReceipt.digest,
      ownerIdentity: { verifierAttemptId: input.verifierReceipt.attemptId },
    } : null
    const gatewayFailures = gatewayEvidence.filter((row) => row.failure !== null)
    const gatewayRefs = gatewayEvidence.map((row) => (
      terminalGatewayEvidenceRef({
        readyRunId: product.readyRunId,
        readyScopeId: product.readyScopeId,
        messageVisibilityEpoch: product.messageVisibilityEpoch,
        aliasGeneration: product.aliasGeneration,
        codexThreadId: input.candidate.codexThreadId,
        codexTurnId: input.candidate.codexTurnId,
        revision: row.responseSequence ?? row.requestSequence,
        receiptId: row.receiptId,
        digest: row.responseEvidenceDigest ?? row.requestEvidenceDigest,
        ownerIdentity: {
          gatewayRequestReceiptId: row.receiptId,
          eventSequence: row.responseSequence ?? row.requestSequence,
        },
      })
    ))
    const effectRefs = effects.map((effect) => terminalIndeterminateEffectEvidenceRef({
      readyRunId: product.readyRunId,
      readyScopeId: product.readyScopeId,
      messageVisibilityEpoch: product.messageVisibilityEpoch,
      aliasGeneration: product.aliasGeneration,
      codexThreadId: input.candidate.codexThreadId,
      codexTurnId: input.candidate.codexTurnId,
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
    }))
    const history = input.lifecycleAction === 'reset'
      ? { kind: 'reset' as const }
      : input.lifecycleAction === 'close'
        ? { kind: 'closed' as const }
        : observation
    const facts = resolveCodexTerminalFacts({
      product: {
        terminal: input.status,
        terminalReason: input.terminalReason,
        failureKind: resolveCodexProductFailureKind({
          terminal: input.status,
          terminalReason: input.terminalReason,
          gatewayFailureClass: gatewayFailures.at(-1)?.failure?.failureClass,
        }),
        evidence: [
          nativeTurnRef,
          nativeReadbackRef,
          ...gatewayRefs,
          ...(lifecycleRef ? [lifecycleRef] : []),
          ...(verifierRef ? [verifierRef] : []),
        ],
      },
      history,
      historyEvidence: history.kind === 'reset' || history.kind === 'closed'
        ? [lifecycleRef as NonNullable<typeof lifecycleRef>]
        : [nativeTurnRef, nativeReadbackRef, ...gatewayRefs, ...(verifierRef ? [verifierRef] : [])],
      effect: effectRefs.length === 0
        ? { state: 'none', evidence: [] }
        : {
            state: effects.some((effect) => effect.state === 'indeterminate')
              ? 'indeterminate' : 'confirmed',
            evidence: effectRefs,
          },
    })
    return { evidence: { nativeReadback, terminalFacts: facts }, history }
  }

  const settleEngineTerminalFailure = async (input: {
    identity: { aliasId: string; aliasGeneration: number }
    readyRunId: string
    status: 'error' | 'interrupted'
    terminalReason: 'blocked_external' | 'cancelled_user'
    initiator: 'codex_recovery' | 'user_stop' | 'user_close' | 'user_reset'
    lifecycleAction?: CodexLifecycleAction
    forcePublicationDiverged?: boolean
    error: string
    /**
     * A completed turn that did not deliver what it owed: only its effects settle and it closes as failed, but its
     * answer stays on the thread (shown under the verified note) so the user can reply instead of restating.
     */
    undelivered?: string | null
  }): Promise<ProductTurnCloseoutEvidence> => {
    const product = repository.readProductTurnRuntime(input.readyRunId)
    const terminal = repository.readEngineTerminalCandidate(product.readyRunId)
    const candidate = terminal?.candidate as CoreTurnCandidate | undefined
    if (
      !terminal
      || candidate?.kind !== 'native_terminal'
      || product.readyAliasId !== input.identity.aliasId
      || product.aliasGeneration !== input.identity.aliasGeneration
      || product.codexThreadId !== terminal.codexThreadId
      || product.codexTurnId !== terminal.codexTurnId
    ) {
      throw new ReadyCodexLifecyclePortError('persistence_failed')
    }
    const boundHost = live.host
    const scope = boundHost?.getScope(product.readyScopeId)
    if (!boundHost || !scope) throw new ReadyCodexLifecyclePortError('persistence_failed')
    const taskFacts = readProductTaskFacts(boundHost, product)
    if (repository.readProductCloseout(product.readyRunId)) {
      return readLifecycleCloseout({ ...input.identity, readyRunId: input.readyRunId })
    }
    if (input.lifecycleAction) {
      requestCodexEngineTerminalLifecycleActionBeforeCloseout({
        repository,
        host: boundHost,
        product,
        action: input.lifecycleAction,
        requestedAt: isoNow(),
      })
    }
    const terminalEvidence = await buildNativeTerminalEvidence({
      product,
      candidate,
      status: input.status,
      terminalReason: input.terminalReason,
      ...(input.lifecycleAction ? { lifecycleAction: input.lifecycleAction } : {}),
      forcePublicationDiverged: input.forcePublicationDiverged === true
        || (input.lifecycleAction === 'stop' && candidate.engineOutcome === 'completed'),
      effectSettlementOnly: Boolean(input.undelivered),
    })
    const forkReservationSetId = terminalEvidence.history.kind === 'diverged'
      ? reserveNativeForkForDivergence(product, terminalEvidence.evidence.nativeReadback)
      : null
    const closeoutMode: CodexProductCloseoutMode = input.lifecycleAction
      ? `lifecycle_${input.lifecycleAction}` as CodexProductCloseoutMode
      : terminalEvidence.history.kind === 'continuation_safe'
        ? 'product'
        : terminalEvidence.history.kind === 'diverged'
          ? 'publication_diverged'
          : 'history_reset_required'
    let committed: Awaited<ReturnType<typeof boundHost.commitCodexProductTurnCloseout>>
    try {
      committed = await commitExpectedCodexCloseout(
        product.readyRunId,
        closeoutMode,
        () => boundHost.commitCodexProductTurnCloseout({
          parentTaskId: product.readyTaskId,
          ownerRunId: product.readyRunId,
          conversationId: product.readyScopeId,
          status: input.status,
          terminalReason: input.terminalReason,
          initiator: input.initiator,
          durationMs: Math.max(1, Date.now() - Date.parse(product.admittedAt)),
          ...taskFacts,
          finalText: codexTerminalPublicMessage(input.status, null, {
            undelivered: input.undelivered,
            answer: input.undelivered ? candidate.candidateText : null,
          }),
          contextUsage: candidate.contextUsage,
          providerDiagnostics: codexFailureDiagnostics({ error: input.error, module: taskFacts.module }),
          now: isoNow(),
        }),
        terminalEvidence.evidence,
      )
    } catch (error) {
      if (forkReservationSetId && live.registry?.snapshot().members.some(
        (member) => member.reservationSetId === forkReservationSetId && member.state === 'held',
      )) {
        live.registry.releaseBeforeDispatch({
          reservationSetId: forkReservationSetId,
          evidenceDigest: digestCanonicalJson({
            readyRunId: product.readyRunId,
            reason: 'canonical_closeout_rolled_back',
          }),
        })
      }
      pendingNativeForkSeeds.delete(product.readyRunId)
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
    }
    const execution: ExecutionHostResult = {
      success: false,
      finalText: committed.canonicalMessage.content,
      cancelled: input.status === 'interrupted',
      usedTools: candidate.usedToolCalls.map((call) => call.tool),
      error: input.error,
      taskId: product.readyTaskId,
      taskProjectionId: product.readyTaskId,
      taskType: taskFacts.taskType,
      interactionState: 'suspended',
      terminalReason: input.terminalReason,
      canonicalMessage: committed.canonicalMessage,
      canonicalMessageDigest: committed.canonicalMessageDigest,
      contextUsage: candidate.contextUsage,
      productTurnReceipt: repository.readProductTurnPresentation(product.readyRunId),
    }
    const recovered: ReadyClosedCodexProductRun = {
      execution,
      productOutcomeDigest: committed.productTerminalDigest,
      candidateBodyDigest: candidate.candidateDigest,
      committedTerminalEvent: terminalEvent({
        scope,
        product,
        execution,
        terminalAt: committed.closeoutAt,
      }),
    }
    const finalization: PendingEngineTerminalFinalization = {
      identity: input.identity,
      product,
      terminal: input.status === 'error' ? 'failed' : 'interrupted',
      productTerminalDigest: committed.productTerminalDigest,
      closeoutAt: committed.closeoutAt,
      recovered,
    }
    finalizeEngineTerminalCloseout(
      finalization,
      input.initiator === 'codex_recovery'
        ? (error) => {
            logAgentMetric('codex_product_recovery_terminal_notification_failed', {
              readyRunId: product.readyRunId,
              errorCode: stableErrorCode(error, 'terminal_notification_failed'),
            })
          }
        : undefined,
    )
    const readback = readEngineTerminalFinalization(finalization)
    pendingEngineTerminalFinalizations.delete(buildCodexEngineTerminalFinalizationKey({
      ...input.identity,
      readyRunId: input.readyRunId,
    }))
    return readback
  }

  live.settleLifecycleReadbackTerminalUserStop = async (input, requestedAction = 'stop') => {
    if (input.turn.status === 'inProgress' || input.turn.id.trim() === '') {
      throw new ReadyCodexLifecyclePortError('interrupt_state_unknown')
    }
    const identity = {
      aliasId: input.aliasId,
      aliasGeneration: input.aliasGeneration,
    }
    const lifecycleOperation = repository.readLifecycleOperation(identity)
    if (
      lifecycleOperation.activeReadyRunId !== input.readyRunId
      || lifecycleOperation.facts.codexThreadId !== input.codexThreadId
      || lifecycleOperation.facts.codexTurnId !== input.turn.id
      || !lifecycleOperation.facts.productRunNonterminal
      || !lifecycleOperation.facts.interruptStateUnknown
    ) {
      throw new ReadyCodexLifecyclePortError('interrupt_state_unknown')
    }
    const product = repository.readProductTurnRuntime(input.readyRunId)
    if (
      product.readyAliasId !== input.aliasId
      || product.aliasGeneration !== input.aliasGeneration
      || product.codexThreadId !== input.codexThreadId
      || product.codexTurnId !== input.turn.id
    ) {
      throw new ReadyCodexLifecyclePortError('interrupt_state_unknown')
    }
    const existing = repository.readEngineTerminalCandidate(input.readyRunId)
    if (existing) {
      if (
        existing.codexThreadId !== input.codexThreadId
        || existing.codexTurnId !== input.turn.id
        || existing.engineOutcome !== input.turn.status
      ) throw new ReadyCodexLifecyclePortError('interrupt_state_unknown')
    } else {
      const candidate = buildCodexProductReadbackCandidate({
        collector,
        product,
        turn: input.turn,
        recovery: 'interrupt_unknown_exact_readback',
      })
      if (candidate.kind !== 'native_terminal') {
        throw new ReadyCodexLifecyclePortError('interrupt_state_unknown')
      }
      repository.recordEngineTerminalCandidate({
        readyRunId: product.readyRunId,
        codexThreadId: input.codexThreadId,
        codexTurnId: input.turn.id,
        engineOutcome: input.turn.status,
        candidate,
        recordedAt: isoNow(),
      })
    }
    return settleEngineTerminalFailure({
      identity,
      readyRunId: input.readyRunId,
      status: 'interrupted',
      terminalReason: 'cancelled_user',
      initiator: `user_${requestedAction}`,
      lifecycleAction: requestedAction,
      error: 'cancelled_user',
    })
  }

  live.settleLifecycleEngineTerminalUserStop = async (identity, requestedAction = 'stop') => {
    const lifecycleOperation = repository.readLifecycleOperation(identity)
    if (!lifecycleOperation.activeReadyRunId) {
      try {
        return readLifecycleCloseout({ ...identity, readyRunId: identity.readyRunId })
      } catch {
        throw new ReadyCodexLifecyclePortError('persistence_failed')
      }
    }
    if (lifecycleOperation.activeReadyRunId !== identity.readyRunId) {
      throw new ReadyCodexLifecyclePortError('persistence_failed')
    }
    if (
      !lifecycleOperation.facts.engineTerminalRecorded
      || lifecycleOperation.facts.readyCloseoutCommitted
    ) {
      throw new ReadyCodexLifecyclePortError('persistence_failed')
    }
    try {
      return await settleEngineTerminalFailure({
        identity,
        readyRunId: identity.readyRunId,
        status: 'interrupted',
        terminalReason: 'cancelled_user',
        initiator: `user_${requestedAction}`,
        lifecycleAction: requestedAction,
        error: 'cancelled_user',
      })
    } catch (error) {
      try {
        const committed = readLifecycleCloseout({ ...identity, readyRunId: identity.readyRunId })
        if (committed.lifecycleAction === requestedAction) return committed
      } catch {
        // silent-catch: no matching durable winner; rethrow the original settlement failure below.
      }
      throw error
    }
  }

  live.retryLifecycleEngineTerminalUserStopFinalization = async (identity) => {
    const key = buildCodexEngineTerminalFinalizationKey(identity)
    const finalization = pendingEngineTerminalFinalizations.get(key)
    if (!finalization || finalization.product.readyRunId !== identity.readyRunId) return null
    finalizeEngineTerminalCloseout(finalization)
    const readback = readEngineTerminalFinalization(finalization)
    pendingEngineTerminalFinalizations.delete(key)
    return readback
  }

  live.settleLifecycleHostFailureCloseout = async (identity) => {
    const lifecycleOperation = repository.readLifecycleOperation(identity)
    if (!lifecycleOperation.activeReadyRunId
      || !lifecycleOperation.facts.hostFailureEvidenceComplete) {
      throw new ReadyCodexLifecyclePortError('persistence_failed')
    }
    const failure = repository.readRecoverySnapshot(
      (epoch) => live.sidecarSession?.isConnectionLive(epoch) || false,
    ).hostFailureCloseouts.find(
      (entry) => entry.readyRunId === lifecycleOperation.activeReadyRunId,
    )
    if (!failure) throw new ReadyCodexLifecyclePortError('persistence_failed')
    const settlement = await closePersistedHostFailure(failure)
    releaseHostFailureReservationIfPresent(live.registry, settlement)
    live.deliverRecoveredCloseout(settlement.readyRunId, settlement.result)
  }

  return {
    finalizeEngineTerminalCloseout,
    readLifecycleCloseout,
    readEngineTerminalFinalization,
    reserveNativeForkForDivergence,
    releaseUndispatchedForkReservation,
    buildNativeTerminalEvidence,
    settleEngineTerminalFailure,
  }
}

export type EngineTerminal = ReturnType<typeof createEngineTerminal>
