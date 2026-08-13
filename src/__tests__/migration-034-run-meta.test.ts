/**
 * Stage S (PR-S11 / W10.1+W10.2) — Migration 034 + RunMetaRepository.
 *
 * Verifies:
 *   1. Migration 034 creates the `run_meta` table with the expected columns
 *      and `idx_run_meta_task_id` / `idx_run_meta_scope_id` indexes.
 *   2. `RunMetaRepository` round-trips a record (create → get → list).
 *   3. `update()` patches mutable fields and bumps `updated_at`.
 *   4. `upsertTokens()` adds deltas cumulatively (no overwrite).
 *   5. Re-running migrations after 034 is idempotent (no SQL error).
 *
 * Uses better-sqlite3 in-memory DB. Skip-helper required because direct
 * better-sqlite3 import touches the Stage 5 SQLite gate (§6.17).
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

test('migration 034 — run_meta table created with expected columns', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-034 schema')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const tableInfo = db
    .prepare(`PRAGMA table_info(run_meta)`)
    .all<{ name: string; type: string; notnull: number; pk: number }>()
  const columnsByName = new Map(tableInfo.map((c) => [c.name, c]))

  for (const expected of [
    'run_id',
    'task_id',
    'scope_id',
    'agent_id',
    'status',
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'first_message_text',
    'last_message_text',
    'follow_up_text',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columnsByName.has(expected), `column '${expected}' must exist`)
  }
  assert.equal(columnsByName.get('run_id')?.pk, 1, 'run_id is the PRIMARY KEY')
  assert.equal(columnsByName.get('status')?.notnull, 1, 'status is NOT NULL')
  assert.equal(columnsByName.get('created_at')?.notnull, 1, 'created_at is NOT NULL')
  assert.equal(columnsByName.get('updated_at')?.notnull, 1, 'updated_at is NOT NULL')
})

test('migration 034 — indexes idx_run_meta_task_id and idx_run_meta_scope_id created', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-034 indexes')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const indexes = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='run_meta'`,
    )
    .all<{ name: string }>()
  const names = new Set(indexes.map((r) => r.name))
  assert.ok(names.has('idx_run_meta_task_id'), 'idx_run_meta_task_id present')
  assert.ok(names.has('idx_run_meta_scope_id'), 'idx_run_meta_scope_id present')
})

test('RunMetaRepository — create + get round-trips record', async (t) => {
  if (skipIfSqliteUnavailable(t, 'run-meta-repository round-trip')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const { RunMetaRepository } = await import(
    '../main/modules/agent-control/task-projection/run-meta-repository'
  )
  const repo = new RunMetaRepository(db as unknown as ConstructorParameters<typeof RunMetaRepository>[0])

  const now = 1_700_000_000_000
  db.prepare(
    `INSERT INTO chat_conversations (id, agent, title, created_at, updated_at)
     VALUES ('scope-1', 'butler', 'Run meta scope', ?, ?)`,
  ).run(String(now), String(now))
  const created = repo.create(
    {
      runId: 'run-1',
      taskId: 'task-1',
      scopeId: 'scope-1',
      messageVisibilityEpoch: 0,
      agentId: 'agent-1',
      status: 'running',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      firstMessageText: 'hello',
    },
    now,
  )
  assert.equal(created.runId, 'run-1')
  assert.equal(created.createdAt, now)
  assert.equal(created.updatedAt, now)

  const fetched = repo.get('run-1')
  assert.ok(fetched, 'fetched record exists')
  assert.equal(fetched!.taskId, 'task-1')
  assert.equal(fetched!.inputTokens, 100)
  assert.equal(fetched!.outputTokens, 50)
  assert.equal(fetched!.totalTokens, 150)
  assert.equal(fetched!.firstMessageText, 'hello')
  assert.equal(fetched!.lastMessageText, null)
})

test('RunMetaRepository — update bumps updated_at and patches fields', async (t) => {
  if (skipIfSqliteUnavailable(t, 'run-meta-repository update')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const { RunMetaRepository } = await import(
    '../main/modules/agent-control/task-projection/run-meta-repository'
  )
  const repo = new RunMetaRepository(db as unknown as ConstructorParameters<typeof RunMetaRepository>[0])

  const t0 = 1_700_000_000_000
  const t1 = t0 + 1000
  repo.create({ runId: 'run-2', status: 'running' }, t0)
  const updated = repo.update(
    'run-2',
    { status: 'done', lastMessageText: 'goodbye' },
    t1,
  )
  assert.ok(updated)
  assert.equal(updated!.status, 'done')
  assert.equal(updated!.lastMessageText, 'goodbye')
  assert.equal(updated!.updatedAt, t1)
  assert.equal(updated!.createdAt, t0, 'created_at preserved')

  const refetched = repo.get('run-2')
  assert.equal(refetched?.status, 'done')
  assert.equal(refetched?.lastMessageText, 'goodbye')
})

test('RunMetaRepository — upsertTokens adds deltas cumulatively', async (t) => {
  if (skipIfSqliteUnavailable(t, 'run-meta-repository upsertTokens')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const { RunMetaRepository } = await import(
    '../main/modules/agent-control/task-projection/run-meta-repository'
  )
  const repo = new RunMetaRepository(db as unknown as ConstructorParameters<typeof RunMetaRepository>[0])

  repo.create({ runId: 'run-3', status: 'running', inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  repo.upsertTokens('run-3', { inputTokens: 20, outputTokens: 10, totalTokens: 30 })
  const after1 = repo.get('run-3')
  assert.equal(after1?.inputTokens, 30)
  assert.equal(after1?.outputTokens, 15)
  assert.equal(after1?.totalTokens, 45)

  repo.upsertTokens('run-3', { inputTokens: 5, outputTokens: 5, totalTokens: 10 })
  const after2 = repo.get('run-3')
  assert.equal(after2?.inputTokens, 35)
  assert.equal(after2?.outputTokens, 20)
  assert.equal(after2?.totalTokens, 55)
})

test('RunMetaRepository — list filters by scopeId / taskId', async (t) => {
  if (skipIfSqliteUnavailable(t, 'run-meta-repository list')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const { RunMetaRepository } = await import(
    '../main/modules/agent-control/task-projection/run-meta-repository'
  )
  const repo = new RunMetaRepository(db as unknown as ConstructorParameters<typeof RunMetaRepository>[0])

  db.prepare(
    `INSERT INTO chat_conversations (id, agent, title, thread_key, created_at, updated_at)
     VALUES ('s1', 'butler', 'Scope 1', 's1', '1', '1'),
            ('s2', 'butler', 'Scope 2', 's2', '1', '1')`,
  ).run()
  repo.create({ runId: 'r1', scopeId: 's1', messageVisibilityEpoch: 0, taskId: 't1', status: 'done' }, 1)
  repo.create({ runId: 'r2', scopeId: 's1', messageVisibilityEpoch: 0, taskId: 't2', status: 'done' }, 2)
  repo.create({ runId: 'r3', scopeId: 's2', messageVisibilityEpoch: 0, taskId: 't1', status: 'done' }, 3)

  const byScope = repo.list({ scopeId: 's1' })
  assert.equal(byScope.length, 2)
  assert.deepEqual(byScope.map((r) => r.runId).sort(), ['r1', 'r2'])

  const byTask = repo.list({ taskId: 't1' })
  assert.equal(byTask.length, 2)
  assert.deepEqual(byTask.map((r) => r.runId).sort(), ['r1', 'r3'])

  const both = repo.list({ scopeId: 's1', taskId: 't1' })
  assert.equal(both.length, 1)
  assert.equal(both[0].runId, 'r1')
})

test('RunMetaRepository — execution bindings are immutable per run and preserve same-task history', async (t) => {
  if (skipIfSqliteUnavailable(t, 'run-meta execution binding history')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)
  const { RunMetaRepository } = await import('../main/modules/agent-control/task-projection/run-meta-repository')
  const repo = new RunMetaRepository(db as unknown as ConstructorParameters<typeof RunMetaRepository>[0])
  const binding = (runId: string, agentId: string, runOrigin: 'initial' | 'handoff_takeover') => ({
    schemaVersion: 1 as const, runId, ownerAgentIdAtStart: agentId, runOrigin,
    kind: 'registered_agent' as const, requestedAgentId: agentId, effectiveAgentId: agentId,
    executionMaterialHash: `hash:${agentId}`, ownerAssignmentSource: runOrigin === 'handoff_takeover' ? 'handoff' as const : 'conversation_active' as const,
    executionSelectionSource: 'task_owner' as const, resolutionKind: 'direct' as const,
  })
  repo.create({ runId: 'run-before', taskId: 'task-shared', status: 'done', executionBinding: binding('run-before', 'butler', 'initial') }, 1)
  repo.create({ runId: 'run-after', taskId: 'task-shared', status: 'running', executionBinding: binding('run-after', 'copywriter', 'handoff_takeover') }, 2)
  assert.equal(repo.get('run-before')?.executionBinding?.effectiveAgentId, 'butler')
  assert.equal(repo.get('run-after')?.executionBinding?.effectiveAgentId, 'copywriter')
  assert.throws(() => repo.update('run-before', { executionBinding: binding('run-before', 'copywriter', 'handoff_takeover') }), /immutable/)
  assert.equal(repo.get('run-before')?.executionBinding?.effectiveAgentId, 'butler')
})

test('migration 034 — re-running migrations is idempotent', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-034 idempotent')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)
  // Second run should be a no-op (the migrations tracking table prevents
  // re-execution); should not throw.
  await runAllMigrations(db)

  // Sanity: the table still exists and is queryable.
  const row = db
    .prepare(`SELECT count(*) AS c FROM run_meta`)
    .get<{ c: number }>()
  assert.equal(row?.c, 0)
})
