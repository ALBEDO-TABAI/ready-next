import assert from 'node:assert/strict'
import test from 'node:test'

import { isBackgroundTaskRun } from '../renderer/components/agent/chat-panel/helpers/badges'
import type { TaskCardRun } from '../renderer/components/agent/task-card-from-projection'

test('completed browser collection outputs stay in the fixed task area until dismissed', () => {
  const run = {
    scopeId: 'scope-1',
    taskId: 'browser-task-1',
    module: 'browser',
    phase: 'done',
    status: 'completed',
    interactionState: 'suspended',
    steps: [],
    toolTrace: [],
    recentArtifacts: [{
      id: 'output',
      module: 'browser',
      kind: 'collection_output',
      label: '采集结果文件夹',
      path: '/tmp/Ready采集/profile',
      createdAt: '2026-07-15T00:00:00.000Z',
    }],
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:00:01.000Z',
  } as TaskCardRun

  assert.equal(isBackgroundTaskRun(run), true)
  assert.equal(isBackgroundTaskRun({ ...run, recentArtifacts: [] }), false)
})
