import assert from 'node:assert/strict'
import test from 'node:test'
import {
  captured,
  driverApi,
  electronAPIStub,
  fireOnError,
  fireOnScopeRunEvent,
  fireOnStream,
  fixtureState,
  getSessionSlice,
  infrastructureTimeoutReports,
  makeLockedSlice,
  seedTwoSessions,
  useAgent,
} from './runtime-driver-test-fixtures'

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


test('sendScoped success without a canonical terminal cannot unlock or finalize a run', () => {
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
  assert.equal(afterSlice.isStreaming, true, 'missing canonical terminal keeps session streaming')
  assert.equal(afterSlice.foregroundBusy, true, 'missing canonical terminal keeps foreground ownership')
  assert.equal(afterSlice.composerLocked, true, 'missing canonical terminal cannot unlock the composer')
  assert.equal(afterSlice.streamingRequestId, 'req-A', 'missing canonical terminal keeps the owner identity')
  assert.equal(state.isStreaming, true, 'active mirror remains owned')
  assert.equal(state.composerLocked, true, 'active mirror remains locked')
  assert.equal(afterSlice.scopeRunStates['scope-A']?.terminalReason, 'done')
})


test('accepted steering restores the existing owner and removes only the fake request placeholder', () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  const before = useAgent.getState()
  const ownerRun = getSessionSlice(before, 'session-A').scopeRunStates['scope-A']
  const fakeRun = {
    ...ownerRun,
    requestId: 'req-steering-ui',
    phase: 'planning' as const,
    responseMessageId: 'response-steering-ui',
    responseBuffer: '',
  }
  const fakeMessage = {
    id: 'response-steering-ui',
    agent: 'butler',
    content: '',
    type: 'agent',
    timestamp: new Date(),
    meta: { transient: true, runId: 'req-steering-ui', scopeId: 'scope-A' },
  } as const
  const ownerMessage = {
    id: 'response-owner',
    agent: 'butler',
    content: '原任务正在执行',
    type: 'agent',
    timestamp: new Date(),
    meta: { transient: true, runId: 'req-A', scopeId: 'scope-A' },
  } as const
  useAgent.setState({
    messages: [ownerMessage, fakeMessage],
    sessions: {
      ...before.sessions,
      'session-A': {
        ...getSessionSlice(before, 'session-A'),
        messages: [ownerMessage, fakeMessage],
        streamingRequestId: 'req-steering-ui',
        streamingMessageId: 'response-steering-ui',
        scopeRunStates: { 'scope-A': fakeRun },
      },
    },
    scopeRunStates: { 'scope-A': fakeRun },
    streamingRequestId: 'req-steering-ui',
    streamingMessageId: 'response-steering-ui',
  })

  driverApi.completeScopeRunAfterSendSuccess('scope-A', 'req-steering-ui', {
    acceptedAsSteering: true,
    ownerRunId: 'req-A',
    previousOwnerRun: ownerRun,
  })

  const state = useAgent.getState()
  const slice = getSessionSlice(state, 'session-A')
  assert.equal(slice.scopeRunStates['scope-A']?.requestId, 'req-A')
  assert.equal(slice.streamingRequestId, 'req-A')
  assert.equal(slice.isStreaming, true)
  assert.equal(slice.composerLocked, true)
  assert.equal(slice.messages.some((message) => message.id === 'response-steering-ui'), false)
  assert.equal(slice.messages.some((message) => message.id === 'response-owner'), true)
})

test('sendMessage routes a follow-up into the active owner without replacing its renderer run', async () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })
  const scope = {
    id: 'scope-A',
    agent: 'butler',
    title: 'Scope A',
    sourceKind: 'local' as const,
    sourceId: 'app',
    threadKey: 'scope-A',
    meta: {},
    createdAt: '2026-07-18T10:00:00.000Z',
    updatedAt: '2026-07-18T10:00:00.000Z',
  }
  const liveSessionOwner = getSessionSlice(useAgent.getState(), 'session-A').scopeRunStates['scope-A']
  useAgent.setState({
    currentScope: scope,
    currentScopeId: scope.id,
    scopes: [scope],
    scopeRunStates: {
      'scope-A': {
        ...liveSessionOwner,
        requestId: 'req-stale-top-level',
        phase: 'done',
        terminalReason: 'done',
      },
    },
  })
  const previousSendScoped = electronAPIStub.agent.sendScoped
  ;(electronAPIStub.agent as any).sendScoped = async () => ({
    success: true,
    acceptedAsSteering: true,
    ownerRunId: 'req-A',
    persistence: { message: 'persisted' },
  })
  try {
    const result = await useAgent.getState().sendMessage('补充要求：同时核对第三项')
    assert.equal(result.success, true)
    const state = useAgent.getState()
    const slice = getSessionSlice(state, 'session-A')
    assert.equal(slice.scopeRunStates['scope-A']?.requestId, 'req-A')
    assert.equal(slice.streamingRequestId, 'req-A')
    assert.equal(slice.isStreaming, true)
    assert.equal(slice.composerLocked, true)
    assert.equal(
      slice.messages.filter((message) => message.type === 'agent' && String(message.content || '') === '').length,
      0,
      'steering ingress must not create an empty assistant placeholder',
    )
    assert.equal(
      state.messages.some((message) => message.type === 'user' && message.content.includes('同时核对第三项')),
      true,
    )
  } finally {
    ;(electronAPIStub.agent as any).sendScoped = previousSendScoped
  }
})

