import { type AgentInputItem, type ModelProvider } from '@openai/agents'
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
import { createTaskProofSink } from '../quality/proof-collector'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import { resolveSkillSurfaceComposition } from '../skills/skill-surface-composition'
import { buildPreparedSkillTurnTruth } from '../skills/prepared-skill-turn'
import { prependSystemReminderInput } from '../system-reminders/background-task-terminal-reminder'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import { createEmptyActiveFrameContext } from '../tools-runtime/tool-runtime'
import {
  resolveAgentSdkTaskBudgetRuntime,
  resolveSourceMessageProvenance,
} from './agent-sdk-foundation-utils'
import { messageToText, parseEnvelopeResourceReferences } from './agent-sdk-input-context-utils'
import {
  resolveSkillHintRelevanceForTurn,
  skillContextMessagesToInstruction
} from './agent-sdk-skill-intent-utils'
import { buildExecutionTurnResult } from './agent-sdk-turn-closeout'
import { finalizeAgentSdkPreparedTurnResult } from './agent-sdk-turn-completion'
import type { TurnOrchestratorHost } from './agent-sdk-turn-context'
import { armDynamicDeliveryDeadline, bindModelStreamLiveness } from './dynamic-delivery/delivery-deadline'
import { DeliveryOutputBuffer } from './dynamic-delivery/delivery-output-buffer'
import { buildSanitizedCheckpointFromSession } from './dynamic-delivery/candidate-session-fork'
import { createAgentSdkTurnGuards } from './agent-sdk-turn-guards'
import { assembleAgentSdkTurnInput } from './agent-sdk-turn-input-assembly'
import type { AgentSdkPreparedTurnContext } from './agent-sdk-turn-execution-types'
import { executeAgentSdkModelToolLoop } from './agent-sdk-turn-model-loop'
import { AgentSessionInputController } from './agent-session-input-controller'
import { browserSurfaceActiveForDefinitions, prepareBrowserWorkflowTurnState } from './agent-sdk-browser-turn-control'
import { createAgentSdkToolResultRecorder } from './agent-sdk-turn-tool-result-recorder'
import { ensureLongRunningTaskBudgetCapacity } from '../task-projection/run-budget-policy'
import { createBrowserSuspensionController } from './agent-sdk-browser-suspension'
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
import {
  activateBrowserCapabilityForCurrentRun,
  installSameRunSkillActivation,
} from './same-run-skill-activation'
import {
  isReadOnlyResearchSkillToolSet,
  resolveActiveSkillAllowedTools,
} from '../domain-adapters/run-capability-controller'

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
    skillCatalogSnapshot,
    skillHintRelevanceForTurn,
    turnCapabilityFloors,
    toolDefinitions,
    abortController,
    runHandle,
    committedPublicSession,
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
    requestedCapabilityConflicts,
    turnFollowup,
    useTextToolBridge,
    documentTargetGuard,
    requiresLocalDocumentExcerpt,
    preferCurrentDocumentRead,
    requiresLocalDocumentWrite,
    providerContent,
    capabilities,
    authorization,
    skillSurface,
    preparedSkillTurn,
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
    hasSuccessfulLocalDocumentSourceRead,
    hasSuccessfulLocalDocumentSourceReadForRecovery,
    hasSuccessfulToolProgress,
    lastDocumentSaveFailure,
    lastDocumentSaveSuccessText,
    lastRollingCheckpointToolCalls,
    longSkillCheckpoint,
    newDocumentNeedsSave,
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
      hasSuccessfulLocalDocumentSourceRead,
      hasSuccessfulLocalDocumentSourceReadForRecovery,
      hasSuccessfulToolProgress,
      lastDocumentSaveFailure,
      lastDocumentSaveSuccessText,
      lastRollingCheckpointToolCalls,
      longSkillCheckpoint,
      newDocumentNeedsSave,
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
      hasSuccessfulLocalDocumentSourceRead,
      hasSuccessfulLocalDocumentSourceReadForRecovery,
      hasSuccessfulToolProgress,
      lastDocumentSaveFailure,
      lastDocumentSaveSuccessText,
      lastRollingCheckpointToolCalls,
      longSkillCheckpoint,
      newDocumentNeedsSave,
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
  const finalizeBudgetCheckpointReturn: typeof finalizeBudgetCheckpointReturnFromContext = async (checkpointText) => {
    syncState()
    const result = await finalizeBudgetCheckpointReturnFromContext(checkpointText)
    syncLocalState()
    return result
  }
  const deliveryMode = effectiveExecutionOptions?.deliveryMode ?? 'adaptive'
  const deliveryDeadline = armDynamicDeliveryDeadline({
    mode: deliveryMode,
    profile: turnCapabilityFloors.reasons.includes('tag_forge_folder_batch')
      ? 'tag_forge_folder_batch'
      : 'default',
    runId,
    abortController,
    runHandle,
    startedAtMs: runStartedAt,
    agentId: name,
    scopeId: sessionId ?? null,
    scopeIdAliases: [host.runtime?.getTaskProjectionStoreForFinalize?.()?.get(taskId)?.scopeId || '', effectiveExecutionOptions?.publicSessionId || ''],
  })
  const emitOutputBeforeProgressTracking = emitOutput
  emitOutput = (chunk, type, projectionPatch) => {
    if (type === 'text' && chunk.trim()) deliveryDeadline.noteProgress('text_delta')
    emitOutputBeforeProgressTracking(chunk, type, projectionPatch)
  }
  runHandle.noteModelStreamActivity = bindModelStreamLiveness(deliveryDeadline)
  try {
    const latentSkillToolDefinitions = host.toolExecutor.listLatentSkillToolDefinitions()
      .filter((definition) => !toolDefinitions.some((visible) => visible.name === definition.name))
    const latentBrowserToolDefinitions = host.toolExecutor.listLatentBrowserToolDefinitions()
      .filter((definition) => !toolDefinitions.some((visible) => visible.name === definition.name))
    const latentToolDefinitions = [...latentSkillToolDefinitions, ...latentBrowserToolDefinitions]
    const hasVeaPipelineTool = toolDefinitions.some(
      (definition) => definition.name === 'skill_video_expert_pipeline'
    )
    const hasMapAmbiguityQuestionTools = toolDefinitions.some(
      (definition) => definition.name === 'map_plan_route'
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
    const definitionByName = new Map([...toolDefinitions, ...latentToolDefinitions]
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
    const readOnlyResearchSkill = isReadOnlyResearchSkillToolSet(
      resolveActiveSkillAllowedTools(authorization),
    )
    const explicitSkillTaskType = readOnlyResearchSkill ? 'research' : null
    let liveTaskBudgetRuntime = resolveAgentSdkTaskBudgetRuntime({
      options: effectiveExecutionOptions,
      explicitTaskType: explicitSkillTaskType,
      overrideTaskType: readOnlyResearchSkill,
    })
    const browserSurfaceActive = browserSurfaceActiveForDefinitions(toolDefinitions)
    if (browserSurfaceActive && liveTaskBudgetRuntime?.bootstrapBudget) {
      liveTaskBudgetRuntime = ensureLongRunningTaskBudgetCapacity(liveTaskBudgetRuntime)
    }
    const turnTaskType = liveTaskBudgetRuntime?.taskType ?? explicitSkillTaskType ?? 'short_task'
    runMetaBudgetRuntime = liveTaskBudgetRuntime
    const sourceMessageProvenance = resolveSourceMessageProvenance({
      sourceMessageId: effectiveExecutionOptions?.sourceMessageId,
      requestEnvelope: effectiveExecutionOptions?.requestEnvelope
    })
    const browserTurnState = await prepareBrowserWorkflowTurnState({
      runtime: host.runtime,
      capturedSession: runHandle.capturedSession,
      taskId,
      runId,
      sessionId,
      browserSurfaceActive,
    })
    const { ownerLocalSession, ownerSessionSeed } = browserTurnState
    const preparedDelivery = await host.dynamicDelivery.prepareOwnerInput({
      mode: deliveryMode,
      runId,
      taskId,
      scopeId: sessionId ?? null,
      userRequestVerbatim: pureUserTurnText,
      ownerSystemPrompt: session.systemPrompt,
      requestEnvelope: effectiveExecutionOptions?.requestEnvelope,
      intentClassification: effectiveExecutionOptions?.intentClassification,
      inferredTaskType: turnTaskType,
      liveBudget: liveTaskBudgetRuntime,
      ownerBinding: effectiveExecutionOptions?.executionBinding ?? null,
      ownerProfile: effectiveExecutionOptions?.executionProfile ?? null,
      committedSession: ownerLocalSession,
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
    // Assistant wording is a candidate until the canonical core transaction
    // commits.  All delivery modes, including single_path, therefore buffer
    // text while tool/status progress remains live.
    const candidateOutputBuffer = preparedDelivery.emitOutput ?? new DeliveryOutputBuffer()
    emitOutput = (chunk, type, projectionPatch) => {
      if (type === 'text') {
        if (chunk.trim()) deliveryDeadline.noteProgress('text_delta')
        candidateOutputBuffer.append(chunk)
        return
      }
      realEmitOutput(chunk, type, projectionPatch)
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
      preparedSkillTurn,
      ...browserTurnState.runtimeFields,
      sameRunActivatedSkillId: null,
      skillSurfaceComposition: skillSurface.composition,
      exclusiveScopeRef: skillSurface.exclusiveScopeRef,
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
      recordToolResult: createAgentSdkToolResultRecorder({
        runtimeContext: () => toolBridgeRuntimeContext,
        state: ctx.state,
        syncBefore: syncState,
        syncAfter: syncLocalState,
        setLiveTaskBudgetRuntime: (runtime) => { liveTaskBudgetRuntime = runtime },
        usedTools,
        projectionPatches,
        toolArgsByName,
        taskProofSink,
        host,
        runId,
        taskId,
        noteProgress: () => deliveryDeadline.noteProgress('tool_result'),
      }),
      agentContext,
      runHandle: { ...runHandle, capturedSession: ownerModelSession },
      taskBudgetRuntime: liveTaskBudgetRuntime
    }
    installSameRunSkillActivation({
      runtimeContext: toolBridgeRuntimeContext,
      latentDefinitions: latentSkillToolDefinitions,
      resolvePreparedSkill: () => host.resolvePreparedSkillTurnForTurn(
        content as RunMessage, sessionId, effectiveExecutionOptions?.requestEnvelope, false, true,
      ),
      resolveComposition: (nextAuthorization) => resolveSkillSurfaceComposition(nextAuthorization, runId),
      buildPreparedTruth: ({ authorization: nextAuthorization, identity, surface }) => {
        const floors = computeCapabilityFloors({
          authorization: nextAuthorization,
          hasLocalDocumentResource: parseEnvelopeResourceReferences(
            effectiveExecutionOptions?.requestEnvelope,
          ).resources.some((resource) =>
            resource.kind === 'folder_reference' || resource.source === 'folder_reference'),
          hasCurrentDocumentContext: Boolean(documentTargetGuard),
        })
        return buildPreparedSkillTurnTruth({
          identity,
          authorization: nextAuthorization,
          requestOrResourceAnchorDigest: preparedSkillTurn.requestOrResourceAnchorDigest,
          floors,
          surface,
        })
      },
      resolveExclusiveFloorToolNames: (nextAuthorization) => computeCapabilityFloors({
        authorization: nextAuthorization,
        hasLocalDocumentResource: parseEnvelopeResourceReferences(
          effectiveExecutionOptions?.requestEnvelope,
        ).resources.some((resource) =>
          resource.kind === 'folder_reference' || resource.source === 'folder_reference'),
        hasCurrentDocumentContext: Boolean(documentTargetGuard),
      }).toolNames,
      allowedToolNames, definitionByName, requiredCapabilityGroups,
      checkpointRequiredCapabilityGroups, checkpointRequiredToolNames,
    })
    toolBridgeRuntimeContext.activateBrowserForCurrentRun = () =>
      activateBrowserCapabilityForCurrentRun({
        runtimeContext: toolBridgeRuntimeContext,
        latentDefinitions: latentBrowserToolDefinitions,
        allowedToolNames,
        definitionByName,
        requiredCapabilityGroups,
        checkpointRequiredCapabilityGroups,
        checkpointRequiredToolNames,
      })
    const checkpointRepository = host.runtime?.getAgentSessionCheckpointRepository?.() ?? null
    const modelInputController = checkpointRepository
      ? new AgentSessionInputController(
          checkpointRepository,
          toolBridgeRuntimeContext,
          effectiveExecutionOptions?.requestEnvelope,
        )
      : null
    if (modelInputController) {
      toolBridgeRuntimeContext.ensureBrowserWorkflowRoute = () =>
        modelInputController.ensureBrowserWorkflowRoute()
    }
    const buildOwnerCheckpointSnapshot = async (): Promise<AgentInputItem[]> => {
      const providerBoundary = modelInputController?.latestFilteredInput()
      if (providerBoundary) return providerBoundary
      if (toolBridgeRuntimeContext.browserWorkflowRoute) {
        throw new Error('browser_route_clean_boundary_missing')
      }
      const dynamicSnapshot = await host.dynamicDelivery.buildSanitizedCheckpoint(runId)
      if (dynamicSnapshot) return dynamicSnapshot
      return buildSanitizedCheckpointFromSession({
        committedBase: ownerSessionSeed,
        workingSession: ownerModelSession,
      })
    }
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
    const browserSuspension = createBrowserSuspensionController({
      modelInputController,
      runtimeContext: toolBridgeRuntimeContext,
      projectionPatches,
      getTaskBudgetRuntime: () => liveTaskBudgetRuntime,
      setContinuationRef: (continuation) => { runMetaContinuationRef = continuation },
      setProviderDiagnostics: (diagnostics) => { runMetaProviderDiagnostics = diagnostics },
      setFinalText: (text) => { finalText = text },
      emitOutput,
      finalizeCheckpoint: (params) => finalizeEarlyReturn({
        status: 'checkpoint',
        providerDiagnostics: runMetaProviderDiagnostics,
        ...params,
      }),
    })
    ctx.state.finishProviderTransferCheckpoint = browserSuspension.finishProviderTransferCheckpoint
    const finishSteeringCheckpointIfNeeded = async (): Promise<ExecutionTurnResult | null> => {
      if (
        !toolBridgeRuntimeContext.browserWorkflowRoute
        || !host.runtime?.getAgentSessionCheckpointRepository().hasPendingSteering(taskId)
      ) return null
      return browserSuspension.finishSuspension({
        reason: 'steering',
        terminalReason: 'checkpoint_steered',
        message: '',
      })
    }
    const finishBudgetCheckpointIfNeeded = async (): Promise<ExecutionTurnResult | null> => {
      if (!liveTaskBudgetRuntime || liveTaskBudgetRuntime.warningLevel !== 'exhausted') return null
      const browserCheckpoint = await browserSuspension.finishSuspension({
        reason: 'budget',
        terminalReason: 'checkpoint_budget',
        message: '本轮工具预算已用完，我已保存续跑检查点，可以继续。',
      })
      if (browserCheckpoint) return browserCheckpoint
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
        sessionSnapshotOverride: await buildOwnerCheckpointSnapshot()
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
        turnTaskType,
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
      latentToolDefinitions,
      toolBridgeRuntimeContext,
      hasVeaPipelineTool,
      hasMapAmbiguityQuestionTools,
      skillContextInstruction,
      documentTargetGuard,
      requiresLocalDocumentExcerpt,
      preferCurrentDocumentRead,
      capabilities,
      authorization,
      skillCatalogSnapshot,
      requestedCapabilityConflicts,
      emitOutput,
      finalizeEarlyReturn
    })
    if (assembledInput.terminalResult) return await assembledInput.terminalResult
    const { sdkTools, instructions } = assembledInput
    let { nextInput } = assembledInput
    if (deliveryReminder) nextInput = prependSystemReminderInput(nextInput, deliveryReminder)
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
      turnTaskType,
      requiredCapabilityGroups,
      usedTools,
      emitOutput, emitHeartbeat,
      candidateOutputBuffer,
      checkpointSnapshotProvider: buildOwnerCheckpointSnapshot,
      callModelInputFilter: modelInputController
        ? (items, context) => modelInputController.filter(items, context)
        : undefined,
      prepareModelSessionForRunner: modelInputController ? () => modelInputController.prepareRunnerSession(ownerModelSession) : undefined,
      nativeTextToolBoundaryFlush,
      finishBudgetCheckpointIfNeeded,
      finishBrowserObservationCheckpoint: browserSuspension.finishObservationCheckpoint,
      finishBrowserIncompleteCheckpoint: browserSuspension.finishIncompleteCheckpoint,
      maybeHandleSkillClarificationGuard,
      maybeHandleActionAnnouncementGuard,
      finalizeEarlyReturn: (params) => {
        // 暂停收口发生在循环内部：receipt 必须在 finalize 消费前写回 ctx.state。
        ctx.state.checkpointCanonicalReceipt = toolBridgeRuntimeContext.browserSuspensionCanonicalReceipt || ctx.state.checkpointCanonicalReceipt || null
        return finalizeEarlyReturn(params)
      }
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
      committedPublicSession,
      committedOwnerSession: ownerLocalSession,
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
      finishSteeringCheckpointIfNeeded,
      finishBrowserIncompleteCheckpoint: browserSuspension.finishIncompleteCheckpoint,
      finalizeEarlyReturn,
      buildResult
    })
  } finally {
    runHandle.noteModelStreamActivity = null
    deliveryDeadline.dispose()
    syncState()
  }
}
