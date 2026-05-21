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
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    state: 'live',
    conversationId: null,
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
    agents: [{ name: 'butler', displayName: '管家', avatar: '', status: 'idle', selected: true }],
    messages: opts.messages ?? getSessionSlice({ ...useAgent.getState(), sessions: opts.sessions, activeSessionId: opts.activeSessionId }, opts.activeSessionId).messages,
    currentAgent: 'butler',
    inputValue: opts.inputValue ?? opts.sessions[opts.activeSessionId]?.inputValue ?? '',
    pendingContinuationIntent: null,
    pendingContinuationDraftAnchor: null,
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    sessionId: opts.activeSessionId,
    conversationId: opts.sessions[opts.activeSessionId]?.conversationId ?? null,
    conversations: [],
    currentScopeId: opts.sessions[opts.activeSessionId]?.conversationId ?? null,
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
    pendingSendCount: opts.sessions[opts.activeSessionId]?.pendingSendCount ?? 0,
    pendingSendFlushAt: opts.sessions[opts.activeSessionId]?.pendingSendFlushAt ?? null,
    sessions: opts.sessions,
    activeSessionId: opts.activeSessionId,
    sessionOrder: Object.keys(opts.sessions),
    taskDisclosureState: {},
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

test('V3.3b.2 — createNewSession switches to an empty message slice', () => {
  const existing = makeMessage('msg-A1', 'existing A')
  seedStore({
    activeSessionId: 'session-A',
    sessions: {
      'session-A': makeSlice({ messages: [existing], inputValue: 'draft-A' }),
    },
  })

  const newId = useAgent.getState().createNewSession()
  assert.ok(newId, 'new session id is returned')

  const state = useAgent.getState()
  assert.equal(state.activeSessionId, newId, 'new session becomes active')
  assert.deepEqual(state.messages, [], 'visible message mirror is empty for the fresh session')
  assert.deepEqual(getSessionSlice(state, 'session-A').messages, [existing], 'old session messages stay parked')
  assert.deepEqual(getSessionSlice(state, newId).messages, [], 'fresh session slice starts empty')
})

test('V3.3b.2 — newSession writes welcome state into the newly active runtime session', () => {
  const msgA = makeMessage('msg-A1', 'existing A')
  const msgB = makeMessage('msg-B1', 'parked B')
  seedStore({
    activeSessionId: 'session-A',
    sessions: {
      'session-A': makeSlice({ messages: [msgA], inputValue: 'draft-A', conversationId: 'conv-A' }),
      'session-B': makeSlice({ messages: [msgB], inputValue: 'draft-B', conversationId: 'conv-B' }),
    },
  })

  useAgent.getState().newSession()

  const state = useAgent.getState()
  assert.ok(state.activeSessionId, 'new local session becomes active')
  assert.equal(state.sessionId, state.activeSessionId, 'runtime session id mirrors active session id')
  assert.equal(state.sessionOrder[0], state.activeSessionId, 'new local session replaces the old active tab')
  assert.equal(state.sessionOrder.includes('session-A'), false, 'old active session is removed from the visible tab order')
  assert.equal(getSessionSlice(state, state.activeSessionId).conversationId, state.currentScopeId)
  assert.deepEqual(
    getSessionSlice(state, state.activeSessionId).messages.map((message) => message.id),
    state.messages.map((message) => message.id),
    'top-level messages mirror the new active session',
  )
  assert.deepEqual(
    getSessionSlice(state, 'session-B').messages.map((message) => message.id),
    ['msg-B1'],
    'parked background session stays untouched',
  )
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
