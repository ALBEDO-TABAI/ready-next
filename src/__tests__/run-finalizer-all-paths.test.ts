import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps,
} from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import {
  finalizeRunOutcome,
  type RunCloseMetric,
} from '../main/modules/agent-control/runtime-core/run-finalizer'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { syncTaskProjection } from '../main/modules/agent-control/task-projection/task-projection-sync'
import type { ScopeRunEventPayload, ScopeRunSummary } from '../main/modules/agent-control/contracts/types'
import type { TaskProjectionRecord, TaskProjectionStore } from '../main/modules/agent-control/contracts/run-contracts'
import { createTaskBudgetRuntime } from '../main/modules/agent-control/task-projection/run-budget-policy'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import type { ToolDefinition } from '../main/modules/agent-control/tools-runtime/tool-definition'
import { __setScopeContextEpochDatabaseForTests } from '../main/modules/agent-control/session/scope-context-epoch'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { canonicalCoreCloseoutTestPort } from './helpers/canonical-core-closeout-test-port'

__setScopeContextEpochDatabaseForTests({
  getRawDb: () => ({ prepare: () => ({ get: () => undefined }) }) as never,
})

test('run-finalizer-all-paths declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'run-finalizer-all-paths transitive sqlite load')
})

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

function canonicalCloseoutPort(repository: RunMetaRepository, store?: TaskProjectionStore) {
  return canonicalCoreCloseoutTestPort((input) => {
    const patch = {
      status: input.status,
      terminalReason: input.terminalReason,
      initiator: input.initiator,
      durationMs: input.durationMs,
    }
    if (repository.get(input.ownerRunId)) {
      repository.update(input.ownerRunId, patch as never)
    } else {
      repository.create({
        runId: input.ownerRunId,
        taskId: input.parentTaskId,
        scopeId: input.conversationId,
        ...patch,
      } as never)
    }
    if (store && input.terminalQualityPatch) {
      store.update(input.parentTaskId, {
        proofRefs: input.terminalQualityPatch.proofRefs,
        checkins: input.terminalQualityPatch.checkins,
        criteria: input.terminalQualityPatch.criteria,
        ...(input.terminalQualityPatch.learningRefs
          ? { learningRefs: input.terminalQualityPatch.learningRefs }
          : {}),
      } as never)
    }
  })
}

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
    ...canonicalCloseoutPort(repository),
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

function attachFinalizeStore(
  runtime: AgentSdkRuntime,
  repository: RunMetaRepository,
  store: TaskProjectionStore,
): void {
  runtime.setRuntime({
    ...canonicalCloseoutPort(repository, store),
    getRunMetaRepository: () => repository,
    getTaskProjectionStore: () => store,
    getTaskProjectionStoreForFinalize: () => store,
    getTaskProjection: (taskId: string) => store.get(taskId),
  } as never)
}

function createProjectionStore(records: Map<string, TaskProjectionRecord>): TaskProjectionStore {
  return {
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
}

function createProjectionRecord(patch: Partial<TaskProjectionRecord> = {}): TaskProjectionRecord {
  return {
    taskId: 'task-finalizer',
    taskOrigin: 'user_root',
    ownerAgentId: 'butler',
    scopeId: 'scope-finalizer',
    runId: 'run-finalizer',
    taskType: 'short_task',
    module: 'system',
    taskTitle: '测试任务',
    taskSummary: '正在处理',
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
    ...patch,
  }
}

function createResearchTool(): ToolDefinition {
  return {
    name: 'web_search',
    groupId: 'general_research',
    domain: 'general_research',
    kind: 'read',
    concurrency: 'parallel_read_safe',
    interruptBehavior: 'abort_signal',
    timeoutProfile: 'default',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: true },
    description: 'Search test source',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    executionVisibility: 'model',
    resultShape: 'json',
  }
}

