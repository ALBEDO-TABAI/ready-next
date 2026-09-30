import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseManager } from '../main/modules/database'
import type { RSSEventDecision } from '../shared/rss-events'
import { RSSProcessingService } from '../main/modules/rss-engine/processing-service'
import { executeRSSTool } from '../main/modules/tools/rss-tools'

function fixture() {
  const db = new DatabaseManager(true)
  const source = db.rss.addRSSSource({ name: 'Publisher', url: 'https://example.test/feed' })
  const put = (id: string, text = 'Version 2 was released.') => db.rss.upsertRSSItems([{ id, source_id: source, guid: id, title: id, link: `https://example.test/${id}`, summary: text }])
  const context = (id: string) => db.rss.events.context(id, Date.now())
  const apply = (id: string, decision: RSSEventDecision, expected = context(id)) => db.rss.events.apply(id, db.rss.content.getArticle(id)!.revision, expected, decision)
  const fresh = (id: string) => apply(id, { kind: 'new', eventId: null, factId: null, quote: 'Version 2 was released.', sourceRole: 'direct', reason: 'New release with an exact quotation.' })
  return { db, source, put, context, apply, fresh }
}

test('event and fact identity distinguish duplicate reports from progress without copying articles', () => {
  const f = fixture()
  try {
    f.put('original'); f.put('duplicate'); f.put('progress', 'Version 2 added video support.')
    f.fresh('original')
    const original = f.db.rss.events.memberships(['original']).original!
    f.apply('duplicate', { kind: 'duplicate', eventId: original.eventId, factId: original.factId, quote: 'Version 2 was released.', sourceRole: 'secondary', reason: 'Reports the same release.' })
    f.apply('progress', { kind: 'progress', eventId: original.eventId, factId: null, quote: 'Version 2 added video support.', sourceRole: 'direct', reason: 'New supported feature.' })
    const event = f.db.rss.events.read({ eventId: original.eventId!, limit: 1 })
    assert.equal(event.total, 3); assert.equal(event.summary.factCount, 2)
    assert.equal(event.summary.sourceCount, 1)
    assert.equal(event.summary.unreadCount, 3)
    f.db.rss.markRSSRead('original'); f.db.rss.toggleRSSStarred('duplicate')
    const after = f.db.rss.events.read({ eventId: original.eventId! })
    assert.equal(after.summary.unreadCount, 2); assert.equal(after.summary.starredCount, 1)
    assert.equal(f.db.rss.getAllRSSItems().length, 3)
    assert.equal(f.db.rss.events.memberships(['duplicate']).duplicate!.factId, original.factId)
  } finally { f.db.close() }
})

test('old candidate revisions, fabricated quotations and foreign facts cannot form events', () => {
  const f = fixture()
  try {
    f.put('one'); f.put('two'); f.fresh('one')
    const context = f.context('two'), candidate = context.candidates[0]
    const decision: RSSEventDecision = { kind: 'duplicate', eventId: candidate.id, factId: candidate.facts[0].id, quote: 'Version 2 was released.', sourceRole: 'secondary', reason: 'same' }
    assert.throws(() => f.apply('two', { ...decision, factId: 'foreign' }, context), /事实/)
    assert.throws(() => f.apply('two', { ...decision, quote: 'Invented statement' }, context), /原文/)
    f.put('one', 'Corrected source statement.')
    assert.throws(() => f.apply('two', decision, context), /变化/)
    assert.equal(f.db.rss.events.memberships(['two']).two, undefined)
  } finally { f.db.close() }
})

