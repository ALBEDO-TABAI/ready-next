import type { DatabaseConnection } from '../../database/connection'
import { CodexBindingRepositoryError } from './codex-binding-error'
import { createCodexBindingContext, type CodexBindingContext } from './binding-repository/context'
import type { CodexBindingRepositoryContract, CodexLifecycleAction, CodexProductInterruptOwnerRead, CodexProductLifecycleActionRead } from './binding-repository/types'
import * as admission from './binding-repository/admission'
import * as browserVerifier from './binding-repository/browser-verifier'
import * as closeoutProduct from './binding-repository/closeout-product'
import * as closeoutTerminal from './binding-repository/closeout-terminal'
import * as continuity from './binding-repository/continuity'
import * as core from './binding-repository/core'
import * as gatewayBinding from './binding-repository/gateway-binding'
import * as interrupts from './binding-repository/interrupts'
import * as lifecycleHeads from './binding-repository/lifecycle-heads'
import * as lifecycleTransitions from './binding-repository/lifecycle-transitions'
import * as manualCompaction from './binding-repository/manual-compaction'
import * as nativeHistory from './binding-repository/native-history'
import * as processLeases from './binding-repository/process-leases'
import * as publicationBarrier from './binding-repository/publication-barrier'
import * as publicationReceipts from './binding-repository/publication-receipts'
import * as recovery from './binding-repository/recovery'
import * as startDispatch from './binding-repository/start-dispatch'
import * as turns from './binding-repository/turns'
import * as uncommittedTails from './binding-repository/uncommitted-tails'

export { CodexBindingRepositoryError } from './codex-binding-error'
export type {
  CodexToolBridgeExecutionBinding,
  CodexToolCallBindingRead,
} from './codex-tool-binding-repository'
export {
  buildCodexIngressAdmissionReceipt,
  buildCodexIngressAdmittedDigest,
  currentDocumentReadReceiptMatches,
} from './binding-repository/shared'
export type { CodexBindingRepositoryContract } from './binding-repository/types'
export type {
  CodexAcceptedNativePrefixHead,
  CodexActiveAliasBindingRead,
  CodexAdmittedBindingInput,
  CodexBindingRecoveryGuard,
  CodexBindingRecoveryMember,
  CodexBindingRecoverySnapshot,
  CodexBrowserVerifierAttemptOutcome,
  CodexBrowserVerifierAttemptRead,
  CodexBrowserVerifierVerdict,
  CodexEmptyAliasGenerationInput,
  CodexEngineTerminalReceiptRead,
  CodexHostFailureRecovery,
  CodexLifecycleAction,
  CodexLifecycleActionCloseoutRead,
  CodexLifecycleCloseoutRead,
  CodexLifecycleOperationRead,
  CodexManualCompactionRecovery,
  CodexManualCompactionRouteRead,
  CodexModelGatewayBindingRead,
  CodexModelGatewayBindingReadInput,
  CodexNativeCoverageItem,
  CodexNativeCoverageReceiptRef,
  CodexNativeForkSeedInput,
  CodexPendingInteractionBindingRead,
  CodexProcessLeaseIdentity,
  CodexProcessLeaseRow,
  CodexProductCloseoutRead,
  CodexProductFenceClaimRead,
  CodexProductFenceRecovery,
  CodexProductInterruptOwnerRead,
  CodexProductLifecycleActionRead,
  CodexProductStartStateRead,
  CodexProductTurnRuntimeRead,
  CodexPublishedToolOutputRead,
  CodexStoredContinuationRead,
  CodexTerminalCloseoutEvidence,
  CodexToolPublicationBarrierRead,
  CodexToolPublicationReceiptRead,
  CodexUncommittedUserTailItem,
} from './binding-repository/types'

type Operation<F> = F extends (context: CodexBindingContext, ...args: infer A) => unknown ? A : never

/**
 * Ready's durable record of Codex threads, turns, compactions, closeouts and the sidecar process. Each operation
 * lives in `binding-repository/` as a function over one shared context; this class is their stable public face.
 */
