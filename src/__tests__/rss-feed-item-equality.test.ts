import assert from 'node:assert/strict'
import test from 'node:test'

import { isRSSFeedItemContentEqual } from '../renderer/modules/rss/rssFeedItemEquality'

const item = {
  id: 'item-1',
  title: 'Title',
  source: 'Source',
  author: 'Author',
  sourceId: 'source-1',
  summary: 'Summary',
  publishedAt: 'Today',
  read: false,
  starred: false,
  link: 'https://example.test/item-1',
}

test('RSS row memo reuses unchanged rows across whole-list snapshot replacement', () => {
  assert.equal(isRSSFeedItemContentEqual(item, { ...item }), true)
  assert.equal(isRSSFeedItemContentEqual(item, { ...item, read: true }), false)
})

test('RSS row memo redraws only when its own analysis display changes', () => {
  const analysis = { status: 'running_script', progress: 50, message: 'Working', error: null }
  assert.equal(isRSSFeedItemContentEqual(item, { ...item }, analysis, { ...analysis }), true)
  assert.equal(isRSSFeedItemContentEqual(item, { ...item }, analysis, { ...analysis, progress: 60 }), false)
})
