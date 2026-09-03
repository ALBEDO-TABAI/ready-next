import assert from 'node:assert/strict'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database'
import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import {
  markPetActivitySeen,
  markPetScopeTerminalActivitiesSeen,
  readPetActivityCutoverAt,
  readPetActivityMarker,
} from '../main/modules/pet/pet-activity-read-marker'
import { loadSqliteAfterGuardForTest, skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('pet attention marker accepts only exact terminal activity identity and direct scope view', (t) => {
  if (skipIfSqliteUnavailable(t, 'pet activity attention marker')) return
  const Database = loadSqliteAfterGuardForTest()
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE chat_conversations (
        id TEXT PRIMARY KEY,
        closed_at TEXT,
        message_visibility_epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        message_visibility_epoch INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE task_projections (
        task_id TEXT PRIMARY KEY,
        scope_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    __runMigrationForTests('116_pet_activity_read_marker', db as unknown as MigrationDatabase)
    __runMigrationForTests('117_pet_activity_attention_cutover', db as unknown as MigrationDatabase)
    const connection = db as unknown as DatabaseConnection
    const cutoverAt = readPetActivityCutoverAt(connection)
    assert.ok(cutoverAt)
    const terminalAt = new Date(Date.parse(cutoverAt as string) + 1_000).toISOString()

    db.prepare('INSERT INTO chat_conversations (id) VALUES (?)').run('scope-a')
    db.prepare(`
      INSERT INTO chat_messages (id, conversation_id, role, timestamp, message_visibility_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run('assistant-a', 'scope-a', 'assistant', terminalAt, 0)
    db.prepare(`
      INSERT INTO task_projections (task_id, scope_id, run_id, status, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('task-a', 'scope-a', 'run-a', 'failed', terminalAt)

    assert.equal(markPetActivitySeen(connection, {
      revision: 1,
      kind: 'blocked',
      taskId: 'task-a',
      scopeId: 'scope-a',
      runId: 'wrong-run',
      messageId: 'assistant-a',
      updatedAt: terminalAt,
    }), false)
    assert.deepEqual(readPetActivityMarker(connection, 'scope-a'), { messageId: null, seenAt: null })

    assert.equal(markPetActivitySeen(connection, {
      revision: 1,
      kind: 'blocked',
      taskId: 'task-a',
      scopeId: 'scope-a',
      runId: 'run-a',
      messageId: 'assistant-a',
      updatedAt: terminalAt,
    }), true)
    assert.deepEqual(readPetActivityMarker(connection, 'scope-a'), {
      messageId: 'assistant-a',
      seenAt: terminalAt,
    })

    const secondTerminalAt = new Date(Date.parse(terminalAt) + 1_000).toISOString()
    db.prepare('INSERT INTO chat_conversations (id) VALUES (?)').run('scope-b')
    db.prepare(`
      INSERT INTO chat_messages (id, conversation_id, role, timestamp, message_visibility_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run('assistant-b', 'scope-b', 'assistant', secondTerminalAt, 0)
    db.prepare(`
      INSERT INTO task_projections (task_id, scope_id, run_id, status, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('task-b', 'scope-b', 'run-b', 'completed', secondTerminalAt)

    assert.equal(markPetScopeTerminalActivitiesSeen(connection, 'scope-b'), true)
    assert.deepEqual(readPetActivityMarker(connection, 'scope-b'), {
      messageId: 'assistant-b',
      seenAt: secondTerminalAt,
    })
    assert.deepEqual(readPetActivityMarker(connection, 'scope-a'), {
      messageId: 'assistant-a',
      seenAt: terminalAt,
    })
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok')
  } finally {
    db.close()
  }
})
