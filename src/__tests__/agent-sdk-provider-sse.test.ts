/**
 * P0-0 (2026-07-02 provider true SSE contract) — focused behavior tests.
 *
 * Covers the completion criteria of
 * docs/superpowers/plans/2026-07-02-p0-0-provider-true-sse-streaming-implementation.md:
 * incremental text deltas before response_done, tool-call fragment
 * accumulation, reasoning kept out of the visible stream, the three-rung
 * degrade ladder (non-SSE JSON / pre-delta 4xx retry / 5xx bubble), abort
 * and idle-stall semantics, the READY_SDK_TRUE_SSE=off kill switch, and
 * vllm patch-profile composition on streaming bodies.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ReadyAnthropicModel,
  ReadyOpenAICompatibleModel,
  resolveTrueSseMode,
} from '../main/modules/agent-control/runtime-core/agent-sdk-provider'
import {
  parseSseStream,
} from '../main/modules/agent-control/runtime-core/provider-sse'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent,
} from '../main/modules/agent-control/metrics'
import type { AIModelConfig } from '../shared/ai-providers'

type FetchLike = NonNullable<ConstructorParameters<typeof ReadyOpenAICompatibleModel>[0]['fetchWithTimeout']>

interface CapturedRequest {
  url: string
  body: Record<string, unknown>
}

const encoder = new TextEncoder()

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

function sseResponse(chunks: string[]): Response {
  return new Response(sseBody(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeQueuedFetch(responses: Array<Response | (() => Response)>): {
  fetch: FetchLike
  captured: CapturedRequest[]
} {
  const captured: CapturedRequest[] = []
  const queue = [...responses]
  const fetch = (async (url: string, init: RequestInit) => {
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>
    } catch {
      // Keep {} — assertions fail with useful diagnostics instead.
    }
    captured.push({ url, body })
    const next = queue.shift()
    if (!next) throw new Error('fake fetch queue exhausted')
    return typeof next === 'function' ? next() : next
  }) as FetchLike
  return { fetch, captured }
}

function makeConfig(overrides: Record<string, unknown> = {}): AIModelConfig {
  return {
    provider: 'openai-compatible',
    model: 'test-model',
    apiKey: 'sk-test',
    baseUrl: 'https://example.invalid',
    ...overrides,
  } as unknown as AIModelConfig
}

function makeRequest(signal?: AbortSignal): never {
  return {
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    systemInstructions: 'system test',
    tools: [],
    modelSettings: { maxTokens: 256 },
    signal: signal ?? new AbortController().signal,
  } as never
}

async function collect(stream: AsyncIterable<unknown>): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = []
  for await (const event of stream) events.push(event as Record<string, unknown>)
  return events
}

function textDeltas(events: Array<Record<string, unknown>>): string[] {
  return events
    .filter((event) => event.type === 'output_text_delta')
    .map((event) => String(event.delta))
}

function captureMetrics(): { metrics: AgentMetricEvent[]; restore: () => void } {
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => { metrics.push(event) })
  return { metrics, restore: () => __setMetricSinkForTests(null) }
}

const dataLine = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`

// ============================================================================
// provider-sse pure layer
// ============================================================================

test('provider-sse: splits blocks across chunk boundaries, joins multi-line data, ignores comments', async () => {
  const chunks = [
    'event: message_start\ndata: {"a"', // data line split across chunks
    ':1}\n\n: keep-alive\n\n',
    'data: line1\ndata: line2\n\n',
    'data: [DONE]\n\n',
  ]
  const events: Array<{ event: string; data: string }> = []
  for await (const event of parseSseStream(sseBody(chunks))) events.push(event)
  assert.deepEqual(events, [
    { event: 'message_start', data: '{"a":1}' },
    { event: '', data: 'line1\nline2' },
    { event: '', data: '[DONE]' },
  ])
})

test('provider-sse: trailing block without final blank line still flushes at EOF', async () => {
  const events: Array<{ event: string; data: string }> = []
  for await (const event of parseSseStream(sseBody(['data: {"x":1}']))) events.push(event)
  assert.deepEqual(events, [{ event: '', data: '{"x":1}' }])
})

test('provider-sse: idle stall raises a structured timeout error', async () => {
  const stalled = new ReadableStream<Uint8Array>({ start() { /* never enqueues, never closes */ } })
  await assert.rejects(async () => {
    for await (const event of parseSseStream(stalled, { idleTimeoutMs: 30, label: 'idle-test' })) {
      void event
    }
  }, /空闲超时/)
})

