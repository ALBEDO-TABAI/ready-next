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
    // Stage S (PR-S5): vision now flows through the three-layer
    // capabilityClass merge. `openai-compatible` declares
    // `supportsVision: false`, so endpoints under that provider must
    // default to `false` instead of inferring `true` from
    // `agentProtocol === 'openai'`. This is the conservative-default
    // contract — unsupported providers no longer silently pass through.
    assert.strictEqual(capabilities?.supportsVision, false)
    assert.strictEqual(capabilities?.supportsNativeVideo, false)
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
    assert.strictEqual(capabilities?.supportsNativeVideo, false)
  })

  it('infers anthropic protocol from custom anthropic base url path', () => {
    const config: AIModelConfig = {
      provider: 'openai-compatible',
      baseUrl: 'https://example.com/anthropic',
      apiKey: 'test-key',
      model: 'custom-model',
    }

    const capabilities = resolveAIConfigCapabilities(config)
    assert.ok(capabilities)
    assert.strictEqual(capabilities?.agentProtocol, 'anthropic')
    assert.strictEqual(capabilities?.wireApi, undefined)
    assert.strictEqual(capabilities?.supportsNativeToolCalls, true)
  })

  it('infers anthropic protocol from v1 messages base url', () => {
    const config: AIModelConfig = {
      provider: 'openai-compatible',
      baseUrl: 'https://example.com/v1/messages',
      apiKey: 'test-key',
      model: 'custom-model',
    }

    const capabilities = resolveAIConfigCapabilities(config)
    assert.ok(capabilities)
    assert.strictEqual(capabilities?.agentProtocol, 'anthropic')
    assert.strictEqual(capabilities?.wireApi, undefined)
    assert.strictEqual(capabilities?.supportsNativeToolCalls, true)
  })
})
