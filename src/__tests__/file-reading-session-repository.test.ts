import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { FileReadingSessionRepository } from '../main/modules/repositories/file-reading-session-repository'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'
import type { DatabaseConnection } from '../main/modules/database'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

type SqliteCtor = new (path: string) => DatabaseConnection & MigrationDatabase

const require = createRequire(import.meta.url)

function loadSqlite(): SqliteCtor | null {
  try {
    const mod = require('better-sqlite3') as SqliteCtor & { default?: SqliteCtor }
    return mod.default || mod
  } catch {
    return null
  }
}

function openDb(): DatabaseConnection & MigrationDatabase {
  const Sqlite = loadSqlite()!
  const db = new Sqlite(':memory:')
  runMigrations(db)
  return db
}

test('migration 047 creates document reading session table and indexes idempotently', (t) => {
  if (skipIfSqliteUnavailable(t, 'document reading session migration schema')) return
  if (!loadSqlite()) return
  const db = openDb()

  try {
    runMigrations(db)
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_reading_sessions'")
      .get<{ name: string }>()
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'document_reading_sessions'")
      .all<{ name: string }>()
      .map((row) => row.name)

    assert.equal(table?.name, 'document_reading_sessions')
    assert.ok(indexes.includes('idx_document_reading_sessions_path_time'))
    assert.ok(indexes.includes('idx_document_reading_sessions_workspace_time'))
  } finally {
    db.close()
  }
})

test('file reading session repository drops short sessions and stores effective sessions', (t) => {
  if (skipIfSqliteUnavailable(t, 'document reading session write/list')) return
  if (!loadSqlite()) return
  const db = openDb()

  try {
    const repo = new FileReadingSessionRepository(db)
    const short = repo.recordSession({
      path: '/workspace/books/白痴.epub',
      workspaceRoot: '/workspace',
      source: 'document_mode',
      startedAt: 1000,
      endedAt: 20_000,
      activeMs: 19_000,
    })
    assert.equal(short, null)

    const stored = repo.recordSession({
      path: '/workspace/books/白痴.epub',
      workspaceRoot: '/workspace',
      source: 'document_mode',
      startedAt: 1000,
      endedAt: 80_000,
      activeMs: 65_000,
      progressStart: 0.3,
      progressEnd: 0.45,
      progressKind: 'ebook',
      meta: { tabId: 'doc-1' },
    })
    assert.equal(stored?.activeMs, 65_000)
    assert.equal(stored?.progressEnd, 0.45)

    const rows = repo.listRecent({ workspaceRoots: ['/workspace'], since: 0, limit: 10 })
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0].meta, { tabId: 'doc-1' })
  } finally {
    db.close()
  }
})

test('file reading session repository prunes by age and max rows', (t) => {
  if (skipIfSqliteUnavailable(t, 'document reading session prune')) return
  if (!loadSqlite()) return
  const db = openDb()

  try {
    const repo = new FileReadingSessionRepository(db)
    for (let index = 0; index < 5; index += 1) {
      repo.recordSession({
        path: `/workspace/books/${index}.epub`,
        workspaceRoot: '/workspace',
        source: 'document_mode',
        startedAt: index * 1000,
        endedAt: index * 1000 + 60_000,
        activeMs: 45_000,
      })
    }

    repo.prune(1000, 2)
    const rows = repo.listRecent({ workspaceRoots: ['/workspace'], since: 0, limit: 10 })
    assert.deepEqual(rows.map((row) => row.path), ['/workspace/books/4.epub', '/workspace/books/3.epub'])
  } finally {
    db.close()
  }
})
