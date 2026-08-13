import assert from 'node:assert/strict'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database'
import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import {
  CodexToolActionJournal,
  CodexToolActionJournalError,
} from '../main/modules/agent-control/codex-runtime/codex-tool-action-journal'
import { digestCanonicalJson } from '../main/modules/agent-control/codex-runtime/codex-model-gateway-contract'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('native action journal makes pending, confirmed, absent, and unknown states durable and immutable', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex tool action journal')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE chat_conversations (id TEXT PRIMARY KEY);
      CREATE TABLE chat_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL);
      CREATE TABLE task_projections (
        task_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, scope_id TEXT NOT NULL, status TEXT NOT NULL
      );
    `)
    __runMigrationForTests('088_codex_runtime_bindings', db as unknown as MigrationDatabase)
    const journal = new CodexToolActionJournal(db as unknown as DatabaseConnection)
    const at = '2026-08-07T00:00:00.000Z'

    assert.deepEqual(await journal.begin({
      readyActionId: 'action-confirmed', actionIdentityDigest: 'identity-confirmed', at,
    }), { fresh: true })
    assert.equal((await journal.read('action-confirmed')).state, 'indeterminate')
    assert.deepEqual(await journal.begin({
      readyActionId: 'action-confirmed', actionIdentityDigest: 'identity-confirmed', at,
    }), { fresh: false })
    await assert.rejects(
      journal.begin({ readyActionId: 'action-confirmed', actionIdentityDigest: 'changed', at }),
      (error) => error instanceof CodexToolActionJournalError
        && error.code === 'tool_action_identity_conflict',
    )

    const output = createToolExecutionOutput('done', { data: { count: 1 } })
    const resultDigest = digestCanonicalJson(output)
    const committed = await journal.commit({
      readyActionId: 'action-confirmed',
      actionIdentityDigest: 'identity-confirmed',
      resultDigest,
      output,
      at,
    })
    assert.equal(committed.state, 'confirmed')
    assert.match(committed.receiptId, /^ready-tool-receipt-[a-f0-9]{64}$/)
    assert.deepEqual(await journal.commit({
      readyActionId: 'action-confirmed',
      actionIdentityDigest: 'identity-confirmed',
      resultDigest,
      output,
      at,
    }), committed)
    assert.deepEqual(await journal.read('action-confirmed'), committed)

    await journal.begin({
      readyActionId: 'action-absent', actionIdentityDigest: 'identity-absent', at,
    })
    journal.markProvenAbsent({
      readyActionId: 'action-absent',
      actionIdentityDigest: 'identity-absent',
      reason: 'domain_readback_proves_no_effect',
      evidenceDigest: 'absent-evidence',
      at,
    })
    assert.deepEqual(await journal.read('action-absent'), {
      state: 'proven_absent',
      reason: 'domain_readback_proves_no_effect',
      evidenceDigest: 'absent-evidence',
    })

    await journal.begin({
      readyActionId: 'action-unknown', actionIdentityDigest: 'identity-unknown', at,
    })
    journal.markIndeterminate({
      readyActionId: 'action-unknown',
      actionIdentityDigest: 'identity-unknown',
      reason: 'external_effect_not_readable',
      evidenceDigest: 'unknown-evidence',
      at,
    })
    assert.deepEqual(await journal.read('action-unknown'), {
      state: 'indeterminate',
      reason: 'external_effect_not_readable',
      evidenceDigest: 'unknown-evidence',
    })

    assert.throws(
      () => db.prepare(`DELETE FROM ready_tool_action_receipts WHERE ready_action_id = 'action-confirmed'`).run(),
      /ready_tool_action_receipt_delete_forbidden/,
    )
    assert.throws(
      () => db.prepare(`
        UPDATE ready_tool_action_receipts SET result_digest = 'forged'
         WHERE ready_action_id = 'action-confirmed'
      `).run(),
      /ready_tool_action_receipt_immutable/,
    )
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
})

test('migration 092 upgrades the legacy call-binding shape without rewriting old rows', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex tool bridge migration')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE codex_thread_bindings (
        thread_binding_id TEXT PRIMARY KEY,
        tool_surface_digest TEXT
      );
      CREATE TABLE codex_turn_bindings (
        ready_run_id TEXT PRIMARY KEY,
        authorization_snapshot_digest TEXT
      );
      CREATE TABLE codex_tool_call_bindings (
        codex_thread_id TEXT NOT NULL,
        codex_turn_id TEXT NOT NULL,
        codex_call_id TEXT NOT NULL,
        ready_run_id TEXT NOT NULL,
        ready_action_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_digest TEXT NOT NULL,
        turn_contract_digest TEXT NOT NULL,
        receipt_id TEXT,
        result_digest TEXT,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (codex_thread_id, codex_turn_id, codex_call_id)
      );
      INSERT INTO codex_tool_call_bindings VALUES (
        'thread-old', 'turn-old', 'call-old', 'run-old', 'action-old', 'tool-old',
        'args-old', 'turn-contract-old', NULL, NULL, 1, 'created', 'updated'
      );
    `)
    __runMigrationForTests('092_codex_tool_bridge', db as unknown as MigrationDatabase)
    const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`)
      .all().map((row) => (row as { name: string }).name)
    assert.ok(columns('codex_thread_bindings').includes('tool_surface_snapshot_digest'))
    assert.ok(columns('codex_turn_bindings').includes('authorization_snapshot_json'))
    assert.ok(columns('codex_turn_bindings').includes('product_budget_seed_json'))
    assert.ok(columns('codex_tool_call_bindings').includes('delivery_intent_at'))
    assert.equal(columns('codex_tool_call_bindings').includes('result_json'), false)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ready_tool_action_receipts`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_tool_call_bindings`)
      .get<{ count: number }>()?.count, 1)
    db.prepare(`
      INSERT INTO ready_tool_action_receipts (
        ready_action_id, action_identity_digest, state, receipt_id,
        result_digest, result_json, revision, created_at, updated_at
      ) VALUES ('action-confirmed', 'identity-confirmed', 'confirmed', 'receipt-confirmed',
        'digest-confirmed', '{"ok":true}', 1, 'created', 'updated')
    `).run()
    assert.throws(
      () => db.prepare(`
        UPDATE ready_tool_action_receipts SET result_json = '{"ok":false}'
         WHERE ready_action_id = 'action-confirmed'
      `).run(),
      /ready_tool_action_receipt_immutable/,
    )
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
})

test('migration 105 adds independent canonical tool response delivery attempts', async (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex tool response delivery attempt migration')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE codex_tool_call_bindings (
        codex_thread_id TEXT NOT NULL,
        codex_turn_id TEXT NOT NULL,
        codex_call_id TEXT NOT NULL,
        ready_action_id TEXT NOT NULL,
        receipt_id TEXT,
        result_digest TEXT,
        PRIMARY KEY (codex_thread_id, codex_turn_id, codex_call_id)
      );
    `)
    __runMigrationForTests(
      '105_codex_tool_response_delivery_attempts',
      db as unknown as MigrationDatabase,
    )
    const columns = db.prepare(`PRAGMA table_info(codex_tool_response_delivery_attempts)`)
      .all().map((row) => (row as { name: string }).name)
    assert.deepEqual(columns, [
      'attempt_id',
      'codex_thread_id',
      'codex_turn_id',
      'codex_call_id',
      'ready_action_id',
      'connection_epoch',
      'request_rpc_id',
      'tool_response_json',
      'tool_response_digest',
      'transport_write_confirmed_at',
      'created_at',
    ])
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM codex_tool_response_delivery_attempts`)
      .get<{ count: number }>()?.count, 0)
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
})
