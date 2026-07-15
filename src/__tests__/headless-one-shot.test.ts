import assert from 'node:assert/strict'
import test from 'node:test'

import type { AIModelConfig } from '../shared/ai-providers'
import { requestHeadlessOneShot } from '../main/modules/content-study/headless-one-shot'

test('OpenAI-compatible one-shot appends chat/completions exactly once to the API base', async () => {
  const originalFetch = globalThis.fetch
  const requestedUrls: string[] = []
  globalThis.fetch = async (input) => {
    requestedUrls.push(String(input))
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const cases = [
    {
      baseUrl: 'https://relay.example.com',
      expected: 'https://relay.example.com/v1/chat/completions',
    },
    {
      baseUrl: 'https://relay.example.com/v1',
      expected: 'https://relay.example.com/v1/chat/completions',
    },
    {
      baseUrl: 'https://relay.example.com/openai/v1',
      expected: 'https://relay.example.com/openai/v1/chat/completions',
    },
  ]

  try {
    for (const item of cases) {
      const config: AIModelConfig = {
        provider: 'openai-compatible',
        baseUrl: item.baseUrl,
        apiKey: 'test-key',
        model: 'gpt-test',
      }
      const result = await requestHeadlessOneShot({
        system: 'system',
        user: 'user',
        config,
      })
      assert.deepEqual(result, { ok: true, text: 'ok' })
    }

    assert.deepEqual(requestedUrls, cases.map((item) => item.expected))
    assert.equal(requestedUrls.some((url) => url.includes('/v1/v1/')), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
