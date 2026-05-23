/**
 * Stage X2.1 / X2.4 / X2.5 / X2.6 — runtime driver terminal-error behavior.
 *
 * Plan §7.1 (docs/superpowers/plans/2026-05-22-X-trust-foundation-and-w5-recovery-implementation.md)
 * three-state failure decomposition:
 *   - Session visibility — covered in session-tabs-ui.test.ts (X2.1 #5/#6).
 *   - Composer lock — THIS file. Terminal events must unlock the session
 *     whose send originated the streaming, even if `currentScopeId`
 *     changes mid-send.
 *   - Runtime intent — THIS file. Terminal errors must clear the
 *     in-flight request handle and hide the Stop button.
 *
 * Plus X2.6 — infrastructure_timeout 60s safety net (the no-terminal-ever
 * recovery path).
 *
 * The driver listens via `window.electronAPI.agent.onError(...)`. The test
 * installs a minimal electronAPI stub that captures the registered handlers
 * so we can fire synthetic IPC events at the driver from inside Node.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'

// ---------------------------------------------------------------------------
// jsdom + global installation — driver imports zustand which touches window
// ---------------------------------------------------------------------------

function installDomGlobals(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' })
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement,
    Node: (globalThis as { Node?: typeof Node }).Node,
    Event: (globalThis as { Event?: typeof Event }).Event,
    CustomEvent: (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent,
    navigator: (globalThis as { navigator?: Navigator }).navigator,
    localStorage: (globalThis as { localStorage?: Storage }).localStorage,
  }
  function set<K extends keyof typeof previous>(key: K, value: unknown) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  set('window', dom.window)
  set('document', dom.window.document)
  set('HTMLElement', dom.window.HTMLElement)
  set('Node', dom.window.Node)
  set('Event', dom.window.Event)
  set('CustomEvent', dom.window.CustomEvent)
  set('navigator', dom.window.navigator)
  set('localStorage', dom.window.localStorage)
  return {
    dom,
    restore: () => {
      for (const key of Object.keys(previous) as Array<keyof typeof previous>) {
        const value = previous[key]
        if (value === undefined) {
          delete (globalThis as unknown as Record<string, unknown>)[key as string]
        } else {
          Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
        }
      }
      try { dom.window.close() } catch { /* silent-catch: close best-effort */ }
    },
  }
}

const handle = installDomGlobals()
process.on('exit', () => { try { handle.restore() } catch { /* silent-catch: restore */ } })

// ---------------------------------------------------------------------------
// electronAPI stub — capture every `onXxx` handler so the test can fire
// synthetic events at the driver.
// ---------------------------------------------------------------------------

type Handler = (data: unknown) => void

interface CapturedHandlers {
  onError: Handler[]
  onStream: Handler[]
  onStatus: Handler[]
  onToolAction: Handler[]
  onToolActionRequest: Handler[]
  onCancelToolActionRequest: Handler[]
  onConversationEvent: Handler[]
  onScopeRunEvent: Handler[]
  onProjectionSyncFailed: Handler[]
  onReferenceSkillHintChanged: Handler[]
  onTaskProjectionsChanged: Handler[]
}

const captured: CapturedHandlers = {
  onError: [],
  onStream: [],
  onStatus: [],
  onToolAction: [],
  onToolActionRequest: [],
  onCancelToolActionRequest: [],
  onConversationEvent: [],
  onScopeRunEvent: [],
  onProjectionSyncFailed: [],
  onReferenceSkillHintChanged: [],
  onTaskProjectionsChanged: [],
}

function register<K extends keyof CapturedHandlers>(slot: K) {
  return (cb: Handler) => {
    captured[slot].push(cb)
    return () => {
      const idx = captured[slot].indexOf(cb)
      if (idx >= 0) captured[slot].splice(idx, 1)
    }
  }
}

