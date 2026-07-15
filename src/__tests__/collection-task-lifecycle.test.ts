import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectionTaskIdToCancel,
  selectLinkedCollectionExecution,
} from '../main/modules/browser-engine/collection-task-lifecycle'
import type { BrowserCapabilityTaskHandle } from '../main/modules/browser-engine/capability-types'

function task(taskId: string, kind: BrowserCapabilityTaskHandle['kind'], status: BrowserCapabilityTaskHandle['status']): BrowserCapabilityTaskHandle {
  return {
    taskId,
    kind,
    status,
    progress: { total: 0, completed: 0, failed: 0, currentLabel: null },
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:00.000Z',
  }
}

test('cancelling a visible collection card targets its active linked write task', () => {
  const source = task('browser-task-source', 'visible_collect', 'completed')
  for (const status of ['queued', 'running', 'paused'] as const) {
    assert.equal(
      collectionTaskIdToCancel(source, task('browser-task-child', 'card_loop', status)),
      'browser-task-child',
    )
  }
})

test('completed linked work and standalone tasks keep their own cancellation identity', () => {
  const source = task('browser-task-source', 'visible_collect', 'completed')
  assert.equal(
    collectionTaskIdToCancel(source, task('browser-task-child', 'card_loop', 'completed')),
    'browser-task-source',
  )
  const standalone = task('browser-task-note', 'note_collect', 'running')
  assert.equal(collectionTaskIdToCancel(standalone, null), 'browser-task-note')
})

test('a live linked execution wins over a newer completed retry for status and cancellation', () => {
  const running = {
    ...task('browser-task-running', 'card_loop', 'running'),
    updatedAt: '2026-07-15T00:00:00.000Z',
  }
  const newerCompleted = {
    ...task('browser-task-completed', 'card_loop', 'completed'),
    updatedAt: '2026-07-15T00:05:00.000Z',
  }
  assert.equal(selectLinkedCollectionExecution([newerCompleted, running])?.taskId, running.taskId)
})
