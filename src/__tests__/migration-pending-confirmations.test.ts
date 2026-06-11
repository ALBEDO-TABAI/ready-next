/**
 * EP1-I3-2 — migration 053 `pending_confirmations` table (fake-DB paradigm,
 * mirrors migration-belief-columns.test.ts: host node cannot load the
 * electron-ABI sqlite, so the migration runner is exercised against a typed
 * fake; the real-SQLite pass is covered by `npm run verify:native`).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('migration-pending-confirmations declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'migration-pending-confirmations transitive sqlite load')
})

interface Statement {
  run(...params: unknown[]): unknown
  all<R = unknown>(...params: unknown[]): R[]
  get<R = unknown>(...params: unknown[]): R | undefined
}

class Migration053Db {
  readonly tables = new Set<string>()
  readonly indexes = new Set<string>()

  constructor(readonly appliedNames: string[]) {}

  exec(sql: string): void {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (
      normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK'
      || normalized.startsWith('CREATE TABLE IF NOT EXISTS migrations')
    ) return

    const createTable = normalized.match(/^CREATE TABLE IF NOT EXISTS ([a-z_]+) /i)
    if (createTable) {
      // IF NOT EXISTS — re-running is a legal no-op, mirror real SQLite.
      this.tables.add(createTable[1])
      return
    }
    const createIndex = normalized.match(/^CREATE INDEX IF NOT EXISTS ([a-z_]+) /i)
    if (createIndex) {
      this.indexes.add(createIndex[1])
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
    throw new Error(`unexpected migration statement: ${normalized}`)
  }
}

test('migration 053 creates the pending_confirmations table + status index idempotently', async () => {
  const { __getMigrationNamesForTests, runMigrations } = await import('../main/modules/migrations')
  const names = __getMigrationNamesForTests()
  const idx = names.indexOf('053_pending_confirmations')
  assert.ok(idx > 0, 'migration 053 must be registered')
  assert.equal(idx, names.length - 1, 'migration 053 must be the newest (append-only discipline)')
  const previous = names.filter((name) => name !== '053_pending_confirmations')

  const db = new Migration053Db([...previous])
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  assert.ok(db.tables.has('pending_confirmations'), 'pending_confirmations table must be created')
  assert.ok(db.indexes.has('idx_pending_confirmations_status'), 'status index must be created')
  assert.equal(db.appliedNames.filter((n) => n === '053_pending_confirmations').length, 1)

  // second run is a no-op (already applied)
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
  assert.equal(db.appliedNames.filter((n) => n === '053_pending_confirmations').length, 1)
})

test('migration 053 declares exactly the contract columns', async () => {
  // The contract fixes the column set (id/run_id/task_id/scope_id/tool_name/
  // params_json/created_at/expires_at/status/released_at). Pin it from the
  // migration source so a drive-by column rename trips a focused failure.
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const source = readFileSync(resolve(process.cwd(), 'src/main/modules/migrations.ts'), 'utf8')
  const tableDef = source.match(/CREATE TABLE IF NOT EXISTS pending_confirmations \(([\s\S]*?)\)\s*`/)?.[1] || ''
  for (const column of ['id', 'run_id', 'task_id', 'scope_id', 'tool_name', 'params_json', 'created_at', 'expires_at', 'status', 'released_at']) {
    assert.ok(new RegExp(`\\b${column}\\b`).test(tableDef), `column ${column} missing from pending_confirmations`)
  }
})
