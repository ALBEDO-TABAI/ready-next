import type { RunBudgetHint, RunBudgetSeed, RunBudgetUsage, TaskType } from './run-contracts'

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
  }
}

export function applyRunBudgetHint(seed: RunBudgetSeed, hint?: RunBudgetHint | null): RunBudgetSeed {
  if (!hint) return seed
  return {
    maxIterations: typeof hint.maxIterations === 'number'
      ? Math.max(seed.maxIterations, hint.maxIterations)
      : seed.maxIterations,
    maxToolCalls: typeof hint.reserveToolCalls === 'number'
      ? seed.maxToolCalls + Math.max(0, hint.reserveToolCalls)
      : seed.maxToolCalls,
    maxParallelToolGroups: seed.maxParallelToolGroups,
  }
}

export function consumeIterationBudget(usage: RunBudgetUsage): RunBudgetUsage {
  return {
    ...usage,
    iterationsUsed: usage.iterationsUsed + 1,
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

export function getRemainingToolCallBudget(seed: RunBudgetSeed, usage: RunBudgetUsage): number {
  return Math.max(0, seed.maxToolCalls - usage.toolCallsUsed)
}

export function canUseParallelToolGroup(seed: RunBudgetSeed, usage: RunBudgetUsage): boolean {
  return usage.parallelToolGroupsUsed < seed.maxParallelToolGroups
}

export function getBudgetUsagePercent(seed: RunBudgetSeed, usage: RunBudgetUsage): number {
  const iterationRatio = seed.maxIterations > 0 ? usage.iterationsUsed / seed.maxIterations : 0
  const toolRatio = seed.maxToolCalls > 0 ? usage.toolCallsUsed / seed.maxToolCalls : 0
  const parallelRatio = seed.maxParallelToolGroups > 0
    ? usage.parallelToolGroupsUsed / seed.maxParallelToolGroups
    : 0

  return Math.max(
    0,
    Math.min(100, Math.round(Math.max(iterationRatio, toolRatio, parallelRatio) * 100)),
  )
}
