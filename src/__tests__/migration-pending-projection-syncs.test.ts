import assert from 'node:assert/strict'
import test from 'node:test'

import { __getMigrationNamesForTests, runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

async function openInMemoryDb(): Promise<MigrationDatabase> {
  const Database = (await import('better-sqlite3')).default
  return new Database(':memory:') as unknown as MigrationDatabase
}

test('migration 061 registers pending projection syncs after blueprint persistence', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration pending projection syncs registration')) return
  const names = __getMigrationNamesForTests()
  assert.ok(names.includes('061_pending_projection_syncs'), '061 registered')
  assert.ok(
    names.indexOf('060_specialist_blueprint_persistence') < names.indexOf('061_pending_projection_syncs'),
    'projection sync ledger follows blueprint persistence migration',
  )
})

test('migration 061 creates durable pending projection sync ledger', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration pending projection syncs table')) return
  const db = await openInMemoryDb()
  try {
    runMigrations(db)
    const table = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
       AND name = 'pending_projection_syncs'`,
    ).get<{ name: string }>()
    assert.equal(table?.name, 'pending_projection_syncs')

    const columns = db.prepare('PRAGMA table_info(pending_projection_syncs)').all<{ name: string }>()
    assert.deepEqual(
      columns.map((column) => column.name),
      ['id', 'status', 'attempts', 'next_attempt_at', 'last_error', 'payload_json', 'created_at', 'updated_at'],
    )

    const index = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
       AND name = 'idx_pending_projection_syncs_due'`,
    ).get<{ name: string }>()
    assert.equal(index?.name, 'idx_pending_projection_syncs_due')

    runMigrations(db)
    const ledger = db.prepare(
      `SELECT COUNT(*) AS count FROM migrations
       WHERE name = '061_pending_projection_syncs'`,
    ).get<{ count: number }>()
    assert.equal(ledger?.count, 1)
  } finally {
    db.close()
  }
})
