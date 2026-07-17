import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearAll,
  clearFitted,
  getBrowserTabFitKey,
  isFitted,
  markFitted,
  shouldClearFittedForTabUpdate,
} from '../renderer/modules/browser/browserTabFitRegistry'

test('browser tab fit cache is scoped to the measured host bounds', () => {
  clearAll()
  const wide = getBrowserTabFitKey({ width: 900, height: 640 })
  const narrow = getBrowserTabFitKey({ width: 520, height: 640 })
  assert.equal(wide, '900x640')
  assert.equal(narrow, '520x640')

  assert.ok(wide)
  markFitted('tab-a', wide)

  assert.equal(isFitted('tab-a', wide), true)
  assert.ok(narrow)
  assert.equal(isFitted('tab-a', narrow), false)

  clearFitted('tab-a')
  assert.equal(isFitted('tab-a', wide), false)
})

test('browser tab fit cache clears only for updates that can change page layout or tab lifetime', () => {
  assert.equal(shouldClearFittedForTabUpdate({ type: 'patch', url: 'https://example.com' }), true)
  assert.equal(shouldClearFittedForTabUpdate({ type: 'patch', loading: true }), true)
  assert.equal(shouldClearFittedForTabUpdate({ type: 'closed' }), true)

  assert.equal(shouldClearFittedForTabUpdate({ type: 'patch' }), false)
  assert.equal(shouldClearFittedForTabUpdate({ type: 'patch', loading: false }), false)
})
