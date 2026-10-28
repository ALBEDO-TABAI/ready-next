import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import test from 'node:test'

import {
  createCodexUpstreamProfileSnapshot,
  digestCanonicalJson,
  instructionTranscriptDigest,
  resolveCodexNativeModelSettings,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { responsesRequestToChat } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-chat'
import {
  CodexModelGateway,
  isCodexUpstreamEventStream,
  normalizeChatGptOAuthResponseEvent,
  type CodexModelGatewayBinding,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway'
import type { CodexModelGatewayUpstreamFailureDiagnostic } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-types'
import { buildCodexThreadDeveloperInstructions } from '../main/modules/agent-control/codex-runtime/codex-runtime-production-composition'

function nativeUsage(): Record<string, unknown> {
  return {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') reject(new Error('fixture_address_invalid'))
      else resolve(address.port)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function rawPost(input: {
  url: string
  host: string
  authorization: string
  body: string
}): Promise<{ status: number; body: string }> {
  const target = new URL(input.url)
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        host: input.host,
        authorization: input.authorization,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(input.body),
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.once('error', reject)
    request.end(input.body)
  })
}

function baseRequest(toolName: string | null = 'ready_read_probe'): Record<string, unknown> {
  const tools = toolName
    ? [{ type: 'function', name: toolName, description: 'read', parameters: { type: 'object' } }]
    : []
  return {
    model: 'ready-e0-model',
    instructions: 'fixed instructions',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    }],
    tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: { summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'thread-native-1',
    store: false,
    stream: true,
    client_metadata: {
      'x-codex-installation-id': 'installation-contract',
      session_id: 'thread-native-1',
      'x-codex-window-id': 'thread-native-1:0',
      turn_id: 'turn-native-1',
      thread_id: 'thread-native-1',
      root_turn_id: 'turn-native-1',
      'x-codex-turn-metadata': JSON.stringify({
        installation_id: 'installation-contract',
        session_id: 'thread-native-1',
        request_kind: 'turn',
        thread_id: 'thread-native-1',
        turn_id: 'turn-native-1',
        root_turn_id: 'turn-native-1',
        window_id: 'thread-native-1:0',
        agent_name: '/root',
        auto_review_enabled: false,
        node_repl_auto_review_required: false,
        node_repl_disabled: false,
        sandbox: 'seatbelt',
        sandbox_mode: 'read-only',
        turn_started_at_unix_ms: 1, window_number: 0, context_window_id: 'context-window-1',
        analytics_enabled: false, model: 'ready-e0-model',
        readyRunId: 'run-1',
        toolSurfaceDigest: digestCanonicalJson(tools),
        turnContractDigest: 'turn-contract-1',
        upstreamProfileSnapshotDigest: 'snapshot-digest-placeholder',
      }),
    },
  }
}

test('upstream snapshot is immutable, non-secret, and separates the credential reference', () => {
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-1',
    config: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1/',
      apiKey: 'must-never-be-stored',
      model: 'upstream-model',
      agentProtocol: 'openai',
      wireApi: 'chat/completions',
      toolUseMode: 'on',
      visionMode: 'on',
    },
    maxRetries: 1,
  })

  assert.equal(created.snapshot.baseUrl, 'https://provider.example/v1')
  assert.equal(created.snapshot.wireApi, 'chat/completions')
  assert.equal(created.snapshot.credentialReferenceId, 'ai-profile:profile-1')
  assert.equal(created.snapshot.reasoningEffort, null)
  assert.equal('contextWindowTokens' in created.snapshot, false)
  assert.equal('maxOutputTokens' in created.snapshot, false)
  assert.equal(created.snapshot.multiTurnThinkingPolicy, 'unknown')
  assert.equal(JSON.stringify(created.snapshot).includes('must-never-be-stored'), false)
  assert.equal(created.snapshotDigest, digestCanonicalJson(created.snapshot))
  assert.throws(() => {
    ;(created.snapshot as { model: string }).model = 'changed'
  }, TypeError)
  assert.throws(() => createCodexUpstreamProfileSnapshot({
    profileId: 'profile-unsafe-reasoning',
    config: {
      provider: 'openai-compatible', baseUrl: 'https://provider.example/v1',
      apiKey: 'secret', model: 'upstream-model', agentProtocol: 'openai',
      wireApi: 'chat/completions', reasoningEffort: 'high', thinkingMode: 'on', toolUseMode: 'on',
    },
    maxRetries: 0,
  }), /gateway_reasoning_policy_unsupported/)
})

test('explicit Ready model limits become the frozen Codex thread and upstream limits', () => {
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-explicit-limits',
    config: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'upstream-model',
      agentProtocol: 'openai',
      wireApi: 'chat/completions',
      contextWindowOverride: 272_000,
      maxOutputTokensOverride: 12_345,
      toolUseMode: 'on',
    },
    maxRetries: 0,
  })

  assert.equal(created.snapshot.contextWindowTokens, 272_000)
  assert.equal(created.snapshot.maxOutputTokens, 12_345)
  assert.deepEqual(resolveCodexNativeModelSettings(created.snapshot), {
    reasoningEffort: null,
    threadConfig: { model_context_window: 272_000 },
  })

  const chat = responsesRequestToChat({
    request: {
      instructions: 'fixed',
      input: [{
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      }],
      tools: [],
      tool_choice: 'auto',
      parallel_tool_calls: false,
    },
    snapshot: created.snapshot,
  })
  assert.equal(chat.max_tokens, 12_345)
})

