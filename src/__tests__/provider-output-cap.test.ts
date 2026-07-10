import assert from 'node:assert/strict'
import test from 'node:test'

import { MemorySession } from '@openai/agents'
import {
  ReadyAnthropicModel,
  ReadyOpenAICompatibleModel
} from '../main/modules/agent-control/runtime-core/agent-sdk-provider'
import { createReadyAgentForRun } from '../main/modules/agent-control/runtime-core/agent-sdk-provider-runner'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent
} from '../main/modules/agent-control/metrics'
import { resolveMaxOutputTokens, type AIModelConfig } from '../shared/ai-providers'

type FetchLike = NonNullable<
  ConstructorParameters<typeof ReadyAnthropicModel>[0]['fetchWithTimeout']
>

function makeRequest(maxTokens?: number): never {
  return {
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    systemInstructions: 'system',
    tools: [],
    modelSettings: maxTokens === undefined ? {} : { maxTokens },
    signal: new AbortController().signal
  } as never
}

function config(model: string, overrides: Partial<AIModelConfig> = {}): AIModelConfig {
  return {
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test',
    model,
    ...overrides
  }
}

function sseResponse(stopReason: string): Response {
  const encoder = new TextEncoder()
  const body = [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg-1', usage: { input_tokens: 3 } } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 2 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`
  ]
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of body) controller.enqueue(encoder.encode(chunk))
        controller.close()
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}

function captureFetch(response: () => Response): {
  fetch: FetchLike
  bodies: Array<Record<string, unknown>>
} {
  const bodies: Array<Record<string, unknown>> = []
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body || '{}')) as Record<string, unknown>)
    return response()
  }) as FetchLike
  return { fetch, bodies }
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    /* drain */
  }
}

test('resolveMaxOutputTokens uses override, catalog, safe Anthropic fallback, then generic fallback', () => {
  assert.equal(resolveMaxOutputTokens(config('claude-opus-4-20250514')), 32000)
  assert.equal(resolveMaxOutputTokens(config('claude-sonnet-4-20250514')), 64000)
  assert.equal(resolveMaxOutputTokens(config('claude-haiku-3-5-20241022')), 8192)
  assert.equal(resolveMaxOutputTokens(config('unknown-model')), 4096)
  assert.equal(
    resolveMaxOutputTokens({
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test',
      model: 'unknown-model'
    }),
    8192
  )
  assert.equal(
    resolveMaxOutputTokens(config('claude-opus-4-20250514', { maxOutputTokensOverride: 12345 })),
    12345
  )
  assert.equal(
    resolveMaxOutputTokens(
      config('claude-opus-4-20250514', { maxOutputTokensOverride: 2_000_000 })
    ),
    1_000_000
  )
})

test('native OpenAI Agent receives the same resolved output cap', () => {
  const agent = createReadyAgentForRun({
    agentName: 'butler',
    runId: 'run-native-cap',
    taskId: 'task-native-cap',
    input: 'hello',
    instructions: 'system',
    model: 'gpt-test',
    provider: {} as never,
    session: new MemorySession(),
    tools: [],
    signal: new AbortController().signal,
    maxTurns: 1,
    contextWindowTokens: 200_000,
    maxOutputTokens: 12_345,
    onTextDelta: () => undefined
  })
  assert.equal(agent.modelSettings.maxTokens, 12_345)
})

test('Anthropic true SSE sends the resolved model cap and explicit request cap wins', async () => {
  const cases: Array<[AIModelConfig, number | undefined, number]> = [
    [config('claude-opus-4-20250514'), undefined, 32000],
    [config('claude-sonnet-4-20250514'), undefined, 64000],
    [config('claude-haiku-3-5-20241022'), undefined, 8192],
    [config('unknown-model'), undefined, 4096],
    [config('claude-opus-4-20250514', { maxOutputTokensOverride: 12345 }), undefined, 12345],
    [config('claude-opus-4-20250514'), 256, 256]
  ]
  for (const [modelConfig, explicit, expected] of cases) {
    const captured = captureFetch(() => sseResponse('end_turn'))
    const model = new ReadyAnthropicModel({
      config: modelConfig,
      baseUrl: modelConfig.baseUrl,
      fetchWithTimeout: captured.fetch
    })
    await drain(model.getStreamedResponse(makeRequest(explicit)))
    assert.equal(captured.bodies[0].max_tokens, expected)
  }
})