const electronAPIStub = {
  agent: {
    onStream: register('onStream'),
    onStatusChange: register('onStatus'),
    onError: register('onError'),
    onToolAction: register('onToolAction'),
    onToolActionRequest: register('onToolActionRequest'),
    onCancelToolActionRequest: register('onCancelToolActionRequest'),
    onConversationEvent: register('onConversationEvent'),
    onScopeRunEvent: register('onScopeRunEvent'),
    onProjectionSyncFailed: register('onProjectionSyncFailed'),
    onReferenceSkillHintChanged: register('onReferenceSkillHintChanged'),
    onTaskProjectionsChanged: register('onTaskProjectionsChanged'),
    completeToolActionRequest: async () => ({ success: true }),
    kill: async () => ({ success: true }),
    newSession: async () => ({ success: true }),
    createLocalScope: async () => ({ success: true }),
    sendScoped: async () => ({ success: true }),
    send: async () => ({ success: true }),
  },
  settings: {
    get: async () => ({ success: true, data: 'true' }),
    set: async () => ({ success: true }),
  },
  tools: {
    logToolEvent: () => undefined,
  },
}

Object.defineProperty(globalThis.window, 'electronAPI', {
  value: electronAPIStub,
  configurable: true,
  writable: true,
})

// ---------------------------------------------------------------------------
// Dynamic imports AFTER jsdom + electronAPI stub installed.
// ---------------------------------------------------------------------------

import type { SessionSlice } from '../renderer/stores/useAgent'

const { useAgent, getSessionSlice } = await import('../renderer/stores/useAgent')
const { createAgentRuntimeDriver } = await import('../renderer/modules/agent/runtimeDriver')

const driver = createAgentRuntimeDriver(useAgent as unknown as { getState: () => any; setState: (partial: any) => void })
driver.initAgentListeners()

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeLockedSlice(scopeId: string, requestId: string): SessionSlice {
  return {
    messages: [],
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    isStreaming: true,
    foregroundBusy: true,
    composerLocked: true,
    streamingMessageId: 'msg-1',
    streamingRequestId: requestId,
    scopeRunStates: {
      [scopeId]: {
        scopeId,
        agent: 'butler',
        requestId,
        phase: 'responding',
        toolTrace: [],
        startedAt: '2026-05-22T00:00:00.000Z',
        updatedAt: '2026-05-22T00:00:01.000Z',
      } as any,
    },
    taskDisclosureState: {},
    state: 'live',
    conversationId: scopeId,
    inputValue: '',
  }
}

function makeEmptySlice(scopeId: string): SessionSlice {
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
    conversationId: scopeId,
    inputValue: '',
  }
}

function seedTwoSessions(opts: {
  activeSessionId: string
  lockedSessionId: string
  lockedScopeId: string
  otherScopeId: string
  requestId: string
}) {
  const lockedSlice = makeLockedSlice(opts.lockedScopeId, opts.requestId)
  const otherSlice = makeEmptySlice(opts.otherScopeId)
  const sessions: Record<string, SessionSlice> = {
    [opts.lockedSessionId]: lockedSlice,
    [opts.activeSessionId]: opts.activeSessionId === opts.lockedSessionId ? lockedSlice : otherSlice,
  }
  // If the active session is also the locked one (i.e. no mid-send switch),
  // seed only that one slice.
  if (opts.activeSessionId === opts.lockedSessionId) {
    delete (sessions as Record<string, SessionSlice>)[opts.lockedSessionId === opts.activeSessionId ? '_extra_' : '']
  }
  const activeSlice = sessions[opts.activeSessionId]
  useAgent.setState({
    agents: [{ name: 'butler', displayName: '管家', avatar: '', status: 'idle', selected: true }],
    currentAgent: 'butler',
    messages: activeSlice.messages,
    inputValue: activeSlice.inputValue,
    sessions,
    activeSessionId: opts.activeSessionId,
    sessionOrder: Object.keys(sessions),
    sessionId: opts.activeSessionId,
    conversationId: activeSlice.conversationId,
    currentScopeId: activeSlice.conversationId,
    currentScope: null,
    scopes: [],
    scopeRunStates: activeSlice.scopeRunStates,
    isStreaming: activeSlice.isStreaming,
    foregroundBusy: activeSlice.foregroundBusy,
    composerLocked: activeSlice.composerLocked,
    streamingMessageId: activeSlice.streamingMessageId,
    streamingRequestId: activeSlice.streamingRequestId,
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    pendingContinuationIntent: null,
    pendingContinuationDraftAnchor: null,
    toolTrace: [],
    toolTraceStatus: activeSlice.isStreaming ? 'running' : 'idle',
    attachments: [],
    filePool: [],
    activeAttachmentPreview: null,
    sendCoalescingEnabled: true,
    sendCoalescingWindowMs: 1200,
    taskDisclosureState: {},
    conversations: [],
  })
}

