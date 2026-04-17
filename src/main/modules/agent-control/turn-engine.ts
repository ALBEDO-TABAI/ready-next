import { buildRequestEnvelope } from './request-envelope'
import { classifyIntent, type IntentClassification } from './intent-classifier'
import { resolveExecutionIntentContext } from './execution-intent-resolver'
import { prepareInitialRun, reconcileAfterBrowserDecision } from './run-capability-controller'
import {
  applyRunBudgetHint,
  consumeIterationBudget,
  consumeParallelGroupBudget,
  consumeToolCallBudget,
  createRunBudgetSeed,
  createStepBudgetState,
  getRemainingToolCallBudget,
  refundIterationBudget,
} from './run-budget-policy'
import {
  buildExecutorRuntimePolicy,
  resolveTaskExecutionRoute,
  selectExecutorAllowedToolNames,
} from './task-execution-router'
import { resolveTaskType } from './task-type-resolver'
import { buildToolRuntimeContext } from './tool-runtime-context-builder'
import {
  buildTextToolBridgeCorrectionMessage,
  buildToolGuidance,
} from './execution-tool-config'
import {
  buildTextToolResultMessage,
  looksLikeMissingNativeToolsReply,
  shouldEnforceBrowserToolRetry,
} from '../claude-bridge/tool-bridge'
import { compressHistoryForPrompt } from './context-compression'
import {
  advanceTaskStepProgress,
  detectTaskStepCompletionCue,
  initializeTaskStepProgress,
} from './task-step-runtime'
import { detectGenericInteractionState } from './interaction-state-detector'
import { inspectDocumentToolCall } from '../claude-bridge/document-tool-flow'
import { getToolResourceTag } from './tool-parallelism-policy'
import {
  normalizeToolExecutionOutput,
  serializeToolExecutionOutput,
  type ToolExecutionOutput,
} from './tool-result-types'
import { TurnState } from './turn-state'
import { TurnTranscript } from './turn-transcript'
import type {
  RunBudgetHint,
  StepBudgetState,
  TurnEngineRequest,
  TurnEngineSession,
  TurnEngineSessionMessage,
  TurnModelResponse,
  TurnSimpleResponse,
  TurnToolBatchResult,
  TurnToolCall,
  TurnToolExecutionResult,
} from './run-contracts'

interface BrowserDomainOrchestratorLike {
  prepareBrowserExecution: (params: Record<string, unknown>) => Promise<{
    browserDecision: { mode: string; reason: string; plan?: { steps?: Array<Record<string, unknown>>; targetUrl?: string; resources?: { links?: Array<{ url?: string }> } } }
    browserContinuityInstruction: string | null
    clarifyText: string | null
    canUseDeterministicBrowserRunner: boolean
    shouldInspectAmbiguousModeEntry: boolean
  }>
  resolveExecutionDispatch: (params: Record<string, unknown>) => {
    kind: 'none' | 'clarify' | 'deterministic' | 'tool_loop'
    continuityInstruction: string | null
    responseText: string | null
    toolLoopMessage: string | null
    fallbackLog: string | null
  }
  runDeterministicExecution: (params: Record<string, unknown>) => Promise<{
    handled: boolean
    state: 'done' | 'failed' | 'cancelled' | 'partial'
    message: string
  }>
  createToolLoopState: (decision: unknown) => {
    isBrowserTask: boolean
    steps: Array<unknown>
    stepIndex: number
  }
  recordToolLoopProgress: (params: Record<string, unknown>) => {
    state: {
      isBrowserTask: boolean
      steps: Array<unknown>
      stepIndex: number
    }
    advancedStepIndex: number | null
    checkpointMessage: string | null
  }
  buildToolLoopLimitMessage: (state: unknown) => string | null
  getBudgetHint: (params: Record<string, unknown>) => RunBudgetHint | null
  getRecommendedToolLoopIterations: (userText: string, decision: unknown, baseMaxToolIterations: number) => number
}

interface SkillContextOrchestratorLike {
  shouldKeepToolsWithVideo: (userText: string, sessionId?: string) => boolean
  findExplicitlyRequestedSkills: (userText: string) => Array<{ skillId: string }>
  hasActiveSkillExecution: (sessionId?: string) => boolean
  buildPreferredSkillToolNames: (userText: string, sessionId?: string) => string[] | null
  maybeInjectExplicitSkillContext: (params: Record<string, unknown>) => Promise<void>
}

interface DocumentToolLoopOrchestratorLike {
  createState: () => any
  getBudgetHint: (params: Record<string, unknown>) => RunBudgetHint | null
  handleNoToolCall: (params: Record<string, unknown>) => {
    state: any
    nextUserMessage: string | null
    finalText: string | null
    preserveAssistantText?: boolean
  }
  applyToolInspection: (state: any, inspection: unknown) => any
  handleIterationResult: (params: Record<string, unknown>) => {
    state: any
    nextUserMessage: string | null
    completionText: string | null
  }
  buildStructuredTaskPayload: (payload: Record<string, unknown>) => Record<string, unknown>
}

interface DesignToolLoopOrchestratorLike {
  createState: () => any
  getBudgetHint: (params: Record<string, unknown>) => RunBudgetHint | null
  filterToolCalls: (params: Record<string, unknown>) => {
    toolCalls: TurnToolCall[]
    droppedCount: number
    nextUserMessage: string | null
  }
  applySourceInput: (toolCall: TurnToolCall, toolPolicy: unknown) => TurnToolCall
  recordToolResult: (params: Record<string, unknown>) => {
    state: any
    isPrimaryArtifact: boolean
  }
  buildCompletionText: (state: any) => string | null
  buildStructuredTaskPayload: (payload: Record<string, unknown>) => Record<string, unknown>
}

interface HostCapabilityDispatcherLike {
  dispatch: (params: Record<string, unknown>) => Promise<{
    handled: boolean
    toolUseText?: string
    outputText?: string
  }>
}

function cloneSession<TSession extends TurnEngineSession>(session: TSession): TSession {
  return {
    ...session,
    messages: session.messages.map((message) => ({ ...message })),
  }
}

function extractIncomingText(content: string | Array<Record<string, unknown>>): string {
  if (typeof content === 'string') return content
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text || ''))
    .join('\n')
}

function extractTaskIdFromText(text: string): string | null {
  return String(text || '').match(/^Task ID:\s*(.+)$/m)?.[1]?.trim() || null
}

function compressSessionMessagesForRetry<TSession extends TurnEngineSession>(session: TSession): boolean {
  if (session.messages.length <= 6) return false
  const earlierMessages = session.messages
    .slice(0, -6)
    .map((message) => ({
      role: message.role,
      content: extractIncomingText(message.content as string | Array<Record<string, unknown>>).trim(),
    }))
    .filter((message) => message.content.length > 0)
  if (earlierMessages.length === 0) return false

  const compressed = compressHistoryForPrompt(earlierMessages, {
    keepRecent: 2,
    maxChars: 900,
  })
  if (!compressed.compressed) return false

  session.messages = [
    { role: 'system', content: `更早对话已压缩以继续执行：\n${compressed.text}` },
    ...session.messages.slice(-6),
  ]
  return true
}

