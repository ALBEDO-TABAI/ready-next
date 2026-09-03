import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  __runMigrationForTests,
  runMigrations,
  type MigrationDatabase,
} from '../main/modules/migrations'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { CodexBindingRepository } from '../main/modules/agent-control/codex-runtime/codex-binding-repository'
import { projectCodexHeadActionProjection } from '../main/modules/agent-control/codex-runtime/codex-action-surface'
import type { DatabaseConnection } from '../main/modules/database'
import { applyCodexGatewayCompletionEvidenceMigration } from '../main/modules/agent-control/codex-runtime/codex-binding-schema'

const historicalSchema = readFileSync(new URL('./fixtures/ready-pre118-schema.sql', import.meta.url), 'utf8')
const upgradedGatewaySchema = readFileSync(new URL('./fixtures/ready-upgraded-pre118-gateway.sql', import.meta.url), 'utf8')

// Only the referenced receipt identity is needed by this table migration.
// The captured table schema and synthetic events contain no real user content.
function createPopulatedLegacyGateway(db: GuardDb): void {
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE ready_model_gateway_request_receipts (receipt_id TEXT PRIMARY KEY);
    INSERT INTO ready_model_gateway_request_receipts VALUES ('old'), ('known'), ('next');
    ${upgradedGatewaySchema}
    CREATE UNIQUE INDEX idx_ready_gateway_exchange_terminal
      ON ready_model_gateway_exchange_events(gateway_request_receipt_id)
      WHERE event_kind = 'response_completed';
    INSERT INTO ready_model_gateway_exchange_events (
      gateway_request_receipt_id, event_kind, instruction_digest, input_digest,
      input_items_json, input_total_string_characters, input_max_string_characters,
      tools_digest, tool_count, body_bytes, evidence_digest, recorded_at,
      memory_history_redaction_digest, memory_history_redacted_item_count
    ) VALUES
      ('old', 'request_admitted', 'instructions', 'input', '[]', 0, 0, 'tools', 0, 2, 'old-evidence', 'before-memory', NULL, NULL),
      ('known', 'request_admitted', 'instructions', 'input', '[]', 0, 0, 'tools', 0, 2, 'known-evidence', 'after-memory', '${'a'.repeat(64)}', 0);
    INSERT INTO ready_model_gateway_exchange_events (
      gateway_request_receipt_id, event_kind, response_id, terminal_digest,
      output_digest, usage_digest, evidence_digest, recorded_at
    ) VALUES ('known', 'response_completed', 'response', 'terminal', 'output', 'usage', 'completed-evidence', 'completed');
  `)
}

test('gateway migration preserves populated historical unknown evidence and requires complete new evidence', (t) => {
  if (skipIfSqliteUnavailable(t, 'populated gateway upgrade')) return
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())
  createPopulatedLegacyGateway(db)
  const columns = db.prepare('PRAGMA table_info(ready_model_gateway_exchange_events)')
    .all<{ name: string }>().map((row) => row.name).join(', ')
  const read = () => db.prepare(`SELECT ${columns} FROM ready_model_gateway_exchange_events ORDER BY event_sequence`).all()
  const before = read()
  db.transaction(() => applyCodexGatewayCompletionEvidenceMigration(db))()
  assert.deepEqual(read(), before, 'historical values, identifiers and evidence digests remain exact')
  db.transaction(() => applyCodexGatewayCompletionEvidenceMigration(db))()
  assert.deepEqual(read(), before)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  const append = db.prepare(`INSERT INTO ready_model_gateway_exchange_events (
    gateway_request_receipt_id, event_kind, instruction_digest, input_digest,
    input_items_json, input_total_string_characters, input_max_string_characters,
    tools_digest, tool_count, body_bytes, evidence_digest, recorded_at,
    memory_history_redaction_digest, memory_history_redacted_item_count
  ) VALUES ('next', 'request_admitted', 'instructions', 'input', '[]', 0, 0, 'tools', 0, 2, 'next-evidence', 'now', ?, ?)`)
  for (const [digest, count] of [[null, null], [null, 0], ['a'.repeat(64), null], ['a'.repeat(64), 0.5]]) {
    assert.throws(() => append.run(digest, count), /ready_model_gateway_exchange_redaction_required/)
  }
  assert.doesNotThrow(() => append.run('a'.repeat(64), 0))
  assert.throws(() => db.exec(`INSERT INTO ready_model_gateway_exchange_events (
    gateway_request_receipt_id, event_kind, failure_json, failure_digest, evidence_digest, recorded_at
  ) VALUES ('known', 'response_failed', '{}', '${'b'.repeat(64)}', 'second-terminal', 'now')`),
  /UNIQUE constraint failed: ready_model_gateway_exchange_events.gateway_request_receipt_id/)
  assert.throws(() => db.exec("UPDATE ready_model_gateway_exchange_events SET recorded_at = 'changed'"), /immutable/)
  assert.throws(() => db.exec('DELETE FROM ready_model_gateway_exchange_events'), /immutable/)
})

test('gateway migration rolls back populated history when final guard installation fails', (t) => {
  if (skipIfSqliteUnavailable(t, 'populated gateway rollback')) return
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())
  createPopulatedLegacyGateway(db)
  const before = db.prepare('SELECT * FROM ready_model_gateway_exchange_events ORDER BY event_sequence').all()
  const schema = db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE '%gateway%' ORDER BY name").all()
  assert.throws(() => db.transaction(() => applyCodexGatewayCompletionEvidenceMigration({
    prepare: db.prepare.bind(db),
    exec(sql) {
      if (sql.includes('CREATE TRIGGER IF NOT EXISTS ready_model_gateway_exchange_redaction_insert')) {
        throw new Error('injected_gateway_guard_failure')
      }
      db.exec(sql)
    },
  }))(), /injected_gateway_guard_failure/)
  assert.deepEqual(db.prepare('SELECT * FROM ready_model_gateway_exchange_events ORDER BY event_sequence').all(), before)
  assert.deepEqual(db.prepare("SELECT name, sql FROM sqlite_master WHERE name LIKE '%gateway%' ORDER BY name").all(), schema)
})

test('migration 119 installs the same new-write guard for already-upgraded databases', (t) => {
  if (skipIfSqliteUnavailable(t, 'gateway guard cutover')) return
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())
  runMigrations(db as unknown as MigrationDatabase)
  const before = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ready_model_gateway_exchange_redaction_insert'").get()
  const beforeIndex = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_ready_gateway_exchange_terminal'").get()
  assert.ok(before)
  assert.ok(beforeIndex)
  db.exec(`DROP TRIGGER ready_model_gateway_exchange_redaction_insert;
    DROP INDEX idx_ready_gateway_exchange_terminal;
    DELETE FROM migrations WHERE name = '119_gateway_exchange_redaction_admission_guard';`)
  runMigrations(db as unknown as MigrationDatabase)
  assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ready_model_gateway_exchange_redaction_insert'").get(), before)
  assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_ready_gateway_exchange_terminal'").get(), beforeIndex)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM migrations WHERE name = '119_gateway_exchange_redaction_admission_guard'").get<{ n: number }>()?.n, 1)
})

test('migration 118 is idempotent and installs continuity owner tables and guards', (t) => {
  if (skipIfSqliteUnavailable(t, 'migration 118 native continuity')) return
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())
  db.exec(historicalSchema)
  const historicalLedger = db.prepare('SELECT name FROM migrations ORDER BY id').all<{ name: string }>()
  assert.equal(historicalLedger.length, 115)
  assert.equal(historicalLedger.at(-1)?.name, '115_interrupt_retired_execution_scopes')
  assert.equal(historicalLedger.some((row) => row.name.startsWith('118_')), false)
  assert.deepEqual(db.prepare('SELECT id, name FROM agents ORDER BY id').all(), [{ id: 'butler', name: 'Ready' }])
  assert.deepEqual(db.prepare('SELECT root FROM workspaces').all(), [{ root: '@shared' }])
  assert.deepEqual(db.prepare('SELECT policy_key, use_memories, generate_memories FROM ready_memory_policies').all(),
    [{ policy_key: 'global', use_memories: 1, generate_memories: 0 }])
  const oldThreadColumns = db.prepare('PRAGMA table_info(codex_thread_bindings)').all<{ name: string }>()
  assert.equal(oldThreadColumns.some((row) => row.name === 'thread_materialization_kind'), false)
  assert.equal(oldThreadColumns.some((row) => row.name === 'native_inherited_contract_digest'), false)
  const oldTurnColumns = db.prepare('PRAGMA table_info(codex_turn_bindings)').all<{ name: string }>()
  assert.equal(oldTurnColumns.some((row) => row.name.startsWith('terminal_facts')), false)
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'ready_model_gateway_exchange_events'")
    .get<{ sql: string }>()?.sql.includes('response_failed'), false)
  const legacy = {
    threadBindingId: 'legacy-binding',
    aliasId: 'legacy-alias',
    scopeId: 'legacy-scope',
    createdAt: '2026-09-01T00:00:00.000Z',
  }
  db.prepare(`
    INSERT INTO codex_thread_bindings (
      thread_binding_id, ready_conversation_alias, alias_generation, ready_scope_id,
      runtime_manifest_digest, protocol_schema_digest, revision, created_at, updated_at
    ) VALUES (?, ?, 1, ?, 'runtime', 'protocol', 1, ?, ?)
  `).run(legacy.threadBindingId, legacy.aliasId, legacy.scopeId, legacy.createdAt, legacy.createdAt)

  runMigrations(db as unknown as MigrationDatabase)
  __runMigrationForTests(
    '118_codex_native_continuity_terminal_head_v3',
    db as unknown as MigrationDatabase,
  )
  assert.deepEqual(db.prepare('SELECT name FROM migrations WHERE id <= 115 ORDER BY id').all(), historicalLedger)
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM migrations WHERE name = '118_codex_native_continuity_terminal_head_v3'")
    .get<{ count: number }>()?.count, 1)

  const tables = new Set(db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all<{ name: string }>().map((row) => row.name))
  assert.equal(tables.has('codex_native_coverage_receipts'), true)
  assert.equal(tables.has('codex_product_effect_bindings'), true)
  const turnColumns = new Set(db.prepare('PRAGMA table_info(codex_turn_bindings)')
    .all<{ name: string }>().map((row) => row.name))
  assert.equal(turnColumns.has('terminal_facts_digest'), true)
  assert.equal(turnColumns.has('accepted_native_coverage_receipt_id'), true)
  assert.equal(turnColumns.has('effect_authority_closed_at'), true)
  const threadColumns = new Set(db.prepare('PRAGMA table_info(codex_thread_bindings)')
    .all<{ name: string }>().map((row) => row.name))
  assert.equal(threadColumns.has('source_accepted_native_coverage_receipt_id'), true)
  assert.deepEqual(db.prepare(`
    SELECT ready_conversation_alias, thread_materialization_kind
      FROM codex_thread_bindings WHERE thread_binding_id = ?
  `).get(legacy.threadBindingId), {
    ready_conversation_alias: legacy.aliasId,
    thread_materialization_kind: 'legacy',
  })
  const guards = new Set(db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'trigger'
  `).all<{ name: string }>().map((row) => row.name))
  assert.equal(guards.has('codex_native_coverage_no_delete'), true)
  assert.equal(guards.has('codex_product_effect_no_delete'), true)
  assert.equal(guards.has('codex_turn_coverage_ref_update'), true)

  const clean = new Sqlite(':memory:')
  t.after(() => clean.close())
  clean.exec('PRAGMA foreign_keys = ON')
  runMigrations(clean as unknown as MigrationDatabase)
  for (const table of [
    'codex_thread_bindings',
    'codex_turn_bindings',
    'codex_product_effect_bindings',
    'codex_native_coverage_receipts',
    'ready_model_gateway_exchange_events',
  ]) {
    const upgradedColumns = db.prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>().map((row) => row.name)
    const cleanColumns = clean.prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>().map((row) => row.name)
    assert.deepEqual(
      [...upgradedColumns].sort(),
      [...cleanColumns].sort(),
      `${table} columns must match clean schema`,
    )
    const indexSignature = (database: typeof db) => database.prepare(`PRAGMA index_list(${table})`)
      .all<{ name: string; unique: number; partial: number }>()
      .map((index) => ({
        name: index.name,
        unique: index.unique,
        partial: index.partial,
        columns: database.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`)
          .all<{ seqno: number; name: string }>()
          .sort((left, right) => left.seqno - right.seqno)
          .map((column) => column.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
    assert.deepEqual(
      indexSignature(db),
      indexSignature(clean),
      `${table} indexes must match clean schema`,
    )
  }
  const triggerSignature = (database: typeof db) => database.prepare(`
    SELECT name, tbl_name, sql FROM sqlite_master
     WHERE type = 'trigger'
       AND tbl_name IN (
         'codex_thread_bindings', 'codex_turn_bindings',
         'codex_product_effect_bindings', 'codex_native_coverage_receipts',
         'ready_model_gateway_exchange_events'
       )
     ORDER BY name
  `).all<{ name: string; tbl_name: string; sql: string }>().map((row) => ({
    name: row.name,
    table: row.tbl_name,
    sql: row.sql.replace(/\s+/g, ' ').trim(),
  }))
  assert.deepEqual(
    triggerSignature(db),
    triggerSignature(clean),
    'migration 118 triggers must match clean schema',
  )
})

const guardAt = '2026-09-01T00:00:00.000Z'
const guardThread = {
  thread_binding_id: 'guard-thread', ready_conversation_alias: 'guard-alias',
  alias_generation: 1, ready_scope_id: 'guard-scope', runtime_manifest_digest: 'runtime',
  protocol_schema_digest: 'protocol', thread_materialization_kind: 'fresh_start',
  revision: 1, created_at: guardAt, updated_at: guardAt,
}
const guardTurn = {
  ready_run_id: 'guard-run', ready_task_id: 'guard-task', thread_binding_id: 'guard-thread',
  start_reservation_set_id: 'guard-set', start_reservation_required_member_count: 1,
  turn_start_reservation_member_id: 'guard-member', turn_start_reservation_admitted_at: guardAt,
  turn_request_id: 'guard-request', origin_user_message_id: 'guard-message',
  ingress_admitted_revision: 1, ingress_admitted_digest: 'ingress-digest', ingress_admitted_at: guardAt,
  attempt_kind: 'user_ingress', tool_surface_digest: 'tools', authorization_snapshot_digest: 'authorization',
  authorization_snapshot_json: '{}', product_budget_seed_json: '{}', effective_codex_model: 'model',
  effective_upstream_snapshot_ref: 'profile', effective_upstream_snapshot_digest: 'profile-digest',
  additional_context_digest: 'context', turn_contract_digest: 'contract', ingress_json: '{}',
  revision: 1, created_at: guardAt, updated_at: guardAt,
}

type GuardDb = InstanceType<ReturnType<typeof loadSqliteAfterGuardForTest>>
function insertGuardRow(db: GuardDb, table: string, row: Record<string, string | number>): void {
  db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(', ')})
    VALUES (${Object.keys(row).map(() => '?').join(', ')})`).run(...Object.values(row))
}

const rejectedInserts: Array<{ name: string; table: string; values: Record<string, string | number> }> = [
  { name: 'native fork without source and accepted-prefix seed', table: 'codex_thread_bindings',
    values: { ...guardThread, thread_materialization_kind: 'native_fork' } },
  { name: 'thread request digest without dispatch identity', table: 'codex_thread_bindings',
    values: { ...guardThread, thread_start_request_digest: 'a'.repeat(64) } },
  { name: 'turn request digest without dispatch identity', table: 'codex_turn_bindings',
    values: { ...guardTurn, turn_start_request_digest: 'a'.repeat(64) } },
  { name: 'unpaired terminal native readback digest', table: 'codex_turn_bindings',
    values: { ...guardTurn, terminal_native_readback_receipt_digest: 'a'.repeat(64) } },
  { name: 'unpaired terminal facts JSON', table: 'codex_turn_bindings',
    values: { ...guardTurn, terminal_facts_json: '{}' } },
  { name: 'non-object terminal native readback', table: 'codex_turn_bindings',
    values: { ...guardTurn, terminal_native_readback_receipt_json: '[]',
      terminal_native_readback_receipt_digest: 'a'.repeat(64), terminal_native_readback_revision: 1,
      terminal_facts_json: '{}', terminal_facts_digest: 'b'.repeat(64) } },
  { name: 'non-SHA terminal facts digest', table: 'codex_turn_bindings',
    values: { ...guardTurn, terminal_native_readback_receipt_json: '{}',
      terminal_native_readback_receipt_digest: 'a'.repeat(64), terminal_native_readback_revision: 1,
      terminal_facts_json: '{}', terminal_facts_digest: 'invalid-digest' } },
]

for (const scenario of rejectedInserts) {
  test(`fresh and genuine pre-118 upgrade reject ${scenario.name}`, (t) => {
    if (skipIfSqliteUnavailable(t, 'migration 118 insert guard parity')) return
    const Sqlite = loadSqliteAfterGuardForTest()
    for (const origin of ['fresh', 'upgraded'] as const) {
      const db = new Sqlite(':memory:')
      try {
        if (origin === 'upgraded') db.exec(historicalSchema)
        db.pragma('foreign_keys = ON')
        runMigrations(db as unknown as MigrationDatabase)
        if (scenario.table === 'codex_turn_bindings') insertGuardRow(db, 'codex_thread_bindings', guardThread)
        assert.throws(() => insertGuardRow(db, scenario.table, scenario.values),
          undefined, `${origin}: ${scenario.name} must not be admitted`)
      } finally { db.close() }
    }
  })
}

for (const kind of ['thread', 'turn'] as const) {
  test(`fresh and genuine pre-118 upgrade freeze the dispatched ${kind} request digest`, (t) => {
    if (skipIfSqliteUnavailable(t, 'migration 118 immutable dispatch digest parity')) return
    const Sqlite = loadSqliteAfterGuardForTest()
    const table = `codex_${kind}_bindings`
    const column = `${kind}_start_request_digest`
    const dispatched = {
      [`${kind}_start_dispatch_intent_at`]: guardAt,
      [`${kind}_start_rpc_connection_epoch`]: 'guard-epoch',
      [`${kind}_start_rpc_id`]: 1,
      [column]: 'a'.repeat(64),
    }
    for (const origin of ['fresh', 'upgraded'] as const) {
      const db = new Sqlite(':memory:')
      try {
        if (origin === 'upgraded') db.exec(historicalSchema)
        db.pragma('foreign_keys = ON')
        runMigrations(db as unknown as MigrationDatabase)
        if (kind === 'turn') insertGuardRow(db, 'codex_thread_bindings', guardThread)
        insertGuardRow(db, table, { ...(kind === 'thread' ? guardThread : guardTurn), ...dispatched })
        assert.throws(() => db.prepare(`UPDATE ${table} SET ${column} = ?`).run('b'.repeat(64)),
          undefined, `${origin}: ${kind} dispatched request digest must be immutable`)
        assert.equal(db.prepare(`SELECT ${column} AS digest FROM ${table}`).get<{ digest: string }>()?.digest,
          'a'.repeat(64))
      } finally { db.close() }
    }
  })
}

test('genuine pre-118 dispatched rows retain unknown digests while lifecycle cleanup remains possible', (t) => {
  if (skipIfSqliteUnavailable(t, 'migration 118 historical dispatched digest preservation')) return
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())
  db.exec(historicalSchema)
  db.prepare(`INSERT INTO chat_conversations (id, agent, title, created_at, updated_at,
    source_kind, source_id, thread_key, meta_json, active_agent_id, handoff_generation,
    message_visibility_epoch) VALUES ('guard-scope', 'butler', 'old scope', ?, ?,
    'local', 'app', 'guard-scope', '{}', 'butler', 0, 0)`).run(guardAt, guardAt)
  const { thread_materialization_kind: _newKind, ...historicalThread } = guardThread
  insertGuardRow(db, 'codex_thread_bindings', {
    ...historicalThread,
    thread_start_reservation_set_id: 'old-thread-set', thread_start_reservation_member_id: 'old-thread-member',
    thread_start_reservation_admitted_at: guardAt, thread_start_request_id: 'old-thread-request',
    isolated_thread_cwd: '/tmp/old-guard-thread', tool_surface_digest: 'tools',
    tool_surface_snapshot_digest: 'tool-snapshot', tool_surface_json: '{}', instruction_contract_digest: 'instructions',
    codex_model_provider_id: 'ready_gateway', codex_model: 'model',
    upstream_profile_snapshot_ref: 'profile', upstream_profile_snapshot_digest: 'profile-digest',
    thread_start_dispatch_intent_at: guardAt, thread_start_rpc_connection_epoch: 'old-epoch', thread_start_rpc_id: 1,
    codex_thread_id: 'old-native-thread', codex_session_id: 'old-native-thread',
    thread_start_reconciled_at: guardAt, thread_start_reconciliation_evidence_digest: 'old-readback',
    thread_started_at: guardAt, thread_start_response_at: guardAt,
    thread_start_reservation_released_at: guardAt, thread_start_reservation_release_reason: 'native_identity_reconciled',
  })
  insertGuardRow(db, 'codex_turn_bindings', {
    ...guardTurn, codex_thread_id: 'old-native-thread',
    ingress_json: '{"prepared":{"preparationContract":"codex_product_run_e1"}}',
    turn_start_dispatch_intent_at: guardAt, turn_start_rpc_connection_epoch: 'old-epoch', turn_start_rpc_id: 2,
  })
  const historicalRows = ['codex_thread_bindings', 'codex_turn_bindings'].map((table) => ({
    table, rows: db.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>(),
  }))
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db as unknown as MigrationDatabase)
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  for (const { table, rows } of historicalRows) {
    const current = db.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>()
    assert.equal(current.length, rows.length)
    for (const [index, old] of rows.entries()) {
      for (const [key, value] of Object.entries(old)) assert.equal(current[index][key], value, `${table}.${key}`)
    }
  }
  const repository = new CodexBindingRepository(db as unknown as DatabaseConnection)
  const head = projectCodexHeadActionProjection(repository.readHeadActionFacts({
    aliasId: 'guard-alias', aliasGeneration: 1, currentRuntimeManifestDigest: 'runtime', currentProtocolSchemaDigest: 'protocol',
  }))
  assert.equal(head.actions.send_new_message.availability, 'blocked')
  assert.ok(head.actions.send_new_message.blockers.includes('legacy_prepared_contract'))
  assert.doesNotThrow(() => db.prepare('UPDATE codex_turn_bindings SET interrupt_requested_at = ?').run(guardAt))
  assert.doesNotThrow(() => db.prepare(`UPDATE codex_thread_bindings SET retired_at = ?,
    retired_reason = 'user_reset', retirement_evidence_digest = ?`).run(guardAt, 'b'.repeat(64)))
  for (const kind of ['thread', 'turn'] as const) {
    const table = `codex_${kind}_bindings`
    const column = `${kind}_start_request_digest`
    assert.equal(db.prepare(`SELECT ${column} AS digest FROM ${table}`).get<{ digest: string | null }>()?.digest, null)
    assert.throws(() => db.prepare(`UPDATE ${table} SET ${column} = ?`).run('a'.repeat(64)),
      undefined, `old ${kind} dispatch must not gain invented request evidence`)
  }
  assert.equal(db.prepare('SELECT thread_start_request_digest AS digest FROM codex_thread_bindings').get<{ digest: null }>()?.digest, null)
  assert.equal(db.prepare('SELECT turn_start_request_digest AS digest FROM codex_turn_bindings').get<{ digest: null }>()?.digest, null)
})

