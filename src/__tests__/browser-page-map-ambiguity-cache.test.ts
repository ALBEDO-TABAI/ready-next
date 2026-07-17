import assert from 'node:assert/strict'
import test from 'node:test'

import {
  disposeBrowserPageMapAmbiguity,
  getBrowserPageMapAmbiguity,
  rememberBrowserPageMapAmbiguity,
  resetBrowserPageMapAmbiguityForTests,
} from '../main/modules/browser-engine/browser-page-map-ambiguity-cache'

test('page-map ambiguity state is removed with its tab runtime resources', () => {
  resetBrowserPageMapAmbiguityForTests()
  rememberBrowserPageMapAmbiguity('tab-1', [{
    role: 'button',
    name: '发布',
    targetIds: ['target-1', 'target-2'],
  }])
  assert.equal(getBrowserPageMapAmbiguity('tab-1', 'target-1')?.targetIds.length, 2)

  disposeBrowserPageMapAmbiguity('tab-1')

  assert.equal(getBrowserPageMapAmbiguity('tab-1', 'target-1'), null)
})
