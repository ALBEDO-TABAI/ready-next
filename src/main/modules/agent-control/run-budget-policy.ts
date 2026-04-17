import type {
  BudgetWarningLevel,
  ContinuationBudgetRestoreDiagnostics,
  RunBudgetHint,
  RunBudgetSeed,
  RunBudgetUsage,
  StepBudgetState,
  TaskBudget,
  TaskBudgetRuntime,
  TaskType,
} from './run-contracts'
import type { ContinuationState } from './continuation-state'

const DEFAULT_MAX_PARALLEL_TOOL_GROUPS = 5
const TASK_TYPE_BUDGET_PRESETS: Record<TaskType, Pick<RunBudgetSeed, 'maxIterations' | 'maxToolCalls'>> = {
  direct_answer: {
    maxIterations: 8,
    maxToolCalls: 8,
  },
  short_task: {
    maxIterations: 24,
    maxToolCalls: 24,
  },
  multi_step_task: {
    maxIterations: 60,
    maxToolCalls: 60,
  },
  media_task: {
    maxIterations: 60,
    maxToolCalls: 60,
  },
  continuation: {
    maxIterations: 24,
    maxToolCalls: 24,
  },
}

export function createRunBudgetSeed(taskType: TaskType = 'short_task'): RunBudgetSeed {
  const preset = TASK_TYPE_BUDGET_PRESETS[taskType] || TASK_TYPE_BUDGET_PRESETS.short_task
  return {
    maxIterations: preset.maxIterations,
    maxToolCalls: preset.maxToolCalls,
    maxParallelToolGroups: DEFAULT_MAX_PARALLEL_TOOL_GROUPS,
    reservedToolCalls: 0,
  }
}

export function createStepBudgetState(params: {
  stepId?: string | null
  totalIterations: number
  stepCount?: number
  suggestedMaxIterations?: number
}): StepBudgetState {
  const stepCount = Math.max(1, params.stepCount || 1)
  const maxIterations = Math.max(
    1,
    Math.round(
      typeof params.suggestedMaxIterations === 'number'
        ? params.suggestedMaxIterations
        : Math.ceil(params.totalIterations / stepCount),
    ),
  )
  return {
    stepId: params.stepId || null,
    maxIterations,
    remainingIterations: maxIterations,
  }
}

export function createTaskBudgetRuntime(taskType: TaskType, options?: {
  budget?: RunBudgetSeed | null
  usage?: RunBudgetUsage | null
  stepBudget?: StepBudgetState | null
  frozen?: boolean
  bootstrapBudget?: boolean
}): TaskBudgetRuntime {
  const budget = {
    ...(options?.budget || createRunBudgetSeed(taskType)),
    reservedToolCalls: Math.max(0, Math.round(options?.budget?.reservedToolCalls || 0)),
  }
  const usage = options?.usage
    ? { ...options.usage }
    : {
      iterationsUsed: 0,
      toolCallsUsed: 0,
      parallelToolGroupsUsed: 0,
    }
  const runtime: TaskBudgetRuntime = {
    taskType,
    budget,
    usage,
    stepBudget: options?.stepBudget || null,
    warningLevel: 'none',
    frozen: Boolean(options?.frozen),
    bootstrapBudget: Boolean(options?.bootstrapBudget),
  }
  return {
    ...runtime,
    warningLevel: getBudgetWarningLevel(getBudgetUsagePercent(runtime)),
  }
}

