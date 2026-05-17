import assert from 'node:assert/strict'
import test from 'node:test'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

interface MigrationDb {
  exec(sql: string): void
  prepare<T = unknown>(sql: string): {
    run(...params: unknown[]): unknown
    all<R = unknown>(...params: unknown[]): R[]
    get<R = unknown>(...params: unknown[]): R | undefined
  }
}

async function buildInMemoryDb(): Promise<MigrationDb> {
  const Database = (await import('better-sqlite3')).default
  return new Database(':memory:') as unknown as MigrationDb
}

async function runAllMigrations(db: MigrationDb): Promise<void> {
  const { runMigrations } = await import('../main/modules/migrations')
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
}

async function runOnlyMigration041(db: MigrationDb): Promise<void> {
  const { __getMigrationNamesForTests, runMigrations } = await import('../main/modules/migrations')
  db.exec(`
    CREATE TABLE migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `)
  const markApplied = db.prepare(`INSERT INTO migrations (name, applied_at) VALUES (?, ?)`)
  for (const name of __getMigrationNamesForTests()) {
    if (name === '041_relax_rss_analysis_item_fk') continue
    markApplied.run(name, new Date(0).toISOString())
  }
  runMigrations(db as unknown as Parameters<typeof runMigrations>[0])
}

function createOldRSSAnalysisSchema(db: MigrationDb): void {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE rss_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      group_name TEXT DEFAULT 'default',
      icon TEXT,
      last_fetched INTEGER,
      fetch_interval INTEGER DEFAULT 30,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE rss_items (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      guid TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      summary TEXT,
      cover_image TEXT,
      author TEXT,
      published_at INTEGER,
      fetched_at INTEGER DEFAULT (unixepoch()),
      read INTEGER DEFAULT 0,
      starred INTEGER DEFAULT 0,
      ai_score INTEGER,
      ai_tags TEXT,
      FOREIGN KEY (source_id) REFERENCES rss_sources(id) ON DELETE CASCADE
    );

    CREATE TABLE rss_analysis_jobs (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      action TEXT NOT NULL,
      source_url TEXT NOT NULL,
      title TEXT NOT NULL,
      target_dir TEXT NOT NULL,
      output_dir TEXT NOT NULL,
      report_path TEXT,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      error TEXT,
      meta_json TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY (item_id) REFERENCES rss_items(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_rss_analysis_item_updated
      ON rss_analysis_jobs(item_id, updated_at DESC);
    CREATE INDEX idx_rss_analysis_status_updated
      ON rss_analysis_jobs(status, updated_at DESC);
  `)
}

function insertAnalysisJob(db: MigrationDb, jobId: string, itemId: string): void {
  db.prepare(`
    INSERT INTO rss_analysis_jobs (
      id, item_id, action, source_url, title, target_dir, output_dir,
      status, progress, message, created_at, updated_at
    )
    VALUES (?, ?, 'copy', 'https://example.com/video', 'Example', '/tmp', '/tmp/out',
      'queued', 5, 'queued', '2026-05-17T00:00:00.000Z', '2026-05-17T00:00:00.000Z')
  `).run(jobId, itemId)
}

test('migration 041 — fresh schema allows browser-tab analysis job ids', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-041 fresh schema')) return
  const db = await buildInMemoryDb()
  await runAllMigrations(db)

  const foreignKeys = db
    .prepare(`PRAGMA foreign_key_list(rss_analysis_jobs)`)
    .all<{ table: string }>()
  assert.equal(
    foreignKeys.some((fk) => fk.table === 'rss_items'),
    false,
    'rss_analysis_jobs.item_id must no longer require rss_items(id)',
  )

  db.exec('PRAGMA foreign_keys = ON')
  assert.doesNotThrow(() => insertAnalysisJob(db, 'job-browser-tab', 'browser-tab-abc'))
})

test('migration 041 — existing rows survive and browser-tab ids work after upgrade', async (t) => {
  if (skipIfSqliteUnavailable(t, 'migration-041 upgrade schema')) return
  const db = await buildInMemoryDb()
  createOldRSSAnalysisSchema(db)
  db.prepare(`INSERT INTO rss_sources (id, name, url) VALUES (?, ?, ?)`)
    .run('source-1', 'Source', 'https://feed.example.com/rss')
  db.prepare(`
    INSERT INTO rss_items (id, source_id, guid, title, link)
    VALUES (?, ?, ?, ?, ?)
  `).run('rss-item-1', 'source-1', 'guid-1', 'RSS Item', 'https://feed.example.com/item')
  insertAnalysisJob(db, 'job-existing', 'rss-item-1')

  await runOnlyMigration041(db)

  const existing = db
    .prepare(`SELECT id, item_id FROM rss_analysis_jobs WHERE id = ?`)
    .get<{ id: string; item_id: string }>('job-existing')
  assert.deepEqual(existing, { id: 'job-existing', item_id: 'rss-item-1' })
  assert.doesNotThrow(() => insertAnalysisJob(db, 'job-browser-tab', 'browser-tab-abc'))
})