function fireOnError(data: Record<string, unknown>): void {
  for (const handler of captured.onError) handler(data)
}

// ---------------------------------------------------------------------------
// Test X2.1 #4 — failed send unlocks composer for the originating session
// even when user has NOT switched scopes (basic baseline).
// ---------------------------------------------------------------------------

test('X2.1 #4 — terminal error on active session: composer unlocks + stop button gone', () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  fireOnError({
    agent: 'butler',
    sessionId: 'session-A',
    scopeId: 'scope-A',
    runId: 'req-A',
    error: 'HTTP 402: insufficient balance',
    type: 'runtime',
    errorKind: 'quota_exceeded',
    recoverable: false,
  })

  const state = useAgent.getState()
  const slice = getSessionSlice(state, 'session-A')
  assert.equal(slice.isStreaming, false, 'session-A slice isStreaming cleared')
  assert.equal(slice.composerLocked, false, 'session-A slice composerLocked cleared')
  assert.equal(slice.foregroundBusy, false, 'session-A slice foregroundBusy cleared')
  assert.equal(slice.streamingRequestId, null, 'session-A slice streamingRequestId cleared (Stop button hidden)')
  assert.equal(slice.streamingMessageId, null, 'session-A slice streamingMessageId cleared')
  // Top-level mirror reflects active session unlock.
  assert.equal(state.composerLocked, false, 'top-level composerLocked mirror cleared')
  assert.equal(state.streamingRequestId, null, 'top-level streamingRequestId mirror cleared')
})

// ---------------------------------------------------------------------------
// Test X2.1 #5 — session/scope mismatch guard: terminal events must unlock
// the session that was locked at send start, even if currentScopeId has
// moved mid-send.
// ---------------------------------------------------------------------------

test('X2.1 #5 — mid-send scope switch: terminal still unlocks the originating session', () => {
  // session-A is locked on scope-A; user has clicked into session-B (scope-B).
  // The active session is now session-B. The terminal error for scope-A arrives.
  seedTwoSessions({
    activeSessionId: 'session-B',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  // sanity check: session-A is still locked before the error fires.
  const before = useAgent.getState()
  const sliceABefore = getSessionSlice(before, 'session-A')
  assert.equal(sliceABefore.composerLocked, true, 'pre-condition: session-A locked')
  assert.equal(before.currentScopeId, 'scope-B', 'pre-condition: user switched to scope-B')

  fireOnError({
    agent: 'butler',
    sessionId: 'session-A',
    scopeId: 'scope-A',
    runId: 'req-A',
    error: 'HTTP 402: insufficient balance',
    type: 'runtime',
    errorKind: 'quota_exceeded',
    recoverable: false,
  })

  const state = useAgent.getState()
  const sliceA = getSessionSlice(state, 'session-A')
  assert.equal(sliceA.composerLocked, false, 'session-A unlocks even though it is not the active session')
  assert.equal(sliceA.isStreaming, false, 'session-A isStreaming cleared')
  assert.equal(sliceA.foregroundBusy, false, 'session-A foregroundBusy cleared')
  assert.equal(sliceA.streamingRequestId, null, 'session-A streamingRequestId cleared (Stop button hidden when returning)')
  assert.equal(sliceA.streamingMessageId, null, 'session-A streamingMessageId cleared')

  // The active session (B) was never locked — its slice should remain
  // unchanged (no spurious side effects on the wrong session).
  const sliceB = getSessionSlice(state, 'session-B')
  assert.equal(sliceB.composerLocked, false, 'session-B composer stays unlocked (never locked)')
  assert.equal(sliceB.streamingRequestId, null, 'session-B streamingRequestId untouched')
})
