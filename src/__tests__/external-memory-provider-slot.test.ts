import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ExternalMemoryProviderSlot,
  type ExternalMemoryProvider
} from '../main/modules/agent-control/memory/external-memory-provider-slot'

test('external memory provider slot only accepts one active provider and forwards lifecycle hooks', async () => {
  const events: string[] = []
  const slot = new ExternalMemoryProviderSlot()

  const providerA: ExternalMemoryProvider = {
    id: 'provider-a',
    async initialize() {
      events.push('init:a')
    },
    async shutdown() {
      events.push('shutdown:a')
    }
  }

  const providerB: ExternalMemoryProvider = {
    id: 'provider-b'
  }

  await slot.register(providerA)
  assert.equal(slot.getActiveProvider()?.id, 'provider-a')
  assert.deepEqual(events, ['init:a'])

  await assert.rejects(() => slot.register(providerB), /already active/i)

  await slot.shutdown()
  assert.equal(slot.getActiveProvider(), null)
  assert.deepEqual(events, ['init:a', 'shutdown:a'])
})
