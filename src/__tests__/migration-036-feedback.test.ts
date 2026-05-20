/**
 * Stage S (PR-S11 / W10.1+W10.2) — Migration 036 + RunFeedbackRepository.
 *
 * Verifies:
 *   1. Migration 036 creates the `run_feedback` table with the rating CHECK
 *      and `idx_run_feedback_run_id` index.
 *   2. `RunFeedbackRepository.upsert()` is idempotent on re-submission and
 *      preserves `created_at` while bumping `updated_at`.
 *   3. Inserting a row with rating outside 1..5 triggers the CHECK.
 *   4. `list()` filters by runId / taskId.
 *
 * Note on foreign keys: SQLite's `foreign_keys` PRAGMA is OFF by default
 * and is NOT toggled by the migration framework. The FK declaration in
 * 036 is documentary; the gate `check-feedback-upsert-shape.cjs` and
 * these tests do not assume cascade behaviour.
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

test('migration 036 — run_feedback table created with expected columns', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-036 schema')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const tableInfo = db
    .prepare(`PRAGMA table_info(run_feedback)`)
    .all<{ name: string; type: string; notnull: number; pk: number }>()
  const columnsByName = new Map(tableInfo.map((c) => [c.name, c]))
  for (const expected of [
    'feedback_id',
    'run_id',
    'task_id',
    'rating',
    'signal',
    'comment',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columnsByName.has(expected), `column '${expected}' must exist`)
  }
  assert.equal(columnsByName.get('feedback_id')?.pk, 1)
  assert.equal(columnsByName.get('run_id')?.notnull, 1, 'run_id is NOT NULL')

  const indexes = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='run_feedback'`)
    .all<{ name: string }>()
  const names = new Set(indexes.map((r) => r.name))
  assert.ok(names.has('idx_run_feedback_run_id'), 'idx_run_feedback_run_id present')
})

test('migration 036 — rating CHECK rejects values outside 1..5', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-036 rating CHECK')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)
  // Need a parent run_meta row in case FKs were enabled; we don't enable
  // them, but inserting one keeps the test future-proof.
  db.prepare(
    `INSERT INTO run_meta (run_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run('run-x', 'done', 1, 1)

  for (const bad of [0, 6, -1, 100]) {
    let threw = false
    try {
      db.prepare(
        `INSERT INTO run_feedback (
          feedback_id, run_id, task_id, rating, signal, comment, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`fb-${bad}`, 'run-x', null, bad, null, null, 1, 1)
    } catch (e) {
      threw = true
      assert.match(String(e), /CHECK constraint failed/i)
    }
    assert.ok(threw, `rating=${bad} must be rejected by CHECK`)
  }

  // Valid range is accepted.
  for (const ok of [1, 2, 3, 4, 5]) {
    db.prepare(
      `INSERT INTO run_feedback (
        feedback_id, run_id, task_id, rating, signal, comment, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`fb-good-${ok}`, 'run-x', null, ok, null, null, 1, 1)
  }
})

test('RunFeedbackRepository — upsert creates new row then preserves created_at on conflict', async (t) => {
  if (skipIfSqliteUnavailable(t, 'run-feedback-repository upsert idempotent')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)
  // Parent run_meta row (declarative FK; not enforced without PRAGMA).
  db.prepare(
    `INSERT INTO run_meta (run_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run('run-y', 'done', 1, 1)

  const { RunFeedbackRepository } = await import(
    '../main/modules/agent-control/task-projection/run-feedback-repository'
  )
  const repo = new RunFeedbackRepository(
    db as unknown as ConstructorParameters<typeof RunFeedbackRepository>[0],
  )

  const t0 = 1_700_000_000_000
  const t1 = t0 + 1000
  const t2 = t0 + 2000

  // First submission.
  const first = repo.upsert(
    { feedbackId: 'fb-1', runId: 'run-y', rating: 3, signal: 'ok' },
    t0,
  )
  assert.equal(first.rating, 3)
  assert.equal(first.signal, 'ok')
  assert.equal(first.createdAt, t0)
  assert.equal(first.updatedAt, t0)

  // Re-submit same feedback_id with different content.
  const second = repo.upsert(
    {
      feedbackId: 'fb-1',
      runId: 'run-y',
      rating: 5,
      signal: 'great',
      comment: 'works as expected',
    },
    t1,
  )
  assert.equal(second.rating, 5)
  assert.equal(second.signal, 'great')
  assert.equal(second.comment, 'works as expected')
  assert.equal(second.createdAt, t0, 'created_at preserved across upsert')
  assert.equal(second.updatedAt, t1, 'updated_at advanced')

  // Third re-submission with even fewer fields → null overwrites previous comment.
  const third = repo.upsert({ feedbackId: 'fb-1', runId: 'run-y', rating: 4 }, t2)
  assert.equal(third.rating, 4)
  assert.equal(third.signal, null)
  assert.equal(third.comment, null)
  assert.equal(third.createdAt, t0, 'created_at still preserved')
  assert.equal(third.updatedAt, t2)
})

test('RunFeedbackRepository — list filters by runId and taskId', async (t) => {
  if (skipIfSqliteUnavailable(t, 'run-feedback-repository list')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)
  db.prepare(
    `INSERT INTO run_meta (run_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run('rA', 'done', 1, 1)
  db.prepare(
    `INSERT INTO run_meta (run_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run('rB', 'done', 1, 1)

  const { RunFeedbackRepository } = await import(
    '../main/modules/agent-control/task-projection/run-feedback-repository'
  )
  const repo = new RunFeedbackRepository(
    db as unknown as ConstructorParameters<typeof RunFeedbackRepository>[0],
  )

  repo.upsert({ feedbackId: 'f1', runId: 'rA', taskId: 'tX', rating: 4 }, 1)
  repo.upsert({ feedbackId: 'f2', runId: 'rA', taskId: 'tY', rating: 5 }, 2)
  repo.upsert({ feedbackId: 'f3', runId: 'rB', taskId: 'tX', rating: 3 }, 3)

  const byRun = repo.list({ runId: 'rA' })
  assert.equal(byRun.length, 2)
  assert.deepEqual(byRun.map((r) => r.feedbackId).sort(), ['f1', 'f2'])

  const byTask = repo.list({ taskId: 'tX' })
  assert.equal(byTask.length, 2)
  assert.deepEqual(byTask.map((r) => r.feedbackId).sort(), ['f1', 'f3'])
})

test('RunFeedbackRepository — delete removes row', async (t) => {
  if (skipIfSqliteUnavailable(t, 'run-feedback-repository delete')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)
  db.prepare(
    `INSERT INTO run_meta (run_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run('r-del', 'done', 1, 1)

  const { RunFeedbackRepository } = await import(
    '../main/modules/agent-control/task-projection/run-feedback-repository'
  )
  const repo = new RunFeedbackRepository(
    db as unknown as ConstructorParameters<typeof RunFeedbackRepository>[0],
  )

  repo.upsert({ feedbackId: 'fd', runId: 'r-del', rating: 1 })
  assert.ok(repo.get('fd'))
  assert.equal(repo.delete('fd'), true)
  assert.equal(repo.get('fd'), null)
  assert.equal(repo.delete('fd'), false, 'second delete reports no change')
})

test('migration 036 — re-running migrations is idempotent', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-036 idempotent')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)
  await runAllMigrations(db)
  const row = db.prepare(`SELECT count(*) AS c FROM run_feedback`).get<{ c: number }>()
  assert.equal(row?.c, 0)
})
