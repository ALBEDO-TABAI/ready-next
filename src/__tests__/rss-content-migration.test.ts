import { migrateRSSOrganization, RSS_ORGANIZATION_MIGRATION } from '../main/modules/rss-engine/organization-schema'
import { migrateRSSProcessing, RSS_PROCESSING_MIGRATION } from '../main/modules/rss-engine/processing-schema'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { DatabaseConnection } from '../main/modules/database/connection'
import { backupBeforeRSSMigration } from '../main/modules/database/rss-migration-backup'
import { migrateRSSContent, RSS_CONTENT_MIGRATION } from '../main/modules/rss-engine/content-schema'
import { __runMigrationForTests } from '../main/modules/migrations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('RSS migration backs up existing WAL data and rolls back without losing reader state', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS content migration')) return
  const Sqlite = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
  const directory = mkdtempSync(join(tmpdir(), 'ready-rss-migration-'))
  const path = join(directory, 'ready.db')
  const db = new Sqlite(path)
  let snapshot: DatabaseConnection | undefined
  try {
    db.pragma?.('journal_mode = WAL')
    for (const migration of ['001_create_rss_tables', '008_add_platform_column', '019_add_rss_draft_store_fields']) __runMigrationForTests(migration, db)
    db.exec("CREATE TABLE migrations(name TEXT PRIMARY KEY); INSERT INTO migrations VALUES('078_backfill_local_conversation_default_user')")
    db.exec("INSERT INTO rss_sources(id,name,url) VALUES('source','Fixture','https://example.test/feed')")
    db.exec("INSERT INTO rss_items(id,source_id,guid,title,link,read,starred,inbox_visible) VALUES('saved','source','saved','Saved title','https://example.test/saved',1,1,0)")
    const backup = backupBeforeRSSMigration(db, path)
    assert.ok(backup)
    snapshot = new Sqlite(backup)
    assert.equal(snapshot.prepare('SELECT title FROM rss_items').get<{ title: string }>()?.title, 'Saved title')
    assert.equal(snapshot.prepare('PRAGMA table_info(rss_items)').all<{ name: string }>().some((column) => column.name === 'content_revision'), false)

    db.exec('CREATE TABLE rss_workspace_state (id INTEGER PRIMARY KEY); BEGIN')
    assert.throws(() => migrateRSSContent(db), /already exists/)
    db.exec('ROLLBACK')
    assert.equal(db.prepare('PRAGMA table_info(rss_items)').all<{ name: string }>().some((column) => column.name === 'content_revision'), false)
    db.exec('DROP TABLE rss_workspace_state; BEGIN')
    migrateRSSContent(db)
    db.prepare('INSERT INTO migrations VALUES(?)').run(RSS_CONTENT_MIGRATION)
    db.exec('COMMIT')
    assert.deepEqual(db.prepare('SELECT read,starred,inbox_visible FROM rss_items').get(), { read: 1, starred: 1, inbox_visible: 0 })
    const organizationBackup = backupBeforeRSSMigration(db, path)
    assert.ok(organizationBackup?.includes('before-rss-080-'))
    db.exec('BEGIN')
    migrateRSSOrganization(db)
    db.prepare('INSERT INTO migrations VALUES(?)').run(RSS_ORGANIZATION_MIGRATION)
    db.exec('COMMIT')
    assert.ok(backupBeforeRSSMigration(db, path)?.includes('before-rss-081-'))
    db.exec('BEGIN')
    migrateRSSProcessing(db)
    db.prepare('INSERT INTO migrations VALUES(?)').run(RSS_PROCESSING_MIGRATION)
    db.exec('COMMIT')
    assert.equal(backupBeforeRSSMigration(db, path), null, 'all RSS migrations have completed')
    assert.equal(snapshot.prepare('SELECT title FROM rss_items').get<{ title: string }>()?.title, 'Saved title')
  } finally {
    snapshot?.close()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
