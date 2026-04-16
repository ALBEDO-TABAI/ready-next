import assert from 'node:assert/strict'
import test from 'node:test'

import type { CapabilityRuntimeSnapshot } from '../shared/ai-capability-runtime'
import { buildRequestEnvelope } from '../main/modules/agent-control/request-envelope'
import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
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

test('task type resolver keeps generic low-signal prompts on the direct answer path', () => {
  const envelope = buildRequestEnvelope({ userText: '你是谁？' })
  const result = resolveTaskType({
    intent: classifyIntent(envelope),
    envelope,
    capabilities: createCapabilities(),
  })

  assert.equal(result.taskType, 'direct_answer')
  assert.equal(result.executionChain, 'direct')
  assert.equal(result.requiresPlanner, false)
  assert.equal(result.preferredExecutor, 'none')
})

test('task type resolver routes browser upload intents into media tasks only when browser host is available', () => {
  const envelope = buildRequestEnvelope({ userText: '帮我把这张图上传到网页里并提交' })
  const intent = classifyIntent(envelope)

  const available = resolveTaskType({
    intent,
    envelope,
    capabilities: createCapabilities({ browserHostAvailable: true }),
  })
  assert.equal(available.taskType, 'media_task')
  assert.equal(available.executionChain, 'domain_executor')
  assert.equal(available.preferredExecutor, 'browser')

  const degraded = resolveTaskType({
    intent,
    envelope,
    capabilities: createCapabilities({ browserHostAvailable: false }),
  })
  assert.equal(degraded.taskType, 'direct_answer')
  assert.equal(degraded.executionChain, 'direct')
  assert.match(degraded.degradationReason || '', /browser/i)
})

test('task type resolver routes cross-domain work into planner-driven multi-step tasks', () => {
  const envelope = buildRequestEnvelope({ userText: '把 RSS 最新内容分析后发到飞书文档里' })
  const result = resolveTaskType({
    intent: classifyIntent(envelope),
    envelope,
    capabilities: createCapabilities(),
  })

  assert.equal(result.taskType, 'multi_step_task')
  assert.equal(result.executionChain, 'planner')
  assert.equal(result.requiresPlanner, true)
})

test('task type resolver restores continuation tasks when current task context is provided', () => {
  const envelope = buildRequestEnvelope({ userText: '继续刚才那个任务' })
  const result = resolveTaskType({
    intent: classifyIntent(envelope),
    envelope,
    capabilities: createCapabilities(),
    currentTaskContext: {
      continuationTaskId: 'task-1',
    },
  })

  assert.equal(result.taskType, 'continuation')
  assert.equal(result.executionChain, 'continuation')
})
