import assert from 'node:assert/strict'
import test from 'node:test'

import { createDebouncedFetch } from '../renderer/modules/agent/debouncedFetch'

/**
 * Stage O §1.1 — `createDebouncedFetch` collapses bursts of push events
 * into a single fetch. `cancel()` is required so the effect cleanup can
 * neutralise a pending timer; without it, an unmounted component would
 * still trigger a fetch.
 */

test('multiple run() within delay coalesce to a single fn() call', async () => {
  let calls = 0
  const debouncer = createDebouncedFetch(() => { calls += 1 }, 30)
  debouncer.run()
  debouncer.run()
  debouncer.run()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(calls, 1)
})

test('cancel() before the timer fires neutralises the pending call', async () => {
  let calls = 0
  const debouncer = createDebouncedFetch(() => { calls += 1 }, 30)
  debouncer.run()
  debouncer.cancel()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(calls, 0)
})

test('cancel() is safe when no run() is pending', () => {
  const debouncer = createDebouncedFetch(() => {}, 30)
  // Should not throw.
  debouncer.cancel()
  debouncer.cancel()
})

test('run() after cancel() schedules a fresh call', async () => {
  let calls = 0
  const debouncer = createDebouncedFetch(() => { calls += 1 }, 20)
  debouncer.run()
  debouncer.cancel()
  debouncer.run()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(calls, 1)
})
