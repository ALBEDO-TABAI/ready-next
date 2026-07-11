import assert from 'node:assert/strict'
import test from 'node:test'

import type { TaskProjectionRecord } from '../shared/ipc-contracts/task-projection'
import {
  parseDeliveryStateJson,
  type DeliveryMode,
  type DeliveryStateV1,
} from '../shared/dynamic-delivery'

function validState(): DeliveryStateV1 {
  return {
    version: 1,
    stateRevision: 3,
    decision: 'verify_only',
    parentGeneration: 2,
    packages: [],
    verifier: { status: 'pending', repaired: false },
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      usageSource: 'provider',
      providerCallCount: 1,
      missingCallCount: 0,
    },
  }
}

test('delivery state JSON round-trips without losing its strict versioned shape', () => {
  const state = validState()
  assert.deepEqual(parseDeliveryStateJson(JSON.stringify(state)), state)
})

test('delivery state parser fails loudly on malformed JSON, unknown versions and invalid state', () => {
  assert.throws(() => parseDeliveryStateJson('{broken'), /delivery state|json/i)
  assert.throws(
    () => parseDeliveryStateJson(JSON.stringify({ ...validState(), version: 2 })),
    /version/i,
  )
  assert.throws(
    () => parseDeliveryStateJson(JSON.stringify({ ...validState(), verifier: { status: 'accepted', repaired: 'yes' } })),
    /delivery state|invalid|repaired/i,
  )
})

test('typed mode and read-only projection delivery state are present on the shared wire', () => {
  const modes: DeliveryMode[] = ['standard', 'adaptive', 'thorough']
  assert.deepEqual(modes, ['standard', 'adaptive', 'thorough'])

  const projection = {
    deliveryState: validState(),
  } as Pick<TaskProjectionRecord, 'deliveryState'>
  assert.equal(projection.deliveryState?.decision, 'verify_only')
})
