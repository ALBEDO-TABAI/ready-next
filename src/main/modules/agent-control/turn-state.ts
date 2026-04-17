import {
  createRunBudgetSeed,
  createTaskBudgetRuntime,
  getBudgetUsagePercent,
  rebindTaskBudgetRuntime,
} from './run-budget-policy'
import type {
  BudgetWarningLevel,
  ContinuationBudgetRestoreDiagnostics,
  ExecutionRunDiagnostics,
  ExecutionTurnResult,
  RecoveryRecord,
  RunBudgetSeed,
  RunBudgetUsage,
  StepBudgetState,
  TaskBudgetRuntime,
  TaskInteractionState,
  TaskStep,
  TaskType,
  ToolSnapshot,
} from './run-contracts'

export class TurnState {
  readonly taskId: string
  taskBudgetRuntime: TaskBudgetRuntime | null
  effectiveRunBudget: RunBudgetSeed | null
  readonly runBudgetState: RunBudgetUsage
  resolvedTaskType: TaskType | undefined
  interactionState: TaskInteractionState
  degradationReason: string | null
  continuationBudgetRestore: ContinuationBudgetRestoreDiagnostics | null
  stepBudgetState: StepBudgetState | null
  budgetWarningLevel: BudgetWarningLevel
  latestFallback: ExecutionRunDiagnostics['fallback']
  recoveryHistory: RecoveryRecord[]
  runtimeTaskSteps: TaskStep[]
  runtimeCurrentStepId: string | null
  pipelineDiagnostics: ExecutionRunDiagnostics['pipeline']
  toolSnapshots: ToolSnapshot[]
  toolResolution: ExecutionRunDiagnostics['toolResolution']

  constructor(params: {
    taskId: string
    taskBudgetRuntime?: TaskBudgetRuntime | null
    budget?: RunBudgetSeed | null
    budgetState?: RunBudgetUsage | null
  }) {
    this.taskId = params.taskId
    this.taskBudgetRuntime = params.taskBudgetRuntime
      ? {
        ...params.taskBudgetRuntime,
        budget: { ...params.taskBudgetRuntime.budget },
        usage: { ...params.taskBudgetRuntime.usage },
        stepBudget: params.taskBudgetRuntime.stepBudget
          ? { ...params.taskBudgetRuntime.stepBudget }
          : null,
      }
      : null
    this.effectiveRunBudget = this.taskBudgetRuntime?.budget || (params.budget ? { ...params.budget } : null)
    this.runBudgetState = this.taskBudgetRuntime?.usage
      ? { ...this.taskBudgetRuntime.usage }
      : params.budgetState
        ? { ...params.budgetState }
        : {
          iterationsUsed: 0,
          toolCallsUsed: 0,
          parallelToolGroupsUsed: 0,
        }
    this.resolvedTaskType = undefined
    this.interactionState = this.taskBudgetRuntime?.frozen ? 'suspended' : 'running'
    this.degradationReason = null
    this.continuationBudgetRestore = null
    this.stepBudgetState = this.taskBudgetRuntime?.stepBudget
      ? { ...this.taskBudgetRuntime.stepBudget }
      : null
    this.budgetWarningLevel = 'none'
    this.latestFallback = null
    this.recoveryHistory = []
    this.runtimeTaskSteps = []
    this.runtimeCurrentStepId = null
    this.pipelineDiagnostics = null
    this.toolSnapshots = []
    this.toolResolution = null
  }

  syncTaskBudgetRuntime(taskType?: TaskType): TaskBudgetRuntime | null {
    const resolvedTaskType = taskType || this.resolvedTaskType || this.taskBudgetRuntime?.taskType || 'short_task'
    if (!this.effectiveRunBudget) return null
    this.taskBudgetRuntime = createTaskBudgetRuntime(resolvedTaskType, {
      budget: this.effectiveRunBudget,
      usage: this.runBudgetState,
      stepBudget: this.stepBudgetState
        ? {
          stepId: this.stepBudgetState.stepId || null,
          maxIterations: Number(this.stepBudgetState.maxIterations || 0),
          remainingIterations: Number(this.stepBudgetState.remainingIterations || 0),
        }
        : null,
      frozen: this.interactionState === 'suspended',
      bootstrapBudget: this.taskBudgetRuntime?.bootstrapBudget,
    })
    this.taskBudgetRuntime.warningLevel = this.budgetWarningLevel
    return this.taskBudgetRuntime
  }

  syncBudgetWarning(): BudgetWarningLevel {
    const resolvedTaskType = this.resolvedTaskType || this.taskBudgetRuntime?.taskType || 'short_task'
    if (!this.effectiveRunBudget) {
      this.budgetWarningLevel = 'none'
      return this.budgetWarningLevel
    }
    this.budgetWarningLevel = createTaskBudgetRuntime(resolvedTaskType, {
      budget: this.effectiveRunBudget,
      usage: this.runBudgetState,
      stepBudget: this.stepBudgetState
        ? {
          stepId: this.stepBudgetState.stepId || null,
          maxIterations: Number(this.stepBudgetState.maxIterations || 0),
          remainingIterations: Number(this.stepBudgetState.remainingIterations || 0),
        }
        : null,
      frozen: this.interactionState === 'suspended',
      bootstrapBudget: this.taskBudgetRuntime?.bootstrapBudget,
    }).warningLevel
    this.syncTaskBudgetRuntime(resolvedTaskType)
    return this.budgetWarningLevel
  }

