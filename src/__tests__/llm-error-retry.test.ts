/**
 * Stage S W8.2 — LLM error retry helper behavior test.
 *
 * Asserts:
 *   - isRetryableStatus / isRetryableMessage classify correctly
 *   - withRetryBackoff retries transient errors and surfaces non-retryable ones
 *   - withRetryBackoff stops after maxAttempts
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyProviderError,
  isRetryableError,
  isRetryableMessage,
  isRetryableStatus,
  RETRY_STATUS_CODES,
  withRetryBackoff,
} from '../main/modules/claude-bridge/llm-resilience'
import { ToolDomainError } from '../main/modules/tools/tool-errors'

test('RETRY_STATUS_CODES contains the 8 canonical codes', () => {
  assert.deepEqual([...RETRY_STATUS_CODES].sort((a, b) => a - b), [408, 409, 425, 429, 500, 502, 503, 504])
})

test('isRetryableStatus matches each canonical code', () => {
  for (const code of RETRY_STATUS_CODES) {
    assert.equal(isRetryableStatus(code), true, `code ${code} should be retryable`)
  }
})

test('isRetryableStatus rejects null/undefined/200/404', () => {
  assert.equal(isRetryableStatus(null), false)
  assert.equal(isRetryableStatus(undefined), false)
  assert.equal(isRetryableStatus(200), false)
  assert.equal(isRetryableStatus(404), false)
})

test('isRetryableMessage matches "server busy" / "rate limit" / "overloaded"', () => {
  assert.equal(isRetryableMessage('Server is busy. please try again.'), true)
  assert.equal(isRetryableMessage('Rate limit exceeded'), true)
  assert.equal(isRetryableMessage('rate-limit reached'), true)
  assert.equal(isRetryableMessage('System overloaded'), true)
  assert.equal(isRetryableMessage('Please try again later.'), true)
  assert.equal(isRetryableMessage('Bad request: invalid model'), false)
  assert.equal(isRetryableMessage(''), false)
  assert.equal(isRetryableMessage(null), false)
})

test('isRetryableError accepts Error with .status or message hit', () => {
  const e1 = Object.assign(new Error('boom'), { status: 503 })
  assert.equal(isRetryableError(e1), true)
  const e2 = new Error('Server is busy now')
  assert.equal(isRetryableError(e2), true)
  const e3 = new Error('not found')
  assert.equal(isRetryableError(e3), false)
  assert.equal(isRetryableError(null), false)
})

test('withRetryBackoff returns success without retry on first attempt', async () => {
  let calls = 0
  const result = await withRetryBackoff(async () => {
    calls += 1
    return 'ok'
  })
  assert.equal(result, 'ok')
  assert.equal(calls, 1)
})

test('withRetryBackoff retries on retryable error and eventually succeeds', async () => {
  let calls = 0
  const result = await withRetryBackoff(
    async () => {
      calls += 1
      if (calls < 3) {
        const err = Object.assign(new Error('busy'), { status: 503 })
        throw err
      }
      return 'ok'
    },
    { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 3 },
  )
  assert.equal(result, 'ok')
  assert.equal(calls, 3)
})

test('withRetryBackoff bubbles non-retryable errors immediately', async () => {
  let calls = 0
  await assert.rejects(
    withRetryBackoff(
      async () => {
        calls += 1
        throw new Error('bad request 400')
      },
      { baseDelayMs: 1, maxAttempts: 5 },
    ),
    /bad request 400/,
  )
  assert.equal(calls, 1)
})

test('classifyProviderError recognizes 400 thinking echo failures', () => {
  const err = Object.assign(new Error('HTTP 400: missing reasoning_content from previous assistant message'), { status: 400 })
  const classified = classifyProviderError(err)
  assert.equal(classified?.errorKind, 'provider_thinking_echo_required')
  assert.equal(classified?.recoverable, false)
})

test('withRetryBackoff wraps 400 thinking echo failures as provider_request_failed', async () => {
  let calls = 0
  await assert.rejects(
    withRetryBackoff(
      async () => {
        calls += 1
        throw Object.assign(new Error('HTTP 400: extended thinking blocks must be preserved'), { status: 400 })
      },
      { baseDelayMs: 1, maxAttempts: 3 },
    ),
    (error) => {
      assert.ok(error instanceof ToolDomainError)
      assert.equal(error.errorKind, 'provider_request_failed')
      assert.equal(error.detail?.recoverable, false)
      assert.equal(error.detail?.providerErrorKind, 'provider_thinking_echo_required')
      return true
    },
  )
  assert.equal(calls, 1)
})

test('withRetryBackoff stops after maxAttempts and rethrows last error', async () => {
  let calls = 0
  await assert.rejects(
    withRetryBackoff(
      async () => {
        calls += 1
        const err = Object.assign(new Error(`busy ${calls}`), { status: 429 })
        throw err
      },
      { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 3 },
    ),
    /busy 3/,
  )
  assert.equal(calls, 3)
})
