import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentRuntimeInvokeGate } from '../preload/agent-runtime-invoke-gate'
import type { AgentRuntimeReadinessSnapshot } from '../shared/ipc-contracts/agent-runtime-readiness'

test('agent runtime calls wait for the shared ready generation before invoking', async () => {
  let listener: ((snapshot: AgentRuntimeReadinessSnapshot) => void) | null = null
  const calls: string[] = []
  const gate = createAgentRuntimeInvokeGate({
    read: async () => ({ ready: false, bootGeneration: 0 }),
    subscribe(next) {
      listener = next
      return () => {
        listener = null
      }
    }
  })

  const first = gate.invoke(async () => {
    calls.push('registry')
    return 'registry-ok'
  })
  const second = gate.invoke(async () => {
    calls.push('scopes')
    return 'scopes-ok'
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, [])

  listener?.({ ready: true, bootGeneration: 1 })
  assert.deepEqual(await Promise.all([first, second]), ['registry-ok', 'scopes-ok'])
  assert.deepEqual(calls, ['registry', 'scopes'])
  gate.dispose()
})

test('agent runtime calls proceed when the pull snapshot is already ready', async () => {
  let invoked = 0
  const gate = createAgentRuntimeInvokeGate({
    read: async () => ({ ready: true, bootGeneration: 4 }),
    subscribe: () => () => {}
  })

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(
    await gate.invoke(async () => {
      invoked += 1
      return 'ok'
    }),
    'ok'
  )
  assert.equal(invoked, 1)
  gate.dispose()
})
