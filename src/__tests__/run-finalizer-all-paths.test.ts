import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps,
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { syncTaskProjection } from '../main/modules/agent-control/task-projection/task-projection-sync'
import { ReflectionService } from '../main/modules/agent-control/reflection-service'
import type { ScopeRunEventPayload, ScopeRunSummary } from '../main/modules/agent-control/contracts/types'
import type { TaskProjectionRecord, TaskProjectionStore } from '../main/modules/agent-control/contracts/run-contracts'

interface Statement {
  run(...params: unknown[]): unknown
  all<R = unknown>(...params: unknown[]): R[]
  get<R = unknown>(...params: unknown[]): R | undefined
}

class RunMetaDb {
  private readonly rows = new Map<string, Record<string, unknown>>()

  exec(_sql: string): void {}

  close(): void {}

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

const fakeConfig = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-test',
} as const

function createRuntime(deps: Partial<AgentSdkRuntimeDeps>): {
  runtime: AgentSdkRuntime
  repository: RunMetaRepository
  outputs: Array<{ runId: string; chunk: string; type: string }>
} {
  const repository = new RunMetaRepository(new RunMetaDb() as unknown as ConstructorParameters<typeof RunMetaRepository>[0])
  const runtime = new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    ...deps,
  })
  runtime.setRuntime({
    getRunMetaRepository: () => repository,
  } as never)
  const outputs: Array<{ runId: string; chunk: string; type: string }> = []
  runtime.on('output', (event) => outputs.push({
    runId: String(event.runId || ''),
    chunk: String(event.chunk || ''),
    type: String(event.type || ''),
  }))
  runtime.on('error', () => undefined)
  return { runtime, repository, outputs }
}

function createSummary(patch: Partial<ScopeRunSummary> = {}): ScopeRunSummary {
  return {
    scopeId: 'scope-finalizer',
    agent: 'butler',
    title: '测试会话',
    sourceKind: 'local',
    sourceId: 'app',
    channelKey: 'local:app',
    threadKey: 'scope-finalizer',
    phase: 'tool_running',
    taskTitle: '技能任务',
    taskSummary: '正在处理',
    taskType: 'short_task',
    interactionState: 'running',
    waitingFor: 'none',
    resumableActions: ['cancel'],
    recentArtifacts: [],
    taskId: 'task-finalizer',
    taskProjectionId: 'task-finalizer',
    updatedAt: '2026-06-10T10:00:00.000Z',
    ...patch,
  }
}

function createPayload(patch: Partial<ScopeRunEventPayload> = {}): ScopeRunEventPayload {
  return {
    type: 'updated',
    scopeId: 'scope-finalizer',
    agent: 'butler',
    runId: 'run-finalizer',
    taskId: 'task-finalizer',
    phase: 'tool_running',
    module: 'system',
    timestamp: '2026-06-10T10:00:00.000Z',
    ...patch,
  }
}

