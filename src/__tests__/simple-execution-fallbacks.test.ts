import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { KimiCodingClient } from '../main/modules/claude-bridge/kimi-coding-client'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('AnthropicExecutionClient keeps simple-path fallback inside the client contract', () => {
  const source = readWorkspaceFile('src/main/modules/claude-bridge/anthropic-execution-client.ts')

  assert.match(source, /annotateFallbackResult/)
  assert.match(source, /buildVideoFrameFallbackMessages/)
  assert.match(source, /onFallbackApplied/)
  assert.match(source, /return annotateFallbackResult\(/)
})

test('KimiCodingClient returns simple fallback metadata after anthropic-compatible retry takes over', async () => {
  let fallbackMessages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> | null = null
  let anthropicCallCount = 0

  const client = new KimiCodingClient({
    fetchWithTimeout: async () => ({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    }) as Response,
    log: () => {},
  })

  const result = await client.requestSimple({
    session: {
      messages: [{ role: 'user', content: [{ type: 'video', source: { type: 'base64', data: 'abc' } }] }],
    },
    config: { provider: 'openai', apiKey: 'key', model: 'kimi-for-coding' } as any,
    baseUrl: 'https://api.kimi.com/coding',
    signal: new AbortController().signal,
    hasVideoInputs: true,
    buildVideoFrameFallbackMessages: async () => [{ role: 'user', content: 'video frames injected' }],
    assignFallbackMessages: (messages) => {
      fallbackMessages = messages
    },
    fallbackToAnthropic: async ({ messagesOverride }) => {
      anthropicCallCount += 1
      assert.deepEqual(messagesOverride, fallbackMessages)
      return {
        text: 'anthropic recovered',
      }
    },
  })

  assert.equal(anthropicCallCount, 1)
  assert.equal(result.text, 'anthropic recovered')
  assert.deepEqual(result.fallback, {
    kind: 'kimi_coding_retry',
    attempts: 1,
  })
  assert.deepEqual(fallbackMessages, [{ role: 'user', content: 'video frames injected' }])
})