export class CodexBindingRepository {
  private readonly context: CodexBindingContext

  constructor(db: DatabaseConnection, currentContract?: CodexBindingRepositoryContract) {
    // A declared mapping must target the contract this runtime and Ready's instructions produce now; a stale one
    // means the continuity evidence predates an instruction change and must be measured again.
    const current = currentContract?.instructionContractDigest
    if (current && currentContract?.runtimeContinuityCatalog?.transitions.some((transition) => (
      transition.instructionContract && transition.instructionContract.targetDigest !== current
    ))) throw new CodexBindingRepositoryError('runtime_continuity_instruction_contract_stale')
    this.context = createCodexBindingContext(db, currentContract, this)
  }

  readOpenProductRunIds(...args: Operation<typeof turns.readOpenProductRunIds>) {
    return turns.readOpenProductRunIds(this.context, ...args)
  }

  readArtifactStorageRetention(...args: Operation<typeof turns.readArtifactStorageRetention>) {
    return turns.readArtifactStorageRetention(this.context, ...args)
  }

  hasProductTurnBinding(...args: Operation<typeof turns.hasProductTurnBinding>) {
    return turns.hasProductTurnBinding(this.context, ...args)
  }

  readActiveProductRunVisibilityIdentity(...args: Operation<typeof turns.readActiveProductRunVisibilityIdentity>) {
    return turns.readActiveProductRunVisibilityIdentity(this.context, ...args)
  }

  readCommittedProductRunVisibilityIdentity(...args: Operation<typeof turns.readCommittedProductRunVisibilityIdentity>) {
    return turns.readCommittedProductRunVisibilityIdentity(this.context, ...args)
  }

  hasExactProductFence(...args: Operation<typeof turns.hasExactProductFence>) {
    return turns.hasExactProductFence(this.context, ...args)
  }

  readPendingInteractionBinding(...args: Operation<typeof turns.readPendingInteractionBinding>) {
    return turns.readPendingInteractionBinding(this.context, ...args)
  }

  readActiveUpstreamProfileUsages(...args: Operation<typeof turns.readActiveUpstreamProfileUsages>) {
    return turns.readActiveUpstreamProfileUsages(this.context, ...args)
  }

  readActiveUpstreamProfileIds(...args: Operation<typeof turns.readActiveUpstreamProfileIds>) {
    return turns.readActiveUpstreamProfileIds(this.context, ...args)
  }

  readLatestAliasGeneration(...args: Operation<typeof core.readLatestAliasGeneration>) {
    return core.readLatestAliasGeneration(this.context, ...args)
  }

  appendAcceptedNativeCoverageReceipt(...args: Operation<typeof nativeHistory.appendAcceptedNativeCoverageReceipt>) {
    return nativeHistory.appendAcceptedNativeCoverageReceipt(this.context, ...args)
  }

  readAcceptedNativePrefixHead(...args: Operation<typeof nativeHistory.readAcceptedNativePrefixHead>) {
    return nativeHistory.readAcceptedNativePrefixHead(this.context, ...args)
  }

  readLatestAcceptedForkBoundary(...args: Operation<typeof nativeHistory.readLatestAcceptedForkBoundary>) {
    return nativeHistory.readLatestAcceptedForkBoundary(this.context, ...args)
  }

  readAcceptedNativePrefixResolution(...args: Operation<typeof nativeHistory.readAcceptedNativePrefixResolution>) {
    return nativeHistory.readAcceptedNativePrefixResolution(this.context, ...args)
  }

  readNativeForkMaterialization(...args: Operation<typeof nativeHistory.readNativeForkMaterialization>) {
    return nativeHistory.readNativeForkMaterialization(this.context, ...args)
  }

  readUncommittedUserTail(...args: Operation<typeof uncommittedTails.readUncommittedUserTail>) {
    return uncommittedTails.readUncommittedUserTail(this.context, ...args)
  }

