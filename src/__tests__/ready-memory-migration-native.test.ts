import assert from 'node:assert/strict'
import test from 'node:test'

import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('migration 113 creates only the four Ready memory truth tables and retires legacy rows', (t) => {
  if (skipIfSqliteUnavailable(t, 'ready-memory migration schema')) return
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())
  db.exec(`
    CREATE TABLE agent_trigger_refs (trigger_id TEXT, memory_id TEXT);
    CREATE TABLE agent_memory_access_log (id TEXT);
    CREATE TABLE agent_triggers (id TEXT);
    CREATE TABLE agent_memory_metadata (id TEXT);
    CREATE TABLE agent_knowledge (id TEXT);
    INSERT INTO agent_trigger_refs VALUES ('trigger-1', 'memory-1');
    INSERT INTO agent_memory_access_log VALUES ('access-1');
    INSERT INTO agent_triggers VALUES ('trigger-1');
    INSERT INTO agent_memory_metadata VALUES ('memory-1');
    INSERT INTO agent_knowledge VALUES ('knowledge-1');

    CREATE TABLE skills_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      error TEXT
    );
    INSERT INTO skills_jobs (id, status, started_at)
    VALUES ('running-job', 'running', '2026-06-01T00:00:00.000Z');
    INSERT INTO skills_jobs (id, status) VALUES ('queued-job', 'queued');
    INSERT INTO skills_jobs (id, status, finished_at) VALUES (
      'finished-job', 'success', '2026-06-01T01:00:00.000Z'
    );

    CREATE TABLE codex_turn_bindings (
      ready_run_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE ready_model_gateway_exchange_events (
      event_sequence INTEGER PRIMARY KEY
    );
  `)

  __runMigrationForTests('113_ready_memory_truth', db as unknown as MigrationDatabase)

  const tables = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name GLOB 'ready_memory_*'
    ORDER BY name
  `).all() as Array<{ name: string }>
  assert.deepEqual(tables.map((row) => row.name), [
    'ready_memory_entries',
    'ready_memory_jobs',
    'ready_memory_policies',
    'ready_memory_sources',
  ])

  for (const tableName of tables.map((row) => row.name)) {
    const table = db.prepare(`SELECT strict FROM pragma_table_list WHERE name = ?`).get(tableName) as {
      strict: number
    }
    assert.equal(table.strict, 1, `${tableName} must be STRICT`)
  }

  const indexes = new Set((db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name GLOB 'idx_ready_memory_*'
  `).all() as Array<{ name: string }>).map((row) => row.name))
  for (const expected of [
    'idx_ready_memory_sources_conversation',
    'idx_ready_memory_entries_snapshot',
    'idx_ready_memory_entries_expiry',
    'idx_ready_memory_jobs_claim',
    'idx_ready_memory_jobs_lease_expiry',
    'idx_ready_memory_policy_conversation',
  ]) assert.ok(indexes.has(expected), `missing ${expected}`)

  const policy = db.prepare(`
    SELECT use_memories, generate_memories, state_revision, revocation_revision
    FROM ready_memory_policies WHERE policy_key = 'global'
  `).get() as Record<string, number>
  assert.deepEqual(policy, {
    use_memories: 1,
    generate_memories: 0,
    state_revision: 1,
    revocation_revision: 0,
  })

  for (const tableName of [
    'agent_trigger_refs',
    'agent_memory_access_log',
    'agent_triggers',
    'agent_memory_metadata',
    'agent_knowledge',
  ]) {
    const count = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }
    assert.equal(count.count, 0, `${tableName} must be cleared`)
  }

  const retired = db.prepare(`
    SELECT id, status, finished_at, error FROM skills_jobs ORDER BY id
  `).all() as Array<{ id: string; status: string; finished_at: string | null; error: string | null }>
  assert.equal(retired.find((row) => row.id === 'running-job')?.status, 'failed')
  assert.equal(retired.find((row) => row.id === 'queued-job')?.status, 'failed')
  assert.match(retired.find((row) => row.id === 'running-job')?.error || '', /retired_workflow/)
  assert.equal(retired.find((row) => row.id === 'finished-job')?.status, 'success')

  const turnColumns = new Set((db.prepare('PRAGMA table_info(codex_turn_bindings)').all() as Array<{
    name: string
  }>).map((column) => column.name))
  for (const name of [
    'ready_memory_snapshot_json',
    'ready_memory_snapshot_digest',
    'ready_memory_state_revision',
    'ready_memory_revocation_revision',
    'ready_memory_read_receipt_json',
    'ready_memory_read_receipt_digest',
  ]) assert.ok(turnColumns.has(name), `missing ${name}`)

  const gatewayColumns = new Set((db.prepare(
    'PRAGMA table_info(ready_model_gateway_exchange_events)',
  ).all() as Array<{ name: string }>).map((column) => column.name))
  assert.ok(gatewayColumns.has('memory_history_redaction_digest'))
  assert.ok(gatewayColumns.has('memory_history_redacted_item_count'))
  db.prepare(`
    INSERT INTO ready_model_gateway_exchange_events (
      event_sequence, memory_history_redaction_digest, memory_history_redacted_item_count
    ) VALUES (1, ?, 3)
  `).run('a'.repeat(64))
  assert.throws(() => db.prepare(`
    INSERT INTO ready_model_gateway_exchange_events (
      event_sequence, memory_history_redaction_digest, memory_history_redacted_item_count
    ) VALUES (2, 'invalid', -1)
  `).run(), /CHECK constraint/)
})

test('migration 113 CHECK constraints reject malformed truth rows', (t) => {
  if (skipIfSqliteUnavailable(t, 'ready-memory migration constraints')) return
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())
  __runMigrationForTests('113_ready_memory_truth', db as unknown as MigrationDatabase)

  assert.throws(() => db.prepare(`
    INSERT INTO ready_memory_entries (
      entry_id, category, content, content_digest, origin, confidence, pinned,
      status, source_refs_json, state_revision, revocation_revision, created_at, updated_at
    ) VALUES ('bad', 'secret', 'x', ?, 'manual', 1, 0, 'active', '[]', 1, 0, ?, ?)
  `).run('a'.repeat(64), '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'), /CHECK constraint/)

  assert.throws(() => db.prepare(`
    INSERT INTO ready_memory_jobs (
      job_id, job_kind, source_id, input_digest, status, attempt_count, created_at, updated_at
    ) VALUES ('bad-job', 'extraction', NULL, ?, 'pending', 0, ?, ?)
  `).run('b'.repeat(64), '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z'), /CHECK constraint/)

  assert.throws(() => db.prepare(`
    UPDATE ready_memory_policies
    SET state_revision = 1, updated_at = '2026-08-20T00:00:01.000Z'
    WHERE policy_key = 'global'
  `).run(), /ready_memory_policy_revision_not_monotonic/)
})
