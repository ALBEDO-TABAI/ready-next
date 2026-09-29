import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertThinkingModeConfigValid,
  normalizeAIConfig,
  resolveAIConfigCapabilities,
  validateThinkingModeConfig,
  type AIModelConfig,
} from '../shared/ai-providers'
import {
  KIMI_K3_DEFAULT_REASONING_EFFORT,
  KIMI_K3_REASONING_EFFORTS,
  KIMI_K3_SESSION_IDENTITY,
  KIMI_K3_SESSION_IDENTITY_FIELD,
  inspectKimiK3History,
  isKimiK3Config,
} from '../shared/ai-providers/kimi-k3'
import { PROVIDER_ERROR_KINDS } from '../main/modules/agent-control/contracts/error-kinds'
import { compactAgentInputItems } from '../main/modules/agent-control/compaction/compact-agent-input'
import { ReadyAnthropicModel, ReadyOpenAICompatibleModel } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import {
  loadScopeSessionSnapshot,
  writeScopeSessionSnapshot,
} from '../main/modules/agent-control/session/scope-session-snapshot'
import { ToolDomainError } from '../main/modules/tools/tool-errors'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'

before(() => {
  __setScopeContextEpochDatabaseForTests({
    getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never,
  })
})

after(() => {
  __setScopeContextEpochDatabaseForTests(null)
})

function unknownThinkingConfig(): AIModelConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://openai-compatible.invalid',
    apiKey: 'sk-test',
    model: 'custom-reasoning-model',
    thinkingMode: 'on',
  }
}

function kimiK3Config(overrides: Partial<AIModelConfig> = {}): AIModelConfig {
  return {
    provider: 'moonshot',
    baseUrl: 'https://api.kimi.com/coding',
    apiKey: 'sk-test',
    model: 'k3',
    agentProtocol: 'anthropic',
    ...overrides,
  }
}

test('manual thinkingMode=on is rejected for unknown multi-turn thinking policy', () => {
  const result = validateThinkingModeConfig(unknownThinkingConfig())

  assert.equal(result.ok, false)
  assert.equal(result.policy, 'unknown')
  assert.match(result.error || '', /未验证/)
  assert.throws(() => assertThinkingModeConfigValid(unknownThinkingConfig()), /未验证/)
})

test('Anthropic built-in Claude models are marked echo_required and can save manual thinking mode', () => {
  const config: AIModelConfig = {
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-test',
    model: 'claude-sonnet-4-20250514',
    thinkingMode: 'on',
  }

  const caps = resolveAIConfigCapabilities(config)
  assert.equal(caps?.multiTurnThinkingPolicy, 'echo_required')
  assert.equal(validateThinkingModeConfig(config).ok, true)
})

test('Kimi K3 resolves only low/high/max, defaults unsupported effort to high, and requires thinking echo', () => {
  assert.deepEqual(KIMI_K3_REASONING_EFFORTS, ['low', 'high', 'max'])
  assert.equal(KIMI_K3_DEFAULT_REASONING_EFFORT, 'high')
  assert.equal(isKimiK3Config(kimiK3Config({ model: 'K3' })), false)

  const normalized = normalizeAIConfig(kimiK3Config({ reasoningEffort: 'medium' }))
  assert.equal(normalized.reasoningEffort, 'high')
  const caps = resolveAIConfigCapabilities(normalized)
  assert.equal(caps?.agentProtocol, 'anthropic')
  assert.equal(caps?.supportsThinking, true)
  assert.equal(caps?.multiTurnThinkingPolicy, 'echo_required')
  assert.equal(validateThinkingModeConfig({ ...normalized, thinkingMode: 'on' }).ok, true)
})

test('Kimi K3 history inspection rejects unmarked assistant history and accepts K3-preserved history', () => {
  assert.deepEqual(inspectKimiK3History([{ role: 'user', content: 'new conversation' }]), {
    compatible: true,
    reason: 'no_model_history',
  })
  assert.deepEqual(
    inspectKimiK3History([{ role: 'assistant', content: 'from another model' }]),
    { compatible: false, reason: 'foreign_or_unmarked_model_history' },
  )
  assert.deepEqual(
    inspectKimiK3History([{
      role: 'assistant',
      content: 'from K3',
      providerData: { [KIMI_K3_SESSION_IDENTITY_FIELD]: KIMI_K3_SESSION_IDENTITY },
    }]),
    { compatible: true, reason: 'kimi_k3_history' },
  )
})

