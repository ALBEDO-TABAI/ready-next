import assert from 'node:assert/strict'
import test from 'node:test'

import { RunProjection } from '../main/modules/agent-control/run-projection'
import { SubtaskRuntime } from '../main/modules/agent-control/subtask-runtime'
import { syncTaskProjection } from '../main/modules/agent-control/task-projection-sync'
import type { TaskProjectionRecord, TaskProjectionStore } from '../main/modules/agent-control/run-contracts'
import type {
  ConversationScope,
  ScopeRunEventPayload,
  ScopeRunSummary,
} from '../main/modules/agent-control/types'

function createScope(): ConversationScope {
  return {
    id: 'scope-1',
    agent: 'butler',
    title: '测试会话',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'scope-1',
    meta: {},
    createdAt: '2026-04-17T10:00:00.000Z',
    updatedAt: '2026-04-17T10:00:00.000Z',
  }
}

function createHarness() {
  const scope = createScope()
  const summaries = new Map<string, ScopeRunSummary>()
  const records = new Map<string, TaskProjectionRecord>()
  const events: ScopeRunEventPayload[] = []
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
  const projection = new RunProjection({
    getScope: (scopeId) => (scopeId === scope.id ? scope : null),
    getPrevious: (scopeId) => summaries.get(scopeId),
    setSummary: (scopeId, summary) => {
      summaries.set(scopeId, summary)
    },
    toChannelKey: () => 'local:app',
  })

  const publishScopeRunEvent = async (payload: ScopeRunEventPayload, projectionTruth?: TaskProjectionRecord['continuationRef']) => {
    events.push(payload)
    const summary = projection.recordEvent(payload, projectionTruth as any)
    if (summary) {
      await syncTaskProjection(store, summary, payload, projectionTruth as any)
    }
  }

  return {
    scope,
    records,
    events,
    publishScopeRunEvent,
  }
}

async function seedParentTask(params: {
  publishScopeRunEvent: (payload: ScopeRunEventPayload) => Promise<void>
  scope: ConversationScope
}) {
  await params.publishScopeRunEvent({
    type: 'started',
    scopeId: params.scope.id,
    agent: params.scope.agent,
    runId: 'run-parent',
    taskId: 'parent-1',
    phase: 'planning',
    module: 'document',
    taskTitle: '父任务',
    taskSummary: '等待子任务执行',
    taskType: 'multi_step_task',
    interactionState: 'running',
    steps: [
      {
        id: 'job-1',
        title: '执行第一个子任务',
        status: 'running',
        updatedAt: '2026-04-17T10:00:00.000Z',
      },
    ],
    currentStepId: 'job-1',
    waitingFor: 'none',
    resumableActions: ['cancel'],
    timestamp: '2026-04-17T10:00:00.000Z',
  })
}

test('SubtaskRuntime creates an independent child projection and full lifecycle for inline workers', async () => {
  const harness = createHarness()
  await seedParentTask(harness)

  const runtime = new SubtaskRuntime({
    publishScopeRunEvent: harness.publishScopeRunEvent,
    runScopedTurn: async () => ({ success: true }),
  })

  const result = await runtime.runInlineWorker({
    scope: harness.scope,
    parentTaskId: 'parent-1',
    parentStepId: 'job-1',
    taskTitle: '子任务：收集引用',
    module: 'document',
    taskType: 'multi_step_task',
    initialSummary: '准备启动子任务',
    initialSteps: [
      {
        id: 'collect_materials',
        title: '读取来源材料',
        status: 'pending',
        updatedAt: '2026-04-17T10:00:00.000Z',
      },
    ],
    runInlineWorker: async ({ emitUpdate }) => {
      emitUpdate({
        phase: 'tool_running',
        taskSummary: '正在读取来源材料',
        steps: [
          {
            id: 'collect_materials',
            title: '读取来源材料',
            status: 'running',
            updatedAt: '2026-04-17T10:01:00.000Z',
          },
        ],
        currentStepId: 'collect_materials',
      })

      return {
        finalText: '子任务完成',
        taskSummary: '已收集 3 条参考链接',
        steps: [
          {
            id: 'collect_materials',
            title: '读取来源材料',
            status: 'done',
            updatedAt: '2026-04-17T10:02:00.000Z',
          },
        ],
        currentStepId: 'collect_materials',
        recentArtifacts: [
          {
            id: 'artifact-1',
            module: 'document',
            kind: 'note',
            label: '参考链接清单',
            createdAt: '2026-04-17T10:02:00.000Z',
          },
        ],
      }
    },
  })

  const child = harness.records.get(result.taskId)
  const parent = harness.records.get('parent-1')

  assert.equal(result.status, 'done')
  assert.ok(child)
  assert.equal(child?.parentTaskId, 'parent-1')
  assert.equal(child?.parentStepId, 'job-1')
  assert.equal(child?.taskTitle, '子任务：收集引用')
  assert.equal(child?.taskSummary, '已收集 3 条参考链接')
  assert.equal(child?.steps[0]?.status, 'done')
  assert.equal(result.projectionTruth?.projectionPatch?.taskTitle, '子任务：收集引用')
  assert.equal(harness.events.some((payload) => payload.taskId === result.taskId && payload.phase === 'planning'), true)
  assert.equal(harness.events.some((payload) => payload.taskId === result.taskId && payload.phase === 'tool_running'), true)
  assert.equal(harness.events.some((payload) => payload.taskId === result.taskId && payload.phase === 'done'), true)
  assert.equal((parent?.steps[0] as any)?.childTasks?.[0]?.taskId, result.taskId)
})

test('SubtaskRuntime keeps child failures isolated from the parent task id and backfills the failed child summary', async () => {
  const harness = createHarness()
  await seedParentTask(harness)

  const runtime = new SubtaskRuntime({
    publishScopeRunEvent: harness.publishScopeRunEvent,
    runScopedTurn: async () => ({ success: true }),
  })

  const result = await runtime.runInlineWorker({
    scope: harness.scope,
    parentTaskId: 'parent-1',
    parentStepId: 'job-1',
    taskTitle: '子任务：写入文档',
    module: 'document',
    taskType: 'multi_step_task',
    runInlineWorker: async ({ emitUpdate }) => {
      emitUpdate({
        phase: 'tool_running',
        taskSummary: '正在写入文档',
        steps: [
          {
            id: 'write_target',
            title: '写入目标文档',
            status: 'running',
            updatedAt: '2026-04-17T10:01:00.000Z',
          },
        ],
        currentStepId: 'write_target',
      })
      throw new Error('写入失败')
    },
  })

  const child = harness.records.get(result.taskId)
  const parent = harness.records.get('parent-1')

  assert.equal(result.status, 'error')
  assert.notEqual(result.taskId, 'parent-1')
  assert.equal(child?.status, 'failed')
  assert.equal(child?.blockedReason, '写入失败')
  assert.match(parent?.steps[0]?.detail || '', /写入失败/)
  assert.equal((parent?.steps[0] as any)?.childTasks?.[0]?.taskId, result.taskId)
})
