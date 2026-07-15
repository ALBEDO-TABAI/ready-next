import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createDeferredSnapshotRefresh,
  type DeferredSnapshotRefreshHost,
} from '../renderer/modules/file-emergence/deferredSnapshotRefresh'

function makeHost(withIdle: boolean) {
  let nextId = 1
  const callbacks = new Map<number, () => void>()
  const cancelled: number[] = []
  const host: DeferredSnapshotRefreshHost = {
    setTimeout: (callback) => {
      const id = nextId++
      callbacks.set(id, callback)
      return id
    },
    clearTimeout: (id) => {
      cancelled.push(id)
      callbacks.delete(id)
    },
  }
  if (withIdle) {
    host.requestIdleCallback = (callback) => {
      const id = nextId++
      callbacks.set(id, callback)
      return id
    }
    host.cancelIdleCallback = (id) => {
      cancelled.push(id)
      callbacks.delete(id)
    }
  }
  return { host, callbacks, cancelled }
}

test('activity refreshes coalesce and run only after the latest idle callback', () => {
  const { host, callbacks, cancelled } = makeHost(true)
  let refreshes = 0
  const scheduler = createDeferredSnapshotRefresh(() => { refreshes += 1 }, host)

  scheduler.schedule()
  const firstId = [...callbacks.keys()][0]
  scheduler.schedule()
  const secondId = [...callbacks.keys()][0]

  assert.deepEqual(cancelled, [firstId])
  assert.notEqual(secondId, firstId)
  callbacks.get(secondId)?.()
  assert.equal(refreshes, 1)
})

test('fallback timer remains cancellable when idle scheduling is unavailable', () => {
  const { host, callbacks } = makeHost(false)
  let refreshes = 0
  const scheduler = createDeferredSnapshotRefresh(() => { refreshes += 1 }, host)

  scheduler.schedule()
  scheduler.cancel()
  for (const callback of callbacks.values()) callback()

  assert.equal(refreshes, 0)
})
