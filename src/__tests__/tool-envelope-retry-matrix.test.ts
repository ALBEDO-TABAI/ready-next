/**
 * EP2-T4-3 — graded retry convergence (phase-1 T4 handover).
 * Matrix: 401/403/4xx arg errors → zero retry; 429 → respect Retry-After,
 * backoff ≤2; 5xx/network → backoff ≤2. First migrated domain:
 * general_research builtins (web-search / web-fetch). Unmigrated outbound
 * domains keep their no-retry behavior byte-for-byte.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyHttpStatusForRetry,
  fetchWithRetryPolicy,
} from '../main/modules/tools/retry-policy'

function fakeResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : '{}', { status, headers })
}

function harness(statuses: Array<number | 'network_error'>) {
  const calls: Array<string> = []
  const sleeps: number[] = []
  const fetchImpl = (async () => {
    const next = statuses[calls.length] ?? 200
    calls.push(String(next))
    if (next === 'network_error') throw new TypeError('fetch failed')
    return fakeResponse(next as number, next === 429 ? { 'Retry-After': '1' } : {})
  }) as unknown as typeof fetch
  const sleep = async (ms: number) => { sleeps.push(ms) }
  return { calls, sleeps, fetchImpl, sleep }
}

test('classification matrix: 401/403/400/422 never retry; 429 rate-limited; 5xx transient', () => {
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(classifyHttpStatusForRetry(status), 'no_retry', `status ${status}`)
  }
  assert.equal(classifyHttpStatusForRetry(429), 'rate_limited')
  for (const status of [500, 502, 503, 504]) {
    assert.equal(classifyHttpStatusForRetry(status), 'transient', `status ${status}`)
  }
})

test('401 gets exactly one attempt — auth failures are never retried', async () => {
  const h = harness([401])
  const response = await fetchWithRetryPolicy('https://api.example.com', undefined, {
    fetchImpl: h.fetchImpl, sleep: h.sleep,
  })
  assert.equal(response.status, 401)
  assert.equal(h.calls.length, 1)
  assert.equal(h.sleeps.length, 0)
})

test('429 respects Retry-After and stops after two retries', async () => {
  const ok = harness([429, 429, 200])
  const response = await fetchWithRetryPolicy('https://api.example.com', undefined, {
    fetchImpl: ok.fetchImpl, sleep: ok.sleep,
  })
  assert.equal(response.status, 200)
  assert.equal(ok.calls.length, 3)
  assert.deepEqual(ok.sleeps, [1000, 1000], 'Retry-After: 1 → 1000ms waits')

  const exhausted = harness([429, 429, 429, 429])
  const final = await fetchWithRetryPolicy('https://api.example.com', undefined, {
    fetchImpl: exhausted.fetchImpl, sleep: exhausted.sleep,
  })
  assert.equal(final.status, 429, 'after two retries the 429 is returned, not retried forever')
  assert.equal(exhausted.calls.length, 3)
})

test('5xx and network errors back off at most twice', async () => {
  const recovers = harness(['network_error', 200])
  const response = await fetchWithRetryPolicy('https://api.example.com', undefined, {
    fetchImpl: recovers.fetchImpl, sleep: recovers.sleep,
  })
  assert.equal(response.status, 200)
  assert.equal(recovers.calls.length, 2)

  const dead = harness(['network_error', 'network_error', 'network_error'])
  await assert.rejects(
    fetchWithRetryPolicy('https://api.example.com', undefined, { fetchImpl: dead.fetchImpl, sleep: dead.sleep }),
    TypeError,
  )
  assert.equal(dead.calls.length, 3, 'initial + two retries, then the error propagates')

  const flaky5xx = harness([503, 500, 200])
  const recovered = await fetchWithRetryPolicy('https://api.example.com', undefined, {
    fetchImpl: flaky5xx.fetchImpl, sleep: flaky5xx.sleep,
  })
  assert.equal(recovered.status, 200)
  assert.equal(flaky5xx.calls.length, 3)
})

test('migrated domain: tavily web_search rides the retry policy (429 then success)', async () => {
  const { executeWebSearch } = await import('../main/modules/tools/builtins/web-search')
  const calls: number[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    calls.push(1)
    if (calls.length === 1) return fakeResponse(429, { 'Retry-After': '0' })
    return new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://x', content: 'c' }] }), { status: 200 })
  }) as typeof fetch
  try {
    const result = await executeWebSearch({ query: 'q', topK: 1 } as never, { tavilyKey: 'k' })
    assert.equal(result.results.length, 1)
    assert.equal(calls.length, 2, 'one 429 retry, then success')
  } finally {
    globalThis.fetch = original
  }
})

test('unmigrated outbound domain keeps zero-retry behavior (snapshot)', async () => {
  const { executeWebClipUrl } = await import('../main/modules/tools/builtins/web-clip-url')
  const calls: number[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    calls.push(1)
    return fakeResponse(500)
  }) as typeof fetch
  try {
    await assert.rejects(executeWebClipUrl(
      { url: 'https://example.com/article' } as never,
      { outputsRoot: '/tmp/ready-clip-out', presetDir: '/tmp/ready-clip-preset' } as never,
    ))
    assert.equal(calls.length, 2, 'html + jina fallback, one attempt each — no retries gained')
  } finally {
    globalThis.fetch = original
  }
})
