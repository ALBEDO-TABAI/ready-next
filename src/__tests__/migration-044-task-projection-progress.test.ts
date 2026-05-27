import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

interface MigrationDb {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all<R = unknown>(...params: unknown[]): R[]
  }
}

async function buildInMemoryDb(): Promise<MigrationDb> {
  const Database = (await import('better-sqlite3')).default
  return new Database(':memory:') as unknown as MigrationDb
}

test('migration 044 adds progress_json to existing task projections', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-044 task projection progress')) return
  const { __getMigrationNamesForTests, runMigrations } = await import('../main/modules/migrations')
  const db = await buildInMemoryDb()

  db.exec(`
    CREATE TABLE migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE task_projections (
      task_id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );
  `)

  const migrationNames = __getMigrationNamesForTests()
  const migrationIndex = migrationNames.indexOf('044_add_task_projection_progress_json')
  assert.ok(migrationIndex > 0, 'migration 044 must be registered after existing migrations')
  for (const name of migrationNames.slice(0, migrationIndex)) {
    db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(name, '2026-05-25T00:00:00.000Z')
  }

  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])

  const columns = db
    .prepare('PRAGMA table_info(task_projections)')
    .all<{ name: string }>()
    .map((column) => column.name)
  assert.ok(columns.includes('progress_json'))
})
