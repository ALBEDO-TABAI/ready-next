import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ScopeCreatePersistenceMetricThrottle,
  type ScopeCreatePersistencePayload,
} from '../renderer/modules/agent/scope-create-persistence-metrics'

/**
 * Stage 3 W4 — pure-module tests for the renderer-side scope-create
 * persistence metric throttle. The module is intentionally free of React /
 * zustand / IPC, so we drive it directly with a manual clock and a captured
 * emit sink — no DOM, no electronAPI mock.
 */

function makeClock(initial = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = initial
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

function captureEmit(): {
  payloads: ScopeCreatePersistencePayload[]
  emit: (payload: ScopeCreatePersistencePayload) => void
} {
  const payloads: ScopeCreatePersistencePayload[] = []
  return { payloads, emit: (payload) => payloads.push(payload) }
}

test('ScopeCreatePersistenceMetricThrottle emits on first call and suppresses within cooldown', () => {
  const { payloads, emit } = captureEmit()
  const clock = makeClock()
  const throttle = new ScopeCreatePersistenceMetricThrottle(5 * 60_000, clock.now, emit)

  assert.equal(throttle.maybeEmit('newSession', 'ipc_rejected', 'scope-A', 'assistant'), true)
  clock.advance(60_000) // 1 min in: still suppressed
  assert.equal(throttle.maybeEmit('newSession', 'ipc_rejected', 'scope-A', 'assistant'), false)
  clock.advance(4 * 60_000 - 1) // 4:59.999 in: still suppressed
  assert.equal(throttle.maybeEmit('newSession', 'ipc_rejected', 'scope-A', 'assistant'), false)
  assert.equal(payloads.length, 1, 'only one emission within the 5min window')
  assert.equal(payloads[0].site, 'newSession')
  assert.equal(payloads[0].reason, 'ipc_rejected')
  assert.equal(payloads[0].scopeId, 'scope-A')
  assert.equal(payloads[0].agent, 'assistant')
})

test('ScopeCreatePersistenceMetricThrottle re-emits after cooldown elapses', () => {
  const { payloads, emit } = captureEmit()
  const clock = makeClock()
  const throttle = new ScopeCreatePersistenceMetricThrottle(5 * 60_000, clock.now, emit)

  throttle.maybeEmit('newSession', 'ipc_rejected', 'scope-A', 'assistant')
  clock.advance(5 * 60_000) // exactly at boundary, condition is `< cooldown`, so this re-fires
  assert.equal(throttle.maybeEmit('newSession', 'ipc_rejected', 'scope-A', 'assistant'), true)
  clock.advance(10 * 60_000)
  assert.equal(throttle.maybeEmit('newSession', 'ipc_rejected', 'scope-A', 'assistant'), true)
  assert.equal(payloads.length, 3)
})

test('ScopeCreatePersistenceMetricThrottle keys throttle bucket by agent × scopeId × site × reason', () => {
  const { payloads, emit } = captureEmit()
  const clock = makeClock()
  const throttle = new ScopeCreatePersistenceMetricThrottle(5 * 60_000, clock.now, emit)

  // Same key collapses
  assert.equal(throttle.maybeEmit('newSession', 'ipc_rejected', 'scope-A', 'assistant'), true)
  assert.equal(throttle.maybeEmit('newSession', 'ipc_rejected', 'scope-A', 'assistant'), false)
  // Different agent
  assert.equal(throttle.maybeEmit('newSession', 'ipc_rejected', 'scope-A', 'manager'), true)
  // Different scopeId
  assert.equal(throttle.maybeEmit('newSession', 'ipc_rejected', 'scope-B', 'assistant'), true)
  // Different site
  assert.equal(throttle.maybeEmit('sendMessage_ensure', 'ipc_rejected', 'scope-A', 'assistant'), true)
  // Different reason
  assert.equal(throttle.maybeEmit('newSession', 'result_failure', 'scope-A', 'assistant'), true)
  // null scopeId collapses with another null scopeId for same agent+site+reason
  assert.equal(throttle.maybeEmit('newSession', 'result_failure', null, 'assistant'), true)
  assert.equal(throttle.maybeEmit('newSession', 'result_failure', null, 'assistant'), false, 'null scopeId shares one bucket')
  assert.equal(payloads.length, 6)
})

test('ScopeCreatePersistenceMetricThrottle forwards payload fields verbatim to emit', () => {
  const { payloads, emit } = captureEmit()
  const clock = makeClock()
  const throttle = new ScopeCreatePersistenceMetricThrottle(5 * 60_000, clock.now, emit)

  throttle.maybeEmit('sendMessage_agent_mismatch', 'result_failure', 'scope-XYZ', 'designer')

  assert.equal(payloads.length, 1)
  assert.deepEqual(payloads[0], {
    site: 'sendMessage_agent_mismatch',
    reason: 'result_failure',
    scopeId: 'scope-XYZ',
    agent: 'designer',
  })
})