  readLiveUncommittedUserTail(...args: Operation<typeof uncommittedTails.readLiveUncommittedUserTail>) {
    return uncommittedTails.readLiveUncommittedUserTail(this.context, ...args)
  }

  readHandoffUncommittedUserTail(...args: Operation<typeof uncommittedTails.readHandoffUncommittedUserTail>) {
    return uncommittedTails.readHandoffUncommittedUserTail(this.context, ...args)
  }

  readUncommittedTailDeliveryAudit(...args: Operation<typeof uncommittedTails.readUncommittedTailDeliveryAudit>) {
    return uncommittedTails.readUncommittedTailDeliveryAudit(this.context, ...args)
  }

  readActiveAliasBinding(...args: Operation<typeof continuity.readActiveAliasBinding>) {
    return continuity.readActiveAliasBinding(this.context, ...args)
  }

  readStoredContinuationContract(...args: Operation<typeof continuity.readStoredContinuationContract>) {
    return continuity.readStoredContinuationContract(this.context, ...args)
  }

  readFreshRootSourceContinuationContract(...args: Operation<typeof continuity.readFreshRootSourceContinuationContract>) {
    return continuity.readFreshRootSourceContinuationContract(this.context, ...args)
  }

  resolveRuntimeOperationForThread(...args: Operation<typeof continuity.resolveRuntimeOperationForThread>) {
    return continuity.resolveRuntimeOperationForThread(this.context, ...args)
  }

  resolveHeadMaterializationRuntime(...args: Operation<typeof continuity.resolveHeadMaterializationRuntime>) {
    return continuity.resolveHeadMaterializationRuntime(this.context, ...args)
  }

  freshRootRequiresReseed(...args: Operation<typeof continuity.freshRootRequiresReseed>) {
    return continuity.freshRootRequiresReseed(this.context, ...args)
  }

  resolveFreshRootInheritance(...args: Operation<typeof continuity.resolveFreshRootInheritance>) {
    return continuity.resolveFreshRootInheritance(this.context, ...args)
  }

  resolveSameThreadContinuation(...args: Operation<typeof continuity.resolveSameThreadContinuation>) {
    return continuity.resolveSameThreadContinuation(this.context, ...args)
  }

  readContextBoundaries(...args: Operation<typeof lifecycleHeads.readContextBoundaries>) {
    return lifecycleHeads.readContextBoundaries(this.context, ...args)
  }

  readHistoryOnlyScope(...args: Operation<typeof lifecycleHeads.readHistoryOnlyScope>) {
    return lifecycleHeads.readHistoryOnlyScope(this.context, ...args)
  }

  buildBeginNewContextActionRef(...args: Operation<typeof lifecycleTransitions.buildBeginNewContextActionRef>) {
    return lifecycleTransitions.buildBeginNewContextActionRef(this.context, ...args)
  }

  beginNewContext(...args: Operation<typeof lifecycleTransitions.beginNewContext>) {
    return lifecycleTransitions.beginNewContext(this.context, ...args)
  }

  readActionSurfaceInvalidation(...args: Operation<typeof lifecycleHeads.readActionSurfaceInvalidation>) {
    return lifecycleHeads.readActionSurfaceInvalidation(this.context, ...args)
  }

  readDriftedFreshStartAliases(...args: Operation<typeof lifecycleHeads.readDriftedFreshStartAliases>) {
    return lifecycleHeads.readDriftedFreshStartAliases(this.context, ...args)
  }

  refreshPristineFreshStartHeadAtomic(...args: Operation<typeof lifecycleTransitions.refreshPristineFreshStartHeadAtomic>) {
    return lifecycleTransitions.refreshPristineFreshStartHeadAtomic(this.context, ...args)
  }

  readManualCompactionRoute(...args: Operation<typeof lifecycleHeads.readManualCompactionRoute>) {
    return lifecycleHeads.readManualCompactionRoute(this.context, ...args)
  }

  readLifecycleOperation(...args: Operation<typeof lifecycleHeads.readLifecycleOperation>) {
    return lifecycleHeads.readLifecycleOperation(this.context, ...args)
  }

