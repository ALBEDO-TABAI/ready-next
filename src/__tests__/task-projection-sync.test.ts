import assert from 'node:assert/strict'
import test from 'node:test'

import { syncTaskProjection } from '../main/modules/agent-control/task-projection-sync'
import type { TaskProjectionRecord, TaskProjectionStore } from '../main/modules/agent-control/run-contracts'
import type { ScopeRunEventPayload, ScopeRunSummary } from '../main/modules/agent-control/types'

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