test('done stream resolves session-slice run when the top-level mirror is stale', async () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  useAgent.setState((state: any) => {
    const slice = getSessionSlice(state, 'session-A')
    const sessionRun = {
      ...slice.scopeRunStates['scope-A'],
      phase: 'responding' as const,
      waitingFor: 'background' as const,
      resumableActions: ['continue' as const],
      steps: [{
        id: 'step-1',
        title: '正在创建文档',
        status: 'running' as const,
        detail: '写入文件',
        updatedAt: '2026-06-25T04:54:00.000Z',
      }],
    }
    return {
      ...state,
      sessions: {
        ...state.sessions,
        'session-A': {
          ...slice,
          isStreaming: true,
          foregroundBusy: true,
          composerLocked: true,
          streamingMessageId: 'msg-1',
          streamingRequestId: 'req-A',
          scopeRunStates: {
            ...slice.scopeRunStates,
            'scope-A': sessionRun,
          },
        },
      },
      scopeRunStates: {
        'scope-A': {
          ...sessionRun,
          requestId: 'req-old',
          phase: 'planning' as const,
        },
      },
      isStreaming: true,
      foregroundBusy: true,
      composerLocked: true,
      streamingMessageId: 'msg-1',
      streamingRequestId: 'req-A',
    }
  })

  const canonical = {
    id: 'assistant:scope-A:req-A:terminal',
    conversationId: 'scope-A',
    role: 'assistant' as const,
    content: '已完成',
    timestamp: '2026-06-25T04:55:00.000Z',
    meta: { runId: 'req-A' },
  }
  fixtureState.conversationScopeMessages = [canonical]
  fireOnStream({
    type: 'done',
    agent: 'butler',
    runId: 'req-A',
    canonicalMessage: canonical,
    canonicalMessageDigest: 'digest-req-A',
  })

  await new Promise((resolve) => setTimeout(resolve, 20))

  const state = useAgent.getState()
  const slice = getSessionSlice(state, 'session-A')
  const run = slice.scopeRunStates['scope-A']
  assert.equal(run?.requestId, 'req-A', 'done event must resolve the real session-slice run by runId')
  assert.equal(run?.phase, 'done')
  assert.equal(run?.terminalReason, 'done')
  assert.equal(run?.waitingFor, 'none')
  assert.equal(run?.steps?.[0]?.status, 'done', 'running task step is closed on terminal done')
  assert.equal(slice.isStreaming, false, 'done stream clears stale session streaming flag')
  assert.equal(slice.foregroundBusy, false, 'done stream clears foreground busy')
  assert.equal(slice.composerLocked, false, 'done stream unlocks composer')
  assert.equal(slice.streamingRequestId, null, 'done stream hides Stop button')
  assert.equal(state.scopeRunStates['scope-A']?.requestId, 'req-A', 'active mirror is refreshed from the session-slice run')
  assert.equal(state.scopeRunStates['scope-A']?.phase, 'done')
  fixtureState.conversationScopeMessages = []
})

test('canonical done readback replaces the transient response exactly once', async () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
  })

  const before = useAgent.getState()
  const slice = getSessionSlice(before, 'session-A')
  const transient = {
    id: 'msg-1',
    agent: 'butler',
    content: '流式瞬影',
    type: 'agent' as const,
    timestamp: new Date('2026-07-18T10:00:00.000Z'),
    meta: { transient: true, runId: 'req-A', scopeId: 'scope-A' },
  }
  const earlierTransient = {
    ...transient,
    id: 'msg-0',
    content: '更早的流式瞬影',
  }
  const run = {
    ...slice.scopeRunStates['scope-A'],
    responseMessageId: transient.id,
    responseBuffer: transient.content,
  }
  useAgent.setState({
    messages: [earlierTransient, transient],
    sessions: {
      ...before.sessions,
      'session-A': {
        ...slice,
        messages: [earlierTransient, transient],
        scopeRunStates: { ...slice.scopeRunStates, 'scope-A': run },
      },
    },
    scopeRunStates: { 'scope-A': run },
  })

  const canonical = {
    id: 'assistant:task-A:req-A:terminal',
    conversationId: 'scope-A',
    role: 'assistant' as const,
    content: '已提交的唯一终稿',
    timestamp: '2026-07-18T10:00:01.000Z',
    meta: { runId: 'req-A' },
  }
  fixtureState.conversationScopeMessages = [canonical]

  const payload = {
    type: 'done',
    agent: 'butler',
    sessionId: 'session-A',
    runId: 'req-A',
    chunk: '',
    canonicalMessage: canonical,
    canonicalMessageDigest: 'digest-A',
  }
  fireOnStream(payload)
  fireOnStream(payload)
  await new Promise((resolve) => setTimeout(resolve, 20))

  const state = useAgent.getState()
  const afterSlice = getSessionSlice(state, 'session-A')
  assert.equal(afterSlice.messages.filter((message) => message.id === canonical.id).length, 1)
  assert.equal(afterSlice.messages.some((message) => message.id === transient.id), false)
  assert.equal(afterSlice.messages.some((message) => message.id === earlierTransient.id), false)
  assert.equal(afterSlice.scopeRunStates['scope-A']?.responseMessageId, canonical.id)
  assert.equal(afterSlice.scopeRunStates['scope-A']?.responseBuffer, canonical.content)
  fixtureState.conversationScopeMessages = []
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
