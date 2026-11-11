import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RSSStore } from '../main/modules/database/rss-store'
import { rssB10Fixture } from './utils/rss-b10-fixture'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import type { RSSQueryInput } from '../shared/rss-workspace'

function allPages(rss: RSSStore, grouped: boolean, input: RSSQueryInput) {
  const read = (query: RSSQueryInput) => grouped ? rss.content.cards(query) : rss.content.query(query)
  let page = read({ ...input, limit: 2 })
  const items = [...page.items]
  while (page.nextCursor) {
    page = read({ ...page.query, cursor: page.nextCursor })
    items.push(...page.items)
  }
  return items
}

test('relevance browsing shares final scores, includes unjudged items, paginates and never exposes', async t => {
  skipIfSqliteUnavailable({ skip: message => { throw new Error(message) } }, 'B10 requires native SQLite')
  const f = rssB10Fixture(t)
  for (let i = 0; i < 6; i++) f.put(`item-${i}`, f.now - i * 3600000)
  await f.judge()
  f.put('unjudged')
  for (const id of ['item-4', 'item-5']) {
    const article = f.rss.content.getArticle(id)!
    f.rss.organization.setManual({ itemId: article.id, expectedArticleRevision: article.revision, definitionId: 'curated', expectedRuleRevision: 1, decision: true })
  }
  f.rss.sieve.recordBehavior({ id: 'less', itemId: 'item-1', action: 'less', reason: 'source', at: f.now })
  const before = f.rss.content.query({ sort: 'newest' })
  const expected = f.rss.sieve.rank(before.items, Date.now())
  assert.deepEqual(expected.slice(0, 2).map(i => i.sieve.score), [100, 100])
  assert.deepEqual(expected.slice(0, 2).map(i => i.id), ['item-4', 'item-5'])
  assert.equal(expected.at(-1)!.id, 'unjudged')
  for (const grouped of [false, true]) {
    const items = allPages(f.rss, grouped, { sort: 'relevance' })
    assert.deepEqual(items.map(i => i.id), expected.map(i => i.id))
    assert.equal(new Set(items.map(i => i.id)).size, 7)
    const read = (input: RSSQueryInput) => grouped ? f.rss.content.cards(input) : f.rss.content.query(input)
    const first = read({ sort: 'relevance', limit: 2 })
    assert.throws(() => read({ ...first.query, sort: 'newest', cursor: first.nextCursor! }), /cursor_query_mismatch/)
    const token = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString())
    assert.equal(token.sort, 'relevance')
  }
  assert.deepEqual(f.rss.content.query({ sort: 'newest' }), before)
  assert.deepEqual(before.items.map(i => i.id), ['unjudged', 'item-0', 'item-1', 'item-2', 'item-3', 'item-4', 'item-5'])
  assert.equal(f.rss.learning.metrics().screened, 0)
})

test('relevance pagination freezes freshness and rejects changed preferences', async t => {
  skipIfSqliteUnavailable({ skip: message => { throw new Error(message) } }, 'B10 requires native SQLite')
  const f = rssB10Fixture(t)
  f.put('older', f.now - 3600000)
  f.put('newer')
  await f.judge()
  const first = f.rss.content.query({ sort: 'relevance', limit: 1 })
  t.mock.method(Date, 'now', () => f.now + 86400000)
  assert.deepEqual(f.rss.content.query({ ...first.query, cursor: first.nextCursor! }).items.map(i => i.id), ['older'])
  f.rss.sieve.recordBehavior({ id: 'less', itemId: 'older', action: 'less', reason: 'source', at: f.now })
  assert.throws(() => f.rss.content.query({ ...first.query, cursor: first.nextCursor! }), /cursor_stale/)
})

test('relevance event cards use the highest matching score and preserve all filter intersections', async t => {
  skipIfSqliteUnavailable({ skip: message => { throw new Error(message) } }, 'B10 requires native SQLite')
  const f = rssB10Fixture(t)
  const topic = f.rss.organization.save({ name: '主题', description: '相关' })
  f.put('original', f.now - 7200000)
  f.put('duplicate', f.now - 3600000)
  f.put('alone')
  await f.judge()
  const original = f.rss.content.getArticle('original')!
  f.rss.events.apply(original.id, original.revision, f.rss.events.context(original.id, f.now, false), { kind: 'new', eventId: null, factId: null, quote: 'original', sourceRole: 'direct', reason: '事件' })
  const event = f.rss.events.memberships(['original']).original
  const duplicate = f.rss.content.getArticle('duplicate')!
  f.rss.events.apply(duplicate.id, duplicate.revision, f.rss.events.context(duplicate.id, f.now, false), { kind: 'duplicate', eventId: event.eventId, factId: event.factId, quote: 'duplicate', sourceRole: 'secondary', reason: '同事件' })
  f.rss.organization.setManual({ itemId: duplicate.id, expectedArticleRevision: duplicate.revision, definitionId: topic.id, expectedRuleRevision: topic.ruleRevision, decision: true })
  f.rss.toggleRSSStarred('original')
  f.rss.toggleRSSStarred('duplicate')
  f.rss.toggleRSSStarred('alone')
  const query: RSSQueryInput = { sort: 'relevance', collectionId: 'curated', categoryId: topic.id, sourceId: f.source, filter: 'starred', search: '正文', searchIn: 'body', from: f.now - 86400000, until: f.now + 1, scope: 'library' }
  const cards = allPages(f.rss, true, query)
  assert.equal(cards.length, 2)
  assert.equal(cards[0].eventGroup?.id, event.eventId)
  assert.equal(cards[0].id, 'original', 'event representative stays independent of its highest score')
  assert.equal(cards[0].eventGroup?.matchingCount, 2)
  const expected = f.rss.sieve.rank(f.rss.content.query({ ...query, sort: 'newest' }).items, Date.now(), topic.id)
  assert.deepEqual(allPages(f.rss, false, query).map(i => i.id), expected.map(i => i.id))
  assert.equal(expected[0].id, 'duplicate')
  assert.equal(f.rss.content.cards({ ...query, search: 'absent' }).cardTotal, 0)
  assert.equal(f.rss.content.query({ ...query, sourceId: 'absent' }).total, 0)
  assert.equal(f.rss.content.query({ ...query, until: f.now - 80000000 }).total, 0)
  f.rss.dismissRSSItemsFromInbox(['alone'])
  f.rss.toggleRSSStarred('alone')
  assert.equal(f.rss.content.query({ sort: 'relevance', scope: 'inbox' }).total, 2)
  assert.equal(f.rss.content.query({ sort: 'relevance', scope: 'library' }).total, 3)
  assert.equal(f.rss.learning.metrics().screened, 0)
})

