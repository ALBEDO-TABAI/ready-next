import type { ModelProvider } from '@openai/agents'
import { classifyFollowupIntent } from '../../../../shared/agent-followup-intent'
import { resolveAIConfigCapabilities } from '../../../../shared/ai-providers'
import { buildAgentSpawnContextFromAIConfig } from '../../skills-runtime/agent-context-source'
import { appendToolCapabilityLog } from '../../tools/tool-event-log'
import type {
  ExecutionTurnResult,
  RunMessage,
  TaskBudgetRuntime,
  TurnTranscriptEvent
} from '../contracts/run-contracts'
import { computeCapabilityFloors } from '../domain-adapters/capability-floors'
import { logAgentMetric } from '../metrics'
import {
  collectToolOutputProofs,
  createTaskProofSink,
  isSuccessfulToolOutput,
} from '../quality/proof-collector'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import { consumeToolCallBudget } from '../task-projection/run-budget-policy'
import { prependSystemReminderInput } from '../system-reminders/background-task-terminal-reminder'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import { normalizeToolExecutionOutput } from '../tools-runtime/tool-result-types'
import { applyContextModifier, createEmptyActiveFrameContext } from '../tools-runtime/tool-runtime'
import {
  DOCUMENT_TARGET_MUTATION_TOOL_NAMES,
  documentSaveSucceeded,
  documentToolMutatedContent,
  isDocumentToolFailure,
  isSameObservedDocumentTarget,
  readDocumentToolTarget
} from './agent-sdk-document-utils'
import {
  resolveAgentSdkTaskBudgetRuntime,
  resolveSourceMessageProvenance,
  resolveTaskTypeFromBrowserWorkflowText,
  resolveTaskTypeFromToolDefinitions
} from './agent-sdk-foundation-utils'
import { messageToText } from './agent-sdk-input-context-utils'
import { readStructuredResultRecord } from './agent-sdk-provider-utils'
import {
  buildTerminalFailureProjectionPatch,
  extractLongSkillCheckpoint,
  readTextField
} from './agent-sdk-runtime-outcome-utils'
import {
  resolveSkillHintRelevanceForTurn,
  skillContextMessagesToInstruction
} from './agent-sdk-skill-intent-utils'
import { buildExecutionTurnResult } from './agent-sdk-turn-closeout'
import { finalizeAgentSdkPreparedTurnResult } from './agent-sdk-turn-completion'
import type { TurnOrchestratorHost } from './agent-sdk-turn-context'
import { armDynamicDeliveryDeadline } from './dynamic-delivery/delivery-deadline'
import { createAgentSdkTurnGuards } from './agent-sdk-turn-guards'
import { assembleAgentSdkTurnInput } from './agent-sdk-turn-input-assembly'
import type { AgentSdkPreparedTurnContext } from './agent-sdk-turn-execution-types'
import { executeAgentSdkModelToolLoop } from './agent-sdk-turn-model-loop'
import type {
  AgentSdkBudgetCheckpointRestore,
  AgentSdkExecutionOptions,
  AgentSdkProviderDiagnostics,
  AgentSdkSession,
  DocumentTargetGuard,
  ObservedDocumentToolTarget,
  ReadyAgentSdkRunResult,
  RunHandle,
  SdkLongSkillCheckpoint,
  ToolBridgeRuntimeContext
} from './agent-sdk-types'
import type { TurnTerminalReason } from './turn-frame'
import { mergeRunUsage } from './run-usage-accumulator'
import { installSameRunSkillActivation } from './same-run-skill-activation'

const LOCAL_DOCUMENT_SOURCE_READ_TOOL_NAMES = new Set([
  'file_read_excerpt',
  'document_read_section'
])

