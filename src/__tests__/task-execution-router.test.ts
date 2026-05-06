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

test('task execution router keeps direct answers off the tool loop', () => {
  const envelope = buildRequestEnvelope({ userText: '你是谁？' })
  const capabilities = createCapabilities()
  const resolution = resolveTaskType({
    intent: classifyIntent(envelope),
    envelope,
    capabilities,
  })

  const route = resolveTaskExecutionRoute({
    taskId: 'task-1',
    resolution,
    envelope,
    capabilities,
  })

  assert.equal(route.chain, 'direct')
  assert.equal(route.executor, 'direct')
  assert.equal(route.steps.length, 0)
})

test('task execution router builds planned steps for multi-step tasks', () => {
  const envelope = buildRequestEnvelope({ userText: '把 RSS 最新内容分析后发到飞书文档里' })
  const capabilities = createCapabilities()
  const resolution = resolveTaskType({
    intent: classifyIntent(envelope),
    envelope,
    capabilities,
  })

  const route = resolveTaskExecutionRoute({
    taskId: 'task-2',
    resolution,
    envelope,
    capabilities,
  })

  assert.equal(route.chain, 'planner')
  assert.equal(route.executor, 'planner')
  assert.ok(route.steps.length >= 2)
  assert.ok(route.steps.every((step) => typeof step.description === 'string' && step.description.length > 0))
  assert.ok(route.steps.every((step) => typeof step.budget === 'number' && step.budget > 0))
})

test('task execution router restores continuation from projection state when available', () => {
  const envelope = buildRequestEnvelope({ userText: '继续刚才那个任务' })
  const capabilities = createCapabilities()
  const resolution = resolveTaskType({
    intent: classifyIntent(envelope),
    envelope,
    capabilities,
    currentTaskContext: {
      continuationTaskId: 'task-3',
    },
  })

  const route = resolveTaskExecutionRoute({
    taskId: 'task-4',
    resolution,
    envelope,
    capabilities,
    continuationContext: {
      state: null,
      projection: {
        taskId: 'task-3',
        scopeId: 'scope-1',
        runId: 'run-1',
        taskType: 'continuation',
        module: 'skill',
        status: 'blocked',
        interactionState: 'awaiting_confirmation',
        steps: [],
        budget: {
          taskType: 'short_task',
          maxIterations: 24,
          maxToolCalls: 24,
          maxParallelToolGroups: 5,
          iterationsUsed: 7,
          toolCallsUsed: 4,
          parallelToolGroupsUsed: 1,
        },
        budgetUsagePercent: 60,
        recoveryHistory: [],
        blockedReason: '等待确认',
        resumableActions: ['continue', 'cancel'],
        continuationRef: {
          executionId: 'exec-1',
          stepId: 'approve',
          blockerType: 'need_confirmation',
          taskId: 'task-3',
        },
        createdAt: '2026-04-16T00:00:00.000Z',
        updatedAt: '2026-04-16T00:00:01.000Z',
      },
    },
  })

  assert.equal(route.chain, 'continuation')
  assert.equal(route.executor, 'skill')
  assert.equal(route.continuation?.taskId, 'task-3')
  assert.equal(route.continuation?.budgetRuntime?.usage.iterationsUsed, 7)
  assert.equal(route.continuation?.budgetRuntime?.usage.toolCallsUsed, 4)
})

test('task execution router keeps skill requests on the dedicated skill executor path', () => {
  const envelope = buildRequestEnvelope({ userText: '用 skill 帮我继续执行这个 workflow，并处理 blocker' })
  const capabilities = createCapabilities()
  const resolution = resolveTaskType({
    intent: classifyIntent(envelope),
    envelope,
    capabilities,
  })

  const route = resolveTaskExecutionRoute({
    taskId: 'task-skill-1',
    resolution,
    envelope,
    capabilities,
  })

  assert.equal(route.chain, 'domain_executor')
  assert.equal(route.executor, 'skill')
})
