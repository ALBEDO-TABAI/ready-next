import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { selectFirstSeenSessionItems } from '../main/modules/rss-engine/session-item-store-policy'

const item = (id: string, published_at: number | null, cover = 'https://cdn/first.jpg') => ({ id, published_at, cover_image: cover })

describe('which items of a login platform are written after a refresh', () => {
  it('writes an item the first time it is seen', () => {
    assert.deepEqual(selectFirstSeenSessionItems([item('a', null), item('b', 100)], []).map((row) => row.id), ['a', 'b'])
  })

  it('leaves an item it already has as it was, whatever came back this time', () => {
    const again = [item('a', null, 'https://cdn/202611180001/resigned.jpg'), item('b', 100, 'https://cdn/another.jpg')]
    assert.deepEqual(selectFirstSeenSessionItems(again, [item('a', null), item('b', 100)]), [])
  })

  it('lets a reading that knows the publish date replace one that did not, once', () => {
    const dated = [item('a', 1_794_000_000)]
    assert.deepEqual(selectFirstSeenSessionItems(dated, [item('a', null)]).map((row) => row.id), ['a'])
    assert.deepEqual(selectFirstSeenSessionItems(dated, [item('a', 1_794_000_000)]), [])
    assert.deepEqual(
      selectFirstSeenSessionItems([item('a', null)], [item('a', 1_794_000_000)]),
      [],
      'a reading without the date never replaces one that has it',
    )
  })
})
