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

test('ThreadMetaRepository — create + get round-trips record', async (t) => {
  if (skipIfSqliteUnavailable(t, 'thread-meta-repository round-trip')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const { ThreadMetaRepository } = await import(
    '../main/modules/agent-control/thread-meta-repository'
  )
  const repo = new ThreadMetaRepository(
    db as unknown as ConstructorParameters<typeof ThreadMetaRepository>[0],
  )

  const now = 1_700_000_000_000
  const created = repo.create(
    {
      threadId: 'th-A',
      scopeId: 'scope-A',
      ownerKind: 'user',
      ownerId: 'user-1',
      displayTitle: 'My Thread',
      pinned: true,
    },
    now,
  )
  assert.equal(created.threadId, 'th-A')
  assert.equal(created.ownerKind, 'user')
  assert.equal(created.ownerId, 'user-1')
  assert.equal(created.pinned, true)
  assert.equal(created.archived, false)
  assert.equal(created.createdAt, now)

  const fetched = repo.get('th-A')
  assert.ok(fetched)
  assert.equal(fetched!.displayTitle, 'My Thread')
  assert.equal(fetched!.pinned, true)
})

test('ThreadMetaRepository — update patches displayTitle / pinned / archived only', async (t) => {
  if (skipIfSqliteUnavailable(t, 'thread-meta-repository update mutable fields')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const { ThreadMetaRepository } = await import(
    '../main/modules/agent-control/thread-meta-repository'
  )
  const repo = new ThreadMetaRepository(
    db as unknown as ConstructorParameters<typeof ThreadMetaRepository>[0],
  )

  const t0 = 1_700_000_000_000
  const t1 = t0 + 5000
  repo.create(
    { threadId: 'th-B', scopeId: 'scope-B', ownerKind: 'agent', ownerId: 'agent-1' },
    t0,
  )
  const updated = repo.update(
    'th-B',
    { displayTitle: 'Renamed', archived: true },
    t1,
  )
  assert.ok(updated)
  assert.equal(updated!.displayTitle, 'Renamed')
  assert.equal(updated!.archived, true)
  assert.equal(updated!.updatedAt, t1)
  assert.equal(updated!.ownerKind, 'agent', 'ownerKind preserved')
  assert.equal(updated!.ownerId, 'agent-1', 'ownerId preserved')
  assert.equal(updated!.scopeId, 'scope-B', 'scopeId preserved')
  assert.equal(updated!.createdAt, t0, 'createdAt preserved')
})

test('ThreadMetaRepository — strict mutate rejects ownerKind / ownerId / scopeId in patch', async (t) => {
  if (skipIfSqliteUnavailable(t, 'thread-meta-repository strict mutate')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const { ThreadMetaRepository } = await import(
    '../main/modules/agent-control/thread-meta-repository'
  )
  const repo = new ThreadMetaRepository(
    db as unknown as ConstructorParameters<typeof ThreadMetaRepository>[0],
  )

  repo.create({
    threadId: 'th-C',
    scopeId: 'scope-C',
    ownerKind: 'user',
    ownerId: 'user-c',
  })

  // Cast to an `any`-style payload to bypass the type guard — the runtime
  // guard inside `update()` is the contract we're pinning here.
  for (const forbidden of ['ownerKind', 'ownerId', 'scopeId', 'threadId', 'createdAt']) {
    let threw = false
    try {
      repo.update(
        'th-C',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { [forbidden]: 'mutated' } as any,
      )
    } catch (e) {
      threw = true
      assert.match(String(e), /immutable/i, `error message should mention 'immutable' for ${forbidden}`)
    }
    assert.ok(threw, `update() must throw when patch contains '${forbidden}'`)
  }
})

test('ThreadMetaRepository — list filters by scopeId / archived / pinned', async (t) => {
  if (skipIfSqliteUnavailable(t, 'thread-meta-repository list')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const { ThreadMetaRepository } = await import(
    '../main/modules/agent-control/thread-meta-repository'
  )
  const repo = new ThreadMetaRepository(
    db as unknown as ConstructorParameters<typeof ThreadMetaRepository>[0],
  )

  repo.create({ threadId: 't1', scopeId: 's1', ownerKind: 'user', ownerId: 'u', pinned: true }, 1)
  repo.create({ threadId: 't2', scopeId: 's1', ownerKind: 'user', ownerId: 'u', archived: true }, 2)
  repo.create({ threadId: 't3', scopeId: 's2', ownerKind: 'system', ownerId: 'sys' }, 3)

  const inScope1 = repo.list({ scopeId: 's1' })
  assert.equal(inScope1.length, 2)

  const archived = repo.list({ archived: true })
  assert.equal(archived.length, 1)
  assert.equal(archived[0].threadId, 't2')

  const pinned = repo.list({ pinned: true })
  assert.equal(pinned.length, 1)
  assert.equal(pinned[0].threadId, 't1')
})

test('migration 035 — re-running migrations is idempotent', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-035 idempotent')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)
  await runAllMigrations(db)
  const row = db.prepare(`SELECT count(*) AS c FROM thread_meta`).get<{ c: number }>()
  assert.equal(row?.c, 0)
})
