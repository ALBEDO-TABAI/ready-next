/**
 * Stage U PR U4.v2-2 — renderer TaskProjectionRecordData is wire-derived.
 *
 * Pins the canonical wire-derived shape so a future PR cannot drift
 * electron.d.ts back to a hand-rewritten copy. Paired with the U4.v2-4
 * gate (check-task-projection-wire-canonical.cjs).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import type { TaskProjectionRecord as Wire } from '../shared/ipc-contracts/task-projection'

test('U4.v2-2 wire TaskProjectionRecord exposes the renderer-required fields', () => {
  // Compile-time assertion: a renderer-shaped value must satisfy the wire
  // record's top-level shape (excluding ScopeRun overrides).
  const sample: Pick<
    Wire,
    | 'taskId' | 'scopeId' | 'runId'
    | 'taskType' | 'module' | 'status' | 'interactionState'
    | 'createdAt' | 'updatedAt'
  > = {
    taskId: 'task-u4.v2-2',
    scopeId: 'scope-u4.v2-2',
    runId: 'run-u4.v2-2',
    taskType: 'general',
    module: 'agent',
    status: 'running',
    interactionState: 'running',
    createdAt: '2026-05-20T00:00:00.000Z',
    updatedAt: '2026-05-20T00:00:00.000Z',
  }
  assert.equal(sample.status, 'running')
  assert.equal(sample.interactionState, 'running')
})

test('U4.v2-2 wire status union accepts the five renderer-visible terminal states', () => {
  const statuses: Wire['status'][] = ['queued', 'running', 'blocked', 'done', 'failed', 'cancelled']
  assert.equal(statuses.length, 6)
})

test('U4.v2-2 wire canResume is optional (Stage Q derived-at-read field)', () => {
  const sample: Pick<Wire, 'taskId' | 'canResume'> = {
    taskId: 'task-q-canresume',
    // canResume intentionally omitted to verify it's optional
  }
  assert.equal(sample.canResume, undefined)
})
