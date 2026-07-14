import assert from 'node:assert/strict'
import test from 'node:test'

import { createLatestFrameScheduler } from '../renderer/components/graph/graph-frame-scheduler'

test('high-frequency graph input commits only the latest value once per frame', () => {
  const callbacks = new Map<number, FrameRequestCallback>()
  const committed: number[] = []
  let nextHandle = 1
  const scheduler = createLatestFrameScheduler(
    (value: number) => committed.push(value),
    (callback) => {
      const handle = nextHandle++
      callbacks.set(handle, callback)
      return handle
    },
    (handle) => { callbacks.delete(handle) },
  )

  for (let value = 1; value <= 10; value += 1) scheduler.schedule(value)
  assert.equal(callbacks.size, 1)
  callbacks.values().next().value?.(0)
  assert.deepEqual(committed, [10])
})

test('flushing a pending drag commits its latest point before release', () => {
  const callbacks = new Map<number, FrameRequestCallback>()
  const events: string[] = []
  const scheduler = createLatestFrameScheduler(
    (value: string) => events.push(`pin:${value}`),
    (callback) => {
      callbacks.set(1, callback)
      return 1
    },
    () => { callbacks.clear() },
  )

  scheduler.schedule('first')
  scheduler.schedule('latest')
  scheduler.flush()
  events.push('release')
  assert.deepEqual(events, ['pin:latest', 'release'])
  assert.equal(callbacks.size, 0)
})
