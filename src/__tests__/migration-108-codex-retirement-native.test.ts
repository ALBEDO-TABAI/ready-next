import assert from 'node:assert/strict'
import test from 'node:test'

import {
  __getMigrationNamesForTests,
  __runMigrationForTests,
  runMigrations,
  type MigrationDatabase,
} from '../main/modules/migrations'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

type NativeDb = import('better-sqlite3').Database

const MIGRATION_108 = '108_codex_thread_retirement_cleanup'
const NOW = '2026-08-12T00:00:00.000Z'

type ScheduleShape = 'neither' | 'tasks_only' | 'occurrences_only' | 'both'

function applyMigrationWithMarker(db: NativeDb, name: string): void {
  db.exec('BEGIN')
  try {
    __runMigrationForTests(name, db as unknown as MigrationDatabase)
    db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(name, NOW)
    db.exec('COMMIT')
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK')
    throw error
  }
}

function migrateThrough107(db: NativeDb): void {
  db.exec(`
    CREATE TABLE migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `)
  for (const name of __getMigrationNamesForTests()) {
    if (name === MIGRATION_108) break
    applyMigrationWithMarker(db, name)
  }
}

function freezeRealPre108CodexTurnShape(db: NativeDb): void {
  const immutableTrigger = db.prepare(`
    SELECT sql FROM sqlite_master
     WHERE type = 'trigger' AND name = 'codex_turn_binding_immutable_update'
  `).get<{ sql: string }>()?.sql
  assert.ok(immutableTrigger, 'migration 088 created the turn immutability trigger')
  const visibilityClause = /\n\s+OR NEW\.message_visibility_epoch IS NOT OLD\.message_visibility_epoch/
  assert.match(immutableTrigger, visibilityClause)

  db.exec('DROP TRIGGER codex_turn_binding_immutable_update')
  db.exec('ALTER TABLE codex_turn_bindings DROP COLUMN message_visibility_epoch')
  db.exec(immutableTrigger.replace(visibilityClause, ''))

  const columns = db.prepare('PRAGMA table_info(codex_turn_bindings)')
    .all<{ name: string }>()
    .map((column) => column.name)
  assert.equal(columns.includes('message_visibility_epoch'), false)
}

