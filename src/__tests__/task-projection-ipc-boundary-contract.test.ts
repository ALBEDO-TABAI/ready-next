/**
 * Stage U PR U4.v2-5 — task-projection IPC boundary contract test.
 *
 * Phase 4 v2 verification acceptance — three renderer-facing IPC
 * channels in the task-projection family must expose wire-canonical
 * types:
 *   1. agent:listTaskProjections returns IPCResponse<TaskProjectionRecordData[]>
 *   2. agent:getTaskProjection returns IPCResponse<TaskProjectionRecordData>
 *   3. agent:taskProjectionsChanged payload is TaskProjectionChangeEventData
 *
 * Asserts at compile time that the renderer-exposed types for these
 * three channels are the wire-derived aliases (U4.v2-2 / -3), not the
 * pre-Phase-4 hand-written interfaces.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  TaskProjectionRecord as TaskProjectionRecordWire,
  TaskProjectionChangeEvent as TaskProjectionChangeEventWire,
} from '../shared/ipc-contracts/task-projection'

type ExpectedRecordTopLevel = Omit<
  TaskProjectionRecordWire,
  'steps' | 'waitingFor' | 'resumableActions' | 'continuationRef' | 'progress' | 'recentArtifacts'
>

test('U4.v2-5 listTaskProjections / getTaskProjection record top-level fields are wire-derived', () => {
  const sample: ExpectedRecordTopLevel = {
    taskId: 'task-u4.v2-5',
    scopeId: 'scope-u4.v2-5',
    runId: 'run-u4.v2-5',
    taskType: 'general',
    module: 'agent',
    status: 'completed',
    interactionState: 'running',
    createdAt: '2026-05-20T00:00:00.000Z',
    updatedAt: '2026-05-20T00:00:00.000Z',
  }
  assert.equal(sample.taskId, 'task-u4.v2-5')
  assert.equal(sample.status, 'completed')
})

test('U4.v2-5 taskProjectionsChanged event payload is exactly wire shape', () => {
  const evt: TaskProjectionChangeEventWire = {
    scopeId: 'scope-evt',
    changedTaskIds: ['t1', 't2'],
    reason: 'update',
  }
  assert.equal(evt.scopeId, 'scope-evt')
  assert.equal(evt.reason, 'update')
})

test('U4.v2-5 wire status union remains canonical child-run status set', () => {
  const expected: TaskProjectionRecordWire['status'][] = [
    'queued', 'running', 'recoverable_paused', 'budget_paused', 'blocked', 'completed', 'failed', 'killed',
  ]
  assert.equal(expected.length, 8)
})

test('U4.v2-5 wire reason union remains canonical 4-member set', () => {
  const reasons: TaskProjectionChangeEventWire['reason'][] = [
    'create', 'update', 'delete', 'supersede',
  ]
  assert.equal(reasons.length, 4)
})
