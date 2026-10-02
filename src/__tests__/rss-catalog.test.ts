import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseManager } from '../main/modules/database'
import { RSS_PROCESSING_METHOD } from '../shared/rss-processing'
import { executeRSSTool } from '../main/modules/tools/rss-tools'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

function fixture() {
  const db = new DatabaseManager(true), sql = db.getRawDb()!
  const sourceId = db.rss.addRSSSource({ name: 'Source', url: 'https://catalog.test/feed' })
  const item = { id: 'item', source_id: sourceId, guid: 'item', title: 'Catalog article', link: 'https://catalog.test/article', summary: 'Saved evidence' }
  db.rss.upsertRSSItems([item, { ...item, id: 'other', guid: 'other' }])
  const job = (id: string) => db.rss.createRSSAnalysisJob({ id, itemId: item.id, title: item.title, action: 'copy', sourceUrl: item.link,
    targetDir: '/not-read', outputDir: '/not-read', status: 'success', progress: 100, metaJson: '{"retained":"history"}' })
  return { db, sql, sourceId, item, job }
}

test('catalog traverses all saved tasks and disabled sources without mutating storage', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS complete catalog')) return
  const f = fixture()
  try {
    for (let index = 0; index < 503; index++) f.job(`job-${index}`)
    f.sql.prepare('UPDATE rss_sources SET enabled=0 WHERE id=?').run(f.sourceId)
    const changes = () => f.sql.prepare('SELECT total_changes() AS n').get<{ n: number }>()!.n
    const before = changes()
    let cursor: string | undefined, ids: string[] = []
    do {
      const page = f.db.rss.catalog.read({ view: 'analysis', limit: 37, cursor })
      assert.equal(page.total, 503)
      ids.push(...page.entries.map((entry) => String(entry.id)))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    assert.equal(ids.length, 503)
    assert.equal(new Set(ids).size, 503)
    const sources = f.db.rss.catalog.read({ view: 'sources' })
    assert.equal(sources.entries.length, 1)
    assert.equal((sources.entries[0] as { enabled: number }).enabled, 0)
    const defs = f.db.rss.catalog.read({ view: 'definitions', limit: 100 })
    assert.deepEqual(defs.entries, f.db.rss.organization.list())
    const result = JSON.parse(await executeRSSTool('rss_read_catalog', { view: 'sources' }, {
      getCatalog: () => f.db.rss.catalog,
      getRouteAttempt: () => ({ sourceId: f.sourceId, sourceName: 'Former name', url: 'https://catalog.test/old', groupName: 'default',
        platform: 'rss', backend: 'native', durationMs: 1, itemCount: 1, success: true, warning: null, attemptedAt: '2026-01-01T00:00:00Z', succeededAt: '2026-01-01T00:00:00Z', lastRouteError: null }),
    }))
    assert.equal(result.ok, true)
    assert.equal(result.diagnostics.entries[0].matchesCurrentUrl, false)
    assert.ok(result.diagnostics.observedAt)
    const denied = JSON.parse(await executeRSSTool('rss_read_catalog', { view: 'analysis' }, { readAccessDenied: true, getCatalog: () => { throw new Error('must not access') } }))
    assert.equal(denied.error, 'rss_read_not_authorized')
    assert.equal(changes(), before)
  } finally { f.db.close() }
})

