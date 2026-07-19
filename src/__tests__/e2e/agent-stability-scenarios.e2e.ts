/**
 * S6-2 — roadmap §6 scenario acceptance (scripted seam).
 *
 * Three user-level scenarios from the 2026-06-09 forensics, asserted at the
 * outcome layer the user actually experiences. Mechanism details live in the
 * focused tests; these compose them end to end.
 */

import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { skipIfSqliteUnavailable } from '../utils/sqlite-skip'

import { AgentSdkRuntime, type AgentSdkRuntimeDeps } from '../../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { createToolExecutionOutput } from '../../main/modules/agent-control/tools-runtime/tool-result-types'
import { createTaskBudgetRuntime } from '../../main/modules/agent-control/task-projection/run-budget-policy'
import { ScriptedAgentRunner } from '../helpers/scripted-agent-runner'
import { canonicalCoreCloseoutTestPort } from '../helpers/canonical-core-closeout-test-port'
import {
  clearScopeSessionSnapshot,
  scopeSessionSnapshotPath,
  writeScopeSessionSnapshot,
} from '../../main/modules/agent-control/session/scope-session-snapshot'

test('agent-stability-scenarios declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'agent-stability-scenarios transitive sqlite load')
})

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

class MemoryRunMetaRepository {
  readonly rows = new Map<string, Record<string, unknown>>()
  get(runId: string): Record<string, unknown> | null {
    return this.rows.get(runId) || null
  }
  create(input: Record<string, unknown>): Record<string, unknown> {
    this.rows.set(String(input.runId), { ...input })
    return input
  }
  update(runId: string, patch: Record<string, unknown>): Record<string, unknown> | null {
    const next = { ...(this.rows.get(runId) || {}), ...patch }
    this.rows.set(runId, next)
    return next
  }
}

function buildRuntime(deps: Partial<AgentSdkRuntimeDeps>): {
  runtime: AgentSdkRuntime
  repository: MemoryRunMetaRepository
  outputs: Array<{ chunk: string; type: string }>
} {
  const repository = new MemoryRunMetaRepository()
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    ...deps,
  })
  runtime.setRuntime({
    ...canonicalCoreCloseoutTestPort(),
    getRunMetaRepository: () => repository,
    publishScopeRunEvent: () => undefined,
    getConversationScope: () => null,
    isChannelTypeAvailable: () => false,
  } as never)
  const outputs: Array<{ chunk: string; type: string }> = []
  runtime.on('output', (event) => outputs.push({
    chunk: String((event as { chunk?: unknown }).chunk || ''),
    type: String((event as { type?: unknown }).type || ''),
  }))
  runtime.on('error', () => undefined)
  return { runtime, repository, outputs }
}

test('场景1 Henry.L：说了不做的 run 不再无声死亡，而是显式 checkpoint + 终态账本', async () => {
  const scripted = new ScriptedAgentRunner({} as AgentSdkRuntimeDeps, [
    { turnIndex: 0, response: '让我先打开这篇笔记：' },
    { turnIndex: 1, response: '好，我现在用浏览器打开第一篇笔记，采集所有图片。' },
  ])
  const { runtime, repository, outputs } = buildRuntime(scripted.deps)
  runtime.newSession('butler::scope-henry', 'system prompt')

  const result = await runtime.sendMessage('butler::scope-henry', '把这个博主的全部笔记采集下来', 'run-henry-1', {
    publicSessionId: 'scope-henry',
    taskId: 'task-henry',
  })

  // 用户可见收口：不是沉默，而是 honest checkpoint 文案
  assert.equal(result.success, true)
  assert.equal(result.terminalReason, 'checkpoint_steered')
  assert.ok(result.finalText.length > 0, 'run must end with user-visible text')
  // 终态账本：run_meta 不允许停留 working
  const row = repository.get('run-henry-1')
  assert.ok(row, 'run_meta row exists')
  assert.notEqual(String(row?.status || ''), 'working')
  // 流式输出里有收口消息
  assert.ok(outputs.some((o) => o.type === 'text' && o.chunk.includes('未能启动')), 'closure text streamed')
})