test('manual split, move and merge persist ahead of late model decisions and preserve reader state', () => {
  const f = fixture()
  try {
    for (const id of ['one', 'two', 'three']) { f.put(id); f.fresh(id) }
    const before = f.context('two')
    const memberships = f.db.rss.events.memberships(['one', 'two', 'three'])
    const revision = f.db.rss.content.getArticle('two')!.revision
    f.db.rss.events.move({ itemId: 'two', expectedArticleRevision: revision, expectedMembershipRevision: memberships.two!.revision,
      targetEventId: memberships.one!.eventId, expectedEventRevision: f.db.rss.events.read({ eventId: memberships.one!.eventId! }).summary.revision })
    const manual = f.db.rss.events.memberships(['two']).two!
    assert.equal(manual.manual, true); assert.equal(manual.eventId, memberships.one!.eventId)
    assert.equal(f.apply('two', { kind: 'new', eventId: null, factId: null, quote: 'Version 2 was released.', sourceRole: 'unknown', reason: 'late' }, before), 'manual_preserved')
    const left = f.db.rss.events.read({ eventId: memberships.one!.eventId! }).summary
    const right = f.db.rss.events.read({ eventId: memberships.three!.eventId! }).summary
    const oldTargetContext = f.context('three')
    f.db.rss.events.merge({ fromEventId: left.id, expectedFromRevision: left.revision, intoEventId: right.id, expectedIntoRevision: right.revision })
    assert.equal(f.db.rss.events.read({ eventId: right.id }).total, 3)
    assert.equal(f.apply('three', { kind: 'new', eventId: null, factId: null, quote: 'Version 2 was released.', sourceRole: 'unknown', reason: 'late target result' }, oldTargetContext), 'manual_preserved')
    const moved = f.db.rss.events.memberships(['two']).two!
    f.db.rss.events.move({ itemId: 'two', expectedArticleRevision: revision, expectedMembershipRevision: moved.revision, targetEventId: null })
    assert.notEqual(f.db.rss.events.memberships(['two']).two!.eventId, right.id)
    assert.equal(f.db.rss.content.getArticle('two')!.revision, revision)
    assert.equal(f.db.rss.content.getArticle('two')!.read, false)
  } finally { f.db.close() }
})

test('moving one duplicate does not move its siblings or rewrite the original fact availability', () => {
  const f = fixture()
  try {
    f.put('one'); f.put('two'); f.fresh('one')
    const original = f.db.rss.events.memberships(['one']).one!
    f.apply('two', { kind: 'duplicate', eventId: original.eventId, factId: original.factId, quote: 'Version 2 was released.', sourceRole: 'secondary', reason: 'same fact' })
    const ownTime = f.db.getRawDb()!.prepare("SELECT MIN(captured_at) AS time FROM rss_event_evidence WHERE item_id='two'").get<{ time: number }>()!.time
    const other = f.db.rss.events.memberships(['two']).two!
    f.db.rss.events.move({ itemId: 'two', expectedArticleRevision: f.db.rss.content.getArticle('two')!.revision, expectedMembershipRevision: other.revision, targetEventId: null })
    const after = f.db.rss.events.memberships(['one', 'two'])
    assert.equal(after.one!.factId, original.factId)
    assert.equal(after.one!.eventId, original.eventId)
    assert.notEqual(after.two!.factId, original.factId)
    assert.equal(f.db.rss.events.read({ eventId: after.two!.eventId! }).members[0].factAvailableAt, ownTime)
  } finally { f.db.close() }
})

test('body completion can compare its explicitly historical fact without creating a new story', () => {
  const f = fixture()
  try {
    f.put('one'); f.fresh('one')
    const original = f.db.rss.events.memberships(['one']).one!
    f.db.rss.content.finishLoad(f.db.rss.content.beginLoad('one')!, { status: 'ready', markdown: 'Version 2 was released. Full details.', sourceUrl: 'https://example.test/one' })
    const context = f.context('one'), own = context.candidates.find((event) => event.id === original.eventId)!
    assert.equal(own.facts[0].historical, true)
    f.apply('one', { kind: 'duplicate', eventId: original.eventId, factId: original.factId, quote: 'Version 2 was released.', sourceRole: 'direct', reason: 'Full text confirms the same fact.' }, context)
    assert.equal(f.db.rss.events.memberships(['one']).one!.factId, original.factId)
    assert.equal(f.db.rss.events.memberships(['one']).one!.stale, false)
  } finally { f.db.close() }
})