test('migration 118 restores the old thread table and foreign keys if post-copy guard installation fails', (t) => {
  if (skipIfSqliteUnavailable(t, 'pristine migration rollback')) return
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())
  db.exec(historicalSchema)
  const { thread_materialization_kind: _newKind, ...historicalThread } = guardThread
  insertGuardRow(db, 'codex_thread_bindings', historicalThread)
  const oldSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'codex_thread_bindings'").get()
  const oldRows = db.prepare('SELECT * FROM codex_thread_bindings').all()
  db.exec('PRAGMA foreign_keys = ON')
  assert.throws(() => runMigrations({
    exec(sql: string) {
      if (sql.includes('CREATE TRIGGER IF NOT EXISTS codex_pristine_contract_refresh_insert')) {
        throw new Error('injected_post_copy_failure')
      }
      db.exec(sql)
    },
    prepare: db.prepare.bind(db),
  } as unknown as MigrationDatabase), /injected_post_copy_failure/)
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
  assert.deepEqual(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'codex_thread_bindings'").get(), oldSql)
  assert.deepEqual(db.prepare('SELECT * FROM codex_thread_bindings').all(), oldRows)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM migrations WHERE name LIKE '118_%'").get<{ n: number }>()?.n, 0)
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'codex_thread_bindings%'").all(), [])
  runMigrations(db as unknown as MigrationDatabase)
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
  assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'codex_thread_bindings'")
    .get<{ sql: string }>()?.sql.includes("'pristine_contract_refresh'"))
})
