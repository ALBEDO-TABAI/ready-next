import assert from 'node:assert/strict'
import test from 'node:test'

import { AttachmentLoadFailureThrottle } from '../main/modules/claude-bridge/direct-chat-attachment-metrics'
import {
  __setMetricSinkForTests,
  type AgentMetricEvent,
} from '../main/modules/agent-control/metrics'

function captureMetrics(): { events: AgentMetricEvent[]; restore: () => void } {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  return { events, restore: () => __setMetricSinkForTests(null) }
}

/**
 * Manual clock so tests don't sleep.
 */
function makeClock(initial = 1_000_000): {
  now: () => number
  advance: (ms: number) => void
} {
  let t = initial
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

test('AttachmentLoadFailureThrottle emits on first call and suppresses within cooldown', () => {
  const { events, restore } = captureMetrics()
  const clock = makeClock()
  try {
    const throttle = new AttachmentLoadFailureThrottle(60_000, clock.now)
    assert.equal(throttle.maybeEmit('sess-A', 'db_error'), true, 'first emits')
    clock.advance(30_000)
    assert.equal(throttle.maybeEmit('sess-A', 'db_error'), false, '30s in: suppressed')
    clock.advance(29_999)
    assert.equal(throttle.maybeEmit('sess-A', 'db_error'), false, '59.999s in: still suppressed')
    const emitted = events.filter((e) => e.metric === 'attachment_load_failed')
    assert.equal(emitted.length, 1, 'only one emission within window')
    assert.equal(emitted[0].sessionId, 'sess-A')
    assert.equal(emitted[0].reason, 'db_error')
  } finally {
    restore()
  }
})

test('AttachmentLoadFailureThrottle re-emits after cooldown elapses', () => {
  const { events, restore } = captureMetrics()
  const clock = makeClock()
  try {
    const throttle = new AttachmentLoadFailureThrottle(60_000, clock.now)
    throttle.maybeEmit('sess-A', 'db_error')
    clock.advance(60_000) // exactly at boundary, condition is `< cooldown`, so this re-fires
    assert.equal(throttle.maybeEmit('sess-A', 'db_error'), true, 'at boundary: re-emits')
    clock.advance(120_000)
    assert.equal(throttle.maybeEmit('sess-A', 'db_error'), true, '2min later: re-emits')
    assert.equal(events.filter((e) => e.metric === 'attachment_load_failed').length, 3)
  } finally {
    restore()
  }
})

test('AttachmentLoadFailureThrottle keys throttle bucket by sessionId', () => {
  const { events, restore } = captureMetrics()
  const clock = makeClock()
  try {
    const throttle = new AttachmentLoadFailureThrottle(60_000, clock.now)
    assert.equal(throttle.maybeEmit('sess-A', 'db_error'), true)
    assert.equal(throttle.maybeEmit('sess-B', 'db_error'), true, 'different session: independent bucket')
    assert.equal(throttle.maybeEmit('sess-A', 'db_error'), false, 'sess-A: still suppressed')
    const emitted = events.filter((e) => e.metric === 'attachment_load_failed')
    assert.equal(emitted.length, 2)
    assert.deepEqual(
      emitted.map((e) => e.sessionId).sort(),
      ['sess-A', 'sess-B'],
    )
  } finally {
    restore()
  }
})

test('AttachmentLoadFailureThrottle collapses empty/undefined sessionId into one bucket', () => {
  const { events, restore } = captureMetrics()
  const clock = makeClock()
  try {
    const throttle = new AttachmentLoadFailureThrottle(60_000, clock.now)
    assert.equal(throttle.maybeEmit(undefined, 'db_error'), true)
    assert.equal(throttle.maybeEmit('', 'db_error'), false, 'empty string shares <no-session> bucket')
    assert.equal(throttle.maybeEmit(undefined, 'db_error'), false, 'undefined shares <no-session> bucket')
    const emitted = events.filter((e) => e.metric === 'attachment_load_failed')
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].sessionId, null, 'sessionId payload normalized to null')
  } finally {
    restore()
  }
})

test('AttachmentLoadFailureThrottle forwards extra payload fields verbatim', () => {
  const { events, restore } = captureMetrics()
  const clock = makeClock()
  try {
    const throttle = new AttachmentLoadFailureThrottle(60_000, clock.now)
    throttle.maybeEmit('sess-A', 'db_error', { message: 'SQLITE_BUSY' })
    const emitted = events.filter((e) => e.metric === 'attachment_load_failed')
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].message, 'SQLITE_BUSY')
  } finally {
    restore()
  }
})
