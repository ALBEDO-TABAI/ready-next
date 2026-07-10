import assert from 'node:assert/strict'
import test from 'node:test'

import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import { finalizeRunOutcome } from '../main/modules/agent-control/runtime-core/run-finalizer'
import { createTaskBudgetRuntime } from '../main/modules/agent-control/task-projection/run-budget-policy'
import { wrapRunMetaRepositoryWithCloseoutSnapshot } from '../main/modules/agent-control/task-projection/run-meta-snapshot'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('run-meta-closeout-precedence declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'run-meta-closeout-precedence transitive sqlite guard')
})

test('terminal patch and runtime facts beat a stale projection snapshot in run_meta', async () => {
  const rows = new Map<string, Record<string, unknown>>([
    ['run-closeout', { runId: 'run-closeout', taskId: 'task-closeout', status: 'working' }]
  ])
  const repository = {
    get: (runId: string) => rows.get(runId) ?? null,
    create: (input: Record<string, unknown>) => {
      rows.set(String(input.runId), { ...input })
      return input
    },
    update: (runId: string, patch: Record<string, unknown>) => {
      rows.set(runId, { ...(rows.get(runId) ?? {}), ...patch })
      return rows.get(runId)
    }
  }
  const staleProjection = {
    taskId: 'task-closeout',
    runId: 'run-closeout',
    scopeId: 'scope-closeout',
    taskType: 'short_task',
    module: 'system',
    status: 'running',
    interactionState: 'running',
    steps: [],
    budget: {
      taskType: 'short_task',
      maxIterations: 24,
      maxToolCalls: 24,
      maxParallelToolGroups: 2
    },
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z'
  } as unknown as TaskProjectionRecord
  const runtime = createTaskBudgetRuntime('research')

  await finalizeRunOutcome(
    {
      kind: 'done',
      runId: 'run-closeout',
      taskId: 'task-closeout',
      scopeId: 'scope-closeout',
      durationMs: 10,
      toolCallsUsed: 1,
      initiator: 'done',
      finalText: '研究已完成',
      taskBudgetRuntime: runtime,
      projectionPatch: { taskType: 'research', module: 'browser' }
    },
    {
      runMetaRepository: wrapRunMetaRepositoryWithCloseoutSnapshot(
        repository,
        () => staleProjection
      ),
      taskProjectionStore: { get: () => staleProjection },
      writeRunCloseMetric: () => {}
    }
  )

  const row = rows.get('run-closeout')!
  assert.equal(row.taskType, 'research')
  assert.deepEqual(row.budget, { ...runtime.budget, ...runtime.usage })
})

test('runtime task type beats a stale projection row when the terminal patch omits taskType', async () => {
  const rows = new Map<string, Record<string, unknown>>([
    [
      'run-runtime-only',
      { runId: 'run-runtime-only', taskId: 'task-runtime-only', status: 'working' }
    ]
  ])
  const repository = {
    get: (runId: string) => rows.get(runId) ?? null,
    create: (input: Record<string, unknown>) => {
      rows.set(String(input.runId), { ...input })
      return input
    },
    update: (runId: string, patch: Record<string, unknown>) => {
      rows.set(runId, { ...(rows.get(runId) ?? {}), ...patch })
      return rows.get(runId)
    }
  }
  const staleProjection = {
    taskId: 'task-runtime-only',
    runId: 'run-runtime-only',
    scopeId: 'scope-runtime-only',
    taskType: 'short_task',
    module: 'system',
    status: 'running',
    interactionState: 'running',
    steps: [],
    budget: {
      taskType: 'short_task',
      maxIterations: 24,
      maxToolCalls: 24,
      maxParallelToolGroups: 2
    },
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z'
  } as unknown as TaskProjectionRecord
  const runtime = createTaskBudgetRuntime('research')

  await finalizeRunOutcome(
    {
      kind: 'done',
      runId: 'run-runtime-only',
      taskId: 'task-runtime-only',
      scopeId: 'scope-runtime-only',
      durationMs: 10,
      toolCallsUsed: 1,
      initiator: 'done',
      finalText: '研究已完成',
      taskBudgetRuntime: runtime,
      projectionPatch: { module: 'browser' }
    },
    {
      runMetaRepository: wrapRunMetaRepositoryWithCloseoutSnapshot(
        repository,
        () => staleProjection
      ),
      taskProjectionStore: { get: () => staleProjection },
      writeRunCloseMetric: () => {}
    }
  )

  const row = rows.get('run-runtime-only')!
  assert.equal(row.taskType, 'research')
  assert.deepEqual(row.budget, { ...runtime.budget, ...runtime.usage })
})

test('runtime task type also corrects a contradictory terminal projection patch', async () => {
  const rows = new Map<string, Record<string, unknown>>([
    ['run-contradictory', { runId: 'run-contradictory', status: 'working' }]
  ])
  const repository = {
    get: (runId: string) => rows.get(runId) ?? null,
    create: (input: Record<string, unknown>) => rows.set(String(input.runId), { ...input }),
    update: (runId: string, patch: Record<string, unknown>) =>
      rows.set(runId, { ...(rows.get(runId) ?? {}), ...patch })
  }
  const runtime = createTaskBudgetRuntime('research')
  let projectionPatch: Record<string, unknown> | null = null

  await finalizeRunOutcome(
    {
      kind: 'done',
      runId: 'run-contradictory',
      taskId: 'task-contradictory',
      scopeId: 'scope-contradictory',
      durationMs: 10,
      toolCallsUsed: 0,
      initiator: 'done',
      finalText: '研究结论',
      taskBudgetRuntime: runtime,
      projectionPatch: { taskType: 'direct_answer', module: 'system' }
    },
    {
      runMetaRepository: repository,
      taskProjectionStore: { get: () => null },
      writeProjectionTerminalPatch: async (patch) => {
        projectionPatch = patch
      },
      writeRunCloseMetric: () => {}
    }
  )

  assert.equal(projectionPatch?.taskType, 'research')
  assert.equal(rows.get('run-contradictory')?.taskType, 'research')
  assert.equal(runtime.taskType, 'research')
})
