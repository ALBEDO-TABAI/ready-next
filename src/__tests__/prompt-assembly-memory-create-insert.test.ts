import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

// skill-resume G7 — agent_knowledge has `id PRIMARY KEY` + `agent_name NOT NULL`
// (migration 003); the legacy 3-column INSERT
//   `INSERT INTO agent_knowledge (key, value, created_at) VALUES (?, ?, ?)`
// silently failed every memory_create with a NOT NULL constraint error which
// createMemoryFromConversation's catch swallowed into "Failed to create
// memory". This test verifies the corrected 6-column INSERT against the real
// schema, mirroring the prompt-assembly fix.

type SqliteModule = new (path: string) => {
  exec: (sql: string) => void
  prepare: (sql: string) => {
    run: (...params: unknown[]) => { changes?: number }
    get: <T = unknown>(...params: unknown[]) => T | undefined
  }
  close: () => void
}

function loadSqlite(): SqliteModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('better-sqlite3') as SqliteModule
  } catch {
    return null
  }
}

function setupSchema(db: ReturnType<SqliteModule>) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_knowledge (
      id TEXT PRIMARY KEY,
      agent_name TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(agent_name, key)
    )
  `)
}

describe('skill-resume G7 — agent_knowledge INSERT covers all NOT NULL columns', () => {
  const Sqlite = loadSqlite()
  if (!Sqlite) {
    it('skill-resume G7: agent_knowledge INSERT (sqlite unavailable)', (t) => {
      skipIfSqliteUnavailable(t, 'prompt-assembly-memory-create-insert: bootstrap')
    })
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'ready-g7-'))
  const db = new Sqlite(join(dir, 't.sqlite'))
  setupSchema(db)

  after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('legacy 3-column INSERT throws NOT NULL constraint error (the bug)', (t) => {
    if (skipIfSqliteUnavailable(t, 'prompt-assembly-memory-create-insert: legacy INSERT bug')) return
    assert.throws(
      () => {
        db.prepare('INSERT INTO agent_knowledge (key, value, created_at) VALUES (?, ?, ?)').run(
          'memory-x',
          'content',
          Math.floor(Date.now() / 1000),
        )
      },
      /NOT NULL constraint failed/,
      'old INSERT must fail to confirm the bug we are fixing',
    )
  })

  it('new 6-column INSERT with id + agent_name succeeds', (t) => {
    if (skipIfSqliteUnavailable(t, 'prompt-assembly-memory-create-insert: 6-column INSERT')) return
    const stmt = db.prepare(
      `INSERT INTO agent_knowledge (id, agent_name, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    const result = stmt.run('kn-aaa-111', 'memory', 'memory-y', 'content body', 1700000000, 1700000000)
    assert.equal(result.changes, 1, 'one row inserted')

    const row = db
      .prepare('SELECT id, agent_name, key, value FROM agent_knowledge WHERE key = ?')
      .get<{ id: string; agent_name: string; key: string; value: string }>('memory-y')!
    assert.equal(row.id, 'kn-aaa-111')
    assert.equal(row.agent_name, 'memory')
    assert.equal(row.value, 'content body')
  })

  it('ON CONFLICT path updates value when (agent_name, key) collides', (t) => {
    if (skipIfSqliteUnavailable(t, 'prompt-assembly-memory-create-insert: ON CONFLICT path')) return
    const stmt = db.prepare(
      `INSERT INTO agent_knowledge (id, agent_name, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_name, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    stmt.run('kn-1', 'memory', 'collision-key', 'first', 1700000000, 1700000000)
    stmt.run('kn-2', 'memory', 'collision-key', 'second', 1700000001, 1700000001)
    const row = db
      .prepare('SELECT value FROM agent_knowledge WHERE agent_name = ? AND key = ?')
      .get<{ value: string }>('memory', 'collision-key')!
    assert.equal(row.value, 'second', 'value should be replaced on conflict')
  })
})
