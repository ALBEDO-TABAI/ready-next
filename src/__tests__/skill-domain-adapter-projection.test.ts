import assert from 'node:assert/strict'
import test from 'node:test'

import { SkillDomainAdapter } from '../main/modules/agent-control/skill-domain-adapter'

function createRoute() {
  return {
    taskId: 'task-1',
    taskType: 'short_task' as const,
    chain: 'domain_executor' as const,
    executor: 'skill' as const,
    steps: [],
    continuation: null,
  }
}

test('skill adapter surfaces no-tool dispatch failures as a task projection patch', () => {
  const adapter = new SkillDomainAdapter()
  const result = adapter.dispatch({
    route: createRoute(),
    request: {} as never,
    host: {} as never,
    session: { messages: [] } as never,
    userText: 'use a skill',
    pureUserInput: 'use a skill',
    requestEnvelope: {} as never,
    executionIntentContext: {} as never,
    hasTools: true,
    toolPolicy: {} as never,
    allowedToolNames: ['memory_recall'],
    domainState: null,
    emitStructuredTaskPayload: () => undefined,
  } as never) as Awaited<ReturnType<typeof adapter.dispatch>>

  const patch = adapter.buildProjectionPatch({
    route: createRoute(),
    request: {} as never,
    executionIntentContext: {} as never,
    toolPolicy: {} as never,
    domainState: result.domainState,
    projection: result.projection || null,
  } as never)

  assert.equal(patch?.module, 'skill')
  assert.equal(patch?.taskTitle, 'Skill 任务')
  assert.equal(patch?.taskSummary, '本轮没有可用的 skill 工具')
  assert.equal(patch?.blockedReason, '未解析到可用的 skill_* 工具')
  assert.deepEqual(patch?.resumableActions, ['retry', 'cancel'])
})

test('skill adapter keeps clarification waiting patches blocked', () => {
  const adapter = new SkillDomainAdapter()
  const state = {
    latestProjectionPatch: {
      taskSummary: '等待补充视频风格',
      waitingFor: 'clarification',
      blockedReason: '需要补充视频风格',
      resumableActions: ['continue', 'cancel'],
    },
    dispatchedAt: '2026-04-26T10:00:00.000Z',
  }

  const result = adapter.applyResult({
    route: createRoute(),
    request: {} as never,
    host: {} as never,
    session: { messages: [] } as never,
    userText: 'continue',
    pureUserInput: 'continue',
    requestEnvelope: {} as never,
    executionIntentContext: {} as never,
    toolPolicy: {} as never,
    allowedToolNames: ['skill_get_state'],
    domainState: state,
    phase: 'no_tool_call',
  } as never) as Awaited<ReturnType<typeof adapter.applyResult>>

  assert.equal(result.projection?.phase, 'blocked')
  assert.equal(result.projection?.waitingFor, 'clarification')
  assert.equal(result.projection?.blockedReason, '需要补充视频风格')
  assert.deepEqual(result.projection?.resumableActions, ['continue', 'cancel'])
})
