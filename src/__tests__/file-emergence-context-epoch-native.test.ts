import assert from 'node:assert/strict'
import test from 'node:test'

import type { DatabaseConnection } from '../main/modules/database'
import {
  listCurrentVisibleTaskProjections,
} from '../main/modules/file-emergence/current-visible-task-projections'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('file emergence ignores task hints from a reset-visible old epoch', async (t) => {
  if (skipIfSqliteUnavailable(t, 'file emergence context epoch')) return
  const Database = (await import('better-sqlite3')).default
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE chat_conversations (
        id TEXT PRIMARY KEY,
        closed_at TEXT,
        message_visibility_epoch INTEGER NOT NULL
      );
      CREATE TABLE task_projections (
        task_id TEXT PRIMARY KEY,
        scope_id TEXT,
        message_visibility_epoch INTEGER NOT NULL,
        status TEXT NOT NULL,
        task_title TEXT,
        expected_outputs_json TEXT,
        recent_artifacts_json TEXT,
        updated_at TEXT NOT NULL
      );
      INSERT INTO chat_conversations VALUES ('scope-1', NULL, 1);
    `)
    const insert = db.prepare(`
      INSERT INTO task_projections (
        task_id, scope_id, message_visibility_epoch, status, task_title,
        expected_outputs_json, recent_artifacts_json, updated_at
      ) VALUES (?, ?, ?, 'running', ?, ?, '[]', ?)
    `)
    insert.run(
      'task-old',
      'scope-1',
      0,
      'old reset task',
      JSON.stringify(['/workspace/old.txt']),
      '2026-08-12T00:00:00.000Z',
    )
    insert.run(
      'task-current',
      'scope-1',
      1,
      'current task',
      JSON.stringify(['/workspace/current.txt']),
      '2026-08-12T00:01:00.000Z',
    )
    insert.run(
      'task-global',
      null,
      -1,
      'global task',
      JSON.stringify(['/workspace/global.txt']),
      '2026-08-12T00:02:00.000Z',
    )

    const hints = listCurrentVisibleTaskProjections(
      db as unknown as DatabaseConnection,
      100,
    )
    assert.deepEqual(
      hints.map((hint) => hint.title).sort(),
      ['current task', 'global task'],
    )
    assert.equal(hints.some((hint) => hint.taskId === 'task-old'), false)
  } finally {
    db.close()
  }
})
