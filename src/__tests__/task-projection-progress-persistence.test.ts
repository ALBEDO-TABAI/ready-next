import assert from 'node:assert/strict'
import test from 'node:test'

import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

async function buildInMemoryDb(): Promise<MigrationDatabase> {
  const Database = (await import('better-sqlite3')).default
  return new Database(':memory:') as unknown as MigrationDatabase
}

function makeProjection(progress: TaskProjectionRecord['progress']): TaskProjectionRecord {
  return {
    taskId: 'task-progress',
    scopeId: 'scope-progress',
    runId: 'run-progress',
    parentTaskId: null,
    parentStepId: null,
    taskType: 'short_task',
    module: 'skill',
    taskTitle: '技能执行 · Video Copy Analyzer',
    taskSummary: '下载视频并提取字幕',
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
    progress,
    recentArtifacts: [],
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
  }
}

test('task projection repository persists progress for renderer task cards', async (t) => {
  if (skipIfSqliteUnavailable(t, 'task projection progress persistence')) return
  const db = await buildInMemoryDb()
  runMigrations(db)
  const repo = new TaskProjectionRepository({ getRawDb: () => db as never })
  const runningProgress = {
    stage: 'running',
    completed: 1,
    total: 5,
    coverage: 0.2,
    overallCoverage: 0.2,
    fingerprint: 'video-copy:running:1',
    updatedAt: '2026-05-25T00:00:00.000Z',
    lastError: null,
    detail: '下载视频并提取字幕',
  }

  repo.create(makeProjection(runningProgress))
  assert.deepEqual(repo.get('task-progress')?.progress, runningProgress)

  const completedProgress = {
    ...runningProgress,
    stage: 'completed',
    completed: 5,
    coverage: 1,
    overallCoverage: 1,
    fingerprint: 'video-copy:completed:5',
    detail: '文案分析报告和结构化文字稿已生成。',
  }
  repo.update('task-progress', {
    status: 'completed',
    progress: completedProgress,
    updatedAt: '2026-05-25T00:01:00.000Z',
  })

  const listed = repo.listByScope('scope-progress')
  assert.equal(listed.length, 1)
  assert.deepEqual(listed[0].progress, completedProgress)
})
