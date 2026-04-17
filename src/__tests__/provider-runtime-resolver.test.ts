import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveOpenAIProviderRuntime, shouldRetryWithTextToolBridge, shouldUseTextToolBridgeForRun } from '../main/modules/agent-control/provider-runtime-resolver'
import type { AIModelConfig } from '../shared/ai-providers'

function createConfig(overrides: Partial<AIModelConfig> = {}): AIModelConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test',
    model: 'gpt-test',
    ...overrides,
  }
}

test('resolveOpenAIProviderRuntime prefers explicit wire api and reasoning effort', () => {
  const runtime = resolveOpenAIProviderRuntime({
    config: createConfig({ wireApi: 'responses', reasoningEffort: 'high' }),
    baseUrl: 'https://example.com/v1',
  })

  assert.equal(runtime.wireApi, 'responses')
  assert.equal(runtime.reasoningEffort, 'high')
})

test('resolveOpenAIProviderRuntime falls back to codex responses defaults', () => {
  const runtime = resolveOpenAIProviderRuntime({
    config: createConfig({ baseUrl: 'https://code.newcli.com/codex/v1' }),
    baseUrl: 'https://code.newcli.com/codex/v1',
  })

  assert.equal(runtime.wireApi, 'responses')
})

test('provider runtime resolver decides text bridge usage and retry consistently', () => {
  const config = createConfig({ baseUrl: 'https://example.com/v1' })

  assert.equal(shouldUseTextToolBridgeForRun({ config, preferTextToolBridge: false }), false)
  assert.equal(shouldUseTextToolBridgeForRun({ config, preferTextToolBridge: true }), true)
  assert.equal(shouldRetryWithTextToolBridge({
    text: 'No available tools in this session.',
    config,
    preferTextToolBridge: false,
  }), true)
  assert.equal(shouldRetryWithTextToolBridge({
    text: 'No available tools in this session.',
    config,
    preferTextToolBridge: true,
  }), false)
  assert.equal(shouldRetryWithTextToolBridge({
    text: '我这边当前消息里虽然写了“浏览器任务执行计划”，但实际没有可调用的浏览器工具组结果返回给我。',
    config,
    preferTextToolBridge: false,
  }), true)
})
