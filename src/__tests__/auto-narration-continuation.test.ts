import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { AIModelConfig } from '../shared/ai-providers'
import { classifyIntent } from '../main/modules/agent-control/intent-classifier'
import { buildRequestEnvelope } from '../main/modules/agent-control/contracts/request-envelope'
import { prepareInitialRun } from '../main/modules/agent-control/domain-adapters/run-capability-controller'
import { buildExplicitNoSkillAuthorization } from '../main/modules/agent-control/skills/skill-tool-authorization'
import {
  AutoNarrationContinuationRunner,
  __resetBackgroundTaskTerminalReminderForTests,
  __setPendingTaskEventDatabaseForTests,
  enqueueBackgroundTaskTerminalReminderFromBridge,
  getOldestPendingTaskEvent,
  insertPendingTaskEvent,
  listPendingTaskEventsForTests,
  markPendingTaskEventConsumed,
  type AutoNarrationContinuationResult,
  type PendingTaskEventDatabase,
} from '../main/modules/agent-control/system-reminders/background-task-terminal-reminder'
import {
  registerWaitingHumanBrowserTaskResumePort,
  resumeWaitingHumanBrowserTaskFromBridge,
  type TaskEventBridgePayload,
} from '../main/modules/browser-engine/task-event-bridge'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('auto-narration-continuation declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'auto-narration-continuation transitive sqlite load')
})