function createDocumentTool(name: string, kind: ToolDefinition['kind']): ToolDefinition {
  return {
    name,
    groupId: 'document',
    domain: 'document',
    kind,
    concurrency: kind === 'read' ? 'parallel_read_safe' : 'serialized',
    timeoutProfile: 'document_write',
    description: name,
    schema: {
      type: 'object',
      properties: name === 'document_set_content'
        ? { content: { type: 'string' } }
        : { path: { type: 'string' } },
      required: name === 'document_set_content'
        ? ['content']
        : name === 'document_save_tab'
          ? []
          : ['path'],
      additionalProperties: false,
    },
    executionVisibility: 'model',
    resultShape: 'json',
  }
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
    taskOrigin: 'user_root',
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
    taskOrigin: 'user_root',
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
      messageVisibilityEpoch: 0,
      taskId: 'task-done',
    })

    const row = repository.get('run-done')
    assert.equal(result.success, true, JSON.stringify(result))
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
      messageVisibilityEpoch: 0,
      taskId: 'task-error',
    })

    const row = repository.get('run-error')
    assert.equal(result.success, false)
    assert.equal(row?.status, 'error')
    assert.equal(row?.initiator, 'error')
    assert.ok(row?.terminalReason)
  })

  test('pre-model config failure records adjudication through finalizer', async () => {
    const { runtime, repository } = createRuntime({
      loadAIConfig: () => ({ ok: false, reason: 'json_corrupt', message: 'bad json' }),
    })
    const records = new Map<string, TaskProjectionRecord>()
    const store = createProjectionStore(records)
    records.set('task-config-finalizer', createProjectionRecord({
      taskId: 'task-config-finalizer',
      scopeId: 'scope-config-finalizer',
      runId: 'run-config-finalizer',
    }))
    attachFinalizeStore(runtime, repository, store)
    runtime.newSession('butler::scope-config-finalizer', 'system prompt')

    const result = await runtime.sendMessage('butler::scope-config-finalizer', 'hello', 'run-config-finalizer', {
      publicSessionId: 'scope-config-finalizer',
      messageVisibilityEpoch: 0,
      taskId: 'task-config-finalizer',
    })

    const row = repository.get('run-config-finalizer')
    const projection = records.get('task-config-finalizer')
    assert.equal(result.success, false)
    assert.equal(result.terminalReason, 'blocked_config')
    assert.equal(row?.status, 'error')
    assert.equal(row?.terminalReason, 'blocked_config')
    assert.equal(row?.initiator, 'error')
    assert.ok((projection?.checkins?.length || 0) > 0)
  })

  test('budget checkpoint records a resumable terminal state without final adjudication', async () => {
    const { runtime, repository } = createRuntime({
      listToolDefinitions: () => [createResearchTool()],
      executeToolCall: async () => createToolExecutionOutput('search result', {
        shape: 'json',
        data: { ok: true },
      }),
      runAgent: async ({ tools }) => {
        const sdkTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
        await sdkTool.invoke({}, JSON.stringify({ query: 'budget proof' }))
        return { finalText: 'done' }
      },
    })
    const records = new Map<string, TaskProjectionRecord>()
    const store = createProjectionStore(records)
    records.set('task-budget-finalizer', createProjectionRecord({
      taskId: 'task-budget-finalizer',
      scopeId: 'scope-budget-finalizer',
      runId: 'run-budget-finalizer',
      taskType: 'research',
    }))
    attachFinalizeStore(runtime, repository, store)
    runtime.newSession('butler::scope-budget-finalizer', 'system prompt')

    const result = await runtime.sendMessage(
      'butler::scope-budget-finalizer',
      'research budget proof',
      'run-budget-finalizer',
      {
        publicSessionId: 'scope-budget-finalizer',
        messageVisibilityEpoch: 0,
        taskId: 'task-budget-finalizer',
        taskBudgetRuntime: createTaskBudgetRuntime('research', {
          budget: {
            maxIterations: 2,
            maxToolCalls: 1,
            maxParallelToolGroups: 5,
            reservedToolCalls: 0,
          },
        }),
      },
    )

    const row = repository.get('run-budget-finalizer')
    const projection = records.get('task-budget-finalizer')
    assert.equal(result.success, true, JSON.stringify(result))
    assert.equal(result.terminalReason, 'checkpoint_budget')
    assert.equal(row?.status, 'checkpoint')
    assert.equal(row?.terminalReason, 'checkpoint_budget')
    assert.equal(row?.initiator, 'checkpoint')
    assert.equal(projection?.checkins?.length || 0, 0)
  })

  test('max-turn saved document done branch records adjudication through finalizer', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'ready-finalizer-max-turn-done-'))
    const targetPath = join(tmpRoot, 'report.md')
    await writeFile(targetPath, '# Report\n\n', 'utf-8')
    try {
      const { runtime, repository } = createRuntime({
        listToolDefinitions: () => [
          createDocumentTool('document_set_content', 'write'),
          createDocumentTool('document_open_tab', 'read'),
          createDocumentTool('document_save_tab', 'write'),
        ],
        executeToolCall: async (name, args) => {
          if (name === 'document_set_content') {
            await writeFile(targetPath, String(args.content || ''), 'utf-8')
          }
          return createToolExecutionOutput(`${name} ok`, {
            shape: 'json',
            data: { ok: true },
          })
        },
        runAgent: async ({ tools }) => {
          const setContentTool = tools[0] as { invoke: (context: unknown, input: string) => Promise<string> }
          await setContentTool.invoke({}, JSON.stringify({
            content: '# Report\n\n已写入并保存。',
          }))
          throw new Error('Max turns (16) exceeded')
        },
      })
      const records = new Map<string, TaskProjectionRecord>()
      const store = createProjectionStore(records)
      records.set('task-max-turn-done-finalizer', createProjectionRecord({
        taskId: 'task-max-turn-done-finalizer',
        scopeId: 'scope-max-turn-done-finalizer',
        runId: 'run-max-turn-done-finalizer',
        proofRefs: [{
          kind: 'tool_result',
          ref: 'document_set_content',
          ts: '2026-06-10T10:00:00.000Z',
          digest: 'b'.repeat(64),
        }],
      }))
      attachFinalizeStore(runtime, repository, store)
      runtime.newSession('butler::scope-max-turn-done-finalizer', 'system prompt')

      const result = await runtime.sendMessage(
        'butler::scope-max-turn-done-finalizer',
        [
          '把内容写入@[report.md]里。',
          '',
          '--- 附件: report.md ---',
          `- 路径: ${targetPath}`,
        ].join('\n'),
        'run-max-turn-done-finalizer',
        {
          publicSessionId: 'scope-max-turn-done-finalizer',
          messageVisibilityEpoch: 0,
          taskId: 'task-max-turn-done-finalizer',
          requestEnvelope: {
            primaryInstruction: '把内容写入@[report.md]里。',
            resources: [
              { name: 'report.md', path: targetPath },
            ],
          },
        },
      )

      const row = repository.get('run-max-turn-done-finalizer')
      const projection = records.get('task-max-turn-done-finalizer')
      assert.equal(result.success, true, JSON.stringify(result))
      assert.equal(result.terminalReason, 'done')
      assert.equal(row?.status, 'done')
      assert.equal(row?.terminalReason, 'done')
      assert.ok((projection?.checkins?.length || 0) > 0)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  test('child resume parent close records adjudication through finalizer', async () => {
    const cases = [
      {
        label: 'done',
        close: {
          status: 'completed',
          terminalReason: 'completed',
          projectionPatch: { taskContinuation: { childRunId: 'child-done' } },
        },
        expectedStatus: 'done',
        expectedReason: 'done',
        expectedSuccess: true,
      },
      {
        label: 'checkpoint',
        close: {
          status: 'budget_paused',
          terminalReason: 'checkpoint_budget',
          projectionPatch: { taskContinuation: { childRunId: 'child-checkpoint' } },
        },
        expectedStatus: 'checkpoint',
        expectedReason: 'checkpoint_budget',
        expectedSuccess: true,
      },
      {
        label: 'error',
        close: {
          status: 'failed',
          terminalReason: 'failed_skill',
          error: { kind: 'failed_skill', message: 'driver failed' },
          projectionPatch: { taskContinuation: { childRunId: 'child-error' } },
        },
        expectedStatus: 'error',
        expectedReason: 'failed_skill',
        expectedSuccess: false,
      },
    ] as const

    for (const item of cases) {
      const { runtime, repository } = createRuntime({
        resumeSkillChildRun: async (childRunId: string) => ({
          childRunId,
          closeEvent: item.close,
        }) as never,
        waitForSkillChildRunClose: async () => {
          throw new Error('close event is returned inline')
        },
        runAgent: async () => {
          throw new Error('child resume path must return before model run')
        },
      })
      const records = new Map<string, TaskProjectionRecord>()
      const store = createProjectionStore(records)
      records.set(`task-child-${item.label}`, createProjectionRecord({
        taskId: `task-child-${item.label}`,
        scopeId: `scope-child-${item.label}`,
        runId: `run-child-${item.label}`,
        proofRefs: [{
          kind: 'tool_result',
          ref: `child-${item.label}`,
          ts: '2026-06-10T10:00:00.000Z',
          digest: 'a'.repeat(64),
        }],
      }))
      attachFinalizeStore(runtime, repository, store)
      runtime.newSession(`butler::scope-child-${item.label}`, 'system prompt')

      const result = await runtime.sendMessage(
        `butler::scope-child-${item.label}`,
        '继续',
        `run-child-${item.label}`,
        {
          publicSessionId: `scope-child-${item.label}`,
          messageVisibilityEpoch: 0,
          taskId: `task-child-${item.label}`,
          continuationIntent: { childRunId: `child-${item.label}` },
        },
      )

      const row = repository.get(`run-child-${item.label}`)
      const projection = records.get(`task-child-${item.label}`)
      assert.equal(result.success, item.expectedSuccess)
      assert.equal(result.terminalReason, item.expectedReason)
      assert.equal(row?.status, item.expectedStatus)
      assert.equal(row?.terminalReason, item.expectedReason)
      if (item.expectedStatus === 'checkpoint') {
        assert.equal(projection?.checkins?.length || 0, 0)
      } else {
        assert.ok((projection?.checkins?.length || 0) > 0)
      }
    }
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
      messageVisibilityEpoch: 0,
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
    assert.match(result.finalText, /已手动停止/)
    assert.ok(outputs.some((event) => event.type === 'done'))
  })

  test('active owner rejects a second direct ingress without cancelling the running turn', async () => {
    let firstSignalReadyResolve!: () => void
    const firstSignalReady = new Promise<void>((resolve) => {
      firstSignalReadyResolve = resolve
    })
    const { runtime, repository, outputs } = createRuntime({
      runAgent: ({ signal }) => {
        firstSignalReadyResolve()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('cancelled_user')
            error.name = 'AbortError'
            reject(error)
          }, { once: true })
        })
      },
    })
    runtime.newSession('butler::scope-preempt', 'system prompt')

    const first = runtime.sendMessage('butler::scope-preempt', 'first', 'run-preempt-old', {
      publicSessionId: 'scope-preempt',
      messageVisibilityEpoch: 0,
      taskId: 'task-preempt-old',
    })
    await firstSignalReady
    const second = await runtime.sendMessage('butler::scope-preempt', 'second', 'run-preempt-new', {
      publicSessionId: 'scope-preempt',
      messageVisibilityEpoch: 0,
      taskId: 'task-preempt-new',
    })
    assert.equal(second.success, false)
    assert.equal(second.terminalReason, 'blocked_external')
    assert.equal(repository.get('run-preempt-old')?.status, 'running')
    assert.equal(repository.get('run-preempt-new'), null)

    runtime.stopGeneration('butler::scope-preempt')
    const firstResult = await first

    const oldRow = repository.get('run-preempt-old')
    assert.equal(firstResult.cancelled, true)
    assert.equal(firstResult.scopeRunAuthority, undefined)
    assert.equal(oldRow?.status, 'cancelled')
    assert.equal(oldRow?.initiator, 'user_stop')
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
    assert.equal(killed?.blockedReason, null)
  })

  test('checkpoint_steered path records checkpoint terminal state with durable handle', async () => {
    const repository = new RunMetaRepository(new RunMetaDb() as unknown as ConstructorParameters<typeof RunMetaRepository>[0])
    const metrics: RunCloseMetric[] = []
    const patches: Array<{ patch: Record<string, unknown> | null; reason: string }> = []

    await finalizeRunOutcome({
      kind: 'checkpoint',
      runId: 'run-steered',
      taskId: 'task-steered',
      scopeId: 'scope-steered',
      messageVisibilityEpoch: 0,
      continuationHandle: '/tmp/ready-action-steered/run_state.json',
      durationMs: 100,
      toolCallsUsed: 0,
      initiator: 'done',
      terminalReason: 'checkpoint_steered',
      projectionPatch: {
        taskContinuation: {
          taskId: 'task-steered',
          outputDir: '/tmp/ready-action-steered',
          runStatePath: '/tmp/ready-action-steered/run_state.json',
        },
      },
    }, {
      runMetaRepository: repository,
      writeProjectionTerminalPatch: (patch, reason) => {
        patches.push({ patch, reason })
      },
      writeRunCloseMetric(metric) {
        metrics.push(metric)
      },
    })

    const row = repository.get('run-steered')
    assert.equal(row?.status, 'checkpoint')
    assert.equal(row?.terminalReason, 'checkpoint_steered')
    assert.equal(metrics[0]?.terminalReason, 'checkpoint_steered')
    assert.equal(patches[0]?.reason, 'checkpoint_steered')
    assert.deepEqual(
      (patches[0]?.patch?.taskContinuation as Record<string, unknown> | undefined)?.runStatePath,
      '/tmp/ready-action-steered/run_state.json',
    )
  })

})