  readHeadActionFacts(...args: Operation<typeof lifecycleHeads.readHeadActionFacts>) {
    return lifecycleHeads.readHeadActionFacts(this.context, ...args)
  }

  readLatestLifecycleCloseout(...args: Operation<typeof lifecycleHeads.readLatestLifecycleCloseout>) {
    return lifecycleHeads.readLatestLifecycleCloseout(this.context, ...args)
  }

  readProductTurnRuntime(...args: Operation<typeof turns.readProductTurnRuntime>) {
    return turns.readProductTurnRuntime(this.context, ...args)
  }

  readProductTurnSuccessorId(...args: Operation<typeof turns.readProductTurnSuccessorId>) {
    return turns.readProductTurnSuccessorId(this.context, ...args)
  }

  readPublishedToolOutputs(...args: Operation<typeof publicationReceipts.readPublishedToolOutputs>) {
    return publicationReceipts.readPublishedToolOutputs(this.context, ...args)
  }

  recordEngineTerminalCandidate(...args: Operation<typeof publicationReceipts.recordEngineTerminalCandidate>) {
    return publicationReceipts.recordEngineTerminalCandidate(this.context, ...args)
  }

  readEngineTerminalCandidate(...args: Operation<typeof publicationReceipts.readEngineTerminalCandidate>) {
    return publicationReceipts.readEngineTerminalCandidate(this.context, ...args)
  }

  readTerminalCloseoutEvidence(...args: Operation<typeof publicationReceipts.readTerminalCloseoutEvidence>) {
    return publicationReceipts.readTerminalCloseoutEvidence(this.context, ...args)
  }

  recordToolPublicationReceipt(...args: Operation<typeof publicationReceipts.recordToolPublicationReceipt>) {
    return publicationReceipts.recordToolPublicationReceipt(this.context, ...args)
  }

  readToolPublicationReceipt(...args: Operation<typeof publicationReceipts.readToolPublicationReceipt>) {
    return publicationReceipts.readToolPublicationReceipt(this.context, ...args)
  }

  readToolPublicationBarrier(...args: Operation<typeof publicationBarrier.readToolPublicationBarrier>) {
    return publicationBarrier.readToolPublicationBarrier(this.context, ...args)
  }

  readProductCloseout(...args: Operation<typeof turns.readProductCloseout>) {
    return turns.readProductCloseout(this.context, ...args)
  }

  readProductTurnPresentation(...args: Operation<typeof lifecycleHeads.readProductTurnPresentation>) {
    return lifecycleHeads.readProductTurnPresentation(this.context, ...args)
  }

  readProductTurnPresentations(...args: Operation<typeof lifecycleHeads.readProductTurnPresentations>) {
    return lifecycleHeads.readProductTurnPresentations(this.context, ...args)
  }

  readProductTurnActionContext(...args: Operation<typeof lifecycleHeads.readProductTurnActionContext>) {
    return lifecycleHeads.readProductTurnActionContext(this.context, ...args)
  }

  readArtifactWriteHead(...args: Operation<typeof publicationReceipts.readArtifactWriteHead>) {
    return publicationReceipts.readArtifactWriteHead(this.context, ...args)
  }

  beginBrowserVerifierAttempt(...args: Operation<typeof browserVerifier.beginBrowserVerifierAttempt>) {
    return browserVerifier.beginBrowserVerifierAttempt(this.context, ...args)
  }

  settleBrowserVerifierAttempt(...args: Operation<typeof browserVerifier.settleBrowserVerifierAttempt>) {
    return browserVerifier.settleBrowserVerifierAttempt(this.context, ...args)
  }

  readBrowserVerifierAttempt(...args: Operation<typeof browserVerifier.readBrowserVerifierAttempt>) {
    return browserVerifier.readBrowserVerifierAttempt(this.context, ...args)
  }

  resolveProductInterruptOwner(...args: Operation<typeof interrupts.resolveProductInterruptOwner>) {
    return interrupts.resolveProductInterruptOwner(this.context, ...args)
  }

