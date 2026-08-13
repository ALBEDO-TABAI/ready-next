import assert from 'node:assert/strict'
import test from 'node:test'

import { TaskEventProofSubscription } from '../main/modules/agent-control/runtime-core/task-event-proof-subscription'
import { taskEventBridge } from '../main/modules/browser-engine/task-event-bridge'

test('proof subscription is replaced and removed across runtime restart lifecycle', () => {
  let writes = 0
  const store = {
    get: (taskId: string) => ({ taskId, proofRefs: [], revision: 0 }),
    update: () => { writes += 1 },
  }
  const subscription = new TaskEventProofSubscription()
  try {
    subscription.start(store)
    subscription.start(store)
    taskEventBridge.publish({ taskId: 'proof-subscription-restart', status: 'paused' })
    assert.equal(writes, 1, 'restart replaces the previous global sink')

    subscription.stop()
    taskEventBridge.publish({ taskId: 'proof-subscription-stopped', status: 'paused' })
    assert.equal(writes, 1, 'stopped runtime receives no task event')

    subscription.start(store)
    taskEventBridge.publish({ taskId: 'proof-subscription-next-runtime', status: 'paused' })
    assert.equal(writes, 2, 'next runtime owns exactly one sink')
  } finally {
    subscription.stop()
  }
})
