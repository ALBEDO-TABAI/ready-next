import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'

import {
  createCodexUpstreamProfileSnapshot,
  digestCanonicalJson,
  instructionTranscriptDigest,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import {
  CodexModelGateway,
  type CodexModelGatewayBinding,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway'
import {
  CodexModelGatewayRetryError,
  prepareCodexUpstreamStreamForControlledRetry,
  READY_GATEWAY_MAX_CONTROLLED_RETRIES,
  waitForControlledGatewayRetry,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-retry'

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

function requestBody(snapshotDigest: string): Record<string, unknown> {
  return {
    model: 'ready-e0-model',
    instructions: 'fixed instructions',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    }],
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: { summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'thread-retry-1',
    store: false,
    stream: true,
    client_metadata: {
      'x-codex-installation-id': 'installation-retry',
      session_id: 'thread-retry-1',
      'x-codex-window-id': 'thread-retry-1:0',
      turn_id: 'turn-retry-1',
      thread_id: 'thread-retry-1',
      root_turn_id: 'turn-retry-1',
      'x-codex-turn-metadata': JSON.stringify({
        installation_id: 'installation-retry',
        session_id: 'thread-retry-1',
        request_kind: 'turn',
        thread_id: 'thread-retry-1',
        turn_id: 'turn-retry-1',
        root_turn_id: 'turn-retry-1',
        window_id: 'thread-retry-1:0',
        agent_name: '/root',
        auto_review_enabled: false,
        node_repl_auto_review_required: false,
        node_repl_disabled: false,
        sandbox: 'seatbelt',
        sandbox_mode: 'read-only',
        turn_started_at_unix_ms: 1,
        readyRunId: 'run-retry-1',
        toolSurfaceDigest: digestCanonicalJson([]),
        turnContractDigest: 'turn-contract-retry-1',
        upstreamProfileSnapshotDigest: snapshotDigest,
      }),
    },
  }
}

function chatSuccess(response: Parameters<Parameters<typeof createServer>[0]>[1]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
  response.end([
    `data: ${JSON.stringify({
      id: 'chat-retry-ok',
      model: 'chat-model',
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: 'recovered' },
        finish_reason: 'stop',
      }],
    })}`,
    `data: ${JSON.stringify({
      id: 'chat-retry-ok',
      model: 'chat-model',
      choices: [],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}`,
    'data: [DONE]',
    '',
  ].join('\n\n'))
}

function transientChatFailure(response: Parameters<Parameters<typeof createServer>[0]>[1]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
  response.end(`data: ${JSON.stringify({
    error: {
      code: 'upstream_unavailable',
      type: 'server_error',
      message: 'temporarily unavailable',
    },
  })}\n\n`)
}

function transientChatFailureAfterNeutralPrefix(
  response: Parameters<Parameters<typeof createServer>[0]>[1],
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
  response.end([
    `data: ${JSON.stringify({
      id: 'chat-neutral-retry',
      model: 'chat-model',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    })}`,
    `data: ${JSON.stringify({
      error: {
        code: 'upstream_unavailable',
        type: 'server_error',
        message: 'temporarily unavailable',
      },
    })}`,
    '',
  ].join('\n\n'))
}

function nativeSuccess(response: Parameters<Parameters<typeof createServer>[0]>[1]): void {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
  response.end([
    `event: response.created\ndata: ${JSON.stringify({
      type: 'response.created',
      response: { id: 'native-retry-ok', model: 'native-model', status: 'in_progress', output: [] },
    })}`,
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: { id: 'native-retry-ok', model: 'native-model', status: 'completed', output: [], usage },
    })}`,
    '',
  ].join('\n\n'))
}

function transientNativeFailure(response: Parameters<Parameters<typeof createServer>[0]>[1]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
  response.end([
    `event: response.created\ndata: ${JSON.stringify({
      type: 'response.created',
      response: { id: 'native-retry-failed', model: 'native-model', status: 'in_progress', output: [] },
    })}`,
    `event: response.failed\ndata: ${JSON.stringify({
      type: 'response.failed',
      response: {
        id: 'native-retry-failed',
        model: 'native-model',
        status: 'failed',
        output: [],
        error: { code: 'server_error', type: 'upstream_unavailable', message: 'temporarily unavailable' },
      },
    })}`,
    '',
  ].join('\n\n'))
}

function transientNativeFlatError(response: Parameters<Parameters<typeof createServer>[0]>[1]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
  response.end(`event: error\ndata: ${JSON.stringify({
    type: 'error',
    code: 'server_error',
    message: 'temporarily unavailable',
    param: null,
    sequence_number: 0,
  })}\n\n`)
}

async function withGateway(input: {
  wireApi: 'responses' | 'chat/completions'
  upstream: Server
  onAttempt?: (attempt: number) => void
  admitToolResponse?: () => void
  maxRetries?: number
  headersDeadlineMs?: number
  run: (url: string, body: Record<string, unknown>) => Promise<void>
}): Promise<void> {
  const port = await listen(input.upstream)
  const model = input.wireApi === 'responses' ? 'native-model' : 'chat-model'
  const created = createCodexUpstreamProfileSnapshot({
    profileId: `retry-${input.wireApi}`,
    config: {
      provider: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'upstream-secret',
      model,
      agentProtocol: 'openai',
      wireApi: input.wireApi,
      toolUseMode: 'on',
    },
    maxRetries: input.maxRetries ?? READY_GATEWAY_MAX_CONTROLLED_RETRIES,
  })
  const body = requestBody(created.snapshotDigest)
  const gateway = new CodexModelGateway({
    bearerToken: 'local-retry-token',
    onUpstreamAttempt: input.onAttempt,
    headersDeadlineMs: input.headersDeadlineMs,
    authority: {
      async resolve(authorityInput) {
        const binding: CodexModelGatewayBinding = {
          kind: 'product',
          codexModel: 'ready-e0-model',
          snapshot: created.snapshot,
          snapshotDigest: created.snapshotDigest,
          toolSurfaceDigest: digestCanonicalJson([]),
          turnContractDigest: 'turn-contract-retry-1',
          instructionContractDigest: instructionTranscriptDigest(body.instructions, body.input),
          additionalContextDigest: digestCanonicalJson([]),
          deliveredUserTail: [],
          forceToolFreeFinalization: false,
          allowedToolNames: [],
        }
        authorityInput.validate(binding)
        return binding
      },
      async admitToolResponse() { input.admitToolResponse?.() },
    },
    credentials: { resolve() { return 'upstream-secret' } },
  })
  const address = await gateway.start()
  try {
    await input.run(address.url, body)
  } finally {
    await gateway.stop()
    await close(input.upstream)
  }
}

async function callGateway(url: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${url}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer local-retry-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

test('controlled retry limit is six and the seventh retry is rejected by the snapshot contract', () => {
  assert.equal(READY_GATEWAY_MAX_CONTROLLED_RETRIES, 6)
  assert.throws(() => createCodexUpstreamProfileSnapshot({
    profileId: 'too-many-retries',
    config: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'secret',
      model: 'native-model',
      agentProtocol: 'openai',
      wireApi: 'responses',
      toolUseMode: 'on',
    },
    maxRetries: 7,
  }), /gateway_retry_policy_invalid/)
})

test('an already-aborted request cannot enter a zero-delay retry', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => waitForControlledGatewayRetry({
    retryOrdinal: 1,
    response: new Response(null, { headers: { 'retry-after': '0' } }),
    signal: controller.signal,
  }), /gateway_request_aborted/)
})

test('retryable HTTP failures recover on the seventh and final wire request', async () => {
  let calls = 0
  const attempts: number[] = []
  const upstream = createServer((_request, response) => {
    calls += 1
    if (calls <= READY_GATEWAY_MAX_CONTROLLED_RETRIES) {
      response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' })
      response.end('{"error":{"type":"server_error"}}')
      return
    }
    nativeSuccess(response)
  })
  await withGateway({
    wireApi: 'responses',
    upstream,
    onAttempt: (attempt) => attempts.push(attempt),
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 200)
      assert.match(await result.text(), /response\.completed/)
    },
  })
  assert.equal(calls, 7)
  assert.deepEqual(attempts, [0, 1, 2, 3, 4, 5, 6])
})

test('retryable HTTP exhaustion also stops before an eighth wire request', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' })
    response.end('{"error":{"type":"server_error"}}')
  })
  await withGateway({
    wireApi: 'responses',
    upstream,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 503)
      assert.match(await result.text(), /gateway_upstream_error/)
    },
  })
  assert.equal(calls, 7)
})

test('HTTP retryability follows the shared provider status authority', async () => {
  for (const status of [408, 425]) {
    let calls = 0
    const upstream = createServer((_request, response) => {
      calls += 1
      if (calls === 1) {
        response.writeHead(status, {
          'content-type': 'application/json',
          'retry-after': '0',
        })
        response.end('{"error":{"type":"server_error"}}')
        return
      }
      nativeSuccess(response)
    })
    await withGateway({
      wireApi: 'responses',
      upstream,
      async run(url, body) {
        const result = await callGateway(url, body)
        assert.equal(result.status, 200)
        await result.text()
      },
    })
    assert.equal(calls, 2, `status ${status}`)
  }

  for (const status of [307, 308, 501, 505]) {
    let calls = 0
    const upstream = createServer((_request, response) => {
      calls += 1
      response.writeHead(status, {
        'content-type': 'application/json',
        'retry-after': '0',
        ...(status === 307 || status === 308 ? { location: 'https://redirect.invalid/' } : {}),
      })
      response.end('{"error":{"type":"unsupported"}}')
    })
    await withGateway({
      wireApi: 'responses',
      upstream,
      async run(url, body) {
        const result = await callGateway(url, body)
        assert.equal(result.status, status)
        await result.text()
      },
    })
    assert.equal(calls, 1, `status ${status}`)
  }
})

test('in-band retryability follows the same provider status authority', async () => {
  for (const status of [408, 425, 501, 505]) {
    let calls = 0
    const upstream = createServer((_request, response) => {
      calls += 1
      if (calls > 1) {
        chatSuccess(response)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
      response.end(`data: ${JSON.stringify({ error: { status } })}\n\n`)
    })
    await withGateway({
      wireApi: 'chat/completions',
      upstream,
      async run(url, body) {
        const result = await callGateway(url, body)
        assert.equal(result.status, 200)
        await result.text()
      },
    })
    assert.equal(calls, status === 408 || status === 425 ? 2 : 1, `status ${status}`)
  }

  for (const fixture of [
    { code: '501', message: 'protocol mismatch' },
    { code: '505', message: 'protocol mismatch' },
    { code: '503', message: 'invalid api key: unauthorized' },
  ]) {
    let calls = 0
    const upstream = createServer((_request, response) => {
      calls += 1
      if (calls > 1) {
        nativeSuccess(response)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
      response.end(`event: error\ndata: ${JSON.stringify({
        type: 'error', code: fixture.code, message: fixture.message, param: null, sequence_number: 0,
      })}\n\n`)
    })
    await withGateway({
      wireApi: 'responses',
      upstream,
      async run(url, body) {
        const result = await callGateway(url, body)
        assert.equal(result.status, 200)
        await result.text()
      },
    })
    assert.equal(calls, 1, `code ${fixture.code}`)
  }
})

test('an exhausted transport failure remains a typed upstream 502', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    response.destroy()
  })
  await withGateway({
    wireApi: 'responses',
    upstream,
    maxRetries: 0,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 502)
      assert.match(await result.text(), /gateway_upstream_transport_failed/)
    },
  })
  assert.equal(calls, 1)
})

test('an upstream headers deadline retries only before output', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    if (calls === 1) return
    nativeSuccess(response)
  })
  const originalRandom = Math.random
  Math.random = () => 0
  try {
    await withGateway({
      wireApi: 'responses',
      upstream,
      maxRetries: 1,
      headersDeadlineMs: 20,
      async run(url, body) {
        const result = await callGateway(url, body)
        assert.equal(result.status, 200)
        assert.match(await result.text(), /native-retry-ok/)
      },
    })
  } finally {
    Math.random = originalRandom
  }
  assert.equal(calls, 2)
})

test('transient Chat stream failure before output retries without exposing the failed attempt', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    if (calls === 1) transientChatFailure(response)
    else chatSuccess(response)
  })
  await withGateway({
    wireApi: 'chat/completions',
    upstream,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 200)
      const output = await result.text()
      assert.match(output, /recovered/)
      assert.equal(output.match(/event: response\.created/g)?.length, 1)
      assert.doesNotMatch(output, /temporarily unavailable|upstream_unavailable/)
    },
  })
  assert.equal(calls, 2)
})

test('a valid neutral Chat prefix does not prevent a transient pre-output retry', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    if (calls > 1) {
      chatSuccess(response)
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
    response.end([
      `data: ${JSON.stringify({
        id: 'chat-neutral-prefix',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'chat-model',
        system_fingerprint: null,
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: '' },
          finish_reason: null,
        }],
      })}`,
      `data: ${JSON.stringify({
        id: 'chat-neutral-prefix',
        object: 'chat.completion.chunk',
        created: 1,
        system_fingerprint: null,
        error: {
          code: 'upstream_unavailable',
          type: 'server_error',
          message: 'temporarily unavailable',
        },
      })}`,
      '',
    ].join('\n\n'))
  })
  await withGateway({
    wireApi: 'chat/completions',
    upstream,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 200)
      const output = await result.text()
      assert.match(output, /recovered/)
      assert.doesNotMatch(output, /temporarily unavailable|upstream_unavailable/)
    },
  })
  assert.equal(calls, 2)
})

test('a provider-valid transient Chat error with metadata retries before output', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    if (calls > 1) {
      chatSuccess(response)
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
    response.end(`data: ${JSON.stringify({
      id: 'chat-error-with-metadata',
      object: 'chat.completion.chunk',
      created: 1,
      system_fingerprint: null,
      error: {
        code: 'upstream_unavailable',
        type: 'server_error',
        message: 'temporarily unavailable',
      },
    })}\n\n`)
  })
  await withGateway({
    wireApi: 'chat/completions',
    upstream,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 200)
      assert.match(await result.text(), /recovered/)
    },
  })
  assert.equal(calls, 2)
})

test('invalid UTF-8 before a transient Chat error is never laundered by retry', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    if (calls > 1) {
      chatSuccess(response)
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
    response.end(Buffer.concat([
      Buffer.from('data: {"id":"chat-invalid-utf8","object":"'),
      Buffer.from([0xff]),
      Buffer.from('","model":"chat-model","choices":[]}\n\n'),
      Buffer.from(`data: ${JSON.stringify({
        error: {
          code: 'server_error',
          type: 'upstream_unavailable',
          message: 'temporarily unavailable',
        },
      })}\n\n`),
    ]))
  })
  await withGateway({
    wireApi: 'chat/completions',
    upstream,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 200)
      const output = await result.text()
      assert.match(output, /gateway_chat_sse_utf8_invalid/)
      assert.doesNotMatch(output, /recovered/)
    },
  })
  assert.equal(calls, 1)
})

test('incomplete UTF-8 at upstream EOF is replayed to the formal Chat validator', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
    response.end(Buffer.concat([
      Buffer.from('data: {"id":"chat-incomplete-utf8","object":"'),
      Buffer.from([0xe2, 0x82]),
    ]))
  })
  await withGateway({
    wireApi: 'chat/completions',
    upstream,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 200)
      assert.match(await result.text(), /gateway_chat_sse_utf8_invalid/)
    },
  })
  assert.equal(calls, 1)
})

test('a failed stream cancellation cannot replace the decided retry error', async () => {
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'retry-cancel-failure',
    config: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'upstream-secret',
      model: 'chat-model',
      agentProtocol: 'openai',
      wireApi: 'chat/completions',
      toolUseMode: 'on',
    },
    maxRetries: READY_GATEWAY_MAX_CONTROLLED_RETRIES,
  })
  const encoded = new TextEncoder().encode([
    `data: ${JSON.stringify({
      id: 'chat-cancel-failure',
      model: 'chat-model',
      choices: [],
    })}`,
    `data: ${JSON.stringify({
      error: {
        code: 'upstream_unavailable',
        type: 'server_error',
        message: 'temporarily unavailable',
      },
    })}`,
    '',
  ].join('\n\n'))
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded)
    },
    cancel() {
      throw new Error('cancel_failed')
    },
  })

  await assert.rejects(() => prepareCodexUpstreamStreamForControlledRetry({
    body,
    wireApi: 'chat/completions',
    snapshot: created.snapshot,
    credential: 'upstream-secret',
    signal: new AbortController().signal,
    deadlineMs: 1_000,
  }), (error: unknown) => {
    assert.ok(error instanceof CodexModelGatewayRetryError)
    assert.equal(error.code, 'gateway_upstream_transient_before_output')
    return true
  })
})

test('the exact byte probe budget replays the complete chunk without retrying', async () => {
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'retry-byte-budget',
    config: {
      provider: 'openai-compatible',
      baseUrl: 'https://provider.example/v1',
      apiKey: 'upstream-secret',
      model: 'chat-model',
      agentProtocol: 'openai',
      wireApi: 'chat/completions',
      toolUseMode: 'on',
    },
    maxRetries: READY_GATEWAY_MAX_CONTROLLED_RETRIES,
  })
  const encoded = new TextEncoder().encode([
    `data: ${JSON.stringify({
      id: 'chat-byte-budget',
      model: 'chat-model',
      choices: [],
    })}`,
    `data: ${JSON.stringify({
      error: {
        code: 'upstream_unavailable',
        type: 'server_error',
        message: 'temporarily unavailable',
      },
    })}`,
    '',
  ].join('\n\n'))
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded)
      controller.close()
    },
  })

  const replay = await prepareCodexUpstreamStreamForControlledRetry({
    body,
    wireApi: 'chat/completions',
    snapshot: created.snapshot,
    credential: 'upstream-secret',
    signal: new AbortController().signal,
    deadlineMs: 1_000,
    maxProbeBytes: encoded.byteLength,
  })
  assert.deepEqual(new Uint8Array(await new Response(replay).arrayBuffer()), encoded)
})

test('one network chunk cannot cross the neutral event probe budget and then retry', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    if (calls > 1) {
      chatSuccess(response)
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
    response.end([
      ...Array.from({ length: 128 }, () => `data: ${JSON.stringify({
        id: 'chat-event-budget',
        model: 'chat-model',
        choices: [],
      })}`),
      `data: ${JSON.stringify({
        error: {
          code: 'server_error',
          type: 'upstream_unavailable',
          message: 'temporarily unavailable',
        },
      })}`,
      '',
    ].join('\n\n'))
  })
  await withGateway({
    wireApi: 'chat/completions',
    upstream,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 200)
      const output = await result.text()
      assert.match(output, /temporarily unavailable/)
      assert.doesNotMatch(output, /recovered/)
    },
  })
  assert.equal(calls, 1)
})

test('a started native response stays on the formal validator and is never retried', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    transientNativeFailure(response)
  })
  await withGateway({
    wireApi: 'responses',
    upstream,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 200)
      const output = await result.text()
      assert.match(output, /response\.failed/)
      assert.match(output, /temporarily unavailable/)
    },
  })
  assert.equal(calls, 1)
})

test('transient native flat error events retry before output', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    if (calls === 1) transientNativeFlatError(response)
    else nativeSuccess(response)
  })
  await withGateway({
    wireApi: 'responses',
    upstream,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 200)
      const output = await result.text()
      assert.match(output, /native-retry-ok/)
      assert.doesNotMatch(output, /temporarily unavailable/)
    },
  })
  assert.equal(calls, 2)
})

test('native retry preflight never launders event or response identity drift', async () => {
  const cases = [
    {
      name: 'event-name',
      expected: /gateway_native_sse_event_invalid/,
      body: `event: response.completed\ndata: ${JSON.stringify({
        type: 'error', code: 'server_error', message: 'temporarily unavailable',
        param: null, sequence_number: 0,
      })}\n\n`,
    },
    {
      name: 'response-id',
      expected: /gateway_response_identity_changed/,
      body: [
        `event: response.created\ndata: ${JSON.stringify({
          type: 'response.created',
          response: { id: 'native-owner', model: 'native-model', status: 'in_progress', output: [] },
        })}`,
        `event: response.failed\ndata: ${JSON.stringify({
          type: 'response.failed',
          response: {
            id: 'native-alien', model: 'native-model', status: 'failed', output: [],
            error: { code: 'server_error', message: 'temporarily unavailable' },
          },
        })}`,
        '',
      ].join('\n\n'),
    },
    {
      name: 'response-model',
      expected: /gateway_upstream_model_mismatch/,
      body: [
        `event: response.created\ndata: ${JSON.stringify({
          type: 'response.created',
          response: { id: 'native-owner', model: 'native-model', status: 'in_progress', output: [] },
        })}`,
        `event: response.failed\ndata: ${JSON.stringify({
          type: 'response.failed',
          response: {
            id: 'native-owner', model: 'wrong-model', status: 'failed', output: [],
            error: { code: 'server_error', message: 'temporarily unavailable' },
          },
        })}`,
        '',
      ].join('\n\n'),
    },
    {
      name: 'queued-created',
      expected: /gateway_response_status_mismatch/,
      body: `event: response.created\ndata: ${JSON.stringify({
        type: 'response.created',
        response: { id: 'native-owner', model: 'native-model', status: 'queued', output: [] },
      })}\n\n`,
    },
    {
      name: 'bad-sequence',
      expected: /gateway_response_sequence_invalid/,
      body: `event: response.created\ndata: ${JSON.stringify({
        type: 'response.created', sequence_number: 'bad',
        response: { id: 'native-owner', model: 'native-model', status: 'in_progress', output: [] },
      })}\n\n`,
    },
    {
      name: 'extra-failure-field',
      expected: /gateway_response_failure_error_invalid/,
      body: [
        `event: response.created\ndata: ${JSON.stringify({
          type: 'response.created',
          response: { id: 'native-owner', model: 'native-model', status: 'in_progress', output: [] },
        })}`,
        `event: response.failed\ndata: ${JSON.stringify({
          type: 'response.failed',
          response: {
            id: 'native-owner', model: 'native-model', status: 'failed', output: [],
            error: { code: 'server_error', message: 'temporarily unavailable', unexpected: true },
          },
        })}`,
        '',
      ].join('\n\n'),
    },
  ]
  for (const fixture of cases) {
    let calls = 0
    const upstream = createServer((_request, response) => {
      calls += 1
      if (calls > 1) {
        nativeSuccess(response)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
      response.end(fixture.body)
    })
    await withGateway({
      wireApi: 'responses',
      upstream,
      async run(url, body) {
        const result = await callGateway(url, body)
        assert.equal(result.status, 200)
        assert.match(await result.text(), fixture.expected)
      },
    })
    assert.equal(calls, 1, fixture.name)
  }
})

test('Chat retry preflight leaves every non-error event to the formal validator', async () => {
  const chunk = (value: Record<string, unknown>) => `data: ${JSON.stringify(value)}\n\n`
  const transientError = chunk({
    error: {
      code: 'server_error',
      type: 'upstream_unavailable',
      message: 'temporarily unavailable',
    },
  })
  const cases = [
    {
      name: 'wrong-model',
      expected: /gateway_upstream_model_mismatch/,
      body: chunk({
        id: 'chat-owner', model: 'alien-model',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      }),
    },
    {
      name: 'changed-id',
      expected: /gateway_chat_response_id_changed/,
      body: chunk({
        id: 'chat-owner', model: 'chat-model',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      }) + chunk({
        id: 'chat-alien', model: 'chat-model',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      }),
    },
    {
      name: 'bad-role',
      expected: /gateway_chat_role_invalid/,
      body: chunk({
        id: 'chat-owner', model: 'chat-model',
        choices: [{ index: 0, delta: { role: 'user' }, finish_reason: null }],
      }),
    },
    {
      name: 'bad-index',
      expected: /gateway_chat_choice_index_invalid/,
      body: chunk({
        id: 'chat-owner', model: 'chat-model',
        choices: [{ index: 1, delta: { role: 'assistant' }, finish_reason: null }],
      }),
    },
  ]
  for (const fixture of cases) {
    let calls = 0
    const upstream = createServer((_request, response) => {
      calls += 1
      if (calls > 1) {
        chatSuccess(response)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
      response.end(fixture.body + transientError)
    })
    await withGateway({
      wireApi: 'chat/completions',
      upstream,
      async run(url, body) {
        const result = await callGateway(url, body)
        assert.equal(result.status, 200)
        assert.match(await result.text(), fixture.expected)
      },
    })
    assert.equal(calls, 1, fixture.name)
  }
})

test('the seventh pre-output stream failure exhausts without an eighth request', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    transientChatFailureAfterNeutralPrefix(response)
  })
  await withGateway({
    wireApi: 'chat/completions',
    upstream,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 502)
      assert.match(await result.text(), /gateway_upstream_retry_exhausted/)
    },
  })
  assert.equal(calls, 7)
})

test('accepted text prevents replay after a later stream disconnect', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
    response.end(`data: ${JSON.stringify({
      id: 'chat-partial',
      model: 'chat-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'visible' }, finish_reason: null }],
    })}\n\n`)
  })
  await withGateway({
    wireApi: 'chat/completions',
    upstream,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 200)
      const output = await result.text()
      assert.match(output, /visible/)
      assert.match(output, /gateway_chat_done_missing/)
    },
  })
  assert.equal(calls, 1)
})

test('structured Chat content is semantic output and prevents replay', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
    response.end([
      `data: ${JSON.stringify({
        id: 'chat-structured-content',
        model: 'chat-model',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: [{ type: 'text', text: 'visible' }] },
          finish_reason: null,
        }],
      })}`,
      `data: ${JSON.stringify({
        error: { code: 'server_error', type: 'upstream_unavailable', message: 'temporarily unavailable' },
      })}`,
      '',
    ].join('\n\n'))
  })
  await withGateway({
    wireApi: 'chat/completions',
    upstream,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 200)
      await result.text()
    },
  })
  assert.equal(calls, 1)
})

test('reasoning summary before a transient Chat error prevents replay', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
    response.end([
      `data: ${JSON.stringify({
        id: 'chat-reasoning-partial',
        model: 'chat-model',
        choices: [{
          index: 0,
          delta: { role: 'assistant', reasoning_summary: 'already started' },
          finish_reason: null,
        }],
      })}`,
      `data: ${JSON.stringify({
        error: {
          code: 'server_error',
          type: 'upstream_unavailable',
          message: 'temporarily unavailable',
        },
      })}`,
      '',
    ].join('\n\n'))
  })
  await withGateway({
    wireApi: 'chat/completions',
    upstream,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 200)
      const output = await result.text()
      assert.match(output, /already started/)
      assert.match(output, /temporarily unavailable/)
    },
  })
  assert.equal(calls, 1)
})

test('native output embedded in an initial event prevents replay', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
    response.end([
      `event: response.created\ndata: ${JSON.stringify({
        type: 'response.created',
        response: {
          id: 'native-semantic-created',
          model: 'native-model',
          status: 'in_progress',
          output: [{ type: 'function_call', call_id: 'call-1', name: 'unsafe', arguments: '{}' }],
        },
      })}`,
      `event: response.failed\ndata: ${JSON.stringify({
        type: 'response.failed',
        response: {
          id: 'native-semantic-created',
          model: 'native-model',
          status: 'failed',
          output: [],
          error: { code: 'server_error', type: 'upstream_unavailable', message: 'temporarily unavailable' },
        },
      })}`,
      '',
    ].join('\n\n'))
  })
  await withGateway({
    wireApi: 'responses',
    upstream,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 200)
      await result.text()
    },
  })
  assert.equal(calls, 1)
})

test('in-band authentication and malformed mixed errors never retry', async () => {
  for (const errorPayload of [
    {
      error: { code: 'invalid_api_key', type: 'authentication_error', message: 'unauthorized' },
    },
    {
      error: { status: 503, code: 'invalid_api_key', message: 'unauthorized' },
    },
    {
      error: { status: 408, code: 'invalid_request', message: 'invalid parameter' },
    },
    {
      model: 'chat-model',
      choices: [],
      error: { code: 'server_error', type: 'upstream_unavailable', message: 'temporarily unavailable' },
    },
    {
      error: { code: 'server_error', type: 'upstream_unavailable', message: 'temporarily unavailable' },
      unexpected: true,
    },
  ]) {
    let calls = 0
    const upstream = createServer((_request, response) => {
      calls += 1
      response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
      response.end(`data: ${JSON.stringify(errorPayload)}\n\n`)
    })
    await withGateway({
      wireApi: 'chat/completions',
      upstream,
      async run(url, body) {
        const result = await callGateway(url, body)
        assert.equal(result.status, 200)
        assert.match(await result.text(), /response\.failed/)
      },
    })
    assert.equal(calls, 1)
  }
})

test('a neutral Chat prefix never turns an authentication error into a retry', async () => {
  let calls = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
    response.end([
      `data: ${JSON.stringify({
        id: 'chat-auth-prefix',
        model: 'chat-model',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}`,
      `data: ${JSON.stringify({
        error: {
          code: 'invalid_api_key',
          type: 'authentication_error',
          message: 'unauthorized',
        },
      })}`,
      '',
    ].join('\n\n'))
  })
  await withGateway({
    wireApi: 'chat/completions',
    upstream,
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 200)
      const output = await result.text()
      assert.match(output, /invalid_api_key/)
      assert.doesNotMatch(output, /recovered/)
    },
  })
  assert.equal(calls, 1)
})

test('a proposed tool call prevents replay and never reaches action admission after failure', async () => {
  let calls = 0
  let admissions = 0
  const upstream = createServer((_request, response) => {
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '0' })
    response.end([
      `data: ${JSON.stringify({
        id: 'chat-tool-partial',
        model: 'chat-model',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call-partial',
              type: 'function',
              function: { name: 'not-authorized', arguments: '{}' },
            }],
          },
          finish_reason: null,
        }],
      })}`,
      `data: ${JSON.stringify({
        error: { code: 'server_error', type: 'upstream_unavailable', message: 'temporarily unavailable' },
      })}`,
      '',
    ].join('\n\n'))
  })
  await withGateway({
    wireApi: 'chat/completions',
    upstream,
    admitToolResponse: () => { admissions += 1 },
    async run(url, body) {
      const result = await callGateway(url, body)
      assert.equal(result.status, 200)
      assert.match(await result.text(), /server_error/)
    },
  })
  assert.equal(calls, 1)
  assert.equal(admissions, 0)
})