function insertEvolvedCodexRows(db: NativeDb): void {
  db.prepare(`
    INSERT INTO codex_thread_bindings (
      thread_binding_id, ready_conversation_alias, alias_generation, ready_scope_id,
      runtime_manifest_digest, protocol_schema_digest, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'thread-binding-upgrade',
    'scope-upgrade',
    7,
    'scope-upgrade',
    'runtime-manifest-107',
    'protocol-schema-107',
    3,
    NOW,
    NOW,
  )
  db.prepare(`
    INSERT INTO codex_turn_bindings (
      ready_run_id, ready_task_id, thread_binding_id,
      start_reservation_set_id, start_reservation_required_member_count,
      turn_start_reservation_member_id, turn_start_reservation_admitted_at,
      turn_request_id, recovery_failure_code, recovery_failure_evidence_digest,
      recovery_failure_recorded_at, origin_user_message_id,
      ingress_admitted_revision, ingress_admitted_digest, ingress_admitted_at,
      attempt_kind, tool_surface_digest, authorization_snapshot_digest,
      authorization_snapshot_json, product_budget_seed_json, effective_codex_model,
      effective_upstream_snapshot_ref, effective_upstream_snapshot_digest,
      additional_context_digest, turn_contract_digest, ingress_json,
      lifecycle_action, lifecycle_action_requested_at, lifecycle_action_evidence_digest,
      revision, created_at, updated_at, gateway_claimed_codex_turn_id
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    'run-upgrade',
    'task-upgrade',
    'thread-binding-upgrade',
    'reservation-set-upgrade',
    1,
    'reservation-member-upgrade',
    NOW,
    'turn-request-upgrade',
    'publication_diverged',
    'b'.repeat(64),
    NOW,
    'message-upgrade',
    4,
    'ingress-admitted-digest-107',
    NOW,
    'user_ingress',
    'tool-surface-digest-107',
    'authorization-snapshot-digest-107',
    '{"mode":"none"}',
    '{"maxIterations":8,"maxToolCalls":4,"maxParallelToolGroups":1}',
    'ready-e0-model',
    'snapshot-ref-107',
    'snapshot-digest-107',
    'additional-context-digest-107',
    'turn-contract-digest-107',
    '{"kind":"user_ingress","source":"pre108"}',
    'stop',
    NOW,
    'c'.repeat(64),
    5,
    NOW,
    NOW,
    'gateway-turn-claim-107',
  )
  db.prepare(`
    INSERT INTO codex_browser_verifier_attempts (
      attempt_id, ready_run_id, ready_task_id, ready_scope_id, ready_alias_id,
      alias_generation, thread_binding_id, codex_thread_id, codex_turn_id,
      candidate_digest, frozen_identity_digest, upstream_profile_snapshot_ref,
      upstream_profile_snapshot_digest, workflow_closeout_seal_digest,
      status, dispatched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'verifier-attempt-upgrade',
    'run-upgrade',
    'task-upgrade',
    'scope-upgrade',
    'scope-upgrade',
    7,
    'thread-binding-upgrade',
    'native-thread-upgrade',
    'native-turn-upgrade',
    'd'.repeat(64),
    'e'.repeat(64),
    'snapshot-ref-107',
    'f'.repeat(64),
    'a'.repeat(64),
    'dispatching',
    NOW,
  )
}

function configureScheduleShape(db: NativeDb, shape: ScheduleShape): void {
  const occurrenceSql = db.prepare(`
    SELECT sql FROM sqlite_master
     WHERE type = 'table' AND name = 'agent_schedule_occurrences'
  `).get<{ sql: string }>()?.sql
  assert.ok(occurrenceSql, 'migration 073 created the occurrence table before migration 108')

  db.pragma('foreign_keys = OFF')
  if (shape === 'neither' || shape === 'tasks_only' || shape === 'occurrences_only') {
    db.exec('DROP TABLE agent_schedule_occurrences')
  }
  if (shape === 'neither' || shape === 'occurrences_only') {
    db.exec('DROP TABLE scheduled_tasks')
  }
  if (shape === 'occurrences_only') {
    db.exec(occurrenceSql.replace(
      'schedule_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE RESTRICT',
      'schedule_id TEXT NOT NULL',
    ))
  }

  if (shape === 'tasks_only' || shape === 'both') {
    db.prepare(`
      INSERT INTO scheduled_tasks (
        id, name, instruction, schedule_spec_json, timezone, agent_id,
        enabled, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      `schedule-${shape}`,
      'legacy schedule',
      'legacy instruction',
      '{"kind":"interval","intervalMinutes":10}',
      'Asia/Singapore',
      'ready',
      '2026-08-12T01:00:00.000Z',
      NOW,
      NOW,
    )
  }
  if (shape === 'occurrences_only' || shape === 'both') {
    db.prepare(`
      INSERT INTO agent_schedule_occurrences (
        id, schedule_id, scheduled_for, triggered_at, trigger_source,
        trigger_source_key, claim_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'timer', ?, 'dispatching', ?, ?)
    `).run(
      `occurrence-${shape}`,
      `schedule-${shape}`,
      '2026-08-12T01:00:00.000Z',
      '2026-08-12T01:00:01.000Z',
      `source-${shape}`,
      NOW,
      NOW,
    )
  }
}

function sqliteObjects(db: NativeDb, tables: readonly string[]): Array<Record<string, unknown>> {
  const placeholders = tables.map(() => '?').join(', ')
  return db.prepare(`
    SELECT type, name, tbl_name, sql
      FROM sqlite_master
     WHERE type IN ('index', 'trigger') AND tbl_name IN (${placeholders})
       AND sql IS NOT NULL
     ORDER BY type, name
  `).all(...tables) as Array<Record<string, unknown>>
}

function assertScheduleRetired(db: NativeDb, shape: ScheduleShape): void {
  if (shape === 'tasks_only' || shape === 'both') {
    assert.deepEqual(db.prepare(`
      SELECT enabled, next_run_at FROM scheduled_tasks WHERE id = ?
    `).get(`schedule-${shape}`), { enabled: 0, next_run_at: null })
  }
  if (shape === 'occurrences_only' || shape === 'both') {
    const row = db.prepare(`
      SELECT claim_status, finished_at, error_kind, error_message
        FROM agent_schedule_occurrences WHERE id = ?
    `).get<Record<string, unknown>>(`occurrence-${shape}`)
    assert.equal(row?.claim_status, 'dispatch_failed')
    assert.equal(typeof row?.finished_at, 'string')
    assert.equal(row?.error_kind, 'feature_retired')
    assert.match(String(row?.error_message), /retired/i)
  }
}

test('migration 108 preserves a real evolved 107 schema and retires every partial schedule shape', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration 108 real 107 upgrade')) return
  const Database = loadSqliteAfterGuardForTest()
  const shapes: ScheduleShape[] = ['neither', 'tasks_only', 'occurrences_only', 'both']

  for (const [shapeIndex, shape] of shapes.entries()) {
    for (const foreignKeys of [false, true]) {
      const db = new Database(':memory:')
      try {
        migrateThrough107(db)
        freezeRealPre108CodexTurnShape(db)
        insertEvolvedCodexRows(db)
        configureScheduleShape(db, shape)

        db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
        db.pragma(`legacy_alter_table = ${shapeIndex % 2 === 0 ? 'ON' : 'OFF'}`)
        const foreignKeysBefore = Number(db.pragma('foreign_keys', { simple: true }))
        const legacyAlterBefore = Number(db.pragma('legacy_alter_table', { simple: true }))

        const parentColumnsBefore = db.prepare('PRAGMA table_info(codex_turn_bindings)')
          .all<{ name: string }>()
        const parentColumnNamesBefore = parentColumnsBefore.map((column) => column.name)
        assert.equal(parentColumnNamesBefore.includes('message_visibility_epoch'), false)
        const parentSqlBefore = db.prepare(`
          SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_turn_bindings'
        `).get<{ sql: string }>()?.sql
        const parentRowBefore = db.prepare(`
          SELECT * FROM codex_turn_bindings WHERE ready_run_id = 'run-upgrade'
        `).get()
        const childSqlBefore = db.prepare(`
          SELECT sql FROM sqlite_master
           WHERE type = 'table' AND name = 'codex_browser_verifier_attempts'
        `).get<{ sql: string }>()?.sql
        const childRowBefore = db.prepare(`
          SELECT * FROM codex_browser_verifier_attempts
           WHERE attempt_id = 'verifier-attempt-upgrade'
        `).get()
        const childFksBefore = db.prepare(
          'PRAGMA foreign_key_list(codex_browser_verifier_attempts)',
        ).all()
        assert.ok(childFksBefore.some((row) => (
          row as { table?: string }
        ).table === 'codex_turn_bindings'))
        const objectsBefore = sqliteObjects(db, [
          'codex_turn_bindings',
          'codex_tool_group_admissions',
          'codex_tool_call_admissions',
          'codex_browser_verifier_attempts',
        ])

        applyMigrationWithMarker(db, MIGRATION_108)

        const parentColumnsAfter = db.prepare('PRAGMA table_info(codex_turn_bindings)')
          .all<{ name: string }>()
        assert.deepEqual(
          parentColumnsAfter.slice(0, parentColumnsBefore.length),
          parentColumnsBefore,
          `${shape}/fk=${foreignKeys}: evolved parent columns changed`,
        )
        assert.equal(parentColumnsAfter.length, parentColumnsBefore.length + 1)
        assert.equal(parentColumnsAfter.at(-1)?.name, 'message_visibility_epoch')
        assert.doesNotMatch(parentSqlBefore || '', /message_visibility_epoch/)
        assert.match(db.prepare(`
          SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'codex_turn_bindings'
        `).get<{ sql: string }>()?.sql || '', /message_visibility_epoch/)
        const parentRowAfter = db.prepare(`
          SELECT * FROM codex_turn_bindings WHERE ready_run_id = 'run-upgrade'
        `).get<Record<string, unknown>>()
        assert.ok(parentRowAfter)
        for (const [column, value] of Object.entries(parentRowBefore as Record<string, unknown>)) {
          assert.deepEqual(parentRowAfter[column], value, `${shape}/fk=${foreignKeys}: changed ${column}`)
        }
        assert.equal(parentRowAfter.message_visibility_epoch, 0)
        assert.equal(db.prepare(`
          SELECT sql FROM sqlite_master
           WHERE type = 'table' AND name = 'codex_browser_verifier_attempts'
        `).get<{ sql: string }>()?.sql, childSqlBefore)
        assert.deepEqual(db.prepare(`
          SELECT * FROM codex_browser_verifier_attempts
           WHERE attempt_id = 'verifier-attempt-upgrade'
        `).get(), childRowBefore)
        assert.deepEqual(
          db.prepare('PRAGMA foreign_key_list(codex_browser_verifier_attempts)').all(),
          childFksBefore,
        )
        const objectsAfter = sqliteObjects(db, [
          'codex_turn_bindings',
          'codex_tool_group_admissions',
          'codex_tool_call_admissions',
          'codex_browser_verifier_attempts',
        ])
        for (const object of objectsBefore) {
          assert.ok(objectsAfter.some((candidate) => (
            candidate.type === object.type
            && candidate.name === object.name
            && candidate.tbl_name === object.tbl_name
            && candidate.sql === object.sql
          )), `${shape}/fk=${foreignKeys}: lost ${String(object.type)} ${String(object.name)}`)
        }

        assertScheduleRetired(db, shape)
        assert.equal(Number(db.pragma('foreign_keys', { simple: true })), foreignKeysBefore)
        assert.equal(Number(db.pragma('legacy_alter_table', { simple: true })), legacyAlterBefore)
        assert.deepEqual(db.pragma('foreign_key_check'), [])
        assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count FROM migrations WHERE name = ?
        `).get<{ count: number }>(MIGRATION_108)?.count, 1)

        const retiredState = {
          schedule: shape === 'tasks_only' || shape === 'both'
            ? db.prepare('SELECT * FROM scheduled_tasks').all()
            : null,
          occurrences: shape === 'occurrences_only' || shape === 'both'
            ? db.prepare('SELECT * FROM agent_schedule_occurrences').all()
            : null,
        }
        runMigrations(db as unknown as MigrationDatabase)
        db.exec('BEGIN')
        try {
          __runMigrationForTests(MIGRATION_108, db as unknown as MigrationDatabase)
          db.exec('COMMIT')
        } catch (error) {
          if (db.inTransaction) db.exec('ROLLBACK')
          throw error
        }
        assert.deepEqual({
          schedule: shape === 'tasks_only' || shape === 'both'
            ? db.prepare('SELECT * FROM scheduled_tasks').all()
            : null,
          occurrences: shape === 'occurrences_only' || shape === 'both'
            ? db.prepare('SELECT * FROM agent_schedule_occurrences').all()
            : null,
        }, retiredState, `${shape}/fk=${foreignKeys}: second migration changed retired rows`)
        assert.equal(db.prepare(`
          SELECT COUNT(*) AS count FROM migrations WHERE name = ?
        `).get<{ count: number }>(MIGRATION_108)?.count, 1)
        assert.deepEqual(db.pragma('foreign_key_check'), [])
        assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
      } finally {
        db.close()
      }
    }
  }
})

test('migration 108 tolerates each legacy optional ledger being absent', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration 108 optional legacy ledgers')) return
  const Database = loadSqliteAfterGuardForTest()
  for (const missingTable of ['run_meta', 'skill_task_runs', 'pending_task_events']) {
    const db = new Database(':memory:')
    try {
      migrateThrough107(db)
      db.pragma('foreign_keys = OFF')
      db.exec(`DROP TABLE ${missingTable}`)
      db.pragma('foreign_keys = ON')

      applyMigrationWithMarker(db, MIGRATION_108)

      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count FROM migrations WHERE name = ?
      `).get<{ count: number }>(MIGRATION_108)?.count, 1)
      assert.deepEqual(db.pragma('foreign_key_check'), [])
      assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
    } finally {
      db.close()
    }
  }
})
