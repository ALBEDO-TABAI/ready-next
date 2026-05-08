/**
 * Stage R W5.1 — RUN_SPAN_METADATA_KEYS frozen list.
 *
 * Asserts the canonical 6 metadata keys are present in the right order.
 * Adding a new key must (a) extend this list and (b) update
 * `check-run-span-metadata-keys-frozen.cjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RUN_SPAN_METADATA_KEYS,
  buildRunSpanMetadata,
} from '../main/modules/agent-control/run-span-metadata'

test('RUN_SPAN_METADATA_KEYS is exactly 6 keys', () => {
  assert.equal(RUN_SPAN_METADATA_KEYS.length, 6)
  assert.deepEqual(
    [...RUN_SPAN_METADATA_KEYS],
    ['agent_id', 'model', 'capability_class', 'parent_run_id', 'task_type', 'session_id'],
  )
})

test('buildRunSpanMetadata only forwards declared keys', () => {
  // @ts-expect-error — extra_key not in RunSpanMetadataKey
  const out = buildRunSpanMetadata({ agent_id: 'a1', model: 'gpt-4', extra_key: 'noop' })
  assert.equal(out.agent_id, 'a1')
  assert.equal(out.model, 'gpt-4')
  // @ts-expect-error — extra_key shouldn't surface
  assert.equal(out.extra_key, undefined)
})
