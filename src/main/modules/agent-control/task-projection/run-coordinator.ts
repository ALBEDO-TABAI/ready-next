import type { ScopeRunMemoryCapture, ScopeRunEventPayload, ConversationScope } from '../types'
import type {
  ExecutionHostRequest,
  ExecutionHostResult,
  ProjectionTruthSnapshot,
  PreparedRunPayload,
  ReflectionResultHook,
  RunCompletionHooks,
  RunCoordinatorRequest,
  RunCoordinatorResult,
  RunMessage,
  RunBudgetUsage,
} from '../run-contracts'
import {
  createRunBudgetSeed,
  createTaskBudgetRuntime,
  getBudgetUsagePercent,
  rebindTaskBudgetRuntime,
} from './run-budget-policy'
import { buildExecutionFallbackState } from '../../claude-bridge/execution-fallback-policy'
import { randomUUID } from 'node:crypto'
import type { TurnTerminalReason } from '../turn-frame'

function phaseFromTerminalReason(reason: TurnTerminalReason | null | undefined): ScopeRunEventPayload['phase'] | null {
  if (!reason) return null
  if (reason === 'done') return 'done'
  if (reason === 'cancelled_runtime' || reason === 'cancelled_user') return 'cancelled'
  if (reason === 'failed_skill' || reason === 'resume_launch_failed' || reason === 'persistence_failed') return 'error'
  return 'checkpoint'
}

export class RunCoordinator {
  constructor(private readonly deps: {
    promptAssembly: {
      buildForScopedRun: (params: {
        scope: ConversationScope
        message: RunMessage
        coordinators: RunCoordinatorRequest['coordinators']
      }) => Promise<PreparedRunPayload>
      applyToMessage: (message: RunMessage, prepared: PreparedRunPayload) => RunMessage
      recordRunOutcome: (payload: {
        scope: ConversationScope
        finalText: string
        usedTools: string[]
        success: boolean
        lifecyclePhase?: ScopeRunEventPayload['phase']
        interactionState?: ScopeRunEventPayload['interactionState']
        waitingFor?: ScopeRunEventPayload['waitingFor']
        blockedReason?: string | null
        resumableActions?: ScopeRunEventPayload['resumableActions']
        taskContinuation?: ScopeRunEventPayload['taskContinuation']
      }) => void
    }
    executeAndCollect: (request: ExecutionHostRequest) => Promise<ExecutionHostResult>
    emitScopeRunEvent: (payload: ScopeRunEventPayload, projectionTruth?: ProjectionTruthSnapshot | null) => void
    reflectOnConversation: (scope: ConversationScope, usedTools: string[]) => Promise<ScopeRunMemoryCapture | null>
  }) {}

  async runScoped(
    request: RunCoordinatorRequest,
    hooks?: RunCompletionHooks & ReflectionResultHook,
  ): Promise<RunCoordinatorResult> {
    return this.executeRun(request, hooks)
  }

  async runInboundChannel(
    request: RunCoordinatorRequest,
    hooks?: RunCompletionHooks & ReflectionResultHook,
  ): Promise<RunCoordinatorResult> {
    return this.executeRun(request, hooks)
  }

