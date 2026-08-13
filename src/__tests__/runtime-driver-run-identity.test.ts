import assert from 'node:assert/strict'
import test from 'node:test'

import {
  completedToolActionRequests,
  fireOnConversationEvent,
  fireOnError,
  fireRawOnScopeRunEvent,
  fireOnScopeRunEvent,
  fireOnToolAction,
  fireOnToolActionRequest,
  getSessionSlice,
  seedTwoSessions,
  useAgent,
} from './runtime-driver-test-fixtures'
import { useMode } from '../renderer/stores/useMode'

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition_not_observed')
}

function seedCurrentRun(requestId = 'req-current'): void {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId,
  })
}

test('scope-run events without the exact generation and visibility identity are ignored', () => {
  seedCurrentRun()
  const before = getSessionSlice(useAgent.getState(), 'session-A')

  fireRawOnScopeRunEvent({
    type: 'started',
    scopeId: 'scope-A',
    sessionId: 'session-A',
    agent: 'butler',
    runId: 'req-missing-identity',
    phase: 'planning',
    timestamp: '2026-08-12T10:00:00.000Z',
  })

  assert.deepEqual(getSessionSlice(useAgent.getState(), 'session-A'), before)
})

test('pre-reset started and terminal events cannot mutate the reset generation', () => {
  seedCurrentRun()
  useAgent.setState((state) => {
    const resetSlice = {
      ...getSessionSlice(state, 'session-A'),
      aliasGeneration: 2,
      messageVisibilityEpoch: 1,
      scopeRunStates: {},
      streamingRequestId: null,
      streamingMessageId: null,
      isStreaming: false,
      foregroundBusy: false,
      composerLocked: false,
    }
    const scopes = state.scopes.map((scope) => scope.id === 'scope-A'
      ? { ...scope, aliasGeneration: 2, messageVisibilityEpoch: 1 }
      : scope)
    return {
      sessions: { ...state.sessions, 'session-A': resetSlice },
      scopes,
      currentScope: scopes.find((scope) => scope.id === 'scope-A') || null,
      messages: [],
      scopeRunStates: {},
      streamingRequestId: null,
      streamingMessageId: null,
      isStreaming: false,
      foregroundBusy: false,
      composerLocked: false,
    }
  })
  const before = getSessionSlice(useAgent.getState(), 'session-A')
  const oldIdentity = { aliasGeneration: 1, messageVisibilityEpoch: 0 }

  fireOnScopeRunEvent({
    ...oldIdentity,
    type: 'started',
    scopeId: 'scope-A',
    sessionId: 'session-A',
    agent: 'butler',
    runId: 'req-old',
    phase: 'planning',
    timestamp: '2026-08-12T10:01:00.000Z',
  })
  fireOnScopeRunEvent({
    ...oldIdentity,
    type: 'terminal',
    scopeId: 'scope-A',
    sessionId: 'session-A',
    agent: 'butler',
    runId: 'req-old',
    phase: 'error',
    terminalReason: 'failed',
    timestamp: '2026-08-12T10:02:00.000Z',
  })

  assert.deepEqual(getSessionSlice(useAgent.getState(), 'session-A'), before)
})

test('a current-generation terminal event still reconciles a same-history stop', () => {
  seedCurrentRun()
  useAgent.setState((state) => {
    const currentSlice = getSessionSlice(state, 'session-A')
    const scopes = state.scopes.map((scope) => scope.id === 'scope-A'
      ? { ...scope, aliasGeneration: 2, messageVisibilityEpoch: 0 }
      : scope)
    return {
      sessions: {
        ...state.sessions,
        'session-A': {
          ...currentSlice,
          aliasGeneration: 2,
          messageVisibilityEpoch: 0,
          lifecyclePendingAction: 'stopping',
        },
      },
      scopes,
      currentScope: scopes.find((scope) => scope.id === 'scope-A') || null,
    }
  })

  fireOnScopeRunEvent({
    aliasGeneration: 2,
    messageVisibilityEpoch: 0,
    type: 'terminal',
    scopeId: 'scope-A',
    sessionId: 'session-A',
    agent: 'butler',
    runId: 'req-current',
    phase: 'cancelled',
    terminalReason: 'cancelled_user',
    timestamp: '2026-08-12T10:03:00.000Z',
  })

  const slice = getSessionSlice(useAgent.getState(), 'session-A')
  assert.equal(slice.aliasGeneration, 2)
  assert.equal(slice.messageVisibilityEpoch, 0)
  assert.equal(slice.lifecyclePendingAction, null)
  assert.equal(slice.streamingRequestId, null)
  assert.equal(slice.composerLocked, false)
  assert.equal(slice.scopeRunStates['scope-A']?.phase, 'cancelled')
})

