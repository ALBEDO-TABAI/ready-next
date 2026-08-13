import assert from 'node:assert/strict'
import test from 'node:test'
import {
  driverApi, fireOnScopeRunEvent,
  fireOnStream,
  fixtureState,
  getSessionSlice, seedTwoSessions,
  useAgent
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
  await driverApi.completeScopeRunAfterSendSuccess('scope-A', 'req-A', {
    canonicalMessage: canonical,
    canonicalMessageDigest: 'digest-A',
  })
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

test('stale text stream cannot append to the current run', () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-new',
  })
  fireOnStream({
    type: 'text',
    agent: 'butler',
    sessionId: 'session-A',
    runId: 'req-new',
    chunk: '新请求的回复',
  })

  const beforeSlice = getSessionSlice(useAgent.getState(), 'session-A')
  const beforeLive = useAgent.getState().scopeLiveMessages['scope-A']
  fireOnStream({
    type: 'text',
    agent: 'butler',
    sessionId: 'session-A',
    runId: 'req-old',
    chunk: '迟到的旧文本',
  })

  const after = useAgent.getState()
  const afterSlice = getSessionSlice(after, 'session-A')
  assert.deepEqual(afterSlice, beforeSlice, 'stale text cannot mutate the owner session')
  assert.deepEqual(after.scopeLiveMessages['scope-A'], beforeLive, 'stale text cannot mutate the live transcript')
  assert.equal(afterSlice.scopeRunStates['scope-A']?.requestId, 'req-new')
  assert.equal(afterSlice.scopeRunStates['scope-A']?.responseBuffer, '新请求的回复')
})

test('stale done stream is a complete no-op when a new request owns the scope', async () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-new',
  })
  fireOnStream({
    type: 'text',
    agent: 'butler',
    sessionId: 'session-A',
    runId: 'req-new',
    chunk: '新请求的瞬影',
  })

  const canonical = {
    id: 'assistant:scope-A:req-old:terminal',
    conversationId: 'scope-A',
    role: 'assistant' as const,
    content: '旧请求的终稿',
    timestamp: '2026-08-11T10:00:01.000Z',
    meta: { runId: 'req-old' },
  }
  const beforeSlice = getSessionSlice(useAgent.getState(), 'session-A')
  const beforeLive = useAgent.getState().scopeLiveMessages['scope-A'] || []
  let readbackCount = 0
  const originalGetMessages = window.electronAPI.agent.getConversationScopeMessages
  window.electronAPI.agent.getConversationScopeMessages = async () => {
    readbackCount += 1
    return { success: true, data: [canonical] }
  }

  try {
    fireOnStream({
      type: 'done',
      agent: 'butler',
      sessionId: 'session-A',
      runId: 'req-old',
      chunk: '',
      canonicalMessage: canonical,
      canonicalMessageDigest: 'digest-old',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const after = useAgent.getState()
    const afterSlice = getSessionSlice(after, 'session-A')
    assert.equal(readbackCount, 0, 'stale done must be rejected before canonical readback')
    assert.deepEqual(afterSlice, beforeSlice, 'stale done cannot finish or unlock the new run')
    assert.deepEqual(after.scopeLiveMessages['scope-A'] || [], beforeLive)
    assert.equal(afterSlice.streamingRequestId, 'req-new')
    assert.equal(afterSlice.scopeRunStates['scope-A']?.terminalReason ?? null, null)
  } finally {
    window.electronAPI.agent.getConversationScopeMessages = originalGetMessages
  }
})

