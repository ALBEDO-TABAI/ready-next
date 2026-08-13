import assert from 'node:assert/strict'
import test from 'node:test'

import { createDefaultAIWorkspace } from '../shared/ai-providers'
import {
  CHATGPT_OAUTH_PROFILE_ID,
  buildChatGptOAuthConfig,
} from '../shared/chatgpt-oauth'
import { createCodexProviderReadinessPort } from '../main/modules/agent-control/codex-runtime/codex-provider-readiness'
import { classifyCodexIngressPreparationError } from '../main/modules/agent-control/codex-runtime/codex-ingress-preparation-error'

const PROXY_API_KEY = 'ready-oauth-proxy-key-12345678901234567890'

function oauthConfig() {
  return buildChatGptOAuthConfig(null, ['gpt-5.6-sol'], PROXY_API_KEY)
}

test('OAuth ingress waits for the shared local runtime before admission', async () => {
  let ensureCalls = 0
  const readiness = createCodexProviderReadinessPort({
    isLifecycleBusy: () => false,
    getStatus: () => ({
      state: 'signed_in',
      connected: true,
      running: false,
      baseUrl: 'http://127.0.0.1:10532/v1',
      models: [],
    }),
    ensureReady: async (models, apiKey) => {
      ensureCalls += 1
      assert.deepEqual(models, ['gpt-5.6-sol'])
      assert.equal(apiKey, PROXY_API_KEY)
      return {
        state: 'ready',
        connected: true,
        running: true,
        baseUrl: 'http://127.0.0.1:10532/v1',
        models: ['gpt-5.6-sol'],
      }
    },
  })

  await readiness.ensureReady({
    profileId: CHATGPT_OAUTH_PROFILE_ID,
    config: oauthConfig(),
  })
  assert.equal(ensureCalls, 1)
})

test('OAuth readiness failures stay before persistence with actionable kinds', async () => {
  const disconnected = createCodexProviderReadinessPort({
    isLifecycleBusy: () => false,
    getStatus: () => ({
      state: 'signed_out',
      connected: false,
      running: false,
      baseUrl: 'http://127.0.0.1:10532/v1',
      models: [],
    }),
    ensureReady: async () => {
      throw new Error('must_not_start')
    },
  })
  await assert.rejects(
    disconnected.ensureReady({
      profileId: CHATGPT_OAUTH_PROFILE_ID,
      config: oauthConfig(),
    }),
    (error: unknown) => (
      classifyCodexIngressPreparationError(error).code === 'configuration_unavailable'
    ),
  )

  const unavailable = createCodexProviderReadinessPort({
    isLifecycleBusy: () => false,
    getStatus: () => ({
      state: 'signed_in',
      connected: true,
      running: false,
      baseUrl: 'http://127.0.0.1:10532/v1',
      models: [],
    }),
    ensureReady: async () => {
      throw new Error('provider secret must not escape')
    },
  })
  await assert.rejects(
    unavailable.ensureReady({
      profileId: CHATGPT_OAUTH_PROFILE_ID,
      config: oauthConfig(),
    }),
    (error: unknown) => {
      const failure = classifyCodexIngressPreparationError(error)
      return failure.code === 'external_service_unavailable'
        && failure.error === 'codex_chatgpt_oauth_runtime_unavailable'
    },
  )
})

test('ordinary API profiles do not depend on the OAuth local runtime', async () => {
  let ensureCalls = 0
  const readiness = createCodexProviderReadinessPort({
    isLifecycleBusy: () => false,
    getStatus: () => { throw new Error('must_not_read_oauth') },
    ensureReady: async () => {
      ensureCalls += 1
      throw new Error('must_not_start_oauth')
    },
  })
  const config = createDefaultAIWorkspace().profiles[0]?.config
  assert.ok(config)
  await readiness.ensureReady({ profileId: 'builtin-openai', config })
  assert.equal(ensureCalls, 0)
})

test('OAuth lifecycle changes reject every profile before ingress persistence', async () => {
  let busy = true
  const readiness = createCodexProviderReadinessPort({
    isLifecycleBusy: () => busy,
    getStatus: () => { throw new Error('must_not_read_oauth_while_busy') },
    ensureReady: async () => { throw new Error('must_not_start_oauth_while_busy') },
  })
  const config = createDefaultAIWorkspace().profiles[0]?.config
  assert.ok(config)

  await assert.rejects(
    readiness.ensureReady({ profileId: 'builtin-openai', config }),
    (error: unknown) => {
      const failure = classifyCodexIngressPreparationError(error)
      return failure.code === 'external_service_unavailable'
        && failure.retryableByUser
        && failure.error === 'codex_chatgpt_oauth_lifecycle_busy'
    },
  )

  busy = false
  await readiness.ensureReady({ profileId: 'builtin-openai', config })
})