test('Anthropic blocking uses the same resolved cap as true SSE', async () => {
  const captured = captureFetch(
    () =>
      new Response(
        JSON.stringify({
          id: 'msg-blocking',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
  )
  const modelConfig = config('claude-opus-4-20250514')
  const model = new ReadyAnthropicModel({
    config: modelConfig,
    baseUrl: modelConfig.baseUrl,
    fetchWithTimeout: captured.fetch
  })
  await model.getResponse(makeRequest())
  assert.equal(captured.bodies[0].max_tokens, 32000)
})

function chatSseResponse(): Response {
  const encoder = new TextEncoder()
  const body =
    `data: ${JSON.stringify({ id: 'chat-stream', choices: [{ delta: { content: 'ok' }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ id: 'chat-stream', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n` +
    'data: [DONE]\n\n'
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body))
        controller.close()
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}

function responsesSseResponse(): Response {
  const encoder = new TextEncoder()
  const body =
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n` +
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp-stream', status: 'completed', output: [] } })}\n\n`
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body))
        controller.close()
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}

test('OpenAI-compatible chat and responses send the same cap in blocking and streaming paths', async () => {
  const cases = [
    {
      wireApi: 'chat/completions' as const,
      stream: false,
      response: () =>
        new Response(
          JSON.stringify({
            id: 'chat',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
      key: 'max_tokens'
    },
    {
      wireApi: 'chat/completions' as const,
      stream: true,
      response: chatSseResponse,
      key: 'max_tokens'
    },
    {
      wireApi: 'responses' as const,
      stream: false,
      response: () =>
        new Response(JSON.stringify({ id: 'resp', status: 'completed', output: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }),
      key: 'max_output_tokens'
    },
    {
      wireApi: 'responses' as const,
      stream: true,
      response: responsesSseResponse,
      key: 'max_output_tokens'
    }
  ]
  for (const item of cases) {
    const captured = captureFetch(item.response)
    const modelConfig: AIModelConfig = {
      provider: 'openai-compatible',
      baseUrl: 'https://example.invalid',
      apiKey: 'x',
      model: 'unknown-model',
      wireApi: item.wireApi,
      maxOutputTokensOverride: 12_345
    }
    const model = new ReadyOpenAICompatibleModel({
      config: modelConfig,
      baseUrl: modelConfig.baseUrl,
      fetchWithTimeout: captured.fetch
    })
    if (item.stream) await drain(model.getStreamedResponse(makeRequest()))
    else await model.getResponse(makeRequest())
    assert.equal(captured.bodies[0][item.key], 12_345)
  }
})

test('all three response shapers emit provider_output_truncated only for length stops', async () => {
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const anthropicConfig = config('claude-opus-4-20250514')
    const anthropicFetch = captureFetch(() => sseResponse('max_tokens'))
    await drain(
      new ReadyAnthropicModel({
        config: anthropicConfig,
        baseUrl: anthropicConfig.baseUrl,
        fetchWithTimeout: anthropicFetch.fetch
      }).getStreamedResponse(makeRequest())
    )

    const chatFetch = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 'chat-1',
            choices: [
              { message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    await new ReadyOpenAICompatibleModel({
      config: {
        provider: 'openai-compatible',
        baseUrl: 'https://example.invalid',
        apiKey: 'x',
        model: 'chat-model',
        wireApi: 'chat/completions'
      },
      baseUrl: 'https://example.invalid',
      fetchWithTimeout: chatFetch.fetch
    }).getResponse(makeRequest())

    const responsesFetch = captureFetch(
      () =>
        new Response(
          JSON.stringify({
            id: 'resp-1',
            finish_reason: 'length',
            output: [],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    await new ReadyOpenAICompatibleModel({
      config: {
        provider: 'openai-compatible',
        baseUrl: 'https://example.invalid',
        apiKey: 'x',
        model: 'responses-model',
        wireApi: 'responses'
      },
      baseUrl: 'https://example.invalid',
      fetchWithTimeout: responsesFetch.fetch
    }).getResponse(makeRequest())

    const truncated = metrics.filter((event) => event.metric === 'provider_output_truncated')
    assert.deepEqual(
      truncated.map((event) => event.path),
      ['anthropic', 'chat', 'responses']
    )
    assert.deepEqual(
      truncated.map((event) => event.cap),
      [32000, 8192, 8192]
    )
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('non-length Anthropic stop does not emit truncation', async () => {
  const metrics: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => metrics.push(event))
  try {
    const modelConfig = config('claude-haiku-3-5-20241022')
    const captured = captureFetch(() => sseResponse('tool_use'))
    await drain(
      new ReadyAnthropicModel({
        config: modelConfig,
        baseUrl: modelConfig.baseUrl,
        fetchWithTimeout: captured.fetch
      }).getStreamedResponse(makeRequest())
    )
    assert.equal(metrics.filter((event) => event.metric === 'provider_output_truncated').length, 0)
  } finally {
    __setMetricSinkForTests(null)
  }
})