function normalizeToolBatchResult(result: TurnToolBatchResult): {
  results: TurnToolExecutionResult[]
  budgetLimited: boolean
  recoveryHistory: TurnToolBatchResult['recoveryHistory']
} {
  return {
    results: result.results.map((item) => ({
      ...item,
      result: normalizeToolExecutionOutput(item.result as ToolExecutionOutput),
    })),
    budgetLimited: result.budgetLimited,
    recoveryHistory: result.recoveryHistory,
  }
}

function normalizeStepBudgetState(stepBudget: {
  stepId?: string | null
  maxIterations: number
  remainingIterations?: number
} | null | undefined): StepBudgetState | null {
  if (!stepBudget) return null
  const maxIterations = Math.max(1, Number(stepBudget.maxIterations || 0))
  const remainingIterations = typeof stepBudget.remainingIterations === 'number'
    ? stepBudget.remainingIterations
    : maxIterations
  return {
    stepId: stepBudget.stepId || null,
    maxIterations,
    remainingIterations: Math.max(0, Number(remainingIterations || 0)),
  }
}

function applyRuntimeBudgetHint(runtime: NonNullable<ReturnType<TurnState['syncTaskBudgetRuntime']>>, hint: RunBudgetHint | null): NonNullable<ReturnType<TurnState['syncTaskBudgetRuntime']>> {
  return applyRunBudgetHint(runtime, hint) as NonNullable<ReturnType<TurnState['syncTaskBudgetRuntime']>>
}