export function applyRunBudgetHint(target: RunBudgetSeed | TaskBudgetRuntime, hint?: RunBudgetHint | null): RunBudgetSeed | TaskBudgetRuntime {
  if (!hint) return target
  if (!('budget' in target)) {
    return target
  }
  const reservedToolCalls = typeof hint.reserveToolCalls === 'number'
    ? Math.max(target.budget.reservedToolCalls || 0, Math.max(0, Math.round(hint.reserveToolCalls)))
    : target.budget.reservedToolCalls || 0
  const stepBudget = target.stepBudget
    ? {
      ...target.stepBudget,
      maxIterations: typeof hint.maxIterations === 'number'
        ? Math.max(target.stepBudget.maxIterations, Math.round(hint.maxIterations))
        : target.stepBudget.maxIterations,
    }
    : null
  const next = {
    ...target,
    budget: {
      ...target.budget,
      reservedToolCalls,
    },
    stepBudget: stepBudget
      ? {
        ...stepBudget,
        remainingIterations: Math.max(
          stepBudget.remainingIterations,
          stepBudget.maxIterations,
        ),
      }
      : null,
  }
  return {
    ...next,
    warningLevel: getBudgetWarningLevel(getBudgetUsagePercent(next)),
  }
}

export function consumeIterationBudget(usage: RunBudgetUsage): RunBudgetUsage
export function consumeIterationBudget(runtime: TaskBudgetRuntime): TaskBudgetRuntime
export function consumeIterationBudget(input: RunBudgetUsage | TaskBudgetRuntime): RunBudgetUsage | TaskBudgetRuntime {
  if ('budget' in input) {
    if (input.frozen) {
      return input
    }
    const next = {
      ...input,
      usage: {
        ...input.usage,
        iterationsUsed: input.usage.iterationsUsed + 1,
      },
      stepBudget: input.stepBudget
        ? {
          ...input.stepBudget,
          remainingIterations: Math.max(0, input.stepBudget.remainingIterations - 1),
        }
        : null,
    }
    return {
      ...next,
      warningLevel: getBudgetWarningLevel(getBudgetUsagePercent(next)),
    }
  }
  return {
    ...input,
    iterationsUsed: input.iterationsUsed + 1,
  }
}

export function consumeToolCallBudget(usage: RunBudgetUsage, amount = 1): RunBudgetUsage {
  return {
    ...usage,
    toolCallsUsed: usage.toolCallsUsed + Math.max(0, amount),
  }
}

export function consumeParallelGroupBudget(usage: RunBudgetUsage): RunBudgetUsage {
  return {
    ...usage,
    parallelToolGroupsUsed: usage.parallelToolGroupsUsed + 1,
  }
}

export function rebindTaskBudgetRuntime(
  runtime: TaskBudgetRuntime,
  taskType: TaskType,
  options?: {
    stepBudget?: StepBudgetState | null
    frozen?: boolean
    bootstrapBudget?: boolean
  },
): TaskBudgetRuntime {
  return createTaskBudgetRuntime(taskType, {
    budget: {
      ...createRunBudgetSeed(taskType),
      reservedToolCalls: runtime.budget.reservedToolCalls || 0,
    },
    usage: runtime.usage,
    stepBudget: options && 'stepBudget' in options
      ? options.stepBudget || null
      : runtime.stepBudget,
    frozen: typeof options?.frozen === 'boolean' ? options.frozen : runtime.frozen,
    bootstrapBudget: Boolean(options?.bootstrapBudget),
  })
}

