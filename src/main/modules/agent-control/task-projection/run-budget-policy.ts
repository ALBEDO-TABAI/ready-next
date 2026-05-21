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
} from '../contracts/run-contracts'
import type { ContinuationState } from '../contracts/continuation-state'

const DEFAULT_MAX_PARALLEL_TOOL_GROUPS = 5
const LONG_SKILL_TASK_HARD_CAP_ITERATIONS = 220
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
    // Reduced 60→40 (skill-resume plan C2): a healthy multi-step task should
    // make visible progress within 40 tool calls. The recent RSS-loop bug ran
    // 35+ iterations without progress because there was no dedup; with C1's
    // dedup detector + this lower ceiling, runaway loops surface much sooner
    // and the user is asked to intervene (via the 70% warning + ask_user inject).
    maxIterations: 40,
    maxToolCalls: 40,
  },
  media_task: {
    maxIterations: 60,
    maxToolCalls: 60,
  },
  continuation: {
    maxIterations: 24,
    maxToolCalls: 24,
  },
  research: {
    maxIterations: 60,
    maxToolCalls: 60,
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

/**
 * Phase 4.2 — fresh continuation budget that inherits from the original task
 * type instead of always collapsing to the 24-iter `continuation` preset.
 *
 * Background: the audit found that resuming a multi_step_task or media_task
 * (e.g. mid-pipeline VEA, mid-batch RSS update) was throttled to 24 iter
 * regardless of the original task's ceiling. With the typical 70%-warning at
 * iter 16, multi-stage skills got an "ask user if continue" reverse nudge
 * before they could finish. Audit Phase 4 §C4.
 *
 * Inheritance rule: only LARGER presets bubble up so we don't accidentally
 * grant a tiny direct_answer continuation 60 iters. Long types
 * (multi_step_task, media_task) inherit; everything else falls back to the
 * 'continuation' preset (24/24).
 *
 * `restoreContinuationTaskBudgetRuntime` already inherits via saved
 * budgetRuntime when available — this helper covers the FRESH continuation
 * case where no prior runtime was persisted (e.g. cross-process resume
 * after Ready restart that lost the runtime budget but kept the projection).
 */
export function createContinuationRunBudgetSeed(
  inheritedFromTaskType: TaskType | null | undefined,
): RunBudgetSeed {
  if (
    inheritedFromTaskType === 'multi_step_task'
    || inheritedFromTaskType === 'media_task'
    || inheritedFromTaskType === 'research'
  ) {
    return createRunBudgetSeed(inheritedFromTaskType)
  }
  return createRunBudgetSeed('continuation')
}

export function applyLongSkillTaskBudgetSeed(seed: RunBudgetSeed): RunBudgetSeed {
  return {
    ...seed,
    maxIterations: Math.max(seed.maxIterations, LONG_SKILL_TASK_HARD_CAP_ITERATIONS),
    maxToolCalls: Math.max(seed.maxToolCalls, LONG_SKILL_TASK_HARD_CAP_ITERATIONS),
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
  lease?: TaskBudgetRuntime['lease']
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
    lease: options?.lease || null,
  }
  return {
    ...runtime,
    warningLevel: getBudgetWarningLevel(getBudgetUsagePercent(runtime)),
  }
}

export function grantBudgetSafetyFloor(params: {
  budget: RunBudgetSeed
  usage: RunBudgetUsage
  stepBudget?: StepBudgetState | null
  minimumRemainingIterations?: number
  minimumRemainingToolCalls?: number
  minimumRemainingStepIterations?: number
}): {
  budget: RunBudgetSeed
  stepBudget: StepBudgetState | null
  grantedIterationSafetyFloor: boolean
  grantedToolCallSafetyFloor: boolean
  grantedStepBudgetSafetyFloor: boolean
} {
  const budget: RunBudgetSeed = {
    ...params.budget,
    reservedToolCalls: Math.max(0, Math.round(params.budget.reservedToolCalls || 0)),
  }
  const usage: RunBudgetUsage = {
    iterationsUsed: Math.max(0, Math.round(params.usage.iterationsUsed || 0)),
    toolCallsUsed: Math.max(0, Math.round(params.usage.toolCallsUsed || 0)),
    parallelToolGroupsUsed: Math.max(0, Math.round(params.usage.parallelToolGroupsUsed || 0)),
  }
  const minimumRemainingIterations = Math.max(1, Math.round(params.minimumRemainingIterations || 4))
  const minimumRemainingToolCalls = Math.max(1, Math.round(params.minimumRemainingToolCalls || 2))
  const minimumRemainingStepIterations = Math.max(
    1,
    Math.round(params.minimumRemainingStepIterations || minimumRemainingIterations),
  )
  let grantedIterationSafetyFloor = false
  let grantedToolCallSafetyFloor = false
  let grantedStepBudgetSafetyFloor = false

  if (budget.maxIterations - usage.iterationsUsed < minimumRemainingIterations) {
    budget.maxIterations = usage.iterationsUsed + minimumRemainingIterations
    grantedIterationSafetyFloor = true
  }
  if (budget.maxToolCalls - budget.reservedToolCalls! - usage.toolCallsUsed < minimumRemainingToolCalls) {
    budget.maxToolCalls = usage.toolCallsUsed + budget.reservedToolCalls! + minimumRemainingToolCalls
    grantedToolCallSafetyFloor = true
  }

  let stepBudget = params.stepBudget
    ? {
      stepId: params.stepBudget.stepId || null,
      maxIterations: Math.max(1, Math.round(params.stepBudget.maxIterations)),
      remainingIterations: Math.max(0, Math.round(params.stepBudget.remainingIterations)),
    }
    : null
  if (stepBudget && stepBudget.remainingIterations < minimumRemainingStepIterations) {
    const usedStepIterations = Math.max(0, stepBudget.maxIterations - stepBudget.remainingIterations)
    stepBudget = {
      ...stepBudget,
      maxIterations: Math.max(stepBudget.maxIterations, usedStepIterations + minimumRemainingStepIterations),
      remainingIterations: minimumRemainingStepIterations,
    }
    grantedStepBudgetSafetyFloor = true
  }

  return {
    budget,
    stepBudget,
    grantedIterationSafetyFloor,
    grantedToolCallSafetyFloor,
    grantedStepBudgetSafetyFloor,
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
    lease: runtime.lease || null,
  })
}