test('old done readback cannot overwrite a new request that starts while readback is pending', async () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-old',
  })

  const canonical = {
    id: 'assistant:scope-A:req-old:terminal',
    conversationId: 'scope-A',
    role: 'assistant' as const,
    content: '旧请求的终稿',
    timestamp: '2026-08-11T10:00:01.000Z',
    meta: { runId: 'req-old' },
  }

  let releaseReadback!: () => void
  let markReadbackStarted!: () => void
  const readbackStarted = new Promise<void>((resolve) => { markReadbackStarted = resolve })
  const readbackGate = new Promise<void>((resolve) => { releaseReadback = resolve })
  const originalGetMessages = window.electronAPI.agent.getConversationScopeMessages
  window.electronAPI.agent.getConversationScopeMessages = async () => {
    markReadbackStarted()
    await readbackGate
    return { success: true, data: [canonical] }
  }

  try {
    fireOnStream({
      type: 'done',
      agent: 'butler',
      sessionId: 'session-A',
      runId: 'req-old',
      chunk: '',
      canonicalMessage: canonical,
      canonicalMessageDigest: 'digest-old',
    })
    await readbackStarted

    fireOnScopeRunEvent({
      type: 'started',
      scopeId: 'scope-A',
      sessionId: 'session-A',
      agent: 'butler',
      runId: 'req-new',
      phase: 'planning',
      latestText: '新请求正在处理',
      timestamp: '2026-08-11T10:00:02.000Z',
    })
    fireOnStream({
      type: 'text',
      agent: 'butler',
      sessionId: 'session-A',
      runId: 'req-new',
      chunk: '新请求的瞬影',
    })
    const beforeReleaseSlice = getSessionSlice(useAgent.getState(), 'session-A')
    const beforeReleaseLive = useAgent.getState().scopeLiveMessages['scope-A']

    releaseReadback()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const after = useAgent.getState()
    const afterSlice = getSessionSlice(after, 'session-A')
    const afterRun = afterSlice.scopeRunStates['scope-A']
    assert.deepEqual(afterSlice, beforeReleaseSlice, 'old readback cannot finish or unlock the new request')
    assert.deepEqual(after.scopeLiveMessages['scope-A'], beforeReleaseLive, 'old readback cannot remove the new live message')
    assert.equal(afterSlice.streamingRequestId, 'req-new')
    assert.equal(afterSlice.isStreaming, true)
    assert.equal(afterSlice.foregroundBusy, true)
    assert.equal(afterSlice.composerLocked, true)
    assert.equal(afterRun?.requestId, 'req-new')
    assert.equal(afterRun?.phase, 'responding')
    assert.equal(afterRun?.terminalReason ?? null, null)
    assert.equal(afterSlice.messages.some((message) => message.id === canonical.id), false)
  } finally {
    releaseReadback()
    window.electronAPI.agent.getConversationScopeMessages = originalGetMessages
  }
})

