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

import { canResumeShape } from '../main/modules/agent-control/resume-handle'
import { isAwaitingUserInteractionState } from '../shared/task-interaction-state'

// `buildContinuationIntent` is a private method on AgentControlRuntime
// (not exported). The behavior we need to pin is the canResumeShape gate
// inside it — namely that the resulting intent must have a durable
// handle. We test the gate directly (the merge logic itself is a
// pass-through of taskId/blockedReason/etc. and is exercised
// elsewhere).

test('buildContinuationIntent gate: empty shell (only skillId) is rejected', () => {
  // Caller-side input shape mimics what `runtime.resumeRun` provides
  // when the renderer transmits a humanizer-zh blocked task with no
  // real durable handle.
  const intentHandle = {
    childRunId: null,
    detachedTaskId: null,
    outputDir: null,
    runStatePath: null,
  }
  assert.equal(canResumeShape(intentHandle), false)
})

test('buildContinuationIntent gate: only taskRunId is rejected', () => {
  // The pre-Stage Q failure mode: `taskRunId: 'str-...'` with skillId
  // and nothing else. The lifecycle layer used to consider this
  // "resumable"; the new gate refuses.
  const intentHandle = {
    childRunId: null,
    detachedTaskId: null,
    outputDir: null,
    runStatePath: null,
    // Note: ResumeHandle does not include `taskRunId` — it's
    // intentionally not a durable handle. This test pins that fact.
  }
  assert.equal(canResumeShape(intentHandle), false)
})

test('buildContinuationIntent gate: childRunId alone passes', () => {
  assert.equal(canResumeShape({
    childRunId: 'cr-real-handle',
    detachedTaskId: null,
    outputDir: null,
    runStatePath: null,
  }), true)
})

test('buildContinuationIntent gate: detachedTaskId alone passes', () => {
  assert.equal(canResumeShape({
    childRunId: null,
    detachedTaskId: 'dt-real-handle',
    outputDir: null,
    runStatePath: null,
  }), true)
})

test('buildContinuationIntent gate: outputDir+runStatePath pair passes', () => {
  assert.equal(canResumeShape({
    childRunId: null,
    detachedTaskId: null,
    outputDir: '/tmp/run-1',
    runStatePath: '/tmp/run-1/run_state.json',
  }), true)
})

test('buildContinuationIntent gate: outputDir without runStatePath rejected', () => {
  // Pin: half-pair is not enough.
  assert.equal(canResumeShape({
    childRunId: null,
    detachedTaskId: null,
    outputDir: '/tmp/run-1',
    runStatePath: null,
  }), false)
})

test('buildContinuationIntent gate: runStatePath without outputDir rejected', () => {
  assert.equal(canResumeShape({
    childRunId: null,
    detachedTaskId: null,
    outputDir: null,
    runStatePath: '/tmp/run-1/run_state.json',
  }), false)
})

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