const BASE_CONFIG: AIModelConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o',
  toolUseMode: 'auto',
  visionMode: 'auto',
  nativeVideoMode: 'auto',
}

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
    if (normalized.startsWith('SELECT id FROM pending_task_events')) {
      const consumedFilter = normalized.includes('AND consumed = 0')
      return {
        get: (taskRunId: unknown, like: unknown) => {
          const status = String(like).replace(/%/g, '').replace('"status":"', '').replace('"', '')
          const hit = this.rows.find((row) =>
            String(row.task_run_id) === String(taskRunId)
            && row.event_payload.includes(`"status":"${status}"`)
            && (!consumedFilter || row.consumed === 0))
          return hit ? { id: hit.id } : undefined
        },
        run: () => undefined,
        all: () => [],
      }
    }
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
    if (normalized.startsWith('SELECT id, event_payload, task_run_id, created_at, consumed FROM pending_task_events ORDER BY')) {
      return {
        all: () => [...this.rows].sort((left, right) => left.id - right.id),
        run: () => undefined,
        get: () => undefined,
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

function buildNarrationCapabilities() {
  const requestEnvelope = buildRequestEnvelope({
    userText: '播报后台任务完成结果，不执行任何写入动作。',
  })
  return prepareInitialRun({
    config: BASE_CONFIG,
    capabilityProfile: 'local_chat',
    supportsToolCalls: true,
    hasVideoInputs: false,
    hasIncomingVideo: false,
    keepToolsWithVideo: false,
    preferredSkillToolNames: null,
    authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
    executionIntentContext: {
      requestEnvelope,
      intentClassification: classifyIntent(requestEnvelope),
      contextualUserInput: requestEnvelope.primaryInstruction,
      userInstructionText: requestEnvelope.primaryInstruction,
      hasDocumentEnvironment: false,
      hasWidgetTargetContext: false,
      explicitWidgetCreateIntent: false,
      documentWidgetTaskKind: null,
      documentWidgetProfile: null,
    },
    browserDecisionMode: 'free_tool_loop',
    runtimeAvailability: {
      browserHostAvailable: true,
      feishuConnected: false,
    },
    hostContext: {
      userText: requestEnvelope.primaryInstruction,
    },
    runCapabilityMode: 'narration',
  })
}

describe('auto narration continuation', () => {
  test('writes pending task events, starts one narration continuation, and resolves a read-only narration tool surface', async () => {
    const db = installPendingDb()
    const payload: TaskEventBridgePayload = {
      taskId: 'browser-task-finished-1',
      status: 'completed',
      extra: {
        scopeId: 'scope-auto-narration-1',
        summary: '后台采集已完成 3/3',
      },
    }

    enqueueBackgroundTaskTerminalReminderFromBridge(payload)

    assert.equal(db.rows.length, 1)
    assert.equal(db.rows[0].consumed, 0)
    assert.deepEqual(JSON.parse(db.rows[0].event_payload), payload)

    const startedRows: number[] = []
    const runner = new AutoNarrationContinuationRunner({
      getOldestPendingTaskEvent,
      markPendingTaskEventConsumed,
      hasActiveNarrationContinuationRun: () => false,
      startNarrationContinuationRun: async (row) => {
        startedRows.push(row.id)
        return { success: true }
      },
    })

    const result = await runner.drainOnce()

    assert.equal(result, 'started')
    assert.deepEqual(startedRows, [1])
    assert.equal(db.rows[0].consumed, 1)

    const capabilities = buildNarrationCapabilities()
    assert.ok(capabilities.allowedToolNames.includes('file_read_excerpt'))
    assert.ok(capabilities.allowedToolNames.includes('file_search'))
    assert.ok(capabilities.allowedToolNames.includes('web_search'))
    for (const denied of ['browser_navigate', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_task', 'write_file', 'skill_run_shell']) {
      assert.equal(capabilities.allowedToolNames.includes(denied), false, `${denied} must not be exposed`)
    }
  })

  test('collapses concurrent pending events into one active narration continuation', async () => {
    installPendingDb()
    insertPendingTaskEvent({
      taskId: 'browser-task-finished-2a',
      status: 'completed',
      extra: { scopeId: 'scope-auto-narration-2' },
    })
    insertPendingTaskEvent({
      taskId: 'browser-task-finished-2b',
      status: 'completed',
      extra: { scopeId: 'scope-auto-narration-2' },
    })

    let activeRuns = 0
    let maxActiveRuns = 0
    let releaseFirstRun!: () => void
    const firstRunReleased = new Promise<void>((resolve) => {
      releaseFirstRun = resolve
    })
    const runner = new AutoNarrationContinuationRunner({
      getOldestPendingTaskEvent,
      markPendingTaskEventConsumed,
      hasActiveNarrationContinuationRun: () => activeRuns > 0,
      startNarrationContinuationRun: async () => {
        activeRuns += 1
        maxActiveRuns = Math.max(maxActiveRuns, activeRuns)
        await firstRunReleased
        activeRuns -= 1
        return { success: true }
      },
    })

    const first = runner.drainOnce()
    const second = runner.drainOnce()
    await Promise.resolve()
    releaseFirstRun()
    const results = await Promise.all([first, second])

    assert.deepEqual(results.sort(), ['active', 'started'])
    assert.equal(maxActiveRuns, 1)
    assert.equal(listPendingTaskEventsForTests().filter((row) => row.consumed === 1).length, 1)
  })

  test('keeps the pending row unconsumed when narration continuation fails', async () => {
    const db = installPendingDb()
    insertPendingTaskEvent({
      taskId: 'browser-task-finished-3',
      status: 'failed',
      extra: { scopeId: 'scope-auto-narration-3', error: '403 Forbidden' },
    })
    const failures: Array<{ rowId: number; error: string | null }> = []
    const runner = new AutoNarrationContinuationRunner({
      getOldestPendingTaskEvent,
      markPendingTaskEventConsumed,
      hasActiveNarrationContinuationRun: () => false,
      startNarrationContinuationRun: async (): Promise<AutoNarrationContinuationResult> => ({
        success: false,
        error: 'model failed',
      }),
      onNarrationContinuationFailure: (row, error) => failures.push({ rowId: row.id, error }),
    })

    const result = await runner.drainOnce()

    assert.equal(result, 'failed')
    assert.equal(db.rows[0].consumed, 0)
    assert.deepEqual(failures, [{ rowId: 1, error: 'model failed' }])
  })

  test('resumes the original browser task when waiting_human confirmation reaches the bridge', async () => {
    const resumedTaskIds: string[] = []
    const unregister = registerWaitingHumanBrowserTaskResumePort({
      getTask: async (taskId) => ({
        taskId,
        kind: 'note_collect',
        status: 'waiting_human',
        progress: { total: 2, completed: 0, failed: 0, currentLabel: null },
      }),
      resumeTask: async (taskId) => {
        resumedTaskIds.push(taskId)
        return {
          taskId,
          kind: 'note_collect',
          status: 'running',
          progress: { total: 2, completed: 0, failed: 0, currentLabel: null },
        }
      },
    })

    try {
      const result = await resumeWaitingHumanBrowserTaskFromBridge({
        taskId: 'browser-task-waiting-human-s2-4',
        confirmed: true,
      })

      assert.equal(result.success, true)
      assert.deepEqual(resumedTaskIds, ['browser-task-waiting-human-s2-4'])
    } finally {
      unregister()
    }
  })
})

test('durable dedupe suppresses duplicate terminal pending rows across restarts', () => {
  const db = new PendingTaskEventMemoryDb()
  __setPendingTaskEventDatabaseForTests(db as never)
  try {
    const payload = { taskId: 'task-dup', status: 'completed' } as never
    const first = insertPendingTaskEvent(payload)
    const second = insertPendingTaskEvent(payload)
    assert.ok(first, 'first insert lands')
    assert.equal(second, null, 'duplicate terminal event is suppressed at the DB layer')
  } finally {
    __setPendingTaskEventDatabaseForTests(null)
  }
})

test('narration runner gives up loudly after three failures and unblocks the queue', async () => {
  const consumed: number[] = []
  let failures = 0
  const runner = new AutoNarrationContinuationRunner({
    getOldestPendingTaskEvent: () => ({ id: 7, eventPayload: '{}', taskRunId: 't', createdAt: 1, consumed: 0 }),
    markPendingTaskEventConsumed: (id) => consumed.push(id),
    hasActiveNarrationContinuationRun: () => false,
    startNarrationContinuationRun: async () => {
      failures += 1
      return { success: false, error: 'boom' }
    },
  })
  const realNow = Date.now
  let fake = 1_000_000
  Date.now = () => fake
  try {
    for (let i = 0; i < 3; i++) {
      await runner.drainOnce()
      fake += 31_000
    }
  } finally {
    Date.now = realNow
  }
  assert.equal(failures, 3)
  assert.deepEqual(consumed, [7], 'third failure consumes the row so newer events stop starving')
})
