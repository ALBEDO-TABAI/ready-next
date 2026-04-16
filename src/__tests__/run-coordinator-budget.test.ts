import assert from 'node:assert/strict'
import test from 'node:test'

import { RunCoordinator } from '../main/modules/agent-control/run-coordinator'
import {
  applyRunBudgetHint,
  createStepBudgetState,
  createTaskBudgetRuntime,
  canUseParallelToolGroup,
  consumeIterationBudget,
  consumeParallelGroupBudget,
  consumeToolCallBudget,
  freezeBudgetRuntime,
  getBudgetWarningLevel,
  createRunBudgetSeed,
  getBudgetUsagePercent,
  getRemainingToolCallBudget,
  refundIterationBudget,
  resumeBudgetRuntime,
} from '../main/modules/agent-control/run-budget-policy'
import type { ConversationScope, ScopeRunEventPayload } from '../main/modules/agent-control/types'

function createScope(): ConversationScope {
  return {
    id: 'scope-budget-1',
    agent: 'butler',
    title: '预算测试',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'scope-budget-1',
    meta: {},
    createdAt: '2026-04-16T00:00:00.000Z',
    updatedAt: '2026-04-16T00:00:00.000Z',
    lastMessageAt: '2026-04-16T00:00:00.000Z',
  }
}

test('RunCoordinator seeds scoped runs with a bootstrap budget and rebinds it after task type resolution', async () => {
  const events: ScopeRunEventPayload[] = []
  let executionRuntime: {
    taskType: string
    bootstrapBudget: boolean
    budget: { maxIterations: number; maxToolCalls: number }
  } | null = null

  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: [],
        memoryRefs: [],
        triggerHits: [],
        contextBudget: { totalChars: 0, l0Chars: 0, l1Chars: 0, l2Chars: 0, droppedRefs: [] },
      }),
      applyToMessage: (message) => message,
      recordRunOutcome: () => {},
    },
    executeAndCollect: async (request) => {
      executionRuntime = request.taskBudgetRuntime
        ? {
          taskType: request.taskBudgetRuntime.taskType,
          bootstrapBudget: request.taskBudgetRuntime.bootstrapBudget,
          budget: {
            maxIterations: request.taskBudgetRuntime.budget.maxIterations,
            maxToolCalls: request.taskBudgetRuntime.budget.maxToolCalls,
          },
        }
        : null
      return {
        success: true,
        finalText: 'done',
        cancelled: false,
        usedTools: [],
        taskType: 'direct_answer',
      }
    },
    emitScopeRunEvent: (payload) => {
      events.push(payload)
    },
    reflectOnConversation: async () => null,
  })

  const result = await coordinator.runScoped({
    scope: createScope(),
    message: '你好',
    requestId: 'req-budget-1',
  })

  const finalEvent = events[events.length - 1]
  assert.equal(result.success, true)
  assert.deepEqual(executionRuntime, {
    taskType: 'short_task',
    bootstrapBudget: true,
    budget: {
      maxIterations: 24,
      maxToolCalls: 24,
    },
  })
  assert.equal(finalEvent?.executionDiagnostics?.taskBudgetRuntime?.taskType, 'direct_answer')
  assert.equal(finalEvent?.executionDiagnostics?.taskBudgetRuntime?.bootstrapBudget, false)
  assert.equal(finalEvent?.executionDiagnostics?.budget?.maxIterations, 8)
  assert.equal(finalEvent?.executionDiagnostics?.budget?.maxToolCalls, 8)
})