  private async executeRun(
    request: RunCoordinatorRequest,
    hooks?: RunCompletionHooks & ReflectionResultHook,
  ): Promise<RunCoordinatorResult> {
    const taskId = request.taskId || `task-${randomUUID()}`
    const budget = request.budget || createRunBudgetSeed()
    const budgetState: RunBudgetUsage = {
      iterationsUsed: 0,
      toolCallsUsed: 0,
      parallelToolGroupsUsed: 0,
    }
    const taskBudgetRuntime = createTaskBudgetRuntime('short_task', {
      budget,
      usage: { ...budgetState },
      bootstrapBudget: !request.budget,
    })
    const prepared = await this.deps.promptAssembly.buildForScopedRun({
      scope: request.scope,
      message: request.message,
      coordinators: request.coordinators,
    })
    const messageWithBootstrap = this.deps.promptAssembly.applyToMessage(request.message, prepared)

    const primaryTrigger = prepared.intentClassification?.primaryDomain === 'skill'
      ? prepared.triggerHits.find((trigger) => trigger.blocking)
      : prepared.triggerHits[0]
    const planningTaskTitle = primaryTrigger?.label || '正在理解需求'
    const planningTaskSummary = primaryTrigger
      ? `准备开始 ${primaryTrigger.label}`
      : '正在整理任务边界、上下文与可用能力'

    this.deps.emitScopeRunEvent({
      type: 'started',
      scopeId: request.scope.id,
      agent: request.scope.agent,
      runId: request.requestId,
      taskId,
      parentTaskId: request.parentTaskId,
      parentStepId: request.parentStepId,
      phase: 'planning',
      module: primaryTrigger?.module,
      latestText: planningTaskSummary,
      taskTitle: planningTaskTitle,
      taskSummary: planningTaskSummary,
      taskProjectionId: taskId,
      memoryRefs: prepared.memoryRefs,
      triggerHits: prepared.triggerHits,
      contextBudget: prepared.contextBudget,
      executionDiagnostics: {
        taskId,
        taskBudgetRuntime,
        compression: prepared.compression || null,
        budget,
        fallback: buildExecutionFallbackState(null),
      },
      timestamp: new Date().toISOString(),
    })

    const result = await this.deps.executeAndCollect({
      agent: request.scope.agent,
      sessionId: request.scope.id,
      sessionIdOverride: request.sessionIdOverride,
      requestId: request.requestId,
      taskId,
      parentTaskId: request.parentTaskId,
      parentStepId: request.parentStepId,
      systemPrompt: prepared.systemPrompt,
      message: messageWithBootstrap,
      requestEnvelope: prepared.requestEnvelope,
      intentClassification: prepared.intentClassification,
      budget,
      budgetState,
      taskBudgetRuntime,
      continuationIntent: request.continuationIntent || null,
    })

    const resolvedTaskBudgetRuntime = result.taskBudgetRuntime
      || result.executionDiagnostics?.taskBudgetRuntime
      || (
        result.taskType && taskBudgetRuntime.bootstrapBudget
          ? rebindTaskBudgetRuntime(taskBudgetRuntime, result.taskType, {
            bootstrapBudget: false,
          })
          : null
      )
    const resolvedBudgetDiagnostics = resolvedTaskBudgetRuntime
      ? {
        ...resolvedTaskBudgetRuntime.budget,
        ...resolvedTaskBudgetRuntime.usage,
      }
      : {
        ...budget,
        ...(result.budgetState || budgetState),
      }

    const projectionPatch = result.projectionTruth?.projectionPatch
    const projectionTaskTitle =
      typeof projectionPatch?.taskTitle === 'string' ? projectionPatch.taskTitle : undefined
    const projectionTaskSummary =
      typeof projectionPatch?.taskSummary === 'string' ? projectionPatch.taskSummary : undefined
    const projectionSteps = Array.isArray(projectionPatch?.steps) ? projectionPatch.steps : undefined
    const projectionCurrentStepId =
      typeof projectionPatch?.currentStepId === 'string' ? projectionPatch.currentStepId : undefined
    const projectionWaitingFor =
      projectionPatch?.waitingFor === 'input'
      || projectionPatch?.waitingFor === 'confirmation'
      || projectionPatch?.waitingFor === 'agent_result'
      || projectionPatch?.waitingFor === 'clarification'
      || projectionPatch?.waitingFor === 'background'
      || projectionPatch?.waitingFor === 'none'
        ? projectionPatch.waitingFor
        : undefined
    const projectionResumableActions = Array.isArray(projectionPatch?.resumableActions)
      ? projectionPatch.resumableActions
      : undefined
    const projectionBlockedReason =
      typeof projectionPatch?.blockedReason === 'string'
        ? projectionPatch.blockedReason
        : projectionPatch?.blockedReason === null
          ? null
          : undefined
    const projectionTaskContinuation =
      projectionPatch?.taskContinuation && typeof projectionPatch.taskContinuation === 'object'
        ? projectionPatch.taskContinuation as ScopeRunEventPayload['taskContinuation']
        : undefined
    const lifecycleSignal = result.skillTaskLifecycle || null
    const finalInteractionState = lifecycleSignal?.interactionState || result.interactionState
    const finalWaitingFor = lifecycleSignal ? lifecycleSignal.waitingFor : projectionWaitingFor
    const finalResumableActions = lifecycleSignal
      ? lifecycleSignal.resumableActions
      : projectionResumableActions as ScopeRunEventPayload['resumableActions'] | undefined
    const finalBlockedReason = lifecycleSignal
      ? lifecycleSignal.blockedReason
      : projectionBlockedReason
    const finalTaskContinuation = lifecycleSignal
      ? lifecycleSignal.taskContinuation
      : projectionTaskContinuation
    const hasRecoverableWait = Boolean(
      (finalWaitingFor && finalWaitingFor !== 'none')
      || finalBlockedReason
      || (finalInteractionState && finalInteractionState !== 'running'),
    )
    const terminalPhase = phaseFromTerminalReason(result.terminalReason)
    const finalPhase: ScopeRunEventPayload['phase'] = result.cancelled
      ? 'cancelled'
      : lifecycleSignal
        ? lifecycleSignal.phase
        : terminalPhase
          ? terminalPhase
        : result.success
        ? hasRecoverableWait ? 'checkpoint' : 'done'
        : 'error'

    this.deps.promptAssembly.recordRunOutcome({
      scope: request.scope,
      finalText: result.finalText,
      usedTools: result.usedTools,
      success: result.success && finalPhase === 'done',
      lifecyclePhase: finalPhase,
      interactionState: finalInteractionState,
      waitingFor: finalWaitingFor,
      blockedReason: finalBlockedReason,
      resumableActions: finalResumableActions,
      taskContinuation: finalTaskContinuation,
    })

    this.deps.emitScopeRunEvent({
      type: 'updated',
      scopeId: request.scope.id,
      agent: request.scope.agent,
      runId: request.requestId,
      taskId,
      parentTaskId: request.parentTaskId,
      parentStepId: request.parentStepId,
      phase: finalPhase,
      terminalReason: result.terminalReason || null,
      taskType: result.taskType,
      interactionState: finalInteractionState,
      taskTitle: projectionTaskTitle,
      taskSummary: projectionTaskSummary,
      steps: projectionSteps as ScopeRunEventPayload['steps'],
      currentStepId: projectionCurrentStepId,
      waitingFor: finalWaitingFor,
      resumableActions: finalResumableActions,
      blockedReason: finalBlockedReason,
      taskContinuation: finalTaskContinuation,
      taskProjectionId: result.taskProjectionId || result.taskId || taskId,
      executionDiagnostics: {
        taskId: result.taskId || taskId,
        taskBudgetRuntime: resolvedTaskBudgetRuntime || taskBudgetRuntime,
        compression: prepared.compression || null,
        budget: resolvedBudgetDiagnostics,
        budgetUsagePercent: result.executionDiagnostics?.budgetUsagePercent
          ?? (resolvedTaskBudgetRuntime ? getBudgetUsagePercent(resolvedTaskBudgetRuntime) : null),
        stepBudget: result.executionDiagnostics?.stepBudget ?? null,
        fallback: buildExecutionFallbackState(result.executionDiagnostics?.fallback || null),
        budgetLease: result.executionDiagnostics?.budgetLease ?? null,
        toolSnapshots: result.executionDiagnostics?.toolSnapshots ?? null,
        toolResolution: result.executionDiagnostics?.toolResolution ?? null,
        recoveryHistory: result.executionDiagnostics?.recoveryHistory ?? null,
        degradationReason: result.executionDiagnostics?.degradationReason ?? null,
        pipeline: result.executionDiagnostics?.pipeline ?? null,
      },
      timestamp: new Date().toISOString(),
    }, result.projectionTruth || null)

    if (!result.success) {
      await hooks?.onFailure?.(result.error || 'Agent execution failed', result)
      return { success: false, error: result.error || 'Agent execution failed' }
    }

    await hooks?.onSuccess?.(result)

    this.deps.reflectOnConversation(request.scope, result.usedTools)
      .then(async (memoryCapture) => {
        if (!memoryCapture || memoryCapture.items.length === 0) return
        this.deps.emitScopeRunEvent({
          type: 'updated',
          scopeId: request.scope.id,
          agent: request.scope.agent,
          runId: request.requestId,
          taskId,
          phase: finalPhase,
          terminalReason: result.terminalReason || null,
          interactionState: finalPhase === 'done' ? undefined : finalInteractionState,
          waitingFor: finalPhase === 'done' ? undefined : finalWaitingFor,
          resumableActions: finalPhase === 'done' ? undefined : finalResumableActions,
          blockedReason: finalPhase === 'done' ? undefined : finalBlockedReason,
          taskContinuation: finalPhase === 'done' ? undefined : finalTaskContinuation,
          memoryCapture,
          timestamp: new Date().toISOString(),
        })
        await hooks?.onMemoryCapture?.(memoryCapture)
      })
      .catch((error) => {
        console.error('[RunCoordinator] Reflection failed:', error)
      })

    return { success: true }
  }
}