test('ChatGPT OAuth snapshot accepts its fixed Responses reasoning contract', () => {
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'custom-chatgpt-oauth',
    config: {
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:10532/v1',
      apiKey: 'ready-oauth-proxy-key-12345678901234567890',
      model: 'gpt-5.6-terra',
      authMode: 'chatgpt-oauth',
      agentProtocol: 'openai',
      wireApi: 'responses',
      reasoningEffort: 'high',
      toolUseMode: 'on',
      nativeVideoMode: 'off',
    },
    maxRetries: 6,
  })

  assert.equal(created.snapshot.supportsThinking, true)
  assert.equal(created.snapshot.multiTurnThinkingPolicy, 'echo_required')
  assert.equal(created.snapshot.reasoningEffort, 'high')
  assert.deepEqual(resolveCodexNativeModelSettings(created.snapshot), {
    reasoningEffort: 'high',
    threadConfig: null,
  })
  assert.equal(isCodexUpstreamEventStream(
    new Response(null, { headers: { 'content-type': 'application/json; charset=utf-8' } }),
    created.snapshot,
  ), true)

  const completedItem = normalizeChatGptOAuthResponseEvent({
    type: 'response.output_item.done',
    sequence_number: 6,
    output_index: 0,
    item: {
      id: 'msg-oauth',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      phase: 'final_answer',
      content: [{
        type: 'output_text',
        text: 'READY_OAUTH_OK',
        annotations: [],
        logprobs: [],
      }],
    },
  }).item as Record<string, unknown>
  assert.deepEqual(completedItem, {
    id: 'msg-oauth',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: 'READY_OAUTH_OK' }],
  })
  assert.deepEqual(normalizeChatGptOAuthResponseEvent({
    type: 'response.completed',
    sequence_number: 7,
    response: {
      id: 'resp-oauth',
      object: 'response',
      created_at: 1,
      status: 'completed',
      model: 'gpt-5.6-terra',
      output: [],
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 3, cache_write_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
      metadata: {},
    },
  }, [completedItem]), {
    type: 'response.completed',
    sequence_number: 7,
    response: {
      id: 'resp-oauth',
      status: 'completed',
      model: 'gpt-5.6-terra',
      output: [completedItem],
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    },
  })

  const ordinary = createCodexUpstreamProfileSnapshot({
    profileId: 'ordinary-responses',
    config: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'upstream-model',
      agentProtocol: 'openai',
      wireApi: 'responses',
      toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  assert.equal(isCodexUpstreamEventStream(
    new Response(null, { headers: { 'content-type': 'application/json; charset=utf-8' } }),
    ordinary.snapshot,
  ), false)
})

