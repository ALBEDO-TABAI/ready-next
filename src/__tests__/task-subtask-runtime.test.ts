import assert from 'node:assert/strict'
import test from 'node:test'

import { RunCoordinator } from '../main/modules/agent-control/task-projection/run-coordinator'
import { syncTaskProjection } from '../main/modules/agent-control/task-projection/task-projection-sync'
import type { TaskProjectionRecord, TaskProjectionStore } from '../main/modules/agent-control/contracts/run-contracts'
import type {
  ConversationScope,
  ScopeRunEventPayload,
  ScopeRunMemoryCapture,
  ScopeRunSummary,
} from '../main/modules/agent-control/contracts/types'

function createScope(): ConversationScope {
  return {
    id: 'scope-1',
    agent: 'butler',
    title: '测试会话',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'scope-1',
    meta: {},
    createdAt: '2026-04-16T10:00:00.000Z',
    updatedAt: '2026-04-16T10:00:00.000Z',
  }
}

test('syncTaskProjection backfills child task summary into the parent step state', async () => {
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

  records.set('parent-1', {
    taskId: 'parent-1',
    scopeId: 'scope-1',
    runId: 'run-parent',
    taskType: 'multi_step_task',
    module: 'document',
    taskTitle: '整理文档',
    taskSummary: '等待子任务返回结果',
    status: 'running',
    interactionState: 'running',
    steps: [
      {
        id: 'collect',
        title: '收集引用',
        description: '先补齐引用材料',
        status: 'running',
        updatedAt: '2026-04-16T10:00:00.000Z',
      },
    ],
    currentStepId: 'collect',
    resumableActions: ['cancel'],
    recentArtifacts: [],
    createdAt: '2026-04-16T10:00:00.000Z',
    updatedAt: '2026-04-16T10:00:00.000Z',
  } as any)

  const summary: ScopeRunSummary = {
    scopeId: 'scope-1',
    agent: 'butler',
    title: '测试会话',
    sourceKind: 'local',
    sourceId: 'app',
    channelKey: 'local:app',
    threadKey: 'scope-1',
    phase: 'done',
    taskId: 'child-1',
    taskTitle: '收集引用',
    taskSummary: '已收集 3 条参考链接',
    taskType: 'direct_answer',
    interactionState: 'running',
    steps: [],
    currentStepId: null,
    waitingFor: 'none',
    resumableActions: ['none'],
    recentArtifacts: [
      {
        id: 'artifact-child-1',
        module: 'document',
        kind: 'note',
        label: '参考链接清单',
        createdAt: '2026-04-16T10:05:00.000Z',
      },
    ],
    taskProjectionId: 'child-1',
    updatedAt: '2026-04-16T10:05:00.000Z',
  }

  const payload: ScopeRunEventPayload = {
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    runId: 'run-child',
    taskId: 'child-1',
    taskOrigin: 'workflow_child',
    ownerAgentId: 'butler',
    phase: 'done',
    module: 'document',
    parentTaskId: 'parent-1',
    parentStepId: 'collect',
    timestamp: '2026-04-16T10:05:00.000Z',
  } as any

  await syncTaskProjection(store, summary, payload)

  const child = records.get('child-1')
  assert.equal(child?.parentTaskId, 'parent-1')
  assert.equal(child?.parentStepId, 'collect')
  assert.equal(child?.taskSummary, '已收集 3 条参考链接')

  const parent = records.get('parent-1')
  assert.ok(parent)
  assert.match(parent?.steps[0]?.detail || '', /已收集 3 条参考链接/)
  assert.match(parent?.steps[0]?.detail || '', /参考链接清单/)
  assert.equal((parent?.steps[0] as any)?.childTasks?.[0]?.taskId, 'child-1')
})