export function restoreContinuationTaskBudgetRuntime(params: {
  taskType: TaskType
  /**
   * Stage 6 L4 contract: callers MUST pass `projectionBudget` so the helper
   * sees the freshest persisted ledger truth (`null` = explicit absence).
   * This shadows the legacy `params.budget` seed and the older
   * `continuationState.budget` cache, in that priority order.
   */
  projectionBudget: TaskBudget | null
  projectionBudgetRuntime: TaskBudgetRuntime | null
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
    grantedStepBudgetSafetyFloor: false,
  }
  const continuationState = params.continuationState || null
  // Priority: explicit projection input > explicit params.budget seed > legacy continuationState cache.
  const budget = params.projectionBudget ?? params.budget ?? continuationState?.budget ?? null
  const runtimeBudget = params.projectionBudgetRuntime ?? continuationState?.budgetRuntime ?? null

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
  const restoredStepBudget = runtimeBudget?.stepBudget
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
    : null

  diagnostics.inheritedBudget = true
  diagnostics.restoredUsage = usage.iterationsUsed > 0 || usage.toolCallsUsed > 0 || usage.parallelToolGroupsUsed > 0

  const safetyFloor = grantBudgetSafetyFloor({
    budget: seed,
    usage,
    stepBudget: restoredStepBudget,
    minimumRemainingIterations,
    minimumRemainingToolCalls,
    minimumRemainingStepIterations: minimumRemainingIterations,
  })
  diagnostics.grantedIterationSafetyFloor = safetyFloor.grantedIterationSafetyFloor
  diagnostics.grantedToolCallSafetyFloor = safetyFloor.grantedToolCallSafetyFloor
  diagnostics.grantedStepBudgetSafetyFloor = safetyFloor.grantedStepBudgetSafetyFloor

  return {
    runtime: createTaskBudgetRuntime(params.taskType, {
      budget: safetyFloor.budget,
      usage,
      stepBudget: safetyFloor.stepBudget,
      frozen: Boolean(runtimeBudget?.frozen ?? budget?.frozen),
      bootstrapBudget: Boolean(runtimeBudget?.bootstrapBudget ?? budget?.bootstrapBudget),
      lease: runtimeBudget?.lease || null,
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
