import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_BOTTOM_BACKGROUND_TASK_CARDS,
  newerTaskSnapshot,
  selectBottomBackgroundTaskRuns,
} from '../renderer/components/agent/chat-panel/task-snapshot/TaskToolSnapshot'
import { taskProjectionToTaskCardRun } from '../renderer/components/agent/task-card-from-projection'

describe('bottom background task card selection', () => {
  it('caps visible bottom cards and reports the hidden count', () => {
    const result = selectBottomBackgroundTaskRuns(['a', 'b', 'c', 'd'])

    assert.equal(result.visibleRuns.length, MAX_BOTTOM_BACKGROUND_TASK_CARDS)
    assert.deepEqual(result.visibleRuns, ['a', 'b'])
    assert.equal(result.hiddenCount, 2)
  })

  it('does not report hidden cards when the list fits', () => {
    const result = selectBottomBackgroundTaskRuns(['a'])

    assert.deepEqual(result.visibleRuns, ['a'])
    assert.equal(result.hiddenCount, 0)
  })

  it('replaces an old parent-task snapshot with a newer live child-run projection', () => {
    const snapshot = taskProjectionToTaskCardRun({
      scopeId: 'scope-1',
      taskId: 'task-parent',
      phase: 'checkpoint',
      status: 'blocked',
      title: '正在处理任务',
      taskSummary: '旧快照还在等待继续',
      taskContinuation: null,
      updatedAt: '2026-06-18T08:39:14.036Z',
    })
    const liveRun = taskProjectionToTaskCardRun({
      scopeId: 'scope-1',
      taskId: 'task-parent',
      phase: 'done',
      status: 'completed',
      title: '技能任务已完成',
      taskSummary: '报告已生成',
      taskContinuation: {
        taskId: 'task-parent',
        childRunId: 'child-done',
      },
      updatedAt: '2026-06-18T09:45:00.000Z',
    })

    assert.equal(newerTaskSnapshot(snapshot, [liveRun]), liveRun)
  })
})
