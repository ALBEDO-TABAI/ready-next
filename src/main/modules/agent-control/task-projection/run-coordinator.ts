import type { ScopeRunMemoryCapture, ScopeRunEventPayload, ConversationScope } from '../contracts/types'
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
  TaskType,
} from '../contracts/run-contracts'
import {
  createRunBudgetSeed,
  createTaskBudgetRuntime,
  getBudgetUsagePercent,
  rebindTaskBudgetRuntime,
} from './run-budget-policy'
import { buildExecutionFallbackState } from '../../claude-bridge/execution-fallback-policy'
import { randomUUID } from 'node:crypto'
import type { TurnTerminalReason } from '../runtime-core/turn-frame'
import type { AgentExecutionProfile, TaskCreationOrigin, TaskExecutionBinding } from '../../../../shared/agent-execution-profile'
import { runOriginForRequest } from './task-agent-binding'

function phaseFromTerminalReason(reason: TurnTerminalReason | null | undefined, success?: boolean): ScopeRunEventPayload['phase'] | null {
  if (!reason) return null
  if (reason === 'done') return 'done'
  if (reason === 'adjudication_degraded') return success ? 'done' : 'error'
  if (reason === 'cancelled_runtime' || reason === 'cancelled_user' || reason === 'main_no_progress_timeout') return 'cancelled'
  if (reason === 'failed_skill' || reason === 'resume_launch_failed' || reason === 'persistence_failed') return 'error'
  return 'checkpoint'
}

function resolveInitialTaskTypeFromPrepared(prepared: PreparedRunPayload): TaskType {
  const primaryDomain = prepared.intentClassification?.primaryDomain
  if (primaryDomain === 'research') return 'research'
  if (primaryDomain === 'skill') return 'multi_step_task'

  const modules = new Set((prepared.triggerHits || []).map((trigger) => String(trigger.module || '').trim()))
  if (modules.has('research')) return 'research'
  if (modules.has('skill')) return 'multi_step_task'
  return 'short_task'
}

