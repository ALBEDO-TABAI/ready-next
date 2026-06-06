import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { makeNoteCollectProjectionSink } from '../main/modules/claude-bridge/browser-collection-projection-sink'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'

function createRuntimeStore() {
  const records = new Map<string, TaskProjectionRecord>()
  const store = {
    get: (taskId: string) => records.get(taskId) || null,
    create: (record: TaskProjectionRecord) => {
      records.set(record.taskId, record)
    },
    update: (taskId: string, record: TaskProjectionRecord) => {
      records.set(taskId, record)
    },
  }
  return {
    records,
    runtime: {
      getTaskProjectionStore: () => store,
    },
  }
}

describe('browser collection projection sink', () => {
  it('merges note collection progress into the visible_collect job card', () => {
    const { records, runtime } = createRuntimeStore()
    const sink = makeNoteCollectProjectionSink(runtime as never)

    sink.upsert({
      taskId: 'browser-task-visible-1',
      scopeId: 'scope-1',
      title: '浏览器可见页面采集',
      summary: '已发现 3 条；尚未保存',
      state: 'completed',
      total: 3,
      completed: 0,
      failed: 0,
      discovered: 3,
      saved: 0,
      remaining: 3,
    })
    sink.upsert({
      taskId: 'browser-task-note-1',
      sourceTaskId: 'browser-task-visible-1',
      scopeId: 'scope-1',
      title: '浏览器逐篇采集',
      summary: '已采集 2/3 篇',
      state: 'running',
      total: 3,
      completed: 2,
      failed: 0,
      saved: 2,
      remaining: 1,
    })

    assert.equal(records.size, 1)
    const record = records.get('browser-task-visible-1')
    assert.ok(record)
    assert.equal(record.runId, 'browser-task-note-1')
    assert.equal(record.taskTitle, '浏览器逐篇采集')
    assert.equal(record.progress && typeof record.progress === 'object' ? (record.progress as { completed?: number }).completed : null, 2)
  })

  it('aggregates multiple child collection tasks under the same visible job without double-counting child updates', () => {
    const { records, runtime } = createRuntimeStore()
    const sink = makeNoteCollectProjectionSink(runtime as never)

    sink.upsert({
      taskId: 'browser-task-visible-2',
      scopeId: 'scope-1',
      title: '浏览器可见页面采集',
      summary: '已发现 5 条；尚未保存',
      state: 'completed',
      total: 5,
      completed: 0,
      failed: 0,
      discovered: 5,
      saved: 0,
      remaining: 5,
    })
    sink.upsert({
      taskId: 'browser-task-note-a',
      sourceTaskId: 'browser-task-visible-2',
      scopeId: 'scope-1',
      title: '浏览器逐篇采集',
      summary: '第一批',
      state: 'running',
      total: 3,
      completed: 1,
      failed: 0,
      saved: 1,
      remaining: 2,
    })
    sink.upsert({
      taskId: 'browser-task-note-a',
      sourceTaskId: 'browser-task-visible-2',
      scopeId: 'scope-1',
      title: '浏览器逐篇采集',
      summary: '第一批更新',
      state: 'running',
      total: 3,
      completed: 2,
      failed: 0,
      saved: 2,
      remaining: 1,
    })
    sink.upsert({
      taskId: 'browser-task-note-b',
      sourceTaskId: 'browser-task-visible-2',
      scopeId: 'scope-1',
      title: '浏览器逐篇采集',
      summary: '第二批',
      state: 'running',
      total: 2,
      completed: 1,
      failed: 1,
      saved: 1,
      remaining: 0,
    })

    const record = records.get('browser-task-visible-2')
    assert.ok(record)
    const progress = record.progress as { total?: number; completed?: number; detail?: string } | null
    assert.equal(progress?.total, 5)
    assert.equal(progress?.completed, 3)
    assert.match(progress?.detail || '', /保存 3/)
    assert.match(progress?.detail || '', /失败 1/)
    assert.match(progress?.detail || '', /剩余 1/)
  })

  it('deduplicates saved and failed counts by sourceId across repeated child collection tasks', () => {
    const { records, runtime } = createRuntimeStore()
    const sink = makeNoteCollectProjectionSink(runtime as never)

    sink.upsert({
      taskId: 'browser-task-visible-3',
      scopeId: 'scope-1',
      title: '浏览器可见页面采集',
      summary: '已发现 3 条；尚未保存',
      state: 'completed',
      total: 3,
      completed: 0,
      failed: 0,
      discovered: 3,
      saved: 0,
      remaining: 3,
    })
    sink.upsert({
      taskId: 'browser-task-note-a',
      sourceTaskId: 'browser-task-visible-3',
      scopeId: 'scope-1',
      title: '浏览器逐篇采集',
      summary: '第一轮',
      state: 'completed',
      total: 3,
      completed: 2,
      failed: 0,
      saved: 2,
      remaining: 1,
      completedSourceIds: ['note-1', 'note-2'],
    })
    sink.upsert({
      taskId: 'browser-task-note-b',
      sourceTaskId: 'browser-task-visible-3',
      scopeId: 'scope-1',
      title: '浏览器逐篇采集',
      summary: '第二轮重复采到 note-2，另失败 note-3',
      state: 'completed',
      total: 3,
      completed: 1,
      failed: 1,
      saved: 1,
      remaining: 1,
      completedSourceIds: ['note-2'],
      failedSourceIds: ['note-3'],
    })

    const record = records.get('browser-task-visible-3')
    assert.ok(record)
    const progress = record.progress as { total?: number; completed?: number; detail?: string } | null
    assert.equal(progress?.total, 3)
    assert.equal(progress?.completed, 2)
    assert.match(progress?.detail || '', /保存 2/)
    assert.match(progress?.detail || '', /失败 1/)
    assert.match(progress?.detail || '', /剩余 0/)
  })

  it('settles linked terminal reproject immediately without reviving an already terminal card', () => {
    const { records, runtime } = createRuntimeStore()
    const sink = makeNoteCollectProjectionSink(runtime as never)

    sink.upsert({
      taskId: 'browser-task-visible-4',
      scopeId: 'scope-1',
      title: '浏览器可见页面采集',
      summary: '已发现 3 条；尚未保存',
      state: 'completed',
      total: 3,
      completed: 0,
      failed: 0,
      discovered: 3,
      saved: 0,
      remaining: 3,
    })
    sink.upsert({
      taskId: 'browser-task-note-terminal',
      sourceTaskId: 'browser-task-visible-4',
      scopeId: 'scope-1',
      title: '浏览器逐张点开采集',
      summary: '采集失败：已采集 0/3 篇',
      state: 'failed',
      total: 3,
      completed: 0,
      failed: 3,
      saved: 0,
      remaining: 0,
      terminalDwell: false,
    })

    const record = records.get('browser-task-visible-4')
    assert.ok(record)
    assert.equal(record.status, 'failed')
    assert.equal(record.waitingFor, 'none')

    sink.upsert({
      taskId: 'browser-task-note-terminal-older',
      sourceTaskId: 'browser-task-visible-4',
      scopeId: 'scope-1',
      title: '浏览器逐张点开采集',
      summary: '旧终态不应复活卡片',
      state: 'cancelled',
      total: 3,
      completed: 0,
      failed: 1,
      saved: 0,
      remaining: 2,
      terminalDwell: false,
    })

    const unchanged = records.get('browser-task-visible-4')
    assert.ok(unchanged)
    assert.equal(unchanged.status, 'failed')
    assert.equal(unchanged.runId, 'browser-task-note-terminal')
  })
})
