import assert from 'node:assert/strict'
import test from 'node:test'

import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import type { FinalizedRunOutcome, RunFinalizerDeps, RunOutcome } from '../main/modules/agent-control/runtime-core/run-finalizer'
import { ReadyAgentOrchestrator } from '../main/modules/agent-control/runtime-core/orchestrator'
import {
  finalizeStaleWithoutHandleProjections,
  shouldFinalizeStaleWithoutHandleProjection,
} from '../main/modules/agent-control/runtime-core/stale-projection-finalizer'

const OLD = '2026-06-20T03:00:00.000Z'
const NOW = '2026-06-20T03:40:00.000Z'

function projection(overrides: Partial<TaskProjectionRecord> = {}): TaskProjectionRecord {
  return {
    taskId: 'task-stale',
    scopeId: 'scope-stale',
    runId: 'run-stale',
    parentTaskId: null,
    parentStepId: null,
    taskType: 'multi_step_task',
    module: 'skill',
    taskTitle: '旧任务',
    taskSummary: '旧任务仍显示进行中',
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
    resumableActions: ['continue', 'cancel'],
    continuationRef: null,
    recentArtifacts: [],
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  }
}

function createStore(record: TaskProjectionRecord) {
  let current = record
  return {
    get current() {
      return current
    },
    store: {
      get(taskId: string) {
        return taskId === current.taskId ? current : null
      },
      update(taskId: string, patch: Partial<TaskProjectionRecord>) {
        if (taskId === current.taskId) {
          current = { ...current, ...patch }
        }
      },
    },
  }
}

test('stale no-handle projection closes through finalizer when no active run exists', async () => {
  const fx = createStore(projection())
  const outcomes: RunOutcome[] = []
  const finalize = async (
    outcome: RunOutcome,
    deps: RunFinalizerDeps,
  ): Promise<FinalizedRunOutcome> => {
    outcomes.push(outcome)
    await deps.writeProjectionTerminalPatch?.(outcome.projectionPatch || null, outcome.terminalReason, 'interrupted')
    return { status: 'interrupted', terminalReason: outcome.terminalReason }
  }

  const closed = await finalizeStaleWithoutHandleProjections({
    scopeId: 'scope-stale',
    records: [fx.current],
    taskProjectionStore: fx.store,
    hasActiveRun: () => false,
    now: NOW,
    finalize,
  })

  assert.equal(closed, 1)
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].kind, 'interrupted')
  assert.equal(outcomes[0].terminalReason, 'stale_without_handle')
  assert.equal(fx.current.status, 'blocked')
  assert.equal(fx.current.interactionState, 'suspended')
  assert.equal(fx.current.waitingFor, 'none')
  assert.equal(fx.current.degradationReason, 'stale_paused')
  assert.deepEqual(fx.current.resumableActions, ['none'])
})

test('stale no-handle projection does not close while the scope has an active run', async () => {
  const fx = createStore(projection())
  let finalizeCalls = 0

  const closed = await finalizeStaleWithoutHandleProjections({
    scopeId: 'scope-stale',
    records: [fx.current],
    taskProjectionStore: fx.store,
    hasActiveRun: () => true,
    now: NOW,
    finalize: async (): Promise<FinalizedRunOutcome> => {
      finalizeCalls += 1
      return { status: 'interrupted', terminalReason: 'stale_without_handle' }
    },
  })

  assert.equal(closed, 0)
  assert.equal(finalizeCalls, 0)
  assert.equal(fx.current.status, 'running')
})

test('stale no-handle projection does not close while the scope has an active child run', async () => {
  const fx = createStore(projection())
  const orchestrator = new ReadyAgentOrchestrator()
  orchestrator.setChildLivenessProvider({
    hasActiveChildRunForScope(scopeId: string): boolean {
      return scopeId === 'scope-stale'
    },
  })
  let finalizeCalls = 0

  const closed = await finalizeStaleWithoutHandleProjections({
    scopeId: 'scope-stale',
    records: [fx.current],
    taskProjectionStore: fx.store,
    hasActiveRun: () => orchestrator.isScopeLive('main-agent', 'scope-stale'),
    now: NOW,
    finalize: async (): Promise<FinalizedRunOutcome> => {
      finalizeCalls += 1
      return { status: 'interrupted', terminalReason: 'stale_without_handle' }
    },
  })

  assert.equal(closed, 0)
  assert.equal(finalizeCalls, 0)
  assert.equal(fx.current.status, 'running')
})

test('stale projection with a durable handle stays resumable', () => {
  const record = projection({
    continuationRef: {
      taskId: 'task-stale',
      childRunId: 'child-still-resumable',
      resumeKind: 'paused',
    },
  })

  assert.equal(
    shouldFinalizeStaleWithoutHandleProjection(record, Date.parse(NOW)),
    false,
  )
})
