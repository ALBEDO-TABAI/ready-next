import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps,
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { buildManualSuspendProjectionPatch } from '../main/modules/agent-control/runtime-core/run-finalizer'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { buildTaskProjectionRecord } from '../main/modules/agent-control/task-projection/task-projection-sync'
import type { ScopeRunEventPayload, ScopeRunSummary } from '../main/modules/agent-control/contracts/types'
import type { TaskProjectionRecord } from '../main/modules/agent-control/contracts/run-contracts'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

interface Statement {
  run(...params: unknown[]): unknown
  all<R = unknown>(...params: unknown[]): R[]
  get<R = unknown>(...params: unknown[]): R | undefined
}

class RunMetaDb {
  private readonly rows = new Map<string, Record<string, unknown>>()

  prepare(sql: string): Statement {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.startsWith('INSERT INTO run_meta')) {
      return {
        run: (...params: unknown[]) => {
          const columns = parseInsertColumns(sql)
          const row: Record<string, unknown> = {}
          columns.forEach((column, index) => {
            row[column] = params[index]
          })
          this.rows.set(String(row.run_id), row)
        },
        all: () => [],
        get: () => undefined,
      }
    }
    if (normalized.startsWith('UPDATE run_meta SET')) {
      return {
        run: (...params: unknown[]) => {
          const assignments = parseUpdateColumns(sql)
          const runId = String(params[assignments.length])
          const row = { ...(this.rows.get(runId) || {}) }
          assignments.forEach((column, index) => {
            row[column] = params[index]
          })
          this.rows.set(runId, row)
        },
        all: () => [],
        get: () => undefined,
      }
    }
    if (normalized === 'SELECT * FROM run_meta WHERE run_id = ?') {
      return {
        get: <R>(runId: unknown) => this.rows.get(String(runId)) as R | undefined,
        all: () => [],
        run: () => undefined,
      }
    }
    throw new Error(`unexpected run_meta statement: ${normalized}`)
  }
}

function parseInsertColumns(sql: string): string[] {
  const match = sql.match(/INSERT INTO run_meta\s*\(([\s\S]+?)\)\s*VALUES/i)
  assert.ok(match, 'insert column list must be parseable')
  return match[1].split(',').map((column) => column.trim())
}

function parseUpdateColumns(sql: string): string[] {
  const match = sql.match(/UPDATE run_meta SET\s*([\s\S]+?)\s*WHERE run_id = \?/i)
  assert.ok(match, 'update column list must be parseable')
  return match[1]
    .split(',')
    .map((assignment) => assignment.trim().split(/\s*=\s*/)[0])
}

function baseProjection(overrides: Partial<TaskProjectionRecord> = {}): TaskProjectionRecord {
  return {
    taskId: 'task-suspend',
    taskOrigin: 'legacy',
    scopeId: 'scope-suspend',
    runId: 'run-suspend',
    taskType: 'multi_step_task',
    module: 'system',
    taskTitle: '暂停测试',
    taskSummary: '运行中',
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
    recentArtifacts: [],
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    ...overrides,
  }
}

test('manual suspend projection patch is recoverable only with a real resume handle', (t) => {
  skipIfSqliteUnavailable(t, 'suspend-run-finalize-semantics transitive sqlite load')

  const resumable = buildManualSuspendProjectionPatch({
    projection: baseProjection({
      continuationRef: {
        taskId: 'task-suspend',
        childRunId: 'child-suspend',
        resumeKind: 'paused',
      },
    }),
    updatedAt: '2026-06-20T01:00:00.000Z',
  })

  assert.equal(resumable.status, 'recoverable_paused')
  assert.equal(resumable.interactionState, 'suspended')
  assert.deepEqual(resumable.resumableActions, ['continue', 'cancel'])
  assert.equal(resumable.blockedReason, '任务已暂停，等待继续。')

  const nonResumable = buildManualSuspendProjectionPatch({
    projection: baseProjection(),
    updatedAt: '2026-06-20T01:00:00.000Z',
  })

  assert.equal(nonResumable.status, 'blocked')
  assert.deepEqual(nonResumable.resumableActions, ['cancel'])
})

test('AgentSdkRuntime manual suspend abort returns checkpoint without writing cancelled run_meta', async (t) => {
  skipIfSqliteUnavailable(t, 'suspend-run-finalize-semantics transitive sqlite load')

  let signalReadyResolve!: () => void
  const signalReady = new Promise<void>((resolve) => {
    signalReadyResolve = resolve
  })
  const repository = new RunMetaRepository(new RunMetaDb() as unknown as ConstructorParameters<typeof RunMetaRepository>[0])
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({
      ok: true,
      config: {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-key',
        model: 'gpt-test',
      },
      reason: 'present',
    }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    runAgent: ({ signal }) => {
      signalReadyResolve()
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('manual_suspend')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    },
  } satisfies Partial<AgentSdkRuntimeDeps>)
  runtime.setRuntime({
    getRunMetaRepository: () => repository,
  } as never)
  runtime.newSession('butler::scope-manual-suspend', 'system prompt')

  const pending = runtime.sendMessage('butler::scope-manual-suspend', 'pause later', 'run-manual-suspend', {
    publicSessionId: 'scope-manual-suspend',
    taskId: 'task-manual-suspend',
  })
  await signalReady
  runtime.stopGeneration('butler::scope-manual-suspend', 'manual_suspend')
  const result = await pending
  const row = repository.get('run-manual-suspend')

  assert.equal(result.success, true)
  assert.equal(result.status, 'checkpoint')
  assert.equal(result.cancelled, false)
  assert.equal(result.terminalReason, 'manual_suspend')
  assert.notEqual(row?.status, 'cancelled')
  assert.notEqual(row?.terminalReason, 'cancelled_runtime')
  assert.notEqual(row?.terminalReason, 'cancelled_user')
})

test('late manual suspend event preserves a finalizer recoverable pause row', (t) => {
  skipIfSqliteUnavailable(t, 'suspend-run-finalize-semantics transitive sqlite load')

  const previous = baseProjection({
    status: 'recoverable_paused',
    interactionState: 'suspended',
    blockedReason: '任务已暂停，等待继续。',
    resumableActions: ['continue', 'cancel'],
    continuationRef: {
      taskId: 'task-suspend',
      childRunId: 'child-suspend',
      resumeKind: 'paused',
    },
  })
  const summary: ScopeRunSummary = {
    scopeId: 'scope-suspend',
    agent: 'butler',
    title: '测试',
    sourceKind: 'local',
    sourceId: 'app',
    channelKey: 'local:app',
    threadKey: 'scope-suspend',
    phase: 'checkpoint',
    runId: 'run-suspend',
    taskId: 'task-suspend',
    interactionState: 'suspended',
    waitingFor: 'none',
    resumableActions: ['cancel'],
    terminalReason: 'manual_suspend',
    updatedAt: '2026-06-20T01:00:00.000Z',
  }
  const payload: ScopeRunEventPayload = {
    type: 'updated',
    scopeId: 'scope-suspend',
    agent: 'butler',
    runId: 'run-suspend',
    taskId: 'task-suspend',
    phase: 'checkpoint',
    terminalReason: 'manual_suspend',
    timestamp: '2026-06-20T01:00:00.000Z',
  }

  const next = buildTaskProjectionRecord(summary, payload, previous)

  assert.ok(next)
  assert.equal(next.status, 'recoverable_paused')
  assert.equal(next.interactionState, 'suspended')
  assert.deepEqual(next.resumableActions, ['continue', 'cancel'])
  assert.deepEqual(next.continuationRef, previous.continuationRef)
})
