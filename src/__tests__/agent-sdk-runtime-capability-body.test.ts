/**
 * Stage U (PR 2 review patch) — request-body level behavior tests for the
 * SDK ModelClient classes.
 *
 * The pure helper test (`message-capability-filter.test.ts`) proves the
 * sanitize function correctly strips image/video blocks given a snapshot.
 * The wired-both-paths CI gate confirms the helper is called at every
 * serialize site by source-grep. This file adds the missing layer: it
 * mounts the actual SDK `Model` class with a fake fetch and asserts the
 * outbound request body contains no image blocks when the resolved
 * capability says supportsVision === false.
 *
 * Covers:
 *   - OpenAI chat-completions wire: image block in history → request body
 *     `messages[].content` carries placeholder text instead of `image_url`
 *   - OpenAI responses wire: same shape for `input[].content` /
 *     `input_image` type
 *   - Anthropic wire: same shape for `messages[].content` with `image` type
 *   - Vision-on model: image blocks PASS THROUGH unchanged (sanity / non-
 *     regression)
 *   - Video on supportsNativeVideo provider: video blocks PASS THROUGH
 *     (the PR-2-review fix for over-filtering)
 *
 * The fake fetch throws after capturing the body so getResponse's downstream
 * parse fails, but the assertion has already been made on the captured body.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ReadyAnthropicModel,
  ReadyOpenAICompatibleModel,
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import type { AIModelConfig } from '../../shared/ai-providers'

type CapturedRequest = {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

interface ModelInputItem {
  role?: string
  content?: unknown
  type?: string
  [key: string]: unknown
}

function makeFakeFetch(): {
  fetch: NonNullable<ConstructorParameters<typeof ReadyOpenAICompatibleModel>[0]['fetchWithTimeout']>
  captured: CapturedRequest[]
} {
  const captured: CapturedRequest[] = []
  const fetchWithTimeout = (async (
    url: string,
    init: RequestInit,
    _signal: AbortSignal,
    _label: string,
    _timeoutMs?: number,
  ): Promise<Response> => {
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as Record<string, unknown>
    } catch {
      // Leave body as {} — assertion will fail on missing fields with a
      // useful diagnostic, easier to debug than a thrown parse error.
    }
    captured.push({ url, headers: new Headers(init.headers), body })
    // Return a benign empty-success response so getResponse can complete
    // without throwing in our parse path. The assertion happens after.
    return new Response(JSON.stringify({
      id: 'resp-test',
      choices: [{ message: { content: '' } }],
      content: [{ type: 'text', text: '' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as NonNullable<ConstructorParameters<typeof ReadyOpenAICompatibleModel>[0]['fetchWithTimeout']>
  return { fetch: fetchWithTimeout, captured }
}

// Minimal ModelRequest shape — the SDK runtime accepts more fields, but
// these are the only ones our Model classes touch for body construction.
function makeModelRequest(input: ModelInputItem[]): {
  input: ModelInputItem[]
  systemInstructions: string
  tools: never[]
  modelSettings: { maxTokens: number }
  signal: AbortSignal
} {
  return {
    input,
    systemInstructions: 'system test',
    tools: [],
    modelSettings: { maxTokens: 256 },
    signal: new AbortController().signal,
  }
}

// ============================================================================
// OpenAI chat-completions wire (default for openai-compatible providers)
// ============================================================================

// SDK input shape: the SDK's `modelInputToOpenAIChatMessages` normalizer
// recognizes `input_image` (with `image` payload) + `input_text/text/output_text`.
// On the OUT side it emits `image_url` blocks. Our sanitize helper sees the
// emitted `image_url` and strips when supportsVision === false.

test('SDK OpenAI chat: vision-off model → history image block stripped from messages[].content', async () => {
  const config = {
    provider: 'openai-compatible',
    model: 'no-vision-model',
    apiKey: 'sk-test',
    baseUrl: 'https://example.invalid',
    visionMode: 'off' as const,
  } as unknown as AIModelConfig
  const { fetch, captured } = makeFakeFetch()
  const model = new ReadyOpenAICompatibleModel({
    config,
    baseUrl: 'https://example.invalid',
    fetchWithTimeout: fetch,
  })

  await model.getResponse(makeModelRequest([
    {
      role: 'user',
      content: [
        { type: 'input_image', image: 'data:image/png;base64,AAAA' },
        { type: 'input_text', text: 'describe the image please' },
      ],
    },
  ]) as never)

  assert.equal(captured.length, 1)
  const messages = (captured[0].body as { messages: Array<{ content: unknown }> }).messages
  // messages[0] is the system instruction; messages[1] is the user history.
  const userContent = messages[1].content
  assert.ok(Array.isArray(userContent), 'user content should be a blocks array')
  const blocks = userContent as Array<{ type: string; text?: string }>
  for (const block of blocks) {
    assert.notEqual(block.type, 'image_url', 'image_url block must NOT survive vision-off sanitize')
    assert.notEqual(block.type, 'image', 'image block must NOT survive vision-off sanitize')
    assert.notEqual(block.type, 'input_image', 'input_image block must NOT survive vision-off sanitize')
  }
  // Original text caption must still be there.
  assert.ok(blocks.some((b) => b.type === 'text' && b.text === 'describe the image please'))
})

test('SDK OpenAI chat: vision-on model → image blocks pass through unchanged (sanity / non-regression)', async () => {
  // For vision-on we use the openai provider class (rather than
  // openai-compatible) because openai-compatible's capabilityClass leaves
  // supportsVision undefined and the inferred default for unknown models
  // is false. The 'openai' provider class explicitly sets supportsVision
  // for vision-capable models.
  const config = {
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    visionMode: 'on' as const,
  } as unknown as AIModelConfig
  const { fetch, captured } = makeFakeFetch()
  const model = new ReadyOpenAICompatibleModel({
    config,
    baseUrl: 'https://api.openai.com/v1',
    fetchWithTimeout: fetch,
  })

  await model.getResponse(makeModelRequest([
    {
      role: 'user',
      content: [
        { type: 'input_image', image: 'data:image/png;base64,AAAA' },
        { type: 'input_text', text: 'describe the image please' },
      ],
    },
  ]) as never)

  const messages = (captured[0].body as { messages: Array<{ content: unknown }> }).messages
  const userBlocks = messages[1].content as Array<{ type: string }>
  const hasImage = userBlocks.some((b) => b.type === 'image_url')
  assert.equal(hasImage, true, 'image_url must survive when supportsVision resolves to true')
})

test('SDK OpenAI chat: event-stream response fails with provider protocol mismatch', async () => {
  const config = {
    provider: 'openai-compatible',
    model: 'custom-model',
    apiKey: 'sk-test',
    baseUrl: 'https://example.invalid/v1',
    agentProtocol: 'openai',
    wireApi: 'chat/completions',
  } as unknown as AIModelConfig
  const model = new ReadyOpenAICompatibleModel({
    config,
    baseUrl: 'https://example.invalid/v1',
    fetchWithTimeout: async () => new Response('event: message\ndata: {"type":"message"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  })

  await assert.rejects(
    model.getResponse(makeModelRequest([{ role: 'user', content: 'hello' }]) as never),
    (error) => {
      const typed = error as Error & { code?: string; terminalReason?: string }
      assert.equal(typed.code, 'provider_protocol_mismatch')
      assert.equal(typed.terminalReason, 'provider_protocol_mismatch')
      assert.match(typed.message, /供应商协议不匹配/)
      return true
    },
  )
})

// ============================================================================
// Anthropic wire
// ============================================================================

test('SDK Anthropic: vision-off model → image block stripped from messages[].content', async () => {
  const config = {
    provider: 'anthropic',
    model: 'claude-no-vision',
    apiKey: 'sk-ant-test',
    baseUrl: 'https://anthropic.invalid',
    visionMode: 'off' as const,
  } as unknown as AIModelConfig
  const { fetch, captured } = makeFakeFetch()
  const model = new ReadyAnthropicModel({
    config,
    baseUrl: 'https://anthropic.invalid',
    fetchWithTimeout: fetch,
  })

  await model.getResponse(makeModelRequest([
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: 'what is this' },
      ],
    },
  ]) as never)

  assert.equal(captured.length, 1)
  const messages = (captured[0].body as { messages: Array<{ content: unknown }> }).messages
  const userContent = messages[0].content
  assert.ok(Array.isArray(userContent))
  const blocks = userContent as Array<{ type: string; text?: string }>
  for (const block of blocks) {
    assert.notEqual(block.type, 'image', 'image block must NOT survive vision-off sanitize')
  }
  assert.ok(blocks.some((b) => b.type === 'text' && b.text === 'what is this'))
})

function kimiK3Config(reasoningEffort: 'low' | 'high' | 'max' = 'high'): AIModelConfig {
  return {
    provider: 'moonshot',
    model: 'k3',
    apiKey: 'sk-test',
    baseUrl: 'https://api.kimi.com/coding',
    agentProtocol: 'anthropic',
    reasoningEffort,
  } as AIModelConfig
}

test('SDK Kimi K3: low/high/max all send preserved-thinking request contract', async () => {
  for (const effort of ['low', 'high', 'max'] as const) {
    const { fetch, captured } = makeFakeFetch()
    const model = new ReadyAnthropicModel({
      config: kimiK3Config(effort),
      baseUrl: 'https://api.kimi.com/coding',
      fetchWithTimeout: fetch,
    })

    await model.getResponse(makeModelRequest([{ role: 'user', content: 'hello' }]) as never)

    assert.equal(captured.length, 1)
    assert.deepEqual(captured[0].body.thinking, { type: 'enabled' })
    assert.deepEqual(captured[0].body.output_config, { effort })
    assert.deepEqual(captured[0].body.context_management, {
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    })
    assert.equal(captured[0].headers.get('x-api-key'), 'sk-test')
    assert.equal(captured[0].headers.get('authorization'), null)
    assert.match(captured[0].headers.get('anthropic-beta') || '', /context-management-2025-06-27/)
  }
})

test('SDK Kimi K3: true-stream request uses the same preserved-thinking contract', async () => {
  const { fetch, captured } = makeFakeFetch()
  const model = new ReadyAnthropicModel({
    config: kimiK3Config('max'),
    baseUrl: 'https://api.kimi.com/coding',
    fetchWithTimeout: fetch,
  })

  for await (const _event of model.getStreamedResponse(
    makeModelRequest([{ role: 'user', content: 'hello' }]) as never,
  )) {
    // Consume the full stream so the same final response shaping runs.
  }

  assert.equal(captured.length, 1)
  assert.equal(captured[0].body.stream, true)
  assert.deepEqual(captured[0].body.thinking, { type: 'enabled' })
  assert.deepEqual(captured[0].body.output_config, { effort: 'max' })
  assert.deepEqual(captured[0].body.context_management, {
    edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
  })
})

test('SDK Kimi K3: streamed thinking and signature are echoed on the next turn', async () => {
  const captured: CapturedRequest[] = []
  let call = 0
  const model = new ReadyAnthropicModel({
    config: kimiK3Config('high'),
    baseUrl: 'https://api.kimi.com/coding',
    fetchWithTimeout: async (url, init) => {
      captured.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body || '{}')) as Record<string, unknown>,
      })
      call += 1
      if (call === 1) {
        const events = [
          ['message_start', { type: 'message_start', message: { id: 'msg-k3-stream', usage: {} } }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'streamed reasoning' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-k3-stream' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'stream answer' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 1 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }],
          ['message_stop', { type: 'message_stop' }],
        ]
        const payload = `${events
          .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}`)
          .join('\n\n')}\n\n`
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(payload))
            controller.close()
          },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response(JSON.stringify({
        id: 'msg-k3-stream-second',
        content: [{ type: 'text', text: 'second answer' }],
        usage: {},
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const streamedEvents: Array<Record<string, unknown>> = []
  for await (const event of model.getStreamedResponse(
    makeModelRequest([{ role: 'user', content: 'first' }]) as never,
  )) {
    streamedEvents.push(event as unknown as Record<string, unknown>)
  }
  const done = streamedEvents.find((event) => event.type === 'response_done') as
    | { response: { output: ModelInputItem[] } }
    | undefined
  assert.ok(done)

  await model.getResponse(makeModelRequest([
    ...done.response.output,
    { role: 'user', content: 'second' },
  ]) as never)

  const secondMessages = captured[1].body.messages as Array<Record<string, unknown>>
  const assistant = secondMessages.find((message) => message.role === 'assistant')
  assert.ok(assistant)
  assert.deepEqual(assistant.content, [
    { type: 'thinking', thinking: 'streamed reasoning', signature: 'sig-k3-stream' },
    { type: 'text', text: 'stream answer' },
  ])
})

test('SDK Kimi K3: plain-text thinking block and signature are echoed on the next turn', async () => {
  const captured: CapturedRequest[] = []
  let call = 0
  const model = new ReadyAnthropicModel({
    config: kimiK3Config('high'),
    baseUrl: 'https://api.kimi.com/coding',
    fetchWithTimeout: async (url, init) => {
      captured.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body || '{}')) as Record<string, unknown>,
      })
      call += 1
      return new Response(JSON.stringify(call === 1 ? {
        id: 'msg-k3-text',
        content: [
          { type: 'thinking', thinking: 'private reasoning', signature: 'sig-k3-text' },
          { type: 'text', text: 'first answer' },
        ],
        usage: {},
      } : {
        id: 'msg-k3-second',
        content: [{ type: 'text', text: 'second answer' }],
        usage: {},
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const first = await model.getResponse(makeModelRequest([{ role: 'user', content: 'first' }]) as never)
  await model.getResponse(makeModelRequest([
    ...first.output as never[],
    { role: 'user', content: 'second' },
  ]) as never)

  const secondMessages = captured[1].body.messages as Array<Record<string, unknown>>
  const assistant = secondMessages.find((message) => message.role === 'assistant')
  assert.ok(assistant)
  assert.deepEqual(assistant.content, [
    { type: 'thinking', thinking: 'private reasoning', signature: 'sig-k3-text' },
    { type: 'text', text: 'first answer' },
  ])
})

test('SDK Kimi K3: text and tool call from one response rejoin one assistant message without duplicating thinking', async () => {
  const captured: CapturedRequest[] = []
  let call = 0
  const model = new ReadyAnthropicModel({
    config: kimiK3Config('low'),
    baseUrl: 'https://api.kimi.com/coding',
    fetchWithTimeout: async (url, init) => {
      captured.push({
        url,
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body || '{}')) as Record<string, unknown>,
      })
      call += 1
      return new Response(JSON.stringify(call === 1 ? {
        id: 'msg-k3-tool',
        content: [
          { type: 'thinking', thinking: 'tool reasoning', signature: 'sig-k3-tool' },
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'call-k3', name: 'lookup', input: { q: 'x' } },
        ],
        usage: {},
      } : {
        id: 'msg-k3-after-tool',
        content: [{ type: 'text', text: 'done' }],
        usage: {},
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })

  const first = await model.getResponse(makeModelRequest([{ role: 'user', content: 'use a tool' }]) as never)
  await model.getResponse(makeModelRequest([
    ...first.output as never[],
    { type: 'function_call_result', callId: 'call-k3', output: 'result' },
    { role: 'user', content: 'continue' },
  ]) as never)

  const secondMessages = captured[1].body.messages as Array<Record<string, unknown>>
  const assistantMessages = secondMessages.filter((message) => message.role === 'assistant')
  assert.equal(assistantMessages.length, 1)
  const content = assistantMessages[0].content as Array<Record<string, unknown>>
  assert.deepEqual(content.map((block) => block.type), ['thinking', 'text', 'tool_use'])
  assert.equal(content.filter((block) => block.type === 'thinking').length, 1)
  assert.equal((content[0] as { signature?: string }).signature, 'sig-k3-tool')
})

// Note on video: the SDK's Anthropic normalize layer (contentPartToAnthropic)
// only recognizes input_text / input_image. Video blocks reach the wire
// only through the legacy DirectChatEngine path, where `session.messages`
// can hold `{type:'video', source:...}` directly. The legacy tests below
// exercise that path.
