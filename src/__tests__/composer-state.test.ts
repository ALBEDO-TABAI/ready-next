import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveComposerState } from '../renderer/modules/agent/composer-state'

test('composer remains editable while send is unavailable', () => {
  for (const blocker of ['thread_busy', 'runtime_unverified', 'head_unavailable'] as const) {
    const state = deriveComposerState({
      hasSendableContent: true,
      sendAvailability: 'blocked',
      blocker,
      authorizationModeUpdating: false,
      destructiveOperationPending: false,
      exactStopIntentAvailable: blocker === 'head_unavailable',
    })
    assert.equal(state.editable, true, blocker)
    assert.equal(state.sendEnabled, false, blocker)
  }
})

test('only destructive ownership changes lock editing and exact ready enables send', () => {
  assert.equal(deriveComposerState({
    hasSendableContent: true,
    sendAvailability: 'ready',
    blocker: null,
    authorizationModeUpdating: false,
    destructiveOperationPending: false,
    exactStopIntentAvailable: false,
  }).sendEnabled, true)
  assert.equal(deriveComposerState({
    hasSendableContent: true,
    sendAvailability: 'blocked',
    blocker: 'thread_busy',
    authorizationModeUpdating: false,
    destructiveOperationPending: true,
    exactStopIntentAvailable: false,
  }).editable, false)
})