test('syncTaskProjection keeps a running child placeholder and then upgrades it when the child finishes', async () => {
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

  records.set('parent-1', {
    taskId: 'parent-1',
    scopeId: 'scope-1',
    runId: 'run-parent',
    taskType: 'multi_step_task',
    module: 'document',
    taskTitle: '整理文档',
    taskSummary: '等待子任务返回结果',
    status: 'running',
    interactionState: 'running',
    steps: [
      {
        id: 'collect',
        title: '收集引用',
        description: '先补齐引用材料',
        status: 'running',
        updatedAt: '2026-04-16T10:00:00.000Z',
      },
    ],
    currentStepId: 'collect',
    resumableActions: ['cancel'],
    recentArtifacts: [],
    createdAt: '2026-04-16T10:00:00.000Z',
    updatedAt: '2026-04-16T10:00:00.000Z',
  } as any)

  await syncTaskProjection(store, {
    scopeId: 'scope-1',
    agent: 'butler',
    title: '测试会话',
    sourceKind: 'local',
    sourceId: 'app',
    channelKey: 'local:app',
    threadKey: 'scope-1',
    phase: 'tool_running',
    taskId: 'child-2',
    taskTitle: '收集引用',
    taskSummary: '正在读取来源文件',
    taskType: 'multi_step_task',
    interactionState: 'running',
    steps: [],
    currentStepId: null,
    waitingFor: 'none',
    resumableActions: ['cancel'],
    recentArtifacts: [],
    taskProjectionId: 'child-2',
    updatedAt: '2026-04-16T10:03:00.000Z',
  }, {
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    runId: 'run-child-2',
    taskId: 'child-2',
    taskOrigin: 'workflow_child',
    ownerAgentId: 'butler',
    phase: 'tool_running',
    module: 'document',
    parentTaskId: 'parent-1',
    parentStepId: 'collect',
    timestamp: '2026-04-16T10:03:00.000Z',
  } as any)

  const parentWhileRunning = records.get('parent-1')
  assert.equal((parentWhileRunning?.steps[0] as any)?.childTasks?.[0]?.status, 'running')
  assert.match(parentWhileRunning?.steps[0]?.detail || '', /正在读取来源文件/)

  await syncTaskProjection(store, {
    scopeId: 'scope-1',
    agent: 'butler',
    title: '测试会话',
    sourceKind: 'local',
    sourceId: 'app',
    channelKey: 'local:app',
    threadKey: 'scope-1',
    phase: 'done',
    taskId: 'child-2',
    taskTitle: '收集引用',
    taskSummary: '已收集完成',
    taskType: 'multi_step_task',
    interactionState: 'running',
    steps: [],
    currentStepId: null,
    waitingFor: 'none',
    resumableActions: ['none'],
    recentArtifacts: [
      {
        id: 'artifact-child-2',
        module: 'document',
        kind: 'note',
        label: '引用列表',
        createdAt: '2026-04-16T10:04:00.000Z',
      },
    ],
    taskProjectionId: 'child-2',
    updatedAt: '2026-04-16T10:04:00.000Z',
  }, {
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    runId: 'run-child-2',
    taskId: 'child-2',
    phase: 'done',
    module: 'document',
    parentTaskId: 'parent-1',
    parentStepId: 'collect',
    timestamp: '2026-04-16T10:04:00.000Z',
  } as any)

  const parentAfterDone = records.get('parent-1')
  assert.equal((parentAfterDone?.steps[0] as any)?.childTasks?.[0]?.status, 'completed')
  assert.match(parentAfterDone?.steps[0]?.detail || '', /已收集完成/)
  assert.match(parentAfterDone?.steps[0]?.detail || '', /引用列表/)
})

test('RunCoordinator preserves parent-child task linkage in emitted scope events', async () => {
  const events: ScopeRunEventPayload[] = []

  const coordinator = new RunCoordinator({
    promptAssembly: {
      buildForScopedRun: async () => ({
        systemPrompt: 'system prompt',
        bootstrapMessages: [],
        memoryRefs: [],
        triggerHits: [],
        contextBudget: { totalChars: 20, l0Chars: 10, l1Chars: 10, l2Chars: 0, droppedRefs: [] },
      }),
      applyToMessage: (message) => message,
      recordRunOutcome: () => {},
    },
    executeAndCollect: async () => ({
      success: true,
      finalText: 'child done',
      cancelled: false,
      usedTools: [],
      taskId: 'child-1',
      taskType: 'direct_answer',
      interactionState: 'running',
      taskProjectionId: 'child-1',
    }),
    emitScopeRunEvent: (payload) => {
      events.push(payload)
    },
    reflectOnConversation: async (): Promise<ScopeRunMemoryCapture | null> => null,
  })

  await coordinator.runScoped({
    scope: createScope(),
    message: '整理引用',
    requestId: 'req-child',
    taskId: 'child-1',
    parentTaskId: 'parent-1',
    parentStepId: 'collect',
    coordinators: []
  } as any)

  assert.equal((events[0] as any).parentTaskId, 'parent-1')
  assert.equal((events[0] as any).parentStepId, 'collect')
  assert.equal((events.at(-1) as any).parentTaskId, 'parent-1')
  assert.equal((events.at(-1) as any).parentStepId, 'collect')
})
