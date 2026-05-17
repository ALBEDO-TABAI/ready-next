/**
 * L4-A-Timezone (Migration 039) — schema verification.
 *
 * Migration 039 adds two TEXT columns `start_tz` and `end_tz` to
 * `calendar_events`. SQLite supports non-destructive `ALTER TABLE ADD
 * COLUMN` so unlike migration 037 (which used CREATE-INSERT-DROP-RENAME
 * to physically delete a column) this one is a single ADD COLUMN pair.
 *
 * This suite verifies:
 *   1. Both columns exist after running all migrations through 039.
 *   2. The columns default to NULL (the "= local timezone" sentinel for
 *      back-compat with pre-039 rows).
 *   3. A non-NULL string value round-trips through the column unchanged.
 *   4. Re-running all migrations is idempotent.
 *
 * Uses better-sqlite3 in-memory DB. Skip-helper required per §6.17 so
 * the test passes under host-Node and is exercised under
 * `npm run verify:native`.
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
  // Dynamic import so the static C3 SQLite gate detects the call.
  const Database = (await import('better-sqlite3')).default
  return new Database(':memory:') as unknown as MigrationDb
}

async function runAllMigrations(db: MigrationDb): Promise<void> {
  const { runMigrations } = await import('../main/modules/migrations')
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
}

test('migration 039 — calendar_events has start_tz and end_tz columns', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-039 schema')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const tableInfo = db
    .prepare(`PRAGMA table_info(calendar_events)`)
    .all<{ name: string; type: string; notnull: number; dflt_value: string | null }>()
  const columnsByName = new Map(tableInfo.map((c) => [c.name, c]))

  const startTz = columnsByName.get('start_tz')
  const endTz = columnsByName.get('end_tz')
  assert.ok(startTz, 'start_tz column must exist after migration 039')
  assert.ok(endTz, 'end_tz column must exist after migration 039')
  assert.equal(startTz?.type, 'TEXT', 'start_tz is TEXT')
  assert.equal(endTz?.type, 'TEXT', 'end_tz is TEXT')
  assert.equal(startTz?.notnull, 0, 'start_tz is nullable (null = local)')
  assert.equal(endTz?.notnull, 0, 'end_tz is nullable (null = local)')
})

test('migration 039 — start_tz / end_tz default to NULL for newly inserted rows', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-039 defaults')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  // Insert a minimal calendar source first so the FK from calendar_events
  // resolves. Calendar sources have their own schema; insert by SQL to
  // avoid pulling in the repository layer.
  db.prepare(
    `INSERT INTO calendar_sources (id, name, color, type, enabled) VALUES (?, ?, ?, ?, ?)`,
  ).run('cal-test', 'Test Calendar', '#5B8DEF', 'local', 1)

  // Bare INSERT — only required columns. The new tz columns should
  // default to NULL so existing event-create callers continue to work
  // without specifying tz at all.
  db.prepare(
    `INSERT INTO calendar_events (id, calendar_id, title, start_time, end_time) VALUES (?, ?, ?, ?, ?)`,
  ).run('evt-1', 'cal-test', 'No Timezone Set', 1779494400, 1779498000)

  const row = db
    .prepare(
      `SELECT id, start_tz, end_tz FROM calendar_events WHERE id = ?`,
    )
    .get<{ id: string; start_tz: string | null; end_tz: string | null }>('evt-1')
  assert.ok(row, 'inserted row must be readable')
  assert.equal(row?.start_tz, null, 'start_tz defaults to NULL (= local)')
  assert.equal(row?.end_tz, null, 'end_tz defaults to NULL (= local)')
})

test('migration 039 — IANA strings round-trip through start_tz / end_tz columns', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-039 round-trip')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  db.prepare(
    `INSERT INTO calendar_sources (id, name, color, type, enabled) VALUES (?, ?, ?, ?, ?)`,
  ).run('cal-test', 'Test Calendar', '#5B8DEF', 'local', 1)

  db.prepare(
    `INSERT INTO calendar_events
       (id, calendar_id, title, start_time, end_time, start_tz, end_tz)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('evt-2', 'cal-test', 'Shanghai Meeting', 1779494400, 1779498000, 'Asia/Shanghai', 'Asia/Shanghai')

  const row = db
    .prepare(
      `SELECT start_tz, end_tz FROM calendar_events WHERE id = ?`,
    )
    .get<{ start_tz: string | null; end_tz: string | null }>('evt-2')
  assert.equal(row?.start_tz, 'Asia/Shanghai', 'start_tz round-trips IANA id')
  assert.equal(row?.end_tz, 'Asia/Shanghai', 'end_tz round-trips IANA id')
})

test('migration 039 — re-running migrations is idempotent', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-039 idempotent')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)
  // Second run must not throw "duplicate column" or any other SQL error.
  await assert.doesNotReject(() => runAllMigrations(db))

  // And the columns still exist.
  const tableInfo = db
    .prepare(`PRAGMA table_info(calendar_events)`)
    .all<{ name: string }>()
  const names = new Set(tableInfo.map((c) => c.name))
  assert.ok(names.has('start_tz'))
  assert.ok(names.has('end_tz'))
})
