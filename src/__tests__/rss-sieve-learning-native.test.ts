import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseManager } from '../main/modules/database'
import { runMigrations } from '../main/modules/migrations'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('migration replay preserves data, removes ai_score; V2 feedback persists and V3 never rewrites focus', t => {
  if (skipIfSqliteUnavailable(t, 'RSS sieve')) return
  const db = new DatabaseManager(true)
  try {
    const source = db.rss.addRSSSource({ name: 'Source', url: 'https://example.test/feed' })
    db.rss.upsertRSSItems(['one', 'two'].map(id => ({ id, source_id: source, guid: id, title: id, link: `https://example.test/${id}` })))
    const sieve = db.rss.sieve
    sieve.saveFocus({ text: '手写关注', expectedVersion: 0 })
    const before = sieve.preference('source', source)
    const feedback = { id: 'feedback-1', itemId: 'one', action: 'less' as const, reason: 'source' as const, at: 1000 }
    sieve.recordBehavior(feedback)
    assert.ok(sieve.preference('source', source) < before)
    const after = sieve.preference('source', source)
    sieve.recordBehavior(feedback)
    assert.equal(sieve.preference('source', source), after, 'replayed action cannot double count')
    assert.equal(sieve.behaviors('one').length, 1)
    assert.throws(() => sieve.recordBehavior({ ...feedback, action: 'more' }), /已使用/)
    sieve.recordBehavior({ id: 'read', itemId: 'two', action: 'finish', at: 2000 })
    assert.deepEqual(sieve.focus(), { text: '手写关注', version: 1 })
    runMigrations(db.getRawDb()!)
    assert.equal(sieve.behaviors('one').length, 1)
    assert.equal(db.getRawDb()!.prepare('PRAGMA table_info(rss_items)').all<{name:string}>().some(c => c.name === 'ai_score'), false)
    assert.equal(sieve.recordDelivery('one', 1000), true)
    assert.equal(sieve.recordDelivery('one', 2000), false)
    assert.equal(sieve.delivery('one'), 1000)
  } finally { db.close() }
})
