import type { RunBudgetHint, RunBudgetSeed, RunBudgetUsage } from './run-contracts'

const DEFAULT_MAX_ITERATIONS = 24
const DEFAULT_MAX_TOOL_CALLS = 24
const DEFAULT_MAX_PARALLEL_TOOL_GROUPS = 1

export function createRunBudgetSeed(): RunBudgetSeed {
  return {
    maxIterations: DEFAULT_MAX_ITERATIONS,
    maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
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