  requestProductInterrupt(input: {
    action: CodexLifecycleAction
    aliasId: string
    aliasGeneration: number
    readyRunId?: string
    codexThreadId: string
    codexTurnId: string
    requestedAt: string
  }): CodexProductLifecycleActionRead
  requestProductInterrupt(input: {
    action?: null
    aliasId: string
    aliasGeneration: number
    readyRunId?: string
    codexThreadId: string
    codexTurnId: string
    requestedAt: string
  }): CodexProductInterruptOwnerRead
  requestProductInterrupt(input: {
    action?: CodexLifecycleAction | null
    aliasId: string
    aliasGeneration: number
    readyRunId?: string
    codexThreadId: string
    codexTurnId: string
    requestedAt: string
  }): CodexProductInterruptOwnerRead | CodexProductLifecycleActionRead {
    return (interrupts.requestProductInterrupt as (context: CodexBindingContext, ...args: unknown[]) => ReturnType<CodexBindingRepository['requestProductInterrupt']>)(this.context, input)
  }

  readProductLifecycleAction(...args: Operation<typeof interrupts.readProductLifecycleAction>) {
    return interrupts.readProductLifecycleAction(this.context, ...args)
  }

  acknowledgeProductInterrupt(...args: Operation<typeof interrupts.acknowledgeProductInterrupt>) {
    return interrupts.acknowledgeProductInterrupt(this.context, ...args)
  }

  markProductInterruptUnknown(...args: Operation<typeof interrupts.markProductInterruptUnknown>) {
    return interrupts.markProductInterruptUnknown(this.context, ...args)
  }

  readProductStartState(...args: Operation<typeof turns.readProductStartState>) {
    return turns.readProductStartState(this.context, ...args)
  }

  createEmptyAliasGeneration(...args: Operation<typeof lifecycleTransitions.createEmptyAliasGeneration>) {
    return lifecycleTransitions.createEmptyAliasGeneration(this.context, ...args)
  }

  createEmptyAliasGenerationInOpenTransaction(...args: Operation<typeof lifecycleTransitions.createEmptyAliasGenerationInOpenTransaction>) {
    return lifecycleTransitions.createEmptyAliasGenerationInOpenTransaction(this.context, ...args)
  }

  resetIdleAlias(...args: Operation<typeof lifecycleTransitions.resetIdleAlias>) {
    return lifecycleTransitions.resetIdleAlias(this.context, ...args)
  }

  retireLegacyPreparedAlias(...args: Operation<typeof lifecycleTransitions.retireLegacyPreparedAlias>) {
    return lifecycleTransitions.retireLegacyPreparedAlias(this.context, ...args)
  }

  retireIdleAliasForClose(...args: Operation<typeof lifecycleTransitions.retireIdleAliasForClose>) {
    return lifecycleTransitions.retireIdleAliasForClose(this.context, ...args)
  }

  admitProductBindings(...args: Operation<typeof admission.admitProductBindings>) {
    return admission.admitProductBindings(this.context, ...args)
  }

  admitProductBindingsInOpenTransaction(...args: Operation<typeof admission.admitProductBindingsInOpenTransaction>) {
    return admission.admitProductBindingsInOpenTransaction(this.context, ...args)
  }

  activateStartDispatch(...args: Operation<typeof startDispatch.activateStartDispatch>) {
    return startDispatch.activateStartDispatch(this.context, ...args)
  }

  markStartChildWriteConfirmed(...args: Operation<typeof startDispatch.markStartChildWriteConfirmed>) {
    return startDispatch.markStartChildWriteConfirmed(this.context, ...args)
  }

  validateUnresolvedStart(...args: Operation<typeof startDispatch.validateUnresolvedStart>) {
    return startDispatch.validateUnresolvedStart(this.context, ...args)
  }

  markForkMaterializationProvenAbsent(...args: Operation<typeof nativeHistory.markForkMaterializationProvenAbsent>) {
    return nativeHistory.markForkMaterializationProvenAbsent(this.context, ...args)
  }

