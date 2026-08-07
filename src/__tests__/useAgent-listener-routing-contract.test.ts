/**
 * Stage W W4.7 — useAgent listener-routing 3-level fallback contract test.
 *
 * Pins the deterministic resolution order used by
 * `initAgentInteractionListeners` when a pushed ask_user_questions card
 * arrives. The chain in `routeCardToSession` is:
 *
 *   1. `event.sessionId`                       — accepted iff its alias is open
 *   2. `lookupSessionByConversation(event.conversationId)` — closed sessions skipped
 *   3. `state.activeSessionId`                 — last-resort live target
 *   (none) → orphan; `{ targetSessionId: null, metric: 'no-active-session-and-keys-null' }`.
 *
 * For each channel type / event shape, this test simulates delivery with
 * the three combinations enumerated by the plan:
 *
 *   case 1 — sessionId set    (and live) → must resolve to that sessionId
 *   case 2 — sessionId absent, conversationId set → must resolve via
 *            lookupSessionByConversation
 *   case 3 — both absent → must fall through to activeSessionId
 *
 * A closed-session case proves an explicitly retired alias is demoted, while
 * done/error/cancelled turn states remain reusable on the same Codex thread.
 *
 * Plan: docs/superpowers/plans/archive/2026-05-22-W4-useagent-ownership-implementation.md §3.7
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isLiveSession,
  lookupSessionByConversation,
  routeCardToSession,
  useAgent,
  type SessionSlice,
} from '../renderer/stores/useAgent'

function makeSlice(patch: Partial<SessionSlice> = {}): SessionSlice {
  return {
    messages: [],
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    scopeRunStates: {},
    taskDisclosureState: {},
    state: 'live',
    conversationId: null,
    inputValue: '',
    ...patch,
  }
}

function seedSessions() {
  // A/B are running aliases, C has a cancelled turn but remains open, and D
  // is explicitly closed. Active = A.
  // active = A. Used by all routing cases below; resetting before each test
  // is unnecessary because each test reseeds explicitly.
  useAgent.setState({
    agents: [{ name: 'butler', displayName: '管家', avatar: '', status: 'idle', selected: true }],
    messages: [],
    currentAgent: 'butler',
    inputValue: '',
    pendingContinuationIntent: null,
    pendingContinuationDraftAnchor: null,
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    sessionId: 'session-A',
    conversationId: 'conv-A',
    conversations: [],
    currentScopeId: 'conv-A',
    currentScope: null,
    scopes: [],
    scopeRunStates: {},
    toolTrace: [],
    toolTraceStatus: 'idle',
    attachments: [],
    filePool: [],
    activeAttachmentPreview: null,
    sessions: {
      'session-A': makeSlice({ state: 'live', conversationId: 'conv-A' }),
      'session-B': makeSlice({ state: 'live', conversationId: 'conv-B' }),
      'session-C': makeSlice({ state: 'cancelled', conversationId: 'conv-C' }),
      'session-D': makeSlice({ state: 'closed', conversationId: 'conv-D' }),
    },
    activeSessionId: 'session-A',
    sessionOrder: ['session-A', 'session-B', 'session-C', 'session-D'],
    taskDisclosureState: {},
  })
}

// ==========================================================================
// Conflicting identities — durable conversation binding wins
// ==========================================================================

test('W4.7 — conflicting live identities route only to the durable conversation binding', () => {
  seedSessions()
  const state = useAgent.getState()
  const decision = routeCardToSession(state, {
    sessionId: 'session-B',
    conversationId: 'conv-A',
    cardId: 'card-1',
  })
  assert.equal(decision.targetSessionId, 'session-A')
  assert.equal(decision.metric, 'session-conversation-conflict')
})

// ==========================================================================
// Level 2 — sessionId absent → lookup by conversation
// ==========================================================================

test('W4.7 — level 2: null sessionId, live conversationId resolves to its session', () => {
  seedSessions()
  const state = useAgent.getState()
  const decision = routeCardToSession(state, {
    sessionId: null,
    conversationId: 'conv-B',
    cardId: 'card-2',
  })
  assert.equal(decision.targetSessionId, 'session-B', 'level 2 hit on conv-B → session-B')
  assert.equal(
    decision.metric,
    'null-sessionId',
    'metric tagged null-sessionId when level 1 was null and level 2 hit',
  )
})

// ==========================================================================
// Level 3 — both absent → activeSessionId fallback
// ==========================================================================

test('W4.7 — level 3: both sessionId and conversationId absent → activeSessionId', () => {
  seedSessions()
  const state = useAgent.getState()
  const decision = routeCardToSession(state, {
    sessionId: null,
    conversationId: null,
    cardId: 'card-3',
  })
  assert.equal(decision.targetSessionId, 'session-A', 'level 3 falls back to activeSessionId')
  assert.equal(
    decision.metric,
    'null-sessionId',
    'metric tagged null-sessionId when only level 3 hit',
  )
})

// ==========================================================================
// Closed-session demotion — only an explicitly retired alias is unavailable
// ==========================================================================

test('W4.7 — closed sessionId demotes while cancelled turn remains reusable', () => {
  seedSessions()
  const state = useAgent.getState()
  assert.equal(isLiveSession(state, 'session-C'), true)
  assert.equal(lookupSessionByConversation(state, 'conv-C'), 'session-C')

  const decision = routeCardToSession(state, {
    sessionId: 'session-D',
    conversationId: null,
    cardId: 'card-4',
  })
  assert.equal(decision.targetSessionId, 'session-A', 'demoted to activeSessionId')
  assert.equal(decision.metric, 'closed-session')
})

// ==========================================================================
// Unknown-session demotion — sessionId not in the Record
// ==========================================================================

test('W4.7 — unknown sessionId demotes with metric unknown-session', () => {
  seedSessions()
  const state = useAgent.getState()
  const decision = routeCardToSession(state, {
    sessionId: 'session-not-in-store',
    conversationId: 'conv-B',
    cardId: 'card-5',
  })
  assert.equal(decision.targetSessionId, 'session-B', 'demoted to conversation lookup at level 2')
  assert.equal(decision.metric, 'unknown-session', 'metric tagged unknown-session')
})

// ==========================================================================
// Orphan — no live target anywhere
// ==========================================================================

test('W4.7 — orphan: no live target produces targetSessionId=null with orphan metric', () => {
  // Seed with NO sessions and NO activeSessionId.
  useAgent.setState({
    agents: [],
    messages: [],
    currentAgent: 'butler',
    inputValue: '',
    pendingContinuationIntent: null,
    pendingContinuationDraftAnchor: null,
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    sessionId: 'session-bootstrap',
    conversationId: null,
    conversations: [],
    currentScopeId: null,
    currentScope: null,
    scopes: [],
    scopeRunStates: {},
    toolTrace: [],
    toolTraceStatus: 'idle',
    attachments: [],
    filePool: [],
    activeAttachmentPreview: null,
    sessions: {},
    activeSessionId: null,
    sessionOrder: [],
    taskDisclosureState: {},
  })
  const state = useAgent.getState()
  const decision = routeCardToSession(state, {
    sessionId: null,
    conversationId: null,
    cardId: 'card-6',
  })
  assert.equal(decision.targetSessionId, null, 'no live target found → null')
  assert.equal(decision.metric, 'no-active-session-and-keys-null', 'orphan metric set')
})

// ==========================================================================
// Helper sanity — isLiveSession and lookupSessionByConversation agree with
// the routing decision (only explicit close removes an alias).
// ==========================================================================

test('W4.7 — isLiveSession and lookupSessionByConversation exclude only closed aliases', () => {
  seedSessions()
  const state = useAgent.getState()

  assert.equal(isLiveSession(state, 'session-A'), true, 'live session passes isLiveSession')
  assert.equal(isLiveSession(state, 'session-C'), true, 'cancelled turn keeps its alias open')
  assert.equal(isLiveSession(state, 'session-D'), false, 'closed alias fails isLiveSession')
  assert.equal(isLiveSession(state, 'session-missing'), false, 'unknown id fails isLiveSession')
  assert.equal(isLiveSession(state, null), false, 'null fails isLiveSession')

  assert.equal(
    lookupSessionByConversation(state, 'conv-A'),
    'session-A',
    'conv-A resolves to its live session',
  )
  assert.equal(
    lookupSessionByConversation(state, 'conv-B'),
    'session-B',
    'conv-B resolves to its live session',
  )
  assert.equal(
    lookupSessionByConversation(state, 'conv-C'),
    'session-C',
    'conv-C remains reusable after a cancelled turn',
  )
  assert.equal(
    lookupSessionByConversation(state, 'conv-D'),
    null,
    'conv-D is explicitly closed',
  )
  assert.equal(
    lookupSessionByConversation(state, null),
    null,
    'null conversationId → null',
  )
})

// ==========================================================================
// Conversation isolation invariant
// ==========================================================================

test('W4.7 — a supplied conversation never falls through into an unrelated active session', () => {
  seedSessions()
  const state = useAgent.getState()

  const decision = routeCardToSession(state, {
    sessionId: 'session-B',
    conversationId: 'conv-A',
    cardId: 'order-1',
  })
  assert.equal(decision.targetSessionId, 'session-A')
  assert.equal(decision.metric, 'session-conversation-conflict')

  // Now drop sessionId; level 2 must win, but we provide conv-A so the
  // result must be session-A (the conversation lookup), not session-A by
  // activeSessionId fallback (still session-A — distinguish via the
  // metric value).
  const decisionLvl2 = routeCardToSession(state, {
    sessionId: null,
    conversationId: 'conv-A',
    cardId: 'order-2',
  })
  assert.equal(decisionLvl2.targetSessionId, 'session-A', 'level 2 honored when conv lookup hits')
  // The metric distinguishes level-2 vs level-3: level-2 returns
  // 'null-sessionId' (because sessionId was null); level-3 also returns
  // 'null-sessionId' because the same code path emits the same reason
  // tag. The non-degenerate proof is the conversation having a non-active
  // mapping below.

  // A known-but-closed conversation is not allowed to bleed into active A.
  const decisionLvl3 = routeCardToSession(state, {
    sessionId: null,
    conversationId: 'conv-D', // points at a closed alias → not eligible
    cardId: 'order-3',
  })
  assert.equal(decisionLvl3.targetSessionId, null)
  assert.equal(decisionLvl3.metric, 'conversation-session-not-found')
})
