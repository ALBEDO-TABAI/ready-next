import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import type { BrowserCapabilityTaskStatus } from '../main/modules/browser-engine/capability-types'
import { BrowserTaskPersistenceService } from '../main/modules/browser-engine/task-persistence-service'
import { taskEventBridge, type TaskEventBridgePayload } from '../main/modules/browser-engine/task-event-bridge'
import {
  __resetBackgroundTaskTerminalReminderForTests,
  __setPendingTaskEventDatabaseForTests,
} from '../main/modules/agent-control/system-reminders/background-task-terminal-reminder'
import type { DatabaseManager as DatabaseManagerInstance } from '../main/modules/database'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

interface FakeBrowserTaskRecord {
  id: string
  kind: string
  status: string
  payload_json: string
  checkpoint_json: string | null
  result_json: string | null
  progress_total: number
  progress_completed: number
  progress_failed: number
  current_label: string | null
  error: string | null
  created_at: string
  started_at: string | null
  updated_at: string
  finished_at: string | null
}

class FakeBrowserRepository {
  readonly tasks = new Map<string, FakeBrowserTaskRecord>()

  createTask(task: FakeBrowserTaskRecord): void {
    this.tasks.set(task.id, { ...task })
  }

  getTask(id: string): FakeBrowserTaskRecord | undefined {
    const task = this.tasks.get(id)
    return task ? { ...task } : undefined
  }

  updateTask(id: string, updates: Partial<FakeBrowserTaskRecord>): void {
    const current = this.tasks.get(id)
    if (!current) return
    const clean = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    ) as Partial<FakeBrowserTaskRecord>
    this.tasks.set(id, { ...current, ...clean })
  }

  listTasks(statuses?: string[]): FakeBrowserTaskRecord[] {
    return [...this.tasks.values()]
      .filter((task) => !statuses || statuses.includes(task.status))
      .map((task) => ({ ...task }))
  }
}

function makeRecord(id: string): FakeBrowserTaskRecord {
  return {
    id,
    kind: 'note_collect',
    status: 'queued',
    payload_json: '{}',
    checkpoint_json: null,
    result_json: null,
    progress_total: 0,
    progress_completed: 0,
    progress_failed: 0,
    current_label: null,
    error: null,
    created_at: '2026-06-21T00:00:00.000Z',
    started_at: null,
    updated_at: '2026-06-21T00:00:00.000Z',
    finished_at: null,
  }
}

