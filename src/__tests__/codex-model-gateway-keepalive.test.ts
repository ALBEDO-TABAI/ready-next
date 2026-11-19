import assert from 'node:assert/strict'
import { createServer, type Server, type ServerResponse } from 'node:http'
import test from 'node:test'

import {
  createCodexUpstreamProfileSnapshot,
  digestCanonicalJson,
  instructionTranscriptDigest,
} from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { CodexModelGateway, type CodexModelGatewayBinding } from '../main/modules/agent-control/codex-runtime/codex-model-gateway'
import { codexTurnStateHeader } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-request'

// Codex drops a stream after its SSE idle timeout even while the gateway still reads upstream; the pinned
// runtime counts an unknown `ready.keepalive` event as activity (codex-gateway-wire.e2e.ts).

const tools = [{ type: 'function', name: 'ready_read_probe', description: 'read', parameters: { type: 'object' } }]
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const send = (response: ServerResponse, payload: Record<string, unknown>) => (
  response.write(`event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`)
)

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

async function runGateway(
  wireApi: 'responses' | 'chat/completions',
  upstreamBody: (response: ServerResponse) => Promise<void>,
  eventIdleMs?: number,
): Promise<{ events: Array<Record<string, unknown>>; admitted: number }> {
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    await upstreamBody(response)
    response.end()
  })
  const port = await listen(upstream)
  const created = createCodexUpstreamProfileSnapshot({
    profileId: 'profile-keepalive',
    config: {
      provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'upstream-secret',
      model: 'upstream-model', agentProtocol: 'openai', wireApi, toolUseMode: 'on',
    },
    maxRetries: 0,
  })
  const metadata = {
    installation_id: 'installation-keepalive', session_id: 'thread-keepalive', request_kind: 'turn',
    thread_id: 'thread-keepalive', turn_id: 'turn-keepalive', root_turn_id: 'turn-keepalive',
    window_id: 'thread-keepalive:0', agent_name: '/root', auto_review_enabled: false,
    node_repl_auto_review_required: false, node_repl_disabled: false, sandbox: process.platform === 'win32' ? 'windows_sandbox' : 'seatbelt',
    sandbox_mode: 'read-only', turn_started_at_unix_ms: 1, window_number: 0, context_window_id: 'context-window-1',
        analytics_enabled: false, model: 'ready-e0-model', readyRunId: 'run-keepalive',
    toolSurfaceDigest: digestCanonicalJson(tools), turnContractDigest: 'turn-contract-1',
    upstreamProfileSnapshotDigest: created.snapshotDigest,
  }
  const request = {
    model: 'ready-e0-model', instructions: 'fixed instructions',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'write the long document' }] }],
    tools, tool_choice: 'auto', parallel_tool_calls: false, reasoning: { summary: 'auto' },
    include: ['reasoning.encrypted_content'], prompt_cache_key: 'thread-keepalive', store: false, stream: true,
    client_metadata: {
      'x-codex-installation-id': 'installation-keepalive', session_id: 'thread-keepalive',
      'x-codex-window-id': 'thread-keepalive:0', turn_id: 'turn-keepalive', thread_id: 'thread-keepalive',
      root_turn_id: 'turn-keepalive', 'x-codex-turn-metadata': JSON.stringify(metadata),
    },
  }
  const binding: CodexModelGatewayBinding = {
    kind: 'product', codexModel: 'ready-e0-model', snapshot: created.snapshot, snapshotDigest: created.snapshotDigest,
    toolSurfaceDigest: metadata.toolSurfaceDigest, turnContractDigest: 'turn-contract-1',
    requestToolsDigest: metadata.toolSurfaceDigest,
    instructionContractDigest: instructionTranscriptDigest(request.instructions, request.input),
    additionalContextDigest: digestCanonicalJson([]), deliveredUserTail: [], forceToolFreeFinalization: false,
    allowedToolNames: ['ready_read_probe'],
  }
  let admitted = 0
  const gateway = new CodexModelGateway({
    bearerToken: 'local-capability-token',
    downstreamKeepaliveMs: 40,
    eventIdleMs,
    authority: {
      async resolve(input) { input.validate(binding); return binding },
      async admitToolResponse() { admitted += 1 },
    },
    credentials: { resolve() { return 'upstream-secret' } },
  })
  const address = await gateway.start()
  try {
    const response = await fetch(`${address.url}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer local-capability-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    assert.equal(response.status, 200)
    const events = (await response.text()).split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)
    return { events, admitted }
  } finally {
    await gateway.stop()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
}

const call = { type: 'function_call', id: 'tool-1', call_id: 'call-1', name: 'ready_read_probe' }
const argumentParts = ['{"query":"', 'chapter one, ', 'chapter two, ', 'chapter three, ', 'chapter four', '"}']

async function nativeToolCall(response: ServerResponse, gapMs: number, stallMs = 0): Promise<void> {
  send(response, { type: 'response.created', response: { id: 'response-1', model: 'upstream-model', status: 'in_progress', output: [] } })
  send(response, { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } })
  await sleep(stallMs)
  for (const delta of argumentParts) {
    await sleep(gapMs)
    send(response, { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'tool-1', delta })
  }
  const done = { ...call, arguments: argumentParts.join(''), status: 'completed' }
  send(response, { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'tool-1', arguments: done.arguments })
  send(response, { type: 'response.output_item.done', output_index: 0, item: done })
  send(response, { type: 'response.completed', response: {
    id: 'response-1', model: 'upstream-model', status: 'completed', output: [done],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
  } })
}

test('a held native tool call keeps Codex\'s stream alive while upstream keeps writing it', async () => {
  const { events, admitted } = await runGateway('responses', (response) => nativeToolCall(response, 30))
  const types = events.map((event) => event.type)
  const firstToolEvent = types.indexOf('response.output_item.added')
  assert.ok(types.filter((type) => type === 'ready.keepalive').length >= 2, types.join(','))
  assert.ok(types.lastIndexOf('ready.keepalive') < firstToolEvent, 'liveness while the call is held, the call itself after validation')
  assert.deepEqual(types.slice(firstToolEvent), [
    'response.output_item.added', 'response.function_call_arguments.delta', 'response.function_call_arguments.done',
    'response.output_item.done', 'response.completed',
  ])
  assert.equal(admitted, 1)
})

test('a stalled upstream gets no keepalive, so the gateway\'s idle policy still ends it', async () => {
  const { events, admitted } = await runGateway('responses', (response) => nativeToolCall(response, 0, 600), 150)
  assert.equal(events.filter((event) => event.type === 'ready.keepalive').length, 0)
  assert.equal(events.at(-1)?.type, 'response.failed')
  assert.equal(admitted, 0)
})

test('a chat tool call that is still being written keeps Codex\'s stream alive', async () => {
  const { events, admitted } = await runGateway('chat/completions', async (response) => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, unknown>) => response.write(
      `data: ${JSON.stringify({ id: 'chat-1', model: 'upstream-model', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`,
    )
    chunk({ role: 'assistant', content: 'Writing it now.' })
    chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'ready_read_probe', arguments: '' } }] })
    for (const part of argumentParts) {
      await sleep(30)
      chunk({ tool_calls: [{ index: 0, function: { arguments: part } }] })
    }
    chunk({}, 'tool_calls', { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 })
    response.write('data: [DONE]\n\n')
  })
  const types = events.map((event) => event.type)
  const toolAdded = events.findIndex((event) => event.type === 'response.output_item.added'
    && (event.item as Record<string, unknown>).type === 'function_call')
  assert.ok(types.filter((type) => type === 'ready.keepalive').length >= 2, types.join(','))
  assert.ok(types.lastIndexOf('ready.keepalive') < toolAdded)
  assert.equal(types.at(-1), 'response.completed')
  assert.equal(admitted, 1)
})

test('only an opaque routing token passes as the Codex turn state', () => {
  assert.equal(codexTurnStateHeader('gAAAAABoX-y_9z=='), 'gAAAAABoX-y_9z==')
  for (const value of ['', 'two words', 'line\nbreak', 'x'.repeat(8193), ['a', 'b'], undefined]) {
    assert.equal(codexTurnStateHeader(value), null, JSON.stringify(value))
  }
})
