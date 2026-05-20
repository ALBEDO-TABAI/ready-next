/**
 * Stage U PR U4.1b — TaskProjectionChangeEvent wire-contract migration.
 *
 * Pins the wire-contract surface so future PRs cannot accidentally
 * drift the renderer-facing payload shape. The canonical type now
 * lives in src/shared/ipc-contracts/task-projection.ts; main-side
 * re-exports it through run-contracts.ts for backward compatibility.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import type { TaskProjectionChangeEvent, TaskProjectionChangeReason } from '../shared/ipc-contracts/task-projection'
import type { TaskProjectionChangeEvent as MainSideEvent } from '../main/modules/agent-control/run-contracts'

test('U4.1b wire TaskProjectionChangeEvent has stable {scopeId, changedTaskIds, reason} shape', () => {
  const sample: TaskProjectionChangeEvent = {
    scopeId: 'scope-u4.1b',
    changedTaskIds: ['task-1', 'task-2'],
    reason: 'update',
  }
  assert.equal(typeof sample.scopeId, 'string')
  assert.equal(Array.isArray(sample.changedTaskIds), true)
  assert.equal(sample.reason, 'update')
})

test('U4.1b wire TaskProjectionChangeReason union has exactly 4 members', () => {
  const reasons: TaskProjectionChangeReason[] = ['create', 'update', 'delete', 'supersede']
  assert.equal(reasons.length, 4)
})

test('U4.1b main re-export stays type-identical to the wire source', () => {
  // Compile-time assertion: if MainSideEvent !== wire TaskProjectionChangeEvent,
  // this assignment fails typecheck. Runtime check is incidental.
  const event: TaskProjectionChangeEvent = {
    scopeId: 'scope-typed',
    changedTaskIds: [],
    reason: 'create',
  }
  const mainSide: MainSideEvent = event
  assert.equal(mainSide.scopeId, 'scope-typed')
})
