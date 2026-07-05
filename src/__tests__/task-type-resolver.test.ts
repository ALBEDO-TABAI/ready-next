import assert from 'node:assert/strict'
import test from 'node:test'

import type { CapabilityRuntimeSnapshot } from '../shared/ai-capability-runtime'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
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

test('task type resolver routes browser upload+submit intents into browser transactions only when browser host is available', () => {
  const envelope = buildRequestEnvelope({ userText: '帮我把这张图上传到网页里并提交' })
  const intent = classifyIntent(envelope)

  // 6e99f0e6 (transaction success proof): 上传+提交 wording is a browser
  // transaction workflow (resolveBrowserWorkflowIntent), superseding the
  // former media_task classification for this text.
  const available = resolveTaskType({
    intent,
    envelope,
    capabilities: createCapabilities({ browserHostAvailable: true }),
  })
  assert.equal(available.taskType, 'browser_transaction')
  assert.equal(available.executionChain, 'tool_loop')
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

test('task type resolver routes multi-note browser collection into a multi-step browser task', () => {
  const envelope = buildRequestEnvelope({ userText: '把这个博主的每篇笔记都采集下来并保存图片' })
  const intent = classifyIntent(envelope)

  const available = resolveTaskType({
    intent,
    envelope,
    capabilities: createCapabilities({ browserHostAvailable: true }),
  })
  assert.equal(available.taskType, 'multi_step_task')
  assert.equal(available.executionChain, 'tool_loop')
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

test('task type resolver routes live external info lookups into the browser tool loop', () => {
  const envelope = buildRequestEnvelope({ userText: '帮我看看今天广州天气怎么样' })
  const result = resolveTaskType({
    intent: classifyIntent(envelope),
    envelope,
    capabilities: createCapabilities(),
  })

  assert.equal(result.taskType, 'short_task')
  assert.equal(result.executionChain, 'tool_loop')
  assert.equal(result.preferredExecutor, 'browser')
})

test('task type resolver routes platform public-ranking lookups into the browser tool loop', () => {
  const envelope = buildRequestEnvelope({ userText: 'youtube 上面 aespa 播放量最高的视频是什么？' })
  const result = resolveTaskType({
    intent: classifyIntent(envelope),
    envelope,
    capabilities: createCapabilities(),
  })

  assert.equal(result.taskType, 'short_task')
  assert.equal(result.executionChain, 'tool_loop')
  assert.equal(result.preferredExecutor, 'browser')
})

test('task type resolver routes location-heavy comparison requests into research', () => {
  const envelope = buildRequestEnvelope({
    userText: '比较北京几个 IT 园区的产业特色和适合入驻的公司类型，位置可以提到，但不要做导航。',
  })
  const result = resolveTaskType({
    intent: classifyIntent(envelope),
    envelope,
    capabilities: createCapabilities(),
  })

  assert.equal(result.taskType, 'research')
  assert.equal(result.executionChain, 'domain_executor')
  assert.equal(result.preferredExecutor, 'research')
})

test('task type resolver routes pet sticky note requests into the tool loop', () => {
  const envelope = buildRequestEnvelope({ userText: '贴到便利贴里面' })
  const result = resolveTaskType({
    intent: classifyIntent(envelope),
    envelope,
    capabilities: createCapabilities(),
  })

  assert.equal(result.taskType, 'short_task')
  assert.equal(result.executionChain, 'tool_loop')
  assert.equal(result.preferredExecutor, 'none')
})

test('task type resolver keeps browser capability meta questions on the direct answer path', () => {
  const envelope = buildRequestEnvelope({ userText: '你不能调用浏览器工具吗？' })
  const result = resolveTaskType({
    intent: classifyIntent(envelope),
    envelope,
    capabilities: createCapabilities(),
  })

  assert.equal(result.taskType, 'direct_answer')
  assert.equal(result.executionChain, 'direct')
  assert.equal(result.preferredExecutor, 'none')
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

test('task type resolver routes explicit skill workflow requests into the skill executor path', () => {
  const envelope = buildRequestEnvelope({ userText: '用 skill 帮我继续执行这个 workflow，并处理 blocker' })
  const result = resolveTaskType({
    intent: classifyIntent(envelope),
    envelope,
    capabilities: createCapabilities(),
  })

  assert.equal(result.taskType, 'multi_step_task')
  assert.equal(result.executionChain, 'domain_executor')
  assert.equal(result.preferredExecutor, 'skill')
})
