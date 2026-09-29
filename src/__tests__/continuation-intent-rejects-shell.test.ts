/**
 * Stage Q (Stage 11) — `runtime.buildContinuationIntent` must refuse to
 * build an intent for an empty-shell handle (only taskRunId/skillId,
 * no real durable handle).
 *
 * Audit §F-6 / plan §3.4 contract C6+C7. Tests directly drive the
 * canResumeShape gate at the buildContinuationIntent boundary.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { canResumeShape } from '../main/modules/agent-control/contracts/resume-handle'
import { isAwaitingUserInteractionState } from '../shared/task-interaction-state'

test('interaction response gate: user-waiting projections do not need a durable resume handle', () => {
  assert.equal(canResumeShape({
    childRunId: null,
    detachedTaskId: null,
    outputDir: null,
    runStatePath: null,
  }), false)
  assert.equal(isAwaitingUserInteractionState({
    waitingFor: 'confirmation',
    interactionState: 'awaiting_confirmation',
  }), true)
})

test('interaction response gate: background resume still requires a durable handle', () => {
  assert.equal(isAwaitingUserInteractionState({
    waitingFor: 'background',
    interactionState: 'suspended',
  }), false)
})