export class RunCoordinator {
  constructor(private readonly deps: {
    promptAssembly: {
      buildForScopedRun: (params: {
        scope: ConversationScope
        message: RunMessage
        coordinators: RunCoordinatorRequest['coordinators']
        workspaceRoots?: string[]
        contextRefIds?: string[]
        trustedFolderReferences?: RunCoordinatorRequest['trustedFolderReferences']
        trustedEnvironment?: RunCoordinatorRequest['trustedEnvironment']
        /** EP3-A4 — the scope's effective owner; switches A2 injection. */
        ownerAgentId?: string | null
        executionProfile: AgentExecutionProfile
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
    getTaskProjection?: (taskId: string) => { scopeId?: string; ownerAgentId?: string | null; taskOrigin: TaskCreationOrigin } | null
    resolveExecutionProfile?: (agentId: string) => Promise<AgentExecutionProfile>
    createExecutionBinding?: (input: {
      profile: AgentExecutionProfile
      runId: string
      ownerAgentIdAtStart: string
      runOrigin: TaskExecutionBinding['runOrigin']
      ownerAssignmentSource: TaskExecutionBinding['ownerAssignmentSource']
    }) => TaskExecutionBinding
    persistRunBinding?: (input: {
      runId: string
      taskId: string
      scopeId: string
      sessionAgentId: string
      executionBinding: TaskExecutionBinding
    }) => void
    getConversationScope?: (scopeId: string) => ConversationScope | null
    getPendingHandoff?: (taskId: string) => {
      targetAgentId: string
      handoffGeneration: number
      userRequestVerbatim: string
      contextRefIds: string[]
    } | null
    markHandoffConsumed?: (taskId: string, handoffGeneration: number) => void | Promise<void>
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
    const runId = request.requestId || `run-${randomUUID()}`
    const existingTask = request.taskId ? this.deps.getTaskProjection?.(request.taskId) ?? null : null
    if (existingTask?.scopeId && existingTask.scopeId !== request.scope.id) {
      throw new Error('[run-coordinator] continuation task does not belong to scope')
    }
    const hasScheduledSource = Boolean(request.scheduledTaskOccurrence)
    if (hasScheduledSource !== (request.runOrigin === 'scheduled_task')) {
      throw new Error('[run-coordinator] scheduled task origin and occurrence source must be provided together')
    }
    if (request.runOrigin === 'scheduled_task' && request.taskOrigin !== 'system_background') {
      throw new Error('[run-coordinator] scheduled task requires system_background task origin')
    }
    if (existingTask && request.taskOrigin && request.taskOrigin !== existingTask.taskOrigin) {
      throw new Error('[run-coordinator] task creation origin is immutable')
    }
    const taskOrigin: TaskCreationOrigin = existingTask?.taskOrigin
      ?? request.taskOrigin
      ?? (request.parentTaskId ? 'workflow_child' : 'user_root')
    const ownerAgentId = existingTask?.ownerAgentId || request.scope.activeAgentId || request.scope.agent
    if (!ownerAgentId) throw new Error('[run-coordinator] task owner is required')
    const executionProfile = this.deps.resolveExecutionProfile
      ? await this.deps.resolveExecutionProfile(ownerAgentId)
      : {
        requestedAgentId: ownerAgentId, effectiveAgentId: ownerAgentId, personaRef: ownerAgentId,
        name: ownerAgentId, charter: '', personality: '', rules: '', knowledgeIndex: '', allowedKnowledgeRefs: [],
        knowledgeWriteOwnerAgentId: ownerAgentId, knowledgeWriteNamespace: `agents/${ownerAgentId}/knowledge`,
        executionMaterialHash: `legacy-test-${ownerAgentId}`, readinessRevision: `legacy-test-${ownerAgentId}`,
        redirectChain: [], readiness: { conversationReady: true, handoffReady: false, autoRoutable: false, collaborationReady: false, reasons: ['legacy_test_fallback'] },
      } satisfies AgentExecutionProfile
    const bindingInput = {
      profile: executionProfile,
      runId,
      ownerAgentIdAtStart: ownerAgentId,
      runOrigin: request.runOrigin ?? runOriginForRequest({ isContinuation: Boolean(existingTask || request.continuationIntent) }),
      ownerAssignmentSource: request.runOrigin === 'handoff_takeover'
        ? 'handoff'
        : request.runOrigin === 'scheduled_task'
          ? 'scheduled_task'
        : existingTask ? 'continuation' : request.parentTaskId ? 'parent_task' : 'conversation_active',
    } as const
    const executionBinding = request.preboundExecutionBinding
      ?? (this.deps.createExecutionBinding
        ? this.deps.createExecutionBinding(bindingInput)
        : {
        schemaVersion: 1, runId, ownerAgentIdAtStart: ownerAgentId, runOrigin: bindingInput.runOrigin,
        kind: 'registered_agent', requestedAgentId: ownerAgentId, effectiveAgentId: ownerAgentId,
        executionMaterialHash: executionProfile.executionMaterialHash,
        ownerAssignmentSource: bindingInput.ownerAssignmentSource, executionSelectionSource: 'task_owner', resolutionKind: 'direct',
      } satisfies TaskExecutionBinding)
    if (
      executionBinding.runId !== runId
      || executionBinding.ownerAgentIdAtStart !== ownerAgentId
      || executionBinding.executionMaterialHash !== executionProfile.executionMaterialHash
    ) {
      throw new Error('[run-coordinator] prebound execution binding does not match durable owner')
    }
    if (!request.preboundExecutionBinding) {
      this.deps.persistRunBinding?.({
        runId,
        taskId,
        scopeId: request.scope.id,
        sessionAgentId: request.scope.agent,
        executionBinding,
      })
    }
    const prepared = await this.deps.promptAssembly.buildForScopedRun({
      scope: request.scope,
      message: request.message,
      coordinators: request.coordinators,
      workspaceRoots: request.workspaceRoots,
      contextRefIds: request.contextRefIds,
      trustedFolderReferences: request.trustedFolderReferences,
      trustedEnvironment: request.trustedEnvironment,
      // EP3-A4 — adoption switched the scope's owner; this is where the
      // next turn's injection follows it (A2 channel).
      ownerAgentId,
      executionProfile,
    })
    const initialTaskType = request.budget ? 'short_task' : resolveInitialTaskTypeFromPrepared(prepared)
    const budget = request.budget || createRunBudgetSeed(initialTaskType)
    const budgetState: RunBudgetUsage = {
      iterationsUsed: 0,
      toolCallsUsed: 0,
      parallelToolGroupsUsed: 0,
    }
    const taskBudgetRuntime = createTaskBudgetRuntime(initialTaskType, {
      budget,
      usage: { ...budgetState },
      bootstrapBudget: !request.budget && initialTaskType === 'short_task',
    })
    const messageWithBootstrap = this.deps.promptAssembly.applyToMessage(request.message, prepared)

    // P1 fix (2026-07-03, live regression) — cross-cutting site-experience
    // cards are injected context, NOT task descriptors. Skip them so the
    // placeholder falls back to the neutral "正在理解需求", which the real
    // task title later replaces. Browser discipline is now a per-turn runtime
    // instruction and no longer appears in triggerHits.
    //
    // 2026-07-04 真机回归第三轮追加：browser-collect-notes / browser-upload
    // 同为流程知识片段（注入指导≠任务名）——此前发布 run 被贴"浏览器逐篇
    // 采集"标题、大量浏览器任务卡长期顶着"浏览器上传流程"（hit_count=35），
    // 语义同病，一并排除出标题选择。
    const isCrossCuttingTrigger = (id: string | undefined): boolean =>
      typeof id === 'string' && (
        id === 'browser-collect-notes'
        || id === 'browser-upload'
        || id.startsWith('site-card-')
      )
    const titleTriggers = prepared.triggerHits.filter((trigger) => !isCrossCuttingTrigger(trigger.id))
    const primaryTrigger = prepared.intentClassification?.primaryDomain === 'skill'
      ? titleTriggers.find((trigger) => trigger.blocking)
      : titleTriggers[0]
    const planningTaskTitle = primaryTrigger?.label || '正在理解需求'
    const planningTaskSummary = primaryTrigger
      ? `准备开始 ${primaryTrigger.label}`
      : '正在整理任务边界、上下文与可用能力'

    this.deps.emitScopeRunEvent({
      type: 'started',
      scopeId: request.scope.id,
      agent: request.scope.agent,
      runId,
      taskId,
      ownerAgentId,
      taskOrigin,
      executionBinding,
      executionAgentDisplayName: executionProfile.name,
      handoffGeneration: request.scope.handoffGeneration,
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
      sessionAgentId: request.scope.agent,
      executionBinding,
      executionProfile,
      sessionId: request.scope.id,
      sessionIdOverride: request.sessionIdOverride,
      requestId: runId,
      sourceMessageId: request.sourceMessageId ?? null,
      scheduledTaskOccurrence: request.scheduledTaskOccurrence,
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
      deliveryMode: request.deliveryMode,
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
    const projectionInteractionState =
      projectionPatch?.interactionState === 'running'
      || projectionPatch?.interactionState === 'awaiting_clarification'
      || projectionPatch?.interactionState === 'awaiting_confirmation'
      || projectionPatch?.interactionState === 'human_takeover'
      || projectionPatch?.interactionState === 'suspended'
      || projectionPatch?.interactionState === 'resuming'
      || projectionPatch?.interactionState === 'check_in_pending'
        ? projectionPatch.interactionState
        : undefined
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
        : projectionPatch?.continuationRef && typeof projectionPatch.continuationRef === 'object'
          ? projectionPatch.continuationRef as ScopeRunEventPayload['taskContinuation']
        : undefined
    const lifecycleSignal = result.skillTaskLifecycle || null
    const finalInteractionState = lifecycleSignal?.interactionState
      || projectionInteractionState
      || (result.terminalReason === 'manual_suspend' ? 'suspended' : result.interactionState)
    const finalWaitingFor = lifecycleSignal ? lifecycleSignal.waitingFor : projectionWaitingFor
    const finalResumableActions = lifecycleSignal
      ? lifecycleSignal.resumableActions
      : result.terminalReason === 'manual_suspend'
        ? (projectionResumableActions as ScopeRunEventPayload['resumableActions'] | undefined) || ['cancel']
        : projectionResumableActions as ScopeRunEventPayload['resumableActions'] | undefined
    const finalBlockedReason = lifecycleSignal
      ? lifecycleSignal.blockedReason
      : result.terminalReason === 'manual_suspend'
        ? projectionBlockedReason || '任务已暂停，等待继续。'
        : projectionBlockedReason
    const finalTaskContinuation = lifecycleSignal
      ? lifecycleSignal.taskContinuation
      : projectionTaskContinuation
    const hasRecoverableWait = Boolean(
      (finalWaitingFor && finalWaitingFor !== 'none')
      || finalBlockedReason
      || (finalInteractionState && finalInteractionState !== 'running'),
    )
    const terminalPhase = phaseFromTerminalReason(result.terminalReason, result.success)
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
      runId,
      taskId,
      ownerAgentId,
      taskOrigin,
      executionBinding,
      executionAgentDisplayName: executionProfile.name,
      handoffGeneration: request.scope.handoffGeneration,
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
      contextUsage: result.contextUsage ?? result.executionDiagnostics?.contextUsage ?? null,
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
        contextUsage: result.contextUsage ?? result.executionDiagnostics?.contextUsage ?? null,
      },
      timestamp: new Date().toISOString(),
    }, result.projectionTruth || null)

    if (!result.success) {
      await hooks?.onFailure?.(result.error || 'Agent execution failed', result)
      return {
        success: false,
        error: result.error || 'Agent execution failed',
        errorKind: result.terminalReason || undefined,
        scopeRunAuthority: result.scopeRunAuthority,
        canonicalMessage: result.canonicalMessage,
        canonicalMessageDigest: result.canonicalMessageDigest,
      }
    }

    if (result.terminalReason === 'manual_suspend') {
      const handoff = this.deps.getPendingHandoff?.(taskId) ?? null
      if (!handoff || handoff.handoffGeneration <= request.scope.handoffGeneration) {
        return {
          success: true,
          canonicalMessage: result.canonicalMessage,
          canonicalMessageDigest: result.canonicalMessageDigest,
        }
      }
      const takeoverScope = this.deps.getConversationScope?.(request.scope.id) ?? null
      if (!takeoverScope || takeoverScope.activeAgentId !== handoff.targetAgentId) {
        return { success: false, error: 'handoff_takeover_scope_mismatch' }
      }
      const takeoverResult = await this.executeRun({
        ...request,
        scope: takeoverScope,
        message: handoff.userRequestVerbatim,
        requestId: undefined,
        taskId,
        contextRefIds: handoff.contextRefIds,
        continuationIntent: null,
        runOrigin: 'handoff_takeover',
      }, hooks)
      if (takeoverResult.success) {
        await this.deps.markHandoffConsumed?.(taskId, handoff.handoffGeneration)
      }
      return takeoverResult
    }

    await hooks?.onSuccess?.(result)

    this.deps.reflectOnConversation(request.scope, result.usedTools)
      .then(async (memoryCapture) => {
        if (!memoryCapture || memoryCapture.items.length === 0) return
        this.deps.emitScopeRunEvent({
          type: 'updated',
          scopeId: request.scope.id,
          agent: request.scope.agent,
          runId,
          taskId,
          ownerAgentId,
          taskOrigin,
          executionBinding,
          executionAgentDisplayName: executionProfile.name,
          handoffGeneration: request.scope.handoffGeneration,
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

    return {
      success: true,
      responseText: result.finalText,
      canonicalMessage: result.canonicalMessage,
      canonicalMessageDigest: result.canonicalMessageDigest,
    }
  }
}
