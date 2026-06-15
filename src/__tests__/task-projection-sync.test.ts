import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import {
  __resetSessionContinuityForTests,
  __setSessionContinuityStoragePathForTests,
  getContinuationState,
} from '../main/modules/agent-control/session/session-continuity'
import { syncTaskProjection } from '../main/modules/agent-control/task-projection/task-projection-sync'
import type { TaskProjectionRecord, TaskProjectionStore } from '../main/modules/agent-control/contracts/run-contracts'
import type { ScopeRunEventPayload, ScopeRunSummary } from '../main/modules/agent-control/contracts/types'

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
    progress: {
      stage: 'running',
      completed: 1,
      total: 5,
      coverage: 0.2,
      overallCoverage: 0.2,
      fingerprint: 'video-copy:running:1',
      updatedAt: '2026-04-16T11:00:00.000Z',
      lastError: null,
      detail: '下载视频并提取字幕',
    },
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
  assert.equal(created?.waitingFor, 'none')
  assert.equal(created?.budgetUsagePercent, 35)
  assert.equal(created?.budget?.stepBudget?.stepId, 'upload')
  assert.equal(created?.steps[0]?.status, 'running')
  assert.equal(created?.recentArtifacts?.[0]?.label, '页面截图')
  assert.equal(created?.progress?.detail, '下载视频并提取字幕')

  const blockedSummary: ScopeRunSummary = {
    ...summary,
    phase: 'takeover',
    interactionState: 'human_takeover',
    waitingFor: 'confirmation',
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
  assert.equal(updated?.waitingFor, 'confirmation')
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

test('syncTaskProjection collapses duplicate skill projections by detached task id', async () => {
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
  const baseSkillSummary: ScopeRunSummary = {
    ...createSummary(),
    taskType: 'short_task',
    phase: 'takeover',
    interactionState: 'suspended',
    waitingFor: 'background',
    blockedReason: '后台任务待续跑',
    taskContinuation: {
      skillId: 'video-expert-analyzer',
      action: 'video_expert_pipeline',
      detachedTaskId: 'dst-vea-1',
      runStatePath: '/tmp/vea/run_state.json',
      outputDir: '/tmp/vea',
    },
    recentArtifacts: [
      {
        id: 'run-state',
        module: 'skill',
        kind: 'json',
        label: 'run_state.json',
        path: '/tmp/vea/run_state.json',
        createdAt: '2026-04-28T01:00:00.000Z',
        meta: {
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          detachedTaskId: 'dst-vea-1',
          outputKey: 'runStatePath',
        },
      },
    ],
  }

  const first = await syncTaskProjection(store, {
    ...baseSkillSummary,
    taskId: 'system-short-a',
    taskSummary: '第一次投影',
    updatedAt: '2026-04-28T01:00:00.000Z',
  }, {
    ...createPayload(),
    taskId: 'system-short-a',
    runId: 'run-a',
    module: 'system',
    timestamp: '2026-04-28T01:00:00.000Z',
  })
  const second = await syncTaskProjection(store, {
    ...baseSkillSummary,
    taskId: 'system-short-b',
    taskSummary: '第二次投影',
    updatedAt: '2026-04-28T01:05:00.000Z',
  }, {
    ...createPayload(),
    taskId: 'system-short-b',
    runId: 'run-b',
    module: 'system',
    timestamp: '2026-04-28T01:05:00.000Z',
  })

  assert.equal(first?.taskId, 'skill:detached:dst-vea-1')
  assert.equal(second?.taskId, 'skill:detached:dst-vea-1')
  assert.equal(records.size, 1)
  assert.equal(records.get('skill:detached:dst-vea-1')?.taskSummary, '第二次投影')
})

test('syncTaskProjection does not keep terminal projections in running interaction state', async () => {
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

  const result = await syncTaskProjection(store, {
    ...createSummary(),
    phase: 'done',
    interactionState: 'running',
    waitingFor: 'none',
    blockedReason: null,
    taskSummary: '已完成',
    updatedAt: '2026-04-28T01:10:00.000Z',
  }, {
    ...createPayload(),
    phase: 'done',
    timestamp: '2026-04-28T01:10:00.000Z',
  })

  assert.equal(result?.status, 'completed')
  assert.equal(result?.interactionState, 'suspended')
})

test('syncTaskProjection does not inherit stale waiting state onto completed records', async () => {
  const records = new Map<string, TaskProjectionRecord>()
  records.set('task-1', {
    taskId: 'task-1',
    scopeId: 'scope-1',
    runId: 'run-1',
    taskType: 'short_task',
    module: 'document',
    taskTitle: '文档任务',
    taskSummary: '文档未改动，已跳过保存',
    status: 'blocked',
    interactionState: 'suspended',
    waitingFor: 'background',
    steps: [],
    currentStepId: null,
    budget: null,
    blockedReason: '文档未改动，已跳过保存',
    resumableActions: ['continue', 'cancel'],
    continuationRef: {
      taskId: 'task-1',
      blockerType: 'background_running',
    },
    recentArtifacts: [],
    createdAt: '2026-04-28T01:09:00.000Z',
    updatedAt: '2026-04-28T01:09:00.000Z',
  })
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

  const result = await syncTaskProjection(store, {
    ...createSummary(),
    phase: 'done',
    taskId: 'task-1',
    taskProjectionId: 'run-1',
    interactionState: undefined,
    waitingFor: undefined,
    blockedReason: null,
    taskContinuation: null,
    resumableActions: [],
    taskSummary: '文档整理完成，现在阅读流畅。',
    updatedAt: '2026-04-28T01:10:00.000Z',
  }, {
    ...createPayload(),
    phase: 'done',
    timestamp: '2026-04-28T01:10:00.000Z',
  })

  assert.equal(result?.status, 'completed')
  assert.equal(result?.waitingFor, 'none')
  assert.equal(result?.blockedReason, null)
  assert.deepEqual(result?.resumableActions, [])
  assert.equal(result?.continuationRef, null)
})

test('syncTaskProjection maps blocked terminal reasons instead of keeping stale running state', async () => {
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

  await syncTaskProjection(store, createSummary(), createPayload())

  const result = await syncTaskProjection(store, {
    ...createSummary(),
    phase: 'checkpoint',
    terminalReason: 'blocked_config',
    interactionState: 'running',
    waitingFor: 'none',
    blockedReason: null,
    resumableActions: ['cancel'],
    taskSummary: '请求失败，需要修复配置',
    updatedAt: '2026-04-28T01:11:00.000Z',
  }, {
    ...createPayload(),
    phase: 'checkpoint',
    terminalReason: 'blocked_config',
    timestamp: '2026-04-28T01:11:00.000Z',
  })

  assert.equal(result?.status, 'blocked')
  assert.equal(result?.interactionState, 'awaiting_clarification')
  assert.equal(result?.waitingFor, 'input')
  assert.equal(result?.blockedReason, '配置需要修复')
  assert.deepEqual(result?.resumableActions, ['continue', 'cancel'])
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

test('syncTaskProjection keeps clarification blockers blocked even when phase is done', async () => {
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

  const summary: ScopeRunSummary = {
    ...createSummary(),
    phase: 'done',
    waitingFor: 'clarification',
    interactionState: 'awaiting_clarification',
    blockedReason: '需要补充目标视频风格',
    resumableActions: ['continue', 'cancel'],
    taskContinuation: {
      taskId: 'task-1',
      stepId: 'collect_input',
      blockerType: 'primitive_ask_user',
      todoId: 'todo-1',
      todoTitle: '补充视频风格',
    },
    updatedAt: '2026-04-26T11:00:00.000Z',
  }

  const result = await syncTaskProjection(store, summary, {
    ...createPayload(),
    phase: 'done',
    timestamp: '2026-04-26T11:00:00.000Z',
  })

  assert.equal(result?.status, 'blocked')
  assert.equal(result?.interactionState, 'awaiting_clarification')
  assert.equal(result?.blockedReason, '需要补充目标视频风格')
  assert.deepEqual(result?.resumableActions, ['continue', 'cancel'])
  assert.deepEqual(result?.continuationRef, {
    taskId: 'task-1',
    stepId: 'collect_input',
    blockerType: 'primitive_ask_user',
    todoId: 'todo-1',
    todoTitle: '补充视频风格',
  })
  assert.equal(getContinuationState('scope-1')?.taskId, 'task-1')
})

test('syncTaskProjection does not materialize blocked background work with only none action', async () => {
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

  const result = await syncTaskProjection(store, {
    ...createSummary(),
    phase: 'done',
    waitingFor: 'background',
    interactionState: 'suspended',
    blockedReason: '预算耗尽但后台仍在跑',
    resumableActions: ['none'],
    taskContinuation: {
      taskId: 'task-1',
      stepId: 'skill_video_expert_pipeline#1',
      blockerType: 'budget_exhausted',
    },
    updatedAt: '2026-04-28T01:00:00.000Z',
  }, {
    ...createPayload(),
    phase: 'done',
    timestamp: '2026-04-28T01:00:00.000Z',
  })

  assert.equal(result?.status, 'blocked')
  assert.equal(result?.waitingFor, 'background')
  assert.deepEqual(result?.resumableActions, ['continue', 'cancel'])
})

test('syncTaskProjection keeps parent blocked while a detached child is still running', async () => {
  const records = new Map<string, TaskProjectionRecord>()
  records.set('parent-task', {
    taskId: 'parent-task',
    scopeId: 'scope-1',
    runId: 'run-parent',
    taskType: 'multi_step_task',
    module: 'skill',
    taskTitle: '父任务',
    taskSummary: '父任务已交接',
    status: 'completed',
    interactionState: 'running',
    steps: [{
      id: 'parent-step',
      title: '后台分析',
      description: '后台分析',
      status: 'done',
      updatedAt: '2026-04-28T01:00:00.000Z',
    }],
    currentStepId: 'parent-step',
    budget: null,
    blockedReason: null,
    resumableActions: ['none'],
    continuationRef: null,
    recentArtifacts: [],
    createdAt: '2026-04-28T01:00:00.000Z',
    updatedAt: '2026-04-28T01:00:00.000Z',
  })
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

  await syncTaskProjection(store, {
    ...createSummary(),
    taskId: 'detached-child',
    taskProjectionId: 'detached-child',
    phase: 'tool_running',
    taskType: 'multi_step_task',
    taskTitle: '后台技能任务',
    taskSummary: '后台仍在运行',
    waitingFor: 'background',
    interactionState: 'suspended',
    blockedReason: '后台仍在运行',
    resumableActions: ['continue', 'cancel'],
    taskContinuation: {
      taskId: 'detached-child',
      detachedTaskId: 'dst-child',
      blockerType: 'background_running',
    },
    parentTaskId: 'parent-task',
    parentStepId: 'parent-step',
    updatedAt: '2026-04-28T01:05:00.000Z',
  }, {
    ...createPayload(),
    taskId: 'detached-child',
    runId: 'detached-child',
    phase: 'tool_running',
    parentTaskId: 'parent-task',
    parentStepId: 'parent-step',
    timestamp: '2026-04-28T01:05:00.000Z',
  })

  const parent = records.get('parent-task')
  assert.equal(parent?.status, 'blocked')
  assert.equal(parent?.interactionState, 'suspended')
  assert.equal(parent?.waitingFor, 'background')
  assert.equal(parent?.blockedReason, '后台仍在运行')
  assert.deepEqual(parent?.resumableActions, ['continue', 'cancel'])
  assert.equal(parent?.continuationRef?.detachedTaskId, 'dst-child')
  assert.equal(parent?.steps[0]?.childTasks?.[0]?.taskId, 'detached-child')
  assert.equal(parent?.steps[0]?.childTasks?.[0]?.status, 'blocked')
})

test('syncTaskProjection demotes resuming interaction state when status is terminal', async () => {
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

  const result = await syncTaskProjection(store, {
    ...createSummary(),
    phase: 'done',
    interactionState: 'resuming',
    waitingFor: 'none',
    blockedReason: null,
    taskSummary: '已完成',
    updatedAt: '2026-04-28T01:11:00.000Z',
  }, {
    ...createPayload(),
    phase: 'done',
    timestamp: '2026-04-28T01:11:00.000Z',
  })

  assert.equal(result?.status, 'completed')
  assert.equal(result?.interactionState, 'suspended')
})

test('syncTaskProjection clears stale blockedReason when frame snapshot says no stale blocker', async () => {
  const records = new Map<string, TaskProjectionRecord>()
  records.set('task-with-stale-blocker', {
    taskId: 'task-with-stale-blocker',
    scopeId: 'scope-1',
    runId: 'run-1',
    taskType: 'short_task',
    module: 'system',
    taskTitle: '历史投影',
    taskSummary: '历史摘要',
    status: 'blocked',
    interactionState: 'suspended',
    waitingFor: 'background',
    steps: [],
    currentStepId: null,
    budget: null,
    blockedReason: '自动并行评分失败：ValueError: 未找到 provider: zai',
    resumableActions: ['continue', 'cancel'],
    continuationRef: null,
    recentArtifacts: [],
    createdAt: '2026-04-26T10:00:00.000Z',
    updatedAt: '2026-04-26T10:00:00.000Z',
  })
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

  const result = await syncTaskProjection(store, {
    ...createSummary(),
    taskId: 'task-with-stale-blocker',
    phase: 'tool_running',
    interactionState: 'running',
    waitingFor: 'none',
    blockedReason: null,
    taskSummary: '继续运行',
    updatedAt: '2026-04-29T05:00:00.000Z',
  }, {
    ...createPayload(),
    taskId: 'task-with-stale-blocker',
    phase: 'tool_running',
    timestamp: '2026-04-29T05:00:00.000Z',
  }, {
    projectionPatch: null,
    transcriptEvents: [],
    frameSnapshot: {
      skill: {
        skillId: 'video-expert-analyzer',
        skillName: 'VEA',
        source: 'supervisor',
        detachedTaskId: 'dst-x',
        runStatePath: null,
        outputDir: null,
        action: null,
        staleBlockerReason: null,
      },
    },
  })

  assert.equal(result?.blockedReason, null)
})

test('syncTaskProjection preserves stale blockedReason when no frame snapshot is provided', async () => {
  const records = new Map<string, TaskProjectionRecord>()
  records.set('task-with-stale-blocker-2', {
    taskId: 'task-with-stale-blocker-2',
    scopeId: 'scope-1',
    runId: 'run-1',
    taskType: 'short_task',
    module: 'system',
    taskTitle: '历史投影',
    taskSummary: '历史摘要',
    status: 'blocked',
    interactionState: 'suspended',
    waitingFor: 'background',
    steps: [],
    currentStepId: null,
    budget: null,
    blockedReason: '自动并行评分失败：ValueError: 未找到 provider: zai',
    resumableActions: ['continue', 'cancel'],
    continuationRef: null,
    recentArtifacts: [],
    createdAt: '2026-04-26T10:00:00.000Z',
    updatedAt: '2026-04-26T10:00:00.000Z',
  })
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

  // Same scenario as the previous test, but no frame snapshot is provided —
  // the existing carry-forward behavior must remain intact when the new turn
  // does not explicitly clear the blocker (`blockedReason` left undefined).
  const result = await syncTaskProjection(store, {
    ...createSummary(),
    taskId: 'task-with-stale-blocker-2',
    phase: 'takeover',
    interactionState: 'awaiting_confirmation',
    waitingFor: 'background',
    taskSummary: '继续待续跑',
    updatedAt: '2026-04-29T05:01:00.000Z',
  }, {
    ...createPayload(),
    taskId: 'task-with-stale-blocker-2',
    phase: 'takeover',
    timestamp: '2026-04-29T05:01:00.000Z',
  })

  assert.equal(result?.blockedReason, '自动并行评分失败：ValueError: 未找到 provider: zai')
})

test('syncTaskProjection preserves continuation data and retry action for failed projections', async () => {
  const records = new Map<string, TaskProjectionRecord>()
  const existing = {
    taskId: 'task-1',
    scopeId: 'scope-1',
    runId: 'run-1',
    taskType: 'short_task',
    module: 'skill',
    taskTitle: '视频任务',
    taskSummary: '等待补充',
    status: 'blocked',
    interactionState: 'awaiting_clarification',
    steps: [],
    currentStepId: 'collect_input',
    budget: null,
    blockedReason: '需要补充目标视频风格',
    resumableActions: ['continue', 'cancel'],
    continuationRef: {
      taskId: 'task-1',
      stepId: 'collect_input',
      blockerType: 'primitive_ask_user',
      todoId: 'todo-1',
      todoTitle: '补充视频风格',
    },
    recentArtifacts: [],
    createdAt: '2026-04-26T10:00:00.000Z',
    updatedAt: '2026-04-26T10:00:00.000Z',
  } satisfies TaskProjectionRecord
  records.set('task-1', existing)
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

  const result = await syncTaskProjection(store, {
    ...createSummary(),
    phase: 'error',
    interactionState: 'running',
    blockedReason: null,
    resumableActions: [],
    taskContinuation: null,
    taskSummary: '执行失败',
    updatedAt: '2026-04-26T10:05:00.000Z',
  }, {
    ...createPayload(),
    phase: 'error',
    timestamp: '2026-04-26T10:05:00.000Z',
  })

  assert.equal(result?.status, 'failed')
  assert.deepEqual(result?.resumableActions, ['retry'])
  assert.deepEqual(result?.continuationRef, existing.continuationRef)
})

test('Stage F1: syncTaskProjection prefers frame snapshot runContract truth for stable identity', async () => {
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

  // Summary intentionally lacks taskContinuation.skillId / detachedTaskId so
  // the heuristic fallback path cannot resolve a skill-keyed identity. The
  // frame snapshot's runContract is the only durable source of truth.
  const summary: ScopeRunSummary = {
    ...createSummary(),
    taskType: 'short_task',
    taskId: 'system-fallback',
    taskContinuation: null,
    recentArtifacts: [],
    updatedAt: '2026-04-29T05:00:00.000Z',
  }
  const payload: ScopeRunEventPayload = {
    ...createPayload(),
    taskId: 'system-fallback',
    runId: 'run-fallback',
    module: 'system',
    timestamp: '2026-04-29T05:00:00.000Z',
  }

  const result = await syncTaskProjection(store, summary, payload, {
    projectionPatch: null,
    transcriptEvents: [],
    frameSnapshot: {
      skill: {
        skillId: 'video-expert-analyzer',
        skillName: 'VEA',
        source: 'supervisor',
        detachedTaskId: 'dst-from-contract',
        runStatePath: '/tmp/contract/run_state.json',
        outputDir: '/tmp/contract',
        action: 'video_expert_pipeline',
        staleBlockerReason: null,
        runContract: {
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          toolName: 'skill_video_expert_pipeline',
          actionInput: { url: 'https://example.com/v1' },
          originalInput: { url: 'https://example.com/v1' },
          sourceUrl: 'https://example.com/v1',
          taskRunId: 'str-contract',
          detachedTaskId: 'dst-from-contract',
          jobId: null,
          outputDir: '/tmp/contract',
          runStatePath: '/tmp/contract/run_state.json',
          artifactPaths: {
            sceneScoresPath: '/tmp/contract/scene_scores.json',
            deliveryReportPath: '/tmp/contract/delivery_report.json',
          },
          status: 'recoverable_paused',
          liveness: 'recoverable_paused',
          progress: {
            stage: 'score_batches',
            totalUnits: 97,
            completedUnits: 12,
            coverageRatio: 12 / 97,
          },
          blocker: { reason: 'budget_exhausted', stale: false },
          projectionIdentity: { stableKey: 'skill:detached:dst-from-contract' },
        },
      },
    },
  })

  // The contract's projectionIdentity.stableKey is the durable id this
  // projection row should use — even though the summary's taskContinuation
  // was empty.
  assert.equal(result?.taskId, 'skill:detached:dst-from-contract')
  assert.equal(records.has('skill:detached:dst-from-contract'), true)
})

test('Phase 7: syncTaskProjection reads child-run identity off contract for projection truth', async () => {
  // Source plan §Phase 7 — the projection primary key MUST be
  // `skill-child:<childRunId>` when the contract carries one, so the
  // projection truth comes from the close event / contract summary
  // instead of artifact path heuristics.
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

  const childRunId = 'va1b2c3d4'
  const summary: ScopeRunSummary = {
    ...createSummary(),
    taskType: 'short_task',
    taskId: 'system-child',
    taskContinuation: null,
    recentArtifacts: [],
    updatedAt: '2026-04-30T05:00:00.000Z',
  }
  const payload: ScopeRunEventPayload = {
    ...createPayload(),
    taskId: 'system-child',
    runId: 'run-child',
    module: 'system',
    timestamp: '2026-04-30T05:00:00.000Z',
  }

  const result = await syncTaskProjection(store, summary, payload, {
    projectionPatch: null,
    transcriptEvents: [],
    frameSnapshot: {
      skill: {
        skillId: 'video-expert-analyzer',
        skillName: 'VEA',
        source: 'tool',
        detachedTaskId: null,
        runStatePath: '/tmp/c/run_state.json',
        outputDir: '/tmp/c',
        action: 'video_expert_pipeline',
        staleBlockerReason: null,
        runContract: {
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          toolName: null,
          actionInput: null,
          originalInput: null,
          sourceUrl: null,
          taskRunId: null,
          // Even with detachedTaskId set, child-run id wins.
          detachedTaskId: 'dst-irrelevant',
          jobId: null,
          outputDir: '/tmp/c',
          runStatePath: '/tmp/c/run_state.json',
          artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
          status: 'running',
          liveness: 'running_process',
          progress: { stage: 'init', totalUnits: null, completedUnits: null, coverageRatio: null },
          blocker: { reason: null, stale: false },
          projectionIdentity: { stableKey: 'skill:detached:dst-irrelevant' },
          childRunId,
        },
      },
    },
  })

  // childRunId wins over BOTH detachedTaskId and projectionIdentity.stableKey.
  assert.equal(result?.taskId, `skill-child:${childRunId}`)
  assert.equal(records.has(`skill-child:${childRunId}`), true)
})

test('T8: projection identity uses the EXACT child handle attached to the contract (no sibling fallback)', async () => {
  // T8 invariant: when `loadSkillRunContract` binds to a specific child
  // (e.g. via exact `outputDir`) and stamps `childRunId` on the contract,
  // the projection primary key MUST be `skill-child:<that childRunId>`.
  // It must NOT fall back to a sibling child running the same skill in the
  // same session (which would happen if projection sync read from a
  // latest-active heuristic instead of the stamped handle).
  const records = new Map<string, TaskProjectionRecord>()
  const store: TaskProjectionStore = {
    create(record) { records.set(record.taskId, record) },
    update(taskId, patch) {
      records.set(taskId, { ...records.get(taskId)!, ...patch })
    },
    get(taskId) { return records.get(taskId) || null },
    listByScope(scopeId) {
      return Array.from(records.values()).filter((record) => record.scopeId === scopeId)
    },
    listByParentTask(parentTaskId) {
      return Array.from(records.values()).filter((record) => record.parentTaskId === parentTaskId)
    },
  }

  const exactChildRunId = 'vt8exact00'
  const siblingChildRunId = 'vt8sibling'
  const summary: ScopeRunSummary = {
    ...createSummary(),
    taskType: 'short_task',
    taskId: 'system-t8',
    taskContinuation: null,
    recentArtifacts: [],
    updatedAt: '2026-04-30T08:00:00.000Z',
  }
  const payload: ScopeRunEventPayload = {
    ...createPayload(),
    taskId: 'system-t8',
    runId: 'run-t8',
    module: 'system',
    timestamp: '2026-04-30T08:00:00.000Z',
  }

  const result = await syncTaskProjection(store, summary, payload, {
    projectionPatch: null,
    transcriptEvents: [],
    frameSnapshot: {
      skill: {
        skillId: 'video-expert-analyzer',
        skillName: 'VEA',
        source: 'tool',
        detachedTaskId: null,
        runStatePath: '/tmp/exact/run_state.json',
        outputDir: '/tmp/exact',
        action: 'video_expert_pipeline',
        staleBlockerReason: null,
        runContract: {
          skillId: 'video-expert-analyzer',
          action: 'video_expert_pipeline',
          toolName: null,
          actionInput: null,
          originalInput: null,
          sourceUrl: null,
          taskRunId: null,
          detachedTaskId: null,
          jobId: null,
          // Exact handles — same skill / session / scope as the sibling,
          // but the contract must already have bound to the EXACT child.
          outputDir: '/tmp/exact',
          runStatePath: '/tmp/exact/run_state.json',
          artifactPaths: { sceneScoresPath: null, deliveryReportPath: null },
          status: 'running',
          liveness: 'running_process',
          progress: { stage: 'init', totalUnits: null, completedUnits: null, coverageRatio: null },
          blocker: { reason: null, stale: false },
          // Projection identity stableKey points elsewhere on purpose:
          // childRunId still wins over the stableKey.
          projectionIdentity: { stableKey: `skill-child:${siblingChildRunId}` },
          childRunId: exactChildRunId,
        },
      },
    },
  })

  assert.equal(
    result?.taskId,
    `skill-child:${exactChildRunId}`,
    'T8: projection identity must use the EXACT contract-attached child handle',
  )
  assert.equal(records.has(`skill-child:${exactChildRunId}`), true)
  assert.equal(
    records.has(`skill-child:${siblingChildRunId}`),
    false,
    'T8: must never alias to a sibling child handle',
  )
})

test('syncTaskProjection clears stale continuation when truth patch explicitly sends null', async () => {
  const records = new Map<string, TaskProjectionRecord>()
  const existing: TaskProjectionRecord = {
    taskId: 'task-vca',
    scopeId: 'scope-1',
    runId: 'run-vca',
    taskType: 'short_task',
    module: 'skill',
    taskTitle: '技能执行 · Video Copy Analyzer',
    taskSummary: '文案分析未完成',
    status: 'failed',
    interactionState: 'suspended',
    waitingFor: 'none',
    steps: [],
    currentStepId: 'skill_video_copy_analyze#1',
    budget: null,
    budgetUsagePercent: null,
    budgetWarningLevel: null,
    blockedReason: '文案分析未完成',
    resumableActions: ['retry', 'cancel'],
    continuationRef: {
      taskId: 'task-vca',
      stepId: 'skill_video_copy_analyze#1',
      blockerType: 'error',
    },
    progress: null,
    recentArtifacts: [],
    createdAt: '2026-05-25T17:39:00.000Z',
    updatedAt: '2026-05-25T17:39:00.000Z',
  }
  records.set(existing.taskId, existing)
  const store: TaskProjectionStore = {
    create(record) { records.set(record.taskId, record) },
    update(taskId, patch) {
      records.set(taskId, {
        ...records.get(taskId)!,
        ...patch,
      })
    },
    get(taskId) { return records.get(taskId) || null },
    listByScope(scopeId) {
      return Array.from(records.values()).filter((record) => record.scopeId === scopeId)
    },
    listByParentTask(parentTaskId) {
      return Array.from(records.values()).filter((record) => record.parentTaskId === parentTaskId)
    },
  }

  const result = await syncTaskProjection(store, {
    ...createSummary(),
    phase: 'done',
    taskId: 'task-vca',
    taskProjectionId: 'task-vca',
    taskType: 'short_task',
    blockedReason: null,
    taskContinuation: null,
    waitingFor: 'none',
    resumableActions: ['open_artifact'],
    updatedAt: '2026-05-25T17:42:00.000Z',
  }, {
    ...createPayload(),
    phase: 'done',
    taskId: 'task-vca',
    runId: 'run-vca',
    module: 'skill',
    timestamp: '2026-05-25T17:42:00.000Z',
  }, {
    projectionPatch: {
      blockedReason: null,
      taskContinuation: null,
      waitingFor: 'none',
      resumableActions: ['open_artifact'],
    },
    transcriptEvents: [],
  })

  assert.equal(result?.status, 'completed')
  assert.equal(result?.blockedReason, null)
  assert.equal(result?.continuationRef, null)
  assert.deepEqual(result?.resumableActions, ['open_artifact'])
})

test('syncTaskProjection clears stale progress when truth patch explicitly sends null', async () => {
  const records = new Map<string, TaskProjectionRecord>()
  const store: TaskProjectionStore = {
    create(record) { records.set(record.taskId, record) },
    update(taskId, patch) {
      records.set(taskId, {
        ...records.get(taskId)!,
        ...patch,
      })
    },
    get(taskId) { return records.get(taskId) || null },
    listByScope(scopeId) {
      return Array.from(records.values()).filter((record) => record.scopeId === scopeId)
    },
    listByParentTask(parentTaskId) {
      return Array.from(records.values()).filter((record) => record.parentTaskId === parentTaskId)
    },
  }

  await syncTaskProjection(store, {
    ...createSummary(),
    taskId: 'task-vca',
    taskProjectionId: 'task-vca',
  }, {
    ...createPayload(),
    taskId: 'task-vca',
    runId: 'run-vca',
    module: 'skill',
  })

  const result = await syncTaskProjection(store, {
    ...createSummary(),
    phase: 'done',
    taskId: 'task-vca',
    taskProjectionId: 'task-vca',
    taskType: 'short_task',
    progress: null,
    updatedAt: '2026-05-25T17:42:00.000Z',
  }, {
    ...createPayload(),
    phase: 'done',
    taskId: 'task-vca',
    runId: 'run-vca',
    module: 'skill',
    timestamp: '2026-05-25T17:42:00.000Z',
  }, {
    projectionPatch: {
      progress: null,
    },
    transcriptEvents: [],
  })

  assert.equal(result?.progress, null)
})
