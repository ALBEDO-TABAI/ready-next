import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseManager } from '../main/modules/database'
import { generateCategoryFeeds } from '../main/modules/rss-engine/feed-generator'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('RSS classification survives persistence, refresh without classification and category export', (t) => {
  if (skipIfSqliteUnavailable(t, 'RSS classification persistence')) return
  const db = new DatabaseManager(true)
  try {
    const sourceId = db.rss.addRSSSource({ name: 'Test feed', url: 'https://example.test/feed' })
    const item = {
      id: 'classification-item', source_id: sourceId, guid: 'classification-item',
      title: '设计案例', link: 'https://example.test/article', ai_tags: '设计',
    }
    db.rss.upsertRSSItems([item])
    assert.equal(db.rss.getRSSItemsByIds([item.id])[0]?.ai_tags, '设计')
    db.rss.markRSSRead(item.id)
    db.rss.dismissRSSItemsFromInbox([item.id])
    db.rss.upsertRSSItems([{ ...item, title: '更新的设计案例', ai_tags: null }])
    const [saved] = db.rss.getRSSItemsByIds([item.id])
    assert.equal(saved?.ai_tags, '设计', 'not classifying a refresh must not erase the saved category')
    assert.equal(saved?.read, 1)
    assert.equal(saved?.inbox_visible, 0)
    assert.equal(db.rss.getRSSStats().categoryDistribution['设计'], 1)
    const feeds = generateCategoryFeeds(db.rss.getAllRSSItems(), db.rss.getRSSSources())
    assert.match(feeds.design, /更新的设计案例/)
    assert.doesNotMatch(feeds.others, /更新的设计案例/)
    db.rss.upsertRSSItems([{ ...item, ai_tags: '科技' }])
    assert.equal(db.rss.getRSSItemsByIds([item.id])[0]?.ai_tags, '科技')
  } finally {
    db.close()
  }
})
