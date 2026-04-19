import assert from 'node:assert/strict'
import test from 'node:test'

import {
  raceWithTimeout,
  throwIfAborted,
} from '../main/modules/agent-control/document-task-tool-timing'

test('throwIfAborted throws AbortError when signal is already aborted', () => {
  const controller = new AbortController()
  controller.abort()
  try {
    throwIfAborted(controller.signal, 'document.insertWidget')
    assert.fail('expected AbortError to be thrown')
  } catch (err) {
    assert.ok(err instanceof DOMException)
    assert.equal((err as DOMException).name, 'AbortError')
  }
})

test('raceWithTimeout resolves immediately for a settled promise well before the timeout', async () => {
  const controller = new AbortController()
  const result = await raceWithTimeout(
    Promise.resolve({ ok: true }),
    controller.signal,
    5_000,
    'document.listWidgets',
  )
  assert.deepEqual(result, { ok: true })
})

test('raceWithTimeout rejects within ~100ms when the signal aborts mid-flight on a long-running tool call', async () => {
  const controller = new AbortController()
  // A pending promise that never resolves on its own — simulates a renderer that
  // accepted the tool request and is sitting on it while we decide to preempt.
  const pending = new Promise<never>(() => { /* never resolves */ })

  const race = raceWithTimeout(pending, controller.signal, 30_000, 'document.insertWidget')
  const startedAt = Date.now()
  setTimeout(() => controller.abort(), 20)

  await assert.rejects(race, (err: unknown) => {
    assert.ok(err instanceof DOMException)
    assert.equal((err as DOMException).name, 'AbortError')
    const elapsed = Date.now() - startedAt
    assert.ok(elapsed < 500, `expected abort-driven reject to happen fast, took ${elapsed}ms`)
    return true
  })
})

test('raceWithTimeout rejects with a timeout error when the tool call never returns', async () => {
  const pending = new Promise<never>(() => { /* never resolves */ })
  await assert.rejects(
    raceWithTimeout(pending, null, 40, 'document.saveTab'),
    /timed out after 40ms/i,
  )
})
