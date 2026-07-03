/**
 * Stage R W1.6 落点 15 — TaskType single source.
 *
 * Asserts:
 *   1. shared/task-types.ts TASK_TYPES is a 6-element readonly tuple
 *   2. isTaskType type guard accepts 'research' and rejects unknown literals
 *   3. renderer toAgentModule('research') normalizes correctly
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { TASK_TYPES, isTaskType } from '../shared/task-types'
import { toAgentModule } from '../renderer/modules/agent/scopeRunState'

test('TASK_TYPES is a 7-element list', () => {
  assert.equal(TASK_TYPES.length, 7)
  // Order doesn't matter for membership but matters for the contract:
  // direct_answer / short_task / multi_step_task / media_task / browser_transaction / continuation / research
  const set = new Set(TASK_TYPES as readonly string[])
  for (const t of ['direct_answer', 'short_task', 'multi_step_task', 'media_task', 'browser_transaction', 'continuation', 'research']) {
    assert.ok(set.has(t), `TASK_TYPES must include ${t}`)
  }
})

test('isTaskType accepts research and rejects unknown literals', () => {
  assert.equal(isTaskType('research'), true)
  assert.equal(isTaskType('direct_answer'), true)
  assert.equal(isTaskType('foo'), false)
  assert.equal(isTaskType(null), false)
  assert.equal(isTaskType(undefined), false)
})

test('toAgentModule normalizes "research" rather than dropping to null', () => {
  assert.equal(toAgentModule('research'), 'research')
  assert.equal(toAgentModule('browser'), 'browser')
  // Unknown values must drop to null (current behavior)
  assert.equal(toAgentModule('unknown_module'), null)
})
