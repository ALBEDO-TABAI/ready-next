import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'

import { reconcileTaskProjections } from '../main/modules/agent-control/task-projection/task-projection-reconciler'
import type { TaskProjectionRecord, TaskProjectionStore } from '../main/modules/agent-control/contracts/run-contracts'
import type { SkillTaskRunRecord } from '../main/modules/repositories/skill-task-run-repository'

const NOW = '2026-06-20T10:00:00.000Z'
const OLD = '2026-06-20T09:00:00.000Z'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createRoot(name: string): string {
  const root = join(tmpdir(), `ready-no-readpath-terminal-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}

function baseProjection(overrides: Partial<TaskProjectionRecord> = {}): TaskProjectionRecord {
  return {
    taskId: 'task-1',
    scopeId: 'scope-1',
    runId: 'run-1',
    parentTaskId: null,
    parentStepId: null,
    taskType: 'short_task',
    module: 'skill',
    taskTitle: 'Task',
    taskSummary: 'running',
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
    resumableActions: ['cancel'],
    continuationRef: null,
    recentArtifacts: [],
    createdAt: OLD,
    updatedAt: OLD,
    ...overrides,
  }
}

function createStore(records: TaskProjectionRecord[]): {
  store: TaskProjectionStore
  records: Map<string, TaskProjectionRecord>
  updates: Array<{ taskId: string; patch: Partial<TaskProjectionRecord> }>
} {
  const map = new Map(records.map((record) => [record.taskId, record]))
  const updates: Array<{ taskId: string; patch: Partial<TaskProjectionRecord> }> = []
  return {
    records: map,
    updates,
    store: {
      create(record) {
        map.set(record.taskId, record)
      },
      update(taskId, patch) {
        updates.push({ taskId, patch })
        map.set(taskId, {
          ...map.get(taskId)!,
          ...patch,
        })
      },
      get(taskId) {
        return map.get(taskId) || null
      },
      listByScope(scopeId) {
        return Array.from(map.values()).filter((record) => record.scopeId === scopeId)
      },
      listByParentTask(parentTaskId) {
        return Array.from(map.values()).filter((record) => record.parentTaskId === parentTaskId)
      },
    },
  }
}

function baseTaskRun(overrides: Partial<SkillTaskRunRecord> = {}): SkillTaskRunRecord {
  return {
    id: 'child-1',
    scopeId: 'scope-1',
    sessionId: 'scope-1',
    agent: null,
    runId: null,
    skillId: 'demo',
    skillName: 'demo',
    action: 'run',
    toolName: null,
    runKind: 'child_run',
    status: 'running',
    interactionState: 'running',
    goalText: null,
    resourceRefs: [],
    params: {},
    steps: [],
    currentStepId: null,
    artifacts: [],
    outputDir: null,
    runStatePath: null,
    sceneScoresPath: null,
    deliveryReportPath: null,
    failureKind: null,
    failureDetail: null,
    jobId: null,
    detachedTaskId: null,
    resumePayload: null,
    createdAt: OLD,
    startedAt: OLD,
    updatedAt: OLD,
    finishedAt: null,
    ...overrides,
  }
}

test('read-path reconcile does not turn completed artifacts into terminal projection status', () => {
  const outputDir = createRoot('done-output')
  const runStatePath = join(outputDir, 'run_state.json')
  writeFileSync(runStatePath, JSON.stringify({ status: 'completed', outputDir }), 'utf8')
  const { store, records, updates } = createStore([
    baseProjection({
      taskId: 'skill:done-output',
      continuationRef: {
        skillId: 'demo',
        action: 'run',
        outputDir,
        runStatePath,
      },
    }),
  ])

  const changes = reconcileTaskProjections({ store, records: Array.from(records.values()), now: NOW })

  const updated = records.get('skill:done-output')!
  assert.equal(changes, 1)
  assert.equal(updated.status, 'running')
  assert.equal(updated.interactionState, 'running')
  assert.equal(updated.waitingFor, 'background')
  assert.equal(updates.length, 1)
  const patch = updates[0]?.patch ?? {}
  assert.equal('status' in patch, false)
  assert.equal(patch.continuationRef?.blockerType, undefined)
  assert.equal(patch.continuationRef?.pauseReason, undefined)
})

test('read-path reconcile still repairs non-terminal stale projections', () => {
  const { store, records, updates } = createStore([
    baseProjection({
      taskId: 'skill:stale-without-handle',
      updatedAt: '2026-06-20T09:00:00.000Z',
      waitingFor: 'background',
      continuationRef: null,
    }),
  ])

  const changes = reconcileTaskProjections({
    store,
    records: Array.from(records.values()),
    now: '2026-06-20T10:00:01.000Z',
  })

  const updated = records.get('skill:stale-without-handle')!
  assert.equal(changes, 1)
  assert.equal(updated.status, 'blocked')
  assert.equal(updated.interactionState, 'suspended')
  assert.equal(updated.waitingFor, 'none')
  assert.equal(updated.degradationReason, 'stale_paused')
  assert.equal(updates.length, 1)
})

test('read-path reconcile does not supersede an older child into killed status', () => {
  const outputDir = createRoot('supersede-output')
  const runStatePath = join(outputDir, 'run_state.json')
  writeFileSync(runStatePath, JSON.stringify({ status: 'completed', outputDir }), 'utf8')
  const oldProjection = baseProjection({
    taskId: 'skill-child:old-child',
    runId: 'old-child',
    status: 'blocked',
    interactionState: 'suspended',
    waitingFor: 'background',
    continuationRef: {
      childRunId: 'old-child',
      skillId: 'demo',
      action: 'run',
      outputDir,
      runStatePath,
    },
  })
  const newProjection = baseProjection({
    taskId: 'skill-child:new-child',
    runId: 'new-child',
    status: 'completed',
    interactionState: 'suspended',
    waitingFor: 'none',
    continuationRef: {
      childRunId: 'new-child',
      skillId: 'demo',
      action: 'run',
      outputDir,
      runStatePath,
    },
  })
  const { store, records, updates } = createStore([oldProjection, newProjection])

  const changes = reconcileTaskProjections({
    store,
    records: Array.from(records.values()),
    taskRuns: [
      baseTaskRun({
        id: 'old-child',
        status: 'blocked',
        outputDir,
        runStatePath,
        updatedAt: OLD,
      }),
      baseTaskRun({
        id: 'new-child',
        status: 'done',
        outputDir,
        runStatePath,
        updatedAt: NOW,
        finishedAt: NOW,
      }),
    ],
    now: NOW,
  })

  const updated = records.get('skill-child:old-child')!
  assert.equal(changes, 2)
  assert.equal(updated.status, 'blocked')
  assert.equal(updated.degradationReason, null)
  assert.equal((updated.continuationRef as { blockerType?: string } | null)?.blockerType, undefined)
  assert.equal((updated.continuationRef as { supersededByChildRunId?: string } | null)?.supersededByChildRunId, undefined)
  const oldUpdate = updates.find((update) => update.taskId === 'skill-child:old-child')
  assert.ok(oldUpdate)
  const patch = oldUpdate.patch
  assert.equal('status' in patch, false)
  assert.equal(patch.degradationReason, undefined)
  assert.equal(patch.continuationRef?.blockerType, undefined)
  assert.equal((patch.continuationRef as { supersededByChildRunId?: string } | null)?.supersededByChildRunId, undefined)
})
