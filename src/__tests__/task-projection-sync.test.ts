import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import {
  __resetSessionContinuityForTests,
  __setSessionContinuityStoragePathForTests,
  getContinuationState,
} from '../main/modules/agent-control/session-continuity'
import { syncTaskProjection } from '../main/modules/agent-control/task-projection-sync'
import type { TaskProjectionRecord, TaskProjectionStore } from '../main/modules/agent-control/run-contracts'
import type { ScopeRunEventPayload, ScopeRunSummary } from '../main/modules/agent-control/types'

const TEST_STORAGE_PATH = join(tmpdir(), 'ready-task-projection-sync-continuity.json')

beforeEach(() => {
  __setSessionContinuityStoragePathForTests(TEST_STORAGE_PATH)
  __resetSessionContinuityForTests()
})

afterEach(() => {
  __resetSessionContinuityForTests()
  __setSessionContinuityStoragePathForTests(null)
  rmSync(TEST_STORAGE_PATH, { force: true })
})

function createSummary(): ScopeRunSummary {
  return {
    scopeId: 'scope-1',
    agent: 'butler',
    title: '测试会话',
    sourceKind: 'local',
    sourceId: 'app',
    channelKey: 'local:app',
    threadKey: 'scope-1',
    phase: 'tool_running',
    taskTitle: '浏览器任务',
    taskSummary: '正在上传附件',
    taskType: 'media_task',
    interactionState: 'running',
    steps: [
      {
        id: 'upload',
        title: '上传附件',
        status: 'running',
        updatedAt: '2026-04-16T11:00:00.000Z',
      },
    ],
    currentStepId: 'upload',
    waitingFor: 'none',
    resumableActions: ['cancel'],
    recentArtifacts: [
      {
        id: 'artifact-1',
        module: 'browser',
        kind: 'screenshot',
        label: '页面截图',
        createdAt: '2026-04-16T11:00:00.000Z',
      },
    ],
    executionDiagnostics: {
      budget: {
        maxIterations: 60,
        maxToolCalls: 60,
        maxParallelToolGroups: 5,
      },
      stepBudget: {
        stepId: 'upload',
        maxIterations: 20,
        remainingIterations: 14,
      },
      budgetUsagePercent: 35,
      recoveryHistory: [
        {
          kind: 'timeout_model',
          source: 'model_request',
          message: 'timeout',
          attempt: 1,
          recovered: true,
          timestamp: '2026-04-16T11:00:10.000Z',
        },
      ],
      degradationReason: null,
    },
    taskId: 'task-1',
    taskProjectionId: 'run-1',
    updatedAt: '2026-04-16T11:00:00.000Z',
  }
}

function createPayload(): ScopeRunEventPayload {
  return {
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    runId: 'run-1',
    taskId: 'task-1',
    phase: 'tool_running',
    module: 'browser',
    timestamp: '2026-04-16T11:00:00.000Z',
  }
}

test('syncTaskProjection creates and then updates projection records from scope run summaries', async () => {
  const records = new Map<string, TaskProjectionRecord>()
  const store: TaskProjectionStore = {
    create(record) {
      records.set(record.taskId, record)
    },
    update(taskId, patch) {
      records.set(taskId, {
        ...records.get(taskId)!,
        ...patch,
      })
    },
    get(taskId) {
      return records.get(taskId) || null
    },
    listByScope(scopeId) {
      return Array.from(records.values()).filter((record) => record.scopeId === scopeId)
    },
    listByParentTask(parentTaskId) {
      return Array.from(records.values()).filter((record) => record.parentTaskId === parentTaskId)
    },
  }

  const summary = createSummary()
  await syncTaskProjection(store, summary, createPayload())

  const created = records.get('task-1')
  assert.ok(created)
  assert.equal(created?.module, 'browser')
  assert.equal(created?.taskTitle, '浏览器任务')
  assert.equal(created?.taskSummary, '正在上传附件')
  assert.equal(created?.taskType, 'media_task')
  assert.equal(created?.status, 'running')
  assert.equal(created?.budgetUsagePercent, 35)
  assert.equal(created?.budget?.stepBudget?.stepId, 'upload')
  assert.equal(created?.steps[0]?.status, 'running')
  assert.equal(created?.recentArtifacts?.[0]?.label, '页面截图')

  const blockedSummary: ScopeRunSummary = {
    ...summary,
    phase: 'takeover',
    interactionState: 'human_takeover',
    blockedReason: '等待用户输入验证码',
    updatedAt: '2026-04-16T11:01:00.000Z',
  }
  const blockedPayload: ScopeRunEventPayload = {
    ...createPayload(),
    phase: 'takeover',
    timestamp: '2026-04-16T11:01:00.000Z',
  }
  await syncTaskProjection(store, blockedSummary, blockedPayload)

  const updated = records.get('task-1')
  assert.equal(updated?.status, 'blocked')
  assert.equal(updated?.interactionState, 'human_takeover')
  assert.equal(updated?.blockedReason, '等待用户输入验证码')
  assert.equal(updated?.createdAt, '2026-04-16T11:00:00.000Z')
  assert.equal(updated?.updatedAt, '2026-04-16T11:01:00.000Z')
})

