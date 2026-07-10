/**
 * EP2-T1 — same-run dual-ledger consistency (07 §1.3). The projection is the
 * authoritative source for task_type/budget; run_meta gets a close-out
 * snapshot through the wrapper, written via the REAL finalizeRunOutcome
 * funnel (the finalizer body itself stays untouched — Q4a serial window).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { wrapRunMetaRepositoryWithCloseoutSnapshot } from '../main/modules/agent-control/task-projection/run-meta-snapshot'
import { finalizeRunOutcome } from '../main/modules/agent-control/runtime-core/run-finalizer'
import { finalizeStaleWithoutHandleProjections } from '../main/modules/agent-control/runtime-core/stale-projection-finalizer'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'

function fakeRunMetaRepository() {
  const rows = new Map<string, Record<string, unknown>>()
  return {
    rows,
    get: (runId: string) => rows.get(runId) ?? null,
    create: (input: Record<string, unknown>) => {
      rows.set(String(input.runId), { ...input })
      return input
    },
    update: (runId: string, patch: Record<string, unknown>) => {
      rows.set(runId, { ...(rows.get(runId) ?? {}), ...patch })
      return rows.get(runId)
    },
  }
}

const projection = {
  taskId: 'task-t1',
  scopeId: 'scope-1',
  runId: 'run-t1',
  taskType: 'research',
  module: 'browser',
  status: 'completed',
  interactionState: 'running',
  steps: [],
  budget: { taskType: 'research', maxIterations: 60, maxToolCalls: 60, maxParallelToolGroups: 2 },
  createdAt: '2026-06-12T09:00:00.000Z',
  updatedAt: '2026-06-12T10:00:00.000Z',
} as unknown as TaskProjectionRecord

test('finalize through the real funnel snapshots task_type/budget from the projection', async () => {
  const repository = fakeRunMetaRepository()
  // mid-run scratch row with drifted values — the close-out snapshot must win
  repository.create({ runId: 'run-t1', taskId: 'task-t1', status: 'working', taskType: 'short_task', budget: { maxIterations: 24 } })

  const wrapped = wrapRunMetaRepositoryWithCloseoutSnapshot(
    repository,
    (taskId) => (taskId === 'task-t1' ? projection : null),
  )
  await finalizeRunOutcome({
    kind: 'done',
    runId: 'run-t1',
    taskId: 'task-t1',
    scopeId: 'scope-1',
    durationMs: 1200,
    toolCallsUsed: 3,
    initiator: 'done',
    finalText: '完成',
  }, {
    runMetaRepository: wrapped,
    writeRunCloseMetric: () => {},
  })

  const row = repository.rows.get('run-t1')!
  assert.equal(row.status, 'done')
  assert.equal(row.taskType, 'research', 'run_meta task_type equals the projection at close-out')
  assert.deepEqual(row.budget, projection.budget, 'run_meta budget equals the projection at close-out')
})

test('missing projection or missing taskId degrades to the unenriched write — finalize never blocks', async () => {
  const repository = fakeRunMetaRepository()
  const wrapped = wrapRunMetaRepositoryWithCloseoutSnapshot(repository, () => null)
  await finalizeRunOutcome({
    kind: 'error',
    runId: 'run-x',
    taskId: 'task-unknown',
    scopeId: null,
    durationMs: 10,
    toolCallsUsed: 0,
    initiator: 'error',
    terminalReason: 'model_failed',
  }, { runMetaRepository: wrapped, writeRunCloseMetric: () => {} })
  const row = repository.rows.get('run-x')!
  assert.equal(row.status, 'error')
  assert.equal(row.taskType, undefined, 'no projection → no fabricated snapshot')

  const throwing = wrapRunMetaRepositoryWithCloseoutSnapshot(repository, () => { throw new Error('db down') })
  await finalizeRunOutcome({
    kind: 'cancelled',
    runId: 'run-y',
    taskId: 'task-t1',
    scopeId: null,
    durationMs: 10,
    toolCallsUsed: 0,
    initiator: 'user',
    terminalReason: 'user_cancelled',
  }, { runMetaRepository: throwing, writeRunCloseMetric: () => {} })
  assert.equal(repository.rows.get('run-y')!.status, 'cancelled', 'snapshot failure never blocks the terminal write')
})

test('manual_suspend and stale-without-handle closeouts both snapshot projection budget truth', async () => {
  const manualProjection = {
    ...projection,
    taskId: 'task-manual',
    runId: 'run-manual',
    budget: { taskType: 'multi_step_task', maxIterations: 40, maxToolCalls: 40, maxParallelToolGroups: 2 },
  } as TaskProjectionRecord
  const manualRepository = fakeRunMetaRepository()
  manualRepository.create({ runId: 'run-manual', taskId: 'task-manual', status: 'working', budget: { maxToolCalls: 24 } })
  await finalizeRunOutcome({
    kind: 'interrupted',
    runId: 'run-manual',
    taskId: 'task-manual',
    scopeId: 'scope-1',
    durationMs: 1,
    toolCallsUsed: 0,
    initiator: 'manual_suspend',
    terminalReason: 'manual_suspend',
  }, {
    runMetaRepository: wrapRunMetaRepositoryWithCloseoutSnapshot(manualRepository, () => manualProjection),
    writeRunCloseMetric: () => {},
  })
  assert.deepEqual(manualRepository.rows.get('run-manual')?.budget, manualProjection.budget)

  let staleProjection = {
    ...projection,
    taskId: 'task-stale-ledger',
    runId: 'run-stale-ledger',
    scopeId: 'scope-stale-ledger',
    status: 'running',
    interactionState: 'running',
    waitingFor: 'background',
    resumableActions: ['continue'],
    continuationRef: null,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    budget: { taskType: 'research', maxIterations: 60, maxToolCalls: 60, maxParallelToolGroups: 2 },
  } as TaskProjectionRecord
  const staleRepository = fakeRunMetaRepository()
  staleRepository.create({ runId: 'run-stale-ledger', taskId: 'task-stale-ledger', status: 'working', budget: { maxToolCalls: 24 } })
  const store = {
    get: (taskId: string) => taskId === staleProjection.taskId ? staleProjection : null,
    update: (taskId: string, patch: Partial<TaskProjectionRecord>) => {
      if (taskId === staleProjection.taskId) staleProjection = { ...staleProjection, ...patch }
    },
  }
  await finalizeStaleWithoutHandleProjections({
    scopeId: staleProjection.scopeId,
    records: [staleProjection],
    taskProjectionStore: store,
    runMetaRepository: wrapRunMetaRepositoryWithCloseoutSnapshot(staleRepository, (taskId) => store.get(taskId)),
    hasActiveRun: () => false,
    now: '2026-07-10T00:40:00.000Z',
  })
  assert.deepEqual(staleRepository.rows.get('run-stale-ledger')?.budget, staleProjection.budget)
})
