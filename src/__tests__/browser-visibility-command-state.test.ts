import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserVisibilityCommandState } from '../main/modules/browser-engine/visibility-command-state'

test('browser visibility command state ignores stale visibility commands', () => {
  const state = new BrowserVisibilityCommandState()

  assert.equal(state.shouldPresentHosts(), true)

  assert.equal(state.applyHide(2), true)
  assert.equal(state.shouldPresentHosts(), false)

  assert.equal(state.applyShow(1), false)
  assert.equal(state.shouldPresentHosts(), false)

  assert.equal(state.applyShow(3), true)
  assert.equal(state.shouldPresentHosts(), true)
})
