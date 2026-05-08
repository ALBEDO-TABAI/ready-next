/**
 * Stage S — provider parity sanity test.
 *
 * Asserts the 7 builtin provider IDs are present in `AI_PROVIDERS` and
 * each carries a `capabilityClass` (Stage S PR-S2 contract).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { AI_PROVIDERS } from '../shared/ai-providers'

test('Stage S — all 7 builtin providers present', () => {
  const ids = AI_PROVIDERS.map((p) => p.id).sort()
  const expected = [
    'anthropic',
    'fox',
    'gemini',
    'moonshot',
    'openai',
    'openai-compatible',
    'volcengine',
  ].sort()
  assert.deepEqual(ids, expected)
})

test('Stage S — every provider has capabilityClass', () => {
  for (const p of AI_PROVIDERS) {
    assert.ok(p.capabilityClass, `provider ${p.id} missing capabilityClass`)
  }
})