test('insufficient evidence remains explicit and deleting members invalidates event reads', () => {
  const f = fixture()
  try {
    f.put('one'); f.fresh('one'); f.put('uncertain')
    f.apply('uncertain', { kind: 'insufficient', eventId: null, factId: null, quote: null, sourceRole: 'unknown', reason: 'Multiple unrelated announcements.' })
    assert.equal(f.db.rss.events.memberships(['uncertain']).uncertain!.eventId, null)
    const eventId = f.db.rss.events.memberships(['one']).one!.eventId!
    const before = f.db.rss.events.read({ eventId }).summary.revision
    f.db.rss.deleteRSSItems(['one'])
    assert.throws(() => f.db.rss.events.read({ eventId, expectedRevision: before }), /变化|不存在/)
  } finally { f.db.close() }
})

test('one explicit batch owns event judgment and saving the identical body never creates another paid input', async () => {
  const f = fixture()
  try {
    for (let i = 0; i < 17; i++) f.db.rss.organization.save({ name: `Topic ${i}`, description: `Description ${i}` })
    f.db.rss.setRSSSourceDraftSeeded(f.source, true); f.put('one')
    const saveBody = () => f.db.rss.content.finishLoad(f.db.rss.content.beginLoad('one')!, { status: 'ready', markdown: 'Version 2 was released. Full details.', sourceUrl: 'https://example.test/one' })
    saveBody()
    const version = f.db.rss.content.getArticle('one')!.revision
    assert.equal(f.db.rss.processing.list().jobs.filter((job) => job.articleRevision === version && job.eventRequested).length, 1)
    let calls = 0, eventCalls = 0
    const worker = new RSSProcessingService({ store: f.db.rss.processing, getArticle: (id) => f.db.rss.content.getArticle(id), hasModel: () => true, now: Date.now, notify: () => {},
      prepare: (input) => async () => {
        calls++
        const event = input.eventContext ? { kind: 'new', eventId: null, factId: null, quote: 'Version 2 was released.', sourceRole: 'direct', reason: 'Independent release.' } : undefined
        if (event) eventCalls++
        return JSON.stringify({ ...(event ? { event } : {}), decisions: input.definitions.map((d) => ({ definitionId: d.id, included: true, reason: 'Relevant', evidence: 'Version 2' })) })
      } })
    await worker.wake()
    assert.equal(calls, 3); assert.equal(eventCalls, 1)
    const first = f.db.rss.events.memberships(['one']).one!
    saveBody(); await worker.wake()
    assert.equal(calls, 3)
    assert.equal(f.db.rss.events.memberships(['one']).one!.factId, first.factId)
  } finally { f.db.close() }
})

test('a new fact in the same article preserves previous version evidence for reading and future deduplication', () => {
  const f = fixture()
  try {
    f.put('one'); f.fresh('one')
    const original = f.db.rss.events.memberships(['one']).one!
    f.put('one', 'Version 2 added video support.')
    f.apply('one', { kind: 'progress', eventId: original.eventId, factId: null, quote: 'Version 2 added video support.', sourceRole: 'direct', reason: 'A later development.' })
    const facts = f.db.rss.events.readFacts({ eventId: original.eventId! })
    assert.equal(facts.total, 2)
    const old = facts.facts.find((fact) => fact.id === original.factId)!
    assert.equal(old.quote, 'Version 2 was released.')
    assert.equal(old.articleRevision, original.articleRevision)
    assert.equal(old.historical, true)
    f.put('reprint')
    const context = f.context('reprint')
    assert.ok(context.candidates.find((event) => event.id === original.eventId)!.facts.some((fact) => fact.id === original.factId))
    f.apply('reprint', { kind: 'duplicate', eventId: original.eventId, factId: original.factId, quote: 'Version 2 was released.', sourceRole: 'secondary', reason: 'Reprints the first fact.' }, context)
    assert.equal(f.db.rss.events.summary(original.eventId!).factCount, 2)
    f.db.rss.deleteRSSItems(['one'])
    const remaining = f.db.rss.events.readFacts({ eventId: original.eventId! })
    assert.equal(remaining.total, 1)
    assert.equal(remaining.facts[0].itemId, 'reprint')
  } finally { f.db.close() }
})

