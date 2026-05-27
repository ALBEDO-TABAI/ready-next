import assert from 'node:assert/strict'
import test from 'node:test'

import {
  findExistingRSSSourceByUrl,
  normalizeRSSSourceUrl,
} from '../main/modules/rss-engine/source-url'

test('RSS source URL lookup treats normalized URLs as the same source', () => {
  const sources = [
    { id: 'hn', url: 'https://hnrss.org/frontpage' },
    { id: 'other', url: 'not a url' },
  ]

  assert.equal(normalizeRSSSourceUrl('https://hnrss.org/frontpage'), 'https://hnrss.org/frontpage')
  assert.equal(findExistingRSSSourceByUrl(sources, 'https://hnrss.org/frontpage')?.id, 'hn')
  assert.equal(findExistingRSSSourceByUrl(sources, 'not a url'), null)
})
