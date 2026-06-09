import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentSdkRuntime, type AgentSdkRuntimeDeps } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { createTaskBudgetRuntime } from '../main/modules/agent-control/task-projection/run-budget-policy'

const fakeConfig = {
  provider: 'openai-compatible',
  baseUrl: 'https://example.com/v1/messages',
  apiKey: 'test-key',
  model: 'custom-model',
  contextWindowOverride: 96_000,
} as const

function createRuntime(deps: Partial<AgentSdkRuntimeDeps>): AgentSdkRuntime {
  return new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    ...deps,
  })
}

test('Agent SDK scoped run writes long-task run_meta fields on close', async () => {
  const rows = new Map<string, Record<string, unknown>>()
  const repo = {
    get: (runId: string) => rows.get(runId) || null,
    create: (input: Record<string, unknown>) => {
      rows.set(String(input.runId), { ...input })
      return input
    },
    update: (runId: string, patch: Record<string, unknown>) => {
      rows.set(runId, { ...(rows.get(runId) || {}), ...patch })
      return rows.get(runId)
    },
  }
  const runtime = createRuntime({
    runAgent: async () => ({
      finalText: 'done',
      usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    }),
  })
  runtime.setRuntime({
    getRunMetaRepository: () => repo,
  } as never)
  runtime.newSession('butler::scope-run-meta', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-run-meta',
    'run meta proof',
    'run-meta-proof',
    {
      publicSessionId: 'scope-run-meta',
      taskId: 'task-run-meta',
      taskBudgetRuntime: createTaskBudgetRuntime('research'),
    },
  )

  assert.equal(result.success, true)
  const row = rows.get('run-meta-proof')
  assert.ok(row)
  assert.equal(row.taskId, 'task-run-meta')
  assert.equal(row.scopeId, 'scope-run-meta')
  assert.equal(row.status, 'done')
  assert.equal(row.taskType, 'research')
  assert.equal(row.terminalReason, 'done')
  assert.equal(row.providerProtocol, 'anthropic')
  assert.equal(row.contextWindow, 96_000)
  assert.deepEqual(row.budget, {
    maxIterations: 60,
    maxToolCalls: 60,
    maxParallelToolGroups: 5,
    reservedToolCalls: 0,
    iterationsUsed: 0,
    toolCallsUsed: 0,
    parallelToolGroupsUsed: 0,
  })
  assert.equal(row.totalTokens, 18)
})
