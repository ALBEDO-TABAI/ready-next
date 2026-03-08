import { describe, it } from 'node:test'
import assert from 'node:assert'

import { resolveAIConfigCapabilities, type AIModelConfig } from '../shared/ai-providers'

describe('resolveAIConfigCapabilities', () => {
  it('infers fox codex responses stack from base url', () => {
    const config: AIModelConfig = {
      provider: 'openai-compatible',
      baseUrl: 'https://code.newcli.com/codex/v1',
      apiKey: 'test-key',
      model: 'gpt-5.4',
    }

    const capabilities = resolveAIConfigCapabilities(config)
    assert.ok(capabilities)
    assert.strictEqual(capabilities?.agentProtocol, 'openai')
    assert.strictEqual(capabilities?.wireApi, 'responses')
    assert.strictEqual(capabilities?.supportsToolCalls, true)
    assert.strictEqual(capabilities?.supportsNativeToolCalls, false)
    assert.strictEqual(capabilities?.toolCallTransport, 'text')
    assert.strictEqual(capabilities?.supportsVision, true)
  })

  it('supports explicit anthropic agent protocol on custom providers', () => {
    const config: AIModelConfig = {
      provider: 'openai-compatible',
      baseUrl: 'https://example.com/anthropic',
      apiKey: 'test-key',
      model: 'custom-model',
      agentProtocol: 'anthropic',
      toolUseMode: 'on',
      visionMode: 'off',
    }

    const capabilities = resolveAIConfigCapabilities(config)
    assert.ok(capabilities)
    assert.strictEqual(capabilities?.agentProtocol, 'anthropic')
    assert.strictEqual(capabilities?.wireApi, undefined)
    assert.strictEqual(capabilities?.supportsToolCalls, true)
    assert.strictEqual(capabilities?.supportsNativeToolCalls, true)
    assert.strictEqual(capabilities?.toolCallTransport, 'native')
    assert.strictEqual(capabilities?.supportsVision, false)
  })
})
