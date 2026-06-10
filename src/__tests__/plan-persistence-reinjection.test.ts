import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

import { AgentSdkRuntime, type AgentSdkRuntimeDeps } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import {
  buildActivePlanReminderText,
  deriveCollectionPlanFromToolCall,
  noteToolResultForActivePlan,
  resetActivePlansForTests,
} from '../main/modules/agent-control/system-reminders/active-plan-step-reminder'

test('plan-persistence-reinjection declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'plan-persistence-reinjection transitive sqlite load')
})

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

function collectionTool(name: string): ToolDefinition {
  return {
    name,
    groupId: 'browser_content_tasks',
    domain: 'browser',
    kind: 'write',
    concurrency: 'serial',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: true },
    description: `${name} test stub`,
    schema: { type: 'object', properties: {}, additionalProperties: false },
    executionVisibility: 'model',
    resultShape: 'json',
  }
}

test('collection plan derives, advances on tool results, and stays scoped', () => {
  resetActivePlansForTests()
  const plan = deriveCollectionPlanFromToolCall('browser_visible_collect', { url: 'https://example.com/u/1' }, 1000)
  assert.ok(plan)
  assert.equal(plan?.steps.length, 3)
  assert.equal(plan?.verify, 'weak')

  noteToolResultForActivePlan('scope-a', 'browser_visible_collect', { url: 'https://example.com/u/1' }, 1000)
  let text = buildActivePlanReminderText('scope-a', 1000)
  assert.ok(text && text.includes('当前步骤 2/3'), `expected step 2 current, got: ${text}`)
  assert.ok(text && text.includes('verify=weak'))

  noteToolResultForActivePlan('scope-a', 'browser_collect_notes', {}, 2000)
  text = buildActivePlanReminderText('scope-a', 2000)
  assert.ok(text && text.includes('当前步骤 3/3'), `expected step 3 current, got: ${text}`)

  // other scopes see nothing
  assert.equal(buildActivePlanReminderText('scope-b', 2000), null)

  // stale plans stop injecting
  assert.equal(buildActivePlanReminderText('scope-a', 2000 + 31 * 60_000), null)
})

test('next turn model input carries the re-injected current plan step', async () => {
  resetActivePlansForTests()
  const inputs: string[] = []
  let turn = 0
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [collectionTool('browser_visible_collect'), collectionTool('browser_collect_notes')],
    executeToolCall: async () => createToolExecutionOutput('ok', { shape: 'json', data: { ok: true } }),
    runAgent: async ({ input, tools }) => {
      inputs.push(typeof input === 'string' ? input : JSON.stringify(input))
      turn += 1
      if (turn === 1) {
        const dispatch = (tools as Array<{ name: string; invoke: (ctx: unknown, raw: string) => Promise<string> }>)
          .find((toolItem) => toolItem.name === 'browser_visible_collect')
        assert.ok(dispatch)
        await dispatch!.invoke({}, JSON.stringify({ url: 'https://example.com/u/1' }))
        return { finalText: '已启动清单发现。', toolTrace: [{ name: 'browser_visible_collect' }] }
      }
      return { finalText: '收到。', toolTrace: [] }
    },
  } as Partial<AgentSdkRuntimeDeps> as AgentSdkRuntimeDeps)

  runtime.newSession('butler::scope-plan', 'system prompt')
  await runtime.sendMessage('butler::scope-plan', '把这个博主的全部笔记采集下来', 'run-plan-1', {})
  await runtime.sendMessage('butler::scope-plan', '继续', 'run-plan-2', {})

  assert.equal(inputs.length >= 2, true)
  const secondTurnInput = inputs[1]
  assert.ok(secondTurnInput.includes('[活动计划]'), `expected plan reminder in second turn input, got: ${secondTurnInput.slice(0, 200)}`)
  assert.ok(secondTurnInput.includes('当前步骤 2/3'), 'expected current step 2 after discovery completed')
})
