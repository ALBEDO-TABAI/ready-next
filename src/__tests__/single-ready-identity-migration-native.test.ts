import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('migration 112 removes all old conversations and preserves only the Ready identity', async (t) => {
  if (skipIfSqliteUnavailable(t, 'single Ready identity migration')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')

  db.exec(`
    CREATE TABLE chat_conversations (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      active_agent_id TEXT,
      handoff_generation INTEGER NOT NULL DEFAULT 0,
      source_kind TEXT NOT NULL DEFAULT 'local',
      source_id TEXT NOT NULL DEFAULT 'app',
      thread_key TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL);
    CREATE VIRTUAL TABLE chat_messages_fts USING fts5(
      message_id UNINDEXED,
      conversation_id UNINDEXED,
      content
    );
    CREATE TABLE session_recall_attachment_index (attachment_key TEXT PRIMARY KEY, conversation_id TEXT NOT NULL);
    CREATE TABLE session_recall_vectors (conversation_id TEXT PRIMARY KEY);
    CREATE TABLE session_recall_metadata (conversation_id TEXT PRIMARY KEY, agent TEXT);
    CREATE TABLE agent_channel_threads (id TEXT PRIMARY KEY, conversation_id TEXT);
    CREATE TABLE codex_thread_bindings (
      thread_binding_id TEXT PRIMARY KEY,
      ready_scope_id TEXT NOT NULL,
      codex_thread_id TEXT,
      codex_session_id TEXT,
      isolated_thread_cwd TEXT,
      ready_conversation_alias TEXT NOT NULL,
      alias_generation INTEGER NOT NULL,
      retired_at TEXT,
      retired_reason TEXT,
      retirement_evidence_digest TEXT,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE codex_thread_dispatch_fences (thread_binding_id TEXT PRIMARY KEY);
    CREATE TABLE codex_turn_bindings (
      thread_binding_id TEXT NOT NULL,
      turn_start_reservation_released_at TEXT,
      product_terminal_digest TEXT,
      host_failure_product_terminal_digest TEXT
    );
    CREATE TABLE task_projections (task_id TEXT PRIMARY KEY, owner_agent_id TEXT, scope_id TEXT);
    CREATE TABLE run_meta (run_id TEXT PRIMARY KEY, agent_id TEXT, scope_id TEXT);
    CREATE TABLE skill_task_runs (
      id TEXT PRIMARY KEY, agent TEXT, scope_id TEXT, updated_at TEXT NOT NULL DEFAULT 'before'
    );
    CREATE TABLE thread_meta (thread_id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL);
    CREATE TABLE specialist_blueprint_confirmations (token_id TEXT PRIMARY KEY);
    CREATE TABLE specialist_blueprints (blueprint_id TEXT PRIMARY KEY);
    CREATE TABLE specialist_content_edit_proposals (proposal_id TEXT PRIMARY KEY);
    CREATE TABLE agent_personalities (id TEXT PRIMARY KEY, agent_name TEXT NOT NULL);
    CREATE TABLE agent_knowledge (id TEXT PRIMARY KEY, agent_name TEXT NOT NULL);
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      parent_agent_id TEXT,
      derivation_reason TEXT,
      merged_into_agent_id TEXT
    );

    INSERT INTO chat_conversations (id, agent, active_agent_id, handoff_generation, thread_key)
      VALUES ('ready-scope', 'butler', 'analyst', 3, 'ready-scope');
    INSERT INTO chat_conversations (id, agent, active_agent_id, handoff_generation, thread_key)
      VALUES ('writer-scope', 'copywriter', 'copywriter', 0, 'writer-scope');
    INSERT INTO chat_conversations (id, agent, active_agent_id, handoff_generation, thread_key)
      VALUES ('analyst-scope', 'analyst', 'analyst', 0, 'analyst-scope');
    INSERT INTO chat_messages VALUES ('ready-message', 'ready-scope');
    INSERT INTO chat_messages VALUES ('writer-message', 'writer-scope');
    INSERT INTO chat_messages_fts VALUES ('writer-message', 'writer-scope', 'old specialist text');
    INSERT INTO session_recall_attachment_index VALUES ('writer-attachment', 'writer-scope');
    INSERT INTO session_recall_vectors VALUES ('writer-scope');
    INSERT INTO session_recall_metadata VALUES ('ready-scope', 'analyst');
    INSERT INTO session_recall_metadata VALUES ('writer-scope', 'copywriter');
    INSERT INTO agent_channel_threads VALUES ('remote-thread', 'writer-scope');
    INSERT INTO codex_thread_bindings VALUES (
      'ready-binding', 'ready-scope', 'ready-thread', 'ready-session', '/tmp/ready-thread',
      'ready-scope', 1, NULL, NULL, NULL, 1, 'before'
    );
    INSERT INTO codex_thread_bindings VALUES (
      'writer-binding', 'writer-scope', 'writer-thread', 'writer-session', '/tmp/writer-thread',
      'writer-scope', 1, NULL, NULL, NULL, 1, 'before'
    );
    INSERT INTO codex_thread_dispatch_fences VALUES ('writer-binding');
    INSERT INTO codex_turn_bindings VALUES ('writer-binding', NULL, NULL, NULL);
    INSERT INTO task_projections VALUES ('task', 'analyst', NULL);
    INSERT INTO run_meta VALUES ('run', 'copywriter', NULL);
    INSERT INTO skill_task_runs VALUES ('skill-run', 'operator', NULL, 'before');
    INSERT INTO thread_meta VALUES ('thread', 'agent', 'video-editor');
    INSERT INTO specialist_blueprint_confirmations VALUES ('confirmation');
    INSERT INTO specialist_blueprints VALUES ('blueprint');
    INSERT INTO specialist_content_edit_proposals VALUES ('proposal');
    INSERT INTO agent_personalities VALUES ('ready-personality', 'butler');
    INSERT INTO agent_personalities VALUES ('writer-personality', 'copywriter');
    INSERT INTO agent_knowledge VALUES ('system-knowledge', 'system');
    INSERT INTO agent_knowledge VALUES ('writer-knowledge', 'copywriter');
    INSERT INTO agents VALUES ('butler', '管家', 'active', NULL, NULL, NULL);
    INSERT INTO agents VALUES ('copywriter', '文案', 'active', 'butler', 'old', NULL);
  `)

  const { applyCodexThreadRetirementCleanupMigration } = await import(
    '../main/modules/agent-control/codex-runtime/codex-thread-retirement-cleanup-migration'
  )
  assert.doesNotThrow(() => applyCodexThreadRetirementCleanupMigration(db as never))
  db.exec(`
    INSERT INTO chat_conversations (
      id, agent, active_agent_id, handoff_generation,
      source_kind, source_id, thread_key, message_visibility_epoch
    ) VALUES ('closed-scope', 'butler', 'butler', 0, 'local', 'app', 'closed-scope', 0);
    INSERT INTO chat_messages (id, conversation_id, message_visibility_epoch)
      VALUES ('closed-message', 'closed-scope', 0);
    UPDATE chat_conversations
       SET closed_at = '2026-08-20T00:00:00.000Z', closed_reason = 'closed',
           close_evidence_digest = '${'c'.repeat(64)}'
     WHERE id = 'closed-scope';
  `)

  const { __runMigrationForTests } = await import('../main/modules/migrations')
  const runCleanupMigration = () => {
    db.exec('BEGIN')
    try {
      __runMigrationForTests('112_single_ready_identity_cleanup', db as never)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  runCleanupMigration()
  runCleanupMigration()

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_conversations').get().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM chat_messages_fts').get().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM session_recall_attachment_index').get().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM session_recall_vectors').get().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM session_recall_metadata').get().count, 0)
  assert.equal(db.prepare('SELECT conversation_id FROM agent_channel_threads').get().conversation_id, null)

  const retired = db.prepare(`
    SELECT retired_reason, retirement_evidence_digest, revision
    FROM codex_thread_bindings WHERE thread_binding_id = 'writer-binding'
  `).get()
  assert.equal(retired.retired_reason, 'cleanup')
  assert.match(retired.retirement_evidence_digest, /^[a-f0-9]{64}$/)
  assert.equal(retired.revision, 2)
  assert.notEqual(db.prepare(`SELECT retired_at FROM codex_thread_bindings WHERE thread_binding_id = 'ready-binding'`).get().retired_at, null)
  assert.deepEqual(
    db.prepare('SELECT thread_binding_id, state FROM codex_thread_archive_intents ORDER BY thread_binding_id').all(),
    [
      { thread_binding_id: 'ready-binding', state: 'pending' },
      { thread_binding_id: 'writer-binding', state: 'pending' },
    ],
  )
  assert.equal(db.prepare(`
    SELECT COUNT(*) AS count FROM codex_thread_archive_intents
    WHERE thread_binding_id = 'writer-binding' AND source_kind = 'retired_backfill'
  `).get().count, 1, 'cleanup must not orphan a retired native thread behind stale run state')

  assert.equal(db.prepare('SELECT owner_agent_id FROM task_projections').get().owner_agent_id, 'analyst')
  assert.equal(db.prepare('SELECT agent_id FROM run_meta').get().agent_id, 'copywriter')
  assert.equal(db.prepare('SELECT agent FROM skill_task_runs').get().agent, 'operator')
  assert.equal(db.prepare('SELECT owner_id FROM thread_meta').get().owner_id, 'video-editor')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM specialist_blueprints').get().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM specialist_blueprint_confirmations').get().count, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM specialist_content_edit_proposals').get().count, 0)
  assert.deepEqual(db.prepare('SELECT agent_name FROM agent_personalities').all(), [{ agent_name: 'butler' }])
  assert.deepEqual(db.prepare('SELECT agent_name FROM agent_knowledge').all(), [{ agent_name: 'system' }])
  assert.deepEqual(db.prepare('SELECT id, name, status FROM agents').all(), [
    { id: 'butler', name: 'Ready', status: 'active' },
  ])

  db.exec(`
    INSERT INTO chat_conversations (
      id, agent, active_agent_id, handoff_generation,
      source_kind, source_id, thread_key, message_visibility_epoch
    ) VALUES ('guard-scope', 'butler', 'butler', 0, 'local', 'app', 'guard-scope', 0);
    INSERT INTO chat_messages (id, conversation_id, message_visibility_epoch)
      VALUES ('guard-message', 'guard-scope', 0);
    UPDATE chat_conversations
       SET closed_at = '2026-08-20T00:01:00.000Z', closed_reason = 'closed',
           close_evidence_digest = '${'d'.repeat(64)}'
     WHERE id = 'guard-scope';
  `)
  assert.throws(() => db.exec(`DELETE FROM chat_messages WHERE id = 'guard-message'`), /chat_message_closed_scope/)
  assert.throws(() => db.exec(`DELETE FROM chat_conversations WHERE id = 'guard-scope'`), /chat_conversation_closed_delete/)

  db.close()
})
