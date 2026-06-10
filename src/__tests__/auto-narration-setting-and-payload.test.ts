import assert from 'node:assert/strict'
import { afterEach, describe, it, test } from 'node:test'

import type { BrowserController } from '../main/modules/browser-engine/ipc-handler'
import { taskEventBridge, type TaskEventBridgePayload } from '../main/modules/browser-engine/task-event-bridge'
import { executeBrowserTool } from '../main/modules/tools/browser-tools'
import {
  AGENT_AUTO_NARRATION_CONTINUATION_SETTING_KEY,
  readAgentAutoNarrationContinuationSetting,
} from '../main/modules/settings-engine/agent-auto-narration-setting'
import {
  AutoNarrationContinuationRunner,
  __resetBackgroundTaskTerminalReminderForTests,
  __setPendingTaskEventDatabaseForTests,
  getOldestPendingTaskEvent,
  markPendingTaskEventConsumed,
  registerPendingTaskEventListener,
  type PendingTaskEventDatabase,
} from '../main/modules/agent-control/system-reminders/background-task-terminal-reminder'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('auto-narration-setting-and-payload declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'auto-narration-setting-and-payload transitive sqlite load')
})


interface PendingRow {
  id: number
  event_payload: string
  task_run_id: string | null
  created_at: number
  consumed: number
}

class PendingTaskEventMemoryDb implements PendingTaskEventDatabase {
  readonly rows: PendingRow[] = []
  private nextId = 1

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.startsWith('INSERT INTO pending_task_events')) {
      return {
        run: (eventPayload: unknown, taskRunId: unknown, createdAt: unknown) => {
          this.rows.push({
            id: this.nextId++,
            event_payload: String(eventPayload),
            task_run_id: taskRunId == null ? null : String(taskRunId),
            created_at: Number(createdAt),
            consumed: 0,
          })
          return { lastInsertRowid: this.rows[this.rows.length - 1].id }
        },
        get: () => undefined,
        all: () => [],
      }
    }
    if (normalized.startsWith('SELECT id, event_payload, task_run_id, created_at, consumed FROM pending_task_events WHERE consumed = 0 ORDER BY')) {
      return {
        get: () => this.rows
          .filter((row) => row.consumed === 0)
          .sort((left, right) => left.created_at - right.created_at || left.id - right.id)[0],
        run: () => undefined,
        all: () => [],
      }
    }
    if (normalized.startsWith('UPDATE pending_task_events SET consumed = 1 WHERE id = ?')) {
      return {
        run: (id: unknown) => {
          const row = this.rows.find((item) => item.id === Number(id))
          if (row) row.consumed = 1
        },
        get: () => undefined,
        all: () => [],
      }
    }
    throw new Error(`unexpected pending_task_events SQL: ${normalized}`)
  }
}

function installPendingDb(): PendingTaskEventMemoryDb {
  __resetBackgroundTaskTerminalReminderForTests()
  const db = new PendingTaskEventMemoryDb()
  __setPendingTaskEventDatabaseForTests(db)
  return db
}

afterEach(() => {
  __resetBackgroundTaskTerminalReminderForTests()
})

describe('auto narration setting and browser task payload', () => {
  it('defaults agent.autoNarrationContinuation to true and reads stored false', () => {
    const values = new Map<string, string>()
    const repository = {
      getSetting: (key: string) => values.get(key),
    }

    assert.equal(readAgentAutoNarrationContinuationSetting(repository), true)
    values.set(AGENT_AUTO_NARRATION_CONTINUATION_SETTING_KEY, 'false')
    assert.equal(readAgentAutoNarrationContinuationSetting(repository), false)
  })

  it('keeps pending task events and projection notification without starting narration when setting is off', async () => {
    const db = installPendingDb()
    const projected: TaskEventBridgePayload[] = []
    const startedRows: number[] = []
    const unregisterProjection = taskEventBridge.registerProjectionSink((payload) => {
      projected.push(payload)
    })
    const runner = new AutoNarrationContinuationRunner({
      getOldestPendingTaskEvent,
      markPendingTaskEventConsumed,
      hasActiveNarrationContinuationRun: () => false,
      isAutoNarrationContinuationEnabled: () => false,
      startNarrationContinuationRun: async (row) => {
        startedRows.push(row.id)
        return { success: true }
      },
    })
    const unregisterPendingListener = registerPendingTaskEventListener(() => runner.trigger())

    try {
      taskEventBridge.publish({
        taskId: 'browser-task-auto-narration-off-s2-4',
        status: 'completed',
        extra: {
          scopeId: 'scope-auto-narration-off-s2-4',
          summary: '后台采集完成',
        },
      })
      await Promise.resolve()
      await Promise.resolve()

      assert.equal(db.rows.length, 1)
      assert.equal(db.rows[0].consumed, 0)
      assert.deepEqual(startedRows, [])
      assert.equal(projected.length, 1)
      assert.equal(projected[0].taskId, 'browser-task-auto-narration-off-s2-4')
      assert.equal(projected[0].status, 'completed')
    } finally {
      unregisterPendingListener()
      unregisterProjection()
    }
  })

  it('browser_get_task returns normalized failedItems and suggestedNextAction', async () => {
    const controller = {
      getTask: async () => ({
        taskId: 'browser-task-failure-payload-s2-4',
        kind: 'note_collect',
        status: 'failed',
        progress: { total: 2, completed: 0, failed: 2, currentLabel: null },
        result: {
          failed: [
            { url: 'https://example.com/retry', reason: 'timeout' },
            { url: 'https://example.com/manual', reason: 'permission_denied', attempts: 2, retryable: false },
          ],
        },
      }),
    } as Partial<BrowserController> as BrowserController

    const raw = await executeBrowserTool(
      'browser_get_task',
      { task_id: 'browser-task-failure-payload-s2-4' },
      controller,
    )
    const payload = JSON.parse(raw) as {
      failedItems?: Array<{ url: string; reason: string; attempts: number; retryable: boolean }>
      suggestedNextAction?: string
    }

    assert.deepEqual(payload.failedItems, [
      { url: 'https://example.com/retry', reason: 'timeout', attempts: 1, retryable: true },
      { url: 'https://example.com/manual', reason: 'permission_denied', attempts: 2, retryable: false },
    ])
    assert.equal(payload.suggestedNextAction, 'retry_failed')
  })
})
