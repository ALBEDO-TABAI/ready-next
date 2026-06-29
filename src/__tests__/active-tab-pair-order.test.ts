import assert from 'node:assert/strict'
import test from 'node:test'

import { getActiveTabPairOrder } from '../renderer/modules/workbench/active-tab-pair-order'

test('active tab pair order keeps the secondary active tab directly below the primary active tab', () => {
  const tabs = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
    { id: 'd' },
  ]

  const ordered = getActiveTabPairOrder(tabs, 'b', 'd')

  assert.deepEqual(ordered.map((item) => item.tab.id), ['a', 'b', 'd', 'c'])
  assert.deepEqual(ordered.map((item) => item.sourceIndex), [0, 1, 3, 2])
})

test('active tab pair order leaves tabs unchanged without a valid active pair', () => {
  const tabs = [
    { id: 'a' },
    { id: 'b' },
  ]

  assert.deepEqual(getActiveTabPairOrder(tabs, 'a', null).map((item) => item.tab.id), ['a', 'b'])
  assert.deepEqual(getActiveTabPairOrder(tabs, 'a', 'missing').map((item) => item.tab.id), ['a', 'b'])
})
