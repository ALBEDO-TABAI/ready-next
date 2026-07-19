/**
 * Stage X2.1 — provider terminal-error classifier behavior tests.
 *
 * Plan §7.2 (docs/superpowers/plans/2026-05-22-X-trust-foundation-and-w5-recovery-implementation.md)
 * spells out 11 typed `ProviderTerminalCode` values + the separate
 * `infrastructure_timeout` 60s safety path. This test covers the 11 codes
 * the classifier must produce; the infrastructure_timeout path is exercised
 * by `runtime-driver-infrastructure-timeout.test.ts` (X2.6) because it
 * lives outside the per-error classifier.
 *
 * The classifier is a PURE function of (httpStatus, errorBody, signal,
 * retryAfterSeconds). Each test feeds one representative fixture per code.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyProviderError,
  type ProviderTerminalCode,
  type ProviderTerminalError,
} from '../main/modules/claude-bridge/provider-terminal-error'

function expectCode(input: Parameters<typeof classifyProviderError>[0], code: ProviderTerminalCode): ProviderTerminalError {
  const result = classifyProviderError(input)
  assert.equal(result.code, code, `expected code=${code}, got ${result.code} (providerMessage=${result.providerMessage})`)
  return result
}

test('quota_exceeded — HTTP 402 (account quota)', () => {
  const result = expectCode(
    { httpStatus: 402, errorBody: 'Insufficient balance' },
    'quota_exceeded',
  )
  assert.equal(result.httpStatus, 402)
  assert.match(result.providerMessage, /Insufficient/i)
})

test('quota_exceeded — HTTP 429 with quota signal in body', () => {
  const result = expectCode(
    { httpStatus: 429, errorBody: '{"error":"quota_exceeded","message":"monthly quota reached"}' },
    'quota_exceeded',
  )
  assert.equal(result.httpStatus, 429)
})

test('auth_required — HTTP 401 unauthorized', () => {
  expectCode({ httpStatus: 401, errorBody: 'Unauthorized' }, 'auth_required')
})

test('auth_required — HTTP 403 forbidden / invalid_api_key', () => {
  expectCode(
    { httpStatus: 403, errorBody: 'invalid_api_key: API key revoked' },
    'auth_required',
  )
})

test('rate_limited — HTTP 429 without quota header, retry-after present', () => {
  const result = expectCode(
    { httpStatus: 429, errorBody: 'Too Many Requests', retryAfterSeconds: 45 },
    'rate_limited',
  )
  assert.equal(result.retryAfterSeconds, 45)
})

test('invalid_request — HTTP 400 with generic invalid request', () => {
  expectCode(
    { httpStatus: 400, errorBody: 'invalid_request: missing required field' },
    'invalid_request',
  )
})

test('invalid_request — HTTP 422 unprocessable entity', () => {
  expectCode(
    { httpStatus: 422, errorBody: 'Validation failed' },
    'invalid_request',
  )
})

test('context_overflow — HTTP 400 with context length in body', () => {
  expectCode(
    { httpStatus: 400, errorBody: 'prompt is too long: 200000 tokens > 100000 max context length' },
    'context_overflow',
  )
})

test('context_overflow — HTTP 413 payload too large', () => {
  expectCode(
    { httpStatus: 413, errorBody: 'Payload Too Large' },
    'context_overflow',
  )
})

test('timeout_model — client signal "stream-timeout"', () => {
  expectCode(
    { signal: 'stream-timeout', errorBody: 'no token within N seconds' },
    'timeout_model',
  )
})

test('timeout_tool — client signal "tool-timeout"', () => {
  expectCode(
    { signal: 'tool-timeout', errorBody: 'tool exceeded budget' },
    'timeout_tool',
  )
})

test('transient — retryable request and server statuses include gateway 520–524', () => {
  for (const httpStatus of [408, 425, 500, 502, 503, 504, 520, 521, 522, 523, 524, 599]) {
    expectCode({ httpStatus, errorBody: 'Server Error' }, 'transient')
  }
})

test('unknown — protocol and capability 5xx are not replayed', () => {
  for (const httpStatus of [501, 505]) {
    expectCode({ httpStatus, errorBody: 'Protocol capability is unsupported' }, 'unknown')
  }
})

test('transient — ECONNRESET / EAI_AGAIN node-level signals', () => {
  expectCode({ errorBody: 'ECONNRESET' }, 'transient')
  expectCode({ errorBody: 'getaddrinfo EAI_AGAIN api.example.com' }, 'transient')
})

test('provider_thinking_echo_required — body mentions thinking blocks rejection', () => {
  expectCode(
    {
      httpStatus: 400,
      errorBody: 'messages.0.content must include the prior thinking blocks when extended thinking is enabled',
    },
    'provider_thinking_echo_required',
  )
})

test('network — DNS lookup / TLS / connection refused', () => {
  expectCode({ errorBody: 'getaddrinfo ENOTFOUND api.example.com' }, 'network')
  expectCode({ errorBody: 'connect ECONNREFUSED 1.2.3.4:443' }, 'network')
  expectCode({ errorBody: 'unable to verify the first certificate' }, 'network')
})

test('unknown — body does not match any known signature', () => {
  const result = expectCode(
    { httpStatus: 418, errorBody: 'I am a teapot' },
    'unknown',
  )
  assert.equal(result.httpStatus, 418)
  assert.match(result.providerMessage, /teapot/i)
})

test('classifier is pure — repeated calls with the same input return the same code', () => {
  const fixture = { httpStatus: 402, errorBody: 'Insufficient balance' }
  const a = classifyProviderError(fixture)
  const b = classifyProviderError(fixture)
  assert.equal(a.code, b.code)
  assert.equal(a.httpStatus, b.httpStatus)
  assert.equal(a.providerMessage, b.providerMessage)
})