test('gateway rejects wrong bearer, wrong host, oversized bodies, and unbound metadata', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(500).end('unexpected')
  })
  const upstreamPort = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-1',
    config: {
      provider: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'upstream-secret',
      model: 'upstream-model',
      agentProtocol: 'openai',
      wireApi: 'chat/completions',
      toolUseMode: 'on',
      visionMode: 'on',
    },
    maxRetries: 0,
  })
  const gateway = new CodexModelGateway({
    bearerToken: 'local-capability-token',
    maxBodyBytes: 4096,
    maxConcurrentRequests: 1,
    authority: {
      async resolve() { throw new Error('binding_not_found') },
    },
    credentials: {
      resolve() { return 'upstream-secret' },
    },
  })
  const address = await gateway.start()
  try {
    const body = JSON.stringify(baseRequest())
    const unauthorized = await fetch(`${address.url}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })
    assert.equal(unauthorized.status, 401)

    const wrongHost = await rawPost({
      url: `${address.url}/v1/responses`,
      host: 'localhost',
      authorization: 'Bearer local-capability-token',
      body,
    })
    assert.equal(wrongHost.status, 400)

    const oversized = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-capability-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ payload: 'x'.repeat(8192) }),
    })
    assert.equal(oversized.status, 413)

    const unbound = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-capability-token',
        'content-type': 'application/json',
      },
      body,
    })
    assert.equal(unbound.status, 409)

    const extended = { ...baseRequest(), unexpected: true }
    const invalidShape = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer local-capability-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(extended),
    })
    assert.equal(invalidShape.status, 400)
    assert.match(await invalidShape.text(), /gateway_request_shape_invalid/)
    assert.equal(JSON.stringify(created.snapshot).includes('upstream-secret'), false)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('each sidecar spawn gets one capability and every prior token is rejected before authority', async () => {
  let authorityCalls = 0
  let upstreamCalls = 0
  const upstreamBodies: Record<string, unknown>[] = []
  const validatedCaptures: Array<{
    requestKind: string
    requestDigest: string
    toolCount: number
    proofSentinelOccurrences: number
    proofSentinels: Array<{ digest: string; occurrences: number }>
    inputItems: Array<{ maxStringCharacters: number }>
  }> = []
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
    upstreamCalls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      `event: response.created\ndata: ${JSON.stringify({
        type: 'response.created',
        response: { id: `spawn-response-${upstreamCalls}`, model: 'native-model', status: 'in_progress', output: [] },
      })}`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: `spawn-response-${upstreamCalls}`, model: 'native-model', status: 'completed', output: [],
          usage: nativeUsage(),
        },
      })}`,
      '',
    ].join('\n\n'))
  })
  const upstreamPort = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'spawn-profile',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'upstream-secret', model: 'native-model', agentProtocol: 'openai',
      wireApi: 'responses', toolUseMode: 'on', maxOutputTokensOverride: 9_876,
    },
    maxRetries: 0,
  })
  const body = baseRequest(null)
  const metadata = JSON.parse(
    (body.client_metadata as Record<string, string>)['x-codex-turn-metadata'],
  ) as Record<string, unknown>
  metadata.upstreamProfileSnapshotDigest = created.snapshotDigest
  ;(body.client_metadata as Record<string, string>)['x-codex-turn-metadata'] = JSON.stringify(metadata)
  const binding: CodexModelGatewayBinding = {
    kind: 'product', codexModel: 'ready-e0-model', snapshot: created.snapshot,
    snapshotDigest: created.snapshotDigest, toolSurfaceDigest: digestCanonicalJson([]), requestToolsDigest: digestCanonicalJson([]),
    turnContractDigest: 'turn-contract-1',
    instructionContractDigest: instructionTranscriptDigest(body.instructions, body.input),
    additionalContextDigest: digestCanonicalJson([]),
    deliveredUserTail: [],
    forceToolFreeFinalization: false,
    allowedToolNames: [],
  }
  const gateway = new CodexModelGateway({
    spawnBound: true,
    proofSentinels: ['hello', 'fixed instructions'],
    onValidatedRequest(capture) { validatedCaptures.push(capture) },
    authority: {
      async resolve(input) {
        authorityCalls += 1
        input.validate(binding)
        return binding
      },
    },
    credentials: { resolve() { return 'upstream-secret' } },
  })
  const address = await gateway.start()
  const call = (token: string, requestBody: Record<string, unknown> = body) => fetch(
    `${address.url}/v1/responses`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    },
  )
  try {
    const first = gateway.activateSpawn('spawn-a')
    const firstResponse = await call(first.bearerToken)
    assert.equal(firstResponse.status, 200)
    assert.match(await firstResponse.text(), /response\.completed/)
    assert.equal(authorityCalls, 1)
    assert.equal(upstreamCalls, 1)
    assert.equal(upstreamBodies[0]?.max_output_tokens, 9_876)
    assert.equal(validatedCaptures.length, 1)
    assert.equal(validatedCaptures[0].requestKind, 'product')
    assert.match(validatedCaptures[0].requestDigest, /^[a-f0-9]{64}$/)
    assert.equal(validatedCaptures[0].toolCount, 0)
    assert.equal(validatedCaptures[0].proofSentinelOccurrences, 1)
    assert.equal(validatedCaptures[0].proofSentinels.length, 2)
    assert.deepEqual(validatedCaptures[0].proofSentinels.map((item) => item.occurrences), [1, 1])
    assert.ok(validatedCaptures[0].inputItems.some((item) => item.maxStringCharacters >= 5))

    const second = gateway.activateSpawn('spawn-b')
    assert.notEqual(first.bearerToken, second.bearerToken)
    const authorityBeforeStale = authorityCalls
    const upstreamBeforeStale = upstreamCalls
    const staleBodies = ['turn', 'automatic_compaction', 'manual_compaction'].map((kind) => {
      const requestBody = structuredClone(body)
      const raw = JSON.parse(
        (requestBody.client_metadata as Record<string, string>)['x-codex-turn-metadata'],
      ) as Record<string, unknown>
      if (kind !== 'turn') delete raw.model
      if (kind === 'automatic_compaction') {
        raw.request_kind = 'compaction'
        raw.compaction = {
          trigger: 'auto', reason: 'context_limit', implementation: 'responses',
          phase: 'pre_turn', strategy: 'memento',
        }
      } else if (kind === 'manual_compaction') {
        raw.request_kind = 'compaction'
        raw.compaction = {
          trigger: 'manual', reason: 'user_requested', implementation: 'responses',
          phase: 'standalone_turn', strategy: 'memento',
        }
      }
      ;(requestBody.client_metadata as Record<string, string>)['x-codex-turn-metadata'] = JSON.stringify(raw)
      return requestBody
    })
    for (const staleBody of staleBodies) {
      const stale = await call(first.bearerToken, staleBody)
      assert.equal(stale.status, 401)
    }
    assert.equal(authorityCalls, authorityBeforeStale)
    assert.equal(upstreamCalls, upstreamBeforeStale)

    const current = await call(second.bearerToken)
    assert.equal(current.status, 200)
    assert.match(await current.text(), /response\.completed/)
    assert.equal(authorityCalls, 2)
    assert.equal(upstreamCalls, 2)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('rotating the sidecar capability aborts an admitted old request before credential or upstream', async () => {
  let authorityEnteredResolve: (() => void) | null = null
  const authorityEntered = new Promise<void>((resolve) => { authorityEnteredResolve = resolve })
  let releaseAuthorityResolve: (() => void) | null = null
  const releaseAuthority = new Promise<void>((resolve) => { releaseAuthorityResolve = resolve })
  let credentialCalls = 0
  let upstreamCalls = 0
  const upstream = createServer((_request, response) => {
    upstreamCalls += 1
    response.writeHead(500).end()
  })
  const upstreamPort = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'rotate-profile',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'upstream-secret', model: 'native-model', agentProtocol: 'openai',
      wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const body = baseRequest(null)
  const metadata = JSON.parse(
    (body.client_metadata as Record<string, string>)['x-codex-turn-metadata'],
  ) as Record<string, unknown>
  metadata.upstreamProfileSnapshotDigest = created.snapshotDigest
  ;(body.client_metadata as Record<string, string>)['x-codex-turn-metadata'] = JSON.stringify(metadata)
  const binding: CodexModelGatewayBinding = {
    kind: 'product', codexModel: 'ready-e0-model', snapshot: created.snapshot,
    snapshotDigest: created.snapshotDigest, toolSurfaceDigest: digestCanonicalJson([]), requestToolsDigest: digestCanonicalJson([]),
    turnContractDigest: 'turn-contract-1',
    instructionContractDigest: instructionTranscriptDigest(body.instructions, body.input),
    additionalContextDigest: digestCanonicalJson([]),
    deliveredUserTail: [],
    forceToolFreeFinalization: false,
    allowedToolNames: [],
  }
  const gateway = new CodexModelGateway({
    spawnBound: true,
    authority: {
      async resolve(input) {
        authorityEnteredResolve?.()
        await releaseAuthority
        input.validate(binding)
        return binding
      },
    },
    credentials: { resolve() { credentialCalls += 1; return 'upstream-secret' } },
  })
  const address = await gateway.start()
  try {
    const first = gateway.activateSpawn('spawn-a')
    const pending = fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${first.bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    await authorityEntered
    gateway.activateSpawn('spawn-b')
    releaseAuthorityResolve?.()
    const rejected = await pending
    assert.equal(rejected.status, 503)
    assert.match(await rejected.text(), /gateway_stopped/)
    assert.equal(credentialCalls, 0)
    assert.equal(upstreamCalls, 0)
  } finally {
    releaseAuthorityResolve?.()
    await gateway.stop()
    await close(upstream)
  }
})

test('rotating the sidecar capability aborts an old request while its body is still uploading', async () => {
  let authorityCalls = 0
  let upstreamCalls = 0
  const upstream = createServer((_request, response) => {
    upstreamCalls += 1
    response.writeHead(500).end()
  })
  await listen(upstream)
  const gateway = new CodexModelGateway({
    spawnBound: true,
    bodyDeadlineMs: 1_000,
    authority: {
      async resolve() {
        authorityCalls += 1
        throw new Error('unexpected_authority_call')
      },
    },
    credentials: { resolve() { return 'upstream-secret' } },
  })
  const address = await gateway.start()
  const first = gateway.activateSpawn('spawn-upload-a')
  const target = new URL(`${address.url}/v1/responses`)
  let pendingRequest: ReturnType<typeof httpRequest> | null = null
  try {
    const outcome = new Promise<number | 'closed'>((resolve) => {
      const request = httpRequest({
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: {
          authorization: `Bearer ${first.bearerToken}`,
          'content-type': 'application/json',
          'content-length': 1_024,
        },
      }, (response) => {
        response.resume()
        response.once('end', () => resolve(response.statusCode || 0))
      })
      pendingRequest = request
      request.once('error', () => resolve('closed'))
      request.write('{')
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    gateway.activateSpawn('spawn-upload-b')
    assert.equal(await outcome, 'closed')
    assert.equal(authorityCalls, 0)
    assert.equal(upstreamCalls, 0)
  } finally {
    pendingRequest?.destroy()
    await gateway.stop()
    await close(upstream)
  }
})

test('chat conversion streams text and authorized tools while blocking malicious or mutated tool names', async () => {
  const upstreamBodies: Record<string, unknown>[] = []
  let toolMode: 'allowed' | 'malicious' | 'mutated' | 'parallel' | 'none' = 'allowed'
  let admittedResponseGroups = 0
  let finishReason: 'tool_calls' | 'stop' | 'length' | 'content_filter' = 'tool_calls'
  const chatUpstreamHeaders: Array<Record<string, unknown>> = []
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
    chatUpstreamHeaders.push(request.headers)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`data: ${JSON.stringify({
      id: 'chat-1', model: 'upstream-model', choices: [{ index: 0, delta: { reasoning_summary: 'checked' } }],
    })}\n\n`)
    response.write(`data: ${JSON.stringify({
      id: 'chat-1', model: 'upstream-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello ' } }],
    })}\n\n`)
    response.write(`data: ${JSON.stringify({
      id: 'chat-1', model: 'upstream-model', choices: [{ index: 0, delta: { content: 'world' } }],
    })}\n\n`)
    if (toolMode !== 'none') {
      const toolCalls = [{
        index: 0, id: 'call-1', type: 'function',
        function: {
          name: toolMode === 'malicious' ? 'shell_exec' : 'ready_read_probe',
          arguments: toolMode === 'mutated' ? '{"query":' : '{"query":"ok"}',
        },
      }]
      if (toolMode === 'parallel') toolCalls.push({
        index: 1, id: 'call-2', type: 'function',
        function: { name: 'ready_read_probe', arguments: '{"query":"other"}' },
      })
      response.write(`data: ${JSON.stringify({
        id: 'chat-1', model: 'upstream-model', choices: [{ index: 0, delta: { tool_calls: [{
          ...toolCalls[0],
        }, ...toolCalls.slice(1)] } }],
      })}\n\n`)
    }
    if (toolMode === 'mutated') {
      response.write(`data: ${JSON.stringify({
        id: 'chat-1', model: 'upstream-model', choices: [{ index: 0, delta: { tool_calls: [{
          index: 0, function: { name: '_evil', arguments: '"ok"}' },
        }] } }],
      })}\n\n`)
    }
    response.write(`data: ${JSON.stringify({
      id: 'chat-1', model: 'upstream-model', choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: {
        prompt_tokens: 7, completion_tokens: 5, total_tokens: 12,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  const upstreamPort = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-1',
    config: {
      provider: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'upstream-secret',
      model: 'upstream-model',
      agentProtocol: 'openai',
      wireApi: 'chat/completions',
      maxOutputTokensOverride: 12_345,
      toolUseMode: 'on',
      visionMode: 'on',
    },
    maxRetries: 0,
  })
  const request = baseRequest()
  const v1 = {
    logicalResourceId: 'document-1', currentVersion: 'v1', currentDigest: 'digest-v1',
    supersedesVersion: null, policyEpoch: 1,
  }
  const v2 = {
    logicalResourceId: 'document-1', currentVersion: 'v2', currentDigest: 'digest-v2',
    supersedesVersion: 'v1', policyEpoch: 2,
  }
  const hostOverlay = buildCodexThreadDeveloperInstructions()
  request.input = [
    {
      type: 'message', role: 'developer',
      content: [{ type: 'input_text', text: hostOverlay }],
    },
    {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: `<external_ready_resources>${JSON.stringify(v1)}</external_ready_resources>` }],
    },
    {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'previous answer' }],
    },
    {
      type: 'message', role: 'developer',
      content: [{ type: 'input_text', text: `<ready-resource-context>${JSON.stringify({ contract: 'ready_resource_context_v1', readyRunId: 'run-1', references: [v2] })}</ready-resource-context>` }],
    },
    {
      type: 'message', role: 'user',
      content: [
        { type: 'input_text', text: 'describe' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' },
      ],
    },
  ]
  const metadata = JSON.parse(
    (request.client_metadata as Record<string, string>)['x-codex-turn-metadata'],
  ) as Record<string, unknown>
  metadata.upstreamProfileSnapshotDigest = created.snapshotDigest
  ;(request.client_metadata as Record<string, string>)['x-codex-turn-metadata'] = JSON.stringify(metadata)
  const binding: CodexModelGatewayBinding = {
    kind: 'product',
    codexModel: 'ready-e0-model',
    snapshot: created.snapshot,
    snapshotDigest: created.snapshotDigest,
    toolSurfaceDigest: metadata.toolSurfaceDigest as string,
    requestToolsDigest: metadata.toolSurfaceDigest as string,
    turnContractDigest: 'turn-contract-1',
    instructionContractDigest: instructionTranscriptDigest(request.instructions, request.input),
    additionalContextDigest: digestCanonicalJson([v2]),
    deliveredUserTail: [],
    forceToolFreeFinalization: false,
    allowedToolNames: ['ready_read_probe'],
  }
  const gateway = new CodexModelGateway({
    bearerToken: 'local-capability-token',
    authority: {
      async resolve(input) {
        input.validate(binding)
        return binding
      },
      async admitToolResponse() { admittedResponseGroups += 1 },
    },
    credentials: { resolve() { return 'upstream-secret' } },
  })
  const address = await gateway.start()
  const call = async () => fetch(`${address.url}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer local-capability-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
  })
  try {
    const response = await call()
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /response\.output_text\.delta/)
    assert.match(text, /hello /)
    assert.match(text, /world/)
    assert.match(text, /response\.reasoning_summary_text\.delta/)
    assert.match(text, /ready_read_probe/)
    assert.match(text, /response\.completed/)
    assert.match(text, /"cached_tokens":2/)
    assert.match(text, /"reasoning_tokens":3/)
    assert.equal(chatUpstreamHeaders[0]?.['session-id'], undefined, 'Codex session headers are a Responses contract')
    const addedEvents = text.split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
      .filter((event) => event.type === 'response.output_item.added')
    assert.deepEqual(addedEvents.map((event) => event.output_index), [0, 1, 2])
    assert.equal(new Set(addedEvents.map((event) => event.output_index)).size, addedEvents.length)
    assert.equal(upstreamBodies[0]?.model, 'upstream-model')
    assert.equal(JSON.stringify(upstreamBodies[0]).includes('ready-e0-model'), false)
    assert.equal(upstreamBodies[0]?.stream, true)
    assert.equal(upstreamBodies[0]?.max_tokens, 12_345)
    assert.match(JSON.stringify(upstreamBodies[0]), /data:image\/png;base64,AAAA/)
    const developerMessages = (upstreamBodies[0]?.messages as Array<Record<string, unknown>>)
      .filter((message) => message.role === 'developer')
    assert.equal(developerMessages.length, 3)
    assert.equal(developerMessages[0].content, 'fixed instructions')
    assert.equal(developerMessages[1].content, hostOverlay)
    assert.equal(
      JSON.stringify(upstreamBodies[0]).split('lark-cli auth status --json --verify').length - 1,
      0,
    )
    assert.equal(admittedResponseGroups, 1)

    binding.forceToolFreeFinalization = true
    toolMode = 'none'
    finishReason = 'stop'
    const finalized = await call()
    assert.equal(finalized.status, 200)
    assert.match(await finalized.text(), /response\.completed/)
    const finalizationBody = upstreamBodies.at(-1) || {}
    assert.equal('tools' in finalizationBody, false)
    assert.equal('tool_choice' in finalizationBody, false)
    assert.equal('parallel_tool_calls' in finalizationBody, false)
    assert.equal(admittedResponseGroups, 1)
    binding.forceToolFreeFinalization = false

    toolMode = 'parallel'
    finishReason = 'tool_calls'
    request.parallel_tool_calls = false
    const forbiddenParallel = await call()
    assert.equal(forbiddenParallel.status, 200)
    const forbiddenParallelText = await forbiddenParallel.text()
    assert.match(forbiddenParallelText, /gateway_parallel_tool_calls_forbidden/)
    const forbiddenParallelEvents = forbiddenParallelText.split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    assert.equal(forbiddenParallelEvents.some((event) => (
      String(event.type).startsWith('response.function_call_arguments.')
      || (
        event.type === 'response.output_item.added'
        && (event.item as Record<string, unknown> | undefined)?.type === 'function_call'
      )
      || event.type === 'response.completed'
    )), false)
    assert.equal(admittedResponseGroups, 1)
    request.parallel_tool_calls = true

    toolMode = 'malicious'
    const blocked = await call()
    assert.equal(blocked.status, 200)
    const blockedText = await blocked.text()
    assert.match(blockedText, /gateway_response_tool_not_authorized/)
    assert.doesNotMatch(blockedText, /"name":"shell_exec"/)

    toolMode = 'mutated'
    const mutated = await call()
    assert.equal(mutated.status, 200)
    const mutatedText = await mutated.text()
    assert.match(mutatedText, /gateway_tool_call_name_changed/)
    assert.doesNotMatch(mutatedText, /ready_read_probe_evil/)
    const mutatedEvents = mutatedText.split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    assert.equal(mutatedEvents.some((event) => (
      event.type === 'response.function_call_arguments.delta'
      || event.type === 'response.function_call_arguments.done'
      || (
        event.type === 'response.output_item.added'
        && (event.item as Record<string, unknown> | undefined)?.type === 'function_call'
      )
    )), false)

    toolMode = 'none'
    finishReason = 'length'
    const truncated = await call()
    assert.equal(truncated.status, 200)
    const truncatedText = await truncated.text()
    assert.match(truncatedText, /response\.failed/)
    assert.match(truncatedText, /gateway_upstream_output_truncated/)
    assert.doesNotMatch(truncatedText, /response\.(completed|incomplete)/)
    assert.ok(
      truncatedText.indexOf('response.output_text.delta')
      < truncatedText.indexOf('response.failed'),
    )

    finishReason = 'content_filter'
    const filtered = await call()
    assert.equal(filtered.status, 200)
    const filteredText = await filtered.text()
    assert.match(filteredText, /response\.failed/)
    assert.match(filteredText, /gateway_upstream_output_filtered/)
    assert.doesNotMatch(filteredText, /response\.(completed|incomplete)/)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('native Responses lane forwards only verified events and rejects action items', async () => {
  let malicious = false
  let maliciousCompleted = false
  let admittedResponseGroups = 0
  const upstreamBodies: Record<string, unknown>[] = []
  const upstreamHeaders: Array<Record<string, unknown>> = []
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
    upstreamHeaders.push(request.headers)
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'turn-state-1', 'x-oai-request-id': 'oai-request-1' })
    response.write(`event: response.created\ndata: ${JSON.stringify({
      type: 'response.created',
      response: { id: 'response-native-1', model: 'native-model', status: 'in_progress', output: [] },
    })}\n\n`)
    response.write(`event: response.output_item.added\ndata: ${JSON.stringify({
      type: 'response.output_item.added', output_index: 0,
      item: malicious
        ? {
            type: 'function_call', id: 'tool-1', call_id: 'call-1',
            name: 'ready_read_probe', arguments: '', status: 'in_progress',
          }
        : { type: 'message', id: 'message-1', role: 'assistant', content: [] },
    })}\n\n`)
    if (!malicious) {
      response.write(`event: response.output_text.delta\ndata: ${JSON.stringify({
        type: 'response.output_text.delta', output_index: 0, content_index: 0,
        item_id: 'message-1', delta: 'native-ok',
      })}\n\n`)
      response.write(`event: response.output_text.done\ndata: ${JSON.stringify({
        type: 'response.output_text.done', output_index: 0, content_index: 0,
        item_id: 'message-1', text: 'native-ok',
      })}\n\n`)
      response.write(`event: response.output_item.done\ndata: ${JSON.stringify({
        type: 'response.output_item.done', output_index: 0,
        item: {
          type: 'message', id: 'message-1', role: 'assistant',
          content: [{ type: 'output_text', text: 'native-ok' }],
        },
      })}\n\n`)
      response.write(`event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed', response: {
          id: 'response-native-1', model: 'native-model', status: 'completed',
          ...(maliciousCompleted
            ? { output: [{ type: 'shell_call', id: 'shell-completed', command: 'touch forbidden' }] }
            : { output: [{
                type: 'message', id: 'message-1', role: 'assistant',
                content: [{ type: 'output_text', text: 'native-ok' }],
              }] }),
          usage: nativeUsage(),
        },
      })}\n\n`)
    }
    response.end()
  })
  const upstreamPort = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-native',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'upstream-secret', model: 'native-model', agentProtocol: 'openai',
      wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const request = baseRequest('ready_read_probe')
  const metadata = JSON.parse(
    (request.client_metadata as Record<string, string>)['x-codex-turn-metadata'],
  ) as Record<string, unknown>
  metadata.upstreamProfileSnapshotDigest = created.snapshotDigest
  ;(request.client_metadata as Record<string, string>)['x-codex-turn-metadata'] = JSON.stringify(metadata)
  const gateway = new CodexModelGateway({
    bearerToken: 'local-capability-token',
    authority: {
      async resolve(input) {
        const binding: CodexModelGatewayBinding = {
          kind: 'product', codexModel: 'ready-e0-model', snapshot: created.snapshot,
          snapshotDigest: created.snapshotDigest,
          toolSurfaceDigest: metadata.toolSurfaceDigest as string,
          requestToolsDigest: metadata.toolSurfaceDigest as string,
          turnContractDigest: 'turn-contract-1',
          instructionContractDigest: instructionTranscriptDigest(request.instructions, request.input),
          additionalContextDigest: digestCanonicalJson([]),
          deliveredUserTail: [],
          forceToolFreeFinalization: true,
          allowedToolNames: ['ready_read_probe'],
        }
        input.validate(binding)
        return binding
      },
      async admitToolResponse() { admittedResponseGroups += 1 },
    },
    credentials: { resolve() { return 'upstream-secret' } },
  })
  const address = await gateway.start()
  const call = (headers: Record<string, string> = {}) => fetch(`${address.url}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer local-capability-token',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(request),
  })
  try {
    const allowed = await call()
    assert.equal(allowed.status, 200)
    assert.match(await allowed.text(), /native-ok/)
    // The backend's per-turn routing token goes back to Codex and returns on the turn's next request.
    assert.equal(allowed.headers.get('x-codex-turn-state'), 'turn-state-1')
    assert.equal(allowed.headers.get('x-ready-upstream-request-id'), 'oai-request-1')
    assert.equal(upstreamHeaders[0]?.['x-codex-turn-state'], undefined)
    assert.equal((await call({ 'x-codex-turn-state': 'turn-state-1' })).status, 200)
    assert.equal(upstreamHeaders[1]?.['x-codex-turn-state'], 'turn-state-1')
    assert.deepEqual(upstreamBodies[0]?.tools, [])
    assert.equal(upstreamBodies[0]?.tool_choice, 'none')
    assert.equal(upstreamBodies[0]?.parallel_tool_calls, false)
    // Prompt-cache routing keys on the session identity Codex sends; the hop keeps it.
    assert.equal(upstreamHeaders[0]?.['session-id'], 'thread-native-1')
    assert.equal(upstreamHeaders[0]?.['thread-id'], 'thread-native-1')
    assert.equal(upstreamHeaders[0]?.['x-client-request-id'], 'thread-native-1')
    assert.equal(upstreamHeaders[0]?.['x-codex-window-id'], 'thread-native-1:0')
    malicious = true
    const blocked = await call()
    assert.equal(blocked.status, 200)
    const blockedText = await blocked.text()
    assert.match(blockedText, /gateway_response_tool_not_authorized/)
    assert.doesNotMatch(blockedText, /ready_read_probe/)
    assert.equal(admittedResponseGroups, 0)

    malicious = false
    maliciousCompleted = true
    const completedBlocked = await call()
    assert.equal(completedBlocked.status, 200)
    const completedBlockedText = await completedBlocked.text()
    assert.match(completedBlockedText, /gateway_response_item_not_allowed/)
    assert.doesNotMatch(completedBlockedText, /touch forbidden/)
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('gateway owns retries exactly and never retries semantic 4xx responses', async () => {
  let mode: 'retryable' | 'semantic' = 'retryable'
  let calls = 0
  const diagnostics: CodexModelGatewayUpstreamFailureDiagnostic[] = []
  const upstream = createServer((_request, response) => {
    calls += 1
    if (mode === 'retryable' && calls === 1) {
      response.writeHead(503, { 'content-type': 'application/json' }).end('{}')
      return
    }
    if (mode === 'semantic') {
      response.writeHead(401, { 'content-type': 'application/json', 'x-request-id': 'upstream-401' })
        .end(JSON.stringify({ error: { code: 'invalid_api_key', type: 'auth_error',
          message: 'key upstream-secret rejected' } }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end([
      `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'r1', model: 'native-model', status: 'in_progress', output: [] } })}`,
      `event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'r1', model: 'native-model', status: 'completed', output: [], usage: nativeUsage(),
        },
      })}`,
      '',
    ].join('\n\n'))
  })
  const upstreamPort = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-retry',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'upstream-secret', model: 'native-model', agentProtocol: 'openai',
      wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 1,
  })
  const request = baseRequest(null)
  const metadata = JSON.parse(
    (request.client_metadata as Record<string, string>)['x-codex-turn-metadata'],
  ) as Record<string, unknown>
  metadata.upstreamProfileSnapshotDigest = created.snapshotDigest
  ;(request.client_metadata as Record<string, string>)['x-codex-turn-metadata'] = JSON.stringify(metadata)
  const gateway = new CodexModelGateway({
    bearerToken: 'local-capability-token',
    authority: {
      async resolve(input) {
        const binding: CodexModelGatewayBinding = {
          kind: 'product', codexModel: 'ready-e0-model', snapshot: created.snapshot,
          snapshotDigest: created.snapshotDigest, toolSurfaceDigest: digestCanonicalJson([]), requestToolsDigest: digestCanonicalJson([]),
          turnContractDigest: 'turn-contract-1',
          instructionContractDigest: instructionTranscriptDigest(request.instructions, request.input),
          additionalContextDigest: digestCanonicalJson([]),
          deliveredUserTail: [],
          forceToolFreeFinalization: false,
          allowedToolNames: [],
        }
        input.validate(binding)
        return binding
      },
    },
    credentials: { resolve() { return 'upstream-secret' } },
    onUpstreamFailure(diagnostic) { diagnostics.push(diagnostic) },
  })
  const address = await gateway.start()
  const call = () => fetch(`${address.url}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer local-capability-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
  })
  try {
    const recovered = await call()
    assert.equal(recovered.status, 200)
    await recovered.text()
    assert.equal(calls, 2)
    assert.deepEqual(diagnostics, [], 'a recovered retry is not a failure')
    mode = 'semantic'
    calls = 0
    const rejected = await call()
    assert.equal(rejected.status, 401)
    assert.equal(calls, 1)
    assert.equal(diagnostics.length, 1)
    assert.equal(diagnostics[0].causeCode, 'gateway_upstream_http_401')
    assert.equal(diagnostics[0].failureStage, 'headers')
    assert.equal(diagnostics[0].profileId, 'profile-retry')
    assert.equal(diagnostics[0].upstreamRequestId, 'upstream-401')
    assert.deepEqual(diagnostics[0].providerError, {
      code: 'invalid_api_key', type: 'auth_error', message: 'key [REDACTED] rejected',
    })
  } finally {
    await gateway.stop()
    await close(upstream)
  }
})

