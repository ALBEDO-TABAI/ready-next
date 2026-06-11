/**
 * EP2-Q1 — migration 054 `task_projections` quality columns + check_in_pending
 * full-chain plumbing (fake-DB paradigm, mirrors migration-pending-confirmations:
 * host node cannot load the electron-ABI sqlite, so the migration runner and
 * repository run against typed fakes; the real-SQLite pass is covered by
 * `npm run verify:native`).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('migration-task-quality-columns declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'migration-task-quality-columns transitive sqlite load')
})

interface Statement {
  run(...params: unknown[]): unknown
  all<R = unknown>(...params: unknown[]): R[]
  get<R = unknown>(...params: unknown[]): R | undefined
}

class Migration054Db {
  readonly addedColumns: string[] = []
  readonly appliedMigrations: string[] = []

  constructor(readonly appliedNames: string[]) {}

  exec(sql: string): void {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (
      normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK'
      || normalized.startsWith('CREATE TABLE IF NOT EXISTS migrations')
    ) return

    const alter = normalized.match(/^ALTER TABLE task_projections ADD COLUMN ([a-z_]+) TEXT$/i)
    if (alter) {
      // Real SQLite throws on duplicate ADD COLUMN — mirror that so the
      // idempotence guarantee must come from the migrations ledger, not luck.
      if (this.addedColumns.includes(alter[1])) {
        throw new Error(`duplicate column: ${alter[1]}`)
      }
      this.addedColumns.push(alter[1])
      return
    }
    throw new Error(`unexpected migration SQL: ${normalized}`)
  }

  prepare(sql: string): Statement {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized === 'SELECT name FROM migrations') {
      return { all: <R>() => this.appliedNames.map((name) => ({ name })) as R[], run: () => undefined, get: () => undefined }
    }
    if (normalized.startsWith('INSERT INTO migrations')) {
      return {
        run: (name: unknown) => {
          this.appliedNames.push(String(name))
          this.appliedMigrations.push(String(name))
        },
        all: () => [],
        get: () => undefined,
      }
    }
    throw new Error(`unexpected migration statement: ${normalized}`)
  }
}

test('migration 054 adds the four quality columns idempotently (name-isolated)', async () => {
  const { __getMigrationNamesForTests, runMigrations } = await import('../main/modules/migrations')
  const names = __getMigrationNamesForTests()
  assert.ok(names.includes('054_task_projection_quality_columns'), 'migration 054 must be registered')

  const previous = names.filter((name) => name !== '054_task_projection_quality_columns')
  const db = new Migration054Db([...previous])
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])

  assert.deepEqual(
    [...db.addedColumns].sort(),
    ['checkins_json', 'criteria_json', 'learning_refs_json', 'proof_refs_json'],
    'exactly the four quality columns are added',
  )
  assert.deepEqual(db.appliedMigrations, ['054_task_projection_quality_columns'])

  // second run is a no-op (ledger-tracked) — the fake throws on duplicate ADD COLUMN
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  assert.equal(db.addedColumns.length, 4)
})

// ---------- repository roundtrip (SQL-matching fake raw DB) ----------

type Row = Record<string, unknown>

class FakeProjectionRawDb {
  readonly rows = new Map<string, Row>()

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    const rows = this.rows
    if (normalized.startsWith('INSERT INTO task_projections')) {
      const columns = normalized
        .slice(normalized.indexOf('(') + 1, normalized.indexOf(')'))
        .split(',')
        .map((column) => column.trim())
      return {
        run: (...params: unknown[]) => {
          assert.equal(params.length, columns.length, 'INSERT params must match column list')
          const row: Row = {}
          columns.forEach((column, index) => { row[column] = params[index] })
          rows.set(String(row.task_id), row)
        },
        all: () => [],
        get: () => undefined,
      }
    }
    if (normalized.startsWith('SELECT * FROM task_projections WHERE task_id = ?')) {
      return {
        run: () => undefined,
        all: () => [],
        get: <R>(taskId: unknown) => rows.get(String(taskId)) as R | undefined,
      }
    }
    if (normalized.startsWith('UPDATE task_projections SET')) {
      const setColumns = normalized
        .slice('UPDATE task_projections SET '.length, normalized.indexOf(' WHERE'))
        .split(',')
        .map((part) => part.trim().split(' ')[0])
      return {
        run: (...params: unknown[]) => {
          const taskId = String(params[params.length - 1])
          const row = rows.get(taskId)
          if (!row) return
          setColumns.forEach((column, index) => { row[column] = params[index] })
        },
        all: () => [],
        get: () => undefined,
      }
    }
    throw new Error(`unexpected repository SQL: ${normalized}`)
  }
}

async function createRepository() {
  const { TaskProjectionRepository } = await import('../main/modules/repositories/task-projection-repository')
  const raw = new FakeProjectionRawDb()
  const repository = new TaskProjectionRepository({ getRawDb: () => raw as never })
  return { repository, raw }
}

function baseRecord(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task-q1',
    scopeId: 'scope-1',
    runId: 'run-1',
    taskType: 'short_task',
    module: 'chat',
    status: 'running',
    interactionState: 'running',
    steps: [],
    createdAt: '2026-06-12T09:00:00.000Z',
    updatedAt: '2026-06-12T09:00:00.000Z',
    ...overrides,
  }
}

test('repository roundtrips the four quality fields through create -> get', async () => {
  const { repository } = await createRepository()
  repository.create(baseRecord({
    criteria: { template: 'short_task/chat', items: [{ id: 'c1', text: '回复用户' }] },
    checkins: [{ kind: 'shadow', verdict: 'accept' }],
    proofRefs: [{ kind: 'tool_result', ref: 'tool:1' }],
    learningRefs: [{ kind: 'memory_card', path: 'knowledge/a.md' }],
  }) as never, { silent: true })

  const record = repository.get('task-q1')
  assert.ok(record)
  assert.deepEqual(record!.criteria, { template: 'short_task/chat', items: [{ id: 'c1', text: '回复用户' }] })
  assert.deepEqual(record!.checkins, [{ kind: 'shadow', verdict: 'accept' }])
  assert.deepEqual(record!.proofRefs, [{ kind: 'tool_result', ref: 'tool:1' }])
  assert.deepEqual(record!.learningRefs, [{ kind: 'memory_card', path: 'knowledge/a.md' }])
})

test('repository update whitelist covers the four quality columns', async () => {
  const { repository } = await createRepository()
  repository.create(baseRecord() as never, { silent: true })
  repository.update('task-q1', {
    checkins: [{ kind: 'enforce', verdict: 'reject' }],
    proofRefs: [{ kind: 'artifact', ref: 'out/file.md' }],
  } as never, { silent: true })

  const record = repository.get('task-q1')
  assert.deepEqual(record!.checkins, [{ kind: 'enforce', verdict: 'reject' }])
  assert.deepEqual(record!.proofRefs, [{ kind: 'artifact', ref: 'out/file.md' }])
})

test('NULL and malformed quality cells read back as safe defaults (no throw)', async () => {
  const { repository, raw } = await createRepository()
  repository.create(baseRecord() as never, { silent: true })

  // legacy row: columns absent / NULL
  let record = repository.get('task-q1')
  assert.equal(record!.criteria, null)
  assert.deepEqual(record!.checkins, [])
  assert.deepEqual(record!.proofRefs, [])
  assert.deepEqual(record!.learningRefs, [])

  // malformed cells planted directly in storage
  const row = raw.rows.get('task-q1')!
  row.criteria_json = '{not json'
  row.checkins_json = '{"oops": true}'
  record = repository.get('task-q1')
  assert.equal(record!.criteria, null)
  assert.deepEqual(record!.checkins, [], 'non-array checkins cell falls back to empty array')
})

test('malformed quality field input is rejected loudly at write time', async () => {
  const { repository } = await createRepository()
  assert.throws(
    () => repository.create(baseRecord({ checkins: 'not-an-array' }) as never, { silent: true }),
    /checkins/,
  )
  repository.create(baseRecord() as never, { silent: true })
  assert.throws(
    () => repository.update('task-q1', { proofRefs: 42 } as never, { silent: true }),
    /proofRefs/,
  )
  assert.throws(
    () => repository.update('task-q1', { criteria: 'free text' } as never, { silent: true }),
    /criteria/,
  )
})

// ---------- check_in_pending full-chain plumbing ----------

test('check_in_pending survives the runtime summary path into the projection record', async () => {
  const { buildTaskProjectionRecord } = await import('../main/modules/agent-control/task-projection/task-projection-sync')
  const summary = {
    scopeId: 'scope-1',
    agent: 'butler',
    runId: 'run-1',
    taskId: 'task-1',
    phase: 'done',
    interactionState: 'check_in_pending',
    timestamp: '2026-06-12T09:01:00.000Z',
  }
  const payload = {
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    runId: 'run-1',
    taskId: 'task-1',
    phase: 'done',
    timestamp: '2026-06-12T09:01:00.000Z',
  }
  const record = buildTaskProjectionRecord(summary as never, payload as never, null, null)
  assert.ok(record)
  assert.equal(record!.interactionState, 'check_in_pending', 'summary path must not wash check_in_pending')
})

test('check_in_pending survives the truthPatch whitelist into the projection record', async () => {
  const { buildTaskProjectionRecord } = await import('../main/modules/agent-control/task-projection/task-projection-sync')
  const summary = {
    scopeId: 'scope-1',
    agent: 'butler',
    runId: 'run-1',
    taskId: 'task-1',
    phase: 'done',
    interactionState: 'running',
    timestamp: '2026-06-12T09:01:00.000Z',
  }
  const payload = {
    type: 'updated',
    scopeId: 'scope-1',
    agent: 'butler',
    runId: 'run-1',
    taskId: 'task-1',
    phase: 'done',
    timestamp: '2026-06-12T09:01:00.000Z',
  }
  const truth = { projectionPatch: { interactionState: 'check_in_pending' } }
  const record = buildTaskProjectionRecord(summary as never, payload as never, null, truth as never)
  assert.ok(record)
  assert.equal(record!.interactionState, 'check_in_pending', 'truthPatch whitelist must not wash check_in_pending')
})

test('both UI labels render check_in_pending as 待裁决, never the default running label', async () => {
  const { interactionStateToUserLabel, interactionStateToBadgeLabel } = await import('../renderer/modules/agent/task-status-vocabulary')
  assert.equal(interactionStateToUserLabel('check_in_pending' as never), '待裁决')
  assert.equal(interactionStateToBadgeLabel('check_in_pending' as never), '待裁决')
})

test('isAwaitingUserInteractionState treats check_in_pending as waiting on the user', async () => {
  const { isAwaitingUserInteractionState } = await import('../shared/task-interaction-state')
  assert.equal(isAwaitingUserInteractionState({ interactionState: 'check_in_pending' }), true)
})

test('buildContinuationStateFromProjection keeps check_in_pending (continuation whitelist)', async () => {
  const { buildContinuationStateFromProjection } = await import('../main/modules/agent-control/contracts/continuation-state')
  const projection = baseRecord({ interactionState: 'check_in_pending' })
  const continuation = buildContinuationStateFromProjection(projection as never)
  assert.equal(continuation.interactionState, 'check_in_pending', 'continuation normalization must not wash check_in_pending to running')
})