test('same-history generation rollover accepts a new started run and its terminal event', () => {
  seedCurrentRun()
  useAgent.setState((state) => {
    const currentSlice = getSessionSlice(state, 'session-A')
    const scopes = state.scopes.map((scope) => scope.id === 'scope-A'
      ? { ...scope, aliasGeneration: 2, messageVisibilityEpoch: 0 }
      : scope)
    return {
      sessions: {
        ...state.sessions,
        'session-A': {
          ...currentSlice,
          aliasGeneration: 2,
          messageVisibilityEpoch: 0,
          lifecyclePendingAction: 'stopping',
        },
      },
      scopes,
      currentScope: scopes.find((scope) => scope.id === 'scope-A') || null,
    }
  })

  fireOnScopeRunEvent({
    aliasGeneration: 2,
    messageVisibilityEpoch: 0,
    type: 'started',
    scopeId: 'scope-A',
    sessionId: 'session-A',
    agent: 'butler',
    runId: 'req-generation-2',
    phase: 'planning',
    timestamp: '2026-08-12T10:04:00.000Z',
  })

  let slice = getSessionSlice(useAgent.getState(), 'session-A')
  assert.equal(slice.streamingRequestId, 'req-generation-2')
  assert.equal(slice.scopeRunStates['scope-A']?.requestId, 'req-generation-2')
  assert.equal(slice.scopeRunStates['scope-A']?.phase, 'planning')

  fireOnScopeRunEvent({
    aliasGeneration: 2,
    messageVisibilityEpoch: 0,
    type: 'terminal',
    scopeId: 'scope-A',
    sessionId: 'session-A',
    agent: 'butler',
    runId: 'req-generation-2',
    phase: 'cancelled',
    terminalReason: 'cancelled_user',
    timestamp: '2026-08-12T10:05:00.000Z',
  })

  slice = getSessionSlice(useAgent.getState(), 'session-A')
  assert.equal(slice.lifecyclePendingAction, null)
  assert.equal(slice.streamingRequestId, null)
  assert.equal(slice.composerLocked, false)
  assert.equal(slice.scopeRunStates['scope-A']?.phase, 'cancelled')
})

test('same-epoch scope alias rollover preserves read authority', () => {
  seedCurrentRun()
  const before = useAgent.getState()
  const scope = before.scopes.find((candidate) => candidate.id === 'scope-A')
  assert.ok(scope)

  fireOnConversationEvent({
    type: 'scope_updated',
    scope: {
      ...scope,
      aliasGeneration: 2,
      messageVisibilityEpoch: 0,
      updatedAt: '2026-08-12T10:06:00.000Z',
    },
  })

  const state = useAgent.getState()
  assert.equal(state.scopeAuthorityRevision, before.scopeAuthorityRevision)
  assert.equal(state.currentScope?.aliasGeneration, 2)
  assert.equal(getSessionSlice(state, 'session-A').aliasGeneration, 2)
  assert.equal(getSessionSlice(state, 'session-A').messageVisibilityEpoch, 0)
})