test('gateway rejects excess concurrency before authority work and aborts an in-flight upstream without retry', async () => {
  let upstreamCalls = 0
  let firstUpstreamClosedResolve: (() => void) | null = null
  const firstUpstreamClosed = new Promise<void>((resolve) => { firstUpstreamClosedResolve = resolve })
  let secondUpstreamClosedResolve: (() => void) | null = null
  const secondUpstreamClosed = new Promise<void>((resolve) => { secondUpstreamClosedResolve = resolve })
  let releaseUpstreamResolve: (() => void) | null = null
  const releaseUpstream = new Promise<void>((resolve) => { releaseUpstreamResolve = resolve })
  const upstream = createServer((_request, response) => {
    upstreamCalls += 1
    const callNumber = upstreamCalls
    response.once('close', () => {
      if (callNumber === 1) firstUpstreamClosedResolve?.()
      if (callNumber === 2) secondUpstreamClosedResolve?.()
    })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(`event: response.created\ndata: ${JSON.stringify({
      type: 'response.created',
      response: { id: 'response-abort-1', model: 'native-model', status: 'in_progress', output: [] },
    })}\n\n`)
    void releaseUpstream.then(() => response.end())
  })
  const upstreamPort = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-abort',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'upstream-secret', model: 'native-model', agentProtocol: 'openai',
      wireApi: 'responses', toolUseMode: 'on',
    },
    maxRetries: 1,
  })
  const request = baseRequest(null)
  const metadata = JSON.parse(
    (request.client_metadata as Record<string, string>)['x-codex-turn-metadata'],
  ) as Record<string, unknown>
  metadata.upstreamProfileSnapshotDigest = created.snapshotDigest
  ;(request.client_metadata as Record<string, string>)['x-codex-turn-metadata'] = JSON.stringify(metadata)
  const binding: CodexModelGatewayBinding = {
    kind: 'product', codexModel: 'ready-e0-model', snapshot: created.snapshot,
    snapshotDigest: created.snapshotDigest, toolSurfaceDigest: digestCanonicalJson([]), requestToolsDigest: digestCanonicalJson([]),
    turnContractDigest: 'turn-contract-1',
    instructionContractDigest: instructionTranscriptDigest(request.instructions, request.input),
    additionalContextDigest: digestCanonicalJson([]),
    deliveredUserTail: [],
    forceToolFreeFinalization: false,
    allowedToolNames: [],
  }
  let firstAuthorityResolve: (() => void) | null = null
  const firstAuthorityEntered = new Promise<void>((resolve) => { firstAuthorityResolve = resolve })
  let releaseAuthorityResolve: (() => void) | null = null
  const releaseAuthority = new Promise<void>((resolve) => { releaseAuthorityResolve = resolve })
  let authorityCalls = 0
  const gateway = new CodexModelGateway({
    bearerToken: 'local-capability-token',
    maxConcurrentRequests: 1,
    authority: {
      async resolve(input) {
        authorityCalls += 1
        firstAuthorityResolve?.()
        await releaseAuthority
        input.validate(binding)
        return binding
      },
    },
    credentials: { resolve() { return 'upstream-secret' } },
  })
  const address = await gateway.start()
  const headers = {
    authorization: 'Bearer local-capability-token',
    'content-type': 'application/json',
  }
  try {
    const controller = new AbortController()
    const first = fetch(`${address.url}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify(request), signal: controller.signal,
    })
    await firstAuthorityEntered
    const excess = await fetch(`${address.url}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify(request),
    })
    assert.equal(excess.status, 429)
    assert.equal(authorityCalls, 1)

    releaseAuthorityResolve?.()
    const active = await first
    assert.equal(active.status, 200)
    const reader = active.body?.getReader()
    assert.ok(reader)
    const firstChunk = await reader.read()
    assert.equal(firstChunk.done, false)
    controller.abort()
    await assert.rejects(reader.read(), /abort/i)
    await Promise.race([
      firstUpstreamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('upstream_abort_timeout')), 2_000)),
    ])
    assert.equal(upstreamCalls, 1)

    const second = await fetch(`${address.url}/v1/responses`, {
      method: 'POST', headers, body: JSON.stringify(request),
    })
    const secondReader = second.body?.getReader()
    assert.ok(secondReader)
    assert.equal((await secondReader.read()).done, false)
    await Promise.race([
      gateway.stop(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('gateway_stop_timeout')), 2_000)),
    ])
    await Promise.race([
      secondUpstreamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error('upstream_stop_abort_timeout')), 2_000)),
    ])
    await assert.rejects(secondReader.read())
    assert.equal(upstreamCalls, 2)
  } finally {
    releaseAuthorityResolve?.()
    releaseUpstreamResolve?.()
    await gateway.stop()
    await close(upstream)
  }
})
