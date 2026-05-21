/**
 * Stage S W8.1 — L2 layered compactor stub behavior test.
 *
 * Asserts the noop hook returns the empty preserve preview shape
 * { preserved: [], truncated: [] } without inspecting the messages.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  noopBeforeSummarizationHook,
  type BeforeSummarizationHookContext,
  type SkillBundlePreservePreview,
} from '../main/modules/agent-control/compaction/layered-compactor-l2-stub'

test('noopBeforeSummarizationHook returns empty preserved/truncated arrays', () => {
  const ctx: BeforeSummarizationHookContext = { messages: [] }
  const result: SkillBundlePreservePreview = noopBeforeSummarizationHook(ctx)
  assert.deepEqual(result, { preserved: [], truncated: [] })
})

test('noopBeforeSummarizationHook ignores non-empty message bundle', () => {
  const ctx: BeforeSummarizationHookContext = {
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ],
  }
  const result = noopBeforeSummarizationHook(ctx)
  assert.deepEqual(result, { preserved: [], truncated: [] })
})

test('noopBeforeSummarizationHook returns fresh arrays on each call', () => {
  const ctx: BeforeSummarizationHookContext = { messages: [] }
  const a = noopBeforeSummarizationHook(ctx)
  const b = noopBeforeSummarizationHook(ctx)
  // Different array identity per call, so callers can mutate safely.
  assert.notStrictEqual(a.preserved, b.preserved)
  assert.notStrictEqual(a.truncated, b.truncated)
})
