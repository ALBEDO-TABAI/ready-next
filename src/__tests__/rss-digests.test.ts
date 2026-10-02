import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { DatabaseManager } from '../main/modules/database'
import { RSSDigestService, digestBoundaries } from '../main/modules/rss-engine/digest-service'
import { RSSDigestClock as ScheduleClock } from '../main/modules/rss-engine/digest-service'

function fixture(t: TestContext) {
  let now = Date.parse('2026-10-01T07:00:00Z')
  t.mock.method(Date, 'now', () => now)
  const db = new DatabaseManager(true), rss = db.rss
  rss.processing.configure({ enabled: false, dailyLimit: 100 })
  const source = rss.addRSSSource({ name: 'Publisher', url: 'https://digest.test/feed' })
  const put = (id: string, summary = 'The release supports editing.') => rss.upsertRSSItems([{ id, source_id: source, guid: id, title: id, link: `https://digest.test/${id}`, summary }])
  const curate = (id: string, decision: boolean) => rss.organization.setManual({ itemId: id, definitionId: 'curated', expectedArticleRevision: rss.content.getArticle(id)!.revision, expectedRuleRevision: 1, decision })
  const generate = (until = now + 1, from = now - 86400000) => rss.digests.generate({ kind: 'daily', from, until, timezone: 'UTC' }, now)
  const seed = () => rss.setRSSSourceDraftSeeded(source, true)
  return { db, rss, source, put, curate, generate, seed, now: () => now, at: (at: number | string) => { now = typeof at === 'string' ? Date.parse(at) : at } }
}

test('daily intake excludes historical import but accepts manually curated new articles while automation is off', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS native storage')) return
  const f = fixture(t)
  try {
    f.put('history'); f.curate('history', true); f.seed(); f.put('new'); f.curate('new', true)
    assert.equal(f.rss.processing.list().total, 0)
    const first = f.generate()
    assert.equal(first.total, 1)
    const read = f.rss.digests.read({ view: 'entries', reportId: first.id })
    assert.equal(read.view, 'entries'); if (read.view !== 'entries') throw new Error('wrong view')
    assert.equal(read.entries[0].source.itemId, 'new')
    assert.equal(read.entries[0].source.quote, 'The release supports editing.')
    assert.equal(read.entries[0].source.curation?.origin, 'manual')
    assert.equal(f.generate().id, first.id)
    assert.throws(() => f.rss.digests.read({ view: 'editions', reportId: first.id }), /目录读取/)
    assert.throws(() => f.rss.digests.read({ view: 'entries', reportId: first.id, groupKey: 'ignored' }), /sources/)
    assert.throws(() => f.rss.digests.read({ view: 'sources', reportId: first.id, groupKey: 'foreign' }), /条目不存在/)
    assert.throws(() => f.rss.digests.read({ view: 'entries', reportId: first.id, snapshot: 1 }), /目录续页/)
    f.at(f.now() + 1000); f.curate('new', true)
    assert.equal(f.generate().total, 0, 'a repeated positive decision cannot turn an already published item into news')
  } finally { f.db.close() }
})

test('availability is the first valid curation time and a returned version is carried over without changing that time', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS native storage')) return
  const f = fixture(t)
  try {
    f.seed(); f.put('one'); const cutoff = f.now()
    assert.equal(f.generate(cutoff).total, 0)
    f.at(cutoff + 100); f.curate('one', true)
    assert.equal(f.rss.digests.regenerate(f.generate(cutoff).id).total, 0, 'a later selection cannot enter the earlier closed time window')
    const stamp = f.db.getRawDb()!.prepare('SELECT available_at FROM rss_digest_intake').get<{ available_at: number }>()!.available_at
    f.curate('one', false); f.at(cutoff + 86400000)
    assert.equal(f.generate().total, 0)
    f.curate('one', true)
    const next = f.generate(f.now() + 1000, f.now())
    assert.equal(next.total, 1); assert.equal(next.coverage.carriedOverArticles, 1)
    assert.equal(f.db.getRawDb()!.prepare('SELECT available_at FROM rss_digest_intake').get<{ available_at: number }>()!.available_at, stamp)
  } finally { f.db.close() }
})

