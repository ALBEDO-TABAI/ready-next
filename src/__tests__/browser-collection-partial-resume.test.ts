import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserContentTaskRunner } from '../main/modules/browser-engine/content-task-runner'
import type { BrowserCapabilityTaskHandle } from '../main/modules/browser-engine/capability-types'
import type { BrowserTaskPersistenceService } from '../main/modules/browser-engine/task-persistence-service'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('browser-collection-partial-resume declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'browser-collection-partial-resume transitive sqlite load')
})

function makeTask(overrides: Partial<BrowserCapabilityTaskHandle> = {}): BrowserCapabilityTaskHandle {
  return {
    taskId: overrides.taskId || 'browser-task-note-partial',
    kind: overrides.kind || 'note_collect',
    status: overrides.status || 'running',
    progress: overrides.progress || {
      total: 69,
      completed: 47,
      failed: 2,
      currentLabel: 'item 48',
    },
    checkpoint: overrides.checkpoint,
    result: overrides.result,
    error: overrides.error ?? null,
    createdAt: overrides.createdAt || '2026-06-09T08:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-06-09T08:05:00.000Z',
  }
}

test('browser collection startup keeps saved note_collect cursor resumable', async () => {
  const task = makeTask({
    checkpoint: {
      taskId: 'browser-task-note-partial',
      stage: 'note_collect_round',
      cursor: '47',
      partialResults: {
        cursor: 47,
        collected: Array.from({ length: 47 }, (_, index) => ({ url: `https://example.com/${index}` })),
        failed: [],
        outputs: [],
        consecutiveFailures: 0,
        startedAt: 1780000000000,
      },
    },
  })
  const updates: Array<{ taskId: string; extras: Record<string, unknown> }> = []
  const persistence = {
    listPendingTasks: () => [task],
    getTaskPayload: () => ({
      scopeId: 'scope-browser-partial',
      agentTabId: 'stale-agent-tab',
      plan: {
        targetProfileUrl: 'https://www.xiaohongshu.com/user/profile/demo',
        outputRootDir: '/tmp/ready-browser-partial',
        notes: [],
      },
    }),
    updateProgress: (taskId: string, _progress: unknown, extras?: Record<string, unknown>) => {
      updates.push({ taskId, extras: extras || {} })
      return task
    },
  } as unknown as BrowserTaskPersistenceService
  const runner = new BrowserContentTaskRunner({} as never, persistence)

  await runner.resumePendingTasks()

  assert.equal(updates.length, 1)
  assert.equal(updates[0].taskId, 'browser-task-note-partial')
  assert.equal(updates[0].extras.status, 'paused')
  assert.equal(updates[0].extras.finishedAt, null)
  assert.match(String(updates[0].extras.error || ''), /resume from the saved cursor/)
})

test('browser collection startup cancels stale note_collect without cursor', async () => {
  const task = makeTask({
    taskId: 'browser-task-note-empty',
    checkpoint: null,
    progress: { total: 69, completed: 0, failed: 0, currentLabel: null },
  })
  const updates: Array<{ taskId: string; extras: Record<string, unknown> }> = []
  const persistence = {
    listPendingTasks: () => [task],
    getTaskPayload: () => ({ scopeId: 'scope-browser-empty', agentTabId: 'stale-agent-tab', plan: { notes: [] } }),
    updateProgress: (taskId: string, _progress: unknown, extras?: Record<string, unknown>) => {
      updates.push({ taskId, extras: extras || {} })
      return task
    },
  } as unknown as BrowserTaskPersistenceService
  const runner = new BrowserContentTaskRunner({} as never, persistence)

  await runner.resumePendingTasks()

  assert.equal(updates.length, 1)
  assert.equal(updates[0].extras.status, 'cancelled')
  assert.match(String(updates[0].extras.error || ''), /missing saved cursor/)
})
