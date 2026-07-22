import assert from 'node:assert/strict'
import test from 'node:test'

import { executeDeclareCompletionCriteria } from '../main/modules/tools/builtins/declare-completion-criteria'
import { TaskProjectionRepository } from '../main/modules/repositories/task-projection-repository'
import { collectArtifactProof } from '../main/modules/agent-control/quality/proof-collector'
import { finalizeRunOutcome, type RunOutcome } from '../main/modules/agent-control/runtime-core/run-finalizer'
import { __getMigrationNamesForTests, __runMigrationForTests } from '../main/modules/migrations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('completion-declaration-persistence declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'completion-declaration-persistence transitive sqlite guard')
})

type Row = Record<string, unknown>

class ProjectionDb {
  readonly rows = new Map<string, Row>()

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized.startsWith('INSERT INTO task_projections')) {
      const columns = normalized.slice(normalized.indexOf('(') + 1, normalized.indexOf(')'))
        .split(',').map((column) => column.trim())
      return {
        run: (...params: unknown[]) => {
          assert.equal(params.length, columns.length)
          const row: Row = {}
          columns.forEach((column, index) => { row[column] = params[index] })
          this.rows.set(String(row.task_id), row)
        },
        get: () => undefined,
        all: () => [],
      }
    }
    if (normalized.startsWith('SELECT * FROM task_projections WHERE task_id = ?')) {
      return {
        run: () => undefined,
        get: <T>(taskId: unknown) => this.rows.get(String(taskId)) as T | undefined,
        all: () => [],
      }
    }
    if (normalized.startsWith('UPDATE task_projections SET')) {
      const columns = normalized.slice('UPDATE task_projections SET '.length, normalized.indexOf(' WHERE'))
        .split(',').map((part) => part.trim().split(' ')[0])
      return {
        run: (...params: unknown[]) => {
          const row = this.rows.get(String(params.at(-1)))
          assert.ok(row)
          columns.forEach((column, index) => { row[column] = params[index] })
          return { changes: 1 }
        },
        get: () => undefined,
        all: () => [],
      }
    }
    throw new Error(`unexpected SQL: ${normalized}`)
  }
}

function makeRepository(db: ProjectionDb): TaskProjectionRepository {
  return new TaskProjectionRepository({ getRawDb: () => db as never })
}

test('migration 065 owns both persistent completion-declaration columns', () => {
  assert.ok(__getMigrationNamesForTests().includes('065_task_projection_completion_declarations'))
  const statements: string[] = []
  __runMigrationForTests('065_task_projection_completion_declarations', {
    exec: (sql: string) => { statements.push(sql) },
    prepare: () => { throw new Error('not used') },
  } as never)
  assert.deepEqual(statements, [
    'ALTER TABLE task_projections ADD COLUMN model_criteria_json TEXT',
    'ALTER TABLE task_projections ADD COLUMN expected_outputs_json TEXT',
  ])
})

test('declaration persists across repository restart and drives terminal delivery coverage', async () => {
  const db = new ProjectionDb()
  const first = makeRepository(db)
  first.create({
    taskId: 'task-crit-p',
    taskOrigin: 'user_root',
    ownerAgentId: 'butler',
    scopeId: 'scope-crit-p',
    runId: 'run-crit-p',
    taskType: 'multi_step_task',
    module: 'skill',
    status: 'running',
    interactionState: 'running',
    steps: [],
    proofRefs: [collectArtifactProof('/Users/user/V/描述.md', new Date('2026-07-10T00:00:00.000Z'))],
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  } as never, { silent: true })

  const output = await executeDeclareCompletionCriteria({
    criteria: ['两份承诺文件均已落盘'],
    expected_outputs: ['/Users/user/V/描述.md', '/Users/user/V/深读.md'],
  }, {
    taskId: 'task-crit-p',
    sessionId: 'scope-crit-p',
    updateTaskCompletionDeclaration: (taskId, patch) => first.update(taskId, patch, { silent: true }),
  })
  assert.equal(output.data?.ok, true)

  const restarted = makeRepository(db)
  const restored = restarted.get('task-crit-p')
  assert.deepEqual(restored?.modelCriteria, ['两份承诺文件均已落盘'])
  assert.deepEqual(restored?.expectedOutputs, ['/Users/user/V/描述.md', '/Users/user/V/深读.md'])

  await finalizeRunOutcome({
    kind: 'done',
    runId: 'run-crit-p',
    taskId: 'task-crit-p',
    scopeId: 'scope-crit-p',
    durationMs: 1,
    toolCallsUsed: 1,
    initiator: 'done',
    finalText: '完成',
  } as RunOutcome, {
    taskProjectionStore: restarted,
    writeRunCloseMetric: () => {},
    now: () => new Date('2026-07-10T00:00:01.000Z'),
  })

  const finalized = restarted.get('task-crit-p')
  const lastCheckin = (finalized?.checkins as Array<{ verdict?: string; blockers?: string[] }>).at(-1)
  assert.notEqual(lastCheckin?.verdict, 'accept')
  assert.ok(
    lastCheckin?.blockers?.includes('criteria_unsatisfied:c1'),
    JSON.stringify({ lastCheckin, finalized }),
  )
})
