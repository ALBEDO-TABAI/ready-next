/**
 * Stage V V3.3b.1 — useAgent inputValue per-session slice migration behavior test.
 *
 * Covers the four contracts established by `useAgent.ts` after the V3.3b.1
 * migration of the composer draft (`inputValue`) from a single top-level
 * field to a per-sessionId slice (with top-level read-through mirror):
 *
 *   1. Single-session write — `setInputValue` writes both the active
 *      session's slice and the top-level mirror; consumers (still reading
 *      `state.inputValue`) observe the same value.
 *   2. Cross-session isolation — calling `setInputValue` while session A is
 *      active leaves session B's slice draft untouched.
 *   3. Active session switch — moving `activeSessionId` from A → B exposes
 *      whichever value the caller mirrors at top level; the slice value for
 *      each session is preserved across the switch.
 *   4. Bootstrap fresh state — the store's initial state has `inputValue=''`
 *      at top level and an empty `sessions` Record whose default slice
 *      (returned by `getSessionSlice`) also carries `inputValue=''`.
 *
 * Plan: docs/superpowers/plans/2026-05-21-V-stage-v-comprehensive-implementation.md
 *   §4 V3.3b
 *
 * Test strategy: drive the store directly via
 * `useAgent.getState().setInputValue` / `useAgent.setState` and inspect both
 * the top-level mirror and the per-session slice (via `getSessionSlice`).
 * No IPC, no DOM beyond a jsdom shim (the setInputValue path inspects no
 * window APIs, but other store branches do — keeping the shim aligns with
 * the V3.3c sibling test file).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

import { getSessionSlice, useAgent } from '../renderer/stores/useAgent'

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

interface SeedOptions {
  sessionId?: string
  activeSessionId?: string | null
  sessions?: Record<string, ReturnType<typeof getSessionSlice>>
  inputValue?: string
}

function seedStore(opts: SeedOptions = {}) {
  useAgent.setState({
    agents: [{ name: 'butler', displayName: '管家', avatar: '', status: 'idle', selected: true }],
    messages: [],
    currentAgent: 'butler',
    inputValue: opts.inputValue ?? '',
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
    sendCoalescingWindowMs: 1200,
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    sessions: opts.sessions ?? {},
    activeSessionId: opts.activeSessionId ?? null,
    taskDisclosureState: {},
  })
}

// --- Case 1 — single session: write both slice + mirror --------------------

test('V3.3b.1 — single session: setInputValue writes both slice and top-level mirror', () => {
  const dom = installDom()
  try {
    seedStore({ sessionId: 'session-A', activeSessionId: 'session-A' })

    useAgent.getState().setInputValue('hello composer')

    const state = useAgent.getState()
    // Consumer-visible top-level field (the path ChatInput / ChatPanel still
    // read pre-V3.3b.X) must reflect the new value.
    assert.equal(state.inputValue, 'hello composer', 'top-level mirror reflects new value')

    // Source-of-truth slice for the active session must carry the same value.
    const slice = getSessionSlice(state)
    assert.equal(slice.inputValue, 'hello composer', 'active session slice carries new value')

    // The slice and mirror must agree — they are written from the same set().
    assert.equal(state.inputValue, slice.inputValue, 'mirror equals slice for active session')

    // The slice entry must exist in the sessions Record so future per-session
    // selectors can find it.
    assert.notEqual(state.sessions['session-A'], undefined, 'session-A slice exists in Record')
    assert.equal(
      state.sessions['session-A'].inputValue,
      'hello composer',
      'sessions[session-A].inputValue carries new value',
    )
  } finally {
    dom.restore()
  }
})

// --- Case 2 — two sessions: write to A doesn't affect B --------------------

test('V3.3b.1 — two sessions: setInputValue on A leaves session B slice untouched', () => {
  const dom = installDom()
  try {
    // Seed both sessions with distinct initial drafts so we can prove session
    // B's slice is preserved verbatim through a session-A write.
    seedStore({
      sessionId: 'session-A',
      activeSessionId: 'session-A',
      sessions: {
        'session-A': {
          pendingSendCount: 0,
          pendingSendFlushAt: null,
          state: 'live',
          conversationId: null,
          inputValue: 'A initial',
        },
        'session-B': {
          pendingSendCount: 0,
          pendingSendFlushAt: null,
          state: 'live',
          conversationId: null,
          inputValue: 'B initial',
        },
      },
      inputValue: 'A initial',
    })

    // Write into session A (which is active).
    useAgent.getState().setInputValue('A new draft')

    const state = useAgent.getState()
    const sliceA = getSessionSlice(state, 'session-A')
    const sliceB = getSessionSlice(state, 'session-B')

    assert.equal(sliceA.inputValue, 'A new draft', 'session A slice receives the write')
    assert.equal(sliceB.inputValue, 'B initial', 'session B slice untouched by session A write')

    // Top-level mirror tracks the active session (A).
    assert.equal(state.inputValue, 'A new draft', 'top-level mirror tracks active session A')

    // Slices must be distinct object identities — a write to one cannot have
    // mutated the other in place.
    assert.notEqual(
      state.sessions['session-A'],
      state.sessions['session-B'],
      'sessions A and B hold distinct slice identities post-write',
    )
  } finally {
    dom.restore()
  }
})

// --- Case 3 — switching activeSessionId exposes per-session drafts ---------

test('V3.3b.1 — switching activeSessionId preserves each session draft; mirror tracks active', () => {
  const dom = installDom()
  try {
    // Two sessions with separate drafts; A active.
    seedStore({
      sessionId: 'session-A',
      activeSessionId: 'session-A',
      sessions: {
        'session-A': {
          pendingSendCount: 0,
          pendingSendFlushAt: null,
          state: 'live',
          conversationId: null,
          inputValue: 'draft-A',
        },
        'session-B': {
          pendingSendCount: 0,
          pendingSendFlushAt: null,
          state: 'live',
          conversationId: null,
          inputValue: 'draft-B',
        },
      },
      inputValue: 'draft-A',
    })

    const beforeSwitch = useAgent.getState()
    assert.equal(beforeSwitch.inputValue, 'draft-A', 'mirror starts at active A draft')
    assert.equal(getSessionSlice(beforeSwitch, 'session-A').inputValue, 'draft-A')
    assert.equal(getSessionSlice(beforeSwitch, 'session-B').inputValue, 'draft-B')

    // Switch to B — the caller is responsible for mirroring the new active
    // session's slice value onto the top-level field (multi-session UI work
    // that lands in a later V3.3b step). The store's contract for this PR
    // is: the slice values must survive the switch unchanged so the future
    // selector can read them.
    const preservedSessions = beforeSwitch.sessions
    useAgent.setState({
      sessionId: 'session-B',
      activeSessionId: 'session-B',
      // Mirror what the future session-switch helper would do: pull the new
      // active session's inputValue onto the top-level mirror.
      inputValue: preservedSessions['session-B'].inputValue,
      sessions: preservedSessions,
    })

    const afterSwitch = useAgent.getState()
    assert.equal(afterSwitch.inputValue, 'draft-B', 'mirror updated to new active session B draft')
    assert.equal(
      getSessionSlice(afterSwitch, 'session-A').inputValue,
      'draft-A',
      'session A draft preserved across switch',
    )
    assert.equal(
      getSessionSlice(afterSwitch, 'session-B').inputValue,
      'draft-B',
      'session B draft preserved across switch',
    )

    // Writing while B is active updates B's slice + mirror — not A's.
    useAgent.getState().setInputValue('draft-B edited')
    const afterEdit = useAgent.getState()
    assert.equal(afterEdit.inputValue, 'draft-B edited', 'mirror reflects B edit')
    assert.equal(
      getSessionSlice(afterEdit, 'session-B').inputValue,
      'draft-B edited',
      'B slice reflects edit',
    )
    assert.equal(
      getSessionSlice(afterEdit, 'session-A').inputValue,
      'draft-A',
      'A slice still pristine after B edit',
    )
  } finally {
    dom.restore()
  }
})

// --- Case 4 — bootstrap fresh state defaults to '' on both layers ----------

test('V3.3b.1 — bootstrap fresh state: top-level inputValue defaults "" alongside slice', () => {
  const dom = installDom()
  try {
    // Seed with no sessions Record entries and no activeSessionId — this
    // models the moment right after store creation, before any write has
    // touched the composer.
    seedStore({
      sessionId: 'session-bootstrap',
      activeSessionId: null,
      sessions: {},
      inputValue: '',
    })

    const state = useAgent.getState()

    // Top-level mirror defaults to ''.
    assert.equal(state.inputValue, '', 'top-level inputValue defaults to empty string')

    // getSessionSlice with no active id falls back through sessionId →
    // PRIMARY_SESSION_KEY → empty slice; the empty slice's inputValue
    // must also default to ''.
    const slice = getSessionSlice(state)
    assert.equal(slice.inputValue, '', 'default slice inputValue defaults to empty string')

    // Explicitly asking for an unseen sessionId returns the empty-slice
    // fallback with the same '' default.
    const unknown = getSessionSlice(state, 'session-never-touched')
    assert.equal(unknown.inputValue, '', 'unknown session falls back to empty slice with ""')

    // Bootstrap invariant: the empty slice carries the same shape as a
    // freshly-created live slice — pendingSendCount=0, flushAt=null,
    // state='live', conversationId=null, inputValue=''.
    assert.equal(slice.pendingSendCount, 0, 'bootstrap slice pendingSendCount=0')
    assert.equal(slice.pendingSendFlushAt, null, 'bootstrap slice pendingSendFlushAt=null')
    assert.equal(slice.state, 'live', 'bootstrap slice state=live')
    assert.equal(slice.conversationId, null, 'bootstrap slice conversationId=null')
  } finally {
    dom.restore()
  }
})
