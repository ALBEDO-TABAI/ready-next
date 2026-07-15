import { describe, it } from 'node:test'
import assert from 'node:assert'

import { resolveAIConfigCapabilities, type AIModelConfig } from '../shared/ai-providers'

describe('resolveAIConfigCapabilities', () => {
  it('does not infer tool support for a generic codex-style endpoint', () => {
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
    assert.strictEqual(capabilities?.supportsToolCalls, false)
    assert.strictEqual(capabilities?.supportsNativeToolCalls, false)
    assert.strictEqual(capabilities?.toolCallTransport, 'none')
    // Stage S (PR-S5): vision now flows through the three-layer
    // capabilityClass merge. `openai-compatible` declares
    // `supportsVision: false`, so endpoints under that provider must
    // default to `false` instead of inferring `true` from
    // `agentProtocol === 'openai'`. This is the conservative-default
    // contract — unsupported providers no longer silently pass through.
    assert.strictEqual(capabilities?.supportsVision, false)
    assert.strictEqual(capabilities?.supportsNativeVideo, false)
  })

  it('honors an explicit tool opt-in for a generic codex-style endpoint', () => {
    const capabilities = resolveAIConfigCapabilities({
      provider: 'openai-compatible',
      baseUrl: 'https://code.newcli.com/codex/v1',
      apiKey: 'test-key',
      model: 'gpt-5.4',
      toolUseMode: 'on',
    })

    assert.ok(capabilities)
    assert.strictEqual(capabilities?.supportsToolCalls, true)
    assert.strictEqual(capabilities?.supportsNativeToolCalls, false)
    assert.strictEqual(capabilities?.toolCallTransport, 'text')
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
    assert.strictEqual(capabilities?.supportsToolCalls, false)
    assert.strictEqual(capabilities?.supportsNativeToolCalls, false)
    assert.strictEqual(capabilities?.toolCallTransport, 'none')
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
    assert.strictEqual(capabilities?.supportsToolCalls, false)
    assert.strictEqual(capabilities?.supportsNativeToolCalls, false)
    assert.strictEqual(capabilities?.toolCallTransport, 'none')
  })

  it('keeps built-in providers tool-capable in auto mode', () => {
    const configs: AIModelConfig[] = [
      {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'gpt-5.4',
      },
      {
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'test-key',
        model: 'claude-sonnet-4-20250514',
      },
      {
        provider: 'fox',
        baseUrl: 'https://code.newcli.com/codex/v1',
        apiKey: 'test-key',
        model: 'gpt-5.4',
      },
    ]

    for (const config of configs) {
      const capabilities = resolveAIConfigCapabilities(config)
      assert.ok(capabilities)
      assert.strictEqual(capabilities?.supportsToolCalls, true, config.provider)
    }
  })
})
