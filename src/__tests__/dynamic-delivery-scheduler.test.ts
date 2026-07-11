import assert from 'node:assert/strict'
import test from 'node:test'

import { DynamicDeliveryPacketScheduler } from '../main/modules/agent-control/runtime-core/dynamic-delivery/packet-scheduler'

test('scheduler turns a fourth concurrent spawn into an explicit capacity settlement', async () => {
  const scheduler = new DynamicDeliveryPacketScheduler()
  assert.equal(DynamicDeliveryPacketScheduler.hardCap(), 3)
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  for (const packageId of ['pkg-1', 'pkg-2', 'pkg-3', 'pkg-4']) {
    scheduler.schedule(packageId, async () => { await gate; return packageId })
  }
  release()
  const results = await scheduler.awaitAll()
  assert.equal(results.length, 4)
  assert.deepEqual(results.find((result) => result.packageId === 'pkg-4'), {
    packageId: 'pkg-4', status: 'capacity_exceeded', reason: 'delivery_scheduler_capacity_exceeded',
  })
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3)
})

test('scheduler preserves package identity for rejected branches', async () => {
  const scheduler = new DynamicDeliveryPacketScheduler()
  scheduler.schedule('pkg-failed', async () => { throw new Error('worker failed') })
  const [result] = await scheduler.awaitAll()
  assert.equal(result?.packageId, 'pkg-failed')
  assert.equal(result?.status, 'failed')
  assert.match(String(result && 'reason' in result ? result.reason : ''), /worker failed/)
})

test('parent cancellation aborts every active worker and settles without a late success', async () => {
  const parent = new AbortController()
  const scheduler = new DynamicDeliveryPacketScheduler({ parentSignal: parent.signal })
  const observedSignals: AbortSignal[] = []
  scheduler.schedule('pkg-completed-before-abort', async (signal) => {
    observedSignals.push(signal)
    return 'must be discarded'
  })
  scheduler.schedule('pkg-active-at-abort', (signal) => {
    observedSignals.push(signal)
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })

  await Promise.resolve()
  parent.abort(new DOMException('parent stopped', 'AbortError'))
  const results = await scheduler.awaitAll()

  assert.equal(observedSignals.length, 2)
  assert.equal(observedSignals[1]?.aborted, true, 'the still-active worker receives the parent abort')
  assert.ok(results.every((result) => result.status === 'failed'))
})
