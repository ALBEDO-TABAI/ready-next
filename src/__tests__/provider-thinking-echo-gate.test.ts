import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertThinkingModeConfigValid,
  resolveAIConfigCapabilities,
  validateThinkingModeConfig,
  type AIModelConfig,
} from '../shared/ai-providers'
import { deriveAgentErrorContract } from '../main/modules/claude-bridge/error-contract'
import { OpenAIExecutionClient } from '../main/modules/claude-bridge/openai-execution-client'
import { ReadyAnthropicModel, ReadyOpenAICompatibleModel } from '../main/modules/agent-control/agent-sdk-runtime'
import { ToolDomainError } from '../main/modules/tools/tool-errors'

function unknownThinkingConfig(): AIModelConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://openai-compatible.invalid',
    apiKey: 'sk-test',
    model: 'custom-reasoning-model',
    thinkingMode: 'on',
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
      assert.equal(error.errorKind, 'provider_request_failed')
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


test('runtime thinking gate blocks legacy provider request before fetch', async () => {
  let fetchCalls = 0
  const client = new OpenAIExecutionClient({
    fetchWithTimeout: async () => {
      fetchCalls += 1
      return new Response('{}', { status: 200 })
    },
    log: () => {},
  })

  await assert.rejects(
    client.requestSimple({
      session: {
        messages: [{ role: 'user', content: 'hello' }],
        systemPrompt: '',
        preferTextToolBridge: false,
      },
      config: unknownThinkingConfig(),
      baseUrl: 'https://openai-compatible.invalid',
      provider: undefined,
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.ok(error instanceof ToolDomainError)
      assert.equal(error.errorKind, 'provider_request_failed')
      return true
    },
  )
  assert.equal(fetchCalls, 0)
})

test('provider_request_failed with recoverable=false remains terminal in agent:error contract', () => {
  const error = new ToolDomainError('provider_request_failed', 'blocked', { recoverable: false })
  assert.deepEqual(deriveAgentErrorContract(error), {
    errorKind: 'provider_request_failed',
    recoverable: false,
  })
})
