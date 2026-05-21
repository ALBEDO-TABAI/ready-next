/**
 * Stage S (PR-S7 / W4.5) — `resolveModelCapabilities` fixture-driven
 * priority tests.
 *
 * The resolver materialises the static (no user-mode toggle) form of
 * the three-layer merge:
 *
 *     model.capabilityOverrides > provider.capabilityClass > false
 *
 * These tests assert the priority directly with synthesised
 * `AIProviderDef` fixtures (no SQLite, no settings repository, no IPC).
 * The runtime check at the `AIModelConfig` level (with user-mode
 * toggles applied) is in `capability-class-resolution.test.ts`.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert'

import {
  AI_PROVIDERS,
  type AIProviderDef,
  type AIProviderType,
} from '../shared/ai-providers'
import { resolveModelCapabilities } from '../shared/ai-providers/model-capability-resolver'

function fixtureProvider(overrides: Partial<AIProviderDef>): AIProviderDef {
  return {
    id: 'openai-compatible',
    label: 'Fixture',
    labelEn: 'Fixture',
    icon: '*',
    baseUrl: 'https://example.invalid',
    authHeader: 'Authorization',
    authPrefix: 'Bearer ',
    models: [],
    apiKeyPlaceholder: '',
    helpUrl: '',
    ...overrides,
  } as AIProviderDef
}

describe('resolveModelCapabilities — three-layer priority', () => {
  it('falls back to conservative defaults when neither provider class nor model overrides are set', () => {
    const provider = fixtureProvider({
      capabilityClass: undefined,
      models: [{ id: 'plain', label: 'Plain', category: 'chat' }],
    })
    const caps = resolveModelCapabilities(provider, 'plain')
    assert.deepStrictEqual(caps, {
      supportsVision: false,
      supportsThinking: false,
      supportsLongContext: false,
      multiTurnThinkingPolicy: 'unknown',
    })
  })

  it('provider class fills in fields the model leaves undeclared', () => {
    const provider = fixtureProvider({
      capabilityClass: { supportsVision: true, supportsThinking: false, supportsLongContext: true },
      models: [{ id: 'plain', label: 'Plain', category: 'chat' }],
    })
    const caps = resolveModelCapabilities(provider, 'plain')
    assert.strictEqual(caps.supportsVision, true)
    assert.strictEqual(caps.supportsThinking, false)
    assert.strictEqual(caps.supportsLongContext, true)
  })

  it('model overrides win over provider class on every overridden field', () => {
    const provider = fixtureProvider({
      capabilityClass: { supportsVision: true, supportsThinking: false, supportsLongContext: true },
      models: [{
        id: 'special',
        label: 'Special',
        category: 'chat',
        capabilityOverrides: {
          supportsVision: false,
          supportsThinking: true,
          // longContext intentionally omitted — provider class should win.
        },
      }],
    })
    const caps = resolveModelCapabilities(provider, 'special')
    assert.strictEqual(caps.supportsVision, false, 'model override must beat provider class')
    assert.strictEqual(caps.supportsThinking, true, 'model override must beat provider class')
    assert.strictEqual(caps.supportsLongContext, true, 'unoverridden field falls through to provider class')
  })

  it('a model whose id does not exist on the provider falls back to the provider class', () => {
    const provider = fixtureProvider({
      capabilityClass: { supportsVision: true, supportsThinking: false, supportsLongContext: false },
      models: [{ id: 'real', label: 'Real', category: 'chat' }],
    })
    const caps = resolveModelCapabilities(provider, 'unknown-model-id')
    assert.strictEqual(caps.supportsVision, true)
    assert.strictEqual(caps.supportsThinking, false)
    assert.strictEqual(caps.supportsLongContext, false)
  })
})

describe('resolveModelCapabilities — built-in fixture (o3-mini vs gpt-4o)', () => {
  function getProvider(id: AIProviderType): AIProviderDef {
    const p = AI_PROVIDERS.find((entry) => entry.id === id)
    assert.ok(p, `expected provider ${id} in AI_PROVIDERS`)
    return p!
  }

  it('o3-mini resolves to thinking=true, vision=false (model override beats openai provider class)', () => {
    const openai = getProvider('openai')
    const caps = resolveModelCapabilities(openai, 'o3-mini')
    assert.strictEqual(caps.supportsThinking, true, 'o3-mini.capabilityOverrides.supportsThinking=true must win')
    assert.strictEqual(caps.supportsVision, false, 'o3-mini.capabilityOverrides.supportsVision=false must beat provider class true')
    // longContext is unoverridden on o3-mini, so it falls through to
    // the openai provider class (true).
    assert.strictEqual(caps.supportsLongContext, true, 'unoverridden longContext falls through to openai provider class')
  })

  it('gpt-4o resolves entirely from the openai provider class (no overrides)', () => {
    const openai = getProvider('openai')
    const caps = resolveModelCapabilities(openai, 'gpt-4o')
    assert.strictEqual(caps.supportsVision, true)
    assert.strictEqual(caps.supportsThinking, false)
    assert.strictEqual(caps.supportsLongContext, true)
  })

  it('gpt-4o and o3-mini diverge on thinking exactly because of the per-model fixture', () => {
    const openai = getProvider('openai')
    const gpt4o = resolveModelCapabilities(openai, 'gpt-4o')
    const o3mini = resolveModelCapabilities(openai, 'o3-mini')
    assert.notStrictEqual(gpt4o.supportsThinking, o3mini.supportsThinking, 'thinking divergence is the whole point of capabilityOverrides')
    assert.notStrictEqual(gpt4o.supportsVision, o3mini.supportsVision, 'vision divergence likewise comes from the per-model fixture')
  })
})
