import assert from 'node:assert/strict'
import test from 'node:test'

import {
  READY_MEMORY_EXTRACTION_CONTRACT,
  READY_MEMORY_PROVIDER_REQUEST_CONTRACT,
  ReadyMemoryProductionProvider,
  type ReadyMemoryProviderRequest,
} from '../main/modules/agent-control/ready-memory'
import type { CodexUpstreamProfileSnapshot } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'

function request(): ReadyMemoryProviderRequest {
  const inputJson = '{"contract":"ready-memory-extraction-input:v1"}'
  return {
    contract: READY_MEMORY_PROVIDER_REQUEST_CONTRACT,
    requestId: 'request-1',
    jobId: 'job-1',
    kind: 'extraction',
    model: 'gpt-memory',
    upstreamProfileSnapshotRef: 'snapshot-1',
    upstreamProfileSnapshotDigest: 'a'.repeat(64),
    revocationRevision: 0,
    recoveryProtocol: 'query-only-by-remote-id:v1',
    budgetLane: 'memory',
    inputJson,
    inputDigest: 'b'.repeat(64),
    maxInputChars: 24_000,
    maxOutputChars: 8_000,
    maxOutputTokens: 2_000,
    outputContract: READY_MEMORY_EXTRACTION_CONTRACT,
  }
}

function snapshot(wireApi: 'responses' | 'chat/completions'): CodexUpstreamProfileSnapshot {
  return {
    profileId: 'profile-1',
    providerId: 'provider-1',
    model: 'gpt-memory',
    baseUrl: wireApi === 'responses' ? 'https://api.openai.com/v1' : 'https://provider.invalid/v1',
    agentProtocol: 'openai',
    wireApi,
    reasoningEffort: null,
    supportsToolCalls: false,
    supportsNativeToolCalls: false,
    supportsVision: false,
    supportsThinking: false,
    multiTurnThinkingPolicy: 'unsupported',
    patchProfileId: null,
    authHeader: 'authorization',
    authPrefix: 'Bearer ',
    extraHeaders: {},
    credentialReferenceId: 'ai-profile:profile-1',
    retryPolicy: { owner: 'ready_gateway', maxRetries: 2, semantic4xxRetries: 0 },
  }
}

test('production provider recovers an already-known Responses id only by GET', async () => {
  const calls: Array<{ url: string; method: string; body?: string; headers: Headers }> = []
  const responses = [
    new Response(JSON.stringify({
      id: 'response-1',
      status: 'completed',
      output_text: JSON.stringify({
        contract: READY_MEMORY_EXTRACTION_CONTRACT,
        summary: 'stable',
        candidates: [],
      }),
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }), { status: 200 }),
  ]
  const provider = new ReadyMemoryProductionProvider({
    profiles: { readSnapshot: () => snapshot('responses') },
    credentials: { resolve: () => 'secret-not-logged' },
    fetch: async (url, init) => {
      calls.push({
        url: String(url), method: String(init?.method), body: String(init?.body || ''),
        headers: new Headers(init?.headers),
      })
      return responses.shift()!
    },
  })
  const recovered = await provider.recover(request(), 'response-1')
  assert.equal(recovered.state, 'completed')
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ['GET', 'https://api.openai.com/v1/responses/response-1'],
  ])
  assert.equal(calls[0]?.body.includes('secret-not-logged'), false)
})

test('Responses incomplete and completed-without-usage are terminal failures', async () => {
  const calls: string[] = []
  const responses = [
    new Response(JSON.stringify({
      id: 'response-incomplete', status: 'incomplete', output_text: '{"partial":true}',
    }), { status: 200 }),
    new Response(JSON.stringify({
      id: 'response-no-usage', status: 'completed', output_text: '{}',
    }), { status: 200 }),
  ]
  const provider = new ReadyMemoryProductionProvider({
    profiles: { readSnapshot: () => snapshot('responses') },
    credentials: { resolve: () => 'secret' },
    fetch: async (url) => { calls.push(String(url)); return responses.shift()! },
  })
  assert.deepEqual(await provider.recover(request(), 'response-incomplete'), {
    state: 'failed', remoteId: 'response-incomplete', error: 'ready_memory_provider_incomplete',
    outputText: '{"partial":true}', usage: undefined,
  })
  assert.deepEqual(await provider.recover(request(), 'response-no-usage'), {
    state: 'failed', remoteId: 'response-no-usage', error: 'ready_memory_provider_usage_missing',
    outputText: '{}',
  })
  assert.equal(calls.length, 2)
})

test('production submission fails closed with zero provider calls without a proven request-id recovery contract', async () => {
  let fetchCalls = 0
  const provider = new ReadyMemoryProductionProvider({
    profiles: { readSnapshot: () => snapshot('responses') },
    credentials: { resolve: () => 'secret' },
    fetch: async () => { fetchCalls += 1; throw new Error('must not fetch') },
  })
  assert.deepEqual(await provider.submit(request()), {
    state: 'failed', error: 'ready_memory_provider_submission_recovery_unproven',
  })
  const chatRequest = request()
  const chatProvider = new ReadyMemoryProductionProvider({
    profiles: { readSnapshot: () => snapshot('chat/completions') },
    credentials: { resolve: () => 'secret' },
    fetch: async () => { fetchCalls += 1; throw new Error('must not fetch') },
  })
  assert.deepEqual(await chatProvider.submit(chatRequest), {
    state: 'failed', error: 'ready_memory_provider_submission_recovery_unproven',
  })
  assert.deepEqual(await chatProvider.recover(chatRequest, 'chat-request-1'), {
    state: 'unknown', remoteId: 'chat-request-1',
  })
  assert.equal(fetchCalls, 0)
})
