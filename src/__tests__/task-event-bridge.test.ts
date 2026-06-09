import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { taskEventBridge, type TaskEventBridgePayload } from '../main/modules/browser-engine/task-event-bridge'

describe('task event bridge', () => {
  it('exports a singleton bridge', () => {
    assert.equal(typeof taskEventBridge.publish, 'function')
    assert.equal(typeof taskEventBridge.scheduleTask, 'function')
  })

  it('publishes events to registered consumers', () => {
    const projectionEvents: TaskEventBridgePayload[] = []
    const agentEvents: TaskEventBridgePayload[] = []
    taskEventBridge.registerProjectionSink((payload) => projectionEvents.push(payload))
    taskEventBridge.registerAgentNotifier((payload) => agentEvents.push(payload))

    const payload: TaskEventBridgePayload = { taskId: 'task-event-bridge-consumers', status: 'completed', extra: { ok: true } }
    taskEventBridge.publish(payload)

    assert.deepEqual(projectionEvents, [payload])
    assert.deepEqual(agentEvents, [payload])
  })

  it('deduplicates repeated taskId and status publishes', () => {
    const events: TaskEventBridgePayload[] = []
    taskEventBridge.registerProjectionSink((payload) => events.push(payload))

    const payload: TaskEventBridgePayload = { taskId: 'task-event-bridge-idempotent', status: 'failed' }
    taskEventBridge.publish(payload)
    taskEventBridge.publish(payload)

    assert.deepEqual(events, [payload])
  })

  it('throws when scheduling a task for an unregistered route', () => {
    assert.throws(
      () => taskEventBridge.scheduleTask('task-event-bridge-missing-route', 'missing-route'),
      /missing-route/,
    )
  })
})
