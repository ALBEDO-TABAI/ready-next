import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { __runMigrationForTests } from '../main/modules/migrations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

const requireFromHere = createRequire(import.meta.url)

test('migration 066 backfills only unambiguous owners and persists conversation active agent', (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-task-agent-binding real sqlite')) return
  const mod = requireFromHere('better-sqlite3') as { default?: new (path: string) => any } | (new (path: string) => any)
  const Sqlite = 'default' in mod && mod.default ? mod.default : mod
  const db = new Sqlite(':memory:')
  try {
    db.exec(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, merged_into_agent_id TEXT
      );
      CREATE TABLE chat_conversations (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL
      );
      CREATE TABLE task_projections (
        task_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, owner_agent_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE run_meta (run_id TEXT PRIMARY KEY);
      INSERT INTO agents VALUES
        ('butler', 'active', NULL),
        ('analyst', 'active', NULL),
        ('old-analyst', 'merged', 'analyst'),
        ('disabled-agent', 'disabled', NULL);
      INSERT INTO chat_conversations VALUES
        ('c-main', 'butler'),
        ('c-specialist', 'analyst'),
        ('c-merged', 'old-analyst'),
        ('c-disabled', 'disabled-agent'),
        ('c-handoff', 'butler');
      INSERT INTO task_projections VALUES
        ('t-main', 'c-main', NULL, '1', '1'),
        ('t-specialist', 'c-specialist', NULL, '1', '1'),
        ('t-merged', 'c-merged', NULL, '1', '1'),
        ('t-disabled', 'c-disabled', NULL, '1', '1'),
        ('t-before-handoff', 'c-handoff', NULL, '1', '1'),
        ('t-handoff', 'c-handoff', 'analyst', '2', '2');
    `)

    __runMigrationForTests('066_agent_foundation_identity_binding', db)

    const conversations = db.prepare('SELECT id, active_agent_id, handoff_generation FROM chat_conversations ORDER BY id').all()
    assert.deepEqual(conversations, [
      { id: 'c-disabled', active_agent_id: 'butler', handoff_generation: 0 },
      { id: 'c-handoff', active_agent_id: 'analyst', handoff_generation: 0 },
      { id: 'c-main', active_agent_id: 'butler', handoff_generation: 0 },
      { id: 'c-merged', active_agent_id: 'analyst', handoff_generation: 0 },
      { id: 'c-specialist', active_agent_id: 'analyst', handoff_generation: 0 },
    ])
    const tasks = db.prepare('SELECT task_id, owner_agent_id, task_origin FROM task_projections ORDER BY task_id').all()
    assert.deepEqual(tasks, [
      { task_id: 't-before-handoff', owner_agent_id: null, task_origin: 'legacy' },
      { task_id: 't-disabled', owner_agent_id: 'butler', task_origin: 'legacy' },
      { task_id: 't-handoff', owner_agent_id: 'analyst', task_origin: 'legacy' },
      { task_id: 't-main', owner_agent_id: 'butler', task_origin: 'legacy' },
      { task_id: 't-merged', owner_agent_id: 'analyst', task_origin: 'legacy' },
      { task_id: 't-specialist', owner_agent_id: 'analyst', task_origin: 'legacy' },
    ])
  } finally {
    db.close()
  }
})
