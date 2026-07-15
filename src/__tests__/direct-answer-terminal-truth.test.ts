import assert from 'node:assert/strict'
import test from 'node:test'

import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import type { CheckInRecord } from '../main/modules/agent-control/quality/task-adjudicator'
import {
  finalizeRunOutcome,
  reconcileTerminalTaskBudgetRuntime,
  type RunCloseMetric,
} from '../main/modules/agent-control/runtime-core/run-finalizer'
import {
  createRunBudgetSeed,
  createTaskBudgetRuntime,
} from '../main/modules/agent-control/task-projection/run-budget-policy'

const NOW = new Date('2026-07-15T08:25:35.767Z')

function bootstrapShortTaskRuntime() {
  return createTaskBudgetRuntime('short_task', {
    budget: createRunBudgetSeed('short_task'),
    usage: {
      iterationsUsed: 1,
      toolCallsUsed: 0,
      parallelToolGroupsUsed: 0,
    },
    bootstrapBudget: true,
  })
}

test('terminal direct answer rebinds only a stale bootstrap budget and preserves usage', () => {
  const bootstrap = bootstrapShortTaskRuntime()
  const rebound = reconcileTerminalTaskBudgetRuntime(bootstrap, {
    taskType: 'direct_answer',
    module: 'system',
  }, 0)

  assert.ok(rebound)
  assert.equal(rebound.taskType, 'direct_answer')
  assert.equal(rebound.bootstrapBudget, false)
  assert.equal(rebound.budget.maxIterations, 8)
  assert.equal(rebound.budget.maxToolCalls, 8)
  assert.deepEqual(rebound.usage, bootstrap.usage)
  assert.equal(
    reconcileTerminalTaskBudgetRuntime(bootstrap, { taskType: 'direct_answer' }, 1),
    bootstrap,
    'a tool-bearing run cannot be reclassified by this zero-tool repair',
  )
})

test('terminal direct answer never downgrades an explicit task budget', () => {
  for (const taskType of ['research', 'browser_transaction', 'continuation', 'multi_step_task'] as const) {
    const explicit = createTaskBudgetRuntime(taskType, { bootstrapBudget: false })
    const resolved = reconcileTerminalTaskBudgetRuntime(explicit, {
      taskType: 'direct_answer',
      module: taskType === 'multi_step_task' ? 'skill' : 'system',
    }, 0)
    assert.equal(resolved, explicit, `${taskType} must remain the governing terminal type`)
    assert.equal(resolved?.taskType, taskType)
  }
})

test('zero-tool explicit research and browser transactions keep their proof contract and fail', async () => {
  for (const taskType of ['research', 'browser_transaction'] as const) {
    const projection: TaskProjectionRecord = {
      taskId: `task-${taskType}`,
      scopeId: `scope-${taskType}`,
      runId: `run-${taskType}`,
      taskType,
      module: taskType === 'browser_transaction' ? 'browser' : 'research',
      status: 'running',
      interactionState: 'running',
      steps: [],
      proofRefs: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    } as TaskProjectionRecord
    const runMeta = new Map<string, Record<string, unknown>>()
    const finalized = await finalizeRunOutcome({
      kind: 'done',
      runId: projection.runId,
      taskId: projection.taskId,
      scopeId: projection.scopeId,
      durationMs: 10,
      toolCallsUsed: 0,
      initiator: 'done',
      finalText: '只有文字，没有来源或网页操作证据。',
      projectionPatch: { taskType, module: projection.module },
      taskBudgetRuntime: createTaskBudgetRuntime(taskType, { bootstrapBudget: false }),
    }, {
      now: () => NOW,
      runMetaRepository: {
        get: (runId) => runMeta.get(runId) ?? null,
        create: (input) => {
          runMeta.set(String(input.runId), { ...input })
          return input
        },
        update: (runId, patch) => {
          const row = { ...(runMeta.get(runId) ?? {}), ...patch }
          runMeta.set(runId, row)
          return row
        },
      },
      taskProjectionStore: {
        get: () => projection,
        update: (_taskId, patch) => Object.assign(projection, patch),
      },
      writeRunCloseMetric: () => {},
    })

    assert.equal(finalized.status, 'error', `${taskType} must not escape into a direct answer`)
    assert.equal(runMeta.get(projection.runId)?.taskType, taskType)
    assert.equal(projection.taskType, taskType)
  }
})

test('finalizer judges a terminal direct answer against response proof and closes every ledger with one type', async () => {
  const projection: TaskProjectionRecord = {
    taskId: 'task-direct-answer',
    scopeId: 'scope-direct-answer',
    runId: 'run-direct-answer',
    taskType: 'short_task',
    module: 'system',
    status: 'running',
    interactionState: 'running',
    steps: [],
    proofRefs: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  } as TaskProjectionRecord
  const runMeta = new Map<string, Record<string, unknown>>([
    ['run-direct-answer', { runId: 'run-direct-answer', status: 'working' }],
  ])
  let terminalPatch: Record<string, unknown> | null = null
  let terminalStatus: string | null = null
  let terminalReason: string | null = null
  let closeMetric: RunCloseMetric | null = null

  const finalized = await finalizeRunOutcome({
    kind: 'done',
    runId: 'run-direct-answer',
    taskId: 'task-direct-answer',
    scopeId: 'scope-direct-answer',
    durationMs: 10,
    toolCallsUsed: 0,
    initiator: 'done',
    finalText: '我是 Ready 里的 AI 工作助手。',
    projectionPatch: { taskType: 'direct_answer', module: 'system' },
    taskBudgetRuntime: bootstrapShortTaskRuntime(),
  }, {
    now: () => NOW,
    runMetaRepository: {
      get: (runId) => runMeta.get(runId) ?? null,
      create: (input) => {
        runMeta.set(String(input.runId), { ...input })
        return input
      },
      update: (runId, patch) => {
        const row = { ...(runMeta.get(runId) ?? {}), ...patch }
        runMeta.set(runId, row)
        return row
      },
    },
    taskProjectionStore: {
      get: () => projection,
      update: (_taskId, patch) => Object.assign(projection, patch),
    },
    writeProjectionTerminalPatch: (patch, reason, status) => {
      terminalPatch = patch
      terminalReason = reason
      terminalStatus = status
    },
    writeRunCloseMetric: (metric) => { closeMetric = metric },
  })

  const checkIn = (projection.checkins as CheckInRecord[]).at(-1)
  const criteria = projection.criteria as { items?: Array<{ kind?: string }>; satisfiedCount?: number }
  const meta = runMeta.get('run-direct-answer')
  const persistedBudget = meta?.budget as { maxIterations?: number; toolCallsUsed?: number }

  assert.deepEqual(finalized, { status: 'done', terminalReason: 'done' })
  assert.equal(checkIn?.verdict, 'accept')
  assert.equal(checkIn?.satisfiedCount, 1)
  assert.equal(criteria.items?.[0]?.kind, 'response_digest')
  assert.equal(criteria.satisfiedCount, 1)
  assert.equal(terminalPatch?.taskType, 'direct_answer')
  assert.equal(terminalStatus, 'done')
  assert.equal(terminalReason, 'done')
  assert.equal(meta?.status, 'done')
  assert.equal(meta?.taskType, 'direct_answer')
  assert.equal(persistedBudget.maxIterations, 8)
  assert.equal(persistedBudget.toolCallsUsed, 0)
  assert.equal(closeMetric?.taskType, 'direct_answer')
})
