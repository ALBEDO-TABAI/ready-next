import assert from 'node:assert/strict'
import test from 'node:test'

import { createWorkerSessionIdentity } from '../main/modules/agent-control/worker-session'

test('createWorkerSessionIdentity generates a child task id and isolated worker session id', () => {
  const first = createWorkerSessionIdentity({
    scopeId: 'scope-1',
    parentTaskId: 'parent-1',
    parentStepId: 'job-1',
  })
  const second = createWorkerSessionIdentity({
    scopeId: 'scope-1',
    parentTaskId: 'parent-1',
    parentStepId: 'job-1',
  })

  assert.equal(first.parentTaskId, 'parent-1')
  assert.equal(first.parentStepId, 'job-1')
  assert.notEqual(first.taskId, 'parent-1')
  assert.notEqual(first.workerSessionId, 'scope-1')
  assert.notEqual(first.taskId, second.taskId)
  assert.notEqual(first.workerSessionId, second.workerSessionId)
  assert.match(first.workerSessionId, /worker/i)
})
