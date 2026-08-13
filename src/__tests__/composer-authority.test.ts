import assert from 'node:assert/strict'
import test from 'node:test'

import {
  captureComposerAuthority,
  isComposerAuthorityCurrent,
  type ComposerAuthorityState,
} from '../renderer/modules/agent/composer-authority'

function makeState(overrides: Partial<ComposerAuthorityState> = {}): ComposerAuthorityState {
  return {
    activeSessionId: 'session-a',
    currentScopeId: 'scope-a',
    composerAuthorityRevision: 4,
    sessions: {
      'session-a': {
        conversationId: 'scope-a',
        aliasGeneration: 7,
        messageVisibilityEpoch: 2,
      },
      'session-b': {
        conversationId: 'scope-b',
        aliasGeneration: 3,
        messageVisibilityEpoch: 0,
      },
    },
    ...overrides,
  }
}

test('composer authority accepts the unchanged originating session', () => {
  const state = makeState()
  const authority = captureComposerAuthority(state)

  assert.equal(isComposerAuthorityCurrent(state, authority), true)
})

test('composer authority rejects a result after switching sessions', () => {
  const authority = captureComposerAuthority(makeState())
  const switched = makeState({
    activeSessionId: 'session-b',
    currentScopeId: 'scope-b',
    composerAuthorityRevision: 5,
  })

  assert.equal(isComposerAuthorityCurrent(switched, authority), false)
})

test('composer authority rejects a result after reset even when the session and scope stay open', () => {
  const authority = captureComposerAuthority(makeState())
  const reset = makeState({
    composerAuthorityRevision: 5,
    sessions: {
      ...makeState().sessions,
      'session-a': {
        conversationId: 'scope-a',
        aliasGeneration: 8,
        messageVisibilityEpoch: 3,
      },
    },
  })

  assert.equal(isComposerAuthorityCurrent(reset, authority), false)
})

test('composer authority independently rejects generation, visibility, and revision drift', () => {
  const initial = makeState()
  const authority = captureComposerAuthority(initial)

  assert.equal(isComposerAuthorityCurrent(makeState({
    sessions: {
      ...initial.sessions,
      'session-a': {
        conversationId: 'scope-a',
        aliasGeneration: 8,
        messageVisibilityEpoch: 2,
      },
    },
  }), authority), false)
  assert.equal(isComposerAuthorityCurrent(makeState({
    sessions: {
      ...initial.sessions,
      'session-a': {
        conversationId: 'scope-a',
        aliasGeneration: 7,
        messageVisibilityEpoch: 3,
      },
    },
  }), authority), false)
  assert.equal(isComposerAuthorityCurrent(makeState({
    composerAuthorityRevision: 5,
  }), authority), false)
})
