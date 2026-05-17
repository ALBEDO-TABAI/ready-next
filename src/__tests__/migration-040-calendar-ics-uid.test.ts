/**
 * L4-B-External-Sync (Migration 040) — schema verification.
 *
 * Migration 040 adds `ics_uid TEXT` + `source_id TEXT` columns to
 * `calendar_events`, plus indexes on each. Like 039 this is a pair of
 * non-destructive `ALTER TABLE ADD COLUMN` statements (no CHECK
 * constraints, no column reorder), so per §6.13 ALTER is the right
 * pattern, not CREATE-INSERT-DROP-RENAME.
 *
 * This suite verifies:
 *   1. Both columns + both indexes exist after running all migrations
 *      through 040.
 *   2. The columns default to NULL (back-compat for local rows).
 *   3. A non-NULL value round-trips through the column unchanged.
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
  const Database = (await import('better-sqlite3')).default
  return new Database(':memory:') as unknown as MigrationDb
}

async function runAllMigrations(db: MigrationDb): Promise<void> {
  const { runMigrations } = await import('../main/modules/migrations')
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
}

test('migration 040 — calendar_events has ics_uid and source_id columns', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-040 schema')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const tableInfo = db
    .prepare(`PRAGMA table_info(calendar_events)`)
    .all<{ name: string; type: string; notnull: number; dflt_value: string | null }>()
  const columnsByName = new Map(tableInfo.map((c) => [c.name, c]))

  const icsUid = columnsByName.get('ics_uid')
  const sourceId = columnsByName.get('source_id')
  assert.ok(icsUid, 'ics_uid column must exist after migration 040')
  assert.ok(sourceId, 'source_id column must exist after migration 040')
  assert.equal(icsUid?.type, 'TEXT', 'ics_uid is TEXT')
  assert.equal(sourceId?.type, 'TEXT', 'source_id is TEXT')
  assert.equal(icsUid?.notnull, 0, 'ics_uid is nullable (null = local row)')
  assert.equal(sourceId?.notnull, 0, 'source_id is nullable (null = local row)')
})

test('migration 040 — idx_events_ics_uid and idx_events_source_id are present', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-040 indexes')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const indexes = db
    .prepare(`PRAGMA index_list(calendar_events)`)
    .all<{ name: string }>()
  const names = new Set(indexes.map((i) => i.name))
  assert.ok(names.has('idx_events_ics_uid'), 'idx_events_ics_uid exists')
  assert.ok(names.has('idx_events_source_id'), 'idx_events_source_id exists')
})

test('migration 040 — ics_uid / source_id default to NULL for newly inserted rows', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-040 defaults')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  db.prepare(
    `INSERT INTO calendar_sources (id, name, color, type, enabled) VALUES (?, ?, ?, ?, ?)`,
  ).run('cal-test', 'Test Calendar', '#5B8DEF', 'local', 1)

  // Bare INSERT — only required columns. The new ics_uid / source_id
  // columns should default to NULL so existing event-create callers
  // continue to work without specifying them at all.
  db.prepare(
    `INSERT INTO calendar_events (id, calendar_id, title, start_time, end_time) VALUES (?, ?, ?, ?, ?)`,
  ).run('evt-1', 'cal-test', 'No Sync Metadata', 1779494400, 1779498000)

  const row = db
    .prepare(
      `SELECT id, ics_uid, source_id FROM calendar_events WHERE id = ?`,
    )
    .get<{ id: string; ics_uid: string | null; source_id: string | null }>('evt-1')
  assert.ok(row, 'inserted row must be readable')
  assert.equal(row?.ics_uid, null, 'ics_uid defaults to NULL')
  assert.equal(row?.source_id, null, 'source_id defaults to NULL')
})

test('migration 040 — ics_uid / source_id strings round-trip through columns', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-040 round-trip')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  db.prepare(
    `INSERT INTO calendar_sources (id, name, color, type, enabled) VALUES (?, ?, ?, ?, ?)`,
  ).run('feed-A', 'Subscription A', '#5B8DEF', 'subscription', 1)

  db.prepare(
    `INSERT INTO calendar_events
       (id, calendar_id, title, start_time, end_time, ics_uid, source_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('evt-2', 'feed-A', 'Imported Event', 1779494400, 1779498000, 'vevent-uid-xyz@example.test', 'feed-A')

  const row = db
    .prepare(
      `SELECT ics_uid, source_id FROM calendar_events WHERE id = ?`,
    )
    .get<{ ics_uid: string | null; source_id: string | null }>('evt-2')
  assert.equal(row?.ics_uid, 'vevent-uid-xyz@example.test', 'ics_uid round-trips')
  assert.equal(row?.source_id, 'feed-A', 'source_id round-trips')
})

test('migration 040 — re-running migrations is idempotent', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-040 idempotent')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)
  await assert.doesNotReject(() => runAllMigrations(db))

  const tableInfo = db
    .prepare(`PRAGMA table_info(calendar_events)`)
    .all<{ name: string }>()
  const names = new Set(tableInfo.map((c) => c.name))
  assert.ok(names.has('ics_uid'))
  assert.ok(names.has('source_id'))
})

test('migration 040 — FK CASCADE drops imported events when source is deleted', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-040 cascade')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)
  // Enable foreign keys — SQLite defaults to off; our app enables this
  // pragma elsewhere but this test is host-Node only so we set it here.
  db.exec('PRAGMA foreign_keys = ON')

  db.prepare(
    `INSERT INTO calendar_sources (id, name, color, type, enabled) VALUES (?, ?, ?, ?, ?)`,
  ).run('feed-X', 'Subscription X', '#5B8DEF', 'subscription', 1)
  db.prepare(
    `INSERT INTO calendar_events
       (id, calendar_id, title, start_time, end_time, ics_uid, source_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('evt-x1', 'feed-X', 'X-1', 1, 2, 'uid-x1', 'feed-X')

  const before = db
    .prepare(`SELECT COUNT(*) AS n FROM calendar_events WHERE calendar_id = ?`)
    .get<{ n: number }>('feed-X')
  assert.equal(before?.n, 1, 'one event exists before delete')

  db.prepare(`DELETE FROM calendar_sources WHERE id = ?`).run('feed-X')

  const after = db
    .prepare(`SELECT COUNT(*) AS n FROM calendar_events WHERE calendar_id = ?`)
    .get<{ n: number }>('feed-X')
  assert.equal(after?.n, 0, 'event was cascade-deleted with the source')
})
