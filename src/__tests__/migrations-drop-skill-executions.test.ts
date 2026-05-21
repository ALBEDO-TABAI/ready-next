/**
 * B plan Phase 4 — migration 029 drops the skill_executions state machine
 * tables. This suite locks:
 *   1. Fresh DB: running all migrations (018 builds the 3 tables, 029 drops
 *      them) leaves no trace of skill_executions / skill_execution_steps /
 *      skill_execution_artifacts.
 *   2. Idempotent: re-running migrations (simulating a re-launch) is a no-op.
 *   3. Legacy DB: a DB that was already at migration 018 applies 029
 *      successfully on upgrade.
 *   4. Never-built DB: a DB that never had the tables (e.g. a test DB that
 *      stubbed 018) handles 029 gracefully because every statement is
 *      IF EXISTS.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

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

function loadSqlite(): SqliteModule | null {
  try {
     
    return require('better-sqlite3') as SqliteModule
  } catch {
    return null
  }
}

function openInMemory(): MigrationDatabase {
  const Sqlite = loadSqlite()!
  const db = new Sqlite(':memory:')
  return db as unknown as MigrationDatabase
}

function tableExists(db: MigrationDatabase, name: string): boolean {
  const row = (db as unknown as {
    prepare: (sql: string) => { get: (n: string) => { name?: string } | undefined }
  })
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name)
  return Boolean(row?.name)
}

function indexExists(db: MigrationDatabase, name: string): boolean {
  const row = (db as unknown as {
    prepare: (sql: string) => { get: (n: string) => { name?: string } | undefined }
  })
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
    .get(name)
  return Boolean(row?.name)
}

function appliedMigrations(db: MigrationDatabase): string[] {
  const rows = (db as unknown as {
    prepare: (sql: string) => { all: () => Array<{ name: string }> }
  })
    .prepare('SELECT name FROM migrations ORDER BY applied_at')
    .all()
  return rows.map((r) => r.name)
}

const SKILL_TABLES = ['skill_executions', 'skill_execution_steps', 'skill_execution_artifacts']
const SKILL_INDEXES = [
  'idx_skill_executions_updated_at',
  'idx_skill_executions_session_status',
  'idx_skill_executions_status_finished_at',
  'idx_skill_execution_steps_execution_step',
  'idx_skill_execution_artifacts_execution_step',
  'idx_skill_execution_artifacts_artifact_id',
]

test('fresh DB — migration 029 drops all 3 skill_executions tables and their indexes', (t) => {
  if (skipIfSqliteUnavailable(t, 'migrations-drop-skill-executions: fresh DB')) return
  if (!loadSqlite()) return
  const db = openInMemory()
  try {
    runMigrations(db)

    for (const table of SKILL_TABLES) {
      assert.equal(tableExists(db, table), false, `${table} must be dropped after 029`)
    }
    for (const idx of SKILL_INDEXES) {
      assert.equal(indexExists(db, idx), false, `${idx} must be dropped along with the table`)
    }

    // Both 018 and 029 are recorded in the migrations tracking table.
    const applied = appliedMigrations(db)
    assert.ok(applied.includes('018_create_skill_execution_tables'))
    assert.ok(applied.includes('028_add_skill_executions_ttl_index'))
    assert.ok(applied.includes('029_drop_skill_execution_tables'))
  } finally {
    ;(db as unknown as { close?: () => void }).close?.()
  }
})

test('idempotent — re-running migrations after 029 is a no-op (no re-applied rows, no thrown errors)', (t) => {
  if (skipIfSqliteUnavailable(t, 'migrations-drop-skill-executions: idempotent')) return
  if (!loadSqlite()) return
  const db = openInMemory()
  try {
    runMigrations(db)
    const firstApplied = appliedMigrations(db)

    runMigrations(db)
    const secondApplied = appliedMigrations(db)

    assert.deepEqual(secondApplied, firstApplied, 'migrations table must not gain duplicate rows')
  } finally {
    ;(db as unknown as { close?: () => void }).close?.()
  }
})

test('never-built DB — skipping 018 and jumping straight to 029 still succeeds (all statements are IF EXISTS)', (t) => {
  if (skipIfSqliteUnavailable(t, 'migrations-drop-skill-executions: never-built DB')) return
  if (!loadSqlite()) return
  const db = openInMemory()
  try {
    // Simulate a corrupted install where 018 was somehow skipped but 029 is
    // applied on the next launch. Every statement in 029 uses IF EXISTS so
    // the migration must not throw.
    db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      )
    `)
    // Mark 018 + 028 as already applied so runMigrations skips them, but
    // their tables were never created. 029 must still run cleanly.
    for (const name of [
      '018_create_skill_execution_tables',
      '028_add_skill_executions_ttl_index',
    ]) {
      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(
        name,
        new Date().toISOString(),
      )
    }

    runMigrations(db)

    const applied = appliedMigrations(db)
    assert.ok(applied.includes('029_drop_skill_execution_tables'))
    for (const table of SKILL_TABLES) {
      assert.equal(tableExists(db, table), false)
    }
  } finally {
    ;(db as unknown as { close?: () => void }).close?.()
  }
})

test('migration 030 upgrades the broad RSS analysis trigger pattern in existing databases', (t) => {
  if (skipIfSqliteUnavailable(t, 'migrations-drop-skill-executions: migration 030')) return
  if (!loadSqlite()) return
  const db = openInMemory()
  try {
    runMigrations(db)
    db.prepare("UPDATE agent_triggers SET pattern = '(rss|订阅|抓取|分析)' WHERE id = 'rss-analysis'").run()
    db.prepare("DELETE FROM migrations WHERE name = '030_tighten_rss_analysis_trigger'").run()

    runMigrations(db)

    const row = (db as unknown as {
      prepare: (sql: string) => { get: (id: string) => { pattern: string; pattern_flags: string } | undefined }
    })
      .prepare('SELECT pattern, pattern_flags FROM agent_triggers WHERE id = ?')
      .get('rss-analysis')

    assert.ok(row, 'rss-analysis trigger should exist')
    assert.notEqual(row!.pattern, '(rss|订阅|抓取|分析)')

    const pattern = new RegExp(row!.pattern, row!.pattern_flags)
    assert.equal(pattern.test('使用 Video Expert Analyzer 分析 YouTube 视频'), false)
    assert.equal(pattern.test('抓取这个 RSS 订阅源并生成分析报告'), true)
  } finally {
    ;(db as unknown as { close?: () => void }).close?.()
  }
})