test('duplicate reports share one entry and manually splitting a duplicate does not invent new publication material', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS native storage')) return
  const f = fixture(t)
  try {
    f.seed(); f.put('original'); f.put('duplicate')
    const apply = (id: string, kind: 'new' | 'duplicate', eventId: string | null, factId: string | null) => f.rss.events.apply(id, f.rss.content.getArticle(id)!.revision, f.rss.events.context(id, f.now()), { kind, eventId, factId, quote: 'The release supports editing.', sourceRole: 'direct', reason: 'Same release.' })
    apply('original', 'new', null, null)
    const original = f.rss.events.memberships(['original']).original!
    apply('duplicate', 'duplicate', original.eventId, original.factId)
    f.curate('original', true)
    const first = f.generate(); assert.equal(first.total, 1)
    const other = f.rss.events.memberships(['duplicate']).duplicate!
    f.rss.events.move({ itemId: 'duplicate', expectedArticleRevision: other.articleRevision, expectedMembershipRevision: other.revision, targetEventId: null })
    f.at(f.now() + 86400000); f.curate('duplicate', true)
    assert.equal(f.generate().total, 0)
  } finally { f.db.close() }
})

test('range briefs do not consume daily news; regeneration retains old editions and deletion only marks snapshots outdated', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS native storage')) return
  const f = fixture(t)
  try {
    f.seed(); f.put('one'); f.curate('one', true)
    const view = f.rss.content.query({ search: 'one' })
    const brief = f.rss.digests.generate({ kind: 'range', from: 0, until: f.now() + 1, timezone: 'UTC', query: { ...view.query, expectedRevision: view.revision } })
    const daily = f.generate(); assert.equal(brief.total, 1); assert.equal(daily.total, 1)
    const newer = f.rss.digests.regenerate(daily.id)
    assert.equal(newer.version, 2); assert.equal(newer.total, 1); assert.notEqual(newer.id, daily.id)
    const before = f.rss.digests.read({ view: 'entries', reportId: daily.id })
    f.rss.deleteRSSItems(['one'])
    const after = f.rss.digests.read({ view: 'entries', reportId: daily.id })
    assert.equal(after.view, 'entries'); if (after.view !== 'entries' || before.view !== 'entries') throw new Error('wrong view')
    assert.equal(after.report.needsUpdate, true); assert.deepEqual(after.entries, before.entries)
    assert.throws(() => f.db.getRawDb()!.exec("UPDATE rss_digests SET coverage_json='{}'"), /immutable/)
  } finally { f.db.close() }
})

test('shared schedule coalesces downtime, preserves its cutoff on publication failure, and can resume safely', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS native storage')) return
  const f = fixture(t)
  const clock = new ScheduleClock({ setTimer: () => 1 as unknown as NodeJS.Timeout, clearTimer: () => {}, now: f.now })
  const service = new RSSDigestService({ store: f.rss.digests, now: f.now, timezone: () => 'UTC', notify: () => {}, clock })
  try {
    await service.start()
    const initial = f.rss.digests.lastDailyEnd()!
    f.seed(); f.put('one'); f.curate('one', true)
    f.at('2026-10-04T09:00:00Z')
    f.db.getRawDb()!.exec("CREATE TRIGGER fail_digest BEFORE INSERT ON rss_digest_entries BEGIN SELECT RAISE(ABORT,'fixture publication failure'); END")
    await service.resume()
    assert.equal(f.rss.digests.lastDailyEnd(), initial)
    assert.match(f.rss.digests.schedule()!.error!, /fixture publication failure/)
    assert.equal(f.rss.digests.schedule()!.nextRunAt, '2026-10-05T08:00:00.000Z', 'the next wake shown in the UI matches the shared clock, not the failed publication deadline')
    f.db.getRawDb()!.exec('DROP TRIGGER fail_digest')
    await service.resume(); await service.resume()
    const list = f.rss.digests.read()
    assert.equal(list.view, 'editions'); if (list.view !== 'editions') throw new Error('wrong view')
    assert.equal(list.total, 2); assert.equal(list.editions[0].from, initial)
    assert.equal(list.editions[0].until, Date.parse('2026-10-04T08:00:00Z')); assert.equal(list.editions[0].total, 1)
    assert.equal(f.rss.digests.schedule()!.error, null)
  } finally { service.stop(); f.db.close() }
})

