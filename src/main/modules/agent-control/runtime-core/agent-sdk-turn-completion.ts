import { MemorySession, type AgentInputItem, type ModelProvider } from '@openai/agents'
import { normalizeSessionSnapshotForSeed } from '../compaction/compact-agent-input'
import type {
  ExecutionTurnResult,
  TaskBudgetRuntime,
  TurnTranscriptEvent
} from '../contracts/run-contracts'
import { writeScopeSessionSnapshot } from '../session/scope-session-snapshot'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import { normalizeToolExecutionOutput } from '../tools-runtime/tool-result-types'
import {
  finalTextIndicatesIncompleteDocument,
  inspectDocumentTargetContent,
  isDocumentToolFailure,
  mergeProjectionPatches
} from './agent-sdk-document-utils'
import { errorMessage, throwIfAbortSignalAborted } from './agent-sdk-execution-utils'
import { log } from './agent-sdk-provider'
import { buildExecutionTurnResult } from './agent-sdk-turn-closeout'
import type { TurnOrchestratorHost } from './agent-sdk-turn-context'
import type {
  AgentSdkProviderDiagnostics,
  DocumentTargetGuard,
  ObservedDocumentToolTarget,
  ReadyAgentSdkRunResult,
  RunHandle,
  ToolBridgeRuntimeContext
} from './agent-sdk-types'
import {
  finalizeRunOutcome,
  reconcileTerminalTaskBudgetRuntime,
  writeRunCloseMetric
} from './run-finalizer'
import type { TurnTerminalReason } from './turn-frame'
import type { CollaborationDecision } from '../../../../shared/dynamic-delivery'
import type {
  BrowserWorkflowCloseoutSeal,
  BrowserWorkflowCompletionVerifierReceipt,
} from '../../../../shared/browser-workflow-control'
import { addRunUsage, mergeRunUsage } from './run-usage-accumulator'
import { materializeDeliveryArtifacts } from './dynamic-delivery/delivery-artifact-readback'
import { materializeBrowserWorkflowDeliveryVerifierResources } from './dynamic-delivery/browser-workflow-delivery-verifier'
import type { CanonicalAssistantMessageReceipt } from '../../../../shared/ipc-contracts/canonical-message'
import { workflowDigest } from '../../repositories/browser-workflow-codec'
import {
  buildBrowserVerifierRecoveryItem,
  withoutBrowserVerifierRecoveryItems,
} from './agent-sdk-browser-suspension'

function canonicalAssistantSessionItem(content: string): AgentInputItem {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: content }],
  } as AgentInputItem
}

function hasCanonicalAssistantItem(items: readonly AgentInputItem[], content: string): boolean {
  return items.some((item) => {
    const candidate = item as {
      role?: unknown
      content?: Array<{ type?: unknown; text?: unknown }>
    }
    return candidate.role === 'assistant'
      && Array.isArray(candidate.content)
      && candidate.content.some((part) => part.type === 'output_text' && part.text === content)
  })
}

export interface AgentSdkTurnCompletionState {
  finalText: string
  hasSuccessfulDocumentTargetMutation: boolean
  hasSuccessfulLocalDocumentSourceRead: boolean
  lastDocumentSaveFailure: string | null
  lastDocumentSaveSuccessText: string | null
  liveTaskBudgetRuntime: TaskBudgetRuntime | null
  newDocumentNeedsSave: boolean
  runMetaBudgetRuntime: TaskBudgetRuntime | null
  runMetaContinuationRef: Record<string, unknown> | null
  runMetaProviderDiagnostics: AgentSdkProviderDiagnostics | null
  runMetaUsage: ReadyAgentSdkRunResult['usage'] | null
}

