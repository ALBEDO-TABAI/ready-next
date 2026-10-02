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
      title: '设计案例', link: 'https://example.test/article',
    }
    db.rss.upsertRSSItems([item])
    const definition = db.rss.organization.save({ name: '设计', description: '设计案例' })
    db.rss.organization.setManual({ itemId: item.id, expectedArticleRevision: db.rss.content.getArticle(item.id)!.revision, definitionId: definition.id, expectedRuleRevision: definition.ruleRevision, decision: true })
    db.rss.markRSSRead(item.id)
    db.rss.dismissRSSItemsFromInbox([item.id])
    db.rss.upsertRSSItems([{ ...item, title: '更新的设计案例' }])
    const [saved] = db.rss.getRSSItemsByIds([item.id])
    assert.equal(saved?.classifications[0].name, '设计', 'refresh must not erase manual category membership')
    assert.equal(saved?.read, 1)
    assert.equal(saved?.inbox_visible, 0)
    assert.equal(db.rss.getRSSStats().categories.find((entry) => entry.id === definition.id)?.count, 1)
    const feeds = generateCategoryFeeds(db.rss.getAllRSSItems(), db.rss.getRSSSources(), db.rss.organization.list())
    assert.match(feeds[definition.id], /更新的设计案例/)
    db.rss.organization.setManual({ itemId: item.id, expectedArticleRevision: db.rss.content.getArticle(item.id)!.revision, definitionId: definition.id, expectedRuleRevision: definition.ruleRevision, decision: false })
    assert.equal(db.rss.getRSSItemsByIds([item.id])[0]?.classifications[0].included, false)
  } finally {
    db.close()
  }
})