  reconcileStartAccepted(...args: Operation<typeof startDispatch.reconcileStartAccepted>) {
    return startDispatch.reconcileStartAccepted(this.context, ...args)
  }

  consumeLateStartResponse(...args: Operation<typeof startDispatch.consumeLateStartResponse>) {
    return startDispatch.consumeLateStartResponse(this.context, ...args)
  }

  closeLateResponseGuardsForConnection(...args: Operation<typeof startDispatch.closeLateResponseGuardsForConnection>) {
    return startDispatch.closeLateResponseGuardsForConnection(this.context, ...args)
  }

  readRecoverySnapshot(...args: Operation<typeof recovery.readRecoverySnapshot>) {
    return recovery.readRecoverySnapshot(this.context, ...args)
  }

  claimProductFenceForBoot(...args: Operation<typeof recovery.claimProductFenceForBoot>) {
    return recovery.claimProductFenceForBoot(this.context, ...args)
  }

  readProductRunForThreadBinding(...args: Operation<typeof turns.readProductRunForThreadBinding>) {
    return turns.readProductRunForThreadBinding(this.context, ...args)
  }

  readStartInboundIdentity(...args: Operation<typeof startDispatch.readStartInboundIdentity>) {
    return startDispatch.readStartInboundIdentity(this.context, ...args)
  }

  quarantineStartInbound(...args: Operation<typeof startDispatch.quarantineStartInbound>) {
    return startDispatch.quarantineStartInbound(this.context, ...args)
  }

  assertThreadArchiveEligible(...args: Operation<typeof core.assertThreadArchiveEligible>) {
    return core.assertThreadArchiveEligible(this.context, ...args)
  }

  recordHostFailureEvidence(...args: Operation<typeof closeoutProduct.recordHostFailureEvidence>) {
    return closeoutProduct.recordHostFailureEvidence(this.context, ...args)
  }

  completeHostFailureCloseout(...args: Operation<typeof closeoutProduct.completeHostFailureCloseout>) {
    return closeoutProduct.completeHostFailureCloseout(this.context, ...args)
  }

  completeProductTurnCloseout(...args: Operation<typeof closeoutProduct.completeProductTurnCloseout>) {
    return closeoutProduct.completeProductTurnCloseout(this.context, ...args)
  }

  completeCanonicalProductCloseoutInOpenTransaction(...args: Operation<typeof closeoutProduct.completeCanonicalProductCloseoutInOpenTransaction>) {
    return closeoutProduct.completeCanonicalProductCloseoutInOpenTransaction(this.context, ...args)
  }

  completeVerifierAcceptedCloseoutInOpenTransaction(...args: Operation<typeof closeoutTerminal.completeVerifierAcceptedCloseoutInOpenTransaction>) {
    return closeoutTerminal.completeVerifierAcceptedCloseoutInOpenTransaction(this.context, ...args)
  }

  completeVerifierRejectedCloseoutInOpenTransaction(...args: Operation<typeof closeoutTerminal.completeVerifierRejectedCloseoutInOpenTransaction>) {
    return closeoutTerminal.completeVerifierRejectedCloseoutInOpenTransaction(this.context, ...args)
  }

  completeLifecycleActionCloseoutInOpenTransaction(...args: Operation<typeof closeoutTerminal.completeLifecycleActionCloseoutInOpenTransaction>) {
    return closeoutTerminal.completeLifecycleActionCloseoutInOpenTransaction(this.context, ...args)
  }

  readLifecycleActionCloseout(...args: Operation<typeof lifecycleHeads.readLifecycleActionCloseout>) {
    return lifecycleHeads.readLifecycleActionCloseout(this.context, ...args)
  }

  completePublicationDivergenceCloseoutInOpenTransaction(...args: Operation<typeof closeoutTerminal.completePublicationDivergenceCloseoutInOpenTransaction>) {
    return closeoutTerminal.completePublicationDivergenceCloseoutInOpenTransaction(this.context, ...args)
  }

