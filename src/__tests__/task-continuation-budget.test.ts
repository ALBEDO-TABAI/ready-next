import assert from 'node:assert/strict'
import test from 'node:test'

import type { CapabilityRuntimeSnapshot } from '../shared/ai-capability-runtime'
import { buildRequestEnvelope } from '../main/modules/agent-control/request-envelope'
import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { resolveTaskExecutionRoute } from '../main/modules/agent-control/task-execution-router'
import { resolveTaskType } from '../main/modules/agent-control/task-type-resolver'

function createCapabilities(overrides?: Partial<CapabilityRuntimeSnapshot['environment']>): CapabilityRuntimeSnapshot {
  return {
    generatedAt: '2026-04-16T00:00:00.000Z',
    profile: 'local_chat',
    groups: {} as CapabilityRuntimeSnapshot['groups'],
    environment: {
      browserHostAvailable: true,
      feishuConnected: true,
      enabledChannelTypes: [],
      connectedChannelTypes: [],
      ...overrides,
    },
  }
}

test('continuation routes restore prior budget usage and grant a safety floor when headroom is nearly exhausted', () => {
  const envelope = buildRequestEnvelope({ userText: '继续刚才那个任务' })
  const capabilities = createCapabilities()
  const resolution = resolveTaskType({
    intent: classifyIntent(envelope),
    envelope,
    capabilities,
    currentTaskContext: {
      continuationTaskId: 'task-prev-1',
    },
  })

  const route = resolveTaskExecutionRoute({
    taskId: 'task-resume-1',
    resolution,
    envelope,
    capabilities,
    continuationContext: {
      state: null,
      projection: {
        taskId: 'task-prev-1',
        scopeId: 'scope-1',
        runId: 'run-prev-1',
        taskType: 'short_task',
        module: 'skill',
        status: 'blocked',
        interactionState: 'awaiting_confirmation',
        steps: [],
        budget: {
          taskType: 'short_task',
          maxIterations: 24,
          maxToolCalls: 24,
          maxParallelToolGroups: 5,
          iterationsUsed: 23,
          toolCallsUsed: 23,
          parallelToolGroupsUsed: 1,
          stepBudget: {
            stepId: 'approve',
            maxIterations: 6,
            remainingIterations: 1,
          },
        },
        budgetUsagePercent: 96,
        recoveryHistory: [],
        blockedReason: '等待确认',
        resumableActions: ['continue', 'cancel'],
        continuationRef: {
          executionId: 'exec-1',
          stepId: 'approve',
          blockerType: 'need_confirmation',
          taskId: 'task-prev-1',
        },
        createdAt: '2026-04-16T00:00:00.000Z',
        updatedAt: '2026-04-16T00:00:01.000Z',
      },
    },
  })

  assert.equal(route.chain, 'continuation')
  assert.equal(route.executor, 'skill')
  assert.equal((route as { currentStepId?: string | null }).currentStepId, 'approve')
  assert.equal(route.continuation?.budgetRuntime?.usage.iterationsUsed, 23)
  assert.equal(route.continuation?.budgetRuntime?.usage.toolCallsUsed, 23)
  assert.equal(route.continuation?.budgetRuntime?.budget.maxIterations, 27)
  assert.equal(route.continuation?.budgetRuntime?.budget.maxToolCalls, 25)
  assert.equal(route.continuation?.budgetRestore?.inheritedBudget, true)
  assert.equal(route.continuation?.budgetRestore?.restoredUsage, true)
  assert.equal(route.continuation?.budgetRestore?.grantedIterationSafetyFloor, true)
  assert.equal(route.continuation?.budgetRestore?.grantedToolCallSafetyFloor, true)
})

test('continuation budget restore grants current-step headroom when the prior step was exhausted', () => {
  const envelope = buildRequestEnvelope({ userText: '继续刚才那个任务' })
  const capabilities = createCapabilities()
  const resolution = resolveTaskType({
    intent: classifyIntent(envelope),
    envelope,
    capabilities,
    currentTaskContext: {
      continuationTaskId: 'task-prev-step-exhausted',
    },
  })

  const route = resolveTaskExecutionRoute({
    taskId: 'task-resume-step-exhausted',
    resolution,
    envelope,
    capabilities,
    continuationContext: {
      state: null,
      projection: {
        taskId: 'task-prev-step-exhausted',
        scopeId: 'scope-1',
        runId: 'run-prev-step-exhausted',
        taskType: 'multi_step_task',
        module: 'skill',
        status: 'blocked',
        interactionState: 'resuming',
        steps: [
          { id: 'score', title: '继续评分', description: '继续评分', status: 'running' },
        ],
        currentStepId: 'score',
        budget: {
          taskType: 'multi_step_task',
          maxIterations: 40,
          maxToolCalls: 40,
          maxParallelToolGroups: 5,
          iterationsUsed: 40,
          toolCallsUsed: 12,
          parallelToolGroupsUsed: 1,
          stepBudget: {
            stepId: 'score',
            maxIterations: 40,
            remainingIterations: 0,
          },
        },
        budgetUsagePercent: 100,
        recoveryHistory: [],
        blockedReason: '等待继续',
        resumableActions: ['continue', 'cancel'],
        continuationRef: {
          executionId: 'exec-step-exhausted',
          stepId: 'score',
          blockerType: 'need_confirmation',
          taskId: 'task-prev-step-exhausted',
        },
        createdAt: '2026-04-16T00:00:00.000Z',
        updatedAt: '2026-04-16T00:00:01.000Z',
      },
    },
  })

  assert.equal(route.chain, 'continuation')
  assert.ok(
    (route.continuation?.budgetRuntime?.stepBudget?.remainingIterations || 0) >= 4,
    `expected restored step budget to have headroom, got ${
      route.continuation?.budgetRuntime?.stepBudget?.remainingIterations
    }`,
  )
  assert.notEqual(route.continuation?.budgetRuntime?.warningLevel, 'exhausted')
})