test('provider-sse: mid-stream abort throws the abort reason and stops iteration', async () => {
  const controller = new AbortController()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode('data: {"n":1}\n\n'))
      // stream stays open; abort must be what ends it
    },
  })
  const events: unknown[] = []
  await assert.rejects(async () => {
    for await (const event of parseSseStream(body, { signal: controller.signal })) {
      events.push(event)
      controller.abort(new Error('user cancelled'))
    }
  }, /user cancelled/)
  assert.equal(events.length, 1)
})

// ============================================================================
// OpenAI chat-completions streaming
// ============================================================================

test('SDK chat stream: incremental deltas, interleaved tool-call fragments, reasoning kept silent, usage from final chunk', async () => {
  const chunks = [
    dataLine({ id: 'chatcmpl-1', choices: [{ delta: { content: '你' } }] }),
    dataLine({ choices: [{ delta: { content: '好' } }] }),
    dataLine({ choices: [{ delta: { reasoning_content: '思考片段A' } }] }),
    dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'brow', arguments: '{"u' } }] } }] }),
    dataLine({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'read_page', arguments: '{}' } }] } }] }),
    dataLine({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'ser_click', arguments: 'rl":1}' } }] } }] }),
    dataLine({ choices: [{ delta: { content: '！' } }] }),
    dataLine({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }),
    'data: [DONE]\n\n',
  ]
  const { fetch, captured } = makeQueuedFetch([sseResponse(chunks)])
  const model = new ReadyOpenAICompatibleModel({
    config: makeConfig(),
    baseUrl: 'https://example.invalid',
    fetchWithTimeout: fetch,
  })
  const events = await collect(model.getStreamedResponse(makeRequest()))

  // ≥2 incremental deltas BEFORE the terminal event; reasoning never streamed.
  assert.deepEqual(textDeltas(events), ['你', '好', '！'])
  const done = events[events.length - 1] as { type: string; response: { usage: Record<string, number>; output: unknown[] } }
  assert.equal(done.type, 'response_done')
  assert.ok(events.slice(0, -1).every((event) => event.type === 'output_text_delta'))

  // streamed request carried the stream flags
  assert.equal(captured[0].body.stream, true)
  assert.deepEqual(captured[0].body.stream_options, { include_usage: true })

  const output = done.response.output as Array<Record<string, unknown>>
  const message = output.find((item) => item.type === 'message') as Record<string, unknown>
  const messageText = JSON.stringify(message)
  assert.ok(messageText.includes('你好！'), `message should carry joined text: ${messageText}`)
  assert.ok(messageText.includes('思考片段A'), 'reasoning must survive into providerData for parity')

  const serializedCalls = JSON.stringify(output.filter((item) => item.type !== 'message'))
  assert.ok(serializedCalls.includes('browser_click'), `tool name fragments must concatenate: ${serializedCalls}`)
  assert.ok(serializedCalls.includes('read_page'))
  assert.ok(serializedCalls.includes('{\\"url\\":1}'), `tool arguments fragments must concatenate: ${serializedCalls}`)

  assert.equal(done.response.usage.inputTokens, 11)
  assert.equal(done.response.usage.outputTokens, 5)
  assert.equal(done.response.usage.totalTokens, 16)
})

