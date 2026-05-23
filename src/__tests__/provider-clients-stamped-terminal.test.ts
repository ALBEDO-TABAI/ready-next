/**
 * Stage X6.1 — provider-clients stamped-terminal behavior test.
 *
 * Plan §7.2 + codex r1 must-fix #2: the three legacy execution clients
 * (openai / anthropic / kimi-coding) must throw `Error` instances
 * pre-stamped with a typed `ProviderTerminalError` (via
 * `buildProviderHttpError`) when the upstream HTTP response is not ok.
 * Previously each client threw a bare `Error` with an ad-hoc `.status`
 * field, leaving downstream consumers to re-parse the message.
 *
 * This test feeds each client a stub fetch that returns HTTP 402
 * (`quota_exceeded` per the classifier) and asserts:
 *   1. the thrown value is an Error
 *   2. `readProviderTerminalError(error)` returns
 *      `{ code: 'quota_exceeded', httpStatus: 402, ... }`
 *   3. the legacy `.status` field is preserved so
 *      `withRetryBackoff` (and any other consumer reading `.status`)
 *      keeps working unchanged
 *
 * HTTP 402 was chosen because it is NOT in the
 * `withRetryBackoff` retry list (408/409/425/429/500–504), so the throw
 * bubbles out of the retry wrapper on the first attempt without any
 * extra fetch calls. It is also NOT matched by any of the legacy
 * fallback policies (`shouldRetryWithKimiCoding`, etc.), so the throw
 * surfaces uniformly across all three clients.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

import { OpenAIExecutionClient } from '../main/modules/claude-bridge/openai-execution-client'
import { AnthropicExecutionClient } from '../main/modules/claude-bridge/anthropic-execution-client'
import { KimiCodingClient } from '../main/modules/claude-bridge/kimi-coding-client'
import { readProviderTerminalError } from '../main/modules/claude-bridge/provider-terminal-error'
import type { AIModelConfig } from '../shared/ai-providers'

function build402Response(): Response {
  return new Response('Insufficient balance', {
    status: 402,
    headers: { 'Content-Type': 'text/plain' },
  })
}

function baseConfig(overrides: Partial<AIModelConfig> = {}): AIModelConfig {
  return {
    provider: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    model: 'gpt-test',
    ...overrides,
  }
}

test('OpenAIExecutionClient.requestSimple stamps ProviderTerminalError(quota_exceeded) on HTTP 402', async () => {
  const client = new OpenAIExecutionClient({
    fetchWithTimeout: async () => build402Response(),
    log: () => {},
  })

  let caught: unknown = null
  try {
    await client.requestSimple({
      session: {
        messages: [{ role: 'user', content: 'hello' }],
        systemPrompt: 'system',
        preferTextToolBridge: false,
      },
      config: baseConfig(),
      baseUrl: 'https://example.com/v1',
      provider: undefined,
      signal: new AbortController().signal,
    })
  } catch (err) {
    caught = err
  }

  assert.ok(caught instanceof Error, 'expected an Error to be thrown')
  const terminal = readProviderTerminalError(caught)
  assert.ok(terminal, 'expected the thrown Error to be stamped with ProviderTerminalError')
  assert.equal(terminal.code, 'quota_exceeded')
  assert.equal(terminal.httpStatus, 402)
  assert.match(terminal.providerMessage, /Insufficient balance/i)
  // Legacy `.status` field preserved for withRetryBackoff backwards compat.
  assert.equal((caught as { status?: number }).status, 402)
  assert.match((caught as Error).message, /HTTP 402:.*Insufficient balance/i)
})

test('AnthropicExecutionClient.requestSimple stamps ProviderTerminalError(quota_exceeded) on HTTP 402', async () => {
  const client = new AnthropicExecutionClient({
    fetchWithTimeout: async () => build402Response(),
    serializeMessages: (messages) => messages.map((m) => ({ role: m.role, content: m.content })),
    log: () => {},
  })

  let caught: unknown = null
  try {
    await client.requestSimple({
      session: {
        messages: [{ role: 'user', content: 'hello' }],
        systemPrompt: 'system',
      },
      config: baseConfig({ provider: 'anthropic' }),
      // Non-kimi base URL → no kimi_coding fallback engages.
      baseUrl: 'https://api.anthropic.example.com',
      signal: new AbortController().signal,
    })
  } catch (err) {
    caught = err
  }

  assert.ok(caught instanceof Error, 'expected an Error to be thrown')
  const terminal = readProviderTerminalError(caught)
  assert.ok(terminal, 'expected the thrown Error to be stamped with ProviderTerminalError')
  assert.equal(terminal.code, 'quota_exceeded')
  assert.equal(terminal.httpStatus, 402)
  assert.equal((caught as { status?: number }).status, 402)
})

test('KimiCodingClient.requestSimple stamps ProviderTerminalError(quota_exceeded) on HTTP 402', async () => {
  const client = new KimiCodingClient({
    fetchWithTimeout: async () => build402Response(),
    log: () => {},
  })

  let caught: unknown = null
  try {
    await client.requestSimple({
      session: {
        messages: [{ role: 'user', content: 'hello' }],
      },
      config: baseConfig({ provider: 'kimi' }),
      baseUrl: 'https://api.kimi.com/coding',
      signal: new AbortController().signal,
    })
  } catch (err) {
    caught = err
  }

  assert.ok(caught instanceof Error, 'expected an Error to be thrown')
  const terminal = readProviderTerminalError(caught)
  assert.ok(terminal, 'expected the thrown Error to be stamped with ProviderTerminalError')
  assert.equal(terminal.code, 'quota_exceeded')
  assert.equal(terminal.httpStatus, 402)
  assert.equal((caught as { status?: number }).status, 402)
})

test('OpenAIExecutionClient parses Retry-After header into rate_limited.retryAfterSeconds on HTTP 429', async () => {
  const client = new OpenAIExecutionClient({
    fetchWithTimeout: async () => new Response('Too Many Requests', {
      status: 429,
      headers: {
        'Content-Type': 'text/plain',
        'Retry-After': '45',
      },
    }),
    log: () => {},
  })

  // 429 IS in the withRetryBackoff list → use a 1-attempt run so it
  // throws on the first failure instead of looping.
  let caught: unknown = null
  try {
    await client.requestSimple({
      session: {
        messages: [{ role: 'user', content: 'hello' }],
        systemPrompt: 'system',
        preferTextToolBridge: false,
      },
      config: baseConfig(),
      baseUrl: 'https://example.com/v1',
      provider: undefined,
      signal: new AbortController().signal,
    })
  } catch (err) {
    caught = err
  }

  assert.ok(caught instanceof Error)
  const terminal = readProviderTerminalError(caught)
  assert.ok(terminal)
  assert.equal(terminal.code, 'rate_limited')
  assert.equal(terminal.httpStatus, 429)
  assert.equal(terminal.retryAfterSeconds, 45)
})

test('AnthropicExecutionClient parses Retry-After header into rate_limited.retryAfterSeconds on HTTP 429', async () => {
  const client = new AnthropicExecutionClient({
    fetchWithTimeout: async () => new Response('Too Many Requests', {
      status: 429,
      headers: {
        'Content-Type': 'text/plain',
        'Retry-After': '30',
      },
    }),
    serializeMessages: (messages) => messages.map((m) => ({ role: m.role, content: m.content })),
    log: () => {},
  })

  let caught: unknown = null
  try {
    await client.requestSimple({
      session: {
        messages: [{ role: 'user', content: 'hello' }],
        systemPrompt: 'system',
      },
      config: baseConfig({ provider: 'anthropic' }),
      // Non-kimi base URL → no kimi_coding fallback engages; withRetryBackoff
      // will replay the stub 3 times before surfacing the final stamped Error.
      baseUrl: 'https://api.anthropic.example.com',
      signal: new AbortController().signal,
    })
  } catch (err) {
    caught = err
  }

  assert.ok(caught instanceof Error)
  const terminal = readProviderTerminalError(caught)
  assert.ok(terminal)
  assert.equal(terminal.code, 'rate_limited')
  assert.equal(terminal.httpStatus, 429)
  assert.equal(terminal.retryAfterSeconds, 30)
})

test('KimiCodingClient parses Retry-After header into rate_limited.retryAfterSeconds on HTTP 429', async () => {
  const client = new KimiCodingClient({
    fetchWithTimeout: async () => new Response('Too Many Requests', {
      status: 429,
      headers: {
        'Content-Type': 'text/plain',
        'Retry-After': '30',
      },
    }),
    log: () => {},
  })

  // Kimi `requestSimple` catches the first failure and (without a
  // fallbackToAnthropic dep) replays `requestSimpleOnce` once, so the
  // stub is hit twice before the stamped Error surfaces.
  let caught: unknown = null
  try {
    await client.requestSimple({
      session: {
        messages: [{ role: 'user', content: 'hello' }],
      },
      config: baseConfig({ provider: 'kimi' }),
      baseUrl: 'https://api.kimi.com/coding',
      signal: new AbortController().signal,
    })
  } catch (err) {
    caught = err
  }

  assert.ok(caught instanceof Error)
  const terminal = readProviderTerminalError(caught)
  assert.ok(terminal)
  assert.equal(terminal.code, 'rate_limited')
  assert.equal(terminal.httpStatus, 429)
  assert.equal(terminal.retryAfterSeconds, 30)
})

test('KimiCodingClient.uploadVideoToFiles stamps ProviderTerminalError(quota_exceeded) on HTTP 402', async () => {
  const client = new KimiCodingClient({
    fetchWithTimeout: async () => build402Response(),
    log: () => {},
  })

  // 1 KB of arbitrary bytes encoded as base64 — large enough to pass the
  // `binary.length === 0` precondition guard so the request actually hits
  // the stubbed fetch.
  const videoBase64 = Buffer.from(new Uint8Array(1024)).toString('base64')

  let caught: unknown = null
  try {
    await client.uploadVideoToFiles(
      'https://api.kimi.com/coding/v1',
      'test-key',
      videoBase64,
      'video/mp4',
      new AbortController().signal,
    )
  } catch (err) {
    caught = err
  }

  assert.ok(caught instanceof Error, 'expected an Error to be thrown')
  const terminal = readProviderTerminalError(caught)
  assert.ok(terminal, 'expected the thrown Error to be stamped with ProviderTerminalError')
  assert.equal(terminal.code, 'quota_exceeded')
  assert.equal(terminal.httpStatus, 402)
  assert.match(terminal.providerMessage, /Insufficient balance/i)
  assert.equal((caught as { status?: number }).status, 402)
  // Human-readable prefix preserved per `buildProviderHttpError({messagePrefix})`.
  assert.match((caught as Error).message, /upload video failed:.*HTTP 402.*Insufficient balance/i)
})