test('run budget policy applies hints to the active step budget instead of inflating the global task seed', () => {
  const seed = createRunBudgetSeed()
  const runtime = createTaskBudgetRuntime('short_task', {
    budget: seed,
    stepBudget: createStepBudgetState({
      stepId: 'step-1',
      totalIterations: seed.maxIterations,
      suggestedMaxIterations: 8,
    }),
  })
  const hinted = applyRunBudgetHint(runtime, {
    maxIterations: 12,
    reserveToolCalls: 3,
  })

  assert.equal(hinted.budget.maxIterations, seed.maxIterations)
  assert.equal(hinted.budget.maxToolCalls, seed.maxToolCalls)
  assert.equal(hinted.stepBudget?.maxIterations, 12)
  assert.equal(hinted.stepBudget?.remainingIterations, 12)
})

test('run budget policy tracks iterations, tool calls, and parallel groups independently', () => {
  let usage = {
    iterationsUsed: 0,
    toolCallsUsed: 0,
    parallelToolGroupsUsed: 0,
  }

  usage = consumeIterationBudget(usage)
  usage = consumeToolCallBudget(usage, 2)
  usage = consumeParallelGroupBudget(usage)

  assert.deepEqual(usage, {
    iterationsUsed: 1,
    toolCallsUsed: 2,
    parallelToolGroupsUsed: 1,
  })
})

test('run budget policy exposes remaining tool capacity and parallel group availability', () => {
  const seed = createRunBudgetSeed()
  const usage = {
    iterationsUsed: 2,
    toolCallsUsed: seed.maxToolCalls - 1,
    parallelToolGroupsUsed: seed.maxParallelToolGroups,
  }

  assert.equal(getRemainingToolCallBudget(seed, usage), 1)
  assert.equal(canUseParallelToolGroup(seed, usage), false)
})

test('run budget policy seeds different iteration budgets for direct, short, and multi-step tasks', () => {
  const direct = createRunBudgetSeed('direct_answer')
  const short = createRunBudgetSeed('short_task')
  const multi = createRunBudgetSeed('multi_step_task')
  const media = createRunBudgetSeed('media_task')

  assert.equal(direct.maxIterations, 8)
  assert.equal(short.maxIterations, 24)
  assert.equal(multi.maxIterations, 60)
  assert.equal(media.maxIterations, 60)
  assert.equal(short.maxParallelToolGroups, 5)
})

test('run budget policy computes a stable usage percentage from the active budget counters', () => {
  const seed = createRunBudgetSeed('multi_step_task')
  const usage = {
    iterationsUsed: 30,
    toolCallsUsed: 15,
    parallelToolGroupsUsed: 2,
  }

  assert.equal(getBudgetUsagePercent(seed, usage), 50)
})

test('run budget policy creates and refunds step budget iterations', () => {
  const seed = createRunBudgetSeed('multi_step_task')
  let runtime = createTaskBudgetRuntime('multi_step_task', {
    budget: seed,
    stepBudget: createStepBudgetState({
      stepId: 'collect',
      totalIterations: seed.maxIterations,
      stepCount: 3,
    }),
  })

  runtime = consumeIterationBudget(runtime)
  assert.equal(runtime.stepBudget?.remainingIterations, 19)

  runtime = refundIterationBudget(runtime)
  assert.equal(runtime.stepBudget?.remainingIterations, 20)
  assert.equal(runtime.usage.iterationsUsed, 0)
})

test('run budget policy exposes warning levels and freeze/resume state', () => {
  const seed = createRunBudgetSeed('short_task')
  let runtime = createTaskBudgetRuntime('short_task', {
    budget: seed,
    usage: {
      iterationsUsed: 22,
      toolCallsUsed: 0,
      parallelToolGroupsUsed: 0,
    },
    stepBudget: createStepBudgetState({
      stepId: 'step-1',
      totalIterations: seed.maxIterations,
      suggestedMaxIterations: 24,
    }),
  })

  assert.equal(getBudgetWarningLevel(getBudgetUsagePercent(runtime)), 'converge')
  runtime = freezeBudgetRuntime(runtime)
  assert.equal(runtime.frozen, true)
  runtime = resumeBudgetRuntime(runtime)
  assert.equal(runtime.frozen, false)
})
