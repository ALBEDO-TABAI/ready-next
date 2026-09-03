/**
 * Stage V V3.3b.2 — multi-session visible-state isolation.
 *
 * Covers the remaining visible state that V3.3b.1 did not migrate:
 * `messages` plus the `setComposerDraft` write path. The store still keeps
 * top-level mirrors for existing ChatPanel selectors; this test proves the
 * mirrors follow the active session while parked sessions keep their own
 * message/draft slices.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getSessionSlice,
  useAgent,
  type AgentMessage,
  type ScopeRunState,
  type SessionSlice,
} from '../renderer/stores/useAgent'

function makeMessage(id: string, content: string, type: AgentMessage['type'] = 'agent'): AgentMessage {
  return {
    id,
    agent: 'butler',
    content,
    type,
    timestamp: new Date(`2026-05-22T00:00:0${id.slice(-1) || '0'}Z`),
  }
}

function makeSlice(opts: Partial<SessionSlice> = {}): SessionSlice {
  return {
    messages: [],
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    scopeRunStates: {},
    taskDisclosureState: {},
    lifecyclePendingAction: null,
    lifecycleError: null,
    state: 'live',
    conversationId: null,
    aliasGeneration: null,
    inputValue: '',
    ...opts,
  }
}

function seedStore(opts: {
  activeSessionId: string
  sessions: Record<string, SessionSlice>
  messages?: AgentMessage[]
  inputValue?: string
}) {
  useAgent.setState({
    agents: [{ name: 'butler', displayName: '管家', avatar: '', status: 'idle' }],
    messages: opts.messages ?? getSessionSlice({ ...useAgent.getState(), sessions: opts.sessions, activeSessionId: opts.activeSessionId }, opts.activeSessionId).messages,
    currentAgent: 'butler',
    inputValue: opts.inputValue ?? opts.sessions[opts.activeSessionId]?.inputValue ?? '',
    pendingContinuationIntent: null,
    pendingContinuationDraftAnchor: null,
    isStreaming: opts.sessions[opts.activeSessionId]?.isStreaming ?? false,
    foregroundBusy: opts.sessions[opts.activeSessionId]?.foregroundBusy ?? false,
    composerLocked: opts.sessions[opts.activeSessionId]?.composerLocked ?? false,
    streamingMessageId: opts.sessions[opts.activeSessionId]?.streamingMessageId ?? null,
    streamingRequestId: opts.sessions[opts.activeSessionId]?.streamingRequestId ?? null,
    sessionId: opts.activeSessionId,
    conversationId: opts.sessions[opts.activeSessionId]?.conversationId ?? null,
    conversations: [],
    currentScopeId: opts.sessions[opts.activeSessionId]?.conversationId ?? null,
    currentScope: null,
    scopes: [],
    scopeRunStates: opts.sessions[opts.activeSessionId]?.scopeRunStates ?? {},
    toolTrace: [],
    toolTraceStatus: 'idle',
    attachments: [],
    filePool: [],
    activeAttachmentPreview: null,
    sessions: opts.sessions,
    activeSessionId: opts.activeSessionId,
    sessionOrder: Object.keys(opts.sessions),
    taskDisclosureState: opts.sessions[opts.activeSessionId]?.taskDisclosureState ?? {},
  })
}

test('V3.3b.2 — messages mirror follows active session and preserves parked session messages', () => {
  const msgA = makeMessage('msg-A1', 'A parked')
  const msgB = makeMessage('msg-B1', 'B active')
  seedStore({
    activeSessionId: 'session-B',
    sessions: {
      'session-A': makeSlice({ messages: [msgA], inputValue: 'draft-A', conversationId: 'conv-A' }),
      'session-B': makeSlice({ messages: [msgB], inputValue: 'draft-B', conversationId: 'conv-B' }),
    },
  })

  useAgent.getState().addMessage(makeMessage('msg-B2', 'B follow-up', 'user'))

  let state = useAgent.getState()
  assert.deepEqual(
    state.messages.map((message) => message.id),
    ['msg-B1', 'msg-B2'],
    'top-level messages mirror active session B only',
  )
  assert.deepEqual(
    getSessionSlice(state, 'session-A').messages.map((message) => message.id),
    ['msg-A1'],
    'session A parked messages are untouched by a session B write',
  )
  assert.deepEqual(
    getSessionSlice(state, 'session-B').messages.map((message) => message.id),
    ['msg-B1', 'msg-B2'],
    'session B slice receives the active write',
  )

  useAgent.getState().setActiveSessionId('session-A')
  state = useAgent.getState()
  assert.deepEqual(
    state.messages.map((message) => message.id),
    ['msg-A1'],
    'switching to A mirrors A messages into the visible top-level field',
  )
  assert.equal(state.inputValue, 'draft-A', 'switching to A also mirrors A composer draft')
})

function makeRun(scopeId: string, phase: ScopeRunState['phase'] = 'responding'): ScopeRunState {
  return {
    scopeId,
    agent: 'butler',
    requestId: `req-${scopeId}`,
    phase,
    toolTrace: [
      {
        id: `trace-${scopeId}`,
        kind: 'call',
        text: `trace ${scopeId}`,
        timestamp: new Date('2026-05-22T00:00:00.000Z'),
      },
    ],
    startedAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:01.000Z',
    latestText: null,
    blockedReason: null,
    controllerId: null,
    ownerTabId: null,
    checkpointExpiresAt: null,
    responseMessageId: `response-${scopeId}`,
    responseBuffer: '',
    responseSegmentBreakPending: false,
    responseSegmentToolTraceStart: 0,
    stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
    error: null,
  }
}

test('V3.3b.2 — setComposerDraft writes active session slice, not just top-level inputValue', () => {
  seedStore({
    activeSessionId: 'session-A',
    sessions: {
      'session-A': makeSlice({ inputValue: 'old-A' }),
      'session-B': makeSlice({ inputValue: 'old-B' }),
    },
  })

  useAgent.getState().setComposerDraft('new-A')

  const state = useAgent.getState()
  assert.equal(state.inputValue, 'new-A', 'top-level draft mirror updates')
  assert.equal(getSessionSlice(state, 'session-A').inputValue, 'new-A', 'active session draft updates')
  assert.equal(getSessionSlice(state, 'session-B').inputValue, 'old-B', 'parked session draft stays untouched')
})

test('V3.3b.2 — a parked background card appears only after switching to that session', () => {
  const msgB = makeMessage('msg-B1', 'B active')
  const backgroundCard = makeMessage('card-A1', 'A question', 'ask_user_questions')
  seedStore({
    activeSessionId: 'session-B',
    sessions: {
      'session-A': makeSlice({ messages: [], conversationId: 'conv-A' }),
      'session-B': makeSlice({ messages: [msgB], conversationId: 'conv-B' }),
    },
  })

  useAgent.setState((state) => ({
    sessions: {
      ...state.sessions,
      'session-A': {
        ...state.sessions['session-A'],
        messages: [backgroundCard],
      },
    },
  }))

  assert.deepEqual(
    useAgent.getState().messages.map((message) => message.id),
    ['msg-B1'],
    'background card does not interrupt active session B',
  )

  useAgent.getState().setActiveSessionId('session-A')

  assert.deepEqual(
    useAgent.getState().messages.map((message) => message.id),
    ['card-A1'],
    'background card becomes visible after switching to session A',
  )
})

test('V3.3e — background streaming state stays parked until its session is active', () => {
  seedStore({
    activeSessionId: 'session-B',
    sessions: {
      'session-A': makeSlice({ conversationId: 'scope-A' }),
      'session-B': makeSlice({ conversationId: 'scope-B' }),
    },
  })

  useAgent.setState((state) => ({
    sessions: {
      ...state.sessions,
      'session-A': {
        ...getSessionSlice(state, 'session-A'),
        isStreaming: true,
        foregroundBusy: true,
        composerLocked: true,
        streamingMessageId: 'message-A',
        streamingRequestId: 'request-A',
      },
    },
  }))

  let state = useAgent.getState()
  assert.equal(state.isStreaming, false, 'background session A streaming does not lock active session B')
  assert.equal(state.streamingRequestId, null, 'active session B request mirror stays empty')

  useAgent.getState().setActiveSessionId('session-A')

  state = useAgent.getState()
  assert.equal(state.isStreaming, true, 'switching to A restores A streaming state')
  assert.equal(state.foregroundBusy, true)
  assert.equal(state.composerLocked, true)
  assert.equal(state.streamingMessageId, 'message-A')
  assert.equal(state.streamingRequestId, 'request-A')
})

test('V3.3e — scope run state mirrors only the active session', () => {
  const runA = makeRun('scope-A', 'tool_running')
  const runB = makeRun('scope-B', 'done')
  seedStore({
    activeSessionId: 'session-B',
    sessions: {
      'session-A': makeSlice({ conversationId: 'scope-A', scopeRunStates: { 'scope-A': runA } }),
      'session-B': makeSlice({ conversationId: 'scope-B', scopeRunStates: { 'scope-B': runB } }),
    },
  })

  let state = useAgent.getState()
  assert.equal(state.scopeRunStates['scope-A'], undefined, 'active mirror starts with session B only')
  assert.equal(state.scopeRunStates['scope-B']?.phase, 'done')

  useAgent.getState().setActiveSessionId('session-A')

  state = useAgent.getState()
  assert.equal(state.currentScopeId, 'scope-A')
  assert.equal(state.scopeRunStates['scope-A']?.phase, 'tool_running')
  assert.equal(state.scopeRunStates['scope-B'], undefined, 'session B run state is parked after switching to A')
  assert.equal(state.isStreaming, true, 'active A run derives the streaming mirror')
  assert.equal(state.toolTrace[0]?.id, 'trace-scope-A')
})

test('V3.3e — task disclosure state is isolated per session', () => {
  seedStore({
    activeSessionId: 'session-B',
    sessions: {
      'session-A': makeSlice({ taskDisclosureState: { 'task-A': { details: true } } }),
      'session-B': makeSlice(),
    },
  })

  useAgent.getState().toggleTaskSection('task-B', 'overview')

  let state = useAgent.getState()
  assert.equal(state.taskDisclosureState['task-B']?.overview, true, 'active B disclosure updates top-level mirror')
  assert.equal(getSessionSlice(state, 'session-A').taskDisclosureState['task-A']?.details, true)
  assert.equal(getSessionSlice(state, 'session-A').taskDisclosureState['task-B'], undefined)

  useAgent.getState().setActiveSessionId('session-A')
  state = useAgent.getState()
  assert.equal(state.taskDisclosureState['task-A']?.details, true, 'switching to A restores A disclosure')
  assert.equal(state.taskDisclosureState['task-B'], undefined, 'B disclosure is parked while A is active')

  useAgent.getState().setActiveSessionId('session-B')
  state = useAgent.getState()
  assert.equal(state.taskDisclosureState['task-B']?.overview, true, 'switching back restores B disclosure')
})
