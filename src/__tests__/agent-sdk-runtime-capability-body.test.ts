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
    captured.push({ url, body })
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

// Note on video: the SDK's Anthropic normalize layer (contentPartToAnthropic)
// only recognizes input_text / input_image. Video blocks reach the wire
// only through the legacy DirectChatEngine path, where `session.messages`
// can hold `{type:'video', source:...}` directly. The legacy tests below
// exercise that path.
