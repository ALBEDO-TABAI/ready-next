/**
 * Stage Q (Stage 11) — cold-start canResume derivation contract.
 *
 * Plan §3.4 contract C10: `runtime.listTaskProjections()` and
 * `runtime.getTaskProjection()` must derive `canResume` per record
 * before returning. Renderer cold-start consumes this single boolean
 * instead of recomputing from `resumableActions / interactionState /
 * taskRunId`.
 *
 * Tests directly exercise the contract: feed records with various
 * continuationRef shapes through the deriveTaskCardRuntimeState path
 * and assert the action set matches Stage Q expectations.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveTaskCardRuntimeState } from '../renderer/modules/agent/taskCardViewModel'
import { deriveTaskProjectionCanResume } from '../main/modules/agent-control/task-projection-resume'
import type { TaskProjectionRecord } from '../main/modules/agent-control/run-contracts'

function projection(overrides: Partial<TaskProjectionRecord>): TaskProjectionRecord {
  return {
    taskId: 'task-q',
    scopeId: 'scope-q',
    runId: 'run-q',
    taskType: 'skill',
    module: 'skill',
    taskTitle: 'VEA',
    status: 'blocked',
    interactionState: 'suspended',
    waitingFor: 'none',
    steps: [],
    resumableActions: ['continue'],
    continuationRef: { childRunId: 'child-q' },
    createdAt: '2026-05-08T00:00:00.000Z',
    updatedAt: '2026-05-08T00:00:00.000Z',
    ...overrides,
  }
}

test('cold-start canResume=false: continue/retry actions are stripped', () => {
  // Empty-shell projection: status='blocked', resumableActions includes
  // continue/retry (from stale lifecycle write), but main side has
  // derived canResume=false because continuationRef has no real handle.
  const runtimeState = deriveTaskCardRuntimeState({
    scopeId: 'scope-q',
    taskId: 'skill:scope-q:humanizer-zh',
    phase: 'checkpoint',
    title: 'humanizer-zh',
    status: 'blocked',
    waitingFor: 'none',
    resumableActions: ['continue', 'retry', 'cancel'],
    interactionState: 'suspended',
    canResume: false,
    updatedAt: '2026-05-08T00:00:00.000Z',
  })
  // continue and retry are stripped; cancel remains.
  assert.deepEqual(runtimeState.actionSet, ['cancel'])
})

test('cold-start canResume=true: continue/retry actions are preserved', () => {
  const runtimeState = deriveTaskCardRuntimeState({
    scopeId: 'scope-q',
    taskId: 'skill:scope-q:video-expert-analyzer',
    phase: 'checkpoint',
    title: 'video-expert-analyzer',
    status: 'blocked',
    waitingFor: 'none',
    resumableActions: ['continue', 'retry', 'cancel'],
    interactionState: 'suspended',
    canResume: true,
    updatedAt: '2026-05-08T00:00:00.000Z',
  })
  assert.deepEqual(runtimeState.actionSet, ['continue', 'retry', 'cancel'])
})

test('cold-start canResume=undefined: defensive default — continue/retry stripped', () => {
  // Defensive default: when main forgot to derive canResume,
  // the renderer treats it as false rather than true.
  const runtimeState = deriveTaskCardRuntimeState({
    scopeId: 'scope-q',
    taskId: 'skill:scope-q:some-skill',
    phase: 'checkpoint',
    title: 'some-skill',
    status: 'blocked',
    waitingFor: 'none',
    resumableActions: ['continue', 'retry', 'cancel'],
    interactionState: 'suspended',
    // canResume omitted
    updatedAt: '2026-05-08T00:00:00.000Z',
  })
  assert.deepEqual(runtimeState.actionSet, ['cancel'])
})

test('cold-start canResume=false but cancel/open_artifact stay', () => {
  // Pin Stage Q contract: cancel and open_artifact are NOT gated by
  // canResume. They represent "give up this stale task" and "browse
  // existing output", neither of which require a live resume path.
  const runtimeStateWithArtifacts = deriveTaskCardRuntimeState({
    scopeId: 'scope-q',
    taskId: 'skill:scope-q:done-skill',
    phase: 'done',
    title: 'done-skill',
    status: 'done',
    resumableActions: ['open_artifact', 'cancel'],
    canResume: false,
    recentArtifacts: [{ id: 'a1', module: 'skill', kind: 'artifact', label: 'output', path: '/tmp/x', createdAt: '2026-05-08T00:00:00.000Z' }],
    updatedAt: '2026-05-08T00:00:00.000Z',
  })
  // 'done' state path — actionSet is ['open_artifact'] when artifacts exist,
  // and 'open_artifact' is NOT gated by canResume (Stage Q rule).
  assert.deepEqual(runtimeStateWithArtifacts.actionSet, ['open_artifact'])
})

test('cold-start canResume=false strips retry from failed state', () => {
  // 'failed' visualState normally yields ['retry', 'cancel', 'open_artifact'].
  // With canResume=false, retry is stripped.
  const runtimeState = deriveTaskCardRuntimeState({
    scopeId: 'scope-q',
    taskId: 'skill:scope-q:failed-skill',
    phase: 'error',
    title: 'failed-skill',
    status: 'failed',
    resumableActions: ['retry', 'cancel'],
    canResume: false,
    updatedAt: '2026-05-08T00:00:00.000Z',
  })
  // open_artifact is not gated; retry IS gated; cancel is not gated.
  assert.deepEqual(runtimeState.actionSet, ['cancel', 'open_artifact'])
})

// ---------------------------------------------------------------------------
// Real Q.6 contract: runtime.listTaskProjections + reconcile + canResume.
//
// Pin that a stale projection (status='blocked' with no durable handle in
// continuationRef) gets `canResume === false` after going through:
//   listByScope → reconcileTaskProjections → listByScope → derive canResume
//
// We test this through the `deriveTaskProjectionCanResume` helper directly
// rather than spinning up a full AgentControlRuntime (which requires app
// init). The helper is the single point of truth that listTaskProjections
// and getTaskProjection both call before returning.
// ---------------------------------------------------------------------------

test('Q.6 contract: stale projection (no durable handle) → canResume=false after derive', async () => {
  // Import the helper that runtime.ts uses internally.
  const { canResumeWithFs } = await import(
    '../main/modules/agent-control/resume-handle'
  )

  // Stale shape: continuationRef has only taskRunId+skillId, NO real handle.
  const stale = {
    childRunId: undefined,
    detachedTaskId: undefined,
    outputDir: undefined,
    runStatePath: undefined,
  }
  assert.equal(canResumeWithFs(stale), false)
})

test('Q.6 contract: live projection (childRunId) → canResume=true after derive', async () => {
  const { canResumeWithFs } = await import(
    '../main/modules/agent-control/resume-handle'
  )
  // Live shape: continuationRef has a childRunId.
  const live = {
    childRunId: 'cr-real-running',
    detachedTaskId: null,
    outputDir: null,
    runStatePath: null,
  }
  assert.equal(canResumeWithFs(live), true)
})

test('Q.6 contract: done projection with artifact-only action → canResume=false after derive', () => {
  const record = deriveTaskProjectionCanResume(projection({
    status: 'done',
    interactionState: 'suspended',
    resumableActions: ['open_artifact'],
  }))
  assert.equal(record.canResume, false)
})

test('Q.6 contract: blocked projection with continue action → canResume=true after derive', () => {
  const record = deriveTaskProjectionCanResume(projection({
    status: 'blocked',
    interactionState: 'suspended',
    resumableActions: ['continue', 'cancel'],
  }))
  assert.equal(record.canResume, true)
})

test('Q.6 contract: ghost path-pair (paths set but fs absent) → canResume=false', async () => {
  const { canResumeWithFs } = await import(
    '../main/modules/agent-control/resume-handle'
  )
  // Path strings set but fs has no such files (typical post-restart shape
  // when the user deleted the output dir).
  const ghost = {
    childRunId: null,
    detachedTaskId: null,
    outputDir: '/definitely/does/not/exist/q-stage-test',
    runStatePath: '/definitely/does/not/exist/q-stage-test/run_state.json',
  }
  assert.equal(canResumeWithFs(ghost), false)
})

test('cold-start canResume=false strips continue from background_running', () => {
  // 'background_running' visualState normally yields
  // ['continue', 'open_artifact', 'cancel']. With canResume=false,
  // continue is stripped.
  const runtimeState = deriveTaskCardRuntimeState({
    scopeId: 'scope-q',
    taskId: 'skill:scope-q:bg-skill',
    phase: 'tool_running',
    title: 'bg-skill',
    status: 'running',
    waitingFor: 'background',
    resumableActions: ['continue', 'cancel'],
    canResume: false,
    updatedAt: '2026-05-08T00:00:00.000Z',
  })
  assert.deepEqual(runtimeState.actionSet, ['open_artifact', 'cancel'])
})