describe('run finalizer all paths', () => {
  test('done path records terminal run_meta through finalizer', async () => {
    const { runtime, repository } = createRuntime({
      runAgent: async ({ onTextDelta }) => {
        onTextDelta('完成')
        return { finalText: '完成' }
      },
    })
    runtime.newSession('butler::scope-done', 'system prompt')

    const result = await runtime.sendMessage('butler::scope-done', 'finish', 'run-done', {
      publicSessionId: 'scope-done',
      taskId: 'task-done',
    })

    const row = repository.get('run-done')
    assert.equal(result.success, true)
    assert.equal(row?.status, 'done')
    assert.equal(row?.terminalReason, 'done')
    assert.equal(row?.initiator, 'done')
  })

  test('error path records terminal run_meta through finalizer', async () => {
    const { runtime, repository } = createRuntime({
      runAgent: async () => {
        throw new Error('provider failed')
      },
    })
    runtime.newSession('butler::scope-error', 'system prompt')

    const result = await runtime.sendMessage('butler::scope-error', 'fail', 'run-error', {
      publicSessionId: 'scope-error',
      taskId: 'task-error',
    })

    const row = repository.get('run-error')
    assert.equal(result.success, false)
    assert.equal(row?.status, 'error')
    assert.equal(row?.initiator, 'error')
    assert.ok(row?.terminalReason)
  })

  test('user_stop path records terminal run_meta and closure capsule', async () => {
    let signalReadyResolve!: () => void
    const signalReady = new Promise<void>((resolve) => {
      signalReadyResolve = resolve
    })
    const { runtime, repository, outputs } = createRuntime({
      runAgent: ({ signal }) => {
        signalReadyResolve()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('cancelled_user')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      },
    })
    runtime.newSession('butler::scope-stop', 'system prompt')

    const pending = runtime.sendMessage('butler::scope-stop', 'stop later', 'run-stop', {
      publicSessionId: 'scope-stop',
      taskId: 'task-stop',
    })
    await signalReady
    runtime.stopGeneration('butler::scope-stop')
    const result = await pending

    const row = repository.get('run-stop')
    assert.equal(result.cancelled, true)
    assert.equal(result.terminalReason, 'cancelled_user')
    assert.equal(row?.status, 'cancelled')
    assert.equal(row?.terminalReason, 'cancelled_user')
    assert.equal(row?.initiator, 'user_stop')
    assert.ok(outputs.some((event) => event.chunk.includes('已手动停止')))
  })

  test('preempt path records terminal run_meta without same-user takeover capsule', async () => {
    let firstSignalReadyResolve!: () => void
    const firstSignalReady = new Promise<void>((resolve) => {
      firstSignalReadyResolve = resolve
    })
    const runAgentQueue: NonNullable<AgentSdkRuntimeDeps['runAgent']>[] = [
      ({ signal }) => {
        firstSignalReadyResolve()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('process_restarted')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      },
      async ({ onTextDelta }) => {
        onTextDelta('第二轮完成')
        return { finalText: '第二轮完成' }
      },
    ]
    const { runtime, repository, outputs } = createRuntime({
      runAgent: (params) => {
        const next = runAgentQueue.shift()
        assert.ok(next)
        return next(params)
      },
    })
    runtime.newSession('butler::scope-preempt', 'system prompt')

    const first = runtime.sendMessage('butler::scope-preempt', 'first', 'run-preempt-old', {
      publicSessionId: 'scope-preempt',
      taskId: 'task-preempt-old',
    })
    await firstSignalReady
    const second = await runtime.sendMessage('butler::scope-preempt', 'second', 'run-preempt-new', {
      publicSessionId: 'scope-preempt',
      taskId: 'task-preempt-new',
    })
    const firstResult = await first

    const oldRow = repository.get('run-preempt-old')
    assert.equal(firstResult.cancelled, true)
    assert.equal(firstResult.scopeRunAuthority?.reason, 'preempted_by_same_user')
    assert.equal(oldRow?.status, 'cancelled')
    assert.equal(oldRow?.initiator, 'preempted')
    assert.equal(second.success, true)
    assert.equal(outputs.some((event) => event.chunk.includes('已被新消息接管')), false)
  })

  test('sibling-kill path writes takeover capsule in projection patch', async () => {
    const records = new Map<string, TaskProjectionRecord>()
    const store: TaskProjectionStore = {
      create(record) {
        records.set(record.taskId, record)
      },
      update(taskId, patch) {
        records.set(taskId, {
          ...records.get(taskId)!,
          ...patch,
        })
      },
      get(taskId) {
        return records.get(taskId) || null
      },
      listByScope(scopeId) {
        return Array.from(records.values()).filter((record) => record.scopeId === scopeId)
      },
      listByParentTask(parentTaskId) {
        return Array.from(records.values()).filter((record) => record.parentTaskId === parentTaskId)
      },
      findByArtifactSiblings() {
        return Array.from(records.values())
      },
    }

    records.set('skill:legacy-old', {
      taskId: 'skill:legacy-old',
      scopeId: 'scope-finalizer',
      runId: 'run-old',
      taskType: 'short_task',
      module: 'system',
      taskTitle: '旧技能任务',
      taskSummary: '旧任务仍在运行',
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
      resumableActions: ['cancel'],
      continuationRef: null,
      progress: null,
      recentArtifacts: [],
      createdAt: '2026-06-10T09:59:00.000Z',
      updatedAt: '2026-06-10T09:59:00.000Z',
    })

    await syncTaskProjection(store, createSummary({
      taskId: 'task-new',
      taskProjectionId: 'task-new',
      updatedAt: '2026-06-10T10:01:00.000Z',
      taskContinuation: {
        skillId: 'skill-a',
        outputDir: '/tmp/shared-output',
        runStatePath: '/tmp/shared-output/run_state.json',
      },
    }), createPayload({
      taskId: 'task-new',
      runId: 'run-new',
      timestamp: '2026-06-10T10:01:00.000Z',
    }))

    const killed = records.get('skill:legacy-old')
    assert.equal(killed?.status, 'killed')
    assert.equal(killed?.taskSummary, '已被新消息接管')
    assert.equal(killed?.blockedReason, '已被新消息接管')
  })

  test('zero-tool non-conversation success does not write completed-task memory', async () => {
    const created: Array<Record<string, unknown>> = []
    const service = new ReflectionService({
      memoryRepository: {
        createMemory: async (entry: Record<string, unknown>) => {
          created.push(entry)
          return { id: `mem-${created.length}`, ...entry }
        },
        queryMemories: async () => [],
      } as never,
    })

    const result = await service.reflectOnConversation({
      scope: {
        id: 'scope-memory',
        agent: 'butler',
        userId: 'default-user',
        title: '新对话',
        sourceKind: 'local',
        sourceId: 'app',
        threadKey: 'thread-memory',
        meta: {},
        createdAt: '2026-06-10T10:00:00.000Z',
        updatedAt: '2026-06-10T10:00:00.000Z',
      },
      messages: [
        { role: 'user', content: '执行这个任务' },
        { role: 'assistant', content: '完成了' },
      ],
      usedTools: [],
      success: true,
    })

    assert.equal(result.sessionSummary, undefined)
    assert.equal(created.some((entry) => String(entry.summary || '').includes('Completed task')), false)
  })
})
