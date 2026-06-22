import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import { BUILTIN_AGENT_IDS, BUILTIN_AGENT_META } from '../shared/agent-identity'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

type SqliteModule = new (path: string, options?: { readonly?: boolean }) => {
  exec: (sql: string) => void
  prepare: (sql: string) => {
    run: (...params: unknown[]) => { changes?: number }
    get: <T = unknown>(...params: unknown[]) => T | undefined
    all: <T = unknown>(...params: unknown[]) => T[]
  }
  close: () => void
}

const require = createRequire(import.meta.url)

function loadSqlite(): SqliteModule | null {
  try {
    return require('better-sqlite3') as SqliteModule
  } catch {
    return null
  }
}

function openInMemory(): MigrationDatabase {
  const Sqlite = loadSqlite()!
  return new Sqlite(':memory:') as unknown as MigrationDatabase
}

test('agent identity migration creates 1:1 built-in agent rows', (t) => {
  if (skipIfSqliteUnavailable(t, 'agent identity built-in migration')) return
  if (!loadSqlite()) return
  const db = openInMemory()

  try {
    runMigrations(db)
    const rows = db.prepare(`
      SELECT a.id, a.name, a.status, a.persona_ref, p.agent_name
      FROM agents a
      LEFT JOIN agent_personalities p ON p.agent_name = a.id
      WHERE a.id IN ('butler', 'copywriter', 'video-editor', 'analyst')
      ORDER BY a.id
    `).all<{ id: string; name: string; status: string; persona_ref: string | null; agent_name: string | null }>()

    assert.deepEqual(rows.map((row) => row.id), [...BUILTIN_AGENT_IDS].sort())
    for (const row of rows) {
      assert.equal(row.status, 'active')
      assert.equal(row.persona_ref, row.id)
      assert.equal(row.agent_name, row.id)
      assert.equal(row.name, BUILTIN_AGENT_META[row.id as keyof typeof BUILTIN_AGENT_META].displayName)
    }
  } finally {
    ;(db as unknown as { close?: () => void }).close?.()
  }
})

test('agent identity migration reassigns a reserved slug conflict without resurrecting it', (t) => {
  if (skipIfSqliteUnavailable(t, 'agent identity conflict migration')) return
  if (!loadSqlite()) return
  const db = openInMemory()

  try {
    runMigrations(db)
    db.prepare(`
      UPDATE agents
      SET name = '葵老板',
          status = 'retired',
          parent_agent_id = 'butler',
          derivation_reason = 'blueprint:bp-copywriter',
          persona_ref = NULL
      WHERE id = 'copywriter'
    `).run()
    db.prepare("DELETE FROM migrations WHERE name = '064_agent_identity_unification'").run()

    runMigrations(db)

    const builtin = db.prepare("SELECT id, name, status, persona_ref FROM agents WHERE id = 'copywriter'")
      .get<{ id: string; name: string; status: string; persona_ref: string }>()
    const reassigned = db.prepare("SELECT id, name, status, parent_agent_id, persona_ref FROM agents WHERE id = 'copywriter-custom'")
      .get<{ id: string; name: string; status: string; parent_agent_id: string; persona_ref: string }>()
    const ledger = db.prepare("SELECT old_agent_id, new_agent_id FROM agent_identity_migration WHERE old_agent_id = 'copywriter'")
      .get<{ old_agent_id: string; new_agent_id: string }>()

    assert.deepEqual(builtin, {
      id: 'copywriter',
      name: '文案',
      status: 'active',
      persona_ref: 'copywriter',
    })
    assert.equal(reassigned?.id, 'copywriter-custom')
    assert.equal(reassigned?.name, '葵老板')
    assert.equal(reassigned?.status, 'disabled')
    assert.equal(reassigned?.parent_agent_id, 'butler')
    assert.equal(reassigned?.persona_ref, 'copywriter-custom')
    assert.equal(ledger?.new_agent_id, 'copywriter-custom')
  } finally {
    ;(db as unknown as { close?: () => void }).close?.()
  }
})