  adoptResolvedTaskTypeBudget(taskType: TaskType): void {
    this.resolvedTaskType = taskType
    if (this.taskBudgetRuntime?.bootstrapBudget) {
      this.taskBudgetRuntime = rebindTaskBudgetRuntime(this.taskBudgetRuntime, taskType, {
        bootstrapBudget: false,
      })
      this.effectiveRunBudget = { ...this.taskBudgetRuntime.budget }
      this.stepBudgetState = this.taskBudgetRuntime.stepBudget
        ? { ...this.taskBudgetRuntime.stepBudget }
        : this.stepBudgetState
      this.budgetWarningLevel = this.taskBudgetRuntime.warningLevel
      return
    }
    if (!this.effectiveRunBudget) {
      this.effectiveRunBudget = createRunBudgetSeed(taskType)
    }
  }

  setRouteState(params: {
    taskType: TaskType
    degradationReason?: string | null
    continuationBudgetRestore?: ContinuationBudgetRestoreDiagnostics | null
    interactionState?: TaskInteractionState
    stepBudgetState?: StepBudgetState | null
    runtimeTaskSteps?: TaskStep[]
    runtimeCurrentStepId?: string | null
  }): void {
    this.resolvedTaskType = params.taskType
    this.degradationReason = params.degradationReason || null
    this.continuationBudgetRestore = params.continuationBudgetRestore || null
    if (params.interactionState) {
      this.interactionState = params.interactionState
    }
    if (params.stepBudgetState) {
      this.stepBudgetState = { ...params.stepBudgetState }
    }
    if (params.runtimeTaskSteps) {
      this.runtimeTaskSteps = params.runtimeTaskSteps.map((step) => ({ ...step }))
    }
    if (typeof params.runtimeCurrentStepId !== 'undefined') {
      this.runtimeCurrentStepId = params.runtimeCurrentStepId
    }
  }

  appendRecoveryHistory(entries: RecoveryRecord[] | null | undefined): void {
    if (!entries || entries.length === 0) return
    this.recoveryHistory = this.recoveryHistory.concat(entries)
    if (!this.degradationReason && entries.some((entry) => entry.kind === 'host_unavailable')) {
      this.degradationReason = 'host_unavailable'
    }
  }

  setPipelineDiagnostics(pipeline: ExecutionRunDiagnostics['pipeline']): void {
    this.pipelineDiagnostics = pipeline || null
  }

  appendToolSnapshots(entries: ToolSnapshot[] | null | undefined): void {
    if (!entries || entries.length === 0) return
    this.toolSnapshots = this.toolSnapshots.concat(entries.map((entry) => ({
      ...entry,
      visibleCapabilityGroupIds: [...entry.visibleCapabilityGroupIds],
      suppressedCapabilityGroupIds: [...entry.suppressedCapabilityGroupIds],
      allowedToolNames: [...entry.allowedToolNames],
    })))
  }

  setToolResolution(resolution: ExecutionRunDiagnostics['toolResolution']): void {
    if (!resolution) {
      this.toolResolution = null
      return
    }
    this.toolResolution = {
      visibleGroupToolCounts: resolution.visibleGroupToolCounts
        ? { ...resolution.visibleGroupToolCounts }
        : undefined,
      groupSchemaErrors: resolution.groupSchemaErrors
        ? { ...resolution.groupSchemaErrors }
        : undefined,
      usedStaticFallbackGroups: resolution.usedStaticFallbackGroups
        ? [...resolution.usedStaticFallbackGroups]
        : undefined,
      invariantViolations: resolution.invariantViolations
        ? [...resolution.invariantViolations]
        : undefined,
    }
  }

  buildExecutionDiagnostics(): ExecutionRunDiagnostics {
    const runtime = this.syncTaskBudgetRuntime()
    return {
      taskId: this.taskId,
      taskBudgetRuntime: runtime,
      budget: this.effectiveRunBudget || this.runBudgetState
        ? {
          ...(this.effectiveRunBudget || {}),
          ...(this.runBudgetState || {}),
        }
        : null,
      budgetUsagePercent: runtime ? getBudgetUsagePercent(runtime) : null,
      stepBudget: this.stepBudgetState,
      budgetWarningLevel: this.budgetWarningLevel,
      fallback: this.latestFallback || null,
      toolSnapshots: this.toolSnapshots.length > 0 ? this.toolSnapshots : null,
      toolResolution: this.toolResolution,
      recoveryHistory: this.recoveryHistory.length > 0 ? this.recoveryHistory : null,
      continuationBudgetRestore: this.continuationBudgetRestore,
      degradationReason: this.degradationReason,
      pipeline: this.pipelineDiagnostics || null,
    }
  }

  buildResult(params: {
    success: boolean
    finalText: string
    usedTools: string[]
    cancelled?: boolean
    error?: string
  }): ExecutionTurnResult {
    return {
      success: params.success,
      finalText: params.finalText,
      usedTools: params.usedTools,
      cancelled: Boolean(params.cancelled),
      error: params.error,
      taskId: this.taskId,
      taskType: this.resolvedTaskType,
      interactionState: this.interactionState,
      taskProjectionId: this.taskId,
      executionDiagnostics: this.buildExecutionDiagnostics(),
    }
  }
}
