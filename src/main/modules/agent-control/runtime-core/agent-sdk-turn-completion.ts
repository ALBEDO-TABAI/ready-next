import type { ModelProvider } from '@openai/agents'
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
import { finalizeRunOutcome, writeRunCloseMetric } from './run-finalizer'
import type { TurnTerminalReason } from './turn-frame'
import type { CollaborationDecision } from '../../../../shared/dynamic-delivery'
import { mergeRunUsage } from './run-usage-accumulator'
import { materializeDeliveryArtifacts } from './dynamic-delivery/delivery-artifact-readback'

export interface AgentSdkTurnCompletionState {
  finalText: string
  hasSuccessfulDocumentTargetMutation: boolean
  hasSuccessfulLocalDocumentSourceRead: boolean
  lastDocumentSaveFailure: string | null
  lastDocumentSaveSuccessText: string | null
  liveTaskBudgetRuntime: TaskBudgetRuntime | null
  newDocumentNeedsSave: boolean
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
    projectionPatch?: Record<string, unknown> | null
  ) => void
  emitStatusForRun: (status: string, terminalReason?: TurnTerminalReason | null) => void
  finishBudgetCheckpointIfNeeded: () => Promise<ExecutionTurnResult | null>
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
    runMetaProviderDiagnostics,
    runMetaUsage
  } = state
  try {
    throwIfAbortSignalAborted(abortSignal)
    if (useTextToolBridge && !finalText && usedTools.length > 0) {
      finalText = '工具已执行，但模型尚未给出最终回复。'
      emitOutput(finalText, 'text')
    }
    if (requiresLocalDocumentExcerpt && !hasSuccessfulLocalDocumentSourceRead) {
      const message = '还没有读取指定文档正文，不能声明完成。'
      emitOutput(message, 'error')
      return finalizeEarlyReturn({
        status: 'error',
        terminalReason: 'blocked_tool_error',
        error: message,
        finalText
      })
    }
    if (documentTargetGuard && finalTextIndicatesIncompleteDocument(finalText)) {
      const message = `目标文档 ${documentTargetGuard.targetName} 仍未补完，不能声明完成。`
      emitOutput(message, 'error')
      return finalizeEarlyReturn({
        status: 'error',
        terminalReason: 'blocked_tool_error',
        error: message,
        finalText
      })
    }
    if (documentTargetGuard) {
      const contentIssue = await inspectDocumentTargetContent(documentTargetGuard, {
        forbidFutureLeakage: requiresLocalDocumentExcerpt
      })
      if (contentIssue) {
        const message = `目标文档 ${documentTargetGuard.targetName} 内容未通过检查：${contentIssue}`
        emitOutput(message, 'error')
        return finalizeEarlyReturn({
          status: 'error',
          terminalReason: 'blocked_tool_error',
          error: message,
          finalText
        })
      }
    }
    if (documentTargetGuard && !hasSuccessfulDocumentTargetMutation) {
      const message = `目标文档 ${documentTargetGuard.targetName} 尚未实际写入，不能声明完成。`
      emitOutput(message, 'error')
      return finalizeEarlyReturn({
        status: 'error',
        terminalReason: 'blocked_tool_error',
        error: message,
        finalText
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
        emitOutput(message, 'error')
        return finalizeEarlyReturn({
          status: 'error',
          terminalReason: 'blocked_tool_error',
          error: message,
          finalText
        })
      }
      const observedTarget = observedDocumentMutationTarget as ObservedDocumentToolTarget | null
      if (observedDocumentMutationMissingTarget || !observedTarget) {
        const message = '文档已经发生修改，但工具没有回传明确的文档身份，不能自动保存或声明完成。'
        emitOutput(message, 'error')
        return finalizeEarlyReturn({
          status: 'error',
          terminalReason: 'blocked_tool_error',
          error: message,
          finalText
        })
      }
      if (!observedTarget.path && observedTarget.requiresSave) {
        const message = `文档 ${observedTarget.title} 还没有保存路径，不能在后台自动保存。请先指定保存位置。`
        emitOutput(message, 'error')
        return finalizeEarlyReturn({
          status: 'error',
          terminalReason: 'blocked_tool_error',
          error: message,
          finalText
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
      emitOutput(message, 'error')
      return finalizeEarlyReturn({
        status: 'error',
        terminalReason: 'persistence_failed',
        error: message,
        finalText
      })
    }
    if (newDocumentNeedsSave) {
      const message = '新文档已经修改但尚未保存，不能声明完成。'
      emitOutput(message, 'error')
      return finalizeEarlyReturn({
        status: 'error',
        terminalReason: 'persistence_failed',
        error: message,
        finalText
      })
    }
    if (!finalText.trim() && usedTools.length > 0) {
      finalText = lastDocumentSaveSuccessText
        ? `已完成，${lastDocumentSaveSuccessText}`
        : '工具已执行完成。'
      emitOutput(finalText, 'text')
    }
    if (deliveryDecision !== 'single_path') {
      const store = host.runtime?.getTaskProjectionStoreForFinalize?.() ?? null
      const projectionAfterOwner = store?.get(taskId) ?? null
      if (!projectionAfterOwner) {
        const message = '协作交付状态不可用，已阻止未经复核的结果。'
        deliveryRealEmitOutput(message, 'error')
        return finalizeEarlyReturn({
          status: 'error',
          terminalReason: 'blocked_tool_error',
          error: message,
          finalText: ''
        })
      }
      const verification = await host.dynamicDelivery.verifyOwnerCandidate({
        runId,
        candidateText: finalText,
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
        materializeAndReadBack: async () => materializeDeliveryArtifacts({
          proofRefs: projectionAfterOwner.proofRefs,
          recentArtifacts: projectionAfterOwner.recentArtifacts,
          expectedOutputs: projectionAfterOwner.expectedOutputs,
          userRequestVerbatim: String(toolBridgeRuntimeContext.currentUserText || ''),
          requestEnvelope: toolBridgeRuntimeContext.requestEnvelope,
          currentRunId: runId,
          runStartedAtMs: runStartedAt,
        }),
      })
      runMetaUsage = mergeRunUsage(runMetaUsage as never, verification.verificationUsage) as ReadyAgentSdkRunResult['usage']
      if (verification.verdict.verdict !== 'accept' || verification.acceptedText === null) {
        const message = verification.verdict.verdict === 'repair'
          ? '独立复核发现仍需修正的缺口，本轮未发布候选结果。'
          : '独立复核未通过，本轮未发布候选结果。'
        deliveryRealEmitOutput(message, 'error')
        return finalizeEarlyReturn({
          status: 'error',
          terminalReason: 'blocked_tool_error',
          error: message,
          finalText: ''
        })
      }
      finalText = verification.acceptedText
      deliveryRealEmitOutput(finalText, 'text')
    }
    {
      const checkpointResult = await finishBudgetCheckpointIfNeeded()
      if (checkpointResult) return checkpointResult
    }
    if (usedTools.length === 0) {
      projectionPatches.push({ taskType: 'direct_answer', module: 'system' })
    }
    const finalProjectionPatch = mergeProjectionPatches(projectionPatches)
    throwIfAbortSignalAborted(abortSignal)
    const finalizedDone = await finalizeRunOutcome(
      {
        kind: 'done',
        runId,
        taskId,
        scopeId: sessionId || null,
        durationMs: Math.max(1, Date.now() - runStartedAt),
        toolCallsUsed: usedTools.length,
        initiator: runHandle.abortInitiator || 'done',
        projectionPatch: finalProjectionPatch,
        // EP2-Q3: the SAME variable emitted to the user above — including
        // the empty-reply default-text branch that just ran.
        finalText,
        taskBudgetRuntime: liveTaskBudgetRuntime,
        providerDiagnostics: runMetaProviderDiagnostics,
        usage: runMetaUsage
      },
      {
        runMetaRepository: host.getRunMetaRepositoryForFinalize(),
        taskProjectionStore: host.runtime?.getTaskProjectionStoreForFinalize?.() ?? null,
        learnFromCheckIn: (input) => host.learnSiteCardsFromCheckIn(input),
        writeProjectionTerminalPatch: (projectionPatch, terminalReason, status) => {
          emitOutputForRun('', 'done', projectionPatch)
          emitStatusForRun(status, terminalReason as TurnTerminalReason)
        },
        writeRunCloseMetric
      }
    )
    const finalizedTerminalReason = finalizedDone.terminalReason as TurnTerminalReason
    // S5-1: persist the scope session snapshot at clean run close so a
    // main-process restart can lazily restore the conversation instead of
    // silently forgetting it. Failure is loud (log), never blocking.
    try {
      const snapshotItems = normalizeSessionSnapshotForSeed(
        await runHandle.capturedSession.getItems()
      )
      const written = writeScopeSessionSnapshot(name, snapshotItems)
      if (!written.ok) log(`scope session snapshot write failed: ${written.error}`)
    } catch (snapshotError) {
      log(`scope session snapshot write failed: ${errorMessage(snapshotError)}`)
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
      usage: runMetaUsage
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
      runMetaProviderDiagnostics,
      runMetaUsage
    })
  }
}