test('stale terminal and recoverable errors cannot mutate the current run', () => {
  seedCurrentRun()

  fireOnError({
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-old',
    error: 'old terminal failure',
    errorKind: 'unknown',
    recoverable: false,
  })
  fireOnError({
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-old',
    error: 'old recoverable failure',
    errorKind: 'network',
    recoverable: true,
  })

  const slice = getSessionSlice(useAgent.getState(), 'session-A')
  const run = slice.scopeRunStates['scope-A']
  assert.equal(slice.streamingRequestId, 'req-current')
  assert.equal(slice.composerLocked, true)
  assert.equal(run?.requestId, 'req-current')
  assert.equal(run?.phase, 'responding')
  assert.equal(run?.error ?? null, null)
  assert.equal(run?.softError ?? null, null)
})

test('canonical message only supersedes a transient from the same run', () => {
  seedCurrentRun('req-new')
  const timestamp = new Date('2026-08-11T12:00:00.000Z')
  const transient = {
    id: 'transient-new',
    agent: 'butler',
    content: '已手动停止任务',
    type: 'agent' as const,
    timestamp,
    meta: { transient: true, runId: 'req-new', scopeId: 'scope-A' },
  }
  useAgent.setState((state) => ({
    messages: [transient],
    scopeLiveMessages: { ...state.scopeLiveMessages, 'scope-A': [transient] },
    sessions: {
      ...state.sessions,
      'session-A': { ...state.sessions['session-A'], messages: [transient] },
    },
  }))

  fireOnConversationEvent({
    type: 'message_added',
    scope: {
      id: 'scope-A',
      agent: 'butler',
      title: 'A',
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
    },
    message: {
      id: 'canonical-old',
      role: 'assistant',
      content: transient.content,
      timestamp: timestamp.toISOString(),
      meta: { runId: 'req-old' },
    },
  })

  let state = useAgent.getState()
  assert.equal(state.messages.some((message) => message.id === 'transient-new'), true)
  assert.equal(state.scopeLiveMessages['scope-A']?.some((message) => message.id === 'transient-new'), true)

  fireOnConversationEvent({
    type: 'message_added',
    scope: {
      id: 'scope-A',
      agent: 'butler',
      title: 'A',
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
    },
    message: {
      id: 'canonical-new',
      role: 'assistant',
      content: transient.content,
      timestamp: timestamp.toISOString(),
      meta: { runId: 'req-new' },
    },
  })

  state = useAgent.getState()
  assert.equal(state.messages.some((message) => message.id === 'transient-new'), false)
  assert.equal(state.messages.some((message) => message.id === 'canonical-new'), true)
  assert.equal(state.scopeLiveMessages['scope-A']?.some((message) => message.id === 'transient-new'), false)
})

test('terminal scope event cannot unlock when streaming and scope run identities diverge', () => {
  seedCurrentRun()
  useAgent.setState((state) => ({
    sessions: {
      ...state.sessions,
      'session-A': {
        ...state.sessions['session-A'],
        lifecyclePendingAction: 'stopping',
        scopeRunStates: {
          ...state.sessions['session-A'].scopeRunStates,
          'scope-A': {
            ...state.sessions['session-A'].scopeRunStates['scope-A'],
            requestId: 'req-new',
            phase: 'responding',
          },
        },
      },
    },
    scopeRunStates: {
      ...state.scopeRunStates,
      'scope-A': {
        ...state.scopeRunStates['scope-A'],
        requestId: 'req-new',
        phase: 'responding',
      },
    },
  }))

  fireOnScopeRunEvent({
    type: 'terminal',
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-current',
    phase: 'error',
    terminalReason: 'failed',
    timestamp: '2026-08-11T12:00:00.000Z',
  })

  const slice = getSessionSlice(useAgent.getState(), 'session-A')
  assert.equal(slice.streamingRequestId, 'req-current')
  assert.equal(slice.composerLocked, true)
  assert.equal(slice.lifecyclePendingAction, 'stopping')
  assert.equal(slice.scopeRunStates['scope-A']?.requestId, 'req-new')
  assert.equal(slice.scopeRunStates['scope-A']?.phase, 'responding')
})