test('SDK chat stream: vllm patch profile composes on the streaming body (include_usage + stream_usage)', async () => {
  const { fetch, captured } = makeQueuedFetch([sseResponse(['data: [DONE]\n\n'])])
  const model = new ReadyOpenAICompatibleModel({
    config: makeConfig({ model: 'qwen-test', baseUrl: 'https://vllm.example/v1' }),
    baseUrl: 'https://vllm.example/v1',
    fetchWithTimeout: fetch,
  })
  await collect(model.getStreamedResponse(makeRequest()))
  assert.equal(captured[0].body.stream, true)
  assert.equal((captured[0].body.stream_options as Record<string, unknown>).include_usage, true)
  assert.equal(captured[0].body.stream_usage, true)
})

test('SDK chat stream: JSON body despite stream:true degrades to pseudo stream with fallback metric', async () => {
  const completion = {
    id: 'chatcmpl-json',
    choices: [{
      message: {
        content: '整包文本',
        tool_calls: [{ id: 'call_j', type: 'function', function: { name: 'noop_tool', arguments: '{}' } }],
      },
    }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  }
  const { metrics, restore } = captureMetrics()
  try {
    const { fetch } = makeQueuedFetch([jsonResponse(completion)])
    const model = new ReadyOpenAICompatibleModel({
      config: makeConfig(),
      baseUrl: 'https://example.invalid',
      fetchWithTimeout: fetch,
    })
    const events = await collect(model.getStreamedResponse(makeRequest()))
    assert.deepEqual(textDeltas(events), ['整包文本'])
    const done = events[events.length - 1] as { type: string; response: { usage: Record<string, number>; output: unknown[] } }
    assert.equal(done.type, 'response_done')
    assert.equal(done.response.usage.totalTokens, 7)
    assert.ok(JSON.stringify(done.response.output).includes('noop_tool'))
    assert.ok(metrics.some((m) => m.metric === 'provider_stream_fallback' && m.reason === 'non_sse_response'))
  } finally {
    restore()
  }
})

test('SDK chat stream: pre-delta 4xx retries exactly once via the blocking path', async () => {
  const completion = { id: 'x', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
  const { metrics, restore } = captureMetrics()
  try {
    const { fetch, captured } = makeQueuedFetch([
      new Response('stream not supported', { status: 400 }),
      jsonResponse(completion),
    ])
    const model = new ReadyOpenAICompatibleModel({
      config: makeConfig(),
      baseUrl: 'https://example.invalid',
      fetchWithTimeout: fetch,
    })
    const events = await collect(model.getStreamedResponse(makeRequest()))
    assert.equal(captured.length, 2)
    assert.equal(captured[0].body.stream, true)
    assert.equal(captured[1].body.stream, undefined)
    assert.deepEqual(textDeltas(events), ['ok'])
    assert.equal((events[events.length - 1] as { type: string }).type, 'response_done')
    assert.ok(metrics.some((m) => m.metric === 'provider_stream_fallback' && m.reason === 'stream_request_rejected'))
  } finally {
    restore()
  }
})

test('SDK chat stream: semantic 4xx (413 overflow) bubbles without blocking retry', async () => {
  const { fetch, captured } = makeQueuedFetch([
    new Response(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'prompt is too long' } }), { status: 413 }),
  ])
  const model = new ReadyOpenAICompatibleModel({
    config: makeConfig(),
    baseUrl: 'https://example.invalid',
    fetchWithTimeout: fetch,
  })
  // 413 must reach the orchestrator's overflow classifier untouched —
  // swallowing it here would break the compaction-retry chain.
  await assert.rejects(collect(model.getStreamedResponse(makeRequest())), /too long|413/)
  assert.equal(captured.length, 1)
})

test('SDK chat stream: 400 without any stream mention bubbles (rung-2 scope guard)', async () => {
  const { fetch, captured } = makeQueuedFetch([new Response('invalid model id', { status: 400 })])
  const model = new ReadyOpenAICompatibleModel({
    config: makeConfig(),
    baseUrl: 'https://example.invalid',
    fetchWithTimeout: fetch,
  })
  await assert.rejects(collect(model.getStreamedResponse(makeRequest())))
  assert.equal(captured.length, 1)
})

