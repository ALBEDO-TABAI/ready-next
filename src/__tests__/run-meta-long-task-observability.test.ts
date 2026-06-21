import assert from 'node:assert/strict'
import test from 'node:test'

import { AgentSdkRuntime, type AgentSdkRuntimeDeps } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { createTaskBudgetRuntime } from '../main/modules/agent-control/task-projection/run-budget-policy'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('run-meta-long-task-observability declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'run-meta-long-task-observability transitive sqlite load')
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
  provider: 'openai-compatible',
  baseUrl: 'https://example.com/v1/messages',
  apiKey: 'test-key',
  model: 'custom-model',
  contextWindowOverride: 96_000,
} as const

function createRuntime(deps: Partial<AgentSdkRuntimeDeps>): AgentSdkRuntime {
  return new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    ...deps,
  })
}

async function runLongTaskWithRepository(
  runId: string,
  runAgent: NonNullable<AgentSdkRuntimeDeps['runAgent']>,
) {
  const repo = new RunMetaRepository(new RunMetaDb() as unknown as ConstructorParameters<typeof RunMetaRepository>[0])
  const runtime = createRuntime({ runAgent })
  runtime.on('error', () => undefined)
  runtime.setRuntime({
    getRunMetaRepository: () => repo,
  } as never)
  runtime.newSession('butler::scope-run-meta', 'system prompt')

  const result = await runtime.sendMessage(
    'butler::scope-run-meta',
    'run meta proof',
    runId,
    {
      publicSessionId: 'scope-run-meta',
      taskId: 'task-run-meta',
      taskBudgetRuntime: createTaskBudgetRuntime('research'),
    },
  )
  return { repo, result, row: repo.get(runId) }
}

test('Agent SDK scoped run writes long-task run_meta fields on close', async () => {
  const { result, row } = await runLongTaskWithRepository('run-meta-proof', async () => ({
    finalText: 'done',
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
  }))

  assert.equal(result.success, true)
  assert.ok(row)
  assert.equal(row.taskId, 'task-run-meta')
  assert.equal(row.scopeId, 'scope-run-meta')
  assert.equal(row.status, 'done')
  assert.equal(row.taskType, 'research')
  assert.equal(row.terminalReason, 'done')
  assert.equal(row.providerProtocol, 'anthropic')
  assert.equal(row.contextWindow, 96_000)
  assert.deepEqual(row.budget, {
    maxIterations: 60,
    maxToolCalls: 60,
    maxParallelToolGroups: 5,
    reservedToolCalls: 0,
    iterationsUsed: 0,
    toolCallsUsed: 0,
    parallelToolGroupsUsed: 0,
  })
  assert.equal(row.totalTokens, 18)
})

test('Agent SDK abort path preserves long-task run_meta task facts', async () => {
  const abortError = new Error('aborted by test')
  abortError.name = 'AbortError'
  const { result, row } = await runLongTaskWithRepository('run-meta-abort-proof', async () => {
    throw abortError
  })

  assert.equal(result.cancelled, true)
  assert.ok(row)
  assert.equal(row.status, 'cancelled')
  assert.equal(row.taskType, 'research')
  assert.equal(row.terminalReason, 'cancelled_user')
  assert.ok(row.budget)
})

test('Agent SDK error path preserves long-task run_meta task facts', async () => {
  const { result, row } = await runLongTaskWithRepository('run-meta-error-proof', async () => {
    throw new Error('boom')
  })

  assert.equal(result.success, false)
  assert.ok(row)
  assert.equal(row.status, 'error')
  assert.equal(row.taskType, 'research')
  assert.ok(row.terminalReason)
  assert.ok(row.budget)
})
