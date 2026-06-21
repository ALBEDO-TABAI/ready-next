/**
 * Stage R W1.2 — web_fetch tool smoke test.
 *
 * Asserts the Zod schema rejects non-URL inputs and that the 4096-char
 * hard-cap constant is exposed for downstream truncation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { WEB_RESEARCH_ERROR_KINDS } from '../main/modules/agent-control/contracts/error-kinds'
import {
  executeWebFetch,
  webFetchSchema,
  WEB_FETCH_CONTENT_HARD_CAP,
} from '../main/modules/tools/builtins/web-fetch'

test('webFetchSchema rejects non-URL input', () => {
  const result = webFetchSchema.safeParse({ url: 'not-a-url' })
  assert.equal(result.success, false)
})

test('webFetchSchema accepts http/https URL', () => {
  const r1 = webFetchSchema.safeParse({ url: 'https://example.com/path' })
  const r2 = webFetchSchema.safeParse({ url: 'http://example.com' })
  assert.equal(r1.success, true)
  assert.equal(r2.success, true)
})

test('WEB_FETCH_CONTENT_HARD_CAP is 4096 characters', () => {
  assert.equal(WEB_FETCH_CONTENT_HARD_CAP, 4096)
})

test('executeWebFetch throws the shared web_fetch_failed errorKind when all backends fail', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('bad request', { status: 400 })) as typeof fetch
  try {
    await assert.rejects(
      executeWebFetch({ url: 'https://example.com/article' }, { tavilyKey: 'tvly-test' }),
      (error: unknown) => {
        assert.equal(
          (error as { errorKind?: string }).errorKind,
          WEB_RESEARCH_ERROR_KINDS.webFetchFailed.code,
        )
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
