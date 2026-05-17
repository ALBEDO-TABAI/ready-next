/**
 * Stage U (PR 2 review patch) — request-body level behavior tests for the
 * legacy DirectChatEngine execution clients (`OpenAIExecutionClient`,
 * `AnthropicExecutionClient`). Companion to
 * `agent-sdk-runtime-capability-body.test.ts` — together they prove the
 * capability filter is wired on BOTH the SDK main path AND legacy.
 *
 * The legacy Anthropic path is where video blocks actually live (session
 * messages with `{type:'video', source:...}`), so the video-survives /
 * video-stripped contract is verified here, not in the SDK file above.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AnthropicExecutionClient } from '../main/modules/claude-bridge/anthropic-execution-client'
import { OpenAIExecutionClient } from '../main/modules/claude-bridge/openai-execution-client'
import type { AIModelConfig } from '../../shared/ai-providers'

type Captured = { url: string; body: Record<string, unknown> }

function makeFakeFetch(): {
  fetch: (
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    label: string,
    timeoutMs?: number,
  ) => Promise<Response>
  captured: Captured[]
} {
  const captured: Captured[] = []
  const fetch = async (
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
      // leave as {}
    }
    captured.push({ url, body })
    return new Response(JSON.stringify({
      id: 'resp-test',
      choices: [{ message: { content: '' } }],
      content: [{ type: 'text', text: '' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, captured }
}

// ============================================================================
// AnthropicExecutionClient — verifies video survival contract
// ============================================================================

test('legacy Anthropic: vision-off + history image → image block stripped from request.messages', async () => {
  const { fetch, captured } = makeFakeFetch()
  const client = new AnthropicExecutionClient({
    fetchWithTimeout: fetch,
    serializeMessages: (messages) => messages.map((m) => ({ role: m.role, content: m.content })),
    log: () => {},
  })
  const config = {
    provider: 'anthropic',
    model: 'no-vision-claude',
    apiKey: 'sk-ant',
    baseUrl: 'https://api.anthropic.invalid',
    visionMode: 'off' as const,
  } as unknown as AIModelConfig

  await client.requestSimpleOnce({
    session: {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            { type: 'text', text: 'describe this' },
          ],
        },
      ],
      systemPrompt: 'sys',
    },
    config,
    baseUrl: 'https://api.anthropic.invalid',
    signal: new AbortController().signal,
  })

  assert.equal(captured.length, 1)
  const messages = (captured[0].body as { messages: Array<{ content: Array<{ type: string }> }> }).messages
  for (const block of messages[0].content) {
    assert.notEqual(block.type, 'image', 'image block must be stripped when vision-off')
  }
})

test('legacy Anthropic: nativeVideoMode=on → video block survives request.messages (PR 2 review fix)', async () => {
  const { fetch, captured } = makeFakeFetch()
  const client = new AnthropicExecutionClient({
    fetchWithTimeout: fetch,
    serializeMessages: (messages) => messages.map((m) => ({ role: m.role, content: m.content })),
    log: () => {},
  })
  const config = {
    provider: 'anthropic',
    model: 'claude-sonnet-with-video',
    apiKey: 'sk-ant',
    baseUrl: 'https://api.anthropic.invalid',
    visionMode: 'on' as const,
    nativeVideoMode: 'on' as const,
  } as unknown as AIModelConfig

  await client.requestSimpleOnce({
    session: {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'AAAA' } },
            { type: 'text', text: 'analyse' },
          ],
        },
      ],
      systemPrompt: 'sys',
    },
    config,
    baseUrl: 'https://api.anthropic.invalid',
    signal: new AbortController().signal,
  })

  const messages = (captured[0].body as { messages: Array<{ content: Array<{ type: string }> }> }).messages
  const hasVideo = messages[0].content.some((b) => b.type === 'video')
  assert.equal(hasVideo, true, 'video must survive when nativeVideoMode=on (regression protector)')
})

test('legacy Anthropic: nativeVideoMode=off → video block stripped from request.messages', async () => {
  const { fetch, captured } = makeFakeFetch()
  const client = new AnthropicExecutionClient({
    fetchWithTimeout: fetch,
    serializeMessages: (messages) => messages.map((m) => ({ role: m.role, content: m.content })),
    log: () => {},
  })
  const config = {
    provider: 'anthropic',
    model: 'claude-no-video',
    apiKey: 'sk-ant',
    baseUrl: 'https://api.anthropic.invalid',
    visionMode: 'on' as const,
    nativeVideoMode: 'off' as const,
  } as unknown as AIModelConfig

  await client.requestSimpleOnce({
    session: {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'video', source: { type: 'base64', media_type: 'video/mp4', data: 'AAAA' } },
            { type: 'text', text: 'analyse' },
          ],
        },
      ],
      systemPrompt: 'sys',
    },
    config,
    baseUrl: 'https://api.anthropic.invalid',
    signal: new AbortController().signal,
  })

  const messages = (captured[0].body as { messages: Array<{ content: Array<{ type: string }> }> }).messages
  const hasVideo = messages[0].content.some((b) => b.type === 'video')
  assert.equal(hasVideo, false, 'video must be stripped when nativeVideoMode=off')
})

// ============================================================================
// OpenAIExecutionClient — verifies the chat-completions path
// ============================================================================

test('legacy OpenAI chat: vision-off + history image_url → image_url stripped from request.messages', async () => {
  const { fetch, captured } = makeFakeFetch()
  const client = new OpenAIExecutionClient({
    fetchWithTimeout: fetch,
    log: () => {},
  })
  const config = {
    provider: 'openai-compatible',
    model: 'no-vision-model',
    apiKey: 'sk',
    baseUrl: 'https://openai-compat.invalid',
    visionMode: 'off' as const,
  } as unknown as AIModelConfig

  await client.requestSimple({
    session: {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'text', text: 'caption?' },
          ],
        },
      ],
      systemPrompt: 'sys',
      preferTextToolBridge: false,
    },
    config,
    baseUrl: 'https://openai-compat.invalid',
    provider: undefined,
    signal: new AbortController().signal,
  })

  assert.equal(captured.length, 1)
  const messages = (captured[0].body as { messages: Array<{ content: unknown }> }).messages
  // messages[0] = system, messages[1] = user
  const userContent = messages[1].content
  if (Array.isArray(userContent)) {
    for (const block of userContent as Array<{ type: string }>) {
      assert.notEqual(block.type, 'image_url', 'image_url must be stripped when vision-off')
      assert.notEqual(block.type, 'image', 'image must be stripped when vision-off')
    }
  }
  // If userContent is a plain string after sanitize, that's also acceptable —
  // it means the array was emptied (placeholder text) and not present.
})

test('legacy OpenAI chat: array-content history preserves reasoning_content', async () => {
  const { fetch, captured } = makeFakeFetch()
  const client = new OpenAIExecutionClient({
    fetchWithTimeout: fetch,
    log: () => {},
  })
  const config = {
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'sk',
    baseUrl: 'https://api.openai.com/v1',
    visionMode: 'on' as const,
  } as unknown as AIModelConfig

  await client.requestSimple({
    session: {
      messages: [
        {
          role: 'assistant',
          reasoning_content: 'previous hidden reasoning',
          content: [{ type: 'text', text: 'previous answer' }],
        },
        { role: 'user', content: 'continue' },
      ],
      systemPrompt: 'sys',
      preferTextToolBridge: false,
    },
    config,
    baseUrl: 'https://api.openai.com/v1',
    provider: undefined,
    signal: new AbortController().signal,
  })

  const messages = (captured[0].body as { messages: Array<Record<string, unknown>> }).messages
  const assistant = messages.find((message) => message.role === 'assistant')
  assert.equal(assistant?.reasoning_content, 'previous hidden reasoning')
})