function isLocalDocumentSourceReadFailureText(text: string): boolean {
  const normalized = String(text || '').trim()
  if (!normalized) return false
  return (
    /^(?:Error:|Document action failed:)/i.test(normalized) ||
    /(?:ok["']?\s*:\s*false|未找到章节|没有可读取|无法读取|读取失败|不在当前工作区|工作区索引|not in index|outside any known workspace|path_missing|not found|找不到|未找到)/i.test(
      normalized
    )
  )
}

function buildFileReadExcerptCheckpoint(
  output: ReturnType<typeof normalizeToolExecutionOutput>
): string | null {
  const normalized = normalizeToolExecutionOutput(output)
  const data = readStructuredResultRecord(normalized)
  if (data.ok === false) return null
  const content = readTextField(data, 'content')
  if (!content) return null
  const path = readTextField(data, 'path')
  const excerpt = content.length > 1600 ? `${content.slice(0, 1600).trimEnd()}...` : content
  return [
    '我已经读到相关文件，但模型在工具轮次内没有收口；先把已读到的关键片段给你，避免变成发送失败。',
    path ? `文件：${path}` : '',
    '',
    excerpt
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export type { AgentSdkPreparedTurnContext, AgentSdkPreparedTurnState } from './agent-sdk-turn-execution-types'

export async function executeAgentSdkPreparedTurn(
  ctx: AgentSdkPreparedTurnContext
): Promise<ExecutionTurnResult> {
  const {
    host,
    name,
    runId,
    taskId,
    sessionId,
    runStartedAt,
    content,
    pureUserTurnText,
    effectiveExecutionOptions,
    checkpointRestore,
    checkpointRequiredCapabilityGroups,
    checkpointRequiredToolNames,
    skillHintRelevanceForTurn,
    turnCapabilityFloors,
    toolDefinitions,
    abortController,
    runHandle,
    session,
    isCurrentRun,
    toolArgsByName,
    transcriptEvents,
    usedTools,
    projectionPatches,
    emitOutputForRun,
    emitOutput: realEmitOutput,
    emitHeartbeat,
    emitStatusForRun,
    finalizeEarlyReturn: finalizeEarlyReturnFromContext,
    finalizeBudgetCheckpointReturn: finalizeBudgetCheckpointReturnFromContext,
    buildResult,
    recentCollectionIntent,
    turnFollowup,
    useTextToolBridge,
    documentTargetGuard,
    requiresLocalDocumentExcerpt,
    preferCurrentDocumentRead,
    requiresLocalDocumentWrite,
    providerContent,
    capabilities,
    authorization,
    contextWindowTokens,
    maxOutputTokens,
    agentContext,
    provider,
    model,
    nativeTextToolBoundaryFlush,
    activeFrame
  } = ctx
  let emitOutput = realEmitOutput
  let {
    actionAnnouncementSteered,
    criteriaSelfCheckInjected,
    fileReadExcerptCheckpointForRecovery,
    finalText,
    hasSuccessfulDocumentTargetMutation,
    hasSuccessfulLocalDocumentSourceReadForRecovery,
    hasSuccessfulToolProgress,
    lastDocumentSaveSuccessText,
    lastRollingCheckpointToolCalls,
    longSkillCheckpoint,
    observedDocumentMutationConflict,
    observedDocumentMutationMissingTarget,
    observedDocumentMutationTarget,
    runMetaBudgetRuntime,
    runMetaContinuationRef,
    runMetaProviderDiagnostics,
    runMetaUsage,
    sessionRestoreNotice,
    skillClarificationSteered
  } = ctx.state
  const syncState = () => {
    Object.assign(ctx.state, {
      actionAnnouncementSteered,
      criteriaSelfCheckInjected,
      fileReadExcerptCheckpointForRecovery,
      finalText,
      hasSuccessfulDocumentTargetMutation,
      hasSuccessfulLocalDocumentSourceReadForRecovery,
      hasSuccessfulToolProgress,
      lastDocumentSaveSuccessText,
      lastRollingCheckpointToolCalls,
      longSkillCheckpoint,
      observedDocumentMutationConflict,
      observedDocumentMutationMissingTarget,
      observedDocumentMutationTarget,
      runMetaBudgetRuntime,
      runMetaContinuationRef,
      runMetaProviderDiagnostics,
      runMetaUsage,
      sessionRestoreNotice,
      skillClarificationSteered
    })
  }
  const syncLocalState = () => {
    ;({
      actionAnnouncementSteered,
      criteriaSelfCheckInjected,
      fileReadExcerptCheckpointForRecovery,
      finalText,
      hasSuccessfulDocumentTargetMutation,
      hasSuccessfulLocalDocumentSourceReadForRecovery,
      hasSuccessfulToolProgress,
      lastDocumentSaveSuccessText,
      lastRollingCheckpointToolCalls,
      longSkillCheckpoint,
      observedDocumentMutationConflict,
      observedDocumentMutationMissingTarget,
      observedDocumentMutationTarget,
      runMetaBudgetRuntime,
      runMetaContinuationRef,
      runMetaProviderDiagnostics,
      runMetaUsage,
      sessionRestoreNotice,
      skillClarificationSteered
    } = ctx.state)
  }
  const finalizeEarlyReturn: typeof finalizeEarlyReturnFromContext = async (params) => {
    syncState()
    const result = await finalizeEarlyReturnFromContext(params)
    syncLocalState()
    return result
  }
  const finalizeBudgetCheckpointReturn: typeof finalizeBudgetCheckpointReturnFromContext = (
    checkpointText
  ) => {
    syncState()
    return finalizeBudgetCheckpointReturnFromContext(checkpointText).then((result) => {
      syncLocalState()
      return result
    })
  }
  const deliveryMode = effectiveExecutionOptions?.deliveryMode ?? 'adaptive'
  const deliveryDeadline = armDynamicDeliveryDeadline({
    mode: deliveryMode,
    runId,
    abortController,
    runHandle,
    startedAtMs: runStartedAt,
  })
  const emitOutputBeforeProgressTracking = emitOutput
  emitOutput = (chunk, type, projectionPatch) => {
    if (type === 'text' && chunk.trim()) deliveryDeadline.noteProgress('text_delta')
    emitOutputBeforeProgressTracking(chunk, type, projectionPatch)
  }
  try {
    const latentSkillToolDefinitions = host.toolExecutor.listLatentSkillToolDefinitions()
      .filter((definition) => !toolDefinitions.some((visible) => visible.name === definition.name))
    const hasVeaPipelineTool = toolDefinitions.some(
      (definition) => definition.name === 'skill_video_expert_pipeline'
    )
    const hasMapAmbiguityQuestionTools = toolDefinitions.some(
      (definition) => definition.name === 'map_plan_route'
    )
    const hasBrowserTools = toolDefinitions.some((definition) =>
      definition.name.startsWith('browser_')
    )
    const hasBrowserVisibleCollectTool = toolDefinitions.some(
      (definition) => definition.name === 'browser_visible_collect'
    )
    const hasBrowserPowerTools = toolDefinitions.some((definition) =>
      definition.name.startsWith('browser_power_')
    )
    const allowedToolNames = toolDefinitions.map((definition) => definition.name)
    appendToolCapabilityLog(
      [
        '[tool_capability]',
        'stage=sdk_runtime_final_tools',
        `restore=${checkpointRestore ? 'true' : 'false'}`,
        `toolCount=${allowedToolNames.length}`,
        `tools=${allowedToolNames.join('|') || 'none'}`,
        `skillHintRelevant=${skillHintRelevanceForTurn.relevant}:${skillHintRelevanceForTurn.reason}`,
        `floors=${turnCapabilityFloors.reasons.join(',') || 'none'}`
      ].join(' ')
    )
    const definitionByName = new Map([...toolDefinitions, ...latentSkillToolDefinitions]
      .map((definition) => [definition.name, definition] as const))
    const requiredCapabilityGroups = Array.from(
      new Set(toolDefinitions.map((definition) => definition.groupId))
    )
    checkpointRequiredCapabilityGroups.splice(
      0,
      checkpointRequiredCapabilityGroups.length,
      ...requiredCapabilityGroups
    )
    checkpointRequiredToolNames.splice(0, checkpointRequiredToolNames.length, ...allowedToolNames)
    const taskProofStore = host.runtime?.getTaskProjectionStoreForFinalize?.() ?? null
    const taskProofSink = taskProofStore ? createTaskProofSink(taskProofStore) : null
    const inferredSdkTaskType =
      resolveTaskTypeFromBrowserWorkflowText(pureUserTurnText) ||
      resolveTaskTypeFromToolDefinitions(toolDefinitions)
    let liveTaskBudgetRuntime = resolveAgentSdkTaskBudgetRuntime({
      options: effectiveExecutionOptions,
      inferredTaskType: inferredSdkTaskType
    })
    runMetaBudgetRuntime = liveTaskBudgetRuntime
    let lastDocumentSaveFailure: string | null = null
    let newDocumentNeedsSave = false
    let hasSuccessfulLocalDocumentSourceRead = false
    const sourceMessageProvenance = resolveSourceMessageProvenance({
      sourceMessageId: effectiveExecutionOptions?.sourceMessageId,
      requestEnvelope: effectiveExecutionOptions?.requestEnvelope
    })
    const preparedDelivery = await host.dynamicDelivery.prepareOwnerInput({
      mode: deliveryMode,
      runId,
      taskId,
      scopeId: sessionId ?? null,
      userRequestVerbatim: pureUserTurnText,
      requestEnvelope: effectiveExecutionOptions?.requestEnvelope,
      intentClassification: effectiveExecutionOptions?.intentClassification,
      inferredTaskType: liveTaskBudgetRuntime?.taskType ?? inferredSdkTaskType ?? 'short_task',
      liveBudget: liveTaskBudgetRuntime,
      ownerBinding: effectiveExecutionOptions?.executionBinding ?? null,
      ownerProfile: effectiveExecutionOptions?.executionProfile ?? null,
      committedSession: runHandle.capturedSession,
      model,
      provider,
      contextWindowTokens,
      maxOutputTokens,
      signal: abortController.signal,
    })
    const ownerModelSession = preparedDelivery.ownerSession
    const deliveryDecision = preparedDelivery.decision
    const deliveryReminder = preparedDelivery.ownerReminder
    if (preparedDelivery.usage) {
      runMetaUsage = mergeRunUsage(runMetaUsage as never, preparedDelivery.usage) as ReadyAgentSdkRunResult['usage']
    }
    if (preparedDelivery.emitOutput) {
      const buffer = preparedDelivery.emitOutput
      emitOutput = (chunk, type, projectionPatch) => {
        if (type === 'text') {
          if (chunk.trim()) deliveryDeadline.noteProgress('text_delta')
          buffer.append(chunk)
          return
        }
        realEmitOutput(chunk, type, projectionPatch)
      }
    }
    const toolBridgeRuntimeContext: ToolBridgeRuntimeContext = {
      agentName: name,
      runId,
      taskId,
      sessionId,
      executionBinding: effectiveExecutionOptions?.executionBinding ?? null,
      executionProfile: effectiveExecutionOptions?.executionProfile ?? null,
      currentUserText: pureUserTurnText,
      sourceMessageId: sourceMessageProvenance.sourceMessageId,
      sourceMessageUnavailableReason: sourceMessageProvenance.sourceMessageUnavailableReason,
      requestEnvelope: effectiveExecutionOptions?.requestEnvelope,
      signal: abortController.signal,
      allowedToolNames,
      definitionByName,
      authorization,
      sameRunActivatedSkillId: null,
      useTextToolBridge,
      activeFrame,
      documentTargetGuard,
      emitOutput,
      emitToolAction: (toolName, args) => {
        if (!isCurrentRun()) return
        const queue = toolArgsByName.get(toolName) ?? []
        queue.push(args)
        toolArgsByName.set(toolName, queue)
        transcriptEvents.push({ kind: 'tool_action', tool: toolName, args })
        host.emit('toolAction', { agent: name, sessionId, runId, tool: toolName, args })
      },
      recordToolResult: (toolName, output) => {
        usedTools.push(toolName)
        // A real tool result pays off the steer; later action promises are fresh.
        if (actionAnnouncementSteered) {
          actionAnnouncementSteered = false
        }
        if (toolBridgeRuntimeContext.taskBudgetRuntime) {
          const previousWarning = toolBridgeRuntimeContext.taskBudgetRuntime.warningLevel
          const nextRuntime = consumeToolCallBudget(toolBridgeRuntimeContext.taskBudgetRuntime)
          toolBridgeRuntimeContext.taskBudgetRuntime = nextRuntime
          liveTaskBudgetRuntime = nextRuntime
          runMetaBudgetRuntime = nextRuntime
          const nextWarning = nextRuntime.warningLevel
          if (
            nextWarning !== 'none' &&
            nextWarning !== previousWarning &&
            !toolBridgeRuntimeContext.budgetWarningMessages.includes(nextWarning)
          ) {
            toolBridgeRuntimeContext.budgetWarningMessages.push(nextWarning)
            projectionPatches.push({
              budgetWarningLevel: nextWarning
            })
          }
        }
        const normalized = normalizeToolExecutionOutput(output)
        if (taskProofSink) {
          try {
            const proofs = collectToolOutputProofs(toolName, normalized, new Date(), { runId })
            taskProofSink.append(taskId, proofs)
          } catch (error) {
            logAgentMetric('proof_collect_failed', {
              taskId,
              toolName,
              reason: error instanceof Error ? error.message : String(error)
            })
          }
        }
        const argsQueue = toolArgsByName.get(toolName)
        host.learnSiteCardFromToolFailure(toolName, argsQueue?.shift(), normalized)
        const structuredData = readStructuredResultRecord(normalized)
        const documentToolFailed = isDocumentToolFailure(normalized)
        const sourceReadFailed =
          LOCAL_DOCUMENT_SOURCE_READ_TOOL_NAMES.has(toolName) &&
          isLocalDocumentSourceReadFailureText(normalized.text)
        const structuredStatus =
          typeof structuredData.status === 'string'
            ? structuredData.status.trim().toLowerCase()
            : ''
        const toolReportedFailure =
          !isSuccessfulToolOutput(normalized) ||
          documentToolFailed ||
          structuredData.ok === false ||
          typeof structuredData.errorKind === 'string' ||
          structuredStatus === 'error' ||
          structuredStatus === 'failed' ||
          sourceReadFailed
        if (!toolReportedFailure) {
          hasSuccessfulToolProgress = true
          deliveryDeadline.noteProgress('tool_result')
        }
        if (LOCAL_DOCUMENT_SOURCE_READ_TOOL_NAMES.has(toolName) && !toolReportedFailure) {
          hasSuccessfulLocalDocumentSourceRead = true
          hasSuccessfulLocalDocumentSourceReadForRecovery = true
        }
        const documentToolChangedContent =
          DOCUMENT_TARGET_MUTATION_TOOL_NAMES.has(toolName) &&
          !documentToolFailed &&
          documentToolMutatedContent(normalized)
        if (documentToolChangedContent) {
          hasSuccessfulDocumentTargetMutation = true
          const documentTarget = readDocumentToolTarget(normalized)
          if (documentTarget) {
            if (!observedDocumentMutationTarget) {
              observedDocumentMutationTarget = documentTarget
            } else if (
              isSameObservedDocumentTarget(observedDocumentMutationTarget, documentTarget)
            ) {
              observedDocumentMutationTarget = documentTarget
            } else {
              observedDocumentMutationConflict = true
            }
          } else {
            observedDocumentMutationMissingTarget = true
          }
        }
        if (documentToolChangedContent && usedTools.includes('document_new_tab')) {
          newDocumentNeedsSave = true
        }
        if (toolName === 'document_save_tab') {
          lastDocumentSaveFailure = documentToolFailed
            ? normalized.text || 'document_save_tab failed'
            : null
          if (!documentToolFailed && documentSaveSucceeded(normalized)) {
            lastDocumentSaveSuccessText = normalized.text
            newDocumentNeedsSave = false
            const savedDocumentTarget = readDocumentToolTarget(normalized)
            if (
              savedDocumentTarget &&
              observedDocumentMutationTarget &&
              isSameObservedDocumentTarget(observedDocumentMutationTarget, savedDocumentTarget)
            ) {
              observedDocumentMutationTarget = savedDocumentTarget
            }
          }
        }
        if (toolName === 'file_read_excerpt' && !toolReportedFailure) {
          fileReadExcerptCheckpointForRecovery = buildFileReadExcerptCheckpoint(normalized)
        }
        applyContextModifier(toolBridgeRuntimeContext, normalized)
        longSkillCheckpoint = extractLongSkillCheckpoint(toolName, normalized, longSkillCheckpoint)
        if (normalized.projectionPatch) {
          projectionPatches.push(normalized.projectionPatch)
        }
        if (toolReportedFailure) {
          projectionPatches.push(buildTerminalFailureProjectionPatch(toolName, structuredData))
        }
      },
      agentContext,
      runHandle,
      taskBudgetRuntime: liveTaskBudgetRuntime,
      budgetWarningMessages: []
    }
    installSameRunSkillActivation({
      runtimeContext: toolBridgeRuntimeContext,
      latentDefinitions: latentSkillToolDefinitions,
      resolveAuthorization: () => host.resolveSkillAuthorizationForTurn(
        content as RunMessage, sessionId, effectiveExecutionOptions?.requestEnvelope, false, true,
      ),
      allowedToolNames, definitionByName, requiredCapabilityGroups,
      checkpointRequiredCapabilityGroups, checkpointRequiredToolNames,
    })
    const skillContextMessages: Array<{
      role: string
      content: string | Array<Record<string, unknown>>
    }> = []
    if (host.skillContextOrchestrator?.maybeInjectExplicitSkillContext) {
      await host.skillContextOrchestrator.maybeInjectExplicitSkillContext({
        userText: messageToText(content as RunMessage),
        session: { messages: skillContextMessages },
        sessionId,
        emitOutput: () => undefined,
        emitToolAction: () => undefined,
        executeTool: async (toolName, args) =>
          host.executeToolCall(
            toolName,
            args,
            host.toolExecutor.buildExecutorContext(toolBridgeRuntimeContext)
          )
      })
    }
    const skillContextInstruction = skillContextMessagesToInstruction(skillContextMessages)
    const finishBudgetCheckpointIfNeeded = async (): Promise<ExecutionTurnResult | null> => {
      if (!liveTaskBudgetRuntime || liveTaskBudgetRuntime.warningLevel !== 'exhausted') return null
      const checkpoint = await host.runLifecycle.writeBudgetCheckpointState({
        agentName: name,
        sessionId,
        runId,
        taskId,
        taskBudgetRuntime: liveTaskBudgetRuntime,
        runHandle,
        usedTools,
        requiredCapabilityGroups,
        requiredToolNames: allowedToolNames,
        lastUserMessage: pureUserTurnText,
        resumeKind: 'paused',
        sessionSnapshotOverride: await host.dynamicDelivery.buildSanitizedCheckpoint(runId)
      })
      runMetaContinuationRef =
        checkpoint.projectionPatch.taskContinuation &&
        typeof checkpoint.projectionPatch.taskContinuation === 'object'
          ? (checkpoint.projectionPatch.taskContinuation as Record<string, unknown>)
          : null
      projectionPatches.push(checkpoint.projectionPatch)
      finalText = '本轮工具预算已用完，我已保存续跑检查点，可以继续。'
      emitOutput(finalText, 'text', checkpoint.projectionPatch)
      return finalizeEarlyReturn({
        status: 'checkpoint',
        terminalReason: 'checkpoint_budget',
        finalText,
        continuationHandle: checkpoint.runStatePath,
        taskBudgetRuntime: liveTaskBudgetRuntime,
        providerDiagnostics: runMetaProviderDiagnostics
      })
    }
    const { maybeHandleSkillClarificationGuard, maybeHandleActionAnnouncementGuard } =
      createAgentSdkTurnGuards({
        state: {
          get actionAnnouncementSteered() {
            return actionAnnouncementSteered
          },
          set actionAnnouncementSteered(value) {
            actionAnnouncementSteered = value
          },
          get finalText() {
            return finalText
          },
          set finalText(value) {
            finalText = value
          },
          get liveTaskBudgetRuntime() {
            return liveTaskBudgetRuntime
          },
          set liveTaskBudgetRuntime(value) {
            liveTaskBudgetRuntime = value
          },
          get newDocumentNeedsSave() {
            return newDocumentNeedsSave
          },
          set newDocumentNeedsSave(value) {
            newDocumentNeedsSave = value
          },
          get nextInput() {
            return nextInput
          },
          set nextInput(value) {
            nextInput = value
          },
          get runMetaBudgetRuntime() {
            return runMetaBudgetRuntime
          },
          set runMetaBudgetRuntime(value) {
            runMetaBudgetRuntime = value
          },
          get runMetaContinuationRef() {
            return runMetaContinuationRef
          },
          set runMetaContinuationRef(value) {
            runMetaContinuationRef = value
          },
          get runMetaUsage() {
            return runMetaUsage
          },
          set runMetaUsage(value) {
            runMetaUsage = value
          },
          get skillClarificationSteered() {
            return skillClarificationSteered
          },
          set skillClarificationSteered(value) {
            skillClarificationSteered = value
          }
        },
        host,
        name,
        runId,
        taskId,
        sessionId,
        runStartedAt,
        pureUserTurnText,
        effectiveExecutionOptions,
        checkpointRestore,
        skillHintRelevanceForTurn,
        turnFollowup,
        recentCollectionIntent,
        inferredSdkTaskType,
        allowedToolNames,
        requiredCapabilityGroups,
        runHandle,
        usedTools,
        projectionPatches,
        transcriptEvents,
        runMetaProviderDiagnostics,
        emitOutput,
        emitOutputForRun,
        emitStatusForRun,
        buildResult
      })
    const assembledInput = assembleAgentSdkTurnInput({
      host,
      session,
      sessionId,
      runId,
      providerContent,
      useTextToolBridge,
      toolDefinitions,
      latentSkillToolDefinitions,
      toolBridgeRuntimeContext,
      hasVeaPipelineTool,
      hasMapAmbiguityQuestionTools,
      hasBrowserTools,
      hasBrowserVisibleCollectTool,
      hasBrowserPowerTools,
      skillContextInstruction,
      documentTargetGuard,
      requiresLocalDocumentExcerpt,
      preferCurrentDocumentRead,
      capabilities,
      authorization,
      emitOutput,
      finalizeEarlyReturn
    })
    if (assembledInput.terminalResult) return await assembledInput.terminalResult
    const { sdkTools, instructions } = assembledInput
    let { nextInput } = assembledInput
    if (deliveryReminder) {
      nextInput = prependSystemReminderInput(nextInput, deliveryReminder)
    }
    const modelToolLoopResult = await executeAgentSdkModelToolLoop({
      state: {
        get criteriaSelfCheckInjected() {
          return criteriaSelfCheckInjected
        },
        set criteriaSelfCheckInjected(value) {
          criteriaSelfCheckInjected = value
        },
        get finalText() {
          return finalText
        },
        set finalText(value) {
          finalText = value
        },
        get hasSuccessfulDocumentTargetMutation() {
          return hasSuccessfulDocumentTargetMutation
        },
        set hasSuccessfulDocumentTargetMutation(value) {
          hasSuccessfulDocumentTargetMutation = value
        },
        get hasSuccessfulLocalDocumentSourceRead() {
          return hasSuccessfulLocalDocumentSourceRead
        },
        set hasSuccessfulLocalDocumentSourceRead(value) {
          hasSuccessfulLocalDocumentSourceRead = value
        },
        get lastDocumentSaveFailure() {
          return lastDocumentSaveFailure
        },
        set lastDocumentSaveFailure(value) {
          lastDocumentSaveFailure = value
        },
        get lastDocumentSaveSuccessText() {
          return lastDocumentSaveSuccessText
        },
        set lastDocumentSaveSuccessText(value) {
          lastDocumentSaveSuccessText = value
        },
        get lastRollingCheckpointToolCalls() {
          return lastRollingCheckpointToolCalls
        },
        set lastRollingCheckpointToolCalls(value) {
          lastRollingCheckpointToolCalls = value
        },
        get liveTaskBudgetRuntime() {
          return liveTaskBudgetRuntime
        },
        set liveTaskBudgetRuntime(value) {
          liveTaskBudgetRuntime = value
        },
        get newDocumentNeedsSave() {
          return newDocumentNeedsSave
        },
        set newDocumentNeedsSave(value) {
          newDocumentNeedsSave = value
        },
        get nextInput() {
          return nextInput
        },
        set nextInput(value) {
          nextInput = value
        },
        get runMetaBudgetRuntime() {
          return runMetaBudgetRuntime
        },
        set runMetaBudgetRuntime(value) {
          runMetaBudgetRuntime = value
        },
        get runMetaContinuationRef() {
          return runMetaContinuationRef
        },
        set runMetaContinuationRef(value) {
          runMetaContinuationRef = value
        },
        get runMetaUsage() {
          return runMetaUsage
        },
        set runMetaUsage(value) {
          runMetaUsage = value
        },
        get sessionRestoreNotice() {
          return sessionRestoreNotice
        },
        set sessionRestoreNotice(value) {
          sessionRestoreNotice = value
        }
      },
      host,
      name,
      runId,
      taskId,
      sessionId,
      pureUserTurnText,
      effectiveExecutionOptions,
      providerContent,
      useTextToolBridge,
      toolDefinitions,
      allowedToolNames,
      definitionByName,
      toolBridgeRuntimeContext,
      documentTargetGuard,
      requiresLocalDocumentExcerpt,
      preferCurrentDocumentRead,
      requiresLocalDocumentWrite,
      runHandle,
      modelSession: ownerModelSession,
      session,
      abortController,
      instructions,
      model,
      provider,
      sdkTools,
      contextWindowTokens,
      maxOutputTokens,
      inferredSdkTaskType,
      requiredCapabilityGroups,
      usedTools,
      emitOutput,
      emitHeartbeat,
      checkpointSnapshotProvider: () => host.dynamicDelivery.buildSanitizedCheckpoint(runId),
      nativeTextToolBoundaryFlush,
      finishBudgetCheckpointIfNeeded,
      maybeHandleSkillClarificationGuard,
      maybeHandleActionAnnouncementGuard,
      finalizeEarlyReturn
    })
    if (modelToolLoopResult) return modelToolLoopResult
    return await finalizeAgentSdkPreparedTurnResult({
      state: {
        get finalText() {
          return finalText
        },
        set finalText(value) {
          finalText = value
        },
        get hasSuccessfulDocumentTargetMutation() {
          return hasSuccessfulDocumentTargetMutation
        },
        set hasSuccessfulDocumentTargetMutation(value) {
          hasSuccessfulDocumentTargetMutation = value
        },
        get hasSuccessfulLocalDocumentSourceRead() {
          return hasSuccessfulLocalDocumentSourceRead
        },
        set hasSuccessfulLocalDocumentSourceRead(value) {
          hasSuccessfulLocalDocumentSourceRead = value
        },
        get lastDocumentSaveFailure() {
          return lastDocumentSaveFailure
        },
        set lastDocumentSaveFailure(value) {
          lastDocumentSaveFailure = value
        },
        get lastDocumentSaveSuccessText() {
          return lastDocumentSaveSuccessText
        },
        set lastDocumentSaveSuccessText(value) {
          lastDocumentSaveSuccessText = value
        },
        get liveTaskBudgetRuntime() {
          return liveTaskBudgetRuntime
        },
        set liveTaskBudgetRuntime(value) {
          liveTaskBudgetRuntime = value
        },
        get newDocumentNeedsSave() {
          return newDocumentNeedsSave
        },
        set newDocumentNeedsSave(value) {
          newDocumentNeedsSave = value
        },
        get runMetaProviderDiagnostics() {
          return runMetaProviderDiagnostics
        },
        set runMetaProviderDiagnostics(value) {
          runMetaProviderDiagnostics = value
        },
        get runMetaUsage() {
          return runMetaUsage
        },
        set runMetaUsage(value) {
          runMetaUsage = value
        }
      },
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
      deliveryRealEmitOutput: realEmitOutput,
      model,
      provider,
      contextWindowTokens,
      maxOutputTokens,
      abortSignal: abortController.signal,
      emitOutput,
      emitOutputForRun,
      emitStatusForRun,
      finishBudgetCheckpointIfNeeded,
      finalizeEarlyReturn,
      buildResult
    })
  } finally {
    deliveryDeadline.dispose()
    syncState()
  }
}
