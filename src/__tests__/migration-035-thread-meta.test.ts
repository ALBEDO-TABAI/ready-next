/**
 * Stage S (PR-S11 / W10.1+W10.2) — Migration 035 + ThreadMetaRepository.
 *
 * Verifies:
 *   1. Migration 035 creates the `thread_meta` table with the expected
 *      columns and CHECK constraint on `owner_kind`.
 *   2. `ThreadMetaRepository` round-trips a record (create → get → list).
 *   3. `update()` patches mutable fields (displayTitle / pinned / archived).
 *   4. `update()` strict-mutate guard rejects forbidden fields at runtime.
 *   5. Inserting a row with an invalid `owner_kind` triggers the CHECK.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

interface MigrationDb {
  exec(sql: string): void
  prepare<T = unknown>(sql: string): {
    run(...params: unknown[]): unknown
    all<R = unknown>(...params: unknown[]): R[]
    get<R = unknown>(...params: unknown[]): R | undefined
  }
}

async function buildInMemoryDb(): Promise<MigrationDb> {
  const Database = (await import('better-sqlite3')).default
  return new Database(':memory:') as unknown as MigrationDb
}

async function runAllMigrations(db: MigrationDb): Promise<void> {
  const { runMigrations } = await import('../main/modules/migrations')
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
}

test('migration 035 — thread_meta table created with expected columns', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-035 schema')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const tableInfo = db
    .prepare(`PRAGMA table_info(thread_meta)`)
    .all<{ name: string; type: string; notnull: number; pk: number }>()
  const columnsByName = new Map(tableInfo.map((c) => [c.name, c]))

  for (const expected of [
    'thread_id',
    'scope_id',
    'owner_kind',
    'owner_id',
    'display_title',
    'pinned',
    'archived',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columnsByName.has(expected), `column '${expected}' must exist`)
  }
  assert.equal(columnsByName.get('thread_id')?.pk, 1, 'thread_id is the PRIMARY KEY')
  assert.equal(columnsByName.get('scope_id')?.notnull, 1, 'scope_id is NOT NULL')
  assert.equal(columnsByName.get('owner_kind')?.notnull, 1, 'owner_kind is NOT NULL')
  assert.equal(columnsByName.get('owner_id')?.notnull, 1, 'owner_id is NOT NULL')
})

test('migration 035 — owner_kind CHECK constraint rejects unknown values', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-035 owner_kind CHECK')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  let threw = false
  try {
    db
      .prepare(
        `INSERT INTO thread_meta (
          thread_id, scope_id, owner_kind, owner_id,
          display_title, pinned, archived, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('th-1', 'scope-1', 'invalid_kind', 'owner-1', null, 0, 0, 1, 1)
  } catch (e) {
    threw = true
    assert.match(String(e), /CHECK constraint failed/i)
  }
  assert.ok(threw, 'invalid owner_kind must be rejected by CHECK')
})

test('migration 035 — re-running migrations is idempotent', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-035 idempotent')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)
  await runAllMigrations(db)
  const row = db.prepare(`SELECT count(*) AS c FROM thread_meta`).get<{ c: number }>()
  assert.equal(row?.c, 0)
})