  completeHistoryResetRequiredCloseoutInOpenTransaction(...args: Operation<typeof closeoutTerminal.completeHistoryResetRequiredCloseoutInOpenTransaction>) {
    return closeoutTerminal.completeHistoryResetRequiredCloseoutInOpenTransaction(this.context, ...args)
  }

  completeRecoveryFailureCloseoutInOpenTransaction(...args: Operation<typeof closeoutProduct.completeRecoveryFailureCloseoutInOpenTransaction>) {
    return closeoutProduct.completeRecoveryFailureCloseoutInOpenTransaction(this.context, ...args)
  }

  bindToolCall(...args: Operation<typeof publicationReceipts.bindToolCall>) {
    return publicationReceipts.bindToolCall(this.context, ...args)
  }

  admitToolResponseGroup(...args: Operation<typeof publicationReceipts.admitToolResponseGroup>) {
    return publicationReceipts.admitToolResponseGroup(this.context, ...args)
  }

  readToolBridgeExecutionBinding(...args: Operation<typeof publicationReceipts.readToolBridgeExecutionBinding>) {
    return publicationReceipts.readToolBridgeExecutionBinding(this.context, ...args)
  }

  readToolCallBinding(...args: Operation<typeof publicationReceipts.readToolCallBinding>) {
    return publicationReceipts.readToolCallBinding(this.context, ...args)
  }

  completeToolCall(...args: Operation<typeof publicationReceipts.completeToolCall>) {
    return publicationReceipts.completeToolCall(this.context, ...args)
  }

  markToolCallDeliveryIntent(...args: Operation<typeof publicationReceipts.markToolCallDeliveryIntent>) {
    return publicationReceipts.markToolCallDeliveryIntent(this.context, ...args)
  }

  beginToolCallDeliveryAttempt(...args: Operation<typeof publicationReceipts.beginToolCallDeliveryAttempt>) {
    return publicationReceipts.beginToolCallDeliveryAttempt(this.context, ...args)
  }

  readToolCallDeliveryAttempts(...args: Operation<typeof publicationReceipts.readToolCallDeliveryAttempts>) {
    return publicationReceipts.readToolCallDeliveryAttempts(this.context, ...args)
  }

  confirmToolCallDeliveryTransportWrite(...args: Operation<typeof publicationReceipts.confirmToolCallDeliveryTransportWrite>) {
    return publicationReceipts.confirmToolCallDeliveryTransportWrite(this.context, ...args)
  }

  readModelGatewayBinding(...args: Operation<typeof gatewayBinding.readModelGatewayBinding>) {
    return gatewayBinding.readModelGatewayBinding(this.context, ...args)
  }

  beginManualCompaction(...args: Operation<typeof manualCompaction.beginManualCompaction>) {
    return manualCompaction.beginManualCompaction(this.context, ...args)
  }

  activateManualCompactionDispatch(...args: Operation<typeof manualCompaction.activateManualCompactionDispatch>) {
    return manualCompaction.activateManualCompactionDispatch(this.context, ...args)
  }

  markManualCompactionWriteAttempted(...args: Operation<typeof manualCompaction.markManualCompactionWriteAttempted>) {
    return manualCompaction.markManualCompactionWriteAttempted(this.context, ...args)
  }

  markManualCompactionWriteConfirmed(...args: Operation<typeof manualCompaction.markManualCompactionWriteConfirmed>) {
    return manualCompaction.markManualCompactionWriteConfirmed(this.context, ...args)
  }

  markManualCompactionDispatchUnresolved(...args: Operation<typeof manualCompaction.markManualCompactionDispatchUnresolved>) {
    return manualCompaction.markManualCompactionDispatchUnresolved(this.context, ...args)
  }

  recordManualCompactionDispatchResponse(...args: Operation<typeof manualCompaction.recordManualCompactionDispatchResponse>) {
    return manualCompaction.recordManualCompactionDispatchResponse(this.context, ...args)
  }

  consumeLateManualCompactionResponse(...args: Operation<typeof manualCompaction.consumeLateManualCompactionResponse>) {
    return manualCompaction.consumeLateManualCompactionResponse(this.context, ...args)
  }

