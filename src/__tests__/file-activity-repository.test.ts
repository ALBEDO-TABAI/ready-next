import { newRepositoryFixture, prepareObjectFixtures } from './utils/object-repository-fixtures'
let fixtureRoot = ''
import type { DatabaseConnection } from '../main/modules/database/connection'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

import { FileActivityRepository } from '../main/modules/repositories/file-activity-repository'
import { runMigrations, type MigrationDatabase } from '../main/modules/migrations'

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
  fixtureRoot=newRepositoryFixture();prepareObjectFixtures(db,[`${fixtureRoot}/workspace/b`,`${fixtureRoot}/workspace/a`],[`${fixtureRoot}/workspace/a/3.md`,`${fixtureRoot}/workspace/a/4.md`,`${fixtureRoot}/workspace/b/other.md`,`${fixtureRoot}/workspace/a/note.md`]);
  return db
}

test('migration 046 creates file activity table and indexes idempotently', (t) => {
  if (skipIfSqliteUnavailable(t, 'file activity migration schema')) return
  if (!loadSqlite()) return
  const db = openDb()

  try {
    runMigrations(db)
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_activity_events'")
      .get<{ name: string }>()
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'file_activity_events'")
      .all<{ name: string }>()
      .map((row) => row.name)

    assert.equal(table?.name, 'file_activity_events')
    assert.ok(indexes.includes('idx_file_activity_path_time'))
    assert.ok(indexes.includes('idx_file_activity_workspace_time'))
  } finally {
    db.close()
  }
})

test('file activity repository writes open and save events by workspace time', (t) => {
  if (skipIfSqliteUnavailable(t, 'file activity repository write/list')) return
  if (!loadSqlite()) return
  const db = openDb()

  try {
    const repo = new FileActivityRepository(db)
    repo.recordEvent({
      path: `${fixtureRoot}/workspace/a/note.md`,
      workspaceRoot: `${fixtureRoot}/workspace/a`,
      eventType: 'open',
      source: 'file_tree',
      createdAt: 1000,
    })
    repo.recordEvent({
      path: `${fixtureRoot}/workspace/a/note.md`,
      workspaceRoot: `${fixtureRoot}/workspace/a`,
      eventType: 'save',
      source: 'document_write',
      meta: { tabId: 'tab-1' },
      createdAt: 2000,
    })
    repo.recordEvent({
      path: `${fixtureRoot}/workspace/b/other.md`,
      workspaceRoot: `${fixtureRoot}/workspace/b`,
      eventType: 'open',
      source: 'file_tree',
      createdAt: 3000,
    })

    const rows = repo.listRecent({ workspaceRoots: [`${fixtureRoot}/workspace/a`], since: 0, limit: 10 })
    assert.deepEqual(rows.map((row) => row.eventType), ['save', 'open'])
    assert.equal(rows[0].weight, 1.2)
    assert.deepEqual(rows[0].meta, { tabId: 'tab-1' })
  } finally {
    db.close()
  }
})

test('file activity repository rejects v1-noisy enum values', (t) => {
  if (skipIfSqliteUnavailable(t, 'file activity repository enum rejection')) return
  if (!loadSqlite()) return
  const db = openDb()

  try {
    const repo = new FileActivityRepository(db)
    assert.throws(
      () => repo.recordEvent({
        path: `${fixtureRoot}/workspace/a/note.md`,
        workspaceRoot: `${fixtureRoot}/workspace/a`,
        eventType: 'select',
        source: 'file_tree',
      }),
      /not recorded in file emergence v1/,
    )
  } finally {
    db.close()
  }
})

test('file activity repository merges short repeated opens for the same path', (t) => {
  if (skipIfSqliteUnavailable(t, 'file activity repository dedupe')) return
  if (!loadSqlite()) return
  const db = openDb()

  try {
    const repo = new FileActivityRepository(db)
    const first = repo.recordEvent({
      path: `${fixtureRoot}/workspace/a/note.md`,
      workspaceRoot: `${fixtureRoot}/workspace/a`,
      eventType: 'open',
      source: 'file_tree',
      createdAt: 10_000,
    })
    const second = repo.recordEvent({
      path: `${fixtureRoot}/workspace/a/note.md`,
      workspaceRoot: `${fixtureRoot}/workspace/a`,
      eventType: 'open',
      source: 'document_mode',
      createdAt: 15_000,
    })
    const rows = repo.listRecent({ workspaceRoots: [`${fixtureRoot}/workspace/a`], since: 0, limit: 10 })

    assert.equal(first.id, second.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].createdAt, 15_000)
  } finally {
    db.close()
  }
})

test('file activity repository keeps short saves from distinct sources separate', (t) => {
  if (skipIfSqliteUnavailable(t, 'file activity save source boundary')) return
  if (!loadSqlite()) return
  const db = openDb()
  try {
    const repo = new FileActivityRepository(db)
    repo.recordEvent({ path: `${fixtureRoot}/workspace/a/note.md`, workspaceRoot: `${fixtureRoot}/workspace/a`, eventType: 'save', source: 'document_mode', createdAt: 10_000 })
    repo.recordEvent({ path: `${fixtureRoot}/workspace/a/note.md`, workspaceRoot: `${fixtureRoot}/workspace/a`, eventType: 'save', source: 'document_write', createdAt: 11_000 })
    assert.equal(repo.listRecent({ workspaceRoots: [`${fixtureRoot}/workspace/a`], since: 0, limit: 10 }).length, 2)
  } finally {
    db.close()
  }
})

test('file activity repository prunes by age and max rows', (t) => {
  if (skipIfSqliteUnavailable(t, 'file activity repository prune')) return
  if (!loadSqlite()) return
  const db = openDb()

  try {
    const repo = new FileActivityRepository(db)
    for (let index = 0; index < 5; index += 1) {
      prepareObjectFixtures(db,[],[`${fixtureRoot}/workspace/a/${index}.md`])
      repo.recordEvent({
        path: `${fixtureRoot}/workspace/a/${index}.md`,
        workspaceRoot: `${fixtureRoot}/workspace/a`,
        eventType: 'open',
        source: 'file_tree',
        createdAt: index * 1000,
      })
    }

    repo.prune(1000, 2)
    const rows = repo.listRecent({ workspaceRoots: [`${fixtureRoot}/workspace/a`], since: 0, limit: 10 })
    assert.deepEqual(rows.map((row) => row.path), [`${fixtureRoot}/workspace/a/4.md`, `${fixtureRoot}/workspace/a/3.md`])
  } finally {
    db.close()
  }
})
