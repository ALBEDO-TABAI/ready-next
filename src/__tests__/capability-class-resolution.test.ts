/**
 * Stage S (PR-S5 / W4.0) — three-layer capability merge.
 *
 * Verifies that `resolveAIConfigCapabilities` honours the priority
 * order:
 *
 *   model.capabilityOverrides  >  provider.capabilityClass  >  legacy
 *
 * The 7 built-in providers are each exercised at the provider-class
 * layer (no overrides, no user-mode toggles) plus a small set of
 * focused override / mode-toggle cases on Anthropic / OpenAI to prove
 * the higher layers win.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  AI_PROVIDERS,
  resolveAIConfigCapabilities,
  type AIModelConfig,
  type AIProviderType,
} from '../shared/ai-providers'

function configFor(providerId: AIProviderType, model?: string, extra?: Partial<AIModelConfig>): AIModelConfig {
  const provider = AI_PROVIDERS.find(p => p.id === providerId)
  if (!provider) throw new Error(`unknown provider: ${providerId}`)
  return {
    provider: providerId,
    baseUrl: provider.baseUrl,
    apiKey: 'test-key',
    model: model || provider.models.find(m => m.id !== '__custom__' && m.id !== 'custom')?.id || provider.models[0]!.id,
    ...(extra || {}),
  }
}

describe('resolveAIConfigCapabilities — three-layer capabilityClass merge', () => {
  describe('provider-class layer (no overrides)', () => {
    it('moonshot — vision=false, thinking=false, longContext=true', () => {
      const caps = resolveAIConfigCapabilities(configFor('moonshot'))
      assert.ok(caps)
      assert.strictEqual(caps?.supportsVision, false)
      assert.strictEqual(caps?.supportsThinking, false)
      assert.strictEqual(caps?.supportsLongContext, true)
    })

    it('anthropic — vision=true, thinking=true, longContext=true', () => {
      const caps = resolveAIConfigCapabilities(configFor('anthropic'))
      assert.ok(caps)
      assert.strictEqual(caps?.supportsVision, true)
      assert.strictEqual(caps?.supportsThinking, true)
      assert.strictEqual(caps?.supportsLongContext, true)
      assert.strictEqual(caps?.multiTurnThinkingPolicy, 'echo_required')
    })

    it('fox — conservative default (vision=false, thinking=false, longContext=false)', () => {
      const caps = resolveAIConfigCapabilities(configFor('fox'))
      assert.ok(caps)
      assert.strictEqual(caps?.supportsVision, false)
      assert.strictEqual(caps?.supportsThinking, false)
      assert.strictEqual(caps?.supportsLongContext, false)
      assert.strictEqual(caps?.multiTurnThinkingPolicy, 'unknown')
    })

    it('openai — vision=true, thinking=false, longContext=true', () => {
      const caps = resolveAIConfigCapabilities(configFor('openai'))
      assert.ok(caps)
      assert.strictEqual(caps?.supportsVision, true)
      assert.strictEqual(caps?.supportsNativeVideo, true)
      assert.strictEqual(caps?.supportsThinking, false)
      assert.strictEqual(caps?.supportsLongContext, true)
    })

    it('gemini — vision=true, thinking=true, longContext=true', () => {
      const caps = resolveAIConfigCapabilities(configFor('gemini'))
      assert.ok(caps)
      assert.strictEqual(caps?.supportsVision, true)
      assert.strictEqual(caps?.supportsThinking, true)
      assert.strictEqual(caps?.supportsLongContext, true)
    })

    it('volcengine — conservative default (all three false)', () => {
      const caps = resolveAIConfigCapabilities(configFor('volcengine'))
      assert.ok(caps)
      assert.strictEqual(caps?.supportsVision, false)
      assert.strictEqual(caps?.supportsNativeVideo, false)
      assert.strictEqual(caps?.supportsThinking, false)
      assert.strictEqual(caps?.supportsLongContext, false)
    })

    it('openai-compatible — conservative default (all three false)', () => {
      const caps = resolveAIConfigCapabilities(configFor('openai-compatible'))
      assert.ok(caps)
      assert.strictEqual(caps?.supportsVision, false)
      assert.strictEqual(caps?.supportsNativeVideo, false)
      assert.strictEqual(caps?.supportsThinking, false)
      assert.strictEqual(caps?.supportsLongContext, false)
    })
  })

  describe('model-overrides layer (highest priority)', () => {
    it('a model with capabilityOverrides.supportsVision=false beats provider class true', () => {
      // Patch the AI_PROVIDERS in-memory: anthropic claude-haiku to
      // declare `supportsVision: false`. We mutate the local model def
      // object to keep this hermetic to the test; restore afterwards.
      const provider = AI_PROVIDERS.find(p => p.id === 'anthropic')!
      const model = provider.models.find(m => m.id === 'claude-haiku-3-5-20241022')!
      const previous = model.capabilityOverrides
      model.capabilityOverrides = { supportsVision: false, supportsNativeVideo: false, supportsThinking: false, supportsLongContext: false }
      try {
        const caps = resolveAIConfigCapabilities(configFor('anthropic', 'claude-haiku-3-5-20241022'))
        assert.ok(caps)
        assert.strictEqual(caps?.supportsVision, false, 'model override must win over provider class')
        assert.strictEqual(caps?.supportsNativeVideo, false)
        assert.strictEqual(caps?.supportsThinking, false)
        assert.strictEqual(caps?.supportsLongContext, false)
      } finally {
        model.capabilityOverrides = previous
      }
    })

    it('a model with capabilityOverrides.supportsThinking=true beats provider class false', () => {
      const provider = AI_PROVIDERS.find(p => p.id === 'openai')!
      const model = provider.models.find(m => m.id === 'gpt-4o')!
      const previous = model.capabilityOverrides
      model.capabilityOverrides = { supportsThinking: true }
      try {
        const caps = resolveAIConfigCapabilities(configFor('openai', 'gpt-4o'))
        assert.ok(caps)
        // Vision and longContext fall through to provider class (still true / true).
        assert.strictEqual(caps?.supportsVision, true)
        assert.strictEqual(caps?.supportsLongContext, true)
        // Thinking flipped by the model override.
        assert.strictEqual(caps?.supportsThinking, true, 'model override must win over provider class')
      } finally {
        model.capabilityOverrides = previous
      }
    })

    it('a model with capabilityOverrides.multiTurnThinkingPolicy beats provider class/default', () => {
      const provider = AI_PROVIDERS.find(p => p.id === 'openai-compatible')!
      const model = provider.models.find(m => m.id !== '__custom__' && m.id !== 'custom')!
      const previous = model.capabilityOverrides
      model.capabilityOverrides = { multiTurnThinkingPolicy: 'proven_safe' }
      try {
        const caps = resolveAIConfigCapabilities(configFor('openai-compatible', model.id))
        assert.ok(caps)
        assert.strictEqual(caps?.multiTurnThinkingPolicy, 'proven_safe')
      } finally {
        model.capabilityOverrides = previous
      }
    })
  })

  describe('user mode toggle (visionMode / thinkingMode / longContextMode)', () => {
    it('visionMode=on forces vision true even if provider class is false', () => {
      const caps = resolveAIConfigCapabilities(configFor('volcengine', undefined, { visionMode: 'on' }))
      assert.ok(caps)
      assert.strictEqual(caps?.supportsVision, true)
    })

    it('nativeVideoMode=on forces native video true even if provider class is false', () => {
      const caps = resolveAIConfigCapabilities(configFor('openai-compatible', undefined, { nativeVideoMode: 'on' }))
      assert.ok(caps)
      assert.strictEqual(caps?.supportsNativeVideo, true)
    })

    it('xiaomi mimo pro custom profile does not inherit image support by model prefix', () => {
      const caps = resolveAIConfigCapabilities(configFor('openai-compatible', 'mimo-v2.5-pro', {
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
        agentProtocol: 'anthropic',
        visionMode: 'auto',
      }))
      assert.ok(caps)
      assert.strictEqual(caps?.supportsVision, false)
    })

    it('thinkingMode=off forces thinking false even if provider class is true', () => {
      const caps = resolveAIConfigCapabilities(configFor('anthropic', undefined, { thinkingMode: 'off' }))
      assert.ok(caps)
      assert.strictEqual(caps?.supportsThinking, false)
    })

    it('longContextMode=auto preserves the merged default (provider class layer)', () => {
      const caps = resolveAIConfigCapabilities(configFor('moonshot', undefined, { longContextMode: 'auto' }))
      assert.ok(caps)
      assert.strictEqual(caps?.supportsLongContext, true)
    })
  })

  describe('legacy fallback (longContext via contextWindow)', () => {
    it('a custom openai-compatible model with no overrides and contextWindow >= 128000 ' +
       'still resolves longContext=false because provider class already set false (provider class beats legacy)', () => {
      // openai-compatible.capabilityClass.supportsLongContext = false,
      // so even if we synthesise a model with contextWindow=200000, the
      // provider class (false) wins over the legacy heuristic.
      const provider = AI_PROVIDERS.find(p => p.id === 'openai-compatible')!
      const customModelId = '__resolution_test_custom__'
      provider.models.push({ id: customModelId, label: 'test', category: 'chat', contextWindow: 200_000 })
      try {
        const caps = resolveAIConfigCapabilities(configFor('openai-compatible', customModelId))
        assert.ok(caps)
        assert.strictEqual(caps?.supportsLongContext, false, 'provider class layer must beat legacy contextWindow heuristic')
      } finally {
        const idx = provider.models.findIndex(m => m.id === customModelId)
        if (idx >= 0) provider.models.splice(idx, 1)
      }
    })
  })
})
