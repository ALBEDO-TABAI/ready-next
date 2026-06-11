import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('migration-belief-columns declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'migration-belief-columns transitive sqlite load')
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

const BELIEF_COLUMNS = ['slug', 'confidence', 'file_path', 'status', 'content_hash']

class Migration052Db implements TestDb {
  readonly memoryColumns = new Set<string>([
    'id', 'layer', 'scope_id', 'category', 'title', 'summary', 'content_key',
  ])

  constructor(readonly appliedNames: string[], existingColumns: string[] = []) {
    for (const column of existingColumns) this.memoryColumns.add(column)
  }

  exec(sql: string): void {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (
      normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK'
      || normalized.startsWith('CREATE TABLE IF NOT EXISTS migrations')
    ) return

    const addColumn = normalized.match(/^ALTER TABLE agent_memory_metadata ADD COLUMN ([a-z_]+) /i)
    if (addColumn) {
      const column = addColumn[1]
      // mirror real SQLite: adding an existing column throws
      if (this.memoryColumns.has(column)) throw new Error(`duplicate column name: ${column}`)
      this.memoryColumns.add(column)
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
      return { run: (name: unknown) => { this.appliedNames.push(String(name)) }, all: () => [], get: () => undefined }
    }
    if (normalized === 'PRAGMA table_info(agent_memory_metadata)') {
      return {
        all: <R>() => Array.from(this.memoryColumns).map((name) => ({ name })) as R[],
        run: () => undefined,
        get: () => undefined,
      }
    }
    throw new Error(`unexpected migration statement: ${normalized}`)
  }
}

test('migration 052 adds the five belief mirror columns idempotently', async () => {
  const { __getMigrationNamesForTests, runMigrations } = await import('../main/modules/migrations')
  const names = __getMigrationNamesForTests()
  const idx = names.indexOf('052_belief_card_mirror_columns')
  assert.ok(idx > 0, 'migration 052 must be registered after existing migrations')
  const previous = names.slice(0, idx)

  const db = new Migration052Db([...previous])
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  for (const col of BELIEF_COLUMNS) assert.ok(db.memoryColumns.has(col), `missing column ${col}`)
  assert.equal(db.appliedNames.filter((n) => n === '052_belief_card_mirror_columns').length, 1)

  // second run is a no-op (already applied) — no duplicate-column throw
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  assert.equal(db.appliedNames.filter((n) => n === '052_belief_card_mirror_columns').length, 1)

  // upgrade path: columns already present → migration still records once, no throw
  const preexisting = new Migration052Db([...previous], BELIEF_COLUMNS)
  runMigrations(preexisting as unknown as Parameters<typeof runMigrations>[0])
  assert.equal(preexisting.appliedNames.filter((n) => n === '052_belief_card_mirror_columns').length, 1)
})