export interface AgentSdkTurnCompletionContext {
  state: AgentSdkTurnCompletionState
  host: TurnOrchestratorHost
  name: string
  runId: string
  taskId: string
  sessionId?: string
  runStartedAt: number
  useTextToolBridge: boolean
  usedTools: string[]
  requiresLocalDocumentExcerpt: boolean
  documentTargetGuard: DocumentTargetGuard | null
  observedDocumentMutationConflict: boolean
  observedDocumentMutationMissingTarget: boolean
  observedDocumentMutationTarget: ObservedDocumentToolTarget | null
  definitionByName: Map<string, ToolDefinition>
  toolBridgeRuntimeContext: ToolBridgeRuntimeContext
  projectionPatches: Record<string, unknown>[]
  transcriptEvents: TurnTranscriptEvent[]
  runHandle: RunHandle
  committedPublicSession: MemorySession
  committedOwnerSession: MemorySession
  deliveryDecision: CollaborationDecision
  deliveryRealEmitOutput: AgentSdkTurnCompletionContext['emitOutput']
  model: string
  provider: ModelProvider
  contextWindowTokens: number
  maxOutputTokens: number
  abortSignal: AbortSignal
  emitOutput: (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null
  ) => void
  emitOutputForRun: (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null,
    canonicalReceipt?: CanonicalAssistantMessageReceipt,
  ) => void
  emitStatusForRun: (status: string, terminalReason?: TurnTerminalReason | null) => void
  finishBudgetCheckpointIfNeeded: () => Promise<ExecutionTurnResult | null>
  finishSteeringCheckpointIfNeeded: () => Promise<ExecutionTurnResult | null>
  finishBrowserIncompleteCheckpoint: (
    message?: string,
    recoveryItems?: AgentInputItem[],
  ) => Promise<ExecutionTurnResult>
  finalizeEarlyReturn: (params: {
    status: 'done' | 'checkpoint' | 'error' | 'cancelled'
    terminalReason: TurnTerminalReason
    finalText: string
    error?: string
    continuationHandle?: string | null
    taskBudgetRuntime?: TaskBudgetRuntime | null
    providerDiagnostics?: AgentSdkProviderDiagnostics | null
    initiator?: string
  }) => Promise<ExecutionTurnResult>
  buildResult: (params: Parameters<typeof buildExecutionTurnResult>[1]) => ExecutionTurnResult
}

