import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  finalizeRunOutcome,
  type RunCloseMetric,
  type RunFinalizerDeps,
} from '../main/modules/agent-control/runtime-core/run-finalizer'
import { AgentSdkRuntime, type AgentSdkRuntimeDeps } from '../main/modules/agent-control/runtime-core/agent-sdk-runtime'
import { RunMetaRepository } from '../main/modules/agent-control/task-projection/run-meta-repository'
import { __setMetricSinkForTests } from '../main/modules/agent-control/metrics'
import { ScriptedAgentRunner } from './helpers/scripted-agent-runner'

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

function createRuntime(deps: Partial<AgentSdkRuntimeDeps>): AgentSdkRuntime {
  return new AgentSdkRuntime({
    loadAIConfig: () => ({ ok: true, config: fakeConfig, reason: 'present' }),
    domainAdapters: [],
    listToolDefinitions: () => [],
    ...deps,
  })
}

function createMetricSpy(): {
  metrics: RunCloseMetric[]
  deps: RunFinalizerDeps
} {
  const metrics: RunCloseMetric[] = []
  return {
    metrics,
    deps: {
      writeRunCloseMetric(metric) {
        metrics.push(metric)
      },
    },
  }
}

describe('finalizeRunOutcome', () => {
  test('done path writes the correct close metric', async () => {
    const { metrics, deps } = createMetricSpy()

    await finalizeRunOutcome({
      kind: 'done',
      runId: 'run-done',
      durationMs: 1_250,
      toolCallsUsed: 3,
      initiator: 'user_stop',
    }, deps)

    assert.deepEqual(metrics, [{
      runId: 'run-done',
      terminalReason: 'done',
      initiator: 'user_stop',
      toolCallsUsed: 3,
      durationMs: 1_250,
    }])
  })

  test('checkpoint path with a valid handle writes checkpoint close metric', async () => {
    const { metrics, deps } = createMetricSpy()

    await finalizeRunOutcome({
      kind: 'checkpoint',
      runId: 'run-checkpoint',
      continuationHandle: 'state/run-checkpoint.json',
      durationMs: 2_500,
      toolCallsUsed: 7,
      initiator: 'budget',
    }, deps)

    assert.deepEqual(metrics, [{
      runId: 'run-checkpoint',
      terminalReason: 'checkpoint',
      initiator: 'budget',
      toolCallsUsed: 7,
      durationMs: 2_500,
    }])
  })

  test('checkpoint path with a null or empty handle rejects and writes degraded metric', async () => {
    for (const continuationHandle of [null, '']) {
      const { metrics, deps } = createMetricSpy()

      await assert.rejects(
        finalizeRunOutcome({
          kind: 'checkpoint',
          runId: 'run-degraded',
          continuationHandle: continuationHandle as string,
          durationMs: 300,
          toolCallsUsed: 1,
          initiator: 'budget',
        }, deps),
        new Error('checkpoint outcome requires a valid continuation handle'),
      )

      assert.deepEqual(metrics, [{
        runId: 'run-degraded',
        terminalReason: 'checkpoint_degraded_error',
        initiator: 'budget',
        toolCallsUsed: 1,
        durationMs: 300,
      }])
    }
  })

  test('initiator is forwarded from outcome to metric', async () => {
    const { metrics, deps } = createMetricSpy()

    await finalizeRunOutcome({
      kind: 'done',
      runId: 'run-initiator',
      durationMs: 50,
      toolCallsUsed: 0,
      initiator: 'preempted',
    }, deps)

    assert.equal(metrics[0]?.initiator, 'preempted')
  })

  test('normal AgentSdkRuntime run finalizes run_meta and emits run-close metric through finalizer', async () => {
    const db = new RunMetaDb()
    const repository = new RunMetaRepository(db as unknown as ConstructorParameters<typeof RunMetaRepository>[0])
    const metricEvents: Array<{ metric: string; [key: string]: unknown }> = []
    __setMetricSinkForTests((event) => metricEvents.push(event))

    try {
      const scripted = new ScriptedAgentRunner({}, [{
        turnIndex: 0,
        response: 'scripted run complete',
      }])
      const runtime = createRuntime(scripted.deps)
      runtime.setRuntime({
        getRunMetaRepository: () => repository,
      } as never)
      runtime.newSession('butler::scope-run-finalizer', 'system prompt')

      const result = await runtime.sendMessage(
        'butler::scope-run-finalizer',
        'finish normally',
        'run-finalizer-scripted',
        {
          publicSessionId: 'scope-run-finalizer',
          taskId: 'task-run-finalizer-scripted',
        },
      )

      assert.equal(result.success, true)
      const row = repository.get('run-finalizer-scripted')
      assert.ok(row, 'run_meta row must be written')
      assert.notEqual(row.status, 'working')
      assert.equal(row.status, 'done')
      assert.notEqual(row.initiator, null)
      assert.notEqual(row.initiator, undefined)
      assert.ok((row.durationMs ?? 0) > 0)
      assert.ok(metricEvents.some((event) => event.metric === 'run_close'))
    } finally {
      __setMetricSinkForTests(null)
    }
  })
})
