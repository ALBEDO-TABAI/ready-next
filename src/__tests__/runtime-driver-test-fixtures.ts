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
 * Plus X2.6 — the 60s renderer liveness probe. Main-confirmed active runs
 * stay alive; only a missing/stale run or an unreachable main releases the
 * renderer lock.
 *
 * The driver listens via `window.electronAPI.agent.onError(...)`. The test
 * installs a minimal electronAPI stub that captures the registered handlers
 * so we can fire synthetic IPC events at the driver from inside Node.
 */

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

export const captured: CapturedHandlers = {
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

export const infrastructureTimeoutReports: Array<{ scopeId: string; requestId: string; elapsedMs?: number }> = []
export const completedToolActionRequests: Array<{
  requestId: string
  handled: boolean
  error?: string
  payload?: Record<string, unknown>
}> = []
export const fixtureState: {
  infrastructureTimeoutReportResult: unknown
  conversationScopeMessages: Array<{
  id: string
  conversationId: string
  role: string
  content: string
  timestamp: string
  meta: Record<string, unknown>
}>
} = {
  infrastructureTimeoutReportResult: { success: true, data: { state: 'not_found' } },
  conversationScopeMessages: [],
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

export const electronAPIStub = {
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
    completeToolActionRequest: async (payload: {
      requestId: string
      handled: boolean
      error?: string
      payload?: Record<string, unknown>
    }) => {
      completedToolActionRequests.push(payload)
      return { success: true }
    },
    reportInfrastructureTimeout: async (payload: { scopeId: string; requestId: string; elapsedMs?: number }) => {
      infrastructureTimeoutReports.push(payload)
      return fixtureState.infrastructureTimeoutReportResult
    },
    kill: async () => ({ success: true }),
    newSession: async () => ({ success: true }),
    createLocalScope: async () => ({ success: true }),
    getConversationScopeMessages: async () => ({ success: true, data: fixtureState.conversationScopeMessages }),
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

export const { useAgent, getSessionSlice } = await import('../renderer/stores/useAgent')
const { createAgentRuntimeDriver } = await import('../renderer/modules/agent/runtimeDriver')

const driver = createAgentRuntimeDriver(useAgent as unknown as { getState: () => unknown; setState: (partial: unknown) => void })
driver.initAgentListeners()

type DriverApi = {
  armInfrastructureWatchdog: (scopeId: string, requestId: string, options?: { timeoutMs?: number }) => void
  clearInfrastructureWatchdog: (scopeId: string, requestId: string | null | undefined) => void
  completeScopeRunAfterSendSuccess: (
    scopeId: string,
    requestId: string,
    options?: {
      canonicalMessage?: {
        id: string
        conversationId: string
        role: 'assistant'
        content: string
        timestamp: string
        meta: Record<string, unknown>
      } | null
      acceptedAsSteering?: boolean
      ownerRunId?: string | null
      previousOwnerRun?: SessionSlice['scopeRunStates'][string] | null
    },
  ) => Promise<void>
}
export const driverApi = driver as unknown as DriverApi

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function makeLockedSlice(scopeId: string, requestId: string): SessionSlice {
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
    aliasGeneration: 1,
    messageVisibilityEpoch: 0,
    inputValue: '',
  }
}

export function makeEmptySlice(scopeId: string): SessionSlice {
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
    aliasGeneration: 1,
    messageVisibilityEpoch: 0,
    inputValue: '',
  }
}

export function seedTwoSessions(opts: {
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
  const scopes = [...new Set(Object.values(sessions)
    .map((slice) => slice.conversationId)
    .filter((scopeId): scopeId is string => Boolean(scopeId)))]
    .map((scopeId) => ({
      id: scopeId,
      aliasGeneration: 1,
      messageVisibilityEpoch: 0,
      agent: 'butler',
      activeAgentId: 'butler',
      handoffGeneration: 0,
      title: scopeId,
      sourceKind: 'local' as const,
      sourceId: 'app',
      threadKey: scopeId,
      meta: {},
      createdAt: '2026-05-22T00:00:00.000Z',
      updatedAt: '2026-05-22T00:00:00.000Z',
      lastMessageAt: null,
    }))
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
    currentScope: scopes.find((scope) => scope.id === activeSlice.conversationId) || null,
    scopes,
    retiredScopeIds: {},
    scopeAuthorityRevision: 0,
    scopeListRequestRevision: 0,
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
    conversations: scopes.map((scope) => ({
      id: scope.id,
      agent: scope.agent,
      title: scope.title,
      created_at: scope.createdAt,
      updated_at: scope.updatedAt,
    })),
  })
}

export function fireOnError(data: Record<string, unknown>): void {
  for (const handler of captured.onError) handler(data)
}

export function fireOnStream(data: Record<string, unknown>): void {
  for (const handler of captured.onStream) handler(data)
}

export function fireOnScopeRunEvent(data: Record<string, unknown>): void {
  const state = useAgent.getState()
  const scopeId = typeof data.scopeId === 'string' ? data.scopeId : ''
  const scope = state.scopes.find((candidate) => candidate.id === scopeId)
  const sessionId = scopeId
    ? Object.keys(state.sessions).find((candidate) => (
        getSessionSlice(state, candidate).conversationId === scopeId
      )) || null
    : null
  const slice = sessionId ? getSessionSlice(state, sessionId) : null
  const event = {
    aliasGeneration: slice?.aliasGeneration ?? scope?.aliasGeneration,
    messageVisibilityEpoch: slice?.messageVisibilityEpoch ?? scope?.messageVisibilityEpoch,
    ...data,
  }
  for (const handler of captured.onScopeRunEvent) handler(event)
}

export function fireRawOnScopeRunEvent(data: Record<string, unknown>): void {
  for (const handler of captured.onScopeRunEvent) handler(data)
}

export function fireOnConversationEvent(data: Record<string, unknown>): void {
  for (const handler of captured.onConversationEvent) handler(data)
}

export function fireOnToolAction(data: Record<string, unknown>): void {
  for (const handler of captured.onToolAction) handler(data)
}

export function fireOnToolActionRequest(data: Record<string, unknown>): void {
  for (const handler of captured.onToolActionRequest) handler(data)
}

// ---------------------------------------------------------------------------
// Test X2.1 #4 — failed send unlocks composer for the originating session
// even when user has NOT switched scopes (basic baseline).
// ---------------------------------------------------------------------------