  markManualCompactionConnectionClosed(...args: Operation<typeof manualCompaction.markManualCompactionConnectionClosed>) {
    return manualCompaction.markManualCompactionConnectionClosed(this.context, ...args)
  }

  proveManualCompactionAttemptAbsent(...args: Operation<typeof manualCompaction.proveManualCompactionAttemptAbsent>) {
    return manualCompaction.proveManualCompactionAttemptAbsent(this.context, ...args)
  }

  renewManualCompactionRecoveryWindow(...args: Operation<typeof manualCompaction.renewManualCompactionRecoveryWindow>) {
    return manualCompaction.renewManualCompactionRecoveryWindow(this.context, ...args)
  }

  recordManualCompactionUnknown(...args: Operation<typeof manualCompaction.recordManualCompactionUnknown>) {
    return manualCompaction.recordManualCompactionUnknown(this.context, ...args)
  }

  consumeManualCompaction(...args: Operation<typeof manualCompaction.consumeManualCompaction>) {
    return manualCompaction.consumeManualCompaction(this.context, ...args)
  }

  settleRejectedManualCompaction(...args: Operation<typeof manualCompaction.settleRejectedManualCompaction>) {
    return manualCompaction.settleRejectedManualCompaction(this.context, ...args)
  }

  quarantineUnknownManualCompaction(...args: Operation<typeof manualCompaction.quarantineUnknownManualCompaction>) {
    return manualCompaction.quarantineUnknownManualCompaction(this.context, ...args)
  }

  reconcileQuarantinedManualCompaction(...args: Operation<typeof manualCompaction.reconcileQuarantinedManualCompaction>) {
    return manualCompaction.reconcileQuarantinedManualCompaction(this.context, ...args)
  }

  recordThreadResumeEvidence(...args: Operation<typeof nativeHistory.recordThreadResumeEvidence>) {
    return nativeHistory.recordThreadResumeEvidence(this.context, ...args)
  }

  createProcessLeaseIntent(...args: Operation<typeof processLeases.createProcessLeaseIntent>) {
    return processLeases.createProcessLeaseIntent(this.context, ...args)
  }

  confirmProcessLeaseOwnership(...args: Operation<typeof processLeases.confirmProcessLeaseOwnership>) {
    return processLeases.confirmProcessLeaseOwnership(this.context, ...args)
  }

  markProcessConnectionOpened(...args: Operation<typeof processLeases.markProcessConnectionOpened>) {
    return processLeases.markProcessConnectionOpened(this.context, ...args)
  }

  markProcessConnectionClosed(...args: Operation<typeof processLeases.markProcessConnectionClosed>) {
    return processLeases.markProcessConnectionClosed(this.context, ...args)
  }

  recordOldMainDeath(...args: Operation<typeof processLeases.recordOldMainDeath>) {
    return processLeases.recordOldMainDeath(this.context, ...args)
  }

  recordProcessTreeZero(...args: Operation<typeof processLeases.recordProcessTreeZero>) {
    return processLeases.recordProcessTreeZero(this.context, ...args)
  }

  readLiveProcessLease(...args: Operation<typeof processLeases.readLiveProcessLease>) {
    return processLeases.readLiveProcessLease(this.context, ...args)
  }

  readProcessLeaseByConnectionEpoch(...args: Operation<typeof processLeases.readProcessLeaseByConnectionEpoch>) {
    return processLeases.readProcessLeaseByConnectionEpoch(this.context, ...args)
  }

  readLatestProcessLeaseByOwnerMainBootId(...args: Operation<typeof processLeases.readLatestProcessLeaseByOwnerMainBootId>) {
    return processLeases.readLatestProcessLeaseByOwnerMainBootId(this.context, ...args)
  }

  readNativeFormalInputCoverage(...args: Operation<typeof nativeHistory.readNativeFormalInputCoverage>) {
    return nativeHistory.readNativeFormalInputCoverage(this.context, ...args)
  }
}