export function restoreContinuationTaskBudgetRuntime(params: {
  taskType: TaskType
  budget?: TaskBudget | null
  continuationState?: ContinuationState | null
  minimumRemainingIterations?: number
  minimumRemainingToolCalls?: number
}): {
  runtime: TaskBudgetRuntime | null
  diagnostics: ContinuationBudgetRestoreDiagnostics
} {
  const diagnostics: ContinuationBudgetRestoreDiagnostics = {
    inheritedBudget: false,
    restoredUsage: false,
    grantedIterationSafetyFloor: false,
    grantedToolCallSafetyFloor: false,
  }
  const continuationState = params.continuationState || null
  const budget = continuationState?.budget || params.budget
  const runtimeBudget = continuationState?.budgetRuntime || null

  const hasBudgetSeed = runtimeBudget
    ? (
      typeof runtimeBudget.budget.maxIterations === 'number'
      && typeof runtimeBudget.budget.maxToolCalls === 'number'
      && typeof runtimeBudget.budget.maxParallelToolGroups === 'number'
    )
    : (
      typeof budget?.maxIterations === 'number'
      && typeof budget?.maxToolCalls === 'number'
      && typeof budget?.maxParallelToolGroups === 'number'
    )
  if (!hasBudgetSeed || (!runtimeBudget && !budget)) {
    return { runtime: null, diagnostics }
  }

  const usage: RunBudgetUsage = runtimeBudget
    ? {
      iterationsUsed: Math.max(0, Math.round(runtimeBudget.usage.iterationsUsed || 0)),
      toolCallsUsed: Math.max(0, Math.round(runtimeBudget.usage.toolCallsUsed || 0)),
      parallelToolGroupsUsed: Math.max(0, Math.round(runtimeBudget.usage.parallelToolGroupsUsed || 0)),
    }
    : {
      iterationsUsed: Math.max(0, Math.round(budget!.iterationsUsed || 0)),
      toolCallsUsed: Math.max(0, Math.round(budget!.toolCallsUsed || 0)),
      parallelToolGroupsUsed: Math.max(0, Math.round(budget!.parallelToolGroupsUsed || 0)),
    }
  const seed: RunBudgetSeed = runtimeBudget
    ? {
      maxIterations: Math.max(1, Math.round(runtimeBudget.budget.maxIterations)),
      maxToolCalls: Math.max(1, Math.round(runtimeBudget.budget.maxToolCalls)),
      maxParallelToolGroups: Math.max(0, Math.round(runtimeBudget.budget.maxParallelToolGroups)),
      reservedToolCalls: Math.max(0, Math.round(runtimeBudget.budget.reservedToolCalls || 0)),
    }
    : {
      maxIterations: Math.max(1, Math.round(budget!.maxIterations)),
      maxToolCalls: Math.max(1, Math.round(budget!.maxToolCalls)),
      maxParallelToolGroups: Math.max(0, Math.round(budget!.maxParallelToolGroups)),
      reservedToolCalls: Math.max(0, Math.round(budget!.reservedToolCalls || 0)),
    }
  const minimumRemainingIterations = Math.max(1, Math.round(params.minimumRemainingIterations || 4))
  const minimumRemainingToolCalls = Math.max(1, Math.round(params.minimumRemainingToolCalls || 2))

  diagnostics.inheritedBudget = true
  diagnostics.restoredUsage = usage.iterationsUsed > 0 || usage.toolCallsUsed > 0 || usage.parallelToolGroupsUsed > 0

  if (seed.maxIterations - usage.iterationsUsed < minimumRemainingIterations) {
    seed.maxIterations = usage.iterationsUsed + minimumRemainingIterations
    diagnostics.grantedIterationSafetyFloor = true
  }
  if (seed.maxToolCalls - seed.reservedToolCalls! - usage.toolCallsUsed < minimumRemainingToolCalls) {
    seed.maxToolCalls = usage.toolCallsUsed + seed.reservedToolCalls! + minimumRemainingToolCalls
    diagnostics.grantedToolCallSafetyFloor = true
  }

  return {
    runtime: createTaskBudgetRuntime(params.taskType, {
      budget: seed,
      usage,
      stepBudget: runtimeBudget?.stepBudget
        ? {
          stepId: runtimeBudget.stepBudget.stepId || null,
          maxIterations: Math.max(1, Math.round(runtimeBudget.stepBudget.maxIterations)),
          remainingIterations: Math.max(0, Math.round(runtimeBudget.stepBudget.remainingIterations)),
        }
        : budget?.stepBudget
        ? {
          stepId: budget.stepBudget.stepId || null,
          maxIterations: Math.max(1, Math.round(budget.stepBudget.maxIterations)),
          remainingIterations: Math.max(0, Math.round(budget.stepBudget.remainingIterations ?? budget.stepBudget.maxIterations)),
        }
        : null,
      frozen: Boolean(runtimeBudget?.frozen ?? budget?.frozen),
      bootstrapBudget: Boolean(runtimeBudget?.bootstrapBudget ?? budget?.bootstrapBudget),
    }),
    diagnostics,
  }
}