test('场景2 研究预算：耗尽变成受控 checkpoint，带可继续句柄而不是硬墙', async () => {
  // 预算上限 1 次调用：一批工具结算后 exhausted（沿用已证明的构造形态）
  const budget = createTaskBudgetRuntime('research', {
    budget: {
      maxIterations: 1,
      maxToolCalls: 1,
      maxParallelToolGroups: 5,
      reservedToolCalls: 0,
    },
  })

  const { runtime, repository } = buildRuntime({
    listToolDefinitions: () => [{
      name: 'web_search',
      groupId: 'general_research',
      domain: 'general_research',
      kind: 'read',
      concurrency: 'parallel_read_safe',
      interruptBehavior: 'abort_signal',
      timeoutProfile: 'default',
      supportsTextBridge: true,
      projectionHint: { emitsProjectionPatch: true },
      description: 'stub',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      executionVisibility: 'model',
      resultShape: 'json',
    } as never],
    executeToolCall: async () => createToolExecutionOutput('r', { shape: 'json', data: { ok: true } }),
    runAgent: async ({ tools }) => {
      const search = (tools as Array<{ name: string; invoke: (ctx: unknown, raw: string) => Promise<string> }>)
        .find((toolItem) => toolItem.name === 'web_search')!
      await search.invoke({}, JSON.stringify({}))
      return { finalText: '继续调查中……', toolTrace: [{ name: 'web_search' }] }
    },
  })
  runtime.newSession('butler::scope-budget-e2e', 'system prompt')
  const result = await runtime.sendMessage('butler::scope-budget-e2e', '深入调查这个话题', 'run-budget-e2e-1', {
    publicSessionId: 'scope-budget-e2e',
    taskId: 'task-budget-e2e',
    taskBudgetRuntime: budget,
  })

  assert.equal(result.terminalReason, 'checkpoint_budget')
  assert.ok(result.finalText.includes('已保存续跑检查点'), `expected controlled checkpoint text, got: ${result.finalText}`)
  const runStatePath = join(tmpdir(), 'ready-agent-continuations', 'task-budget-e2e', 'run-budget-e2e-1', 'run_state.json')
  assert.ok(existsSync(runStatePath), 'durable continuation handle written')
  const row = repository.get('run-budget-e2e-1')
  assert.notEqual(String(row?.status || ''), 'working')
})

test('场景3 重启：会话懒恢复有显式通知，损坏快照显式重置', async () => {
  const scope = `butler::scope-restart-e2e-${process.pid}`
  clearScopeSessionSnapshot(scope)
  writeScopeSessionSnapshot(scope, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '之前的任务上下文' }] },
  ])

  const inputs: string[] = []
  const { runtime } = buildRuntime({
    runAgent: async ({ input }) => {
      inputs.push(typeof input === 'string' ? input : JSON.stringify(input))
      return { finalText: '收到，继续。', toolTrace: [] }
    },
  })
  // 全新 runtime 实例 = 重启后的主进程
  await runtime.sendMessage(scope, '继续', 'run-restart-e2e-1', {})
  assert.ok(inputs[0].includes('已恢复上次会话上下文'), 'restore notice visible to the model')

  // 损坏快照 → 显式重置
  const scope2 = `${scope}-corrupt`
  clearScopeSessionSnapshot(scope2)
  writeScopeSessionSnapshot(scope2, [])
  writeFileSync(scopeSessionSnapshotPath(scope2), '{broken', 'utf8')
  const { runtime: runtime2 } = buildRuntime({
    runAgent: async ({ input }) => {
      inputs.push(typeof input === 'string' ? input : JSON.stringify(input))
      return { finalText: '好的。', toolTrace: [] }
    },
  })
  await runtime2.sendMessage(scope2, '你好', 'run-restart-e2e-2', {})
  assert.ok(inputs[1].includes('会话已重置'), 'corrupt snapshot resets explicitly')

  clearScopeSessionSnapshot(scope)
  clearScopeSessionSnapshot(scope2)
})
