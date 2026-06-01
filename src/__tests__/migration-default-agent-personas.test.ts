import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { DEFAULT_AGENT_PERSONAS } from '../main/modules/claude-bridge/default-personas'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
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

test('migration 045 seeds the four built-in agent personas', (t) => {
  if (skipIfSqliteUnavailable(t, 'default agent persona seed')) return
  if (!loadSqlite()) return
  const db = openInMemory()

  try {
    runMigrations(db)

    const rows = db
      .prepare(`
        SELECT agent_name, display_name, personality_text, meta_json
        FROM agent_personalities
        WHERE agent_name IN ('butler', 'copywriter', 'video-editor', 'analyst')
        ORDER BY agent_name
      `)
      .all<{
        agent_name: string
        display_name: string
        personality_text: string
        meta_json: string
      }>()

    assert.equal(rows.length, 4)
    for (const row of rows) {
      assert.equal(row.personality_text, DEFAULT_AGENT_PERSONAS[row.agent_name])
      assert.ok(row.display_name)
      assert.ok(JSON.parse(row.meta_json).emoji)
    }
  } finally {
    ;(db as unknown as { close?: () => void }).close?.()
  }
})

test('migration 045 does not overwrite an existing customized persona', (t) => {
  if (skipIfSqliteUnavailable(t, 'default agent persona seed idempotence')) return
  if (!loadSqlite()) return
  const db = openInMemory()

  try {
    runMigrations(db)
    db
      .prepare(`
        UPDATE agent_personalities
        SET personality_text = ?
        WHERE agent_name = 'butler'
      `)
      .run('custom butler persona')
    db.prepare("DELETE FROM migrations WHERE name = '045_seed_default_agent_personas'").run()

    runMigrations(db)

    const row = db
      .prepare("SELECT personality_text FROM agent_personalities WHERE agent_name = 'butler'")
      .get<{ personality_text: string }>()
    const count = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM agent_personalities
        WHERE agent_name IN ('butler', 'copywriter', 'video-editor', 'analyst')
      `)
      .get<{ count: number }>()

    assert.equal(row?.personality_text, 'custom butler persona')
    assert.equal(count?.count, 4)
  } finally {
    ;(db as unknown as { close?: () => void }).close?.()
  }
})
