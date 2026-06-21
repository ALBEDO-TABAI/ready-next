import assert from 'node:assert/strict'
import test from 'node:test'

import { runMigrations, __getMigrationNamesForTests, type MigrationDatabase } from '../main/modules/migrations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

async function openInMemoryDb(): Promise<MigrationDatabase> {
  const Database = (await import('better-sqlite3')).default
  return new Database(':memory:') as unknown as MigrationDatabase
}

test('migration 060 registers specialist blueprint persistence after lifecycle columns', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration specialist blueprint persistence registration')) return
  const names = __getMigrationNamesForTests()
  assert.ok(names.includes('060_specialist_blueprint_persistence'), '060 registered')
  assert.ok(
    names.indexOf('059_agent_lifecycle_merged_target') < names.indexOf('060_specialist_blueprint_persistence'),
    'blueprint persistence follows lifecycle migration',
  )
})

test('migration 060 creates durable blueprint and confirmation tables', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration specialist blueprint persistence tables')) return
  const db = await openInMemoryDb()
  try {
    runMigrations(db)
    const tableNames = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
       AND name IN ('specialist_blueprints', 'specialist_blueprint_confirmations')
       ORDER BY name`,
    ).all<{ name: string }>().map((row) => row.name)
    assert.deepEqual(tableNames, ['specialist_blueprint_confirmations', 'specialist_blueprints'])

    const index = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
       AND name = 'idx_specialist_blueprints_status'`,
    ).get<{ name: string }>()
    assert.equal(index?.name, 'idx_specialist_blueprints_status')

    runMigrations(db)
    const ledger = db.prepare(
      `SELECT COUNT(*) AS count FROM migrations
       WHERE name = '060_specialist_blueprint_persistence'`,
    ).get<{ count: number }>()
    assert.equal(ledger?.count, 1)
  } finally {
    db.close()
  }
})
