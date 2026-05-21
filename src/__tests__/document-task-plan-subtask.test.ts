import assert from 'node:assert/strict'
import test from 'node:test'

import { RunProjection } from '../main/modules/agent-control/task-projection/run-projection'
import { SubtaskRuntime } from '../main/modules/agent-control/subtask-runtime'
import { runDocumentTaskPlanWithSubtasks } from '../main/modules/agent-control/document-pipeline/document-task-subtask-runner'
import { syncTaskProjection } from '../main/modules/agent-control/task-projection/task-projection-sync'
import type { DocumentTaskPlan } from '../main/modules/agent-control/document-pipeline/document-task-plan'
import type { TaskProjectionRecord, TaskProjectionStore } from '../main/modules/agent-control/contracts/run-contracts'
import type {
  ConversationScope,
  ScopeRunEventPayload,
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
    createdAt: '2026-04-17T10:00:00.000Z',
    updatedAt: '2026-04-17T10:00:00.000Z',
  }
}

function createPlan(jobCount: number): DocumentTaskPlan {
  const jobs = Array.from({ length: jobCount }, (_, index) => ({
    id: `job-${index + 1}`,
    instruction: `根据 来源${index + 1} 在 目标文档 中做卡片`,
    action: 'compose_widget' as const,
    steps: [
      'collect_materials',
      'build_insight',
      'compose_widget',
      'write_target',
      'save_target',
      'verify_result',
    ] as const,
    bindings: [
      {
        role: 'primary_source' as const,
        resource: {
          id: `source-${index + 1}`,
          kind: 'attachment' as const,
          source: 'explicit_reference' as const,
          name: `来源${index + 1}.md`,
          path: `/docs/source-${index + 1}.md`,
          text: `来源${index + 1}内容`,
          summary: `来源${index + 1}摘要`,
          order: index,
          canRead: true,
          canWrite: false,
        },
      },
      {
        role: 'target_document' as const,
        resource: {
          id: 'target',
          kind: 'file' as const,
          source: 'explicit_reference' as const,
          name: '目标文档.md',
          path: '/docs/target.md',
          text: '目标文档内容',
          summary: null,
          order: 10,
          canRead: true,
          canWrite: true,
        },
      },
    ],
  }))

  return {
    requiresStructuredPlan: true,
    jobs,
    blockedReason: null,
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

  return { scope, records, events, publishScopeRunEvent }
}

async function seedParentTask(params: {
  scope: ConversationScope
  publishScopeRunEvent: (payload: ScopeRunEventPayload) => Promise<void>
}) {
  await params.publishScopeRunEvent({
    type: 'started',
    scopeId: params.scope.id,
    agent: params.scope.agent,
    runId: 'run-parent',
    taskId: 'parent-task',
    phase: 'planning',
    module: 'document',
    taskTitle: '文档信息卡',
    taskSummary: '准备执行文档任务',
    taskType: 'multi_step_task',
    interactionState: 'running',
    waitingFor: 'none',
    resumableActions: ['cancel'],
    timestamp: '2026-04-17T10:00:00.000Z',
  })
}

test('runDocumentTaskPlanWithSubtasks executes multi-job document plans through child subtasks in order', async () => {
  const harness = createHarness()
  await seedParentTask(harness)

  const subtaskRuntime = new SubtaskRuntime({
    publishScopeRunEvent: harness.publishScopeRunEvent,
  })
  const parentPatches: Record<string, unknown>[] = []

  const result = await runDocumentTaskPlanWithSubtasks({
    plan: createPlan(2),
    scope: harness.scope,
    parentTaskId: 'parent-task',
    parentRunId: 'run-parent',
    subtaskRuntime,
    publishParentScopeRunEvent: harness.publishScopeRunEvent,
    emitStructuredTaskPayload: (payload) => {
      parentPatches.push(payload)
    },
    runJob: async ({ jobIndex, emitChildUpdate }) => {
      emitChildUpdate({
        phase: 'tool_running',
        taskSummary: `job-${jobIndex + 1} 正在读取材料`,
        steps: [
          {
            id: 'collect_materials',
            title: '读取来源材料',
            status: 'done',
            updatedAt: `2026-04-17T10:0${jobIndex}:00.000Z`,
          },
          {
            id: 'build_insight',
            title: '提炼重点',
            status: 'done',
            updatedAt: `2026-04-17T10:1${jobIndex}:00.000Z`,
          },
          {
            id: 'compose_widget',
            title: '生成卡片草稿',
            status: 'done',
            updatedAt: `2026-04-17T10:2${jobIndex}:00.000Z`,
          },
          {
            id: 'write_target',
            title: '写入目标文档',
            status: 'done',
            updatedAt: `2026-04-17T10:3${jobIndex}:00.000Z`,
          },
          {
            id: 'save_target',
            title: '保存目标文档',
            status: 'done',
            updatedAt: `2026-04-17T10:4${jobIndex}:00.000Z`,
          },
          {
            id: 'verify_result',
            title: '核对结果',
            status: 'done',
            updatedAt: `2026-04-17T10:5${jobIndex}:00.000Z`,
          },
        ],
        currentStepId: 'verify_result',
      })

      return {
        finalText: `job-${jobIndex + 1} 完成`,
        taskSummary: `job-${jobIndex + 1} 已完成`,
        recentArtifacts: [
          {
            id: `artifact-${jobIndex + 1}`,
            module: 'document',
            kind: 'note',
            label: `job-${jobIndex + 1} 结果`,
            createdAt: `2026-04-17T10:5${jobIndex}:00.000Z`,
          },
        ],
        writeSummary: '已写入目标文档',
        saveSummary: '已保存目标文档',
        verifySummary: '核对通过',
      }
    },
  })

  const childRecords = Array.from(harness.records.values()).filter((record) => record.parentTaskId === 'parent-task')
  const parent = harness.records.get('parent-task')

  assert.equal(result.success, true)
  assert.equal(childRecords.length, 2)
  assert.equal(childRecords[0]?.steps.length, 6)
  assert.equal(childRecords[1]?.steps.length, 6)
  assert.equal(parent?.steps.length, 2)
  assert.equal(parent?.steps[0]?.id, 'job-1')
  assert.equal(parent?.steps[1]?.id, 'job-2')
  assert.equal((parent?.steps[0] as any)?.childTasks?.length, 1)
  assert.equal((parent?.steps[1] as any)?.childTasks?.length, 1)
  assert.match(String(parentPatches.at(-1)?.taskSummary || ''), /完成|已/)
})

test('runDocumentTaskPlanWithSubtasks stops on the first failing child and keeps finished child results', async () => {
  const harness = createHarness()
  await seedParentTask(harness)

  const subtaskRuntime = new SubtaskRuntime({
    publishScopeRunEvent: harness.publishScopeRunEvent,
  })

  const result = await runDocumentTaskPlanWithSubtasks({
    plan: createPlan(2),
    scope: harness.scope,
    parentTaskId: 'parent-task',
    parentRunId: 'run-parent',
    subtaskRuntime,
    publishParentScopeRunEvent: harness.publishScopeRunEvent,
    emitStructuredTaskPayload: () => {},
    runJob: async ({ jobIndex, emitChildUpdate }) => {
      emitChildUpdate({
        phase: 'tool_running',
        taskSummary: `job-${jobIndex + 1} 进行中`,
        steps: [
          {
            id: 'collect_materials',
            title: '读取来源材料',
            status: 'running',
            updatedAt: `2026-04-17T10:0${jobIndex}:00.000Z`,
          },
        ],
        currentStepId: 'collect_materials',
      })

      if (jobIndex === 1) {
        throw new Error('第二个 job 写入失败')
      }

      return {
        finalText: 'job-1 完成',
        taskSummary: 'job-1 已完成',
        writeSummary: '已写入目标文档',
        saveSummary: '已保存目标文档',
        verifySummary: '核对通过',
      }
    },
  })

  const childRecords = Array.from(harness.records.values()).filter((record) => record.parentTaskId === 'parent-task')
  assert.equal(result.success, false)
  assert.equal(childRecords.length, 2)
  assert.equal(childRecords.filter((record) => record.status === 'done').length, 1)
  assert.equal(childRecords.filter((record) => record.status === 'failed').length, 1)
  assert.match(result.error || '', /第二个 job 写入失败/)
})

test('single-job document plans stay inline and do not create child task projections', async () => {
  const harness = createHarness()
  await seedParentTask(harness)

  const subtaskRuntime = new SubtaskRuntime({
    publishScopeRunEvent: harness.publishScopeRunEvent,
  })

  const result = await runDocumentTaskPlanWithSubtasks({
    plan: createPlan(1),
    scope: harness.scope,
    parentTaskId: 'parent-task',
    parentRunId: 'run-parent',
    subtaskRuntime,
    publishParentScopeRunEvent: harness.publishScopeRunEvent,
    emitStructuredTaskPayload: () => {},
    runJob: async ({ jobIndex }) => ({
      finalText: `job-${jobIndex + 1} 完成`,
      taskSummary: `job-${jobIndex + 1} 已完成`,
      writeSummary: '已写入目标文档',
      saveSummary: '已保存目标文档',
      verifySummary: '核对通过',
    }),
  })

  const childRecords = Array.from(harness.records.values()).filter((record) => record.parentTaskId === 'parent-task')

  assert.equal(result.success, true)
  assert.equal(childRecords.length, 0)
})