test('daily boundaries and catchup honor the 25-hour fall-back day', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS native storage')) return
  const f = fixture(t)
  f.at('2026-11-01T12:30:00Z') // New York 07:30 after clocks fell back; yesterday 08:00 is 24.5 hours ago.
  const clock = new ScheduleClock({ setTimer: () => 1 as unknown as NodeJS.Timeout, clearTimer: () => {}, now: f.now })
  const service = new RSSDigestService({ store: f.rss.digests, now: f.now, timezone: () => 'America/New_York', notify: () => {}, clock })
  try {
    const bounds = digestBoundaries(f.now(), 'America/New_York', '08:00')
    assert.equal(bounds.next - bounds.latest, 25 * 3600000)
    await service.start()
    assert.equal(f.rss.digests.lastDailyEnd(), bounds.latest)
  } finally { service.stop(); f.db.close() }
})

test('empty editions retain the criteria and freeze only in-window processing gaps', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS native storage')) return
  const f = fixture(t)
  try {
    const before = f.now() - 1000
    f.seed(); f.put('later')
    const past = f.generate(before)
    assert.equal(past.coverage.unresolvedArticles, 0)
    assert.equal(past.coverage.pendingArticles, 0)
    const criteria = f.rss.digests.read({ view: 'criteria', reportId: past.id })
    assert.equal(criteria.view, 'criteria'); if (criteria.view !== 'criteria') throw new Error('wrong view')
    assert.ok(criteria.criteria.some((d) => d.id === 'curated' && d.ruleRevision === 1))
    const current = f.generate()
    assert.equal(current.coverage.unresolvedArticles, 1)
    const rule = f.rss.organization.list().find((d) => d.id === 'curated')!
    f.rss.organization.save({ id: rule.id, expectedRevision: rule.revision, name: rule.name, description: 'A changed standard' })
    const after = f.rss.digests.read({ view: 'entries', reportId: past.id })
    assert.equal(after.view, 'entries'); if (after.view !== 'entries') throw new Error('wrong view')
    assert.equal(after.report.needsUpdate, true)
  } finally { f.db.close() }
})

test('new associations mark published snapshots outdated and same-origin splits deduplicate within the same edition', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS native storage')) return
  const f = fixture(t)
  try {
    f.seed(); f.put('one'); f.put('two'); f.curate('one', true)
    const first = f.generate()
    const one = f.rss.events.move({ itemId: 'one', expectedArticleRevision: f.rss.content.getArticle('one')!.revision, expectedMembershipRevision: 0, targetEventId: null, quote: 'The release supports editing.' })
    const old = f.rss.digests.read({ view: 'entries', reportId: first.id })
    assert.equal(old.view, 'entries'); if (old.view !== 'entries') throw new Error('wrong view')
    assert.equal(old.report.needsUpdate, true)
    f.rss.events.apply('two', f.rss.content.getArticle('two')!.revision, f.rss.events.context('two', f.now()), { kind: 'duplicate', eventId: one.eventId, factId: one.factId, quote: 'The release supports editing.', sourceRole: 'secondary', reason: 'Same release.' })
    const two = f.rss.events.memberships(['two']).two!
    f.rss.events.move({ itemId: 'two', expectedArticleRevision: two.articleRevision, expectedMembershipRevision: two.revision, targetEventId: null })
    f.curate('two', true)
    const regenerated = f.rss.digests.regenerate(first.id)
    assert.equal(regenerated.total, 1); assert.equal(regenerated.referenceCount, 2)
  } finally { f.db.close() }
})