test('send success keeps the composer locked until the canonical assistant message is visible', async () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
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

  let releaseReadback!: () => void
  const readbackGate = new Promise<void>((resolve) => { releaseReadback = resolve })
  const originalGetMessages = window.electronAPI.agent.getConversationScopeMessages
  window.electronAPI.agent.getConversationScopeMessages = async () => {
    await readbackGate
    return { success: true, data: fixtureState.conversationScopeMessages }
  }

  try {
    const completion = driverApi.completeScopeRunAfterSendSuccess('scope-A', 'req-A', {
      canonicalMessage: canonical,
      canonicalMessageDigest: 'digest-A',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const during = getSessionSlice(useAgent.getState(), 'session-A')
    assert.equal(during.composerLocked, true, 'composer must stay locked while canonical readback is pending')
    assert.equal(during.foregroundBusy, true, 'foreground remains busy until the assistant message is visible')
    assert.equal(during.messages.some((message) => message.id === canonical.id), false)

    releaseReadback()
    await completion

    const after = getSessionSlice(useAgent.getState(), 'session-A')
    assert.equal(after.composerLocked, false)
    assert.equal(after.foregroundBusy, false)
    assert.equal(after.messages.some((message) => (
      message.id === canonical.id && message.content === canonical.content
    )), true)
  } finally {
    window.electronAPI.agent.getConversationScopeMessages = originalGetMessages
    fixtureState.conversationScopeMessages = []
  }
})

test('successful scope event cannot unlock before delayed stream-done reconciliation', async () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-A',
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

  let releaseReadback!: () => void
  const readbackGate = new Promise<void>((resolve) => { releaseReadback = resolve })
  const originalGetMessages = window.electronAPI.agent.getConversationScopeMessages
  window.electronAPI.agent.getConversationScopeMessages = async () => {
    await readbackGate
    return { success: true, data: fixtureState.conversationScopeMessages }
  }

  try {
    fireOnStream({
      type: 'done',
      agent: 'butler',
      sessionId: 'session-A',
      runId: 'req-A',
      chunk: '',
      canonicalMessage: canonical,
      canonicalMessageDigest: 'digest-A',
    })
    fireOnScopeRunEvent({
      type: 'finished',
      scopeId: 'scope-A',
      sessionId: 'session-A',
      agent: 'butler',
      runId: 'req-A',
      phase: 'done',
      terminalReason: 'done',
      timestamp: '2026-07-18T10:00:01.000Z',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const during = getSessionSlice(useAgent.getState(), 'session-A')
    assert.equal(during.composerLocked, true)
    assert.equal(during.foregroundBusy, true)
    assert.equal(during.messages.some((message) => message.id === canonical.id), false)

    releaseReadback()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const after = getSessionSlice(useAgent.getState(), 'session-A')
    assert.equal(after.composerLocked, false)
    assert.equal(after.foregroundBusy, false)
    assert.equal(after.messages.some((message) => (
      message.id === canonical.id && message.content === canonical.content
    )), true)
  } finally {
    window.electronAPI.agent.getConversationScopeMessages = originalGetMessages
    fixtureState.conversationScopeMessages = []
  }
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

test('matching late terminal reconciles an unknown stop and unlocks its session', () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-current',
  })
  useAgent.setState((state: any) => ({
    sessions: {
      ...state.sessions,
      'session-A': {
        ...getSessionSlice(state, 'session-A'),
        lifecyclePendingAction: null,
        lifecycleError: {
          ok: false,
          action: 'stop',
          code: 'interrupt_state_unknown',
          preserveUi: true,
          aliasId: 'scope-A',
          aliasGeneration: 1,
          evidenceDigest: 'unknown-stop',
        },
      },
    },
  }))

  fireOnScopeRunEvent({
    type: 'finished',
    scopeId: 'scope-A',
    sessionId: 'session-A',
    agent: 'butler',
    runId: 'req-current',
    phase: 'cancelled',
    terminalReason: 'cancelled_user',
    timestamp: '2026-08-11T09:00:00.000Z',
  })

  const slice = getSessionSlice(useAgent.getState(), 'session-A')
  assert.equal(slice.isStreaming, false)
  assert.equal(slice.foregroundBusy, false)
  assert.equal(slice.composerLocked, false)
  assert.equal(slice.streamingRequestId, null)
  assert.equal(slice.lifecyclePendingAction, null)
  assert.equal(slice.lifecycleError, null)
  assert.equal(slice.state, 'cancelled')
})

test('stale old-run terminal cannot reconcile or unlock the current unknown stop', () => {
  seedTwoSessions({
    activeSessionId: 'session-A',
    lockedSessionId: 'session-A',
    lockedScopeId: 'scope-A',
    otherScopeId: 'scope-B',
    requestId: 'req-current',
  })
  const lifecycleError = {
    ok: false as const,
    action: 'stop' as const,
    code: 'interrupt_state_unknown' as const,
    preserveUi: true as const,
    aliasId: 'scope-A',
    aliasGeneration: 1,
    evidenceDigest: 'unknown-stop',
  }
  useAgent.setState((state: any) => ({
    sessions: {
      ...state.sessions,
      'session-A': {
        ...getSessionSlice(state, 'session-A'),
        lifecyclePendingAction: null,
        lifecycleError,
      },
    },
  }))

  fireOnScopeRunEvent({
    type: 'finished',
    scopeId: 'scope-A',
    sessionId: 'session-A',
    agent: 'butler',
    runId: 'req-old',
    phase: 'cancelled',
    terminalReason: 'cancelled_user',
    timestamp: '2026-08-11T09:00:00.000Z',
  })

  const slice = getSessionSlice(useAgent.getState(), 'session-A')
  assert.equal(slice.isStreaming, true)
  assert.equal(slice.foregroundBusy, true)
  assert.equal(slice.composerLocked, true)
  assert.equal(slice.streamingRequestId, 'req-current')
  assert.deepEqual(slice.lifecycleError, lifecycleError)
  assert.equal(slice.scopeRunStates['scope-A']?.requestId, 'req-current')
  assert.equal(slice.scopeRunStates['scope-A']?.terminalReason ?? null, null)
  assert.equal(slice.state, 'live')
})
