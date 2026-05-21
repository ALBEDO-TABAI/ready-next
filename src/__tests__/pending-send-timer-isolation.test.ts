/**
 * Stage V V3.3c — pending-send timer/buffer per-session isolation behavior test.
 *
 * Covers the four contracts established by `useAgent.ts` after the V3.3c
 * migration of the 4 send-coalescing globals to per-sessionId Maps:
 *
 *  1. Single-session regression lock — the pre-existing coalescing flow
 *     (two rapid sends into one buffer with one timer) still mutates the
 *     active-session slice and the top-level mirror exactly as before.
 *  2. Two sessions, independent buffers — writing into session A's buffer
 *     never leaks parts into session B's buffer and vice versa.
 *  3. Two sessions, independent timers — the `pendingSendTimers` Map holds
 *     two distinct handles; firing one does not flush the other.
 *  4. HMR dispose — the exported `__disposePendingSendCoalescingForHMR`
 *     hook clears outstanding timers and both Maps, simulating what the
 *     `import.meta.hot.dispose` callback runs in dev.
 *
 * Plan: docs/superpowers/plans/2026-05-21-V-stage-v-comprehensive-implementation.md
 *   §4 V3.3c
 *
 * Test strategy: drive the store directly via `useAgent.getState().sendMessage`
 * for case 1 (full integration coalescing path) and via direct slice/Map
 * inspection for cases 2-4 (isolation contract). The full sendMessage path
 * requires no electronAPI for the coalescing branch — it short-circuits and
 * returns before any IPC call is made.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import {
  __disposePendingSendCoalescingForHMR,
  __getPendingSendCoalescingFleetSizeForTesting,
  getSessionSlice,
  useAgent,
} from '../renderer/stores/useAgent'

// --- jsdom shim install — useAgent reads window for several side branches ---

function installDom(): { restore: () => void } {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost' })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
  }
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true })
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true })
  return {
    restore: () => {
      if (previous.window) {
        Object.defineProperty(globalThis, 'window', { value: previous.window, configurable: true })
      } else {
        delete (globalThis as typeof globalThis & { window?: Window }).window
      }
      if (previous.document) {
        Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true })
      } else {
        delete (globalThis as typeof globalThis & { document?: Document }).document
      }
    },
  }
}

interface SeedOptions {
  sessionId?: string
  activeSessionId?: string | null
  coalesceWindowMs?: number
}

function seedStore(opts: SeedOptions = {}) {
  // Reset to a clean state that satisfies the `shouldCoalesce` predicate:
  // no streaming, no continuation intent, coalescing enabled with window > 0.
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
    sessionId: opts.sessionId ?? 'session-test-A',
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
    sendCoalescingWindowMs: opts.coalesceWindowMs ?? 1200,
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    sessions: {},
    activeSessionId: opts.activeSessionId ?? null,
    taskDisclosureState: {},
  })
}

function resetCoalescingFleet() {
  __disposePendingSendCoalescingForHMR()
}

// --- Case 1 — single-session coalescing regression lock --------------------

test('V3.3c — single session: two rapid sends coalesce into one buffer (regression lock)', async () => {
  const dom = installDom()
  try {
    resetCoalescingFleet()
    seedStore({ sessionId: 'session-single', activeSessionId: 'session-single' })

    const firstResult = await useAgent.getState().sendMessage('hello world')
    assert.equal(firstResult.success, true, 'first coalesced send returns success')
    assert.equal(firstResult.shouldClearInput, true, 'first coalesced send clears composer')

    const secondResult = await useAgent.getState().sendMessage('second message')
    assert.equal(secondResult.success, true, 'second coalesced send returns success')

    // Top-level mirror reflects coalesced state (the existing ChatInput
    // selector path that V3.3c must not break).
    const state = useAgent.getState()
    assert.equal(state.pendingSendCount, 2, 'top-level mirror sees 2 buffered parts')
    assert.notEqual(state.pendingSendFlushAt, null, 'top-level mirror sees flushAt timestamp')

    // Slice mirrors the same — both are sourced from the same write.
    const slice = getSessionSlice(state)
    assert.equal(slice.pendingSendCount, 2, 'active-session slice sees 2 buffered parts')
    assert.equal(
      slice.pendingSendFlushAt,
      state.pendingSendFlushAt,
      'slice flushAt matches top-level mirror flushAt',
    )

    // Exactly one buffer + one timer should exist for this single session.
    const fleet = __getPendingSendCoalescingFleetSizeForTesting()
    assert.equal(fleet.buffers, 1, 'single session creates exactly one buffer')
    assert.equal(fleet.timers, 1, 'single session creates exactly one timer')
    assert.deepEqual(fleet.bufferedKeys, ['session-single'], 'buffer keyed by sessionId')
  } finally {
    resetCoalescingFleet()
    dom.restore()
  }
})

// --- Case 2 — two sessions, independent buffers ----------------------------

test('V3.3c — two sessions: writing to A buffer does not affect B buffer', async () => {
  const dom = installDom()
  try {
    resetCoalescingFleet()

    // Session A buffers one message.
    seedStore({ sessionId: 'session-A', activeSessionId: 'session-A' })
    await useAgent.getState().sendMessage('A1')
    await useAgent.getState().sendMessage('A2')
    const sliceAAfterTwo = getSessionSlice(useAgent.getState(), 'session-A')
    assert.equal(sliceAAfterTwo.pendingSendCount, 2, 'session A slice tracks 2 buffered parts')

    // Switch active session to B while preserving A's sessions Record entry.
    // Keep the existing `sessions[session-A]` slice — only the active
    // pointer changes — to model multi-session UI parking the inactive scope.
    const preservedSessions = useAgent.getState().sessions
    useAgent.setState({
      sessionId: 'session-B',
      activeSessionId: 'session-B',
      // The top-level mirror tracks the active session; reset it to 0 because
      // session B has no buffered messages yet.
      pendingSendCount: 0,
      pendingSendFlushAt: null,
      sessions: preservedSessions,
    })

    // Session B buffers one message.
    await useAgent.getState().sendMessage('B1')

    const finalState = useAgent.getState()
    const sliceA = getSessionSlice(finalState, 'session-A')
    const sliceB = getSessionSlice(finalState, 'session-B')

    assert.equal(sliceA.pendingSendCount, 2, 'session A buffer retains both parts')
    assert.equal(sliceB.pendingSendCount, 1, 'session B buffer has its own single part')
    // Slices are sourced from the per-session Map — they must be distinct
    // object identities so a write to one cannot mutate the other. (We
    // intentionally do NOT assert different flushAt values: two sends in
    // the same millisecond would race and produce equal timestamps; that
    // is not what the isolation contract is about.)
    assert.notEqual(
      finalState.sessions['session-A'],
      finalState.sessions['session-B'],
      'sessions A and B hold distinct slice object identities',
    )
    assert.notEqual(
      finalState.sessions['session-A'],
      undefined,
      'session A slice exists in sessions Record',
    )
    assert.notEqual(
      finalState.sessions['session-B'],
      undefined,
      'session B slice exists in sessions Record',
    )

    // Top-level mirror tracks the active (B) session only.
    assert.equal(finalState.pendingSendCount, 1, 'top-level mirror tracks active session B')
    assert.equal(
      finalState.pendingSendFlushAt,
      sliceB.pendingSendFlushAt,
      'top-level mirror flushAt equals active session B slice flushAt',
    )

    // Both buffer and timer Maps have two distinct entries.
    const fleet = __getPendingSendCoalescingFleetSizeForTesting()
    assert.equal(fleet.buffers, 2, 'fleet holds two buffers (A + B)')
    assert.equal(fleet.timers, 2, 'fleet holds two timers (A + B)')
    assert.deepEqual(
      [...fleet.bufferedKeys].sort(),
      ['session-A', 'session-B'],
      'fleet keys are exactly the two sessionIds',
    )
  } finally {
    resetCoalescingFleet()
    dom.restore()
  }
})

// --- Case 3 — two sessions, independent timers -----------------------------

test('V3.3c — two sessions: firing A timer does not flush B buffer', async () => {
  const dom = installDom()
  try {
    resetCoalescingFleet()

    // Seed session A with a very short coalescing window so we can let A's
    // timer fire deterministically inside the test. Session B uses the
    // default (much longer) window so its timer will NOT fire during the
    // wait window below.
    seedStore({
      sessionId: 'session-A',
      activeSessionId: 'session-A',
      coalesceWindowMs: 15,
    })
    await useAgent.getState().sendMessage('A1')

    // Switch to B with a long window. Preserve A's slice and inspect Maps.
    const preservedSessions = useAgent.getState().sessions
    useAgent.setState({
      sessionId: 'session-B',
      activeSessionId: 'session-B',
      sendCoalescingWindowMs: 10_000,
      pendingSendCount: 0,
      pendingSendFlushAt: null,
      sessions: preservedSessions,
    })
    await useAgent.getState().sendMessage('B1')

    const preFleet = __getPendingSendCoalescingFleetSizeForTesting()
    assert.equal(preFleet.buffers, 2, 'before A timer fires, both buffers exist')
    assert.equal(preFleet.timers, 2, 'before A timer fires, both timers exist')

    // Wait long enough for A's 15ms timer to elapse but not B's 10s window.
    // A's flush attempts to call sendMessage(merged) recursively; because we
    // are not running with a real IPC stack, the inner sendMessage falls
    // through past the coalescing branch (bypassCoalescingOnce=true) and
    // exits without persisting. For our isolation contract we only care
    // that A's Map entries are cleared and B's are untouched.
    await new Promise((resolve) => setTimeout(resolve, 60))

    const postFleet = __getPendingSendCoalescingFleetSizeForTesting()
    assert.equal(
      postFleet.buffers,
      1,
      'after A timer fires, only B buffer remains in fleet',
    )
    assert.equal(
      postFleet.timers,
      1,
      'after A timer fires, only B timer remains in fleet',
    )
    assert.deepEqual(
      [...postFleet.bufferedKeys],
      ['session-B'],
      'fleet now only holds session-B',
    )

    // Session B slice is untouched.
    const sliceB = getSessionSlice(useAgent.getState(), 'session-B')
    assert.equal(sliceB.pendingSendCount, 1, 'session B buffer not flushed by A timer')
  } finally {
    resetCoalescingFleet()
    dom.restore()
  }
})

// --- Case 4 — HMR dispose clears both Maps + timers ------------------------

test('V3.3c — HMR dispose clears all timers and Maps', async () => {
  const dom = installDom()
  try {
    resetCoalescingFleet()

    // Populate the fleet with two sessions worth of timers + buffers.
    seedStore({ sessionId: 'session-A', activeSessionId: 'session-A' })
    await useAgent.getState().sendMessage('A1')
    const preservedSessions = useAgent.getState().sessions
    useAgent.setState({
      sessionId: 'session-B',
      activeSessionId: 'session-B',
      pendingSendCount: 0,
      pendingSendFlushAt: null,
      sessions: preservedSessions,
    })
    await useAgent.getState().sendMessage('B1')

    const beforeDispose = __getPendingSendCoalescingFleetSizeForTesting()
    assert.equal(beforeDispose.buffers, 2, 'precondition — fleet has two buffers')
    assert.equal(beforeDispose.timers, 2, 'precondition — fleet has two timers')

    // Capture the timer handles before dispose so we can prove they were
    // cleared and would not fire later. We do this indirectly: record the
    // fleet size, dispose, wait beyond the coalescing window, then assert
    // no extra fleet entries appeared and the fleet remains empty.
    __disposePendingSendCoalescingForHMR()

    const afterDispose = __getPendingSendCoalescingFleetSizeForTesting()
    assert.equal(afterDispose.buffers, 0, 'HMR dispose clears all buffers')
    assert.equal(afterDispose.timers, 0, 'HMR dispose clears all timers')
    assert.deepEqual(afterDispose.bufferedKeys, [], 'no buffered keys remain post-dispose')

    // Wait past the default 1200ms coalescing window. If dispose had failed
    // to clear timers they would re-add slice entries via flushPendingSendBuffer.
    await new Promise((resolve) => setTimeout(resolve, 1300))

    const longAfterDispose = __getPendingSendCoalescingFleetSizeForTesting()
    assert.equal(
      longAfterDispose.buffers,
      0,
      'no buffers reappear after wait — timers were truly cleared',
    )
    assert.equal(
      longAfterDispose.timers,
      0,
      'no timers reappear after wait — disposed timers did not re-arm',
    )
  } finally {
    resetCoalescingFleet()
    dom.restore()
  }
})
