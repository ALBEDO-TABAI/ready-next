import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RSSStore } from '../main/modules/database/rss-store'
import type { DatabaseConnection } from '../main/modules/database/connection'
import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseManager } from '../main/modules/database'
import { RSSContentService } from '../main/modules/rss-engine/content-service'
import { RSSProcessingService } from '../main/modules/rss-engine/processing-service'
import type { RSSJudgmentInput } from '../main/modules/rss-engine/processing-judgment'

function fixture() {
  const db = new DatabaseManager(true), rss = db.rss
  const source = rss.addRSSSource({ name: 'Versioned source', url: 'https://restore.test/feed' })
  rss.setRSSSourceDraftSeeded(source, true)
  rss.upsertRSSItems([{ id: 'story', source_id: source, guid: 'story', title: 'Project update', summary: 'Summary', link: 'https://restore.test/story' }])
  const body = (text: string) => {
    const claim = rss.content.beginLoad('story')!
    assert.equal(rss.content.finishLoad(claim, { status: 'ready', markdown: text, sourceUrl: 'https://restore.test/story' }), true)
  }
  let calls = 0, override: boolean | undefined
  const runner = new RSSProcessingService({ store: rss.processing, getArticle: (id) => rss.content.getArticle(id), hasModel: () => true,
    now: () => Date.now(), notify: () => {}, prepare: (input: RSSJudgmentInput) => async () => {
      calls++
      const isA = input.source.text.includes('Release A'), quote = isA ? 'Release A' : 'Release B'
      return JSON.stringify({ relevance:{score:80,because:'standard',reason:'相关',workRef:null}, decisions: input.definitions.map((d) => ({ definitionId: d.id, included: override ?? isA, reason: quote, evidence: quote })),
        ...(input.eventContext && !input.eventContext.manual && !input.eventContext.reused ? { event: { kind: isA ? 'new' : 'insufficient', eventId: null, factId: null,
          quote: isA ? quote : null, sourceRole: 'direct', reason: quote } } : {}) })
    } })
  return { db, rss, body, runner, calls: () => calls, override: (value: boolean) => { override = value }, article: () => rss.content.getArticle('story')! }
}

test('A to B to A restores saved judgments and event identity without a third request', async (testContext) => {
  if (skipIfSqliteUnavailable(testContext, 'RSS native storage')) return
  const f = fixture()
  try {
    f.body('Release A'); await f.runner.wake()
    const a = f.article(); assert.equal(a.classifications[0].included, true); assert.ok(a.event?.factId)
    f.body('Release B'); await f.runner.wake()
    assert.equal(f.article().classifications[0].included, false); assert.equal(f.article().event?.factId, null)
    f.body('Release A'); await f.runner.wake()
    assert.equal(f.calls(), 2)
    assert.equal(f.article().revision, a.revision)
    assert.equal(f.article().classifications[0].included, true)
    assert.equal(f.article().classifications[0].stale, false)
    assert.equal(f.article().event?.factId, a.event?.factId)
    assert.equal(f.article().event?.stale, false)
    f.body('Release B'); await f.runner.wake()
    assert.equal(f.article().event?.factId, null)
    assert.equal(f.article().event?.stale, false)
    assert.equal(f.calls(), 2)
  } finally { await f.runner.stop(); f.db.close() }
})

test('returning versions restore the latest accepted reprocessing and keep manual decisions separate', async (testContext) => {
  if (skipIfSqliteUnavailable(testContext, 'RSS native storage')) return
  const f = fixture()
  try {
    f.body('Release A'); await f.runner.wake()
    f.override(false); f.rss.processing.enqueue('story', 'manual'); await f.runner.wake()
    assert.equal(f.calls(), 2)
    f.rss.organization.setManual({ itemId: 'story', definitionId: 'curated', expectedArticleRevision: f.article().revision, expectedRuleRevision: 1, decision: true })
    f.body('Release B'); await f.runner.wake()
    f.body('Release A'); await f.runner.wake()
    assert.equal(f.calls(), 3)
    assert.equal(f.article().classifications[0].origin, 'manual')
    assert.equal(f.article().classifications[0].included, true)
    f.rss.organization.setManual({ itemId: 'story', definitionId: 'curated', expectedArticleRevision: f.article().revision, expectedRuleRevision: 1, decision: null })
    assert.equal(f.article().classifications[0].included, false)
    assert.equal(f.article().classifications[0].stale, false)
    assert.equal(f.article().classifications[0].reason, 'Release A')
  } finally { await f.runner.stop(); f.db.close() }
})

test('a same-version event correction retires the superseded evidence before future candidates read it', async (testContext) => {
  if (skipIfSqliteUnavailable(testContext, 'RSS native storage')) return
  const f = fixture()
  try {
    f.body('Release A'); await f.runner.wake()
    const old = f.article().event!
    f.rss.events.apply('story', f.article().revision, f.rss.events.context('story', Date.now(), false), {
      kind: 'insufficient', eventId: null, factId: null, quote: null, sourceRole: 'unknown', reason: 'The initial association is unsupported.',
    })
    assert.equal(f.article().event?.factId, null)
    assert.equal(f.rss.events.browse().total, 0)
    assert.equal(f.rss.events.context('story', Date.now(), false).candidates.some((c) => c.id === old.eventId), false)
    f.body('Release B'); await f.runner.wake()
    f.body('Release A'); await f.runner.wake()
    assert.equal(f.calls(), 2)
    assert.equal(f.article().event?.factId, null)
    assert.equal(f.article().event?.stale, false)
  } finally { await f.runner.stop(); f.db.close() }
})