test('explore appends one below-threshold unread item after top 12, exposes it and excludes it from remaining/today', async t => {
  skipIfSqliteUnavailable({ skip: message => { throw new Error(message) } }, 'B10 requires native SQLite')
  const f = rssB10Fixture(t)
  for (let i = 0; i < 13; i++) f.put(`high-${i}`)
  await f.judge()
  for (const id of ['low-a', 'low-b', 'read', 'dismissed']) f.put(id)
  f.put('old', f.now - 49 * 3600000)
  f.rss.markRSSRead('read')
  f.rss.dismissRSSItemsFromInbox(['dismissed'])
  const result = f.rss.sieve.query({}, f.now)
  assert.equal(result.items.length, 13)
  const explore = result.items.at(-1)!
  assert.equal(explore.sieve.explore, true)
  assert.equal(explore.sieve.reason, '换换口味')
  assert.ok(explore.sieve.score < 60)
  assert.ok(['low-a', 'low-b'].includes(explore.id))
  assert.ok(result.items.slice(0, 12).every(i => i.sieve.score >= 60 && !i.sieve.explore))
  assert.equal(result.remainingCount, 2)
  assert.ok(!result.remaining.some(i => i.id === explore.id))
  assert.equal(f.rss.learning.metrics(f.now).screened, 13)
  assert.equal(f.rss.sieve.query({}, f.now + 1000).items.at(-1)!.id, explore.id)
  assert.ok(f.rss.sieve.today(f.now).every(i => !i.sieve.explore))
})

test('daily exploration survives reopening and does not replace a read or removed choice', t => {
  skipIfSqliteUnavailable({ skip: message => { throw new Error(message) } }, 'B10 requires native SQLite')
  const directory = mkdtempSync(join(tmpdir(), 'rss-explore-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  for (const action of ['read', 'dismiss', 'delete'] as const) {
    const f = rssB10Fixture(t, join(directory, `${action}.sqlite`))
    f.put('a')
    f.put('b')
    const selected = f.rss.sieve.query({}, f.now).items[0]
    assert.ok(selected?.sieve.explore)
    const connection = new Database(join(directory, `${action}.sqlite`))
    t.after(() => connection.close())
    const reopened = { rss: new RSSStore(() => connection) }
    assert.equal(reopened.rss.sieve.query({}, f.now).items[0].id, selected.id)
    if (action === 'read') f.rss.markRSSRead(selected.id)
    else if (action === 'dismiss') f.rss.dismissRSSItemsFromInbox([selected.id])
    else f.rss.deleteRSSItems([selected.id])
    assert.equal(reopened.rss.sieve.query({}, f.now + 1000).items.length, 0)
    assert.equal(reopened.rss.sieve.query({}, f.now + 86400000).items.length, 1)
  }
})

test('explore settings default on, persist off/on, and today never selects or exposes low-score articles', t => {
  skipIfSqliteUnavailable({ skip: message => { throw new Error(message) } }, 'B10 requires native SQLite')
  const f = rssB10Fixture(t)
  f.put('low-a')
  f.put('low-b')
  assert.deepEqual(f.rss.sieve.settings(), { explore: true })
  assert.deepEqual(f.rss.sieve.today(f.now), [])
  assert.equal(f.rss.learning.metrics(f.now).screened, 0)
  assert.deepEqual(f.rss.sieve.saveSettings({ explore: false }), { explore: false })
  const reopened = new RSSStore(() => f.db)
  assert.deepEqual(reopened.sieve.settings(), { explore: false })
  assert.equal(reopened.sieve.query({}, f.now).items.length, 0)
  reopened.sieve.saveSettings({ explore: true })
  const chosen = reopened.sieve.query({}, f.now).items[0]
  reopened.sieve.saveSettings({ explore: false })
  assert.equal(reopened.sieve.query({}, f.now).items.length, 0)
  reopened.sieve.saveSettings({ explore: true })
  assert.equal(reopened.sieve.query({}, f.now).items[0].id, chosen.id)
})
