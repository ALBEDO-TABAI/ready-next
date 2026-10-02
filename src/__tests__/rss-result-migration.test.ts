import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { __getMigrationNamesForTests, __runMigrationForTests } from '../main/modules/migrations'
import { RSSStore } from '../main/modules/database/rss-store'
import type { DatabaseConnection } from '../main/modules/database/connection'

test('result migration preserves actual current values on disk without inventing results from success receipts', (testContext) => {
  if (skipIfSqliteUnavailable(testContext, 'RSS native storage')) return
  const SQLite = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => DatabaseConnection
  const directory = mkdtempSync(join(tmpdir(), 'rss-results-')), path = join(directory, 'ready.db')
  let db = new SQLite(path)
  try {
    db.exec('PRAGMA foreign_keys=ON')
    for (const name of __getMigrationNamesForTests().filter((n) => Number(n.slice(0, 3)) < 128)) __runMigrationForTests(name, db)
    db.exec(`INSERT INTO rss_sources(id,name,url) VALUES('source','Source','https://restore.test/feed');
      INSERT INTO rss_items(id,source_id,guid,title,link,read,starred) VALUES('one','source','one','Title','https://restore.test/one',1,1);
      INSERT INTO rss_memberships(item_id,definition_id,manual_decision,derived_decision,derived_origin,reason,evidence,content_revision,rule_revision)
        VALUES('one','curated',0,1,'model','Actual saved reason','Actual evidence','old-version',1);
      INSERT INTO rss_processing_jobs(id,item_id,title,article_revision,fingerprint,method,definitions_json,trigger_kind,status,created_at,started_at)
        VALUES('past','one','Title','lost-version','past','rss-organize-v1','[{"id":"curated","name":"Saved","description":"Rule","ruleRevision":1}]','automatic','success',1,2);`)
    db.exec('BEGIN')
    __runMigrationForTests('128_rss_saved_results', db)
    db.exec('ROLLBACK')
    assert.equal(db.prepare('SELECT reason FROM rss_memberships').get<{ reason: string }>()!.reason, 'Actual saved reason')
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='rss_classification_results'").get(), undefined)
    db.exec('BEGIN')
    __runMigrationForTests('128_rss_saved_results', db)
    db.exec('COMMIT')
    db.close(); db = new SQLite(path); db.exec('PRAGMA foreign_keys=ON')
    const rss = new RSSStore(() => db), article = rss.content.getArticle('one')!
    assert.equal(article.read, true); assert.equal(article.starred, true)
    assert.equal(article.classifications[0].included, false)
    const saved = db.prepare('SELECT decision,origin,reason,evidence,content_revision,method,job_id FROM rss_classification_results').all()
    assert.deepEqual(saved, [{ decision: 1, origin: 'model', reason: 'Actual saved reason', evidence: 'Actual evidence', content_revision: 'old-version', method: null, job_id: null }])
    assert.equal(rss.processing.get('past')!.savedDecisionCount, 0)
    assert.equal(rss.processing.get('past')!.inputCurrent, false)
    assert.equal(rss.processing.list().total, 1)
    assert.equal(db.prepare('PRAGMA table_info(rss_memberships)').all<{ name: string }>().some((c) => c.name === 'derived_decision'), false)
    assert.throws(() => db.exec("UPDATE rss_classification_results SET reason='tampered'"), /immutable/)
    db.exec('BEGIN')
    __runMigrationForTests('129_rss_digests', db)
    assert.equal(db.prepare('SELECT daily_eligible FROM rss_items').get<{ daily_eligible: number }>()!.daily_eligible, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rss_digest_intake').get<{ n: number }>()!.n, 0)
    db.exec('ROLLBACK')
    assert.equal(db.prepare('PRAGMA table_info(rss_items)').all<{ name: string }>().some((c) => c.name === 'daily_eligible'), false)
    db.exec('BEGIN'); __runMigrationForTests('129_rss_digests', db); db.exec('COMMIT')
    db.close(); db = new SQLite(path); db.exec('PRAGMA foreign_keys=ON')
    const upgraded = new RSSStore(() => db)
    assert.equal(upgraded.content.getArticle('one')!.classifications[0].included, false)
    assert.equal(upgraded.digests.read().total, 0)
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
})