test('an interrupted restore rolls back body, classification pointer and event pointer together', async (testContext) => {
  if (skipIfSqliteUnavailable(testContext, 'RSS native storage')) return
  const f = fixture()
  try {
    f.body('Release A'); await f.runner.wake()
    f.body('Release B'); await f.runner.wake()
    const before = f.article(), raw = f.db.getRawDb()!
    raw.exec("CREATE TRIGGER fail_restore BEFORE UPDATE ON rss_event_members BEGIN SELECT RAISE(ABORT,'interrupted restore'); END")
    const loader = new RSSContentService({ content: f.rss.content,
      fetchHtml: async () => ({ html: '<article>Release A</article>', finalUrl: 'https://restore.test/story' }),
      extractor: { extract: async () => ({ title: 'Project update', contentMarkdown: 'Release A', metadata: {}, structuredData: [], metaLookup: {}, diagnostics: { confidence: 1, extractionSource: 'readability', warnings: [] } }) },
    })
    await assert.rejects(loader.load('story', true), /interrupted restore/)
    assert.equal(f.article().body.fetching, false)
    assert.match(f.article().body.error!, /interrupted restore/)
    assert.equal(f.article().revision, before.revision)
    assert.deepEqual(f.article().classifications, before.classifications)
    assert.deepEqual(f.article().event, before.event)
    raw.exec('DROP TRIGGER fail_restore')
    await loader.load('story', true); await f.runner.wake()
    await loader.stop()
    assert.equal(f.article().classifications[0].stale, false)
    assert.equal(f.calls(), 2)
  } finally { await f.runner.stop(); f.db.close() }
})

test('stale rules cannot select articles in either query or export and deleted results do not erase paid attempts', async (testContext) => {
  if (skipIfSqliteUnavailable(testContext, 'RSS native storage')) return
  const f = fixture()
  try {
    const topic = f.rss.organization.save({ name: 'Releases', description: 'New releases' })
    f.body('Release A'); await f.runner.wake()
    assert.equal(f.rss.content.query({ collectionId: topic.id }).total, 1)
    assert.equal(f.rss.getRSSStats().categories.find((c) => c.id === topic.id)?.count, 1)
    const current = f.rss.organization.list().find((d) => d.id === topic.id)!
    const changed = f.rss.organization.save({ id: current.id, name: current.name, expectedRevision: current.revision, description: 'Only independently verified releases' })
    assert.equal(f.rss.content.query({ collectionId: topic.id }).total, 0)
    assert.equal(f.rss.getRSSStats().categories.find((c) => c.id === topic.id), undefined)
    const { generateCategoryFeeds } = await import('../main/modules/rss-engine/feed-generator')
    assert.doesNotMatch(generateCategoryFeeds(f.rss.getAllRSSItems(), [], f.rss.organization.list())[topic.id], /<item>/)
    const calls = f.rss.processing.status(Date.now(), true).callsToday
    f.rss.organization.remove({ id: topic.id, expectedRevision: changed.revision })
    assert.equal(f.db.getRawDb()!.prepare('SELECT COUNT(*) AS n FROM rss_classification_results WHERE definition_id=?').get<{ n: number }>(topic.id)!.n, 0)
    f.rss.deleteRSSItems(['story'])
    assert.equal(f.db.getRawDb()!.prepare('SELECT COUNT(*) AS n FROM rss_classification_results').get<{ n: number }>()!.n, 0)
    assert.equal(f.rss.processing.status(Date.now(), true).callsToday, calls)
  } finally { await f.runner.stop(); f.db.close() }
})

test('a reopened database restores a returning body from saved results and keeps call accounting', async (testContext) => {
  if (skipIfSqliteUnavailable(testContext, 'RSS native storage')) return
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), 'rss-restoration-reopen-')), path = join(directory, 'ready.db')
  let reopened: DatabaseConnection | undefined
  try {
    f.body('Release A'); await f.runner.wake()
    const a = f.article()
    f.body('Release B'); await f.runner.wake()
    f.db.getRawDb()!.prepare('VACUUM INTO ?').run(path)
    await f.runner.stop(); f.db.close()
    const SQLite = createRequire(import.meta.url)('better-sqlite3')
    reopened = new SQLite(path)
    const rss = new RSSStore(() => reopened || null)
    rss.processing.recover(); rss.content.recoverInterruptedLoads()
    assert.equal(rss.content.finishLoad(rss.content.beginLoad('story')!, { status: 'ready', markdown: 'Release A', sourceUrl: 'https://restore.test/story' }), true)
    const restored = rss.content.getArticle('story')!
    assert.deepEqual(restored.classifications, a.classifications)
    assert.equal(restored.event?.factId, a.event?.factId)
    assert.equal(restored.event?.stale, false)
    assert.equal(rss.processing.status(Date.now(), true).callsToday, 2)
    assert.equal(rss.processing.status(Date.now(), true).pending, 0)
    assert.deepEqual(reopened!.prepare('PRAGMA foreign_key_check').all(), [])
  } finally { await f.runner.stop(); reopened?.close(); f.db.close(); rmSync(directory, { recursive: true, force: true }) }
})