test('group cards filter before pagination and expanded queries keep every matching article', () => {
  const f = fixture()
  try {
    f.put('original'); f.fresh('original')
    const event = f.db.rss.events.memberships(['original']).original!
    for (let i = 0; i < 7; i++) {
      const id = `matching-${i}`; f.put(id)
      f.apply(id, { kind: 'duplicate', eventId: event.eventId, factId: event.factId, quote: 'Version 2 was released.', sourceRole: 'secondary', reason: 'Same fact' })
    }
    f.put('matching-alone')
    const first = f.db.rss.content.cards({ search: 'matching', limit: 1 })
    assert.equal(first.total, 8); assert.equal(first.cardTotal, 2)
    const second = f.db.rss.content.cards({ ...first.query, cursor: first.nextCursor!, expectedRevision: first.revision })
    const cards = [...first.items, ...second.items]
    assert.equal(cards.filter((item) => item.eventGroup?.id === event.eventId).length, 1)
    assert.equal(cards.find((item) => item.eventGroup)?.eventGroup?.matchingCount, 7)
    assert.ok(cards.find((item) => item.eventGroup)?.id.startsWith('matching-'))
    const expanded = f.db.rss.content.query({ search: 'matching', eventId: event.eventId!, limit: 3 })
    assert.equal(expanded.total, 7)
    assert.equal(f.db.rss.content.query({ search: 'matching' }).total, 8, 'raw query keeps every article')
    assert.throws(() => f.db.rss.content.query({ ...first.query, cursor: first.nextCursor! }), /cursor_query_mismatch/)
  } finally { f.db.close() }
})

test('seen facts survive duplicate reports; new progress is distinct and Agent reading does not acknowledge it', async () => {
  const f = fixture()
  try {
    f.put('one'); f.fresh('one'); f.put('two')
    const original = f.db.rss.events.memberships(['one']).one!
    const context = f.context('two')
    f.db.rss.events.markSeen({ factIds: [original.factId!] })
    assert.equal(f.db.rss.events.summary(original.eventId!).unseenFactCount, 0)
    f.apply('two', { kind: 'duplicate', eventId: original.eventId, factId: original.factId, quote: 'Version 2 was released.', sourceRole: 'secondary', reason: 'same fact' }, context)
    assert.equal(f.db.rss.events.summary(original.eventId!).unseenFactCount, 0)
    f.put('progress', 'Version 2 supports photos.')
    f.apply('progress', { kind: 'progress', eventId: original.eventId, factId: null, quote: 'Version 2 supports photos.', sourceRole: 'direct', reason: 'New development' })
    const read = JSON.parse(await executeRSSTool('rss_read_events', { view: 'facts', eventId: original.eventId }, { getEvents: () => f.db.rss.events }))
    assert.equal(read.data.facts.length, 2); assert.equal(read.data.summary.unseenFactCount, 1)
    assert.equal(f.db.rss.events.summary(original.eventId!).unseenFactCount, 1)
    assert.equal(f.db.rss.content.getArticle('two')!.read, false, 'fact acknowledgment must not mark other articles as read')
    const denied = JSON.parse(await executeRSSTool('rss_read_events', {}, { readAccessDenied: true, getEvents: () => { throw new Error('must not read') } }))
    assert.equal(denied.error, 'rss_read_not_authorized')
  } finally { f.db.close() }
})

