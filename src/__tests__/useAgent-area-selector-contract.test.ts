/**
 * Stage W W4.5 — useAgent per-area selector contract.
 *
 * Pins two falsifiable properties for the 6 declared ownership areas
 * (session slice / runtime listeners / pending-send / persistence /
 * projection / UI selectors — see ownership-areas.md):
 *
 *   1. Each area exposes a typed selector that returns a stable view of its
 *      narrow slice. "Stable" here means: when the upstream state has not
 *      changed, two consecutive calls return either the same identity (for
 *      direct-field selectors) or deep-equal values whose underlying
 *      primitive fields are === (for normalize-on-read selectors like
 *      getSessionSlice). A future selector that loses this invariant
 *      breaks consumer memoization and is rejected by this contract.
 *
 *   2. The area's internal mutable state is not exported on the public
 *      module surface. Specifically: the pending-send coalescing Maps
 *      (`pendingSendTimers`, `pendingSendBuffers`), the runtime listener
 *      metrics object (`cardRoutingMetrics`), and the private write
 *      helper (`withSessionSliceAndActiveMirror`) must not be reachable
 *      from outside the store module.
 *
 * Plan: docs/superpowers/plans/2026-05-22-W4-useagent-ownership-implementation.md
 *       §3.5
 *
 * Test strategy: import only the declared selector surface, drive the
 * store directly via `useAgent.setState`, then assert (a) stability before
 * any mutation and (b) value transition after a targeted mutation.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import * as useAgentModule from '../renderer/stores/useAgent'
import {
  getSessionSlice,
  selectActiveScopeRunStates,
  selectActiveSessionSlice,
  selectAgents,
  selectAttachments,
  selectConversations,
  selectFilePool,
  selectPendingSendForActive,
  selectScopes,
  selectSessionOrder,
  useAgent,
  type SessionSlice,
} from '../renderer/stores/useAgent'
import { createEmptyScopeRunState } from '../renderer/modules/agent/scopeRunState'

function makeSlice(patch: Partial<SessionSlice> = {}): SessionSlice {
  return {
    messages: [],
    pendingSendCount: 0,
    pendingSendFlushAt: null,
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

function resetStore() {
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
    sendCoalescingEnabled: true,
    sendCoalescingWindowMs: 1200,
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    sessions: { 'session-A': makeSlice() },
    activeSessionId: 'session-A',
    sessionOrder: ['session-A'],
    taskDisclosureState: {},
  })
}

// ==========================================================================
// Property 1 — per-area selector stability (no upstream change → no change)
// ==========================================================================

test('W4.5 — area S: selectActiveSessionSlice / selectSessionOrder stable across no-op reads', () => {
  resetStore()
  const state1 = useAgent.getState()
  const slice1 = selectActiveSessionSlice(state1)
  const slice2 = selectActiveSessionSlice(state1)
  // Stability: same input state must yield deep-equal slices with primitive
  // field identity. getSessionSlice normalizes on read, so wrapper identity
  // isn't preserved across calls, but the primitives must be.
  assert.deepEqual(slice1, slice2, 'selectActiveSessionSlice deep-stable on no-op')
  assert.equal(slice1.inputValue, slice2.inputValue, 'inputValue primitive stable')
  assert.equal(slice1.state, slice2.state, 'slice state primitive stable')

  const order1 = selectSessionOrder(state1)
  const order2 = selectSessionOrder(state1)
  // sessionOrder is a direct field reference; selector returns the same array.
  assert.equal(order1, order2, 'selectSessionOrder returns identical reference on no-op')

  // After an irrelevant top-level update (no slice/order change), the order
  // selector reference must remain identical.
  useAgent.setState({ currentAgent: 'butler' })
  const order3 = selectSessionOrder(useAgent.getState())
  assert.equal(order1, order3, 'selectSessionOrder identity preserved across unrelated set')
})

test('W4.5 — area P: selectPendingSendForActive returns primitive-stable view', () => {
  resetStore()
  const state1 = useAgent.getState()
  const a = selectPendingSendForActive(state1)
  const b = selectPendingSendForActive(state1)
  assert.equal(a.count, b.count, 'pendingSendCount primitive stable')
  assert.equal(a.flushAt, b.flushAt, 'pendingSendFlushAt primitive stable')

  useAgent.setState({ pendingSendCount: 2, pendingSendFlushAt: 1234 })
  const c = selectPendingSendForActive(useAgent.getState())
  assert.equal(c.count, 2, 'selector reflects updated pendingSendCount')
  assert.equal(c.flushAt, 1234, 'selector reflects updated pendingSendFlushAt')
})

test('W4.5 — area J: selectActiveScopeRunStates returns referentially-stable map', () => {
  resetStore()
  const map1 = selectActiveScopeRunStates(useAgent.getState())
  const map2 = selectActiveScopeRunStates(useAgent.getState())
  assert.equal(map1, map2, 'scopeRunStates reference stable on no-op')

  const nextMap = {
    'scope-1': createEmptyScopeRunState({ scopeId: 'scope-1', agent: 'butler', phase: 'running' }),
  }
  useAgent.setState({ scopeRunStates: nextMap })
  const map3 = selectActiveScopeRunStates(useAgent.getState())
  assert.notEqual(map3, map1, 'scopeRunStates identity changes when upstream changes')
  assert.equal(map3['scope-1']?.phase, 'running')
})

test('W4.5 — area U: selectAgents / selectAttachments / selectFilePool stable on no-op', () => {
  resetStore()
  const state = useAgent.getState()
  assert.equal(selectAgents(state), selectAgents(state), 'agents reference stable')
  assert.equal(selectAttachments(state), selectAttachments(state), 'attachments reference stable')
  assert.equal(selectFilePool(state), selectFilePool(state), 'filePool reference stable')

  // Mutate attachments only — agents reference must stay stable.
  const agentsBefore = selectAgents(state)
  useAgent.setState({ attachments: [{ id: 'att-1', name: 'x', size: 1, mime: 'text/plain' } as never] })
  const agentsAfter = selectAgents(useAgent.getState())
  assert.equal(agentsBefore, agentsAfter, 'agents identity preserved across attachments-only update')
})

test('W4.5 — area D: selectConversations / selectScopes stable on no-op', () => {
  resetStore()
  const state = useAgent.getState()
  assert.equal(selectConversations(state), selectConversations(state), 'conversations reference stable')
  assert.equal(selectScopes(state), selectScopes(state), 'scopes reference stable')
})

test('W4.5 — area L: getSessionSlice + routeCardToSession compose stably for no-op', () => {
  resetStore()
  const state = useAgent.getState()
  // The listener area's "selector" surface is the pair of helpers it uses
  // to make routing decisions: getSessionSlice (per-session read) and
  // routeCardToSession (3-level fallback resolver). Both must return
  // deterministic results for the same input state.
  const slice1 = getSessionSlice(state, 'session-A')
  const slice2 = getSessionSlice(state, 'session-A')
  assert.deepEqual(slice1, slice2, 'getSessionSlice deep-stable for no-op')

  const decision1 = useAgentModule.routeCardToSession(state, {
    sessionId: 'session-A',
    conversationId: null,
    cardId: 'card-x',
  })
  const decision2 = useAgentModule.routeCardToSession(state, {
    sessionId: 'session-A',
    conversationId: null,
    cardId: 'card-x',
  })
  assert.deepEqual(decision1, decision2, 'routeCardToSession deterministic for identical input')
  assert.equal(decision1.targetSessionId, 'session-A')
})

// ==========================================================================
// Property 2 — area-internal mutable state is not exported
// ==========================================================================

test('W4.5 — pending-send Maps and runtime-listener metrics are not exported', () => {
  // The mutable coalescing Maps and listener metrics object must not be
  // reachable from outside the store. Only test-only `__get*ForTesting`
  // introspection helpers are allowed; these return read-only snapshots
  // so external code cannot mutate them.
  const exports = Object.keys(useAgentModule)

  assert.equal(exports.includes('pendingSendTimers'), false, 'pendingSendTimers Map not exported')
  assert.equal(exports.includes('pendingSendBuffers'), false, 'pendingSendBuffers Map not exported')
  assert.equal(exports.includes('cardRoutingMetrics'), false, 'cardRoutingMetrics object not exported')
  assert.equal(exports.includes('withSessionSlice'), false, 'withSessionSlice private write helper not exported')
  assert.equal(exports.includes('withSessionSliceAndActiveMirror'), false, 'withSessionSliceAndActiveMirror private write helper not exported')
  assert.equal(exports.includes('mirrorFromSessionSlice'), false, 'mirrorFromSessionSlice private helper not exported')

  // Sanity — the test-only introspection helpers are present (they are the
  // allowed read paths for the runtime-listener metrics).
  assert.equal(exports.includes('__getCardRoutingMetricsForTesting'), true, 'test-only metrics snapshot is exported')
  assert.equal(exports.includes('__resetCardRoutingMetricsForTesting'), true, 'test-only metrics reset is exported')
  assert.equal(exports.includes('__getPendingSendCoalescingFleetSizeForTesting'), true, 'test-only fleet size introspection is exported')
})
