import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

import { AgentSdkRuntime, type AgentSdkRuntimeDeps } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { classifyExecutionError } from '../main/modules/claude-bridge/error-classifier'

test('sdk-loop-provider-retry declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'sdk-loop-provider-retry transitive sqlite load')
})

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

function createRuntime(runAgent: AgentSdkRuntimeDeps['runAgent']): AgentSdkRuntime {
  return new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    runAgent,
  } as Partial<AgentSdkRuntimeDeps> as AgentSdkRuntimeDeps)
}

test('stream-cut shapes classify as transient (single policy source)', () => {
  assert.equal(classifyExecutionError(new Error('ERR_STREAM_PREMATURE_CLOSE: Premature close')).kind, 'transient')
  assert.equal(classifyExecutionError(new Error('fetch failed')).kind, 'transient')
  assert.equal(classifyExecutionError(new Error('terminated')).kind, 'transient')
  assert.equal(classifyExecutionError(new Error('HTTP 429 too many requests')).kind, 'rate_limit')
})

test('two 429s then success keeps the run alive with exactly two retries', async () => {
  let calls = 0
  const runtime = createRuntime(async () => {
    calls += 1
    if (calls <= 2) throw new Error('HTTP 429 Too Many Requests')
    return { finalText: '成功了。', toolTrace: [] }
  })
  runtime.newSession('butler::scope-retry', 'system prompt')
  const result = await runtime.sendMessage('butler::scope-retry', '查个东西', 'run-retry-1', {})
  assert.equal(result.success, true)
  assert.equal(calls, 3)
  assert.equal(result.finalText.includes('成功了'), true)
})

test('persistent 5xx exhausts retries and surfaces a classified failure', async () => {
  let calls = 0
  const runtime = createRuntime(async () => {
    calls += 1
    throw new Error('HTTP 503 Service Unavailable')
  })
  runtime.on('error', () => {})
  runtime.newSession('butler::scope-retry-fail', 'system prompt')
  const result = await runtime.sendMessage('butler::scope-retry-fail', '查个东西', 'run-retry-2', {})
  assert.equal(result.success, false)
  // 1 initial + maxAttempts(3) retries = 4 calls
  assert.equal(calls, 4)
})
