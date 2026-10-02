import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseManager } from '../main/modules/database'
import { RSS_PROCESSING_METHOD } from '../shared/rss-processing'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('known old or unknown model methods are historical in every current classification consumer', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS classification method validity')) return
  const db = new DatabaseManager(true), sql = db.getRawDb()!
  try {
    const source = db.rss.addRSSSource({ name: 'Methods', url: 'https://methods.test/rss' })
    db.rss.setRSSSourceDraftSeeded(source, true)
    const topic = db.rss.organization.save({ name: 'Topic', description: 'Useful release facts' })
    for (const [id, origin, method] of [['old', 'model', 'rss-organize-old'], ['unknown', 'model', null], ['legacy', 'legacy', null], ['current', 'model', RSS_PROCESSING_METHOD]] as const) {
      db.rss.upsertRSSItems([{ id, source_id: source, guid: id, title: id, link: `https://methods.test/${id}`, summary: 'Saved fact' }])
      const article = db.rss.content.getArticle(id)!
      for (const definitionId of ['curated', topic.id]) {
        const result = sql.prepare(`INSERT INTO rss_classification_results(item_id,definition_id,decision,origin,reason,evidence,content_revision,rule_revision,method)
          VALUES (?,?,1,?,'Saved reason','Saved fact',?,1,?) RETURNING id`).get<{ id: number }>(id, definitionId, origin, article.revision, method)!
        sql.prepare('INSERT INTO rss_memberships(item_id,definition_id,result_id) VALUES (?,?,?)').run(id, definitionId, result.id)
      }
      db.rss.organization.recordDigestIntake(id)
    }
    assert.deepEqual(db.rss.content.query({ collectionId: 'curated' }).items.map((item) => item.id).sort(), ['current', 'legacy'])
    assert.deepEqual(db.rss.content.query({ categoryId: topic.id }).items.map((item) => item.id).sort(), ['current', 'legacy'])
    assert.equal(db.rss.getRSSStats().categories.find((entry) => entry.id === topic.id)?.count, 2)
    for (const id of ['old', 'unknown']) assert.equal(db.rss.content.getArticle(id)!.classifications.find((entry) => entry.definitionId === 'curated')!.stale, true)
    const brief = db.rss.digests.generate({ kind: 'range', from: 0, until: Date.now() + 1000, timezone: 'UTC', query: {} })
    assert.equal(brief.coverage.unresolvedArticles, 2, 'old method is not a current explicit yes/no decision')
    const article = db.rss.content.getArticle('old')!
    db.rss.organization.setManual({ itemId: article.id, definitionId: 'curated', expectedArticleRevision: article.revision, expectedRuleRevision: 1, decision: true })
    assert.equal(db.rss.content.getArticle('old')!.classifications.find((entry) => entry.definitionId === 'curated')!.stale, false)
    assert.equal(db.rss.content.query({ collectionId: 'curated' }).total, 3)
    db.rss.organization.setManual({ itemId: article.id, definitionId: 'curated', expectedArticleRevision: article.revision, expectedRuleRevision: 1, decision: null })
    assert.equal(db.rss.content.query({ collectionId: 'curated' }).total, 2)
  } finally { db.close() }
})

test('old event methods cannot group current cards or silently keep an old digest current', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS event method validity')) return
  const db = new DatabaseManager(true), sql = db.getRawDb()!
  try {
    const source = db.rss.addRSSSource({ name: 'Events', url: 'https://methods.test/rss' })
    for (const id of ['one', 'two']) db.rss.upsertRSSItems([{ id, source_id: source, guid: id, title: id, link: `https://methods.test/${id}`, summary: 'Version 2 released.' }])
    const one = db.rss.content.getArticle('one')!, two = db.rss.content.getArticle('two')!
    db.rss.events.apply(one.id, one.revision, db.rss.events.context(one.id, Date.now()), {
      kind: 'new', eventId: null, factId: null, quote: one.summary, sourceRole: 'direct', reason: 'Release' })
    const event = db.rss.events.memberships([one.id])[one.id]
    db.rss.events.apply(two.id, two.revision, db.rss.events.context(two.id, Date.now()), {
      kind: 'duplicate', eventId: event.eventId, factId: event.factId, quote: two.summary, sourceRole: 'secondary', reason: 'Same release' })
    const brief = db.rss.digests.generate({ kind: 'range', from: 0, until: Date.now() + 1000, timezone: 'UTC', query: {} })
    assert.equal(brief.needsUpdate, false)
    // Represents an older writer's retained evidence after an application update; immutable evidence is not rewritten.
    sql.exec(`INSERT INTO rss_event_evidence(id,item_id,article_revision,method,fact_id,quote,title,source_id,source_name,source_url,published_at,source_role,relation,reason,captured_at)
      SELECT 'old-'||id,item_id,article_revision,'rss-event-old',fact_id,quote,title,source_id,source_name,source_url,published_at,source_role,relation,reason,captured_at FROM rss_event_evidence;
      UPDATE rss_event_members SET evidence_id='old-'||evidence_id;`)
    assert.equal(db.rss.content.getArticle(one.id)!.event!.stale, true)
    assert.equal(db.rss.events.summary(event.eventId!).staleCount, 2)
    assert.equal(db.rss.content.cards({}).cardTotal, 2)
    const read = db.rss.digests.read({ view: 'entries', reportId: brief.id })
    assert.equal('report' in read && read.report.needsUpdate, true)
    sql.exec("UPDATE rss_event_evidence SET withdrawn=1 WHERE method<>'rss-event-old'")
    assert.equal(db.rss.events.readFacts({ eventId: event.eventId! }).facts[0].historical, true)
    assert.equal(db.rss.events.context(one.id, Date.now()).candidates[0].facts[0].historical, true)
    sql.exec('UPDATE rss_event_members SET manual=1')
    assert.equal(db.rss.content.getArticle(one.id)!.event!.stale, false)
    assert.equal(db.rss.content.cards({}).cardTotal, 1, 'explicit manual adoption takes precedence over old automatic method')
  } finally { db.close() }
})
