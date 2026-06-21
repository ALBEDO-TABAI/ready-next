import assert from 'node:assert/strict'
import test from 'node:test'

import { runMigrations, __getMigrationNamesForTests, type MigrationDatabase } from '../main/modules/migrations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

async function openInMemoryDb(): Promise<MigrationDatabase> {
  const Database = (await import('better-sqlite3')).default
  return new Database(':memory:') as unknown as MigrationDatabase
}

test('migration 062 registers specialist content edit proposals after projection syncs', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration specialist content edit proposals registration')) return
  const names = __getMigrationNamesForTests()
  assert.ok(names.includes('062_specialist_content_edit_proposals'), '062 registered')
  assert.ok(
    names.indexOf('061_pending_projection_syncs') < names.indexOf('062_specialist_content_edit_proposals'),
    'content edit proposals follow projection sync ledger',
  )
})

test('migration 062 creates durable content edit proposal table and index', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration specialist content edit proposal tables')) return
  const db = await openInMemoryDb()
  try {
    runMigrations(db)
    const table = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
       AND name = 'specialist_content_edit_proposals'`,
    ).get<{ name: string }>()
    assert.equal(table?.name, 'specialist_content_edit_proposals')

    const index = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index'
       AND name = 'idx_specialist_content_edit_agent_status'`,
    ).get<{ name: string }>()
    assert.equal(index?.name, 'idx_specialist_content_edit_agent_status')

    runMigrations(db)
    const ledger = db.prepare(
      `SELECT COUNT(*) AS count FROM migrations
       WHERE name = '062_specialist_content_edit_proposals'`,
    ).get<{ count: number }>()
    assert.equal(ledger?.count, 1)
  } finally {
    db.close()
  }
})