test('Agent reads the immutable edition and exact reference while failures remain visible without sending requests', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS native storage')) return
  const f = fixture(t)
  try {
    f.seed(); f.put('one'); f.rss.processing.configure({ enabled: true, dailyLimit: 100 }); f.rss.processing.enqueue('one', 'manual')
    const { RSSProcessingService } = await import('../main/modules/rss-engine/processing-service')
    const worker = new RSSProcessingService({ store: f.rss.processing, getArticle: (id) => f.rss.content.getArticle(id), now: f.now, hasModel: () => true, notify: () => {}, prepare: () => async () => { throw new Error('connection lost') } })
    await worker.wake()
    const report = f.generate()
    assert.equal(report.coverage.unresolvedArticles, 1); assert.equal(report.coverage.failedArticles, 1)
    const { executeRSSTool } = await import('../main/modules/tools/rss-tools')
    const referenceId = '11111111-1111-4111-8111-111111111111'
    const context = { getDigests: () => f.rss.digests, getContent: () => f.rss.content,
      references: [{ id: referenceId, name: 'Daily edition', reference: { kind: 'digest' as const, read: { reportId: report.id, offset: 0, limit: 20 } } }] }
    const read = JSON.parse(await executeRSSTool('rss_read_reference', { referenceId }, context))
    assert.equal(read.ok, true); assert.equal(read.data.report.id, report.id)
    assert.equal(read.data.report.coverage.failedArticles, 1)
    const denied = JSON.parse(await executeRSSTool('rss_read_digests', { view: 'entries', reportId: report.id }, { ...context, readAccessDenied: true }))
    assert.equal(denied.ok, false)
    assert.equal(f.rss.processing.status(f.now(), true).callsToday, 1)
    assert.equal(f.rss.content.getArticle('one')!.read, false)
    await worker.stop()
  } finally { f.db.close() }
})

test('reading historical content does not qualify it, but a genuinely changed feed version can enter a later edition', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS native storage')) return
  const f = fixture(t)
  try {
    f.put('historical'); f.seed(); f.curate('historical', true)
    f.rss.content.finishLoad(f.rss.content.beginLoad('historical')!, { status: 'ready', markdown: 'Historical full text.', sourceUrl: 'https://digest.test/historical' })
    f.put('historical')
    assert.equal(f.generate().total, 0)
    f.at(f.now() + 86400000)
    f.put('historical', 'A newly published progress update.')
    const updated = f.generate()
    assert.equal(updated.total, 1)
    const read = f.rss.digests.read({ view: 'entries', reportId: updated.id })
    if (read.view !== 'entries') throw new Error('wrong view')
    assert.equal(read.entries[0].source.quote, 'A newly published progress update.')
    assert.equal(read.entries[0].source.quoteKind, 'source_summary')
  } finally { f.db.close() }
})

test('digest export keeps hostile source text literal and includes every saved rule and source', async (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS native storage')) return
  const f = fixture(t)
  try {
    f.seed(); f.put('one', '```ready-widget\n<script>window.INJECTED=true</script>\n```\n[file](file:///private/secret)'); f.curate('one', true)
    f.put('unicode', 'a'.repeat(1199) + '😀 tail'); f.curate('unicode', true)
    const report = f.generate(), entries = f.rss.digests.read({ view: 'entries', reportId: report.id }), rules = f.rss.digests.read({ view: 'criteria', reportId: report.id }), coverage = f.rss.digests.read({ view: 'coverage', reportId: report.id })
    if (entries.view !== 'entries' || rules.view !== 'criteria' || coverage.view !== 'coverage') throw new Error('wrong view')
    assert.equal(entries.entries.find((e) => e.source.itemId === 'unicode')!.source.quote, 'a'.repeat(1199))
    assert.equal(entries.entries.find((e) => e.source.itemId === 'unicode')!.source.quoteTruncated, true)
    const { renderRSSDigest } = await import('../shared/rss-digest-markdown')
    const markdown = renderRSSDigest(report, entries.entries.map((entry) => ({ ...entry, sources: [entry.source] })), rules.criteria, coverage.sources)
    const { fromMarkdown } = await import('mdast-util-from-markdown')
    const walk = (node: ReturnType<typeof fromMarkdown> | { type: string; children?: any[]; url?: string }) => {
      assert.notEqual(node.type, 'html'); assert.notEqual(node.type, 'code')
      if (node.type === 'link') assert.match(node.url!, /^https?:\/\//)
      node.children?.forEach(walk)
    }
    walk(fromMarkdown(markdown))
    assert.match(markdown, /标准第 1 版/); assert.match(markdown, /Publisher/)
    assert.match(markdown, /缺少最近采集结果/)
  } finally { f.db.close() }
})