test('late conversation and run events cannot recreate a durably closed scope', () => {
  seedCurrentRun()
  useAgent.setState({
    sessions: {},
    sessionOrder: [],
    activeSessionId: null,
    currentScopeId: null,
    currentScope: null,
    conversationId: null,
    scopes: [],
    conversations: [],
    messages: [],
    scopeRunStates: {},
    retiredScopeIds: { 'scope-A': true },
  })
  const scope = {
    id: 'scope-A',
    aliasGeneration: 1,
    agent: 'butler',
    activeAgentId: 'butler',
    handoffGeneration: 0,
    title: 'Closed',
    sourceKind: 'local',
    sourceId: 'app',
    threadKey: 'scope-A',
    meta: {},
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
    lastMessageAt: null,
  }

  fireOnConversationEvent({ type: 'scope_created', scope })
  fireOnConversationEvent({
    type: 'message_added',
    scope,
    message: {
      id: 'message-late-closed',
      role: 'assistant',
      content: 'late',
      timestamp: '2026-08-12T00:01:00.000Z',
      meta: { runId: 'run-late-closed' },
    },
  })
  fireOnScopeRunEvent({
    type: 'started',
    scopeId: scope.id,
    sessionId: 'session-late-closed',
    agent: 'butler',
    runId: 'run-late-closed',
    phase: 'planning',
    timestamp: '2026-08-12T00:01:00.000Z',
  })
  fireOnScopeRunEvent({
    type: 'terminal',
    scopeId: scope.id,
    sessionId: 'session-late-closed',
    agent: 'butler',
    runId: 'run-late-closed',
    phase: 'done',
    timestamp: '2026-08-12T00:02:00.000Z',
  })

  const state = useAgent.getState()
  assert.deepEqual(state.scopes, [])
  assert.deepEqual(state.sessions, {})
  assert.deepEqual(state.messages, [])
  assert.deepEqual(state.scopeRunStates, {})
})

test('background started event aligns its owner before stale error and tool events arrive', async () => {
  seedTwoSessions({
    activeSessionId: 'session-B',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-old',
  })
  useMode.setState({ workbenchMode: 'browser', readySubMode: 'browser' })

  fireOnScopeRunEvent({
    type: 'started',
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-new',
    phase: 'planning',
    timestamp: '2026-08-11T12:00:00.000Z',
  })
  fireOnError({
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-old',
    error: 'old terminal failure',
    errorKind: 'unknown',
    recoverable: false,
  })
  fireOnToolAction({
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-old',
    tool: 'app.switchMode',
    args: { mode: 'document' },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))

  const slice = getSessionSlice(useAgent.getState(), 'session-A')
  const run = slice.scopeRunStates['scope-A']
  assert.equal(slice.streamingRequestId, 'req-new')
  assert.equal(slice.composerLocked, true)
  assert.equal(run?.requestId, 'req-new')
  assert.equal(run?.phase, 'planning')
  assert.equal(run?.error ?? null, null)
  assert.deepEqual(run?.toolTrace, [])
  assert.equal(useMode.getState().workbenchMode, 'browser')
})

test('stale tool events do not execute and tool requests acknowledge stale_run', async () => {
  seedCurrentRun()
  completedToolActionRequests.length = 0
  useMode.setState({ workbenchMode: 'browser', readySubMode: 'browser' })

  fireOnToolAction({
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-old',
    tool: 'app.switchMode',
    args: { mode: 'document' },
  })
  fireOnToolActionRequest({
    requestId: 'tool-stale',
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-old',
    tool: 'app.switchMode',
    args: { mode: 'calendar' },
  })

  await waitFor(() => completedToolActionRequests.some((item) => item.requestId === 'tool-stale'))
  assert.equal(useMode.getState().workbenchMode, 'browser')
  assert.deepEqual(
    completedToolActionRequests.find((item) => item.requestId === 'tool-stale'),
    { requestId: 'tool-stale', handled: false, error: 'stale_run' },
  )
  const run = getSessionSlice(useAgent.getState(), 'session-A').scopeRunStates['scope-A']
  assert.equal(run?.requestId, 'req-current')
  assert.deepEqual(run?.toolTrace, [])
})

