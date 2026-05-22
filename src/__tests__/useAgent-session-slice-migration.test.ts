/**
 * Stage W W4.2 — useAgent V3.3b.3 streaming per-session slice mirror migration test.
 *
 * Extends the V3.3b.1/V3.3b.2 mirror pattern (see
 * useagent-input-value-session-isolation.test.ts and multi-session-isolation.test.ts)
 * to the streaming flag group deferred from V3.3b:
 *
 *   W4.2 — `streaming` (the 5-field streaming group:
 *                       isStreaming, foregroundBusy, composerLocked,
 *                       streamingMessageId, streamingRequestId)
 *
 * The contract is the same single mirror invariant the V3.3b.1 / V3.3b.2
 * tests established:
 *
 *   1. Writing into `sessions[id].slice.<field>` while id is the active
 *      session leaves the top-level `<field>` === sessions[id].slice.<field>.
 *   2. Calling `setActiveSessionId(otherId)` where
 *      sessions[otherId].slice.<field> = Y rewrites the top-level mirror to Y
 *      and leaves sessions[id].slice.<field> untouched (parked-session
 *      preservation).
 *
 * W4.3 (scopeRuns) and W4.4 (taskProjections) extend this file with two
 * additional sub-cases as they land.
 *
 * Plan: docs/superpowers/plans/2026-05-22-W4-useagent-ownership-implementation.md §3.2
 *
 * Test strategy: drive the store directly via `useAgent.setState` to seed a
 * known multi-session shape, then exercise the published action surface
 * (`setActiveSessionId`) for the switch leg. Both legs read back through
 * `getSessionSlice` to confirm slice values, and through `useAgent.getState()`
 * to confirm the top-level mirror.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import {
  getSessionSlice,
  useAgent,
  type SessionSlice,
} from '../renderer/stores/useAgent'

// --- jsdom shim ------------------------------------------------------------

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

function seedTwoSessions(opts: {
  activeId: 'session-A' | 'session-B'
  sliceA: Partial<SessionSlice>
  sliceB: Partial<SessionSlice>
  topLevel?: Partial<Parameters<typeof useAgent.setState>[0] & object>
}) {
  const sessions = {
    'session-A': makeSlice(opts.sliceA),
    'session-B': makeSlice(opts.sliceB),
  }
  const active = sessions[opts.activeId]
  useAgent.setState({
    agents: [{ name: 'butler', displayName: '管家', avatar: '', status: 'idle', selected: true }],
    messages: active.messages,
    currentAgent: 'butler',
    inputValue: active.inputValue,
    pendingContinuationIntent: null,
    pendingContinuationDraftAnchor: null,
    isStreaming: active.isStreaming,
    foregroundBusy: active.foregroundBusy,
    composerLocked: active.composerLocked,
    streamingMessageId: active.streamingMessageId,
    streamingRequestId: active.streamingRequestId,
    sessionId: opts.activeId,
    conversationId: active.conversationId,
    conversations: [],
    currentScopeId: null,
    currentScope: null,
    scopes: [],
    scopeRunStates: active.scopeRunStates,
    toolTrace: [],
    toolTraceStatus: 'idle',
    attachments: [],
    filePool: [],
    activeAttachmentPreview: null,
    sendCoalescingEnabled: true,
    sendCoalescingWindowMs: 1200,
    pendingSendCount: active.pendingSendCount,
    pendingSendFlushAt: active.pendingSendFlushAt,
    sessions,
    activeSessionId: opts.activeId,
    sessionOrder: ['session-A', 'session-B'],
    taskDisclosureState: active.taskDisclosureState,
    ...(opts.topLevel ?? {}),
  })
}

// ==========================================================================
// W4.2 — streaming (the 5-field group)
// ==========================================================================

test('W4.2 — streaming flags mirror top-level ↔ sessions[activeId].slice', () => {
  const dom = installDom()
  try {
    // Leg 1 — write into the active session's slice, then read the mirror.
    seedTwoSessions({
      activeId: 'session-A',
      sliceA: {
        isStreaming: true,
        foregroundBusy: true,
        composerLocked: true,
        streamingMessageId: 'msg-A-1',
        streamingRequestId: 'req-A-1',
      },
      sliceB: {
        isStreaming: false,
        foregroundBusy: false,
        composerLocked: false,
        streamingMessageId: null,
        streamingRequestId: null,
      },
      topLevel: {
        // Mirror set up explicitly at seed time — same shape as the
        // V3.3b.1 mirror pattern uses elsewhere.
        isStreaming: true,
        foregroundBusy: true,
        composerLocked: true,
        streamingMessageId: 'msg-A-1',
        streamingRequestId: 'req-A-1',
      },
    })

    const before = useAgent.getState()
    const sliceA = getSessionSlice(before, 'session-A')
    assert.equal(before.isStreaming, sliceA.isStreaming, 'top-level isStreaming mirrors active slice')
    assert.equal(before.foregroundBusy, sliceA.foregroundBusy, 'top-level foregroundBusy mirrors active slice')
    assert.equal(before.composerLocked, sliceA.composerLocked, 'top-level composerLocked mirrors active slice')
    assert.equal(before.streamingMessageId, sliceA.streamingMessageId, 'top-level streamingMessageId mirrors active slice')
    assert.equal(before.streamingRequestId, sliceA.streamingRequestId, 'top-level streamingRequestId mirrors active slice')

    // Leg 2 — setActiveSessionId(session-B) where sliceB has different
    // streaming values; the top-level mirror must rewrite, sliceA must stay.
    useAgent.getState().setActiveSessionId('session-B')

    const after = useAgent.getState()
    const sliceBAfter = getSessionSlice(after, 'session-B')
    const sliceAAfter = getSessionSlice(after, 'session-A')

    assert.equal(after.activeSessionId, 'session-B', 'activeSessionId switched to B')
    assert.equal(after.isStreaming, sliceBAfter.isStreaming, 'top-level isStreaming now mirrors session-B slice')
    assert.equal(after.foregroundBusy, sliceBAfter.foregroundBusy, 'top-level foregroundBusy now mirrors session-B slice')
    assert.equal(after.composerLocked, sliceBAfter.composerLocked, 'top-level composerLocked now mirrors session-B slice')
    assert.equal(after.streamingMessageId, sliceBAfter.streamingMessageId, 'top-level streamingMessageId now mirrors session-B slice')
    assert.equal(after.streamingRequestId, sliceBAfter.streamingRequestId, 'top-level streamingRequestId now mirrors session-B slice')

    // Parked session preservation — A's slice still holds its streaming state.
    assert.equal(sliceAAfter.isStreaming, true, 'parked session-A keeps isStreaming=true')
    assert.equal(sliceAAfter.streamingMessageId, 'msg-A-1', 'parked session-A keeps streamingMessageId')
    assert.equal(sliceAAfter.streamingRequestId, 'req-A-1', 'parked session-A keeps streamingRequestId')
  } finally {
    dom.restore()
  }
})
