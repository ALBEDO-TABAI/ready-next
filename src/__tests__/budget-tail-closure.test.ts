import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

import {
  createTaskBudgetRuntime,
  consumeToolCallBudget,
  freezeBudgetRuntime,
  resumeBudgetRuntime,
  rebindTaskBudgetRuntime,
  getBudgetUsagePercent,
} from '../main/modules/agent-control/task-projection/run-budget-policy'
import { AgentSdkRuntime, type AgentSdkRuntimeDeps } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

function readTool(): ToolDefinition {
  return {
    name: 'web_search',
    groupId: 'general_research',
    domain: 'general_research',
    kind: 'read',
    concurrency: 'parallel_read_safe',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: true },
    description: 'search stub',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    executionVisibility: 'model',
    resultShape: 'json',
  }
}

test('budget-tail-closure declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'budget-tail-closure transitive sqlite load')
})

test('L-f1: continuation resume and rebind preserve consumed usage (no double budget)', () => {
  let runtime = createTaskBudgetRuntime('research')
  for (let i = 0; i < 10; i++) runtime = consumeToolCallBudget(runtime)
  assert.equal(runtime.usage.toolCallsUsed, 10)

  const frozen = freezeBudgetRuntime(runtime)
  const resumed = resumeBudgetRuntime(frozen)
  assert.equal(resumed.usage.toolCallsUsed, 10, 'resume must not reset usage')
  assert.equal(resumed.frozen, false)

  const rebound = rebindTaskBudgetRuntime(resumed, 'research', { bootstrapBudget: false })
  assert.equal(rebound.usage.toolCallsUsed, 10, 'rebind must carry usage forward')

  const pct = getBudgetUsagePercent(rebound)
  assert.ok(pct > 0, 'usage percent reflects carried consumption')
})

test('L-f3: crossing a warning threshold stays diagnostic and does not mutate tool results', async () => {
  const invokeReturns: string[] = []
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [readTool()],
    executeToolCall: async () => createToolExecutionOutput('result', { shape: 'json', data: { ok: true } }),
    runAgent: async ({ tools }) => {
      const search = (tools as Array<{ name: string; invoke: (ctx: unknown, raw: string) => Promise<string> }>)
        .find((toolItem) => toolItem.name === 'web_search')!
      for (let i = 0; i < 6; i++) {
        invokeReturns.push(await search.invoke({}, JSON.stringify({})))
      }
      return { finalText: '完成。', toolTrace: [{ name: 'web_search' }] }
    },
  } as Partial<AgentSdkRuntimeDeps> as AgentSdkRuntimeDeps)
  runtime.newSession('butler::scope-steer', 'system prompt')
  const result = await runtime.sendMessage('butler::scope-steer', '查资料', 'run-steer-1', {
    publicSessionId: 'scope-steer',
    taskId: 'task-steer',
    taskBudgetRuntime: createTaskBudgetRuntime('direct_answer'),
  })
  assert.equal(result.success, true)
  assert.ok(invokeReturns.every((text) => !text.includes('budgetSteeringInjected')))
  assert.equal(result.projectionTruth?.projectionPatch?.budgetWarningLevel, 'warning')
})

test('L-f4/L-f5: run_meta budget carries the live taskType and rolling checkpoint persists mid-run', async () => {
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [readTool()],
    executeToolCall: async () => createToolExecutionOutput('result', { shape: 'json', data: { ok: true } }),
    runAgent: async ({ tools }) => {
      const search = (tools as Array<{ name: string; invoke: (ctx: unknown, raw: string) => Promise<string> }>)
        .find((toolItem) => toolItem.name === 'web_search')!
      // Five tool calls within one SDK run cross the rolling checkpoint
      // interval. The completed provider boundary persists the snapshot
      // without replaying already completed tool effects.
      for (let i = 0; i < 5; i++) await search.invoke({}, JSON.stringify({}))
      return { finalText: '完成。', toolTrace: [{ name: 'web_search' }] }
    },
  } as Partial<AgentSdkRuntimeDeps> as AgentSdkRuntimeDeps)
  runtime.newSession('butler::scope-rolling', 'system prompt')
  const result = await runtime.sendMessage('butler::scope-rolling', '查资料', 'run-rolling-1', {
    publicSessionId: 'scope-rolling',
    taskId: 'task-rolling',
    taskBudgetRuntime: createTaskBudgetRuntime('research'),
  })
  assert.equal(result.success, true)
  assert.equal(result.executionDiagnostics?.taskBudgetRuntime?.taskType, 'research', 'live runtime taskType flows to diagnostics (run_meta source)')
  const runStatePath = join(tmpdir(), 'ready-agent-continuations', 'task-rolling', 'run-rolling-1', 'run_state.json')
  assert.ok(existsSync(runStatePath), `expected rolling checkpoint at ${runStatePath}`)
})
