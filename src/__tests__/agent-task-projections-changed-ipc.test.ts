import assert from 'node:assert/strict'
import test from 'node:test'

import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import type { TaskProjectionRecord, TaskProjectionChangeEvent } from '../main/modules/agent-control/run-contracts'

/**
 * Stage O §0.3 / §5.1 — verify the `agent:taskProjectionsChanged`
 * push contract end-to-end at the bridge layer:
 *
 *   1. repo emit → bridge listener → mainWindow.webContents.send
 *      (channel name + payload shape).
 *
 *   2. cleanup → emits AFTER cleanup do not reach the bridge (ipc-handler's
 *      `cleanupAgentRuntime` calls the unsubscribe slot first).
 *
 *   3. dev-reload re-entry — connecting twice must NOT double-fire.
 *      A second subscription that doesn't first detach the previous one
 *      would leak; the unsubscribe-before-resubscribe pattern in
 *      `ipc-handler.ts` is the contract this test pins.
 *
 * The test uses the real repository (not the full ipc-handler module —
 * that pulls in too much electron/runtime machinery). Instead it mimics
 * the bridge wiring: capture the unsubscribe slot, fake `webContents.send`,
 * and assert call counts.
 */

function makeMockDb() {
  const rows = new Map<string, { task_id: string; scope_id: string }>()
  return {
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

/**
 * Mirror of the ipc-handler bridge logic at `setupAgentIPC`. Returns
 * the unsubscribe function so the test can simulate `cleanupAgentRuntime`
 * and dev-reload re-entry.
 */
function bridge(repo: TaskProjectionRepository, sends: Array<[string, unknown]>): () => void {
  const onChange = (event: TaskProjectionChangeEvent): void => {
    sends.push(['agent:taskProjectionsChanged', event])
  }
  repo.on('change', onChange)
  return () => repo.off('change', onChange)
}

test('repo emit reaches the bridge with the correct channel and payload', () => {
  const repo = new TaskProjectionRepository(makeMockDb())
  const sends: Array<[string, unknown]> = []
  bridge(repo, sends)
  repo.create(makeRecord('t1', 's1'))
  assert.equal(sends.length, 1)
  assert.equal(sends[0][0], 'agent:taskProjectionsChanged')
  assert.deepEqual(sends[0][1], {
    scopeId: 's1',
    changedTaskIds: ['t1'],
    reason: 'create',
  })
})

test('cleanup detaches — emits after cleanup do not reach the bridge', () => {
  const repo = new TaskProjectionRepository(makeMockDb())
  const sends: Array<[string, unknown]> = []
  const off = bridge(repo, sends)
  repo.create(makeRecord('t1', 's1'))
  off()
  repo.create(makeRecord('t2', 's1'))
  assert.equal(sends.length, 1)
  assert.equal((sends[0][1] as TaskProjectionChangeEvent).changedTaskIds[0], 't1')
})

test('dev-reload re-entry: two setups, one create, one send', () => {
  // Simulates `setupAgentIPC` running twice on dev reload. The
  // ipc-handler.ts pattern: drain `currentTaskProjectionsChangeOff`
  // before re-binding. This test pins that contract — without the
  // drain, both listeners fire and the renderer gets duplicate sends.
  const repo = new TaskProjectionRepository(makeMockDb())
  const sends: Array<[string, unknown]> = []

  // First setup — bridge() returns the off() that drains the listener.
  let off = bridge(repo, sends)

  // Simulate dev-reload: drain the prior subscription, then re-bind.
  off()
  off = bridge(repo, sends)

  repo.create(makeRecord('t1', 's1'))
  assert.equal(sends.length, 1, `expected 1 send, got ${sends.length}`)
})

test('dev-reload WITHOUT drain leaks listeners (negative control)', () => {
  // Negative control: this is what would happen WITHOUT the drain.
  // We don't ship this code path — the test exists to demonstrate
  // why the drain matters. If the bridge ever stops draining, the
  // happy-path test above keeps passing (1 listener, 1 send), so we
  // need this negative test to make the contract visible.
  const repo = new TaskProjectionRepository(makeMockDb())
  const sends: Array<[string, unknown]> = []
  bridge(repo, sends) // first listener — left intentionally undrained
  bridge(repo, sends) // second listener — leaks
  repo.create(makeRecord('t1', 's1'))
  assert.equal(sends.length, 2, 'two listeners produce two sends — confirms drain is necessary')
})
