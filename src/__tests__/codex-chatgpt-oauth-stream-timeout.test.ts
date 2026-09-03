import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCodexGatewayEventIdleMs } from '../main/modules/agent-control/codex-runtime/codex-model-gateway'
import { CHATGPT_OAUTH_BASE_URL, CHATGPT_OAUTH_PROFILE_ID } from '../shared/chatgpt-oauth'

const chatGptOAuth = {
  profileId: CHATGPT_OAUTH_PROFILE_ID,
  baseUrl: CHATGPT_OAUTH_BASE_URL,
  wireApi: 'responses' as const,
}

test('the exact ChatGPT OAuth Responses route uses Codex five-minute SSE parity', () => {
  assert.equal(resolveCodexGatewayEventIdleMs({ snapshot: chatGptOAuth }), 300_000)
})

test('nearby provider identities keep Ready default instead of inheriting ChatGPT authority', () => {
  assert.equal(resolveCodexGatewayEventIdleMs({
    snapshot: { ...chatGptOAuth, profileId: 'custom-openai' },
  }), 120_000)
  assert.equal(resolveCodexGatewayEventIdleMs({
    snapshot: { ...chatGptOAuth, baseUrl: 'http://127.0.0.1:10533/v1' },
  }), 120_000)
  assert.equal(resolveCodexGatewayEventIdleMs({
    snapshot: { ...chatGptOAuth, wireApi: 'chat/completions' },
  }), 120_000)
})

test('an explicit positive timeout remains authoritative and invalid overrides fail closed', () => {
  assert.equal(resolveCodexGatewayEventIdleMs({ snapshot: chatGptOAuth, overrideMs: 25 }), 25)
  assert.throws(
    () => resolveCodexGatewayEventIdleMs({ snapshot: chatGptOAuth, overrideMs: 0 }),
    /gateway_configuration_invalid/,
  )
})
