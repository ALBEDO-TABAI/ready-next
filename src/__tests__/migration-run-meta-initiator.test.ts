import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('migration-run-meta-initiator declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'migration-run-meta-initiator transitive sqlite load')
})

interface Statement {
  run(...params: unknown[]): unknown
  all<R = unknown>(...params: unknown[]): R[]
  get<R = unknown>(...params: unknown[]): R | undefined
}

interface TestDb {
  exec(sql: string): void
  prepare(sql: string): Statement
}

class Migration050Db implements TestDb {
  readonly runMetaColumns = new Set<string>([
    'run_id',
    'task_id',
    'scope_id',
    'agent_id',
    'status',
    'created_at',
    'updated_at',
  ])

  constructor(readonly appliedNames: string[], existingColumns: string[] = []) {
    for (const column of existingColumns) this.runMetaColumns.add(column)
  }

  exec(sql: string): void {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (
      normalized === 'BEGIN'
      || normalized === 'COMMIT'
      || normalized === 'ROLLBACK'
      || normalized.startsWith('CREATE TABLE IF NOT EXISTS migrations')
    ) {
      return
    }

    const addColumn = normalized.match(/^ALTER TABLE run_meta ADD COLUMN ([a-z_]+) /i)
    if (addColumn) {
      const column = addColumn[1]
      if (this.runMetaColumns.has(column)) {
        throw new Error(`duplicate column name: ${column}`)
      }
      this.runMetaColumns.add(column)
      return
    }

    throw new Error(`unexpected migration SQL: ${normalized}`)
  }

  prepare(sql: string): Statement {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized === 'SELECT name FROM migrations') {
      return {
        all: <R>() => this.appliedNames.map((name) => ({ name })) as R[],
        run: () => undefined,
        get: () => undefined,
      }
    }

    if (normalized.startsWith('INSERT INTO migrations')) {
      return {
        run: (name: unknown) => {
          this.appliedNames.push(String(name))
        },
        all: () => [],
        get: () => undefined,
      }
    }

    throw new Error(`unexpected migration statement: ${normalized}`)
  }
}

class RunMetaDb implements TestDb {
  private readonly rows = new Map<string, Record<string, unknown>>()

  exec(_sql: string): void {}

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

    if (normalized === 'SELECT initiator, duration_ms FROM run_meta WHERE run_id = ?') {
      return {
        get: <R>(runId: unknown) => {
          const row = this.rows.get(String(runId))
          if (!row) return undefined
          return { initiator: row.initiator, duration_ms: row.duration_ms } as R
        },
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

test('migration 050 adds run_meta initiator and duration columns idempotently', async () => {
  const { __getMigrationNamesForTests, runMigrations } = await import('../main/modules/migrations')
  const migrationNames = __getMigrationNamesForTests()
  const migrationIndex = migrationNames.indexOf('050_add_run_meta_initiator_duration')
  assert.ok(migrationIndex > 0, 'migration 050 must be registered after existing migrations')
  const previousNames = migrationNames.slice(0, migrationIndex)

  const db = new Migration050Db([...previousNames])
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  assert.ok(db.runMetaColumns.has('initiator'))
  assert.ok(db.runMetaColumns.has('duration_ms'))
  assert.equal(db.appliedNames.filter((name) => name === '050_add_run_meta_initiator_duration').length, 1)

  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  assert.equal(db.appliedNames.filter((name) => name === '050_add_run_meta_initiator_duration').length, 1)

  const preexisting = new Migration050Db([...previousNames], ['initiator', 'duration_ms'])
  runMigrations(preexisting as unknown as Parameters<typeof runMigrations>[0])
  assert.equal(preexisting.appliedNames.filter((name) => name === '050_add_run_meta_initiator_duration').length, 1)
})

test('RunMetaRepository writes and reads initiator and duration', async () => {
  const db = new RunMetaDb()
  const { RunMetaRepository } = await import(
    '../main/modules/agent-control/task-projection/run-meta-repository'
  )
  const repo = new RunMetaRepository(db as unknown as ConstructorParameters<typeof RunMetaRepository>[0])

  const created = repo.create(
    {
      runId: 'run-initiator',
      status: 'running',
      initiator: 'user_stop',
      durationMs: 0,
    },
    1_700_000_000_000,
  )
  assert.equal(created.initiator, 'user_stop')
  assert.equal(created.durationMs, 0)

  const updated = repo.update(
    'run-initiator',
    {
      status: 'cancelled',
      initiator: 'timeout',
      durationMs: 1_234,
    },
    1_700_000_001_234,
  )
  assert.ok(updated)
  assert.equal(updated.initiator, 'timeout')
  assert.equal(updated.durationMs, 1_234)

  const refetched = repo.get('run-initiator')
  assert.equal(refetched?.initiator, 'timeout')
  assert.equal(refetched?.durationMs, 1_234)

  const raw = db
    .prepare('SELECT initiator, duration_ms FROM run_meta WHERE run_id = ?')
    .get<{ initiator: string | null; duration_ms: number | null }>('run-initiator')
  assert.equal(raw?.initiator, 'timeout')
  assert.equal(raw?.duration_ms, 1_234)
})