test('SDK chat stream: 5xx does not retry — provider http error bubbles', async () => {
  const { fetch, captured } = makeQueuedFetch([new Response('boom', { status: 500 })])
  const model = new ReadyOpenAICompatibleModel({
    config: makeConfig(),
    baseUrl: 'https://example.invalid',
    fetchWithTimeout: fetch,
  })
  await assert.rejects(collect(model.getStreamedResponse(makeRequest())))
  assert.equal(captured.length, 1)
})

test('READY_SDK_TRUE_SSE=off: chat reverts to blocking pseudo stream (no stream flag on the wire)', async () => {
  process.env.READY_SDK_TRUE_SSE = 'off'
  try {
    assert.equal(resolveTrueSseMode(), 'off')
    const completion = { id: 'x', choices: [{ message: { content: '一整段' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
    const { fetch, captured } = makeQueuedFetch([jsonResponse(completion)])
    const model = new ReadyOpenAICompatibleModel({
      config: makeConfig(),
      baseUrl: 'https://example.invalid',
      fetchWithTimeout: fetch,
    })
    const events = await collect(model.getStreamedResponse(makeRequest()))
    assert.equal(captured.length, 1)
    assert.equal(captured[0].body.stream, undefined)
    assert.deepEqual(textDeltas(events), ['一整段'])
    assert.equal((events[events.length - 1] as { type: string }).type, 'response_done')
  } finally {
    delete process.env.READY_SDK_TRUE_SSE
  }
})

// ============================================================================
// OpenAI responses streaming
// ============================================================================

test('SDK responses stream: output_text deltas + completed payload carries tool calls', async () => {
  const completedResponse = {
    id: 'resp_1',
    output: [
      { type: 'message', content: [{ type: 'output_text', text: '早安！' }] },
      { type: 'function_call', name: 'browser_read_page', call_id: 'fc_1', arguments: '{"tab":"t1"}' },
    ],
    usage: { input_tokens: 6, output_tokens: 8, total_tokens: 14 },
  }
  const chunks = [
    `event: response.created\n${dataLine({ type: 'response.created', response: { id: 'resp_1' } })}`,
    `event: response.output_text.delta\n${dataLine({ type: 'response.output_text.delta', delta: '早' })}`,
    `event: response.output_text.delta\n${dataLine({ type: 'response.output_text.delta', delta: '安！' })}`,
    `event: response.completed\n${dataLine({ type: 'response.completed', response: completedResponse })}`,
  ]
  const { fetch, captured } = makeQueuedFetch([sseResponse(chunks)])
  const model = new ReadyOpenAICompatibleModel({
    config: makeConfig({ wireApi: 'responses' }),
    baseUrl: 'https://example.invalid',
    fetchWithTimeout: fetch,
  })
  const events = await collect(model.getStreamedResponse(makeRequest()))
  assert.ok(captured[0].url.endsWith('/responses'))
  assert.equal(captured[0].body.stream, true)
  assert.deepEqual(textDeltas(events), ['早', '安！'])
  const done = events[events.length - 1] as { type: string; response: { usage: Record<string, number>; output: unknown[] } }
  assert.equal(done.type, 'response_done')
  assert.equal(done.response.usage.totalTokens, 14)
  const serialized = JSON.stringify(done.response.output)
  assert.ok(serialized.includes('早安！'))
  assert.ok(serialized.includes('browser_read_page'))
})

test('SDK responses stream: delta-only stream without terminal payload fails loud (stream_incomplete)', async () => {
  const chunks = [
    `event: response.output_text.delta\n${dataLine({ type: 'response.output_text.delta', delta: '半' })}`,
  ]
  const { fetch } = makeQueuedFetch([sseResponse(chunks)])
  const model = new ReadyOpenAICompatibleModel({
    config: makeConfig({ wireApi: 'responses' }),
    baseUrl: 'https://example.invalid',
    fetchWithTimeout: fetch,
  })
  await assert.rejects(collect(model.getStreamedResponse(makeRequest())), /stream_incomplete/)
})

// ============================================================================
// Anthropic messages streaming
// ============================================================================

test('SDK anthropic stream: text deltas live, tool_use input joins, thinking stays silent, usage merges', async () => {
  const chunks = [
    `event: message_start\n${dataLine({ type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 7 } } })}`,
    `event: content_block_start\n${dataLine({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })}`,
    `event: content_block_delta\n${dataLine({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '内部推理' } })}`,
    `event: content_block_stop\n${dataLine({ type: 'content_block_stop', index: 0 })}`,
    `event: content_block_start\n${dataLine({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })}`,
    `event: content_block_delta\n${dataLine({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '早' } })}`,
    `event: content_block_delta\n${dataLine({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '安' } })}`,
    `event: content_block_stop\n${dataLine({ type: 'content_block_stop', index: 1 })}`,
    `event: content_block_start\n${dataLine({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'browser_click', input: {} } })}`,
    `event: content_block_delta\n${dataLine({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"se' } })}`,
    `event: content_block_delta\n${dataLine({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'l":"#a"}' } })}`,
    `event: content_block_stop\n${dataLine({ type: 'content_block_stop', index: 2 })}`,
    `event: message_delta\n${dataLine({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } })}`,
    `event: message_stop\n${dataLine({ type: 'message_stop' })}`,
  ]
  const { fetch, captured } = makeQueuedFetch([sseResponse(chunks)])
  const model = new ReadyAnthropicModel({
    config: makeConfig(),
    baseUrl: 'https://example.invalid',
    fetchWithTimeout: fetch,
  })
  const events = await collect(model.getStreamedResponse(makeRequest()))
  assert.ok(captured[0].url.endsWith('/v1/messages'))
  assert.equal(captured[0].body.stream, true)
  assert.deepEqual(textDeltas(events), ['早', '安'])
  const done = events[events.length - 1] as { type: string; response: { usage: Record<string, number>; output: unknown[] } }
  assert.equal(done.type, 'response_done')
  assert.equal(done.response.usage.inputTokens, 7)
  assert.equal(done.response.usage.outputTokens, 9)
  const serialized = JSON.stringify(done.response.output)
  assert.ok(serialized.includes('早安'))
  assert.ok(serialized.includes('browser_click'))
  assert.ok(serialized.includes('sel'), `tool_use input JSON must join and parse: ${serialized}`)
  assert.ok(!textDeltas(events).some((delta) => delta.includes('内部推理')), 'thinking must never stream as visible text')
})

test('SDK anthropic stream: mid-stream abort stops iteration without a terminal event', async () => {
  const controller = new AbortController()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode(`event: message_start\n${dataLine({ type: 'message_start', message: { id: 'm' } })}`))
      c.enqueue(encoder.encode(`event: content_block_start\n${dataLine({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`))
      c.enqueue(encoder.encode(`event: content_block_delta\n${dataLine({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '部' } })}`))
      // stream intentionally left open — abort must end it
    },
  })
  const { fetch } = makeQueuedFetch([
    new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  ])
  const model = new ReadyAnthropicModel({
    config: makeConfig(),
    baseUrl: 'https://example.invalid',
    fetchWithTimeout: fetch,
  })
  const events: Array<Record<string, unknown>> = []
  await assert.rejects(async () => {
    for await (const event of model.getStreamedResponse(makeRequest(controller.signal))) {
      events.push(event as Record<string, unknown>)
      controller.abort(new Error('stop now'))
    }
  }, /stop now/)
  assert.equal(events.length, 1)
  assert.ok(events.every((event) => event.type !== 'response_done'))
})
