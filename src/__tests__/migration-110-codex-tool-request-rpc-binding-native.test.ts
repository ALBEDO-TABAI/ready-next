import assert from 'node:assert/strict'
import test from 'node:test'

import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('migration 110 backfills canonical request RPC identities from calls and delivery attempts', (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex tool request RPC migration')) return
  const Database = loadSqliteAfterGuardForTest()
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE codex_tool_call_bindings (
        codex_thread_id TEXT NOT NULL,
        codex_turn_id TEXT NOT NULL,
        codex_call_id TEXT NOT NULL,
        ready_action_id TEXT NOT NULL,
        request_connection_epoch TEXT,
        request_rpc_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (codex_thread_id, codex_turn_id, codex_call_id)
      );
      CREATE TABLE codex_tool_response_delivery_attempts (
        attempt_id TEXT PRIMARY KEY,
        codex_thread_id TEXT NOT NULL,
        codex_turn_id TEXT NOT NULL,
        codex_call_id TEXT NOT NULL,
        ready_action_id TEXT NOT NULL,
        connection_epoch TEXT NOT NULL,
        request_rpc_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    db.prepare(`
      INSERT INTO codex_tool_call_bindings VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('thread-1', 'turn-1', 'call-1', 'action-1', 'epoch-1', ' 1 ', '2026-08-12T00:00:00.000Z')
    db.prepare(`
      INSERT INTO codex_tool_response_delivery_attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'attempt-1', 'thread-1', 'turn-1', 'call-1', 'action-1',
      'epoch-2', ' 99 ', '2026-08-12T00:00:01.000Z',
    )

    __runMigrationForTests(
      '110_codex_tool_request_rpc_binding',
      db as unknown as MigrationDatabase,
    )

    assert.deepEqual(db.prepare(`
      SELECT connection_epoch, request_rpc_id, codex_call_id
        FROM codex_tool_request_rpc_bindings
       ORDER BY connection_epoch
    `).all(), [
      { connection_epoch: 'epoch-1', request_rpc_id: '1', codex_call_id: 'call-1' },
      { connection_epoch: 'epoch-2', request_rpc_id: '99', codex_call_id: 'call-1' },
    ])
    assert.throws(() => db.prepare(`
      INSERT INTO codex_tool_request_rpc_bindings (
        connection_epoch, request_rpc_id, codex_thread_id, codex_turn_id,
        codex_call_id, ready_action_id, created_at
      ) VALUES ('epoch-1', '1', 'thread-1', 'turn-1', 'call-1', 'action-1', 'later')
    `).run(), /UNIQUE constraint failed/)
    assert.throws(() => db.prepare(`
      DELETE FROM codex_tool_request_rpc_bindings
       WHERE connection_epoch = 'epoch-1' AND request_rpc_id = '1'
    `).run(), /codex_tool_request_rpc_binding_delete_forbidden/)
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
})