test('catalog rejects changed pages without making analysis progress invalidate article pages', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS catalog revisions')) return
  const f = fixture()
  try {
    f.job('first'); f.job('second')
    const articles = f.db.rss.content.query({ limit: 1 })
    const tasks = f.db.rss.catalog.read({ view: 'analysis', limit: 1 })
    f.db.rss.updateRSSAnalysisJob('second', { progress: 50 })
    assert.throws(() => f.db.rss.catalog.read({ view: 'analysis', cursor: tasks.nextCursor! }), /已变化/)
    assert.equal(f.db.rss.content.query({ limit: 1, cursor: articles.nextCursor! }).items.length, 1)
    const last = f.db.rss.addRSSSource({ name: 'Last', url: 'https://catalog.test/last' })
    const sources = f.db.rss.catalog.read({ view: 'sources', limit: 1 })
    const rowid = f.sql.prepare('SELECT rowid FROM rss_sources WHERE id=?').get<{ rowid: number }>(last)!.rowid
    f.db.rss.removeRSSSource(last)
    const replacement = f.db.rss.addRSSSource({ name: 'Replacement', url: 'https://catalog.test/replacement' })
    assert.equal(f.sql.prepare('SELECT rowid FROM rss_sources WHERE id=?').get<{ rowid: number }>(replacement)!.rowid, rowid)
    assert.throws(() => f.db.rss.catalog.read({ view: 'sources', cursor: sources.nextCursor! }), /已变化/)
    const current = f.db.rss.catalog.read({ view: 'sources', limit: 1 })
    f.sql.exec('SAVEPOINT change_then_rollback')
    f.sql.prepare('UPDATE rss_sources SET icon=?,platform=?,last_fetched=42,draft_seeded=1 WHERE id=?').run('changed', 'youtube', f.sourceId)
    assert.throws(() => f.db.rss.catalog.read({ view: 'sources', cursor: current.nextCursor! }), /已变化/)
    f.sql.exec('ROLLBACK TO change_then_rollback; RELEASE change_then_rollback')
    assert.equal(f.db.rss.catalog.read({ view: 'sources', cursor: current.nextCursor! }).revision, current.revision)
    assert.throws(() => f.db.rss.catalog.read({ view: 'analysis', cursor: current.nextCursor! }), /筛选不一致/)
    assert.throws(() => f.db.rss.catalog.read({ view: 'sources', itemId: 'item' }), /view/)
    assert.throws(() => f.db.rss.catalog.read({ view: 'analysis', cursor: 'null' }), /游标/)
    const filtered = f.db.rss.catalog.read({ view: 'analysis', itemId: 'item', limit: 1 })
    assert.throws(() => f.db.rss.catalog.read({ view: 'analysis', itemId: 'other', cursor: filtered.nextCursor! }), /筛选不一致/)
    f.db.rss.deleteRSSAnalysisJob('second'); f.job('second')
    assert.throws(() => f.db.rss.catalog.read({ view: 'analysis', itemId: 'item', cursor: filtered.nextCursor! }), /已变化/)
  } finally { f.db.close() }
})

test('catalog keeps historical classification and withdrawn or insufficient event evidence distinct', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS catalog history')) return
  const f = fixture()
  try {
    const article = f.db.rss.content.getArticle(f.item.id)!
    const insert = f.sql.prepare(`INSERT INTO rss_classification_results(item_id,definition_id,decision,origin,reason,evidence,content_revision,rule_revision,method)
      VALUES (?,'curated',1,'legacy',?,'Saved evidence',?,1,?) RETURNING id`)
    const old = insert.get<{ id: number }>(f.item.id, 'Old result', 'old-version', null)!
    const current = insert.get<{ id: number }>(f.item.id, 'Current result', article.revision, RSS_PROCESSING_METHOD)!
    f.sql.prepare("INSERT INTO rss_memberships(item_id,definition_id,result_id,manual_decision) VALUES (?,'curated',?,0)").run(f.item.id, current.id)
    const judgments = f.db.rss.catalog.read({ view: 'judgments', itemId: f.item.id }).entries as Array<Record<string, unknown>>
    assert.equal(judgments.length, 2)
    assert.equal(judgments.find((row) => row.id === old.id)!.matches_current_content_and_rule, 0)
    assert.equal(judgments.find((row) => row.id === current.id)!.selected_automatic_base, 1)
    assert.equal(judgments[0].manual_decision, 0)
    const page = f.db.rss.catalog.read({ view: 'judgments', limit: 1 })
    insert.get(f.item.id, 'Unbound result', article.revision, null)
    assert.throws(() => f.db.rss.catalog.read({ view: 'judgments', cursor: page.nextCursor! }), /已变化/)
    const event = f.db.rss.events.move({ itemId: article.id, expectedArticleRevision: article.revision, expectedMembershipRevision: 0, targetEventId: null, quote: 'Saved evidence' })
    f.sql.prepare('UPDATE rss_event_evidence SET withdrawn=1 WHERE item_id=?').run(article.id)
    f.sql.prepare(`INSERT INTO rss_event_evidence(id,item_id,article_revision,method,title,source_id,source_name,source_url,source_role,reason,captured_at)
      VALUES ('insufficient',?,?,'rss-event-v1','Title',?,'Source',?,'unknown','Information insufficient',1)`).run(article.id, article.revision, f.sourceId, article.link)
    const evidence = f.db.rss.catalog.read({ view: 'evidence', itemId: article.id }).entries as Array<Record<string, unknown>>
    assert.equal(evidence.length, 2)
    assert.equal(evidence.find((row) => row.id === 'insufficient')!.fact_id, null)
    assert.equal(evidence.find((row) => row.withdrawn === 1)!.selected_current_evidence, 0)
    assert.equal(f.db.rss.catalog.read({ view: 'evidence', eventId: event.eventId! }).total, 1)
  } finally { f.db.close() }
})
