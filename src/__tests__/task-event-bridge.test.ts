import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isTaskEventBridgeStatus, taskEventBridge, toBridgeStatus, type TaskEventBridgePayload } from '../main/modules/browser-engine/task-event-bridge'
import type { BrowserCapabilityTaskStatus } from '../main/modules/browser-engine/capability-types'

describe('task event bridge', () => {
  it('exports a singleton bridge', () => {
    assert.equal(typeof taskEventBridge.publish, 'function')
    assert.equal(typeof taskEventBridge.scheduleTask, 'function')
  })

  it('maps persisted browser task statuses to bridge publish statuses explicitly', () => {
    const cases: Array<[BrowserCapabilityTaskStatus, ReturnType<typeof toBridgeStatus>]> = [
      ['queued', null],
      ['running', null],
      ['waiting_human', 'waiting_human'],
      ['paused', 'paused'],
      ['completed', 'completed'],
      ['failed', 'failed'],
      ['cancelled', null],
    ]

    for (const [status, expected] of cases) {
      assert.equal(toBridgeStatus(status), expected)
    }
    assert.equal(cases.some(([status]) => toBridgeStatus(status) === 'needs_attention'), false)
    assert.equal(isTaskEventBridgeStatus('needs_attention'), true)
    assert.equal(isTaskEventBridgeStatus('cancelled'), false)
  })

  it('publishes events to registered consumers', () => {
    const projectionEvents: TaskEventBridgePayload[] = []
    const unregister = taskEventBridge.registerProjectionSink((payload) => projectionEvents.push(payload))

    const payload: TaskEventBridgePayload = { taskId: 'task-event-bridge-consumers', status: 'completed', extra: { ok: true } }
    try {
      taskEventBridge.publish(payload)
    } finally {
      unregister()
    }

    assert.deepEqual(projectionEvents, [payload])
    assert.equal('registerAgentNotifier' in taskEventBridge, false)
  })

  it('deduplicates repeated terminal taskId and status publishes', () => {
    const events: TaskEventBridgePayload[] = []
    const unregister = taskEventBridge.registerProjectionSink((payload) => events.push(payload))

    const payload: TaskEventBridgePayload = { taskId: 'task-event-bridge-idempotent', status: 'failed' }
    try {
      taskEventBridge.publish(payload)
      taskEventBridge.publish(payload)
    } finally {
      unregister()
    }

    assert.deepEqual(events, [payload])
  })

  it('bounds terminal dedupe memory while retaining recent duplicate protection', () => {
    const recent: TaskEventBridgePayload = {
      taskId: 'task-event-bridge-bounded-recent',
      status: 'completed',
    }
    for (let index = 0; index < 10_000; index += 1) {
      taskEventBridge.publish({
        taskId: `task-event-bridge-bounded-${index}`,
        status: 'completed',
      })
    }
    const events: TaskEventBridgePayload[] = []
    const unregister = taskEventBridge.registerProjectionSink((payload) => events.push(payload))
    try {
      taskEventBridge.publish(recent)
      taskEventBridge.publish(recent)
      taskEventBridge.publish({ taskId: 'task-event-bridge-bounded-0', status: 'completed' })
      for (let index = 0; index < 10_000; index += 1) {
        taskEventBridge.publish({ taskId: `task-event-bridge-paused-${index}`, status: 'paused' })
      }
    } finally {
      unregister()
    }

    const state = taskEventBridge as unknown as { publishedKeys: Set<string> }
    assert.equal(state.publishedKeys.size, 2_048)
    assert.deepEqual(events.slice(0, 2), [
      recent,
      { taskId: 'task-event-bridge-bounded-0', status: 'completed' },
    ])
    assert.equal(events.length, 10_002, 'non-terminal events remain re-enterable without consuming dedupe capacity')
  })

  it('allows re-enterable statuses through the bridge repeatedly', () => {
    const events: TaskEventBridgePayload[] = []
    const unregister = taskEventBridge.registerProjectionSink((payload) => events.push(payload))

    const paused: TaskEventBridgePayload = { taskId: 'task-event-bridge-reentrant', status: 'paused' }
    const needsAttention: TaskEventBridgePayload = { taskId: 'task-event-bridge-reentrant', status: 'needs_attention' }
    try {
      taskEventBridge.publish(paused)
      taskEventBridge.publish(paused)
      taskEventBridge.publish(needsAttention)
      taskEventBridge.publish(needsAttention)
    } finally {
      unregister()
    }

    assert.deepEqual(events, [paused, paused, needsAttention, needsAttention])
  })

  it('throws when scheduling a task for an unregistered route', () => {
    assert.throws(
      () => taskEventBridge.scheduleTask('task-event-bridge-missing-route', 'missing-route'),
      /missing-route/,
    )
  })

})
