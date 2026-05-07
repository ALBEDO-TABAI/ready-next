import assert from 'node:assert/strict'
import test from 'node:test'

import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import type { TaskProjectionChangeEvent, TaskProjectionRecord } from '../main/modules/agent-control/run-contracts'

/**
 * Stage O §0.2 / §5.1 — `TaskProjectionRepository` emits `'change'`
 * after every successful create / update / deleteByScope, with the
 * reason field reflecting the operation (or the caller's reasonHint
 * for `supersede`). `silent: true` suppresses the emit; this is what
 * `task-projection-reconciler.ts` uses to break the
 * fetch-→reconcile-→push-→fetch loop.
 *
 * The test uses a tiny in-memory mock of the SQLite-shaped raw db; we
 * don't exercise SQL semantics here, only the wrapper's emit contract.
 */

interface Row {
  task_id: string
  scope_id: string
  // Other columns are written but irrelevant for these assertions.
  [k: string]: unknown
}

function makeMockDb() {
  const rows = new Map<string, Row>()
  return {
    rows,
    getRawDb() {
      return {
        prepare: (sql: string) => {
          if (/^\s*INSERT\s+INTO\s+task_projections/i.test(sql)) {
            return {
              run: (...params: unknown[]) => {
                const taskId = params[0] as string
                const scopeId = params[1] as string
                rows.set(taskId, { task_id: taskId, scope_id: scopeId })
              },
              get: () => undefined,
              all: () => [],
            }
          }
          if (/^\s*UPDATE\s+task_projections/i.test(sql)) {
            return {
              run: (...params: unknown[]) => {
                const taskId = params[params.length - 1] as string
                const existing = rows.get(taskId)
                if (existing) rows.set(taskId, existing)
              },
              get: () => undefined,
              all: () => [],
            }
          }
          if (/^\s*DELETE\s+FROM\s+task_projections/i.test(sql)) {
            return {
              run: (...params: unknown[]) => {
                const scopeId = params[0] as string
                for (const [k, v] of Array.from(rows.entries())) {
                  if (v.scope_id === scopeId) rows.delete(k)
                }
              },
              get: () => undefined,
              all: () => [],
            }
          }
          if (/SELECT\s+\*\s+FROM\s+task_projections\s+WHERE\s+task_id\s*=/i.test(sql)) {
            return {
              run: () => undefined,
              get: <T>(taskId: string) => rows.get(taskId) as T | undefined,
              all: () => [],
            }
          }
          if (/SELECT\s+\*\s+FROM\s+task_projections\s+WHERE\s+scope_id\s*=/i.test(sql)) {
            return {
              run: () => undefined,
              get: () => undefined,
              all: <T>(scopeId: string) =>
                Array.from(rows.values()).filter((r) => r.scope_id === scopeId) as T[],
            }
          }
          return { run: () => undefined, get: () => undefined, all: () => [] }
        },
      }
    },
  }
}

function makeRecord(taskId: string, scopeId: string): TaskProjectionRecord {
  return {
    taskId,
    scopeId,
    runId: 'r',
    parentTaskId: null,
    parentStepId: null,
    taskType: 'short_task',
    module: 'system',
    taskTitle: null,
    taskSummary: null,
    status: 'running',
    interactionState: 'running',
    waitingFor: 'none',
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
    updatedAt: '2026-05-07T00:00:00.000Z',
  }
}

test('create emits change with reason=create', () => {
  const repo = new TaskProjectionRepository(makeMockDb())
  const events: TaskProjectionChangeEvent[] = []
  repo.on('change', (e) => events.push(e))
  repo.create(makeRecord('t1', 's1'))
  assert.equal(events.length, 1)
  assert.equal(events[0].scopeId, 's1')
  assert.equal(events[0].reason, 'create')
  assert.deepEqual(events[0].changedTaskIds, ['t1'])
})

test('update emits change with reason=update by default', () => {
  const repo = new TaskProjectionRepository(makeMockDb())
  repo.create(makeRecord('t1', 's1'))
  const events: TaskProjectionChangeEvent[] = []
  repo.on('change', (e) => events.push(e))
  repo.update('t1', { taskTitle: 'updated' })
  assert.equal(events.length, 1)
  assert.equal(events[0].reason, 'update')
})

test('update with reasonHint=supersede emits change with reason=supersede', () => {
  const repo = new TaskProjectionRepository(makeMockDb())
  repo.create(makeRecord('t1', 's1'))
  const events: TaskProjectionChangeEvent[] = []
  repo.on('change', (e) => events.push(e))
  repo.update('t1', { taskTitle: 'updated' }, { reasonHint: 'supersede' })
  assert.equal(events.length, 1)
  assert.equal(events[0].reason, 'supersede')
})

test('deleteByScope emits change with reason=delete and the removed taskIds', () => {
  const repo = new TaskProjectionRepository(makeMockDb())
  repo.create(makeRecord('t1', 's1'))
  repo.create(makeRecord('t2', 's1'))
  const events: TaskProjectionChangeEvent[] = []
  repo.on('change', (e) => events.push(e))
  repo.deleteByScope('s1')
  // create×2 produces 0 because we attached AFTER, then deleteByScope = 1 emit
  assert.equal(events.length, 1)
  assert.equal(events[0].reason, 'delete')
  assert.equal(events[0].scopeId, 's1')
  assert.deepEqual(events[0].changedTaskIds.sort(), ['t1', 't2'])
})

test('silent: true suppresses emit on update', () => {
  const repo = new TaskProjectionRepository(makeMockDb())
  repo.create(makeRecord('t1', 's1'))
  const events: TaskProjectionChangeEvent[] = []
  repo.on('change', (e) => events.push(e))
  repo.update('t1', { taskTitle: 'silent' }, { silent: true })
  assert.equal(events.length, 0)
})

test('silent: true also suppresses emit on create / delete', () => {
  const repo = new TaskProjectionRepository(makeMockDb())
  const events: TaskProjectionChangeEvent[] = []
  repo.on('change', (e) => events.push(e))
  repo.create(makeRecord('t1', 's1'), { silent: true })
  repo.deleteByScope('s1', { silent: true })
  assert.equal(events.length, 0)
})

test('off() detaches the listener', () => {
  const repo = new TaskProjectionRepository(makeMockDb())
  const events: TaskProjectionChangeEvent[] = []
  const listener = (e: TaskProjectionChangeEvent) => events.push(e)
  repo.on('change', listener)
  repo.create(makeRecord('t1', 's1'))
  repo.off('change', listener)
  repo.create(makeRecord('t2', 's1'))
  assert.equal(events.length, 1)
  assert.equal(events[0].changedTaskIds[0], 't1')
})
