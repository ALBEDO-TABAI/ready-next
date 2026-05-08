import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveTaskCardRuntimeState } from '../renderer/modules/agent/taskCardViewModel'
import type { TaskCardRunLike } from '../renderer/modules/agent/taskCardViewModel'

/**
 * Stage O §1.3 / §5.1 — pin the contract that projection wins over
 * scope-run state when the two disagree. This is the "failed被running盖住"
 * regression-prevention test referenced in plan §C.
 *
 * The renderer's `mergedTaskRuns` builds `TaskCardRun.status` from
 * `projection?.status`; whitelist fields (phase / terminalReason) come
 * from the scope-run summary. Even when phase says "running", the
 * runtime state derives from `status`, `waitingFor`, and `terminalReason`,
 * so projection.status='failed' must rule.
 *
 * This test exercises `deriveTaskCardRuntimeState` against a card
 * built as if `mergedTaskRuns` had fed it both signals — a transient
 * `phase='tool_running'` overlapping with a projection that has already
 * recorded `status='failed'` and no live background work.
 */

function makeRun(partial: Partial<TaskCardRunLike>): TaskCardRunLike {
  return {
    scopeId: 's1',
    title: 't',
    phase: 'tool_running',
    updatedAt: new Date().toISOString(),
    ...partial,
  }
}

test('projection.status=failed wins over phase=tool_running (no live background)', () => {
  // Mirror what `mergedTaskRuns` would produce when the projection has
  // landed `failed` but the scope-run-event for that turn briefly
  // reported phase='tool_running'. The card MUST surface as failed.
  const run = makeRun({
    phase: 'tool_running',
    status: 'failed',
    // No background signals — failed wins outright.
    waitingFor: 'none',
    terminalReason: undefined,
    taskContinuation: null,
    canResume: true,
  })
  const state = deriveTaskCardRuntimeState(run)
  assert.equal(state.visualState, 'failed', 'projection-driven failed must beat scope-run phase')
  assert.deepEqual(state.actionSet, ['retry', 'cancel', 'open_artifact'])
})

test('projection.status=failed + live background → background_running (per CLAUDE §6.13)', () => {
  // Single-card edge case: when the projection says failed but the
  // task continuation still indicates a live background child, the
  // card surfaces as background_running. CLAUDE.md §6.13's
  // "失败且无后台存活" priority deliberately demotes failed in this case.
  const run = makeRun({
    phase: 'tool_running',
    status: 'failed',
    waitingFor: 'background',
    taskContinuation: {
      taskId: 't1',
      stepId: 's1',
      blockerType: 'background_running',
      childRunId: 'vcr_x',
      skillId: 'demo',
    },
  })
  const state = deriveTaskCardRuntimeState(run)
  assert.equal(state.visualState, 'background_running')
})

test('projection.status=blocked + waiting_for=input → waiting_input', () => {
  const run = makeRun({
    phase: 'checkpoint',
    status: 'blocked',
    waitingFor: 'input',
    interactionState: 'awaiting_clarification',
  })
  const state = deriveTaskCardRuntimeState(run)
  assert.equal(state.visualState, 'waiting_input')
})

test('projection.status=done → done with open_artifact when artifacts present', () => {
  const run = makeRun({
    phase: 'done',
    status: 'done',
    recentArtifacts: [{
      id: 'a1',
      module: 'skill',
      kind: 'folder',
      label: 'output',
      path: '/tmp/x',
      createdAt: new Date().toISOString(),
    }],
  })
  const state = deriveTaskCardRuntimeState(run)
  assert.equal(state.visualState, 'done')
  assert.deepEqual(state.actionSet, ['open_artifact'])
})

test('projection.status=running → running fallback (no continuation, default cancel action)', () => {
  const run = makeRun({
    phase: 'tool_running',
    status: 'running',
    interactionState: 'running',
    waitingFor: 'none',
  })
  const state = deriveTaskCardRuntimeState(run)
  assert.equal(state.visualState, 'running')
  assert.deepEqual(state.actionSet, ['cancel'])
})