export class TurnEngine {
  async execute<TSession extends TurnEngineSession>(request: TurnEngineRequest<TSession>) {
    const host = request.host
    const transcript = new TurnTranscript(request.emitters)
    const state = new TurnState({
      taskId: request.taskId,
      taskBudgetRuntime: request.taskBudgetRuntime,
      budget: request.budget,
      budgetState: request.budgetState,
    })
    const skillContextOrchestrator = host.skillContextOrchestrator as SkillContextOrchestratorLike
    const browserDomainOrchestrator = host.browserDomainOrchestrator as BrowserDomainOrchestratorLike
    const documentToolLoopOrchestrator = host.documentToolLoopOrchestrator as DocumentToolLoopOrchestratorLike
    const designToolLoopOrchestrator = host.designToolLoopOrchestrator as DesignToolLoopOrchestratorLike
    const hostCapabilityDispatcher = host.hostCapabilityDispatcher as HostCapabilityDispatcherLike

    const emitStructuredTaskPayload = (payload: unknown): void => {
      transcript.emitStructuredPayload(payload)
    }

    const buildHostToolContext = (allowedToolNames: string[] | null | undefined, scope?: unknown) => buildToolRuntimeContext({
      browserController: host.browserController as any,
      sidecarManager: host.sidecarManager as any,
      runtime: host.runtime as any,
      scope: scope as any,
      allowedToolNames: allowedToolNames || undefined,
      emitToolAction: (tool, args) => {
        transcript.emitToolAction(tool, args)
      },
      requestModuleToolAction: host.requestModuleToolAction,
      abortSignal: request.abortSignal,
      sessionId: request.sessionId,
      registerRunCleanup: (cleanup) => {
        host.registerRunCleanup?.(cleanup)
      },
    })

    const finish = (params: {
      success: boolean
      error?: string
      cancelled?: boolean
      status?: 'done' | 'error' | 'cancelled'
      doneEventType?: 'done' | 'error'
    }) => {
      transcript.emitOutput('', params.doneEventType || 'done')
      transcript.emitStatus(params.status || (params.cancelled ? 'cancelled' : params.success ? 'done' : 'error'))
      return state.buildResult({
        success: params.success,
        error: params.error,
        cancelled: params.cancelled,
        finalText: transcript.getFinalText(),
        usedTools: transcript.getUsedTools(),
      })
    }

    try {
      const session = request.session
      const userText = extractIncomingText(request.content as string | Array<Record<string, unknown>>)
      const requestEnvelope = request.requestEnvelope || buildRequestEnvelope({ userText })
      const executionIntentContext = resolveExecutionIntentContext({
        requestEnvelope,
        previousInputs: host.collectRecentPureUserInputs(session.messages.slice(0, -1), 40),
        lastDocumentContextInput: session.lastDocumentContextInput,
        intentClassification: request.intentClassification || classifyIntent(requestEnvelope),
      })
      const contextualUserInput = executionIntentContext.contextualUserInput
      const pureUserInput = requestEnvelope.pureUserText
      if (contextualUserInput !== pureUserInput) {
        host.log(`tool policy context reused previous user input: ${contextualUserInput.slice(0, 120)}`)
      }
      const hasVideoInputs = host.sessionHasVideoInputs(session.messages)
      const keepToolsWithVideo = skillContextOrchestrator.shouldKeepToolsWithVideo(contextualUserInput, request.sessionId)
      const incomingAttachmentHints = host.getIncomingAttachmentHints(request.content)
      let browserDecision = { mode: 'free_tool_loop', reason: 'browser_disabled' } as { mode: string; reason: string }

      const preferredSkillToolNames = (
        skillContextOrchestrator.findExplicitlyRequestedSkills(contextualUserInput).length > 0
        || skillContextOrchestrator.hasActiveSkillExecution(request.sessionId)
      )
        ? skillContextOrchestrator.buildPreferredSkillToolNames(contextualUserInput, request.sessionId)
        : null
      const runtimeAvailability = {
        browserHostAvailable: Boolean(host.browserController),
        feishuConnected: host.runtime?.isChannelTypeAvailable?.('feishu-app') ?? false,
      }
      const preparedRunCapabilities = prepareInitialRun({
        config: host.providerContext.config,
        capabilityProfile: 'local_chat',
        supportsToolCalls: host.providerContext.supportsToolCalls,
        hasVideoInputs,
        hasIncomingVideo: host.providerContext.hasRawVideoInIncoming,
        keepToolsWithVideo,
        preferredSkillToolNames,
        executionIntentContext,
        browserDecisionMode: browserDecision.mode as any,
        runtimeAvailability,
        hostContext: {
          userText: executionIntentContext.requestEnvelope.primaryInstruction
            || executionIntentContext.requestEnvelope.pureUserText
            || userText,
        },
      })
      const hasTools = preparedRunCapabilities.visibilityPlan.hasTools
      let toolPolicy = preparedRunCapabilities.toolPolicy
      if ((toolPolicy as any).forceDocumentTool) {
        session.lastDocumentContextInput = contextualUserInput
      }

      const continuationHintText =
        executionIntentContext.requestEnvelope.primaryInstruction
        || executionIntentContext.requestEnvelope.pureUserText
        || userText
      const explicitTaskId = extractTaskIdFromText(userText)
      const shouldResolveContinuation =
        Boolean(explicitTaskId)
        || /(继续|接着|恢复|上次|重试)/.test(continuationHintText)
      const continuationProjection = host.resolveContinuationProjection(request.sessionId, userText, {
        explicitTaskId,
        allowImplicitContinuation: shouldResolveContinuation,
      })
      const continuationTaskId = continuationProjection?.taskId || null
      const initialTaskTypeResolution = resolveTaskType({
        intent: executionIntentContext.intentClassification as IntentClassification,
        envelope: executionIntentContext.requestEnvelope,
        capabilities: preparedRunCapabilities.runtimeSnapshot,
        currentTaskContext: continuationTaskId ? { continuationTaskId } : null,
      })
      const initialTaskExecutionRoute = resolveTaskExecutionRoute({
        taskId: request.taskId,
        resolution: initialTaskTypeResolution,
        envelope: executionIntentContext.requestEnvelope,
        capabilities: preparedRunCapabilities.runtimeSnapshot,
        currentTaskContext: continuationTaskId
          ? {
            continuationTaskId,
            continuationProjection,
          }
          : null,
      })

      const documentTaskPlanResult = await host.maybeRunDocumentTaskPlan({
        initialTaskExecutionRoute,
        executionIntentContext,
        hasTools,
        requestModuleToolAction: host.requestModuleToolAction,
        signal: request.abortSignal,
        session,
        providerContext: host.providerContext,
        emitStructuredTaskPayload,
      })
      if (documentTaskPlanResult) {
        if (documentTaskPlanResult.interactionState) {
          state.interactionState = documentTaskPlanResult.interactionState
        }
        if (documentTaskPlanResult.finalText) {
          transcript.emitOutput(documentTaskPlanResult.finalText, 'text')
          session.messages.push({ role: 'assistant', content: documentTaskPlanResult.finalText })
        }
        return finish({
          success: documentTaskPlanResult.success ?? (documentTaskPlanResult.status !== 'error'),
          error: documentTaskPlanResult.error,
          cancelled: documentTaskPlanResult.status === 'cancelled',
          status: documentTaskPlanResult.status || 'done',
          doneEventType: documentTaskPlanResult.status === 'error' ? 'done' : 'done',
        })
      }

      const documentPipelineResult = await host.maybeRunDocumentWidgetPipeline({
        initialTaskExecutionRoute,
        executionIntentContext,
        hasTools,
        requestModuleToolAction: host.requestModuleToolAction,
        signal: request.abortSignal,
        session,
        providerContext: host.providerContext,
        emitStructuredTaskPayload,
        setPipelineDiagnostics: (pipeline: unknown) => state.setPipelineDiagnostics(pipeline as any),
      })
      if (documentPipelineResult) {
        if (documentPipelineResult.interactionState) {
          state.interactionState = documentPipelineResult.interactionState
        }
        if (documentPipelineResult.finalText) {
          transcript.emitOutput(documentPipelineResult.finalText, 'text')
          session.messages.push({ role: 'assistant', content: documentPipelineResult.finalText })
        }
        return finish({
          success: documentPipelineResult.success ?? (documentPipelineResult.status !== 'error'),
          error: documentPipelineResult.error,
          cancelled: documentPipelineResult.status === 'cancelled',
          status: documentPipelineResult.status || 'done',
          doneEventType: documentPipelineResult.status === 'error' ? 'done' : 'done',
        })
      }

      if (hasTools) {
        const preparedToolContext = buildHostToolContext(preparedRunCapabilities.allowedToolNames)
        await skillContextOrchestrator.maybeInjectExplicitSkillContext({
          userText,
          session,
          sessionId: request.sessionId,
          emitOutput: (chunk: string, type: string) => transcript.emitOutput(chunk, type),
          emitToolAction: (tool: string, args: Record<string, unknown>) => transcript.emitToolAction(tool, args),
          executeTool: async (tool: string, args: Record<string, unknown>) => host.executeToolCall(tool, args, preparedToolContext),
        })
      }

      const preparedBrowserExecution = await browserDomainOrchestrator.prepareBrowserExecution({
        hasTools,
        browserControllerAvailable: Boolean(host.browserController),
        browserAgentEnabled: host.isBrowserAgentV3Enabled(),
        userText,
        pureUserInput,
        sessionMessages: session.messages,
        sessionId: request.sessionId,
        refineDecision: async (decision: unknown) => browserDomainOrchestrator.prepareBrowserExecution({
          hasTools,
          browserControllerAvailable: Boolean(host.browserController),
          browserAgentEnabled: host.isBrowserAgentV3Enabled(),
          userText,
          pureUserInput,
          sessionMessages: session.messages,
          sessionId: request.sessionId,
          decision,
        }),
      })
      browserDecision = preparedBrowserExecution.browserDecision
      const reconciledRunCapabilities = reconcileAfterBrowserDecision({
        prepared: preparedRunCapabilities,
        browserDecisionMode: browserDecision.mode as any,
      })
      toolPolicy = reconciledRunCapabilities.toolPolicy

      const taskTypeResolution = resolveTaskType({
        intent: executionIntentContext.intentClassification as IntentClassification,
        envelope: executionIntentContext.requestEnvelope,
        capabilities: reconciledRunCapabilities.runtimeSnapshot,
        currentTaskContext: continuationTaskId ? { continuationTaskId } : null,
      })
      const taskExecutionRoute = resolveTaskExecutionRoute({
        taskId: request.taskId,
        resolution: taskTypeResolution,
        envelope: executionIntentContext.requestEnvelope,
        capabilities: reconciledRunCapabilities.runtimeSnapshot,
        currentTaskContext: continuationTaskId
          ? {
            continuationTaskId,
            continuationProjection,
          }
          : null,
      })
      state.continuationBudgetRestore = taskExecutionRoute.continuation?.budgetRestore || null
      if (taskExecutionRoute.chain === 'continuation' && taskExecutionRoute.continuation?.budgetRuntime) {
        state.taskBudgetRuntime = {
          ...taskExecutionRoute.continuation.budgetRuntime,
          budget: { ...taskExecutionRoute.continuation.budgetRuntime.budget },
          usage: { ...taskExecutionRoute.continuation.budgetRuntime.usage },
          stepBudget: taskExecutionRoute.continuation.budgetRuntime.stepBudget
            ? { ...taskExecutionRoute.continuation.budgetRuntime.stepBudget }
            : null,
        }
        state.effectiveRunBudget = { ...state.taskBudgetRuntime.budget }
        Object.assign(state.runBudgetState, state.taskBudgetRuntime.usage)
        state.stepBudgetState = state.taskBudgetRuntime.stepBudget
          ? { ...state.taskBudgetRuntime.stepBudget }
          : null
      }
      state.adoptResolvedTaskTypeBudget(taskExecutionRoute.taskType)
      const alignedRunBudget = state.effectiveRunBudget || createRunBudgetSeed(taskExecutionRoute.taskType)
      state.effectiveRunBudget = alignedRunBudget
      state.degradationReason = taskExecutionRoute.degradationReason || null
      const executorRuntimePolicy = buildExecutorRuntimePolicy(taskExecutionRoute.executor)
      const executorAllowedToolNames = selectExecutorAllowedToolNames(
        taskExecutionRoute.executor,
        reconciledRunCapabilities.allowedToolNames,
      )
      const routedAllowedToolNames = executorAllowedToolNames || reconciledRunCapabilities.allowedToolNames
      if (executorRuntimePolicy.instruction) {
        session.messages.push({ role: 'user', content: executorRuntimePolicy.instruction })
      }
      if (taskExecutionRoute.chain === 'continuation' && taskExecutionRoute.continuation) {
        state.interactionState = 'resuming'
      }
      state.stepBudgetState = normalizeStepBudgetState(taskExecutionRoute.continuation?.budgetRuntime?.stepBudget)
        || normalizeStepBudgetState(continuationProjection?.budget?.stepBudget)
        || (
          taskExecutionRoute.steps.length > 0
            ? createStepBudgetState({
              stepId: taskExecutionRoute.steps[0]?.id || null,
              totalIterations: alignedRunBudget.maxIterations,
              stepCount: taskExecutionRoute.steps.length,
              suggestedMaxIterations: taskExecutionRoute.steps[0]?.budget,
            })
            : createStepBudgetState({
              stepId: null,
              totalIterations: alignedRunBudget.maxIterations,
              suggestedMaxIterations: alignedRunBudget.maxIterations,
            })
        )
      state.runtimeTaskSteps = taskExecutionRoute.steps.map((step) => ({ ...step }))
      state.runtimeCurrentStepId = taskExecutionRoute.steps[0]?.id || null
      if (taskExecutionRoute.chain === 'planner') {
        const initialPlannerProgress = initializeTaskStepProgress(taskExecutionRoute.steps)
        state.runtimeTaskSteps = initialPlannerProgress.steps
        state.runtimeCurrentStepId = initialPlannerProgress.currentStepId
      }
      const structuredModule =
        taskTypeResolution.preferredExecutor && taskTypeResolution.preferredExecutor !== 'none'
          ? taskTypeResolution.preferredExecutor
          : 'system'
      const emitRuntimeTaskPayload = (options: {
        summary: string
        waitingFor?: 'input' | 'confirmation' | 'agent_result' | 'background' | 'none'
        resumableActions?: Array<'continue' | 'retry' | 'open_artifact' | 'cancel' | 'none'>
        blockedReason?: string | null
      }) => {
        emitStructuredTaskPayload({
          module: structuredModule,
          message: options.summary,
          taskTitle: executionIntentContext.userInstructionText || '任务执行',
          taskSummary: options.summary,
          steps: state.runtimeTaskSteps.map((step) => ({
            id: step.id,
            title: step.title || step.description,
            status: step.status || 'pending',
            detail: step.detail || null,
            updatedAt: step.updatedAt || new Date().toISOString(),
          })),
          currentStepId: state.runtimeCurrentStepId,
          waitingFor: options.waitingFor || 'none',
          resumableActions: options.resumableActions || ['cancel'],
          blockedReason: options.blockedReason || null,
        })
      }
      const advancePlannerStep = (summary: string): boolean => {
        if (taskExecutionRoute.chain !== 'planner') return false
        const next = advanceTaskStepProgress({
          steps: state.runtimeTaskSteps,
          currentStepId: state.runtimeCurrentStepId,
          totalIterations: alignedRunBudget.maxIterations,
          summary,
        })
        state.runtimeTaskSteps = next.steps
        state.runtimeCurrentStepId = next.currentStepId
        state.stepBudgetState = next.stepBudget
          ? {
            stepId: next.stepBudget.stepId || null,
            maxIterations: next.stepBudget.maxIterations,
            remainingIterations: next.stepBudget.remainingIterations,
          }
          : null
        emitRuntimeTaskPayload({ summary })
        return next.advanced
      }
      const syncInteractionStateFromAssistantText = (text: string): boolean => {
        const detected = detectGenericInteractionState(text)
        if (!detected) return false
        state.interactionState = detected.interactionState
        emitRuntimeTaskPayload({
          summary: text,
          waitingFor: detected.waitingFor,
          resumableActions: detected.resumableActions,
          blockedReason: detected.blockedReason,
        })
        return true
      }
      state.syncBudgetWarning()
      if (taskExecutionRoute.chain === 'planner' && taskExecutionRoute.steps.length > 0) {
        emitRuntimeTaskPayload({ summary: '已拆分任务步骤，开始逐步执行' })
        session.messages.push({
          role: 'user',
          content: [
            '系统规划步骤：',
            ...state.runtimeTaskSteps.map((step, index) =>
              `${index + 1}. ${step.title || step.description}（预算 ${step.budget || 0} 轮）`
            ),
            '请严格按以上步骤推进，并在接近预算上限时主动收敛总结。',
          ].join('\n'),
        })
      }
      if (taskExecutionRoute.chain === 'continuation' && taskExecutionRoute.continuation) {
        session.messages.push({
          role: 'user',
          content: [
            `Task ID: ${taskExecutionRoute.continuation.taskId}`,
            taskExecutionRoute.continuation.continuationRef?.executionId
              ? `Execution ID: ${taskExecutionRoute.continuation.continuationRef.executionId}`
              : null,
            taskExecutionRoute.continuation.continuationRef?.stepId
              ? `Step ID: ${taskExecutionRoute.continuation.continuationRef.stepId}`
              : null,
            continuationProjection?.blockedReason
              ? `继续前上下文：${continuationProjection.blockedReason}`
              : null,
          ].filter(Boolean).join('\n'),
        })
      }

      const allowBrowserDispatch =
        taskExecutionRoute.executor === 'browser'
        || taskExecutionRoute.executor === 'tool_loop'
        || taskExecutionRoute.executor === 'planner'
      const browserExecutionDispatch = allowBrowserDispatch
        ? browserDomainOrchestrator.resolveExecutionDispatch({
          hasTools,
          browserControllerAvailable: Boolean(host.browserController),
          browserDecision,
          browserContinuityInstruction: preparedBrowserExecution.browserContinuityInstruction,
          clarifyText: preparedBrowserExecution.clarifyText,
          canUseDeterministicBrowserRunner: preparedBrowserExecution.canUseDeterministicBrowserRunner,
          shouldInspectAmbiguousModeEntry: preparedBrowserExecution.shouldInspectAmbiguousModeEntry,
        })
        : {
          kind: 'none' as const,
          continuityInstruction: null,
          responseText: null,
          toolLoopMessage: null,
          fallbackLog: null,
        }

      if (browserExecutionDispatch.continuityInstruction) {
        session.messages.push({ role: 'user', content: browserExecutionDispatch.continuityInstruction })
      }

      if (browserExecutionDispatch.kind === 'clarify' && browserExecutionDispatch.responseText) {
        state.interactionState = 'awaiting_clarification'
        transcript.emitOutput(browserExecutionDispatch.responseText, 'text')
        session.messages.push({ role: 'assistant', content: browserExecutionDispatch.responseText })
        return finish({ success: true, status: 'done' })
      }

      if (browserExecutionDispatch.fallbackLog) {
        host.log(browserExecutionDispatch.fallbackLog)
      }

      if (browserExecutionDispatch.kind === 'deterministic' && host.browserController) {
        const browserResult = await browserDomainOrchestrator.runDeterministicExecution({
          browserController: host.browserController,
          abortSignal: request.abortSignal,
          sessionId: request.sessionId,
          decision: browserDecision,
          userText,
          emitToolEvent: (type: string, text: string) => {
            transcript.emitOutput(text, type)
          },
        })
        if (browserResult.handled) {
          if (browserResult.state === 'partial' && /(人工|手动|验证码|接管)/.test(browserResult.message)) {
            state.interactionState = 'human_takeover'
          }
          transcript.emitOutput(browserResult.message, 'text')
          session.messages.push({ role: 'assistant', content: browserResult.message })
          return finish({
            success: true,
            cancelled: browserResult.state === 'cancelled',
            status: browserResult.state === 'failed'
              ? 'error'
              : browserResult.state === 'cancelled'
                ? 'cancelled'
                : 'done',
          })
        }
      }

      if (browserExecutionDispatch.kind === 'tool_loop' && browserExecutionDispatch.toolLoopMessage) {
        session.messages.push({ role: 'user', content: browserExecutionDispatch.toolLoopMessage })
      }

      const hostToolContext = buildHostToolContext(routedAllowedToolNames)
      const hostShortcutResult = await hostCapabilityDispatcher.dispatch({
        decision: reconciledRunCapabilities.hostShortcutDecision,
        toolContext: hostToolContext,
        agentName: request.agentName,
        userText,
        session,
        config: host.providerContext.config,
        baseUrl: host.providerContext.baseUrl,
        provider: host.providerContext.provider,
        signal: request.abortSignal,
        isKimi: host.providerContext.isKimi,
        isKimiCoding: host.providerContext.isKimiCoding,
        useAnthropicProtocol: host.providerContext.useAnthropicProtocol,
        onAssistantSummary: (summary: string) => {
          session.messages.push({ role: 'assistant', content: summary })
        },
      })
      if (hostShortcutResult.handled) {
        if (hostShortcutResult.toolUseText) {
          transcript.emitOutput(hostShortcutResult.toolUseText, 'tool_use')
        }
        if (hostShortcutResult.outputText) {
          transcript.emitOutput(hostShortcutResult.outputText.slice(0, 300), 'tool_result')
          transcript.emitOutput(hostShortcutResult.outputText, 'text')
          session.messages.push({ role: 'assistant', content: hostShortcutResult.outputText })
        }
        return finish({ success: true, status: 'done' })
      }

      if (!state.resolvedTaskType) {
        state.resolvedTaskType = hasTools ? 'short_task' : 'direct_answer'
      }
      if (!state.effectiveRunBudget) {
        state.effectiveRunBudget = createRunBudgetSeed(state.resolvedTaskType)
      }
      const shouldUseToolLoop = Boolean(hasTools && taskExecutionRoute.chain !== 'direct')

      if (!shouldUseToolLoop) {
        const hasMediaInputs = host.sessionHasMediaInputs(session.messages)
        const simpleResponse = await host.requestSimpleText({
          session,
          signal: request.abortSignal,
          providerContext: host.providerContext,
          enableKimiWebSearch: !hasMediaInputs,
        }) as TurnSimpleResponse
        if (simpleResponse.fallback) {
          state.latestFallback = simpleResponse.fallback
        }
        if (simpleResponse.text) {
          syncInteractionStateFromAssistantText(simpleResponse.text)
          if (taskExecutionRoute.chain === 'planner' && detectTaskStepCompletionCue(simpleResponse.text, state.runtimeTaskSteps.find((step) => step.id === state.runtimeCurrentStepId))) {
            advancePlannerStep(simpleResponse.text)
          }
          transcript.emitOutput(simpleResponse.text, 'text')
          session.messages.push({ role: 'assistant', content: simpleResponse.text })
        }
        return finish({ success: true, status: 'done' })
      }

      let documentToolLoopState = documentToolLoopOrchestrator.createState()
      let designToolLoopState = designToolLoopOrchestrator.createState()
      const hintedRuntimeBase = state.syncTaskBudgetRuntime() || state.taskBudgetRuntime
      if (!hintedRuntimeBase) {
        throw new Error('turn engine failed to initialize runtime budget')
      }
      state.taskBudgetRuntime = applyRuntimeBudgetHint(
        hintedRuntimeBase,
        browserDomainOrchestrator.getBudgetHint({
          userText,
          decision: browserDecision,
          baseMaxToolIterations: host.maxToolIterations,
        }),
      )
      state.taskBudgetRuntime = applyRuntimeBudgetHint(
        state.taskBudgetRuntime,
        documentToolLoopOrchestrator.getBudgetHint({
          forceDocumentTool: (toolPolicy as any).forceDocumentTool,
          state: documentToolLoopState,
        }),
      )
      state.taskBudgetRuntime = applyRuntimeBudgetHint(
        state.taskBudgetRuntime,
        designToolLoopOrchestrator.getBudgetHint({
          forceDesignTool: (toolPolicy as any).forceDesignTool,
          primaryArtifactProduced: designToolLoopState.primaryArtifactProduced,
        }),
      )
      state.effectiveRunBudget = state.taskBudgetRuntime.budget
      state.stepBudgetState = state.taskBudgetRuntime.stepBudget
        ? { ...state.taskBudgetRuntime.stepBudget }
        : null
      state.budgetWarningLevel = state.taskBudgetRuntime.warningLevel
      const baseMaxToolIterations = state.effectiveRunBudget.maxIterations > 0
        ? state.effectiveRunBudget.maxIterations
        : host.maxToolIterations
      const recommendedMaxToolIterations = browserDomainOrchestrator.getRecommendedToolLoopIterations(
        userText,
        browserDecision,
        baseMaxToolIterations,
      )
      const effectiveMaxToolIterations = state.effectiveRunBudget.maxIterations > 0
        ? Math.min(recommendedMaxToolIterations, state.effectiveRunBudget.maxIterations)
        : recommendedMaxToolIterations
      let iterations = 0
      let finishedBeforeLimit = false
      let textToolBridgeNudges = 0
      let budgetLimitedBeforeCompletion = false
      let convergencePromptInjected = false
      let browserToolLoopState = browserDomainOrchestrator.createToolLoopState(browserDecision)
      const toolGuidance = buildToolGuidance(toolPolicy as any)
      const toolLoopSession = toolGuidance
        ? {
          ...session,
          systemPrompt: `${session.systemPrompt}\n\n${toolGuidance}`,
        }
        : session

      while (iterations < effectiveMaxToolIterations) {
        request.ensureNotAborted()
        if (state.syncTaskBudgetRuntime()?.frozen) {
          state.interactionState = 'suspended'
          break
        }
        if (taskExecutionRoute.chain === 'planner' && (state.stepBudgetState?.remainingIterations || 0) <= 0) {
          const advanced = advancePlannerStep('当前步骤预算已耗尽，已切换到下一步继续推进。')
          if (advanced) {
            state.syncBudgetWarning()
            continue
          }
        }
        if (state.budgetWarningLevel === 'exhausted' || (state.stepBudgetState?.remainingIterations || 0) <= 0) {
          budgetLimitedBeforeCompletion = true
          break
        }
        if (state.budgetWarningLevel === 'converge' && !convergencePromptInjected) {
          session.messages.push({
            role: 'user',
            content: '系统提醒：当前预算已接近上限，请在剩余轮次内收敛并优先给出可交付结果。',
          })
          convergencePromptInjected = true
        }
        iterations += 1
        Object.assign(state.runBudgetState, consumeIterationBudget(state.runBudgetState))
        if (state.stepBudgetState) {
          state.stepBudgetState = {
            ...state.stepBudgetState,
            remainingIterations: Math.max(0, Number(state.stepBudgetState.remainingIterations || 0) - 1),
          }
        }
        state.syncBudgetWarning()

        const scope = request.sessionId ? host.runtime?.getConversationScope?.(request.sessionId) : undefined
        const toolContext = buildHostToolContext(routedAllowedToolNames, scope)
        const response = await host.requestToolLoopResponse({
          session: toolLoopSession,
          signal: request.abortSignal,
          toolPolicy,
          providerContext: host.providerContext,
          hasVideoInputs,
          compressContext: () => compressSessionMessagesForRetry(session),
        }) as TurnModelResponse
        if (response.fallback) {
          state.latestFallback = response.fallback
        }
        state.appendRecoveryHistory(response.recoveryHistory)

        if (response.toolCalls.length === 0) {
          const browserToolRetryNeeded = shouldEnforceBrowserToolRetry({
            isBrowserTask: browserToolLoopState.isBrowserTask,
            toolCallsCount: response.toolCalls.length,
            toolTransport: response.toolTransport,
            responseText: response.text || response.rawText || '',
          })
          if (browserToolRetryNeeded && textToolBridgeNudges < 2) {
            textToolBridgeNudges += 1
            const assistantHistoryText = response.rawText || response.text
            if (assistantHistoryText) {
              session.messages.push({ role: 'assistant', content: assistantHistoryText })
            }
            session.preferTextToolBridge = true
            toolLoopSession.preferTextToolBridge = true
            session.messages.push({
              role: 'user',
              content: [
                buildTextToolBridgeCorrectionMessage(toolPolicy as any),
                '系统补充：当前任务是浏览器任务，至少先调用一个 browser_* 工具（例如 browser_search、browser_navigate、browser_read_page），不要直接解释这轮工具列表。',
              ].join('\n'),
            })
            continue
          }
          if (response.toolTransport === 'text' && response.rawText) {
            session.messages.push({ role: 'assistant', content: response.rawText })
            if (looksLikeMissingNativeToolsReply(response.text || response.rawText) && textToolBridgeNudges < 2) {
              textToolBridgeNudges += 1
              session.messages.push({
                role: 'user',
                content: buildTextToolBridgeCorrectionMessage(toolPolicy as any),
              })
              continue
            }
          }
          const documentNoToolDecision = documentToolLoopOrchestrator.handleNoToolCall({
            state: documentToolLoopState,
            forceDocumentTool: (toolPolicy as any).forceDocumentTool,
            responseText: response.text,
            toolTransport: response.toolTransport,
          })
          documentToolLoopState = documentNoToolDecision.state
          const plannerStepCompleted = response.text
            ? detectTaskStepCompletionCue(response.text, state.runtimeTaskSteps.find((step) => step.id === state.runtimeCurrentStepId))
            : false
          if (documentNoToolDecision.nextUserMessage) {
            emitStructuredTaskPayload(documentToolLoopOrchestrator.buildStructuredTaskPayload({
              taskTitle: (toolPolicy as any).documentWidgetTaskKind
                ? '文档组件操作'
                : (toolPolicy as any).preferFormatOnly
                  ? '文档格式优化'
                  : (toolPolicy as any).preferSectionRewrite
                    ? '章节改写'
                    : '文档修改',
              taskSummary: documentNoToolDecision.nextUserMessage,
              state: documentToolLoopState,
              phase: 'blocked',
            }))
            if (documentNoToolDecision.preserveAssistantText && response.text && response.toolTransport !== 'text') {
              session.messages.push({ role: 'assistant', content: response.text })
            }
            session.messages.push({
              role: 'user',
              content: documentNoToolDecision.nextUserMessage,
            })
            continue
          }
          if (documentNoToolDecision.finalText) {
            emitStructuredTaskPayload(documentToolLoopOrchestrator.buildStructuredTaskPayload({
              taskTitle: (toolPolicy as any).documentWidgetTaskKind
                ? '文档组件操作'
                : (toolPolicy as any).preferFormatOnly
                  ? '文档格式优化'
                  : (toolPolicy as any).preferSectionRewrite
                    ? '章节改写'
                    : '文档修改',
              taskSummary: documentNoToolDecision.finalText,
              state: documentToolLoopState,
              phase: 'done',
            }))
            transcript.emitOutput(documentNoToolDecision.finalText, 'text')
            session.messages.push({ role: 'assistant', content: documentNoToolDecision.finalText })
            advancePlannerStep(documentNoToolDecision.finalText)
            finishedBeforeLimit = true
            break
          }
          if (response.text) {
            const genericInteractionDetected = syncInteractionStateFromAssistantText(response.text)
            transcript.emitOutput(response.text, 'text')
            if (plannerStepCompleted) {
              const advanced = advancePlannerStep(response.text)
              if (advanced) {
                session.messages.push({
                  role: 'user',
                  content: `系统提醒：已进入下一步 ${state.runtimeCurrentStepId || ''}，请继续执行。`,
                })
                continue
              }
            }
            if (genericInteractionDetected) {
              session.messages.push({ role: 'assistant', content: response.text })
              finishedBeforeLimit = true
              break
            }
          }
          if (response.text && response.toolTransport !== 'text') {
            session.messages.push({ role: 'assistant', content: response.text })
          }
          finishedBeforeLimit = true
          break
        }

        const designToolFilter = designToolLoopOrchestrator.filterToolCalls({
          toolCalls: response.toolCalls,
          policy: toolPolicy,
          primaryArtifactProduced: designToolLoopState.primaryArtifactProduced,
        })
        if (designToolFilter.nextUserMessage) {
          emitStructuredTaskPayload(designToolLoopOrchestrator.buildStructuredTaskPayload({
            taskTitle: '设计任务',
            taskSummary: designToolFilter.nextUserMessage,
            state: designToolLoopState,
            phase: 'blocked',
          }))
          session.messages.push({
            role: 'user',
            content: designToolFilter.nextUserMessage,
          })
          continue
        }
        const toolCallsForIteration = designToolFilter.toolCalls
          .map((toolCall) => designToolLoopOrchestrator.applySourceInput(toolCall, toolPolicy))
        const remainingToolCallBudget = getRemainingToolCallBudget(state.effectiveRunBudget, state.runBudgetState)
        if (remainingToolCallBudget < toolCallsForIteration.length) {
          budgetLimitedBeforeCompletion = true
          break
        }

        let executedDocActionCount = 0
        let executedMutatingDocActionCount = 0
        let executedInspectionDocActionCount = 0
        let executedSaveDocActionCount = 0
        let executedBrowserToolsThisIteration = 0
        let executedPrimaryDesignToolThisIteration = false
        let documentToolResultsThisIteration: string[] = []

        const executeBatch = async () => normalizeToolBatchResult(await host.executeToolBatch({
          toolCalls: toolCallsForIteration,
          budget: state.effectiveRunBudget || undefined,
          budgetState: state.runBudgetState,
          signal: request.abortSignal,
          onGroupStart: (group) => {
            if (group.mode === 'parallel') {
              Object.assign(state.runBudgetState, consumeParallelGroupBudget(state.runBudgetState))
            }
          },
          executeTool: async (toolCall) => {
            request.ensureNotAborted()
            transcript.emitToolUse(toolCall.name, toolCall.input)
            const result = await host.executeToolCall(toolCall.name, toolCall.input, toolContext)
            request.ensureNotAborted()
            host.log(`tool execute: ${toolCall.name}, result=${result.text.slice(0, 140)}`)
            return result
          },
        }))

        const consumeExecutedToolBatch = (executedToolBatch: Awaited<ReturnType<typeof executeBatch>>, params: {
          onResult: (payload: {
            executedTool: typeof executedToolBatch.results[number]
            serializedResult: string
          }) => void
        }) => {
          state.appendRecoveryHistory(executedToolBatch.recoveryHistory)
          Object.assign(state.runBudgetState, consumeToolCallBudget(state.runBudgetState, executedToolBatch.results.length))
          if (executedToolBatch.budgetLimited || getRemainingToolCallBudget(state.effectiveRunBudget || alignedRunBudget, state.runBudgetState) <= 0) {
            budgetLimitedBeforeCompletion = true
          }

          for (const executedTool of executedToolBatch.results) {
            const result = executedTool.result as ToolExecutionOutput
            const resultText = result.text
            const serializedResult = serializeToolExecutionOutput(result)
            const toolName = executedTool.name
            const documentToolInspection = inspectDocumentToolCall(toolName, resultText)
            if (documentToolInspection.isDocumentTool) {
              documentToolResultsThisIteration.push(resultText)
              executedDocActionCount += documentToolInspection.executedDocActionCount
              executedMutatingDocActionCount += documentToolInspection.executedMutatingDocActionCount
              executedInspectionDocActionCount += documentToolInspection.executedInspectionDocActionCount
              executedSaveDocActionCount += documentToolInspection.executedSaveDocActionCount
              documentToolLoopState = documentToolLoopOrchestrator.applyToolInspection(
                documentToolLoopState,
                documentToolInspection,
              )
            }
            if (toolName.startsWith('browser_')) {
              executedBrowserToolsThisIteration += 1
            }
            const designResult = designToolLoopOrchestrator.recordToolResult({
              state: designToolLoopState,
              toolName,
              rawResult: resultText,
              policy: toolPolicy,
            })
            if ((result as any).interactionHint === 'awaiting_confirmation') {
              state.interactionState = 'awaiting_confirmation'
            } else if ((result as any).interactionHint === 'awaiting_clarification') {
              state.interactionState = 'awaiting_clarification'
            }
            if (designResult.isPrimaryArtifact) {
              executedPrimaryDesignToolThisIteration = true
              designToolLoopState = designResult.state
            }
            transcript.emitOutput(serializedResult.slice(0, 200), 'tool_result')
            params.onResult({
              executedTool,
              serializedResult,
            })
          }
        }

        if (host.providerContext.useAnthropicProtocol) {
          const assistantContent: Array<Record<string, unknown>> = []
          if (response.text) {
            transcript.emitOutput(response.text, 'text')
            assistantContent.push({ type: 'text', text: response.text })
          }
          for (const toolCall of toolCallsForIteration) {
            assistantContent.push({ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: toolCall.input })
          }
          session.messages.push({ role: 'assistant', content: assistantContent })
          const executedToolBatch = await executeBatch()
          const toolResults: Array<Record<string, unknown>> = []
          consumeExecutedToolBatch(executedToolBatch, {
            onResult: ({ executedTool, serializedResult }) => {
              toolResults.push({ type: 'tool_result', tool_use_id: executedTool.id, content: serializedResult })
            },
          })
          if (toolCallsForIteration.length > 0 && toolCallsForIteration.every((toolCall) => getToolResourceTag(toolCall.name).accessMode === 'read')) {
            if (state.stepBudgetState) {
              state.stepBudgetState = refundIterationBudget({
                taskType: state.resolvedTaskType || 'short_task',
                budget: state.effectiveRunBudget,
                usage: state.runBudgetState,
                stepBudget: {
                  stepId: state.stepBudgetState.stepId || null,
                  maxIterations: Number(state.stepBudgetState.maxIterations || 0),
                  remainingIterations: Number(state.stepBudgetState.remainingIterations || 0),
                },
                warningLevel: state.budgetWarningLevel,
                frozen: false,
                bootstrapBudget: false,
              }).stepBudget
            }
            state.runBudgetState.iterationsUsed = Math.max(0, state.runBudgetState.iterationsUsed - 1)
            state.syncBudgetWarning()
          }
          session.messages.push({ role: 'user', content: toolResults })
        } else if (response.toolTransport === 'text') {
          const historyText = response.rawText || response.text
          if (historyText) {
            session.messages.push({ role: 'assistant', content: historyText })
          }
          if (response.text) {
            transcript.emitOutput(response.text, 'text')
          }
          const textBridgeResults: Array<{ id: string; name: string; result: ToolExecutionOutput }> = []
          const executedToolBatch = await executeBatch()
          consumeExecutedToolBatch(executedToolBatch, {
            onResult: ({ executedTool }) => {
              textBridgeResults.push({ id: executedTool.id, name: executedTool.name, result: executedTool.result as ToolExecutionOutput })
            },
          })
          if (textBridgeResults.length > 0) {
            session.messages.push({ role: 'user', content: buildTextToolResultMessage(textBridgeResults as any) })
          }
          state.syncBudgetWarning()
        } else {
          const assistantMsg: Record<string, unknown> = {
            role: 'assistant',
            content: response.text || null,
            tool_calls: toolCallsForIteration.map((toolCall) => ({
              id: toolCall.id,
              type: 'function',
              function: { name: toolCall.name, arguments: JSON.stringify(toolCall.input) },
            })),
          }
          if (response.providerResponseId) {
            assistantMsg.response_id = response.providerResponseId
          }
          if (response.reasoningContent !== undefined || host.providerContext.isKimiCoding) {
            assistantMsg.reasoning_content = response.reasoningContent ?? ''
          }
          session.messages.push(assistantMsg as any)
          if (response.text) {
            transcript.emitOutput(response.text, 'text')
          }
          const executedToolBatch = await executeBatch()
          consumeExecutedToolBatch(executedToolBatch, {
            onResult: ({ executedTool, serializedResult }) => {
              session.messages.push({
                role: 'tool',
                content: serializedResult,
                ...({ tool_call_id: executedTool.id } as Record<string, unknown>),
              } as any)
            },
          })
          state.syncBudgetWarning()
        }

        if (browserToolLoopState.isBrowserTask && executedBrowserToolsThisIteration > 0) {
          const progress = browserDomainOrchestrator.recordToolLoopProgress({
            state: browserToolLoopState,
            responseText: response.text,
            executedBrowserToolsThisIteration,
          })
          browserToolLoopState = progress.state
          if (progress.checkpointMessage) {
            session.messages.push({ role: 'user', content: progress.checkpointMessage })
          }
        }

        if (response.text) {
          const plannerStepCompleted = detectTaskStepCompletionCue(
            response.text,
            state.runtimeTaskSteps.find((step) => step.id === state.runtimeCurrentStepId),
          )
          if (plannerStepCompleted) {
            const advanced = advancePlannerStep(response.text)
            if (advanced) {
              session.messages.push({
                role: 'user',
                content: `系统提醒：已进入下一步 ${state.runtimeCurrentStepId || ''}，请继续执行。`,
              })
              continue
            }
          }
          if (syncInteractionStateFromAssistantText(response.text)) {
            session.messages.push({ role: 'assistant', content: response.text })
            finishedBeforeLimit = true
            break
          }
        }

        const documentIterationDecision = documentToolLoopOrchestrator.handleIterationResult({
          state: documentToolLoopState,
          forceDocumentTool: (toolPolicy as any).forceDocumentTool,
          documentWidgetTaskKind: (toolPolicy as any).documentWidgetTaskKind,
          executedDocActionCount,
          executedMutatingDocActionCount,
          executedInspectionDocActionCount,
          executedSaveDocActionCount,
          documentToolResultsThisIteration,
        })
        documentToolLoopState = documentIterationDecision.state
        if (documentIterationDecision.nextUserMessage) {
          emitStructuredTaskPayload(documentToolLoopOrchestrator.buildStructuredTaskPayload({
            taskTitle: (toolPolicy as any).documentWidgetTaskKind
              ? '文档组件操作'
              : (toolPolicy as any).preferFormatOnly
                ? '文档格式优化'
                : (toolPolicy as any).preferSectionRewrite
                  ? '章节改写'
                  : '文档修改',
            taskSummary: documentIterationDecision.nextUserMessage,
            state: documentToolLoopState,
            phase: 'blocked',
          }))
          session.messages.push({
            role: 'user',
            content: documentIterationDecision.nextUserMessage,
          })
          continue
        }

        if (documentIterationDecision.completionText) {
          emitStructuredTaskPayload(documentToolLoopOrchestrator.buildStructuredTaskPayload({
            taskTitle: (toolPolicy as any).documentWidgetTaskKind
              ? '文档组件操作'
              : (toolPolicy as any).preferFormatOnly
                ? '文档格式优化'
                : (toolPolicy as any).preferSectionRewrite
                  ? '章节改写'
                  : '文档修改',
            taskSummary: documentIterationDecision.completionText,
            state: documentToolLoopState,
            phase: 'done',
          }))
          transcript.emitOutput(documentIterationDecision.completionText, 'text')
          session.messages.push({ role: 'assistant', content: documentIterationDecision.completionText })
          advancePlannerStep(documentIterationDecision.completionText)
          finishedBeforeLimit = true
          break
        }

        if ((toolPolicy as any).forceDesignTool && !(toolPolicy as any).allowMultipleDesignArtifacts && executedPrimaryDesignToolThisIteration) {
          const completionText = designToolLoopOrchestrator.buildCompletionText(designToolLoopState)
          if (completionText) {
            emitStructuredTaskPayload(designToolLoopOrchestrator.buildStructuredTaskPayload({
              taskTitle: '设计任务',
              taskSummary: completionText,
              state: designToolLoopState,
              phase: 'done',
            }))
            transcript.emitOutput(completionText, 'text')
            session.messages.push({ role: 'assistant', content: completionText })
            advancePlannerStep(completionText)
          }
          finishedBeforeLimit = true
          break
        }

        if (budgetLimitedBeforeCompletion) {
          break
        }
      }

      if (state.interactionState === 'suspended') {
        return finish({ success: true, cancelled: true, status: 'cancelled' })
      }

      if (!finishedBeforeLimit && (iterations >= effectiveMaxToolIterations || budgetLimitedBeforeCompletion)) {
        const browserLimitMessage = browserDomainOrchestrator.buildToolLoopLimitMessage(browserToolLoopState)
        if (browserLimitMessage) {
          session.messages.push({
            role: 'user',
            content: browserLimitMessage,
          })
        }
        transcript.emitOutput(
          budgetLimitedBeforeCompletion
            ? '\n[已达到本轮工具预算上限，请总结当前进度并建议下一步重试方式]'
            : '\n[已达到最大工具调用次数，请尝试让助手使用 browser_run_workflow 或 browser_download_urls 批量执行后重试]',
          'text',
        )
      }

      return finish({ success: true, status: 'done' })
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        state.interactionState = 'suspended'
        state.syncBudgetWarning()
        return finish({ success: true, cancelled: true, status: 'cancelled' })
      }
      const message = error instanceof Error ? error.message : String(error)
      host.log(`Error: ${message}`)
      transcript.emitOutput(`API 请求失败: ${message}`, 'error')
      transcript.emitRuntimeError(message)
      return finish({ success: false, error: message, status: 'error', doneEventType: 'done' })
    }
  }
}