test('tool request that becomes stale while awaiting cannot write into the new run', async () => {
  seedCurrentRun()
  completedToolActionRequests.length = 0

  let markHandlerStarted!: () => void
  const handlerStarted = new Promise<void>((resolve) => { markHandlerStarted = resolve })
  let releaseHandler!: (value: Record<string, unknown>) => void
  const handlerResult = new Promise<Record<string, unknown>>((resolve) => { releaseHandler = resolve })
  const readyWindow = window as Window & {
    __readyModuleAgentHandlers?: Record<string, (request: unknown) => Promise<unknown>>
  }
  readyWindow.__readyModuleAgentHandlers = {
    ...(readyWindow.__readyModuleAgentHandlers || {}),
    calendar: async () => {
      markHandlerStarted()
      return await handlerResult
    },
  }

  try {
    fireOnToolActionRequest({
      requestId: 'tool-awaiting',
      scopeId: 'scope-A',
      sessionId: 'scope-A',
      agent: 'butler',
      runId: 'req-current',
      tool: 'calendar.lookup',
      args: {},
    })
    await handlerStarted

    fireOnScopeRunEvent({
      type: 'started',
      scopeId: 'scope-A',
      sessionId: 'scope-A',
      agent: 'butler',
      runId: 'req-new',
      phase: 'planning',
      timestamp: '2026-08-11T12:00:00.000Z',
    })
    releaseHandler({ summary: 'old run result' })

    await waitFor(() => completedToolActionRequests.some((item) => item.requestId === 'tool-awaiting'))
    assert.deepEqual(
      completedToolActionRequests.find((item) => item.requestId === 'tool-awaiting'),
      { requestId: 'tool-awaiting', handled: false, error: 'stale_run' },
    )
    const run = getSessionSlice(useAgent.getState(), 'session-A').scopeRunStates['scope-A']
    assert.equal(run?.requestId, 'req-new')
    assert.equal(run?.phase, 'planning')
    assert.deepEqual(run?.toolTrace, [])
  } finally {
    delete readyWindow.__readyModuleAgentHandlers?.calendar
  }
})

test('duplicate tool request waits for the original execution and acknowledges exactly once', async () => {
  seedCurrentRun()
  completedToolActionRequests.length = 0

  let markHandlerStarted!: () => void
  const handlerStarted = new Promise<void>((resolve) => { markHandlerStarted = resolve })
  let releaseHandler!: (value: Record<string, unknown>) => void
  const handlerResult = new Promise<Record<string, unknown>>((resolve) => { releaseHandler = resolve })
  const readyWindow = window as Window & {
    __readyModuleAgentHandlers?: Record<string, (request: unknown) => Promise<unknown>>
  }
  readyWindow.__readyModuleAgentHandlers = {
    ...(readyWindow.__readyModuleAgentHandlers || {}),
    calendar: async () => {
      markHandlerStarted()
      return await handlerResult
    },
  }
  const request = {
    requestId: 'tool-duplicate',
    scopeId: 'scope-A',
    sessionId: 'scope-A',
    agent: 'butler',
    runId: 'req-current',
    tool: 'calendar.lookup',
    args: {},
  }

  try {
    fireOnToolActionRequest(request)
    await handlerStarted
    fireOnToolActionRequest(request)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(completedToolActionRequests.length, 0, 'duplicate dispatch cannot settle the original request')

    releaseHandler({ summary: 'original result' })
    await waitFor(() => completedToolActionRequests.length === 1)
    assert.deepEqual(completedToolActionRequests, [{
      requestId: 'tool-duplicate',
      handled: true,
      payload: { summary: 'original result' },
    }])
  } finally {
    delete readyWindow.__readyModuleAgentHandlers?.calendar
  }
})
