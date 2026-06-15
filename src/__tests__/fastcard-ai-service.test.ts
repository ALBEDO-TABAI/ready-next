import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildFastCardVisionConfigFromAgentContext,
  formatFastCardModelHttpError,
  resolveFastCardVisionConfig,
} from '../main/modules/browser-engine/fastcard-ai-service'
import type { AgentSpawnContext } from '../shared/skill-host-contract'
import { resolveAIConfigCapabilities, type AIModelConfig } from '../shared/ai-providers'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

function makeActiveConfig(overrides: Partial<AIModelConfig> = {}): AIModelConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://api.kimi.com/anthropic',
    apiKey: 'sk-active',
    model: 'k2.6',
    agentProtocol: 'anthropic',
    visionMode: 'auto',
    ...overrides,
  }
}

function makeVisionContext(overrides: Partial<AgentSpawnContext> = {}): AgentSpawnContext {
  return {
    provider: 'mimo',
    model_id: 'mimo-v2.5',
    base_url: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
    api_key: 'sk-vision',
    api_kind: 'anthropic-messages',
    fallback_chain: [],
    input_modes: ['text', 'image'],
    ...overrides,
  }
}

test('fastcard-ai-service declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'fastcard-ai-service transitive sqlite guard')
})

test('FastCard model errors explain supplier 402 failures', () => {
  const message = formatFastCardModelHttpError(402, JSON.stringify({
    error: { message: 'Insufficient Balance' },
  }))

  assert.match(message, /余额不足/)
  assert.match(message, /402/)
  assert.match(message, /Insufficient Balance/)
})

test('FastCard model errors explain common authorization and rate limit failures', () => {
  assert.match(formatFastCardModelHttpError(401), /API Key/)
  assert.match(formatFastCardModelHttpError(403), /没有权限/)
  assert.match(formatFastCardModelHttpError(429), /限流/)
})

test('FastCard image description prefers the configured vision model over an active text-only model', () => {
  const config = resolveFastCardVisionConfig({
    readVisionAgentContext: () => makeVisionContext(),
    readAIConfig: () => makeActiveConfig(),
  })

  assert.ok(config)
  assert.equal(config!.provider, 'openai-compatible')
  assert.equal(config!.model, 'mimo-v2.5')
  assert.equal(config!.baseUrl, 'https://token-plan-sgp.xiaomimimo.com/anthropic')
  assert.equal(config!.agentProtocol, 'anthropic')
  assert.equal(config!.wireApi, undefined)
  assert.equal(config!.visionMode, 'on')
  assert.equal(resolveAIConfigCapabilities(config!)?.supportsVision, true)
})

test('FastCard vision config falls back to the active model when no vision service is image-capable', () => {
  const active = makeActiveConfig({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    agentProtocol: 'openai',
    wireApi: 'chat/completions',
  })
  const config = resolveFastCardVisionConfig({
    readVisionAgentContext: () => makeVisionContext({ input_modes: ['text'] }),
    readAIConfig: () => active,
  })

  assert.equal(config, active)
  assert.equal(resolveAIConfigCapabilities(config)?.supportsVision, true)
})

test('FastCard vision service context is ignored until it declares image input', () => {
  const config = buildFastCardVisionConfigFromAgentContext(makeVisionContext({ input_modes: ['text'] }))

  assert.equal(config, null)
})