export function getRemainingToolCallBudget(runtime: TaskBudgetRuntime): number
export function getRemainingToolCallBudget(seed: RunBudgetSeed, usage: RunBudgetUsage): number
export function getRemainingToolCallBudget(
  seedOrRuntime: RunBudgetSeed | TaskBudgetRuntime,
  usage?: RunBudgetUsage,
): number {
  const seed = 'budget' in seedOrRuntime ? seedOrRuntime.budget : seedOrRuntime
  const currentUsage = 'budget' in seedOrRuntime ? seedOrRuntime.usage : (usage || {
    iterationsUsed: 0,
    toolCallsUsed: 0,
    parallelToolGroupsUsed: 0,
  })
  return Math.max(0, seed.maxToolCalls - Math.max(0, seed.reservedToolCalls || 0) - currentUsage.toolCallsUsed)
}

export function canUseParallelToolGroup(seed: RunBudgetSeed, usage: RunBudgetUsage): boolean {
  return usage.parallelToolGroupsUsed < seed.maxParallelToolGroups
}

export function refundIterationBudget(runtime: TaskBudgetRuntime): TaskBudgetRuntime {
  const usage = {
    ...runtime.usage,
    iterationsUsed: Math.max(0, runtime.usage.iterationsUsed - 1),
  }
  const stepBudget = runtime.stepBudget
    ? {
      ...runtime.stepBudget,
      remainingIterations: Math.min(runtime.stepBudget.maxIterations, runtime.stepBudget.remainingIterations + 1),
    }
    : null
  const next = {
    ...runtime,
    usage,
    stepBudget,
  }
  return {
    ...next,
    warningLevel: getBudgetWarningLevel(getBudgetUsagePercent(next)),
  }
}

export function freezeBudgetRuntime(runtime: TaskBudgetRuntime): TaskBudgetRuntime {
  return {
    ...runtime,
    frozen: true,
  }
}

export function resumeBudgetRuntime(runtime: TaskBudgetRuntime): TaskBudgetRuntime {
  return {
    ...runtime,
    frozen: false,
  }
}

export function getBudgetUsagePercent(seed: RunBudgetSeed, usage: RunBudgetUsage): number
export function getBudgetUsagePercent(runtime: TaskBudgetRuntime): number
export function getBudgetUsagePercent(
  seedOrRuntime: RunBudgetSeed | TaskBudgetRuntime,
  usage?: RunBudgetUsage,
): number {
  const seed = 'budget' in seedOrRuntime ? seedOrRuntime.budget : seedOrRuntime
  const currentUsage = 'budget' in seedOrRuntime ? seedOrRuntime.usage : (usage || {
    iterationsUsed: 0,
    toolCallsUsed: 0,
    parallelToolGroupsUsed: 0,
  })
  const iterationRatio = seed.maxIterations > 0 ? currentUsage.iterationsUsed / seed.maxIterations : 0
  const effectiveMaxToolCalls = Math.max(1, seed.maxToolCalls - Math.max(0, seed.reservedToolCalls || 0))
  const toolRatio = seed.maxToolCalls > 0 ? currentUsage.toolCallsUsed / effectiveMaxToolCalls : 0
  const parallelRatio = seed.maxParallelToolGroups > 0
    ? currentUsage.parallelToolGroupsUsed / seed.maxParallelToolGroups
    : 0
  const stepRatio = 'budget' in seedOrRuntime && seedOrRuntime.stepBudget && seedOrRuntime.stepBudget.maxIterations > 0
    ? (seedOrRuntime.stepBudget.maxIterations - seedOrRuntime.stepBudget.remainingIterations) / seedOrRuntime.stepBudget.maxIterations
    : 0

  return Math.max(
    0,
    Math.min(100, Math.round(Math.max(iterationRatio, toolRatio, parallelRatio, stepRatio) * 100)),
  )
}

export function getBudgetWarningLevel(percent: number): BudgetWarningLevel {
  if (percent >= 100) return 'exhausted'
  if (percent >= 90) return 'converge'
  if (percent >= 70) return 'warning'
  return 'none'
}
