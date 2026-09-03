import assert from 'node:assert/strict'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database'
import { CodexToolActionJournal } from '../main/modules/agent-control/codex-runtime/codex-tool-action-journal'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('closeout closes effect authority and terminalizes every pending bound action', (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex product effect closeout')) return
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())
  db.exec(`
    CREATE TABLE codex_turn_bindings (
      ready_run_id TEXT PRIMARY KEY, effect_authority_closed_at TEXT,
      product_terminal_digest TEXT, host_failure_product_terminal_digest TEXT,
      revision INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE codex_tool_call_bindings (ready_run_id TEXT, ready_action_id TEXT);
    CREATE TABLE codex_product_effect_bindings (ready_run_id TEXT, effect_action_id TEXT);
    CREATE TABLE ready_tool_action_receipts (
      ready_action_id TEXT PRIMARY KEY, action_identity_digest TEXT NOT NULL,
      state TEXT NOT NULL, receipt_id TEXT, result_digest TEXT, result_json TEXT,
      resolution_reason TEXT, resolution_evidence_digest TEXT,
      revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `)
  const at = '2026-09-02T01:00:00.000Z'
  db.prepare(`INSERT INTO codex_turn_bindings VALUES ('run-1', NULL, NULL, NULL, 1, ?)`)
    .run(at)
  db.prepare(`INSERT INTO codex_tool_call_bindings VALUES ('run-1', 'action-1')`).run()
  db.prepare(`
    INSERT INTO ready_tool_action_receipts VALUES (
      'action-1', 'identity-1', 'pending', NULL, NULL, NULL, NULL, NULL, 1, ?, ?
    )
  `).run(at, at)
  const journal = new CodexToolActionJournal(db as unknown as DatabaseConnection)
  const settled = journal.settleProductEffectsForCloseout({ readyRunId: 'run-1', closeoutAt: at })
  assert.equal(settled.length, 1)
  assert.equal(settled[0].state, 'indeterminate')
  assert.equal(db.prepare(`
    SELECT effect_authority_closed_at FROM codex_turn_bindings WHERE ready_run_id = 'run-1'
  `).get<{ effect_authority_closed_at: string }>()?.effect_authority_closed_at, at)
  assert.deepEqual(journal.settleProductEffectsForCloseout({ readyRunId: 'run-1', closeoutAt: at }), settled)
})
