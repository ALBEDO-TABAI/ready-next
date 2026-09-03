import assert from 'node:assert/strict'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database'
import { CodexInteractionTransitionRepository } from '../main/modules/agent-control/codex-runtime/codex-interaction-transition-repository'
import { buildFrozenCallPendingSourceDigest } from '../main/modules/agent-control/safety/frozen-call-store'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('ask-card and linked confirmation settle in one durable transaction', (t) => {
  if (skipIfSqliteUnavailable(t, 'Codex interaction transition transaction')) return
  const Sqlite = loadSqliteAfterGuardForTest()
  const db = new Sqlite(':memory:')
  t.after(() => db.close())
  db.exec(`
    CREATE TABLE chat_conversations (
      id TEXT PRIMARY KEY, closed_at TEXT, message_visibility_epoch INTEGER NOT NULL
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, meta_json TEXT, message_visibility_epoch INTEGER NOT NULL
    );
    CREATE TABLE chat_messages_fts (
      message_id TEXT, conversation_id TEXT, content TEXT
    );
    CREATE TABLE pending_confirmations (
      id TEXT PRIMARY KEY, run_id TEXT, task_id TEXT, scope_id TEXT, tool_name TEXT NOT NULL,
      params_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      status TEXT NOT NULL, released_at TEXT
    );
  `)
  const createdAt = '2026-09-02T00:00:00.000Z'
  const expiresAt = '2026-09-02T00:10:00.000Z'
  const paramsJson = JSON.stringify({ __audit: 'redacted' })
  const ownerRef = {
    frozenCallId: 'frozen-1',
    pendingConfirmationSourceDigest: buildFrozenCallPendingSourceDigest({
      id: 'frozen-1',
      runId: 'run-1',
      taskId: 'task-1',
      scopeId: 'scope-1',
      toolName: 'dangerous_tool',
      paramsJson,
      createdAt,
      expiresAt,
    }),
  }
  db.prepare(`INSERT INTO chat_conversations VALUES ('scope-1', NULL, 0)`).run()
  db.prepare(`
    INSERT INTO pending_confirmations VALUES (
      'frozen-1', 'run-1', 'task-1', 'scope-1', 'dangerous_tool', ?, ?, ?, 'pending', NULL
    )
  `).run(paramsJson, createdAt, expiresAt)
  const pendingMeta = {
    askUserQuestions: {
      status: 'pending',
      requestId: 'run-1',
      actionConfirmationOwnerRef: ownerRef,
    },
  }
  db.prepare(`
    INSERT INTO chat_messages VALUES ('card-1', 'scope-1', 'agent_card', 'pending', ?, 0)
  `).run(JSON.stringify(pendingMeta))
  db.prepare(`INSERT INTO chat_messages_fts VALUES ('card-1', 'scope-1', 'pending')`).run()

  const repository = new CodexInteractionTransitionRepository(
    db as unknown as DatabaseConnection,
  )
  const submittedMeta = {
    askUserQuestions: {
      ...pendingMeta.askUserQuestions,
      status: 'submitted',
      answers: [{ id: 'confirm', answer: '确认执行' }],
      answeredAt: Date.parse('2026-09-02T00:01:00.000Z'),
    },
  }
  assert.equal(repository.transitionAskCard({
    messageId: 'card-1',
    meta: submittedMeta,
    content: 'confirmed',
  }), true)
  assert.deepEqual(db.prepare(`
    SELECT status, released_at FROM pending_confirmations WHERE id = 'frozen-1'
  `).get(), {
    status: 'released',
    released_at: '2026-09-02T00:01:00.000Z',
  })
  assert.deepEqual(db.prepare(`
    SELECT content, meta_json FROM chat_messages WHERE id = 'card-1'
  `).get(), { content: 'confirmed', meta_json: JSON.stringify(submittedMeta) })
  assert.deepEqual(db.prepare(`
    SELECT content FROM chat_messages_fts WHERE message_id = 'card-1'
  `).get(), { content: 'confirmed' })
  assert.throws(() => repository.transitionAskCard({
    messageId: 'card-1',
    meta: { askUserQuestions: { ...submittedMeta.askUserQuestions, status: 'cancelled' } },
  }), /action_confirmation_owner_ref_mismatch/)
  assert.equal(db.prepare(`
    SELECT status FROM pending_confirmations WHERE id = 'frozen-1'
  `).get<{ status: string }>()?.status, 'released')
})
