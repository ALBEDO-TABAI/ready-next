import assert from 'node:assert/strict'
import test from 'node:test'

import { RunProjection } from '../main/modules/agent-control/task-projection/run-projection'
import { syncTaskProjection } from '../main/modules/agent-control/task-projection/task-projection-sync'
import type { ProjectionTruthSnapshot, TaskProjectionRecord, TaskProjectionStore } from '../main/modules/agent-control/contracts/run-contracts'
import type { ConversationScope, ScopeRunEventPayload, ScopeRunSummary } from '../main/modules/agent-control/contracts/types'

function createScope(): ConversationScope {
  return {
    id: 'scope-1',
    agent: 'butler',
    title: '测试会话',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'scope-1',
    meta: {},
    createdAt: '2026-04-17T09:00:00.000Z',
    updatedAt: '2026-04-17T09:00:00.000Z',
  }
}

function createStore(records: Map<string, TaskProjectionRecord>): TaskProjectionStore {
  return {
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
}

test('projection truth snapshots override planning text when building persisted task projections', async () => {
  const summaries = new Map<string, ScopeRunSummary>()
  const projection = new RunProjection({
    getScope: () => createScope(),
    getPrevious: (scopeId) => summaries.get(scopeId),
    setSummary: (scopeId, summary) => {
      summaries.set(scopeId, summary)
    },
    toChannelKey: () => 'local:app',
  })
  const projectionRecords = new Map<string, TaskProjectionRecord>()
  const store = createStore(projectionRecords)
  const payload: ScopeRunEventPayload = {
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    runId: 'run-1',
    taskId: 'task-1',
    phase: 'done',
    latestText: '模型自己总结：也许已经完成',
    timestamp: '2026-04-17T09:01:00.000Z',
  }
  const truth: ProjectionTruthSnapshot = {
    projectionPatch: {
      module: 'document',
      taskTitle: '章节改写',
      taskSummary: '已完成第一段替换',
      steps: [{
        id: 'execute',
        title: '章节改写',
        status: 'done',
        updatedAt: '2026-04-17T09:01:00.000Z',
      }],
      currentStepId: 'execute',
      resumableActions: ['cancel'],
      blockedReason: null,
    },
    transcriptEvents: [{
      kind: 'structured_payload',
      projectionPatch: {
        module: 'document',
        taskTitle: '章节改写',
      },
    }],
  }

  const summary = projection.recordEvent(payload, truth)
  assert.ok(summary)
  await syncTaskProjection(store, summary!, payload, truth)

  const record = projectionRecords.get('task-1')
  assert.equal(record?.taskTitle, '章节改写')
  assert.equal(record?.taskSummary, '已完成第一段替换')
  assert.equal(record?.steps[0]?.title, '章节改写')
  assert.equal(record?.status, 'completed')
})