export async function finalizeAgentSdkPreparedTurnResult(
  ctx: AgentSdkTurnCompletionContext
): Promise<ExecutionTurnResult> {
  const {
    state,
    host,
    name,
    runId,
    taskId,
    sessionId,
    runStartedAt,
    useTextToolBridge,
    usedTools,
    requiresLocalDocumentExcerpt,
    documentTargetGuard,
    observedDocumentMutationConflict,
    observedDocumentMutationMissingTarget,
    observedDocumentMutationTarget,
    definitionByName,
    toolBridgeRuntimeContext,
    projectionPatches,
    transcriptEvents,
    runHandle,
    committedPublicSession,
    committedOwnerSession,
    deliveryDecision,
    deliveryRealEmitOutput,
    model,
    provider,
    contextWindowTokens,
    maxOutputTokens,
    abortSignal,
    emitOutput,
    emitOutputForRun,
    emitStatusForRun,
    finishBudgetCheckpointIfNeeded,
    finishSteeringCheckpointIfNeeded,
    finishBrowserIncompleteCheckpoint,
    finalizeEarlyReturn,
    buildResult
  } = ctx
  let {
    finalText,
    hasSuccessfulDocumentTargetMutation,
    hasSuccessfulLocalDocumentSourceRead,
    lastDocumentSaveFailure,
    lastDocumentSaveSuccessText,
    liveTaskBudgetRuntime,
    newDocumentNeedsSave,
    runMetaBudgetRuntime,
    runMetaContinuationRef,
    runMetaProviderDiagnostics,
    runMetaUsage
  } = state
  let dynamicDeliveryCandidatePending = false
  let verifiedCandidateSnapshot: {
    acceptedText: string
    committedBase: AgentInputItem[]
    acceptedDelta: AgentInputItem[]
  } | null = null
  let deferredTerminalProjection: {
    projectionPatch: Record<string, unknown> | null
    terminalReason: string
    status: string
    canonicalReceipt?: CanonicalAssistantMessageReceipt
  } | null = null
  let workflowCloseoutSeal: BrowserWorkflowCloseoutSeal | null = null
  let workflowVerifierAcceptance: Omit<
    BrowserWorkflowCompletionVerifierReceipt,
    'parentTaskId' | 'ownerRunId' | 'terminalQualityPatchDigest'
  > | null = null
  try {
    throwIfAbortSignalAborted(abortSignal)
    {
      const checkpointResult = await finishSteeringCheckpointIfNeeded()
      if (checkpointResult) return checkpointResult
    }
    if (useTextToolBridge && !finalText && usedTools.length > 0) {
      finalText = '工具已执行，但模型尚未给出最终回复。'
    }
    if (requiresLocalDocumentExcerpt && !hasSuccessfulLocalDocumentSourceRead) {
      const message = '还没有读取指定文档正文，不能声明完成。'
      return finalizeEarlyReturn({
        status: 'error',
        terminalReason: 'blocked_tool_error',
        error: message,
        finalText: message
      })
    }
    if (documentTargetGuard && finalTextIndicatesIncompleteDocument(finalText)) {
      const message = `目标文档 ${documentTargetGuard.targetName} 仍未补完，不能声明完成。`
      return finalizeEarlyReturn({
        status: 'error',
        terminalReason: 'blocked_tool_error',
        error: message,
        finalText: message
      })
    }
    if (documentTargetGuard) {
      const contentIssue = await inspectDocumentTargetContent(documentTargetGuard, {
        forbidFutureLeakage: requiresLocalDocumentExcerpt
      })
      if (contentIssue) {
        const message = `目标文档 ${documentTargetGuard.targetName} 内容未通过检查：${contentIssue}`
        return finalizeEarlyReturn({
          status: 'error',
          terminalReason: 'blocked_tool_error',
          error: message,
          finalText: message
        })
      }
    }
    if (documentTargetGuard && !hasSuccessfulDocumentTargetMutation) {
      const message = `目标文档 ${documentTargetGuard.targetName} 尚未实际写入，不能声明完成。`
      return finalizeEarlyReturn({
        status: 'error',
        terminalReason: 'blocked_tool_error',
        error: message,
        finalText: message
      })
    }
    if (
      !documentTargetGuard &&
      hasSuccessfulDocumentTargetMutation &&
      !lastDocumentSaveSuccessText &&
      !newDocumentNeedsSave
    ) {
      if (observedDocumentMutationConflict) {
        const message = '本轮修改涉及多个文档，不能自动判断要保存哪一个。请明确目标文档后继续。'
        return finalizeEarlyReturn({
          status: 'error',
          terminalReason: 'blocked_tool_error',
          error: message,
          finalText: message
        })
      }
      const observedTarget = observedDocumentMutationTarget as ObservedDocumentToolTarget | null
      if (observedDocumentMutationMissingTarget || !observedTarget) {
        const message = '文档已经发生修改，但工具没有回传明确的文档身份，不能自动保存或声明完成。'
        return finalizeEarlyReturn({
          status: 'error',
          terminalReason: 'blocked_tool_error',
          error: message,
          finalText: message
        })
      }
      if (!observedTarget.path && observedTarget.requiresSave) {
        const message = `文档 ${observedTarget.title} 还没有保存路径，不能在后台自动保存。请先指定保存位置。`
        return finalizeEarlyReturn({
          status: 'error',
          terminalReason: 'blocked_tool_error',
          error: message,
          finalText: message
        })
      }
      if (observedTarget.path && observedTarget.requiresSave) {
        const saveDefinition = definitionByName.get('document_save_tab')
        if (saveDefinition) {
          emitOutput(`文档 ${observedTarget.title} 已修改但还没有保存，我会自动保存它。`, 'text')
          const output = await host.toolExecutor.executeReadyToolDefinition(
            saveDefinition,
            { tabId: observedTarget.tabId },
            toolBridgeRuntimeContext
          )
          lastDocumentSaveFailure = state.lastDocumentSaveFailure
          lastDocumentSaveSuccessText = state.lastDocumentSaveSuccessText
          liveTaskBudgetRuntime = state.liveTaskBudgetRuntime
          newDocumentNeedsSave = state.newDocumentNeedsSave
          const normalized = normalizeToolExecutionOutput(output)
          if (isDocumentToolFailure(normalized)) {
            lastDocumentSaveFailure = normalized.text || 'document_save_tab failed'
          } else if (
            lastDocumentSaveSuccessText &&
            !finalText.includes(lastDocumentSaveSuccessText)
          ) {
            const savedMessage = `已完成，${lastDocumentSaveSuccessText}`
            finalText = finalText.trim() ? `${finalText}\n\n${savedMessage}` : savedMessage
            emitOutput(savedMessage, 'text')
          }
        } else {
          lastDocumentSaveFailure = '本轮未开放 document_save_tab'
        }
      }
    }
    if (newDocumentNeedsSave) {
      const saveDefinition = definitionByName.get('document_save_tab')
      if (saveDefinition) {
        emitOutput('正文或标签尚未完成，我会自动补全当前文档。', 'text')
        const output = await host.toolExecutor.executeReadyToolDefinition(
          saveDefinition,
          {},
          toolBridgeRuntimeContext
        )
        lastDocumentSaveFailure = state.lastDocumentSaveFailure
        lastDocumentSaveSuccessText = state.lastDocumentSaveSuccessText
        liveTaskBudgetRuntime = state.liveTaskBudgetRuntime
        newDocumentNeedsSave = state.newDocumentNeedsSave
        const normalized = normalizeToolExecutionOutput(output)
        if (isDocumentToolFailure(normalized)) {
          lastDocumentSaveFailure = normalized.text || 'document_save_tab failed'
        } else if (
          lastDocumentSaveSuccessText &&
          !finalText.includes(lastDocumentSaveSuccessText)
        ) {
          const savedMessage = `已完成，${lastDocumentSaveSuccessText}`
          finalText = finalText.trim() ? `${finalText}\n\n${savedMessage}` : savedMessage
          emitOutput(savedMessage, 'text')
        }
      } else {
        lastDocumentSaveFailure = '本轮未开放 document_save_tab'
      }
    }
    if (lastDocumentSaveFailure && hasSuccessfulDocumentTargetMutation) {
      const message = `文档保存失败，不能声明完成：${lastDocumentSaveFailure}`
      return finalizeEarlyReturn({
        status: 'error',
        terminalReason: 'persistence_failed',
        error: message,
        finalText: message
      })
    }
    if (newDocumentNeedsSave) {
      const message = '新文档已经修改但尚未保存，不能声明完成。'
      return finalizeEarlyReturn({
        status: 'error',
        terminalReason: 'persistence_failed',
        error: message,
        finalText: message
      })
    }
    if (!finalText.trim() && usedTools.length > 0) {
      finalText = lastDocumentSaveSuccessText
        ? `已完成，${lastDocumentSaveSuccessText}`
        : '工具已执行完成。'
    }
    const workflowRepository = toolBridgeRuntimeContext.browserWorkflowRoute
      ? host.runtime?.getAgentSessionCheckpointRepository() ?? null
      : null
    const browserVerifierInspection = workflowRepository
      ? workflowRepository.readWorkflowVerifierBundle(taskId)
      : null
    const browserVerifierBundle = browserVerifierInspection?.bundle ?? null
    if (browserVerifierInspection && browserVerifierInspection.inspection.state !== 'sealable') {
      const message = browserVerifierInspection.inspection.state === 'observation_required'
        ? '最后一个页面动作还没有完成因果观察，本轮未发布候选结果。'
        : browserVerifierInspection.inspection.state === 'action_in_flight'
          ? '页面动作仍在执行，本轮未发布候选结果。'
          : browserVerifierInspection.inspection.state === 'research_incomplete'
            ? '网页调研证据还未齐备，本轮未发布候选结果。'
            : '浏览器任务路由已丢失，本轮未发布候选结果。'
      if (browserVerifierInspection.inspection.state !== 'absent') {
        return finishBrowserIncompleteCheckpoint(message)
      }
      return finalizeEarlyReturn({
        status: 'error',
        terminalReason: 'blocked_tool_error',
        error: message,
        finalText: message,
      })
    }
    if (browserVerifierBundle) workflowCloseoutSeal = browserVerifierBundle.seal
    const readVerifierResources = (projectionAfterOwner: {
      proofRefs?: ReadonlyArray<unknown> | null
      recentArtifacts?: ReadonlyArray<unknown> | null
      expectedOutputs?: ReadonlyArray<string> | null
    }) => {
      const resources = materializeDeliveryArtifacts({
        proofRefs: projectionAfterOwner.proofRefs,
        recentArtifacts: projectionAfterOwner.recentArtifacts,
        expectedOutputs: projectionAfterOwner.expectedOutputs,
        userRequestVerbatim: browserVerifierBundle?.requestText
          || String(toolBridgeRuntimeContext.currentUserText || ''),
        requestEnvelope: toolBridgeRuntimeContext.requestEnvelope,
        currentRunId: runId,
        runStartedAtMs: runStartedAt,
      })
      return browserVerifierBundle
        ? materializeBrowserWorkflowDeliveryVerifierResources({
            bundle: browserVerifierBundle,
            projection: projectionAfterOwner,
            requestEnvelope: toolBridgeRuntimeContext.requestEnvelope,
            currentRunId: runId,
            runStartedAtMs: runStartedAt,
          })
        : resources
    }
    if (deliveryDecision !== 'single_path') {
      const store = host.runtime?.getTaskProjectionStoreForFinalize?.() ?? null
      const projectionAfterOwner = store?.get(taskId) ?? null
      if (!projectionAfterOwner) {
        const message = '协作交付状态不可用，已阻止未经复核的结果。'
        return finalizeEarlyReturn({
          status: 'error',
          terminalReason: 'blocked_tool_error',
          error: message,
          finalText: message
        })
      }
      const verification = await host.dynamicDelivery.verifyOwnerCandidate({
        runId,
        candidateText: finalText,
        ...(browserVerifierBundle
          ? { userRequestVerbatimOverride: browserVerifierBundle.requestText }
          : {}),
        projectionAfterOwner,
        model,
        provider,
        contextWindowTokens,
        maxOutputTokens,
        signal: abortSignal,
        artifactRepairTools: [
          'document_read_section',
          'document_replace_exact',
          'document_update_widget',
          'document_save_tab',
        ].flatMap((toolName) => {
          const definition = definitionByName.get(toolName)
          return definition ? [host.toolExecutor.buildSdkTool(definition, toolBridgeRuntimeContext)] : []
        }),
        materializeAndReadBack: async () => readVerifierResources(projectionAfterOwner),
      })
      runMetaUsage = mergeRunUsage(runMetaUsage as never, verification.verificationUsage) as ReadyAgentSdkRunResult['usage']
      if (verification.verdict.verdict !== 'accept' || verification.acceptedText === null) {
        if (browserVerifierBundle) {
          return finishBrowserIncompleteCheckpoint('', [buildBrowserVerifierRecoveryItem({
            rejectedCandidateDigest: workflowDigest(verification.sealed.candidateText),
            verdict: verification.verdict.verdict,
            summary: verification.verdict.summary,
            gaps: verification.verdict.gaps,
          })])
        }
        const message = verification.verdict.verdict === 'repair'
          ? '独立复核发现仍需修正的缺口，本轮未发布候选结果。'
          : '独立复核未通过，本轮未发布候选结果。'
        return finalizeEarlyReturn({
          status: 'error',
          terminalReason: 'blocked_tool_error',
          error: message,
          finalText: message,
        })
      }
      finalText = verification.acceptedText
      if (!verification.acceptedDeliveryState) {
        throw new Error('[dynamic-delivery] accepted candidate is missing accepted state')
      }
      projectionPatches.push({ deliveryState: verification.acceptedDeliveryState })
      dynamicDeliveryCandidatePending = true
      if (browserVerifierBundle && workflowCloseoutSeal) {
        workflowVerifierAcceptance = {
          version: 1,
          verdict: 'accept',
          candidateDigest: workflowDigest(finalText),
          workflowCloseoutSealDigest: workflowDigest(workflowCloseoutSeal),
          sealedCandidateDigest: workflowDigest(verification.sealed),
          verifiedAt: verification.sealed.sealedAt,
        }
      }
    } else if (browserVerifierBundle && workflowCloseoutSeal) {
      const store = host.runtime?.getTaskProjectionStoreForFinalize?.() ?? null
      const projectionAfterOwner = store?.get(taskId) ?? null
      if (!projectionAfterOwner) throw new Error('browser_workflow_projection_missing_for_verifier')
      const verification = await host.dynamicDelivery.verifyStandaloneCandidate({
        runId,
        taskId,
        userRequestVerbatim: browserVerifierBundle.requestText,
        candidateText: finalText,
        hostCriteria: projectionAfterOwner.criteria ? [projectionAfterOwner.criteria] : [],
        modelCriteria: projectionAfterOwner.modelCriteria ?? [],
        model,
        provider,
        contextWindowTokens,
        maxOutputTokens,
        signal: abortSignal,
        materializeAndReadBack: async () => readVerifierResources(projectionAfterOwner),
      })
      runMetaUsage = mergeRunUsage(
        runMetaUsage as never,
        addRunUsage(null, verification.verificationUsage),
      ) as ReadyAgentSdkRunResult['usage']
      if (verification.verdict.verdict !== 'accept') {
        const message = '独立复核未通过，本轮未发布候选结果。'
        return finishBrowserIncompleteCheckpoint(message, [buildBrowserVerifierRecoveryItem({
          rejectedCandidateDigest: workflowDigest(verification.sealed.candidateText),
          verdict: verification.verdict.verdict,
          summary: verification.verdict.summary,
          gaps: verification.verdict.gaps,
        })])
      }
      workflowVerifierAcceptance = {
        version: 1,
        verdict: 'accept',
        candidateDigest: workflowDigest(finalText),
        workflowCloseoutSealDigest: workflowDigest(workflowCloseoutSeal),
        sealedCandidateDigest: workflowDigest(verification.sealed),
        verifiedAt: verification.sealed.sealedAt,
      }
    }
    {
      const checkpointResult = await finishBudgetCheckpointIfNeeded()
      if (checkpointResult) {
        if (dynamicDeliveryCandidatePending) host.dynamicDelivery.abortVerifiedCandidate(runId)
        return checkpointResult
      }
    }
    if (usedTools.length === 0 && (!liveTaskBudgetRuntime || liveTaskBudgetRuntime.bootstrapBudget)) {
      projectionPatches.push({ taskType: 'direct_answer', module: 'system' })
    }
    if (toolBridgeRuntimeContext.browserWorkflowRoute && !workflowCloseoutSeal) {
      throw new Error('browser_workflow_closeout_seal_missing')
    }
    const finalProjectionPatch = mergeProjectionPatches(projectionPatches)
    liveTaskBudgetRuntime = reconcileTerminalTaskBudgetRuntime(
      liveTaskBudgetRuntime,
      finalProjectionPatch,
      usedTools.length
    )
    runMetaBudgetRuntime = liveTaskBudgetRuntime
    throwIfAbortSignalAborted(abortSignal)
    if (dynamicDeliveryCandidatePending) {
      verifiedCandidateSnapshot = host.dynamicDelivery.inspectVerifiedCandidate(runId)
      if (
        verifiedCandidateSnapshot.acceptedText !== finalText
        || !hasCanonicalAssistantItem(verifiedCandidateSnapshot.acceptedDelta, finalText)
      ) {
        host.dynamicDelivery.abortVerifiedCandidate(runId)
        dynamicDeliveryCandidatePending = false
        throw new Error('[dynamic-delivery] verified candidate differs from canonical closeout text')
      }
    }
    let finalizedDone
    try {
      finalizedDone = await finalizeRunOutcome(
        {
          kind: 'done',
          runId,
          taskId,
          scopeId: sessionId || null,
          durationMs: Math.max(1, Date.now() - runStartedAt),
          toolCallsUsed: usedTools.length,
          initiator: runHandle.abortInitiator || 'done',
          projectionPatch: finalProjectionPatch,
          finalText,
          taskBudgetRuntime: liveTaskBudgetRuntime,
          providerDiagnostics: runMetaProviderDiagnostics,
          usage: runMetaUsage,
          workflowCloseoutSeal,
          workflowVerifierAcceptance,
        },
        {
          runMetaRepository: host.getRunMetaRepositoryForFinalize(),
          taskProjectionStore: host.runtime?.getTaskProjectionStoreForFinalize?.() ?? null,
          learnFromCheckIn: (input) => host.learnSiteCardsFromCheckIn(input),
          commitCanonicalCoreCloseout: host.runtime
            ? (input) => host.runtime!.commitCanonicalCoreCloseout(input)
            : undefined,
          writeProjectionTerminalPatch: (projectionPatch, terminalReason, status, canonicalReceipt) => {
            deferredTerminalProjection = {
              projectionPatch,
              terminalReason,
              status,
              canonicalReceipt,
            }
          },
          writeRunCloseMetric
        }
      )
    } catch (error) {
      if (dynamicDeliveryCandidatePending) host.dynamicDelivery.abortVerifiedCandidate(runId)
      throw error
    }
    if (dynamicDeliveryCandidatePending) {
      if (finalizedDone.status === 'done') {
        try {
          const committedCandidate = await host.dynamicDelivery.commitVerifiedCandidate(runId, {
            deliveryStateAlreadyPersisted: true,
          })
          if (committedCandidate.acceptedText !== finalizedDone.canonicalMessage?.content) {
            log('[dynamic-delivery] post-commit candidate text mismatch; canonical database message retained')
          }
        } catch (error) {
          // Core truth is already committed.  A derived in-memory session
          // failure must be repaired from the accepted snapshot below, never
          // reinterpret the run as failed or emit a second terminal answer.
          log(`[dynamic-delivery] post-commit candidate merge failed; rebuilding from canonical truth: ${errorMessage(error)}`)
        }
      } else {
        host.dynamicDelivery.abortVerifiedCandidate(runId)
      }
      dynamicDeliveryCandidatePending = false
    }
    if (finalizedDone.canonicalMessage) {
      finalText = finalizedDone.canonicalMessage.content
      let acceptedTruthItems = verifiedCandidateSnapshot
        ? [
            ...verifiedCandidateSnapshot.committedBase,
            ...verifiedCandidateSnapshot.acceptedDelta,
          ]
        : await committedOwnerSession.getItems()
      acceptedTruthItems = withoutBrowserVerifierRecoveryItems(acceptedTruthItems)
      if (!hasCanonicalAssistantItem(acceptedTruthItems, finalText)) {
        acceptedTruthItems = [
          ...acceptedTruthItems,
          canonicalAssistantSessionItem(finalText),
        ]
      }
      try {
        const publicItems = await committedPublicSession.getItems()
        const publicPrefix = acceptedTruthItems.slice(0, publicItems.length)
        if (JSON.stringify(publicPrefix) !== JSON.stringify(publicItems)) {
          throw new Error('accepted_owner_session_public_prefix_mismatch')
        }
        const acceptedDelta = acceptedTruthItems.slice(publicItems.length)
        if (acceptedDelta.length > 0) await committedPublicSession.addItems(acceptedDelta)
        runHandle.capturedSession = committedPublicSession
      } catch (mergeError) {
        log(`canonical session merge failed after core commit: ${errorMessage(mergeError)}`)
        const repairedSession = new MemorySession({
          sessionId: `${name}:canonical:${runId}`,
          initialItems: acceptedTruthItems,
        })
        runHandle.capturedSession = repairedSession
        const liveSession = host.sessionManager.get(name)
        if (liveSession?.currentRun?.runId === runId) liveSession.sdkSession = repairedSession
      }
      deliveryRealEmitOutput(finalText, 'text')
    }
    const deferred = deferredTerminalProjection as {
      projectionPatch: Record<string, unknown> | null
      terminalReason: string
      status: string
      canonicalReceipt?: CanonicalAssistantMessageReceipt
    } | null
    if (deferred) {
      emitOutputForRun('', 'done', deferred.projectionPatch, deferred.canonicalReceipt)
      emitStatusForRun(
        deferred.status,
        deferred.terminalReason as TurnTerminalReason,
      )
    }
    const finalizedTerminalReason = finalizedDone.terminalReason as TurnTerminalReason
    runMetaContinuationRef = null
    // S5-1: persist the scope session snapshot at clean run close so a
    // main-process restart can lazily restore the conversation instead of
    // silently forgetting it. Failure is loud (log), never blocking.
    if (finalizedDone.canonicalMessage) {
      try {
        const snapshotItems = normalizeSessionSnapshotForSeed(
          await runHandle.capturedSession.getItems()
        )
        const messageVisibilityEpoch = toolBridgeRuntimeContext.messageVisibilityEpoch
        if (!Number.isSafeInteger(messageVisibilityEpoch) || Number(messageVisibilityEpoch) < 0) {
          throw new Error('scope_session_snapshot_message_visibility_epoch_missing')
        }
        const written = writeScopeSessionSnapshot(
          name,
          snapshotItems,
          Number(messageVisibilityEpoch),
        )
        if (!written.ok) log(`scope session snapshot write failed: ${written.error}`)
      } catch (snapshotError) {
        log(`scope session snapshot write failed: ${errorMessage(snapshotError)}`)
      }
    }
    return buildResult({
      success: finalizedDone.status !== 'error',
      finalText,
      cancelled: false,
      taskId,
      usedTools,
      transcriptEvents,
      projectionPatches,
      terminalReason: finalizedTerminalReason,
      taskBudgetRuntime: liveTaskBudgetRuntime,
      providerDiagnostics: runMetaProviderDiagnostics,
      usage: runMetaUsage,
      canonicalMessage: finalizedDone.canonicalMessage,
      canonicalMessageDigest: finalizedDone.canonicalMessageDigest,
    })
  } finally {
    Object.assign(state, {
      finalText,
      hasSuccessfulDocumentTargetMutation,
      hasSuccessfulLocalDocumentSourceRead,
      lastDocumentSaveFailure,
      lastDocumentSaveSuccessText,
      liveTaskBudgetRuntime,
      newDocumentNeedsSave,
      runMetaBudgetRuntime,
      runMetaContinuationRef,
      runMetaProviderDiagnostics,
      runMetaUsage
    })
  }
}
