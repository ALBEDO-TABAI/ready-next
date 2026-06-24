/**
 * Stage X2.1 / X2.4 / X2.5 / X2.6 — runtime driver terminal-error behavior.
 *
 * Plan §7.1 (docs/superpowers/plans/2026-05-22-X-trust-foundation-and-w5-recovery-implementation.md)
 * three-state failure decomposition:
 *   - Session visibility — covered in multi-session-isolation.test.ts (V3.3b.2).
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

const infrastructureTimeoutReports: Array<{ scopeId: string; requestId: string; elapsedMs?: number }> = []
let infrastructureTimeoutReportResult: unknown = { success: true, data: { state: 'cancel_requested' } }

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
    reportInfrastructureTimeout: async (payload: { scopeId: string; requestId: string; elapsedMs?: number }) => {
      infrastructureTimeoutReports.push(payload)
      return infrastructureTimeoutReportResult
    },
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

const driver = createAgentRuntimeDriver(useAgent as unknown as { getState: () => unknown; setState: (partial: unknown) => void })
driver.initAgentListeners()

type DriverApi = {
  armInfrastructureWatchdog: (scopeId: string, requestId: string, options?: { timeoutMs?: number }) => void
  clearInfrastructureWatchdog: (scopeId: string, requestId: string | null | undefined) => void
  completeScopeRunAfterSendSuccess: (scopeId: string, requestId: string) => void
}
const driverApi = driver as unknown as DriverApi

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
      } as unknown as SessionSlice['scopeRunStates'][string],
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

function fireOnScopeRunEvent(data: Record<string, unknown>): void {
  for (const handler of captured.onScopeRunEvent) handler(data)
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

// ---------------------------------------------------------------------------
// Test X2.6 — infrastructure_timeout safety net.
//
// Per plan §7.2 last paragraph: if no terminal event of any kind arrives
// within 60s of send, fire infrastructure_timeout: unlock the originating
// session's composer, hide Stop, and toast "Ready lost track of this
// request; recovered automatically".
//
// The driver exposes `armInfrastructureWatchdog(scopeId, requestId,
// { timeoutMs })` as a test seam so we can fire it on a 1ms budget
// instead of actually waiting 60 seconds.
// ---------------------------------------------------------------------------

test('X2.6 — infrastructure_timeout fires after timeout with no terminal event', async () => {
  infrastructureTimeoutReports.length = 0
  infrastructureTimeoutReportResult = { success: false, error: 'ipc unavailable' }
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 10 })

  // Wait the timeout window (+ a little headroom for the timer callback
  // and the React-style setState flush).
  await new Promise((resolve) => setTimeout(resolve, 50))

  const state = useAgent.getState()
  const slice = getSessionSlice(state, 'session-A')
  assert.equal(slice.composerLocked, false, 'infrastructure_timeout unlocks the originating session')
  assert.equal(slice.isStreaming, false, 'infrastructure_timeout clears isStreaming')
  assert.equal(slice.foregroundBusy, false, 'infrastructure_timeout clears foregroundBusy')
  assert.equal(slice.streamingRequestId, null, 'infrastructure_timeout clears streamingRequestId (Stop button hidden)')
  assert.equal(slice.scopeRunStates['scope-A']?.phase, 'error', 'infrastructure_timeout marks the active run terminal')
  assert.equal(slice.scopeRunStates['scope-A']?.terminalReason, 'infra_error', 'infrastructure_timeout releases active-run aliases')
  assert.deepEqual(
    infrastructureTimeoutReports,
    [{ scopeId: 'scope-A', requestId: 'req-A', elapsedMs: 10 }],
    'infrastructure_timeout reports the stuck request to main with request-id authority',
  )
  assert.equal(state.composerLocked, false, 'active mirror also unlocks after infrastructure_timeout')
  assert.equal(state.foregroundBusy, false, 'active mirror foregroundBusy is not resurrected by a stale planning run')

  // A user-visible "lost track" system message lands in the active scope.
  const lostTrackMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('Ready 跟丢了'))
  assert.ok(lostTrackMsg, 'a "Ready 跟丢了" system message is appended for the active scope')
})

test('X2.6 — main-acknowledged timeout does not surface a lost-track message', async () => {
  infrastructureTimeoutReports.length = 0
  infrastructureTimeoutReportResult = { success: true, data: { state: 'cancel_requested' } }
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 10 })

  await new Promise((resolve) => setTimeout(resolve, 50))

  const state = useAgent.getState()
  assert.deepEqual(
    infrastructureTimeoutReports,
    [{ scopeId: 'scope-A', requestId: 'req-A', elapsedMs: 10 }],
    'timeout still reports to main with request-id authority',
  )
  const lostTrackMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('Ready 跟丢了'))
  assert.equal(lostTrackMsg, undefined, 'main accepted the timeout, so renderer must not claim it lost the request')
  assert.equal(getSessionSlice(state, 'session-A').composerLocked, false, 'composer still unlocks after acknowledged timeout')
})

test('X2.6 — hung main timeout report still releases the renderer lock', async () => {
  infrastructureTimeoutReports.length = 0
  infrastructureTimeoutReportResult = new Promise(() => undefined)
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 10 })

  // A hung report now resolves at the 5s ack window (bumped from 1s so a
  // slow-but-alive main can answer); wait past it before asserting unlock.
  await new Promise((resolve) => setTimeout(resolve, 5300))

  const state = useAgent.getState()
  const slice = getSessionSlice(state, 'session-A')
  assert.deepEqual(
    infrastructureTimeoutReports,
    [{ scopeId: 'scope-A', requestId: 'req-A', elapsedMs: 10 }],
    'renderer still attempts to report the stuck request to main',
  )
  assert.equal(slice.composerLocked, false, 'hung main report cannot keep the composer locked')
  assert.equal(slice.isStreaming, false, 'hung main report cannot keep the session streaming')
  assert.equal(slice.streamingRequestId, null, 'hung main report clears the in-flight request handle')
  const lostTrackMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('Ready 跟丢了'))
  assert.ok(lostTrackMsg, 'without a main ack, renderer still surfaces the local recovery message')
})

test('B step 1 — a slow-but-alive main (answers after 1s, before 5s) reaches main, no false lost-track', async () => {
  infrastructureTimeoutReports.length = 0
  // Resolve at ~2.5s: under the OLD 1s ack this raced out → null → false
  // "lost track" recovery; under the 5s ack the alive main is heard.
  infrastructureTimeoutReportResult = new Promise((resolve) =>
    setTimeout(() => resolve({ success: true, data: { state: 'cancel_requested' } }), 2500))
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 10 })
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const state = useAgent.getState()
  // Assert only renderer-observable facts: the alive main was reached (reported),
  // no false "lost track" message, and the composer unlocked. We intentionally do
  // NOT assert a "main-authoritative" terminalReason here — the value the renderer
  // sets in this branch is a transient LOCAL label, not main's real terminal
  // reason (a process_exit kill finalizes as cancelled_runtime on main). Asserting
  // the real terminal reason belongs to a test that simulates main's terminal IPC.
  const lostTrackMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('Ready 跟丢了'))
  assert.equal(lostTrackMsg, undefined, 'a slow-but-alive main must NOT be mistaken for lost track')
  assert.deepEqual(
    infrastructureTimeoutReports,
    [{ scopeId: 'scope-A', requestId: 'req-A', elapsedMs: 10 }],
    'the alive main was actually reached (report delivered) within the 5s ack window',
  )
  assert.equal(getSessionSlice(state, 'session-A').composerLocked, false, 'composer unlocks after main answers')
})

test('started event for a new request does not inherit the previous response segment', () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-old',
  })
  useAgent.setState((state: any) => {
    const slice = getSessionSlice(state, 'session-A')
    const previousRun = slice.scopeRunStates['scope-A']
    return {
      ...state,
      messages: [
        {
          id: 'response-old',
          agent: 'butler',
          type: 'agent',
          content: '上一轮回答',
          timestamp: new Date('2026-06-21T10:22:16.000Z'),
        },
      ],
      sessions: {
        ...state.sessions,
        'session-A': {
          ...slice,
          messages: [
            {
              id: 'response-old',
              agent: 'butler',
              type: 'agent',
              content: '上一轮回答',
              timestamp: new Date('2026-06-21T10:22:16.000Z'),
            },
          ],
          scopeRunStates: {
            ...slice.scopeRunStates,
            'scope-A': {
              ...previousRun,
              phase: 'done',
              terminalReason: 'done',
              responseMessageId: 'response-old',
              responseBuffer: '上一轮回答',
              toolTrace: [
                {
                  id: 'old-tool',
                  kind: 'result',
                  text: 'old result',
                  timestamp: new Date('2026-06-21T10:22:10.000Z'),
                },
              ],
            },
          },
        },
      },
      scopeRunStates: {
        ...state.scopeRunStates,
        'scope-A': {
          ...previousRun,
          phase: 'done',
          terminalReason: 'done',
          responseMessageId: 'response-old',
          responseBuffer: '上一轮回答',
          toolTrace: [
            {
              id: 'old-tool',
              kind: 'result',
              text: 'old result',
              timestamp: new Date('2026-06-21T10:22:10.000Z'),
            },
          ],
        },
      },
    }
  })

  fireOnScopeRunEvent({
    type: 'started',
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-new',
    phase: 'planning',
    latestText: '正在理解需求',
    timestamp: '2026-06-21T10:41:52.000Z',
  })

  const nextRun = getSessionSlice(useAgent.getState(), 'session-A').scopeRunStates['scope-A']
  assert.equal(nextRun.requestId, 'req-new')
  assert.equal(nextRun.responseMessageId, null, 'new run must not reuse the old assistant message id')
  assert.equal(nextRun.responseBuffer, '', 'new run starts with an empty response buffer')
  assert.deepEqual(nextRun.toolTrace, [], 'new run starts with a fresh tool trace')
  assert.equal(nextRun.startedAt, '2026-06-21T10:41:52.000Z', 'new run owns its own start timestamp')
})

test('X2.6 — runtime liveness extends the bootstrap watchdog window', async () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 20 })

  fireOnScopeRunEvent({
    type: 'started',
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-A',
    phase: 'planning',
    latestText: '正在理解需求',
    timestamp: new Date().toISOString(),
  })

  await new Promise((resolve) => setTimeout(resolve, 80))
  driverApi.clearInfrastructureWatchdog('scope-A', 'req-A')

  const state = useAgent.getState()
  const lostTrackMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('Ready 跟丢了'))
  assert.equal(lostTrackMsg, undefined, 'active runtime liveness does not trip the bootstrap lost-track toast')
  assert.equal(getSessionSlice(state, 'session-A').scopeRunStates['scope-A']?.phase, 'planning')
})

test('sendScoped success fallback unlocks a completed run with stale composer locks', () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  const before = useAgent.getState()
  const slice = getSessionSlice(before, 'session-A')
  const completedRun = {
    ...slice.scopeRunStates['scope-A'],
    phase: 'done' as const,
    terminalReason: 'done' as const,
  }
  useAgent.setState({
    sessions: {
      ...before.sessions,
      'session-A': {
        ...slice,
        isStreaming: true,
        foregroundBusy: true,
        composerLocked: true,
        streamingMessageId: 'msg-1',
        streamingRequestId: 'req-A',
        scopeRunStates: {
          ...slice.scopeRunStates,
          'scope-A': completedRun,
        },
      },
    },
    scopeRunStates: {
      ...before.scopeRunStates,
      'scope-A': completedRun,
    },
    isStreaming: true,
    foregroundBusy: true,
    composerLocked: true,
    streamingMessageId: 'msg-1',
    streamingRequestId: 'req-A',
  })

  driverApi.completeScopeRunAfterSendSuccess('scope-A', 'req-A')

  const state = useAgent.getState()
  const afterSlice = getSessionSlice(state, 'session-A')
  assert.equal(afterSlice.isStreaming, false, 'success fallback clears stale session streaming flag')
  assert.equal(afterSlice.foregroundBusy, false, 'success fallback clears stale foreground lock')
  assert.equal(afterSlice.composerLocked, false, 'success fallback unlocks the composer')
  assert.equal(afterSlice.streamingRequestId, null, 'success fallback hides the Stop button')
  assert.equal(state.isStreaming, false, 'active mirror streaming flag is cleared')
  assert.equal(state.composerLocked, false, 'active mirror composer lock is cleared')
  assert.equal(afterSlice.scopeRunStates['scope-A']?.terminalReason, 'done')
})

test('scope run events ignore stale non-started run ids but allow takeover and started handoff', () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-new',
  })

  fireOnScopeRunEvent({
    type: 'started',
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-new',
    phase: 'planning',
    taskSummary: 'new run planning',
    timestamp: '2026-05-31T00:00:00.000Z',
  })

  fireOnScopeRunEvent({
    type: 'updated',
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-old',
    phase: 'checkpoint',
    taskSummary: 'stale run checkpoint',
    timestamp: '2026-05-31T00:00:01.000Z',
  })

  const afterStale = getSessionSlice(useAgent.getState(), 'session-A').scopeRunStates['scope-A']
  assert.equal(afterStale?.requestId, 'req-new')
  assert.equal(afterStale?.phase, 'planning')
  assert.equal(afterStale?.taskSummary, 'new run planning')

  fireOnScopeRunEvent({
    type: 'updated',
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    phase: 'takeover',
    taskSummary: 'paused by user',
    timestamp: '2026-05-31T00:00:02.000Z',
  })

  const afterTakeover = getSessionSlice(useAgent.getState(), 'session-A').scopeRunStates['scope-A']
  assert.equal(afterTakeover?.requestId, 'req-new')
  assert.equal(afterTakeover?.phase, 'takeover')
  assert.equal(afterTakeover?.taskSummary, 'paused by user')

  fireOnScopeRunEvent({
    type: 'started',
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-next',
    phase: 'planning',
    taskSummary: 'next run planning',
    timestamp: '2026-05-31T00:00:03.000Z',
  })

  const afterStarted = getSessionSlice(useAgent.getState(), 'session-A').scopeRunStates['scope-A']
  assert.equal(afterStarted?.requestId, 'req-next')
  assert.equal(afterStarted?.phase, 'planning')
  assert.equal(afterStarted?.taskSummary, 'next run planning')
})

test('X2.6 — terminal event before timeout disarms the watchdog', async () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 20 })

  // Fire a real terminal error BEFORE the timer expires.
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

  // Now wait past the watchdog window — it should not fire because the
  // terminal handler cleared it.
  await new Promise((resolve) => setTimeout(resolve, 80))

  const state = useAgent.getState()
  // The "Ready 跟丢了" message must NOT appear — the watchdog was
  // disarmed by the terminal event.
  const lostTrackMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('Ready 跟丢了'))
  assert.equal(lostTrackMsg, undefined, 'no spurious infrastructure_timeout toast after a real terminal event')
})

test('X2.6 — explicit clearInfrastructureWatchdog disarms by scope', async () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  driverApi.armInfrastructureWatchdog('scope-A', 'req-A', { timeoutMs: 20 })
  // Clear immediately (e.g. user clicked Stop).
  driverApi.clearInfrastructureWatchdog('scope-A', 'req-A')

  await new Promise((resolve) => setTimeout(resolve, 80))

  const state = useAgent.getState()
  const lostTrackMsg = state.messages.find((m: { content: string }) =>
    typeof m.content === 'string' && m.content.includes('Ready 跟丢了'))
  assert.equal(lostTrackMsg, undefined, 'clearInfrastructureWatchdog disarms the timer')
})
