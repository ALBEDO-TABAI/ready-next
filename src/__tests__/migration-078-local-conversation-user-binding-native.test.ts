import assert from 'node:assert/strict'
import test from 'node:test'

import { __runMigrationForTests, type MigrationDatabase } from '../main/modules/migrations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('migration 078 preserves remote and explicit bindings in real SQLite', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-078 local conversation user binding')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE chat_conversations (
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        user_id TEXT
      );
      INSERT INTO chat_conversations (id, source_kind, user_id) VALUES
        ('local-null', 'local', NULL),
        ('local-empty', 'local', ''),
        ('local-blank', 'local', '   '),
        ('local-bound', 'local', 'another-user'),
        ('remote-null', 'channel', NULL),
        ('remote-empty', 'channel', ''),
        ('remote-bound', 'channel', 'remote-user');
    `)

    __runMigrationForTests('078_backfill_local_conversation_default_user', db as unknown as MigrationDatabase)
    __runMigrationForTests('078_backfill_local_conversation_default_user', db as unknown as MigrationDatabase)

    const rows = db.prepare(
      'SELECT id, source_kind, user_id FROM chat_conversations ORDER BY id',
    ).all() as Array<{ id: string; source_kind: string; user_id: string | null }>
    assert.deepEqual(rows, [
      { id: 'local-blank', source_kind: 'local', user_id: 'default-user' },
      { id: 'local-bound', source_kind: 'local', user_id: 'another-user' },
      { id: 'local-empty', source_kind: 'local', user_id: 'default-user' },
      { id: 'local-null', source_kind: 'local', user_id: 'default-user' },
      { id: 'remote-bound', source_kind: 'channel', user_id: 'remote-user' },
      { id: 'remote-empty', source_kind: 'channel', user_id: '' },
      { id: 'remote-null', source_kind: 'channel', user_id: null },
    ])
  } finally {
    db.close()
  }
})
