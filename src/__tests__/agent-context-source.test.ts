/**
 * B-arch-5 — `getCurrentAgentContext()` contract.
 *
 * Verifies:
 *   - Returns a fresh AgentSpawnContext when settings have an active config
 *   - Returns `null` (with a warning) when no config is present
 *   - Returns `null` when provider/model is empty (corrupted settings)
 *   - Each call returns a brand-new object (no shared refs into the source)
 *   - Reader is invoked on every call (no caching) — supports mid-session
 *     model switches
 *   - api_key value is NOT logged (security check)
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildAgentSpawnContextFromAIConfig,
  getCurrentAgentContext,
} from '../main/modules/skills-runtime/agent-context-source'
import type { AIModelConfig } from '../shared/ai-providers'

function makeConfig(overrides: Partial<AIModelConfig> = {}): AIModelConfig {
  return {
    provider: 'moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: 'sk-test-secret-do-not-leak',
    model: 'kimi-k2',
    ...overrides,
  }
}

test('returns context derived from the active AI config', async () => {
  const config = makeConfig()
  const ctx = await getCurrentAgentContext({ readAIConfig: () => config })
  assert.ok(ctx, 'context should be non-null')
  assert.equal(ctx!.provider, 'moonshot')
  assert.equal(ctx!.model_id, 'kimi-k2')
  assert.equal(ctx!.base_url, 'https://api.moonshot.cn/v1')
  assert.equal(ctx!.api_key, 'sk-test-secret-do-not-leak')
  assert.deepEqual(ctx!.fallback_chain, [])
})

test('buildAgentSpawnContextFromAIConfig can use the run-time normalized base URL', () => {
  const ctx = buildAgentSpawnContextFromAIConfig(
    makeConfig({
      provider: 'openai',
      baseUrl: 'https://stale.example.com/v1',
      model: 'gpt-5.4',
    }),
    { baseUrl: 'https://current.example.com/v1' },
  )

  assert.ok(ctx)
  assert.equal(ctx!.provider, 'openai')
  assert.equal(ctx!.model_id, 'gpt-5.4')
  assert.equal(ctx!.base_url, 'https://current.example.com/v1')
  assert.equal(ctx!.api_kind, 'openai-responses')
})

test('returns null with a warning when no AI config is configured', async () => {
  const warnings: string[] = []
  const ctx = await getCurrentAgentContext({
    readAIConfig: () => null,
    warn: (msg) => { warnings.push(msg) },
  })
  assert.equal(ctx, null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /no AI config/i)
})

test('returns null when provider is empty', async () => {
  const warnings: string[] = []
  const ctx = await getCurrentAgentContext({
    readAIConfig: () => makeConfig({ provider: '' as any }),
    warn: (msg) => { warnings.push(msg) },
  })
  assert.equal(ctx, null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /missing provider or model/i)
})

test('returns null when model is empty', async () => {
  const warnings: string[] = []
  const ctx = await getCurrentAgentContext({
    readAIConfig: () => makeConfig({ model: '' }),
    warn: (msg) => { warnings.push(msg) },
  })
  assert.equal(ctx, null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /missing provider or model/i)
})

test('returns null when reader throws (settings table corrupted)', async () => {
  const warnings: string[] = []
  const ctx = await getCurrentAgentContext({
    readAIConfig: () => { throw new Error('db locked') },
    warn: (msg) => { warnings.push(msg) },
  })
  assert.equal(ctx, null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /failed to read AI config/i)
  assert.match(warnings[0], /db locked/)
})

test('each call returns a fresh object (no shared refs)', async () => {
  const config = makeConfig()
  const a = await getCurrentAgentContext({ readAIConfig: () => config })
  const b = await getCurrentAgentContext({ readAIConfig: () => config })
  assert.ok(a && b)
  assert.notStrictEqual(a, b, 'context objects must be distinct')
  assert.notStrictEqual(a!.fallback_chain, b!.fallback_chain, 'fallback_chain arrays must be distinct')
  // Mutating one must not affect the other (via type-cast since the field
  // is declared ReadonlyArray — we verify runtime separation).
  ;(a!.fallback_chain as string[]).push('test/poisoned')
  assert.deepEqual(b!.fallback_chain, [])
})

test('reader is invoked on every call (no caching — supports mid-session switch)', async () => {
  let callCount = 0
  const configs: AIModelConfig[] = [
    makeConfig({ provider: 'moonshot', model: 'kimi-k2' }),
    makeConfig({ provider: 'anthropic', model: 'claude-opus-4-7' }),
  ]
  const reader = () => {
    const config = configs[callCount] ?? configs[configs.length - 1]
    callCount += 1
    return config
  }

  const first = await getCurrentAgentContext({ readAIConfig: reader })
  const second = await getCurrentAgentContext({ readAIConfig: reader })

  assert.equal(callCount, 2, 'reader should be called once per getCurrentAgentContext call')
  assert.equal(first!.provider, 'moonshot')
  assert.equal(first!.model_id, 'kimi-k2')
  assert.equal(second!.provider, 'anthropic')
  assert.equal(second!.model_id, 'claude-opus-4-7')
})

test('warning messages never include the api_key value', async () => {
  const warnings: string[] = []
  const secret = 'sk-do-not-leak-this-string-anywhere'

  // Trigger every warning branch and assert the secret never appears.
  await getCurrentAgentContext({
    readAIConfig: () => null,
    warn: (msg) => warnings.push(msg),
  })
  await getCurrentAgentContext({
    readAIConfig: () => makeConfig({ apiKey: secret, provider: '' as any }),
    warn: (msg) => warnings.push(msg),
  })
  await getCurrentAgentContext({
    readAIConfig: () => makeConfig({ apiKey: secret, model: '' }),
    warn: (msg) => warnings.push(msg),
  })
  await getCurrentAgentContext({
    readAIConfig: () => { const e: any = new Error(`token=${secret}`); throw e },
    warn: (msg) => warnings.push(msg),
  })

  // First three warnings must not contain the secret; the fourth wraps the
  // error message which we constructed, so it WILL contain `token=secret`.
  // To be defensive: assert the helper never *itself* embeds api_key.
  for (const msg of warnings.slice(0, 3)) {
    assert.ok(!msg.includes(secret), `warning leaked api_key: ${msg}`)
  }
})