describe('browser task persistence', () => {
  it('publishes only mapped browser task statuses to the task event bridge', () => {
    __resetBackgroundTaskTerminalReminderForTests()
    __setPendingTaskEventDatabaseForTests(null)
    const repository = new FakeBrowserRepository()
    const service = new BrowserTaskPersistenceService(repository as never)
    const events: TaskEventBridgePayload[] = []
    const unregister = taskEventBridge.registerProjectionSink((payload) => {
      if (payload.taskId.startsWith('browser-task-publish-map-')) events.push(payload)
    })
    const statuses: BrowserCapabilityTaskStatus[] = [
      'queued',
      'running',
      'waiting_human',
      'paused',
      'completed',
      'failed',
      'cancelled',
    ]

    try {
      for (const status of statuses) {
        const taskId = `browser-task-publish-map-${status}`
        repository.createTask(makeRecord(taskId))
        const updated = service.updateProgress(taskId, {}, { status })
        assert.equal(updated?.status, status)
      }

      assert.deepEqual(
        events.map((event) => [event.taskId, event.status]),
        [
          ['browser-task-publish-map-waiting_human', 'waiting_human'],
          ['browser-task-publish-map-paused', 'paused'],
          ['browser-task-publish-map-completed', 'completed'],
          ['browser-task-publish-map-failed', 'failed'],
        ],
      )
      for (const event of events) {
        assert.equal((event.extra as { taskId?: string } | null)?.taskId, event.taskId)
      }
    } finally {
      unregister()
      __resetBackgroundTaskTerminalReminderForTests()
      __setPendingTaskEventDatabaseForTests(null)
    }
  })

  it('publishes scoped sanitized pause summaries for browser collection terminal events', () => {
    __resetBackgroundTaskTerminalReminderForTests()
    __setPendingTaskEventDatabaseForTests(null)
    const repository = new FakeBrowserRepository()
    const service = new BrowserTaskPersistenceService(repository as never)
    const taskId = 'browser-task-publish-sanitized-max-duration'
    repository.createTask({
      ...makeRecord(taskId),
      payload_json: JSON.stringify({
        scopeId: 'scope-browser-collection',
        plan: {
          sourceTaskId: 'browser-task-visible-source',
          outputRootDir: '/tmp/ready-out',
          notes: [
            { url: 'https://www.xiaohongshu.com/explore/n1?xsec_token=secret-token', title: 'note' },
          ],
        },
      }),
    })
    const events: TaskEventBridgePayload[] = []
    const unregister = taskEventBridge.registerProjectionSink((payload) => {
      if (payload.taskId === taskId) events.push(payload)
    })

    try {
      service.updateProgress(taskId, {
        total: 179,
        completed: 169,
        failed: 0,
        currentLabel: null,
      }, {
        status: 'paused',
        checkpoint: {
          taskId,
          stage: 'note_collect_round',
          cursor: '169',
          partialResults: { cursor: 169 },
        } as never,
        result: {
          stopReason: 'max_duration',
          sourceTaskId: 'browser-task-visible-source',
          outputRootDir: '/tmp/ready-out',
          remaining: 10,
          resumeFromCursor: 169,
          autoContinue: true,
        },
        startedAt: '2026-07-01T00:00:00.000Z',
        finishedAt: '2026-07-01T00:20:00.000Z',
      })

      assert.equal(events.length, 1)
      const extra = events[0].extra as Record<string, unknown>
      assert.equal(events[0].status, 'paused')
      assert.equal(extra.scopeId, 'scope-browser-collection')
      assert.equal(extra.browserTaskId, taskId)
      assert.equal(extra.sourceTaskId, 'browser-task-visible-source')
      assert.equal(extra.stopReason, 'max_duration')
      assert.equal(extra.autoContinue, true)
      assert.equal(extra.canResume, true)
      assert.equal(extra.summary, '单段运行保护暂停：已保存 169/179，剩余 10')
      assert.deepEqual(extra.progress, {
        total: 179,
        completed: 169,
        failed: 0,
        remaining: 10,
        currentLabel: null,
      })
      const serialized = JSON.stringify(extra)
      assert.doesNotMatch(serialized, /xsec_token/)
      assert.doesNotMatch(serialized, /secret-token/)
      assert.doesNotMatch(serialized, /xiaohongshu\.com\/explore\/n1/)
    } finally {
      unregister()
      __resetBackgroundTaskTerminalReminderForTests()
      __setPendingTaskEventDatabaseForTests(null)
    }
  })

  it('keeps waiting_human out of startup pending tasks while visible supervision handles it separately', () => {
    const repository = new FakeBrowserRepository()
    const service = new BrowserTaskPersistenceService(repository as never)
    for (const status of ['queued', 'running', 'paused', 'waiting_human', 'completed'] as const) {
      repository.createTask({ ...makeRecord(`browser-task-${status}`), status })
    }

    assert.deepEqual(
      service.listPendingTasks().map((task) => task.status),
      ['queued', 'running', 'paused'],
    )
  })

  it('does not include undefined fields in browser task update SQL', async () => {
    const { BrowserStore } = await import('../main/modules/database/browser-store')
    let sql = ''
    let params: unknown[] = []
    const fakeManager = {
      db: {
        prepare: (source: string) => ({
          run: (...args: unknown[]) => {
            sql = source
            params = args
          },
        }),
      },
    }

    new BrowserStore(() => fakeManager.db as never).updateBrowserTask( 'browser-task-1', {
      status: 'cancelled',
      checkpoint_json: undefined,
      result_json: undefined,
      progress_completed: 3,
    })

    assert.match(sql, /status = \?/)
    assert.match(sql, /progress_completed = \?/)
    assert.doesNotMatch(sql, /checkpoint_json = \?/)
    assert.doesNotMatch(sql, /result_json = \?/)
    assert.equal(params[0], 'cancelled')
    assert.equal(params[1], 3)
    assert.equal(params[params.length - 1], 'browser-task-1')
  })

  it('preserves existing result and checkpoint when an update omits those fields', async (t) => {
    if (skipIfSqliteUnavailable(t, 'browser-task-persistence: preserve omitted fields')) return
    const { DatabaseManager, DatabaseUnavailableError } = await import('../main/modules/database')
    let db: DatabaseManagerInstance | null = null

    try {
      db = new DatabaseManager(true)
    } catch (error) {
      if (error instanceof DatabaseUnavailableError) {
        t.skip('better-sqlite3 native binding unavailable in this Node runtime')
        return
      }
      throw error
    }

    try {
      db.browser.createBrowserTask({
        id: 'browser-task-preserve',
        kind: 'note_collect',
        status: 'running',
        payload_json: '{}',
        checkpoint_json: JSON.stringify({ stage: 'note_collect_round', cursor: '1' }),
        result_json: JSON.stringify({ collected: ['https://example.com/1'] }),
        progress_total: 2,
        progress_completed: 1,
        progress_failed: 0,
        current_label: 'note 1',
        error: null,
        created_at: '2026-06-05T00:00:00.000Z',
        started_at: '2026-06-05T00:00:00.000Z',
        updated_at: '2026-06-05T00:00:00.000Z',
        finished_at: null,
      })

      db.browser.updateBrowserTask('browser-task-preserve', {
        status: 'cancelled',
        progress_completed: 1,
        current_label: null,
        finished_at: '2026-06-05T00:00:01.000Z',
      })

      const record = db.browser.getBrowserTask('browser-task-preserve')
      assert.ok(record)
      assert.equal(record.status, 'cancelled')
      assert.equal(record.result_json, JSON.stringify({ collected: ['https://example.com/1'] }))
      assert.equal(record.checkpoint_json, JSON.stringify({ stage: 'note_collect_round', cursor: '1' }))
    } finally {
      db?.close()
    }
  })
})