test('Kimi K3 request is blocked before fetch when an existing conversation came from another model', async () => {
  let fetchCalls = 0
  const model = new ReadyAnthropicModel({
    config: kimiK3Config(),
    baseUrl: 'https://api.kimi.com/coding',
    fetchWithTimeout: async () => {
      fetchCalls += 1
      return new Response('{}', { status: 200 })
    },
  })

  await assert.rejects(
    model.getResponse({
      input: [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer without K3 identity' },
        { role: 'user', content: 'continue with K3' },
      ],
      systemInstructions: '',
      tools: [],
      modelSettings: {},
      signal: new AbortController().signal,
    } as never),
    (error) => {
      assert.ok(error instanceof ToolDomainError)
      assert.equal(error.errorKind, PROVIDER_ERROR_KINDS.providerRequestFailed.code)
      assert.equal(error.detail?.recoverable, false)
      assert.equal(error.detail?.reason, 'kimi_k3_incompatible_history')
      assert.match(error.message, /新建会话/)
      return true
    },
  )
  assert.equal(fetchCalls, 0)
})

test('compaction keeps K3 session identity only for an entirely K3-origin history', () => {
  const k3ProviderData = { [KIMI_K3_SESSION_IDENTITY_FIELD]: KIMI_K3_SESSION_IDENTITY }
  const compacted = compactAgentInputItems([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer', providerData: k3ProviderData },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'answer 2', providerData: k3ProviderData },
  ] as never[], { windowTokens: 1, keepTailCount: 1, force: true })
  assert.equal(compacted instanceof Promise, false)
  const compactedItems = (compacted as Awaited<typeof compacted>).items as Array<Record<string, unknown>>
  const summary = compactedItems.find((item) => item.role === 'user' && String(item.content).includes('[ready:context-compacted]'))
  assert.equal(
    (summary?.providerData as Record<string, unknown> | undefined)?.[KIMI_K3_SESSION_IDENTITY_FIELD],
    KIMI_K3_SESSION_IDENTITY,
  )
  assert.equal(inspectKimiK3History(compactedItems).compatible, true)

  const mixed = compactAgentInputItems([
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'old model answer' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'K3 answer', providerData: k3ProviderData },
  ] as never[], { windowTokens: 1, keepTailCount: 1, force: true })
  assert.equal(mixed instanceof Promise, false)
  assert.equal(inspectKimiK3History((mixed as Awaited<typeof mixed>).items as never[]).compatible, false)
})

test('scope snapshot round-trip preserves K3 thinking content, signature, and session identity', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ready-kimi-k3-snapshot-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const thinking = {
    type: 'thinking',
    thinking: 'persisted reasoning',
    signature: 'sig-k3-persisted',
  }
  const items = [{
    id: 'msg-k3-persisted',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'answer' }],
    providerData: {
      [KIMI_K3_SESSION_IDENTITY_FIELD]: KIMI_K3_SESSION_IDENTITY,
      anthropicThinkingBlocks: [thinking],
    },
  }]

  const written = writeScopeSessionSnapshot('butler::scope-kimi-k3', items, 0, root)
  assert.equal(written.ok, true)
  const loaded = loadScopeSessionSnapshot('butler::scope-kimi-k3', 0, root)
  assert.equal(loaded.ok, true)
  if (!loaded.ok) return
  assert.deepEqual(loaded.items, items)
  assert.deepEqual(inspectKimiK3History(loaded.items), {
    compatible: true,
    reason: 'kimi_k3_history',
  })
})

test('runtime thinking gate blocks SDK provider request before fetch', async () => {
  let fetchCalls = 0
  const model = new ReadyOpenAICompatibleModel({
    config: unknownThinkingConfig(),
    baseUrl: 'https://openai-compatible.invalid',
    fetchWithTimeout: async () => {
      fetchCalls += 1
      return new Response('{}', { status: 200 })
    },
  })

  await assert.rejects(
    model.getResponse({
      input: 'hello',
      systemInstructions: '',
      tools: [],
      modelSettings: {},
      signal: new AbortController().signal,
    } as never),
    (error) => {
      assert.ok(error instanceof ToolDomainError)
      assert.equal(error.errorKind, PROVIDER_ERROR_KINDS.providerRequestFailed.code)
      assert.equal(error.detail?.recoverable, false)
      return true
    },
  )
  assert.equal(fetchCalls, 0)
})

test('runtime thinking gate allows proven Anthropic model and sends request', async () => {
  let fetchCalls = 0
  const model = new ReadyAnthropicModel({
    config: {
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-test',
      model: 'claude-sonnet-4-20250514',
      thinkingMode: 'on',
    },
    baseUrl: 'https://api.anthropic.com',
    fetchWithTimeout: async () => {
      fetchCalls += 1
      return new Response(JSON.stringify({
        id: 'msg-test',
        content: [{ type: 'text', text: 'ok' }],
        usage: {},
      }), { status: 200 })
    },
  })

  await model.getResponse({
    input: 'hello',
    systemInstructions: '',
    tools: [],
    modelSettings: { maxTokens: 10 },
    signal: new AbortController().signal,
  } as never)

  assert.equal(fetchCalls, 1)
})