test('syncTaskProjection falls back to update when create loses a concurrent insert race', async () => {
  const records = new Map<string, TaskProjectionRecord>()
  const existing = {
    ...createSummary(),
    taskId: 'task-1',
  } as never as TaskProjectionRecord
  records.set('task-1', existing)
  let getCount = 0
  let updateCount = 0
  const store: TaskProjectionStore = {
    create() {
      const error = new Error('UNIQUE constraint failed: task_projections.task_id') as NodeJS.ErrnoException
      error.code = 'SQLITE_CONSTRAINT_PRIMARYKEY'
      throw error
    },
    update(taskId, patch) {
      updateCount += 1
      records.set(taskId, {
        ...records.get(taskId)!,
        ...patch,
      })
    },
    get(taskId) {
      getCount += 1
      return getCount === 1 ? null : records.get(taskId) || null
    },
    listByScope(scopeId) {
      return Array.from(records.values()).filter((record) => record.scopeId === scopeId)
    },
    listByParentTask(parentTaskId) {
      return Array.from(records.values()).filter((record) => record.parentTaskId === parentTaskId)
    },
  }

  const summary = {
    ...createSummary(),
    taskSummary: '并发后更新成功',
    updatedAt: '2026-04-16T11:05:00.000Z',
  }
  const result = await syncTaskProjection(store, summary, createPayload())

  assert.equal(updateCount, 1)
  assert.equal(result?.taskSummary, '并发后更新成功')
  assert.equal(records.get('task-1')?.taskSummary, '并发后更新成功')
})

test('syncTaskProjection keeps older blocked continuation snapshots when a newer task finishes', async () => {
  const records = new Map<string, TaskProjectionRecord>()
  const store: TaskProjectionStore = {
    create(record) {
      records.set(record.taskId, record)
    },
    update(taskId, patch) {
      records.set(taskId, {
        ...records.get(taskId)!,
        ...patch,
      })
    },
    get(taskId) {
      return records.get(taskId) || null
    },
    listByScope(scopeId) {
      return Array.from(records.values()).filter((record) => record.scopeId === scopeId)
    },
    listByParentTask(parentTaskId) {
      return Array.from(records.values()).filter((record) => record.parentTaskId === parentTaskId)
    },
  }

  const blockedTask1: ScopeRunSummary = {
    ...createSummary(),
    taskId: 'task-1',
    taskProjectionId: 'run-1',
    phase: 'takeover',
    interactionState: 'awaiting_confirmation',
    blockedReason: '等待第一个任务继续',
    taskSummary: '任务一待继续',
    updatedAt: '2026-04-16T11:01:00.000Z',
  }
  await syncTaskProjection(store, blockedTask1, {
    ...createPayload(),
    taskId: 'task-1',
    runId: 'run-1',
    phase: 'takeover',
    timestamp: '2026-04-16T11:01:00.000Z',
  })

  const blockedTask2: ScopeRunSummary = {
    ...createSummary(),
    taskId: 'task-2',
    taskProjectionId: 'run-2',
    phase: 'takeover',
    interactionState: 'awaiting_confirmation',
    blockedReason: '等待第二个任务继续',
    taskSummary: '任务二待继续',
    updatedAt: '2026-04-16T11:02:00.000Z',
  }
  await syncTaskProjection(store, blockedTask2, {
    ...createPayload(),
    taskId: 'task-2',
    runId: 'run-2',
    phase: 'takeover',
    timestamp: '2026-04-16T11:02:00.000Z',
  })

  assert.equal(getContinuationState('scope-1')?.taskId, 'task-2')

  const doneTask2: ScopeRunSummary = {
    ...blockedTask2,
    phase: 'done',
    interactionState: 'running',
    blockedReason: null,
    taskSummary: '任务二已完成',
    updatedAt: '2026-04-16T11:03:00.000Z',
  }
  await syncTaskProjection(store, doneTask2, {
    ...createPayload(),
    taskId: 'task-2',
    runId: 'run-2',
    phase: 'done',
    timestamp: '2026-04-16T11:03:00.000Z',
  })

  assert.equal(getContinuationState('scope-1')?.taskId, 'task-1')
})
