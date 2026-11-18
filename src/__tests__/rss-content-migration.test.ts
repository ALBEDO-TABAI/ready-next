import { migrateRSSSieveLearning, RSS_SIEVE_LEARNING_MIGRATION } from '../main/modules/rss-engine/sieve-learning-schema'
import { migrateRSSSieve, RSS_SIEVE_MIGRATION } from '../main/modules/rss-engine/sieve-schema'
import { migrateRSSDigests, RSS_DIGEST_MIGRATION } from '../main/modules/rss-engine/digest-schema'
import { migrateRSSCatalog, RSS_CATALOG_MIGRATION } from '../main/modules/rss-engine/catalog-schema'
import { migrateRSSMethodValidity, RSS_METHOD_VALIDITY_MIGRATION } from '../main/modules/rss-engine/method-validity-schema'
import { migrateRSSTranslations, RSS_TRANSLATION_MIGRATION } from '../main/modules/rss-engine/translation-schema'
import { RSSStore } from '../main/modules/database/rss-store'
import { migrateRSSPictures } from '../main/modules/rss-engine/pictures-schema'
import { migrateRSSResults, RSS_RESULT_MIGRATION } from '../main/modules/rss-engine/result-schema'
import { migrateRSSOrganization, RSS_ORGANIZATION_MIGRATION } from '../main/modules/rss-engine/organization-schema'
import { migrateRSSProcessing, RSS_PROCESSING_MIGRATION } from '../main/modules/rss-engine/processing-schema'
import { migrateRSSEvents, RSS_EVENT_MIGRATION } from '../main/modules/rss-engine/event-schema'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
  let db = new Sqlite(path)
  let snapshot: DatabaseConnection | undefined
  try {
    db.pragma?.('journal_mode = WAL')
    for (const migration of ['001_create_rss_tables', '008_add_platform_column', '010_create_rss_analysis_jobs', '019_add_rss_draft_store_fields']) __runMigrationForTests(migration, db)
    db.exec("CREATE TABLE migrations(name TEXT PRIMARY KEY); INSERT INTO migrations VALUES('078_backfill_local_conversation_default_user')")
    db.exec("INSERT INTO rss_sources(id,name,url) VALUES('source','Fixture','https://example.test/feed')")
    db.exec("INSERT INTO rss_items(id,source_id,guid,title,link,read,starred,inbox_visible) VALUES('saved','source','saved','Saved title','https://example.test/saved',1,1,0)")
    const oldJob = new RSSStore(() => db).createRSSAnalysisJob({ id: 'retained-job', itemId: 'saved', action: 'copy', sourceUrl: 'https://example.test/saved',
      title: 'Old report', targetDir: '/preserved', outputDir: '/preserved/report', status: 'success', progress: 100, metaJson: '{"historical":true}' })
    // A launch whose RSS step keeps failing replaces its previous copy instead of piling up full backups.
    const firstAttempt = backupBeforeRSSMigration(db, path)
    const backup = backupBeforeRSSMigration(db, path)
    assert.ok(firstAttempt && backup && firstAttempt !== backup)
    assert.deepEqual(readdirSync(dirname(backup)).filter((name) => name.startsWith('before-rss-124-')), [basename(backup)])
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
    assert.ok(organizationBackup?.includes('before-rss-125-'))
    db.exec('BEGIN')
    migrateRSSOrganization(db)
    db.prepare('INSERT INTO migrations VALUES(?)').run(RSS_ORGANIZATION_MIGRATION)
    db.exec('COMMIT')
    assert.ok(backupBeforeRSSMigration(db, path)?.includes('before-rss-126-'))
    db.exec('BEGIN')
    migrateRSSProcessing(db)
    db.prepare('INSERT INTO migrations VALUES(?)').run(RSS_PROCESSING_MIGRATION)
    db.exec('COMMIT')
    assert.ok(backupBeforeRSSMigration(db, path)?.includes('before-rss-127-'))
    db.exec('BEGIN')
    migrateRSSEvents(db)
    db.prepare('INSERT INTO migrations VALUES(?)').run(RSS_EVENT_MIGRATION)
    db.exec('COMMIT')
    assert.ok(backupBeforeRSSMigration(db, path)?.includes('before-rss-128-'))
    db.exec('BEGIN')
    migrateRSSResults(db)
    db.prepare('INSERT INTO migrations VALUES(?)').run(RSS_RESULT_MIGRATION)
    db.exec('COMMIT')
    assert.ok(backupBeforeRSSMigration(db, path)?.includes('before-rss-129-'))
    db.exec('BEGIN')
    migrateRSSDigests(db)
    db.prepare('INSERT INTO migrations VALUES(?)').run(RSS_DIGEST_MIGRATION)
    db.exec('COMMIT')
    assert.equal(db.prepare('SELECT daily_eligible FROM rss_items').get<{ daily_eligible: number }>()!.daily_eligible, 0)
    assert.ok(backupBeforeRSSMigration(db, path)?.includes('before-rss-130-'))
    db.exec('CREATE TRIGGER rss_catalog_workspace_change AFTER UPDATE ON rss_workspace_state BEGIN SELECT 1; END; BEGIN')
    assert.throws(() => migrateRSSCatalog(db), /already exists/)
    db.exec('ROLLBACK')
    assert.equal(db.prepare('PRAGMA table_info(rss_workspace_state)').all<{ name: string }>().some((column) => column.name === 'catalog_revision'), false)
    assert.deepEqual(db.prepare('SELECT read,starred,inbox_visible FROM rss_items').get(), { read: 1, starred: 1, inbox_visible: 0 })
    db.exec('DROP TRIGGER rss_catalog_workspace_change; BEGIN')
    migrateRSSCatalog(db)
    db.prepare('INSERT INTO migrations VALUES(?)').run(RSS_CATALOG_MIGRATION)
    db.exec('COMMIT')
    db.close(); db = new Sqlite(path)
    assert.equal(new RSSStore(() => db).catalog.read({ view: 'sources' }).total, 1)
    assert.deepEqual(new RSSStore(() => db).catalog.read({ view: 'analysis' }).entries, [oldJob])
    migrateRSSPictures(db)
    const beforeMethods = new RSSStore(() => db).content.query({})
    assert.ok(backupBeforeRSSMigration(db, path)?.includes('before-rss-131-'))
    db.exec('BEGIN')
    migrateRSSMethodValidity(db)
    db.prepare('INSERT INTO migrations VALUES(?)').run(RSS_METHOD_VALIDITY_MIGRATION)
    db.exec('COMMIT')
    const afterMethods = new RSSStore(() => db).content.query({})
    assert.equal(afterMethods.revision, beforeMethods.revision + 1)
    assert.deepEqual(afterMethods.items, beforeMethods.items)
    assert.deepEqual(new RSSStore(() => db).getRSSAnalysisJob(oldJob.id), oldJob)
    assert.throws(() => new RSSStore(() => db).content.query({ expectedRevision: beforeMethods.revision }), /stale/)
    assert.ok(backupBeforeRSSMigration(db, path)?.includes('before-rss-132-'))
    db.exec('BEGIN')
    migrateRSSTranslations(db)
    db.prepare('INSERT INTO migrations VALUES(?)').run(RSS_TRANSLATION_MIGRATION)
    db.exec('COMMIT')
    assert.equal(new RSSStore(() => db).translations.get(afterMethods.items[0]!.id, 'zh-CN'), null)
    assert.deepEqual(new RSSStore(() => db).content.query({}).items, afterMethods.items, 'translations add no reader state')
    const sieveBackup = backupBeforeRSSMigration(db, path)
    assert.ok(sieveBackup?.includes('before-rss-155-'))
    db.exec('BEGIN; CREATE TABLE rss_focus (singleton INTEGER)')
    assert.throws(() => migrateRSSSieve(db), /already exists/)
    db.exec('ROLLBACK')
    assert.ok(db.prepare('PRAGMA table_info(rss_items)').all<{name:string}>().some(c => c.name === 'ai_score'))
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='rss_behaviors'").get(), undefined)
    db.exec('BEGIN'); migrateRSSSieve(db)
    db.prepare('INSERT INTO migrations VALUES(?)').run(RSS_SIEVE_MIGRATION); db.exec('COMMIT')
    assert.equal(db.prepare('PRAGMA table_info(rss_items)').all<{name:string}>().some(c => c.name === 'ai_score'), false)
    assert.deepEqual(db.prepare('SELECT read,starred,inbox_visible FROM rss_items').get(), { read:1,starred:1,inbox_visible:0 })
    assert.ok(backupBeforeRSSMigration(db, path)?.includes('before-rss-156-'))
    db.exec('BEGIN')
    migrateRSSSieveLearning(db)
    db.exec('ROLLBACK')
    assert.equal(db.prepare('PRAGMA table_info(rss_sources)').all<{name:string}>().some(c=>c.name==='fetch_interval'),true)
    db.exec('BEGIN')
    migrateRSSSieveLearning(db)
    db.prepare('INSERT INTO migrations VALUES(?)').run(RSS_SIEVE_LEARNING_MIGRATION)
    db.exec('COMMIT')
    assert.equal(backupBeforeRSSMigration(db, path), null, 'all RSS migrations have completed')
    assert.equal(snapshot.prepare('SELECT title FROM rss_items').get<{ title: string }>()?.title, 'Saved title')
  } finally {
    snapshot?.close()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
