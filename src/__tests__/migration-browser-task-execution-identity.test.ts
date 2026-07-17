import assert from 'node:assert/strict'
import test from 'node:test'
import { __getMigrationNamesForTests, __runMigrationForTests } from '../main/modules/migrations'
import type { MigrationDatabase } from '../main/modules/migrations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('migration 082 adds browser task revision and execution identity columns', (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-082 browser task execution identity statements')) return
  const names = __getMigrationNamesForTests()
  assert.ok(names.includes('082_browser_task_execution_identity'))
  assert.ok(names.indexOf('081_browser_power_preflight_audit') < names.indexOf('082_browser_task_execution_identity'))

  const statements: string[] = []
  __runMigrationForTests('082_browser_task_execution_identity', {
    exec: (sql) => { statements.push(sql) },
    prepare: () => ({ run: () => undefined, all: () => [] }),
  })
  const sql = statements.join('\n')
  for (const column of [
    'revision',
    'created_by_run_id',
    'active_execution_binding_json',
    'parent_task_id',
    'projection_revision',
    'projection_sync_json',
  ]) {
    assert.match(sql, new RegExp(`browser_tasks ADD COLUMN ${column}`))
  }
})

test('migration 082 preserves existing browser tasks and applies real SQLite defaults', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-082 browser task execution identity')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE browser_tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        progress_total INTEGER NOT NULL DEFAULT 0,
        progress_completed INTEGER NOT NULL DEFAULT 0,
        progress_failed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO browser_tasks (
        id, kind, status, payload_json, created_at, updated_at
      ) VALUES (
        'browser-task-existing', 'site_research', 'paused', '{}',
        '2026-07-18T00:00:00.000Z', '2026-07-18T00:00:00.000Z'
      );
    `)

    __runMigrationForTests('082_browser_task_execution_identity', db as unknown as MigrationDatabase)

    const row = db.prepare(`
      SELECT id, revision, created_by_run_id, active_execution_binding_json,
             parent_task_id, projection_revision, projection_sync_json
      FROM browser_tasks WHERE id = ?
    `).get('browser-task-existing') as Record<string, unknown>
    assert.deepEqual(row, {
      id: 'browser-task-existing',
      revision: 0,
      created_by_run_id: null,
      active_execution_binding_json: null,
      parent_task_id: null,
      projection_revision: 0,
      projection_sync_json: null,
    })
    const indexes = db.prepare("PRAGMA index_list('browser_tasks')").all() as Array<{ name: string }>
    assert.ok(indexes.some((index) => index.name === 'idx_browser_tasks_projection_revision'))
  } finally {
    db.close()
  }
})
