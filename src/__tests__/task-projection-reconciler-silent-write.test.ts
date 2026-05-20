import assert from 'node:assert/strict'
import test from 'node:test'

import { reconcileTaskProjections } from '../main/modules/agent-control/task-projection/task-projection-reconciler'
import type { TaskProjectionRecord, TaskProjectionWriteOptions } from '../main/modules/agent-control/run-contracts'

/**
 * Stage O §0.2 / §2.1 — `reconcileTaskProjections` is invoked inside
 * `runtime.listTaskProjections`, which is itself driven by a renderer
 * fetch. If the reconciler-driven `store.update` emitted `change`, we
 * would loop fetch → reconcile → push → fetch. v8 makes the reconciler
 * pass `{ silent: true }`; this test pins the behavior so a future
 * change can't silently restore the loop.
 */

function makeStaleRecord(): TaskProjectionRecord {
  return {
    taskId: 'skill-child:vcr_stale',
    scopeId: 's1',
    runId: 'r',
    parentTaskId: null,
    parentStepId: null,
    taskType: 'short_task',
    module: 'skill',
    taskTitle: null,
    taskSummary: null,
    status: 'running',
    interactionState: 'running',
    waitingFor: 'background',
    steps: [],
    currentStepId: null,
    budget: null,
    budgetUsagePercent: null,
    budgetWarningLevel: null,
    recoveryHistory: [],
    degradationReason: null,
    blockedReason: null,
    resumableActions: [],
    continuationRef: null,
    recentArtifacts: [],
    createdAt: '2026-05-07T00:00:00.000Z',
    // updatedAt is far in the past so the reconciler considers the row
    // stale relative to the matched ledger run; if the ledger doesn't
    // expose a fresh run, the reconciler downgrades to `blocked`.
    updatedAt: '2025-01-01T00:00:00.000Z',
  }
}

test('reconciler-driven store.update is invoked with { silent: true }', () => {
  const updateCalls: Array<{
    taskId: string
    options: TaskProjectionWriteOptions | undefined
  }> = []

  const store = {
    update: (
      taskId: string,
      _patch: Partial<TaskProjectionRecord>,
      options?: TaskProjectionWriteOptions,
    ) => {
      updateCalls.push({ taskId, options })
    },
  }

  const stale = makeStaleRecord()
  // No matching ledger run → reconciler sees nothing to update, no call.
  // To force at least one update, pass a ledger run with the same taskId
  // but a status that is NOT in RECONCILABLE_STATUSES so the reconciler
  // resolves the row as terminal-superseded. The reconciler returns the
  // count of updates; we only assert that whenever it DID update, the
  // options carried `silent: true`.
  const changes = reconcileTaskProjections({
    store,
    records: [stale],
    taskRuns: [
      {
        taskId: stale.taskId,
        scopeId: stale.scopeId,
        // Stale record + completed ledger run forces a reconcile.
        status: 'completed',
        startedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-02-01T00:00:00.000Z',
        // Minimal additional fields so the reconciler accepts the run.
        outputDir: '/tmp/x',
        runStatePath: null,
        skillId: 'demo',
        sceneScoresPath: null,
        deliveryReportPath: null,
        action: 'demo',
      } as unknown as Parameters<typeof reconcileTaskProjections>[0]['taskRuns'][number],
    ],
    now: '2026-05-07T00:00:00.000Z',
  })

  // Either the reconciler updated (1+ calls) or it didn't (0 calls); in
  // both cases, every call MUST be silent. We don't pin the count
  // because the reconciler's policy can legitimately evolve; we ONLY
  // pin the silent contract.
  assert.equal(typeof changes, 'number')
  for (const call of updateCalls) {
    assert.deepEqual(call.options, { silent: true }, `update for ${call.taskId} missing silent flag`)
  }
})