test('a second queued classification plan reuses an event judgment completed for the same article and method', async () => {
  const f = fixture()
  try {
    f.db.rss.setRSSSourceDraftSeeded(f.source, true); f.put('one')
    f.db.rss.organization.save({ name: 'Later topic', description: 'A newly requested classification' })
    f.db.rss.processing.enqueue('one', 'manual')
    let eventCalls = 0
    const worker = new RSSProcessingService({ store: f.db.rss.processing, getArticle: (id) => f.db.rss.content.getArticle(id), hasModel: () => true, now: Date.now, notify: () => {},
      prepare: (input) => async () => {
        const event = input.eventContext && !input.eventContext.manual && !input.eventContext.reused
          ? { kind: 'new', eventId: null, factId: null, quote: 'Version 2 was released.', sourceRole: 'direct', reason: 'Independent release' } : undefined
        if (event) eventCalls++
        return JSON.stringify({ ...(event ? { event } : {}), decisions: input.definitions.map((d) => ({ definitionId: d.id, included: true, reason: 'Relevant', evidence: 'Version 2' })) })
      } })
    await worker.wake()
    assert.equal(eventCalls, 1)
    assert.equal(f.db.rss.events.browse().total, 1)
    assert.equal(f.db.rss.content.getArticle('one')!.classifications.length, 2)
  } finally { f.db.close() }
})

test('moving the current article version preserves earlier evidence of the same fact in its original event', () => {
  const f = fixture()
  try {
    f.put('one'); f.fresh('one')
    const original = f.db.rss.events.memberships(['one']).one!
    f.db.rss.content.finishLoad(f.db.rss.content.beginLoad('one')!, { status: 'ready', markdown: 'Version 2 was released. Full details.', sourceUrl: 'https://example.test/one' })
    f.apply('one', { kind: 'duplicate', eventId: original.eventId, factId: original.factId, quote: 'Version 2 was released.', sourceRole: 'direct', reason: 'Same fact in the complete version.' })
    const full = f.db.rss.events.memberships(['one']).one!
    const moved = f.db.rss.events.move({ itemId: 'one', expectedArticleRevision: full.articleRevision, expectedMembershipRevision: full.revision, targetEventId: null })
    assert.notEqual(moved.factId, original.factId)
    const oldFacts = f.db.rss.events.readFacts({ eventId: original.eventId! })
    assert.equal(oldFacts.total, 1)
    assert.equal(oldFacts.facts[0].articleRevision, original.articleRevision)
    assert.equal(oldFacts.facts[0].historical, true)
    assert.equal(f.db.rss.events.readFacts({ eventId: moved.eventId! }).facts[0].articleRevision, full.articleRevision)
  } finally { f.db.close() }
})

test('restoring historical evidence follows a later event merge and never revives a withdrawn latest decision', () => {
  const f = fixture()
  try {
    f.put('one'); f.fresh('one'); f.put('target'); f.fresh('target')
    const original = f.db.rss.events.memberships(['one']).one!, target = f.db.rss.events.memberships(['target']).target!
    f.db.rss.content.finishLoad(f.db.rss.content.beginLoad('one')!, { status: 'ready', markdown: 'Version 2 was released. Full details.', sourceUrl: 'https://example.test/one' })
    f.apply('one', { kind: 'insufficient', eventId: null, factId: null, quote: null, sourceRole: 'unknown', reason: 'No single main event.' })
    f.db.rss.events.merge({ fromEventId: original.eventId!, intoEventId: target.eventId!, expectedFromRevision: f.db.rss.events.summary(original.eventId!).revision, expectedIntoRevision: f.db.rss.events.summary(target.eventId!).revision })
    // Restore the actual original material, not a new source identity.
    const raw = f.db.getRawDb()!
    raw.prepare('DELETE FROM rss_article_content WHERE item_id=?').run('one')
    assert.equal(f.db.rss.events.restore('one', original.articleRevision), true)
    assert.equal(f.db.rss.events.memberships(['one']).one!.eventId, target.eventId)
    assert.equal(f.db.rss.events.memberships(['one']).one!.factId, original.factId)
    raw.prepare("UPDATE rss_event_evidence SET withdrawn=1 WHERE item_id='one' AND article_revision=?").run(original.articleRevision)
    assert.equal(f.db.rss.events.restore('one', original.articleRevision), false)
  } finally { f.db.close() }
})
