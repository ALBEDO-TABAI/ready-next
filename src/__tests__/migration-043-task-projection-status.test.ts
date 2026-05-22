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

test('migration 043 rewrites projection-local terminal statuses to child-run statuses', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-043 task projection status')) return
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
    INSERT INTO task_projections (task_id, status) VALUES
      ('done-row', 'done'),
      ('cancelled-row', 'cancelled'),
      ('running-row', 'running'),
      ('blocked-row', 'blocked'),
      ('completed-row', 'completed'),
      ('killed-row', 'killed');
  `)

  const migrationNames = __getMigrationNamesForTests()
  for (const name of migrationNames.slice(0, migrationNames.indexOf('043_migrate_task_projection_status_to_child_status'))) {
    db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(name, '2026-05-22T00:00:00.000Z')
  }

  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])

  const rows = db
    .prepare('SELECT task_id, status FROM task_projections ORDER BY task_id')
    .all<{ task_id: string; status: string }>()
  assert.deepEqual(rows, [
    { task_id: 'blocked-row', status: 'blocked' },
    { task_id: 'cancelled-row', status: 'killed' },
    { task_id: 'completed-row', status: 'completed' },
    { task_id: 'done-row', status: 'completed' },
    { task_id: 'killed-row', status: 'killed' },
    { task_id: 'running-row', status: 'running' },
  ])
})
