import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertTaskExecutionBinding,
  resolveTaskOwner,
  runOriginForRequest,
} from '../main/modules/agent-control/task-projection/task-agent-binding'

test('new root tasks use the conversation active agent and continuations use the target task owner', () => {
  assert.deepEqual(resolveTaskOwner({
    taskOrigin: 'user_root',
    conversationActiveAgentId: 'copywriter',
  }), { ownerAgentId: 'copywriter', source: 'conversation_active' })
  assert.deepEqual(resolveTaskOwner({
    taskOrigin: 'user_root',
    conversationActiveAgentId: 'butler',
    continuationOwnerAgentId: 'analyst',
  }), { ownerAgentId: 'analyst', source: 'continuation' })
})

test('registered and ephemeral bindings cannot borrow each other identity fields', () => {
  const registered = assertTaskExecutionBinding({
    schemaVersion: 1,
    runId: 'run-1',
    ownerAgentIdAtStart: 'butler',
    runOrigin: 'workflow_participant',
    kind: 'registered_agent',
    requestedAgentId: 'analyst',
    effectiveAgentId: 'analyst',
    executionMaterialHash: 'hash',
    ownerAssignmentSource: 'parent_task',
    executionSelectionSource: 'workflow_participant',
    resolutionKind: 'direct',
  })
  assert.equal(registered.effectiveAgentId, 'analyst')
  assert.throws(() => assertTaskExecutionBinding({
    ...registered,
    kind: 'ephemeral',
    ephemeralRole: 'reviewer',
  }), /invalid ephemeral binding/)
})

test('run origin is independent from immutable task creation origin', () => {
  assert.equal(runOriginForRequest({}), 'initial')
  assert.equal(runOriginForRequest({ isContinuation: true }), 'continuation')
  assert.equal(runOriginForRequest({ isHandoffTakeover: true, isContinuation: true }), 'handoff_takeover')
  assert.equal(runOriginForRequest({ isScheduledTask: true }), 'scheduled_task')
})
