import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CreateSessionResult,
  LifecycleResult,
} from '../shared/ipc-contracts/agent-runtime'
import type { AgentMessage, ConversationScope } from '../renderer/modules/agent/types'
import { createEmptyScopeRunState } from '../renderer/modules/agent/scopeRunState'
import { makeEmptySessionSlice } from '../renderer/stores/agent-store-helpers'
import { useAgent } from '../renderer/stores/useAgent'

const aliasId = 'alias-renderer-lifecycle'
const sessionId = 'session-renderer-lifecycle'
const scope: ConversationScope = {
  id: aliasId,
  agent: 'butler',
  activeAgentId: 'butler',
  handoffGeneration: 0,
  title: '保留中的对话',
  sourceKind: 'local',
  sourceId: 'app',
  threadKey: aliasId,
  meta: { sourceLabel: '应用内', createdBy: 'app' },
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-07T00:00:00.000Z',
  lastMessageAt: '2026-08-07T00:00:01.000Z',
}
const message: AgentMessage = {
  id: 'message-before-lifecycle',
  agent: 'butler',
  content: '必须保留',
  type: 'user',
  timestamp: new Date('2026-08-07T00:00:01.000Z'),
}

function seedStore() {
  const slice = {
    ...makeEmptySessionSlice(aliasId),
    messages: [message],
    inputValue: '未发送草稿',
    aliasGeneration: 1,
    isStreaming: true,
    foregroundBusy: true,
    composerLocked: true,
    streamingMessageId: 'response-pending',
    streamingRequestId: 'request-pending',
  }
  useAgent.setState({
    messages: [message],
    currentAgent: 'butler',
    inputValue: '未发送草稿',
    currentScopeId: aliasId,
    currentScope: scope,
    scopes: [scope],
    retiredScopeIds: {},
    scopeAuthorityRevision: 0,
    scopeListRequestRevision: 0,
    conversations: [],
    attachments: [{
      id: 'attachment-before-lifecycle',
      name: '保留.txt',
      path: '/tmp/keep.txt',
      type: 'text',
      size: 1,
      ext: '.txt',
      source: 'file',
    }],
    filePool: [],
    pendingContinuationIntent: null,
    pendingContinuationDraftAnchor: null,
    isStreaming: true,
    foregroundBusy: true,
    composerLocked: true,
    streamingMessageId: 'response-pending',
    streamingRequestId: 'request-pending',
    scopeRunStates: {},
    toolTrace: [],
    toolTraceStatus: 'running',
    sessions: { [sessionId]: slice },
    activeSessionId: sessionId,
    sessionId,
    sessionOrder: [sessionId],
    taskDisclosureState: {},
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function installAgentApi(api: Record<string, unknown>) {
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    value: { electronAPI: { agent: api } },
    configurable: true,
  })
  return () => {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
    } else {
      delete (globalThis as typeof globalThis & { window?: Window }).window
    }
  }
}

function failure(
  action: Extract<LifecycleResult, { ok: false }>['action'],
  code: Extract<LifecycleResult, { ok: false }>['code'] = 'thread_busy',
): Extract<LifecycleResult, { ok: false }> {
  return {
    ok: false,
    action,
    code,
    preserveUi: true,
    aliasId,
    aliasGeneration: 1,
    evidenceDigest: `${action}-failure-digest`,
  }
}

test('create shows no tab before persistence and creates no welcome transcript', async () => {
  seedStore()
  const pending = deferred<CreateSessionResult>()
  const requests: unknown[] = []
  const restore = installAgentApi({
    createSession: (request: unknown) => { requests.push(request); return pending.promise },
  })
  try {
    const beforeOrder = [...useAgent.getState().sessionOrder]
    const promise = useAgent.getState().createNewSession()
    assert.deepEqual(useAgent.getState().sessionOrder, beforeOrder)

    pending.resolve({
      ok: true,
      action: 'create',
      aliasId: 'alias-created',
      aliasGeneration: 1,
      persistedAt: '2026-08-07T00:00:02.000Z',
    })
    const result = await promise
    assert.equal(result.ok, true)
    assert.deepEqual(requests, [{ agentId: 'butler' }])
    assert.equal(useAgent.getState().sessionOrder.length, beforeOrder.length + 1)
    assert.deepEqual(useAgent.getState().messages, [])
    assert.deepEqual(useAgent.getState().attachments, [])
    assert.equal(useAgent.getState().pendingContinuationIntent, null)
    assert.deepEqual(useAgent.getState().toolTrace, [])
    assert.equal(useAgent.getState().toolTraceStatus, 'idle')
  } finally {
    restore()
  }
})

test('create failure leaves the visible sessions byte-for-byte unchanged', async () => {
  seedStore()
  const before = useAgent.getState()
  const failureResult: CreateSessionResult = {
    ok: false,
    action: 'create',
    code: 'persistence_failed',
    preserveUi: true,
    evidenceDigest: 'create-failure-digest',
  }
  const restore = installAgentApi({ createSession: async () => failureResult })
  try {
    assert.deepEqual(await useAgent.getState().createNewSession(), failureResult)
    const after = useAgent.getState()
    assert.deepEqual(after.sessionOrder, before.sessionOrder)
    assert.deepEqual(after.messages, before.messages)
    assert.equal(after.inputValue, before.inputValue)
  } finally {
    restore()
  }
})

test('reload restores the immutable alias generation before lifecycle actions', async () => {
  seedStore()
  useAgent.setState((state) => ({
    sessions: {
      ...state.sessions,
      [sessionId]: {
        ...state.sessions[sessionId],
        aliasGeneration: null,
      },
    },
  }))
  let closeRequest: { aliasId: string; aliasGeneration: number; readyRunId: string | null } | null = null
  const closeFailure: LifecycleResult = {
    ok: false,
    action: 'close',
    code: 'thread_busy',
    preserveUi: true,
    aliasId,
    aliasGeneration: 7,
    evidenceDigest: 'reload-close-digest',
  }
  const restore = installAgentApi({
    listConversationScopes: async () => ({
      success: true,
      data: [{ ...scope, aliasGeneration: 7 }],
    }),
    closeSession: async (request: { aliasId: string; aliasGeneration: number; readyRunId: string | null }) => {
      closeRequest = request
      return closeFailure
    },
  })
  try {
    await useAgent.getState().loadScopes()
    assert.equal(useAgent.getState().sessions[sessionId]?.aliasGeneration, 7)
    assert.deepEqual(await useAgent.getState().closeSession(sessionId), closeFailure)
    assert.deepEqual(closeRequest, { aliasId, aliasGeneration: 7, readyRunId: null })
  } finally {
    restore()
  }
})

test('cold reload hydrates the exact durable running operation instead of the empty renderer cache', async () => {
  useAgent.setState({
    messages: [], currentAgent: 'butler', inputValue: '', currentScopeId: null,
    currentScope: null, scopes: [], conversations: [], attachments: [], filePool: [],
    pendingContinuationIntent: null, pendingContinuationDraftAnchor: null,
    isStreaming: false, foregroundBusy: false, composerLocked: false,
    streamingMessageId: null, streamingRequestId: null, scopeRunStates: {},
    toolTrace: [], toolTraceStatus: 'idle', sessions: {}, activeSessionId: null,
    sessionId: 'cold-placeholder', sessionOrder: [], taskDisclosureState: {},
  })
  const requests: unknown[] = []
  const restore = installAgentApi({
    listConversationScopes: async () => ({
      success: true,
      data: [{ ...scope, aliasGeneration: 4 }],
    }),
    getConversationScopeMessages: async () => ({ success: true, data: [] }),
    readCodexLifecycleSnapshot: async (request: unknown) => {
      requests.push(request)
      return {
        success: true,
        data: {
          identity: { aliasId, aliasGeneration: 4 },
          activeReadyRunId: 'run-recovered',
          latestReadyRunId: 'run-recovered',
          snapshot: 'product_turn_interruptible',
          interruptRequested: false,
          interruptAcknowledged: false,
          requestedAction: null,
          evidenceDigest: 'lifecycle-readback-digest',
        },
      }
    },
  })
  try {
    await useAgent.getState().loadScopes()
    assert.deepEqual(requests, [{ aliasId, aliasGeneration: 4 }])
    const state = useAgent.getState()
    const slice = state.sessions[state.activeSessionId || '']
    assert.equal(slice?.aliasGeneration, 4)
    assert.equal(slice?.streamingRequestId, 'run-recovered')
    assert.equal(slice?.isStreaming, true)
    assert.equal(slice?.composerLocked, true)
    assert.equal(slice?.lifecyclePendingAction, null)
    assert.equal(slice?.scopeRunStates[aliasId]?.requestId, 'run-recovered')
  } finally {
    restore()
  }
})

test('cold lifecycle hydration restores the exact stop, close, or reset action from the persisted run', async () => {
  for (const entry of [
    {
      snapshot: 'product_turn_interruptible',
      requestedAction: 'stop',
      pending: 'stopping',
      error: null,
    },
    {
      snapshot: 'product_turn_engine_terminal_closeout_pending',
      requestedAction: 'close',
      pending: 'closing',
      error: null,
    },
    {
      snapshot: 'product_turn_engine_terminal_closeout_pending',
      requestedAction: 'reset',
      pending: 'resetting',
      error: null,
    },
    {
      snapshot: 'product_turn_interrupt_unknown',
      requestedAction: 'stop',
      pending: null,
      error: 'interrupt_state_unknown',
    },
    {
      snapshot: 'product_turn_interrupt_unknown',
      requestedAction: 'close',
      pending: null,
      error: 'interrupt_state_unknown',
    },
    {
      snapshot: 'product_turn_interrupt_unknown',
      requestedAction: 'reset',
      pending: null,
      error: 'interrupt_state_unknown',
    },
  ] as const) {
    useAgent.setState({
      messages: [], currentAgent: 'butler', inputValue: '', currentScopeId: null,
      currentScope: null, scopes: [], conversations: [], attachments: [], filePool: [],
      pendingContinuationIntent: null, pendingContinuationDraftAnchor: null,
      isStreaming: false, foregroundBusy: false, composerLocked: false,
      streamingMessageId: null, streamingRequestId: null, scopeRunStates: {},
      toolTrace: [], toolTraceStatus: 'idle', sessions: {}, activeSessionId: null,
      sessionId: 'cold-placeholder', sessionOrder: [], taskDisclosureState: {},
    })
    const restore = installAgentApi({
      listConversationScopes: async () => ({
        success: true,
        data: [{ ...scope, aliasGeneration: 5, lastMessageAt: null }],
      }),
      readCodexLifecycleSnapshot: async () => ({
        success: true,
        data: {
          identity: { aliasId, aliasGeneration: 5 },
          activeReadyRunId: 'run-stopping',
          latestReadyRunId: 'run-stopping',
          snapshot: entry.snapshot,
          interruptRequested: true,
          interruptAcknowledged: false,
          requestedAction: entry.requestedAction,
          evidenceDigest: 'lifecycle-stop-readback-digest',
        },
      }),
    })
    try {
      await useAgent.getState().loadScopes()
      const state = useAgent.getState()
      const slice = state.sessions[state.activeSessionId || '']
      assert.equal(slice?.streamingRequestId, 'run-stopping')
      assert.equal(slice?.lifecyclePendingAction, entry.pending)
      assert.equal(slice?.lifecycleError?.code || null, entry.error)
      assert.equal(slice?.lifecycleError?.action || null, entry.error ? entry.requestedAction : null)
      assert.equal(slice?.composerLocked, true)
    } finally {
      restore()
    }
  }
})

test('durable terminal readback clears a stale matching composer lock after reload', async () => {
  seedStore()
  const restore = installAgentApi({
    listConversationScopes: async () => ({
      success: true,
      data: [{ ...scope, aliasGeneration: 1, lastMessageAt: null }],
    }),
    readCodexLifecycleSnapshot: async () => ({
      success: true,
      data: {
        identity: { aliasId, aliasGeneration: 1 },
        activeReadyRunId: null,
        latestReadyRunId: 'request-pending',
        snapshot: 'idle_native_thread',
        interruptRequested: false,
        interruptAcknowledged: false,
        requestedAction: null,
        evidenceDigest: 'terminal-lifecycle-readback-digest',
      },
    }),
  })
  try {
    await useAgent.getState().loadScopes()
    const slice = useAgent.getState().sessions[sessionId]
    assert.equal(slice?.streamingRequestId, null)
    assert.equal(slice?.isStreaming, false)
    assert.equal(slice?.composerLocked, false)
    assert.equal(slice?.lifecyclePendingAction, null)
    assert.equal(slice?.lifecycleError, null)
  } finally {
    restore()
  }
})

test('an old terminal snapshot cannot clear a newer run already owned by the registered listener', async () => {
  seedStore()
  const newRun = createEmptyScopeRunState({
    scopeId: aliasId,
    agent: 'butler',
    requestId: 'run-new',
    phase: 'responding',
  })
  useAgent.setState((state) => ({
    sessions: {
      ...state.sessions,
      [sessionId]: {
        ...state.sessions[sessionId],
        streamingRequestId: 'run-new',
        scopeRunStates: { [aliasId]: newRun },
      },
    },
    streamingRequestId: 'run-new',
    scopeRunStates: { [aliasId]: newRun },
  }))
  const restore = installAgentApi({
    listConversationScopes: async () => ({
      success: true,
      data: [{ ...scope, aliasGeneration: 1, lastMessageAt: null }],
    }),
    readCodexLifecycleSnapshot: async () => ({
      success: true,
      data: {
        identity: { aliasId, aliasGeneration: 1 },
        activeReadyRunId: null,
        latestReadyRunId: 'request-pending',
        snapshot: 'idle_native_thread',
        interruptRequested: false,
        interruptAcknowledged: false,
        requestedAction: null,
        evidenceDigest: 'old-terminal-lifecycle-readback-digest',
      },
    }),
  })
  try {
    await useAgent.getState().loadScopes()
    const slice = useAgent.getState().sessions[sessionId]
    assert.equal(slice?.streamingRequestId, 'run-new')
    assert.equal(slice?.isStreaming, true)
    assert.equal(slice?.composerLocked, true)
  } finally {
    restore()
  }
})

test('a late lifecycle snapshot cannot revive an old run after a newer exact run entered the same generation', async () => {
  useAgent.setState({
    messages: [], currentAgent: 'butler', inputValue: '', currentScopeId: null,
    currentScope: null, scopes: [], conversations: [], attachments: [], filePool: [],
    pendingContinuationIntent: null, pendingContinuationDraftAnchor: null,
    isStreaming: false, foregroundBusy: false, composerLocked: false,
    streamingMessageId: null, streamingRequestId: null, scopeRunStates: {},
    toolTrace: [], toolTraceStatus: 'idle', sessions: {}, activeSessionId: null,
    sessionId: 'cold-placeholder', sessionOrder: [], taskDisclosureState: {},
  })
  const pending = deferred<{ success: true; data: Record<string, unknown> }>()
  const restore = installAgentApi({
    listConversationScopes: async () => ({
      success: true,
      data: [{ ...scope, aliasGeneration: 6, lastMessageAt: null }],
    }),
    readCodexLifecycleSnapshot: () => pending.promise,
  })
  try {
    const loading = useAgent.getState().loadScopes()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const current = useAgent.getState()
    const coldSessionId = current.activeSessionId || aliasId
    useAgent.setState((state) => ({
      sessions: {
        ...state.sessions,
        [coldSessionId]: {
          ...state.sessions[coldSessionId],
          isStreaming: true,
          foregroundBusy: true,
          composerLocked: true,
          streamingRequestId: 'run-new',
        },
      },
      isStreaming: true,
      foregroundBusy: true,
      composerLocked: true,
      streamingRequestId: 'run-new',
    }))
    pending.resolve({
      success: true,
      data: {
        identity: { aliasId, aliasGeneration: 6 },
        activeReadyRunId: 'run-old',
        latestReadyRunId: 'run-old',
        snapshot: 'product_turn_interruptible',
        interruptRequested: false,
        interruptAcknowledged: false,
        requestedAction: null,
        evidenceDigest: 'stale-lifecycle-readback-digest',
      },
    })
    await loading
    const slice = useAgent.getState().sessions[coldSessionId]
    assert.equal(slice?.streamingRequestId, 'run-new')
    assert.equal(slice?.composerLocked, true)
  } finally {
    restore()
  }
})

test('close success removes only the confirmed tab and mirrors the next live session', async () => {
  seedStore()
  const nextSessionId = 'session-renderer-lifecycle-next'
  const nextAliasId = 'alias-renderer-lifecycle-next'
  const nextMessage: AgentMessage = {
    id: 'message-next-session',
    agent: 'butler',
    content: '下一条会话',
    type: 'user',
    timestamp: new Date('2026-08-07T00:00:03.000Z'),
  }
  const current = useAgent.getState()
  useAgent.setState({
    sessions: {
      ...current.sessions,
      [nextSessionId]: {
        ...makeEmptySessionSlice(nextAliasId),
        messages: [nextMessage],
        inputValue: '下一条草稿',
        aliasGeneration: 1,
      },
    },
    sessionOrder: [sessionId, nextSessionId],
  })
  const success: LifecycleResult = {
    ok: true,
    action: 'close',
    closeoutDisposition: 'never_started',
    aliasId,
    retiredGeneration: 1,
    retirementTransactionDigest: 'close-success-digest',
    archiveDisposition: 'not_required',
    scopeClosureEvidenceDigest: 'a'.repeat(64),
  }
  const restore = installAgentApi({ closeSession: async () => success })
  try {
    assert.deepEqual(await useAgent.getState().closeSession(sessionId), success)
    const state = useAgent.getState()
    assert.deepEqual(state.sessionOrder, [nextSessionId])
    assert.equal(state.sessions[sessionId], undefined)
    assert.equal(state.activeSessionId, nextSessionId)
    assert.equal(state.sessionId, nextSessionId)
    assert.deepEqual(state.messages, [nextMessage])
    assert.equal(state.inputValue, '下一条草稿')
  } finally {
    restore()
  }
})

test('reset keeps messages, composer, and attachments until success and blocks a conflicting compact', async () => {
  seedStore()
  const pending = deferred<LifecycleResult>()
  let compactCalls = 0
  let sendCalls = 0
  const restore = installAgentApi({
    resetSession: () => pending.promise,
    compactSession: async () => {
      compactCalls += 1
      return failure('manual_compact')
    },
    sendScoped: async () => {
      sendCalls += 1
      throw new Error('must_not_send_during_lifecycle_action')
    },
  })
  try {
    const promise = useAgent.getState().resetCurrentConversation()
    assert.deepEqual(useAgent.getState().messages, [message])
    assert.equal(useAgent.getState().inputValue, '未发送草稿')
    assert.equal(useAgent.getState().attachments.length, 1)
    await assert.rejects(useAgent.getState().compactCurrentSession(), /lifecycle_action_pending/)
    assert.equal(compactCalls, 0)
    const sendResult = await useAgent.getState().sendMessage('重置期间不能发送')
    assert.equal(sendResult.disposition, 'rejected_before_persistence')
    assert.equal(sendResult.errorKind, 'thread_busy')
    assert.equal(sendCalls, 0)

    pending.resolve(failure('reset', 'persistence_failed'))
    const result = await promise
    assert.equal(result.ok, false)
    assert.deepEqual(useAgent.getState().messages, [message])
    assert.equal(useAgent.getState().inputValue, '未发送草稿')
    assert.equal(useAgent.getState().attachments.length, 1)
  } finally {
    restore()
  }
})

test('reset success after a tab switch clears only the origin session', async () => {
  seedStore()
  const pending = deferred<LifecycleResult>()
  const restore = installAgentApi({ resetSession: () => pending.promise })
  const destinationAttachment = {
    id: 'attachment-after-reset-switch',
    name: '下一会话.txt',
    path: '/tmp/next-session.txt',
    type: 'text' as const,
    size: 2,
    ext: '.txt',
    source: 'file' as const,
  }
  const destinationTrace = {
    id: 'trace-after-reset-switch',
    kind: 'call' as const,
    text: 'destination_tool()',
    timestamp: new Date('2026-08-07T00:00:03.000Z'),
  }
  try {
    const promise = useAgent.getState().resetCurrentConversation()
    const nextSessionId = 'session-after-reset-switch'
    const nextAliasId = 'alias-after-reset-switch'
    const current = useAgent.getState()
    useAgent.setState({
      sessions: {
        ...current.sessions,
        [nextSessionId]: {
          ...makeEmptySessionSlice(nextAliasId),
          inputValue: '下一会话草稿',
          aliasGeneration: 1,
        },
      },
      sessionOrder: [sessionId, nextSessionId],
      activeSessionId: nextSessionId,
      sessionId: nextSessionId,
      currentScopeId: nextAliasId,
      conversationId: nextAliasId,
      messages: [],
      inputValue: '下一会话草稿',
      attachments: [destinationAttachment],
      pendingContinuationIntent: { taskId: 'destination-task' },
      pendingContinuationDraftAnchor: '下一会话草稿',
      toolTrace: [destinationTrace],
      toolTraceStatus: 'running',
    })

    pending.resolve({
      ok: true,
      action: 'reset',
      aliasId,
      retiredGeneration: 1,
      newGeneration: 2,
      transactionDigest: 'reset-success-digest',
    })
    const result = await promise
    assert.equal(result.ok, true)

    const state = useAgent.getState()
    assert.equal(state.activeSessionId, nextSessionId)
    assert.equal(state.inputValue, '下一会话草稿')
    assert.deepEqual(state.attachments, [destinationAttachment])
    assert.deepEqual(state.pendingContinuationIntent, { taskId: 'destination-task' })
    assert.equal(state.pendingContinuationDraftAnchor, '下一会话草稿')
    assert.deepEqual(state.toolTrace, [destinationTrace])
    assert.equal(state.toolTraceStatus, 'running')
    assert.deepEqual(state.sessions[sessionId]?.messages, [])
    assert.equal(state.sessions[sessionId]?.aliasGeneration, 2)
    assert.equal(
      state.scopes.find((candidate) => candidate.id === aliasId)?.aliasGeneration,
      2,
    )
    assert.equal(state.retiredScopeIds[aliasId], undefined)
  } finally {
    restore()
  }
})

for (const entry of [
  { action: 'stop' as const, invoke: () => useAgent.getState().stopStreaming(), apiName: 'kill' },
  { action: 'close' as const, invoke: () => useAgent.getState().closeSession(sessionId), apiName: 'closeSession' },
  { action: 'manual_compact' as const, invoke: () => useAgent.getState().compactCurrentSession(), apiName: 'compactSession' },
]) {
  test(`${entry.action} failure retains the current tab and transcript`, async () => {
    seedStore()
    const restore = installAgentApi({
      [entry.apiName]: async () => failure(entry.action),
    })
    try {
      const result = await entry.invoke()
      assert.equal(result.ok, false)
      assert.deepEqual(useAgent.getState().sessionOrder, [sessionId])
      assert.deepEqual(useAgent.getState().messages, [message])
      assert.equal(useAgent.getState().inputValue, '未发送草稿')
    } finally {
      restore()
    }
  })
}

test('stop reconciles a stale locked composer when Main proves no operation is active', async () => {
  seedStore()
  const noActive = failure('stop', 'no_active_operation')
  const requests: unknown[] = []
  const restore = installAgentApi({
    kill: async (request: unknown) => { requests.push(request); return noActive },
  })
  try {
    assert.deepEqual(await useAgent.getState().stopStreaming(), noActive)
    assert.deepEqual(requests, [{
      aliasId,
      aliasGeneration: 1,
      readyRunId: 'request-pending',
    }])
    const state = useAgent.getState()
    const slice = state.sessions[sessionId]
    assert.equal(state.isStreaming, false)
    assert.equal(state.composerLocked, false)
    assert.equal(state.streamingRequestId, null)
    assert.equal(slice?.isStreaming, false)
    assert.equal(slice?.composerLocked, false)
    assert.equal(slice?.lifecyclePendingAction, null)
    assert.equal(slice?.lifecycleError, null)
    assert.deepEqual(state.messages, [message])
    assert.equal(state.inputValue, '未发送草稿')
  } finally {
    restore()
  }
})

test('interrupt uncertainty allows the exact stop to retry while send, reset, and close stay blocked', async () => {
  seedStore()
  const stopRequests: unknown[] = []
  let resetCalls = 0
  let closeCalls = 0
  let sendCalls = 0
  const restore = installAgentApi({
    kill: async (request: unknown) => {
      stopRequests.push(request)
      return failure('stop', 'interrupt_state_unknown')
    },
    resetSession: async () => {
      resetCalls += 1
      return failure('reset')
    },
    closeSession: async () => {
      closeCalls += 1
      return failure('close')
    },
    sendScoped: async () => {
      sendCalls += 1
      throw new Error('must_not_send_while_lifecycle_unknown')
    },
  })
  try {
    const first = await useAgent.getState().stopStreaming()
    assert.equal(first.ok, false)
    const second = await useAgent.getState().stopStreaming()
    assert.equal(second.ok, false)
    await assert.rejects(
      useAgent.getState().resetCurrentConversation(),
      /lifecycle_reconciliation_required/,
    )
    await assert.rejects(
      useAgent.getState().closeSession(sessionId),
      /lifecycle_reconciliation_required/,
    )
    const sendResult = await useAgent.getState().sendMessage('不能在状态未知时继续')
    assert.equal(sendResult.disposition, 'rejected_before_persistence')
    assert.equal(sendResult.errorKind, 'conversation_reset_required')
    assert.deepEqual(stopRequests, [
      { aliasId, aliasGeneration: 1, readyRunId: 'request-pending' },
      { aliasId, aliasGeneration: 1, readyRunId: 'request-pending' },
    ])
    assert.equal(resetCalls, 0)
    assert.equal(closeCalls, 0)
    assert.equal(sendCalls, 0)
    assert.deepEqual(useAgent.getState().messages, [message])
  } finally {
    restore()
  }
})

test('an exact interrupt uncertainty survives a transport failure and remains retryable', async () => {
  seedStore()
  const priorError = failure('stop', 'interrupt_state_unknown')
  const requests: unknown[] = []
  let calls = 0
  const restore = installAgentApi({
    kill: async (request: unknown) => {
      requests.push(request)
      calls += 1
      if (calls === 1) throw new Error('stop_transport_failed')
      return priorError
    },
  })
  try {
    useAgent.setState((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          lifecycleError: priorError,
        },
      },
      lifecycleError: priorError,
    }))

    await assert.rejects(useAgent.getState().stopStreaming(), /stop_transport_failed/)
    assert.deepEqual(useAgent.getState().sessions[sessionId]?.lifecycleError, priorError)
    assert.equal(useAgent.getState().sessions[sessionId]?.lifecyclePendingAction, null)

    assert.deepEqual(await useAgent.getState().stopStreaming(), priorError)
    assert.equal(requests.length, 2)
  } finally {
    restore()
  }
})

test('exact close and reset uncertainty survives transport failure and retries the captured run', async () => {
  for (const action of ['close', 'reset'] as const) {
    seedStore()
    const priorError = failure(action, 'interrupt_state_unknown')
    const requests: unknown[] = []
    let calls = 0
    const api = async (request: unknown) => {
      requests.push(request)
      calls += 1
      if (calls === 1) throw new Error(`${action}_transport_failed`)
      return priorError
    }
    const restore = installAgentApi(action === 'close'
      ? { closeSession: api }
      : { resetSession: api })
    try {
      useAgent.setState((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            lifecycleError: priorError,
          },
        },
        lifecycleError: priorError,
      }))

      const invoke = () => action === 'close'
        ? useAgent.getState().closeSession(sessionId)
        : useAgent.getState().resetCurrentConversation()
      await assert.rejects(invoke(), new RegExp(`${action}_transport_failed`))
      assert.deepEqual(useAgent.getState().sessions[sessionId]?.lifecycleError, priorError)
      assert.equal(useAgent.getState().sessions[sessionId]?.lifecyclePendingAction, null)
      assert.deepEqual(await invoke(), priorError)
      assert.deepEqual(requests, [
        { aliasId, aliasGeneration: 1, readyRunId: 'request-pending' },
        { aliasId, aliasGeneration: 1, readyRunId: 'request-pending' },
      ])
    } finally {
      restore()
    }
  }
})

test('an exact manual-compaction uncertainty can reset into the returned generation', async () => {
  seedStore()
  const requests: unknown[] = []
  const restore = installAgentApi({
    resetSession: async (request: unknown) => {
      requests.push(request)
      return {
        ok: true,
        action: 'reset',
        aliasId,
        retiredGeneration: 1,
        newGeneration: 2,
        transactionDigest: 'manual-quarantine-reset',
      }
    },
  })
  try {
    const current = useAgent.getState()
    useAgent.setState({
      sessions: {
        ...current.sessions,
        [sessionId]: {
          ...current.sessions[sessionId],
          composerLocked: true,
          lifecycleError: failure('manual_compact', 'compaction_state_unknown'),
        },
      },
      composerLocked: true,
      lifecycleError: failure('manual_compact', 'compaction_state_unknown'),
    })

    const result = await useAgent.getState().resetCurrentConversation()

    assert.equal(result.ok, true)
    assert.deepEqual(requests, [{ aliasId, aliasGeneration: 1, readyRunId: 'request-pending' }])
    const next = useAgent.getState().sessions[sessionId]
    assert.equal(next.aliasGeneration, 2)
    assert.equal(next.lifecycleError, null)
    assert.equal(next.composerLocked, false)
  } finally {
    restore()
  }
})

test('an exact manual-compaction uncertainty survives an action mismatch and remains resettable', async () => {
  seedStore()
  const priorError = failure('manual_compact', 'compaction_state_unknown')
  let calls = 0
  const restore = installAgentApi({
    resetSession: async () => {
      calls += 1
      if (calls === 1) {
        return {
          ok: true,
          action: 'stop',
          aliasId,
          codexThreadId: 'thread-mismatched',
          codexTurnId: 'turn-mismatched',
          terminal: 'interrupted',
          closeoutDigest: 'mismatched-stop-result',
          fenceReleaseRevision: 1,
        }
      }
      return {
        ok: true,
        action: 'reset',
        aliasId,
        retiredGeneration: 1,
        newGeneration: 2,
        transactionDigest: 'manual-quarantine-reset-after-mismatch',
      }
    },
  })
  try {
    useAgent.setState((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          lifecycleError: priorError,
        },
      },
      lifecycleError: priorError,
    }))

    await assert.rejects(
      useAgent.getState().resetCurrentConversation(),
      /lifecycle_result_action_mismatch/,
    )
    assert.deepEqual(useAgent.getState().sessions[sessionId]?.lifecycleError, priorError)
    assert.equal(useAgent.getState().sessions[sessionId]?.lifecyclePendingAction, null)

    const result = await useAgent.getState().resetCurrentConversation()
    assert.equal(result.ok, true)
    assert.equal(calls, 2)
    assert.equal(useAgent.getState().sessions[sessionId]?.aliasGeneration, 2)
    assert.equal(useAgent.getState().sessions[sessionId]?.lifecycleError, null)
  } finally {
    restore()
  }
})

test('a stale manual-compaction uncertainty cannot reset a different alias generation', async () => {
  seedStore()
  let resetCalls = 0
  const restore = installAgentApi({
    resetSession: async () => {
      resetCalls += 1
      return failure('reset')
    },
  })
  try {
    const current = useAgent.getState()
    useAgent.setState({
      sessions: {
        ...current.sessions,
        [sessionId]: {
          ...current.sessions[sessionId],
          aliasGeneration: 2,
          lifecycleError: failure('manual_compact', 'compaction_state_unknown'),
        },
      },
      aliasGeneration: 2,
      lifecycleError: failure('manual_compact', 'compaction_state_unknown'),
    })

    await assert.rejects(
      useAgent.getState().resetCurrentConversation(),
      /lifecycle_reconciliation_required/,
    )
    assert.equal(resetCalls, 0)
  } finally {
    restore()
  }
})

test('late interrupt_state_unknown cannot restore lifecycle uncertainty after the terminal already unlocked', async () => {
  seedStore()
  const pending = deferred<LifecycleResult>()
  const restore = installAgentApi({ kill: () => pending.promise })
  try {
    const stop = useAgent.getState().stopStreaming()
    assert.equal(useAgent.getState().sessions[sessionId]?.lifecyclePendingAction, 'stopping')
    useAgent.setState((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          lifecyclePendingAction: null,
          lifecycleError: null,
          isStreaming: false,
          foregroundBusy: false,
          composerLocked: false,
          streamingMessageId: null,
          streamingRequestId: null,
        },
      },
      isStreaming: false,
      foregroundBusy: false,
      composerLocked: false,
      streamingMessageId: null,
      streamingRequestId: null,
    }))
    const lateFailure = failure('stop', 'interrupt_state_unknown')
    pending.resolve(lateFailure)
    assert.deepEqual(await stop, lateFailure)

    const state = useAgent.getState()
    const slice = state.sessions[sessionId]
    assert.equal(slice?.lifecyclePendingAction, null)
    assert.equal(slice?.lifecycleError, null)
    assert.equal(slice?.composerLocked, false)
    assert.equal(slice?.streamingRequestId, null)
  } finally {
    restore()
  }
})

test('late stop success or failure cannot clear or poison a new run after terminal rollover', async () => {
  const outcomes: LifecycleResult[] = [
    {
      ok: true,
      action: 'stop',
      aliasId,
      codexThreadId: 'thread-old',
      codexTurnId: 'turn-old',
      terminal: 'interrupted',
      closeoutDigest: 'old-stop-closeout',
      fenceReleaseRevision: 1,
    },
    failure('stop', 'interrupt_state_unknown'),
  ]

  for (const outcome of outcomes) {
    seedStore()
    const pending = deferred<LifecycleResult>()
    const restore = installAgentApi({ kill: () => pending.promise })
    try {
      const stop = useAgent.getState().stopStreaming()
      useAgent.setState((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            lifecyclePendingAction: null,
            lifecycleError: null,
            isStreaming: true,
            foregroundBusy: true,
            composerLocked: true,
            streamingMessageId: 'response-next',
            streamingRequestId: 'request-next',
          },
        },
        isStreaming: true,
        foregroundBusy: true,
        composerLocked: true,
        streamingMessageId: 'response-next',
        streamingRequestId: 'request-next',
      }))
      pending.resolve(outcome)
      assert.deepEqual(await stop, outcome)

      assert.equal(useAgent.getState().retiredScopeIds[aliasId], undefined)
      const slice = useAgent.getState().sessions[sessionId]
      assert.equal(slice?.lifecyclePendingAction, null)
      assert.equal(slice?.lifecycleError, null)
      assert.equal(slice?.isStreaming, true)
      assert.equal(slice?.foregroundBusy, true)
      assert.equal(slice?.composerLocked, true)
      assert.equal(slice?.streamingMessageId, 'response-next')
      assert.equal(slice?.streamingRequestId, 'request-next')
    } finally {
      restore()
    }
  }
})

test('late transport failures cannot restore uncertainty after run or generation takeover', async () => {
  for (const action of ['stop', 'reset'] as const) {
    seedStore()
    const release = deferred<void>()
    const priorError = action === 'stop'
      ? failure('stop', 'interrupt_state_unknown')
      : failure('manual_compact', 'compaction_state_unknown')
    const restore = installAgentApi(action === 'stop'
      ? {
          kill: async () => {
            await release.promise
            throw new Error('late_stop_transport_failed')
          },
        }
      : {
          resetSession: async () => {
            await release.promise
            throw new Error('late_reset_transport_failed')
          },
        })
    try {
      useAgent.setState((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            lifecycleError: priorError,
          },
        },
        lifecycleError: priorError,
      }))
      const request = action === 'stop'
        ? useAgent.getState().stopStreaming()
        : useAgent.getState().resetCurrentConversation()

      useAgent.setState((state) => ({
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...state.sessions[sessionId],
            aliasGeneration: action === 'reset' ? 2 : 1,
            lifecyclePendingAction: null,
            lifecycleError: null,
            streamingRequestId: action === 'stop' ? 'request-next' : null,
          },
        },
        aliasGeneration: action === 'reset' ? 2 : 1,
        lifecyclePendingAction: null,
        lifecycleError: null,
        streamingRequestId: action === 'stop' ? 'request-next' : null,
      }))
      release.resolve()
      await assert.rejects(request, /late_(stop|reset)_transport_failed/)

      const slice = useAgent.getState().sessions[sessionId]
      assert.equal(slice?.lifecycleError, null)
      assert.equal(slice?.lifecyclePendingAction, null)
      assert.equal(slice?.aliasGeneration, action === 'reset' ? 2 : 1)
      assert.equal(slice?.streamingRequestId, action === 'stop' ? 'request-next' : null)
    } finally {
      restore()
    }
  }
})

test('a late reset success cannot roll back a newer alias generation', async () => {
  seedStore()
  const pending = deferred<LifecycleResult>()
  const priorError = failure('manual_compact', 'compaction_state_unknown')
  const restore = installAgentApi({ resetSession: () => pending.promise })
  try {
    useAgent.setState((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          lifecycleError: priorError,
        },
      },
      lifecycleError: priorError,
    }))
    const reset = useAgent.getState().resetCurrentConversation()

    useAgent.setState((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          aliasGeneration: 3,
          lifecyclePendingAction: null,
          lifecycleError: null,
        },
      },
      aliasGeneration: 3,
      lifecyclePendingAction: null,
      lifecycleError: null,
    }))
    pending.resolve({
      ok: true,
      action: 'reset',
      aliasId,
      retiredGeneration: 1,
      newGeneration: 2,
      transactionDigest: 'stale-reset-success',
    })
    const result = await reset
    assert.equal(result.ok, true)

    const slice = useAgent.getState().sessions[sessionId]
    assert.equal(slice?.aliasGeneration, 3)
    assert.equal(slice?.lifecycleError, null)
    assert.equal(slice?.lifecyclePendingAction, null)
  } finally {
    restore()
  }
})

test('durable close success wins over a renderer-only run that appeared while close was pending', async () => {
  seedStore()
  const pending = deferred<LifecycleResult>()
  const requests: unknown[] = []
  const restore = installAgentApi({
    closeSession: (request: unknown) => {
      requests.push(request)
      return pending.promise
    },
  })
  try {
    const operation = useAgent.getState().closeSession(sessionId)
    useAgent.setState((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          lifecyclePendingAction: null,
          lifecycleError: null,
          isStreaming: true,
          foregroundBusy: true,
          composerLocked: true,
          streamingMessageId: 'response-B',
          streamingRequestId: 'run-B',
        },
      },
      lifecyclePendingAction: null,
      lifecycleError: null,
      isStreaming: true,
      foregroundBusy: true,
      composerLocked: true,
      streamingMessageId: 'response-B',
      streamingRequestId: 'run-B',
    }))
    pending.resolve({
      ok: true,
      action: 'close',
      closeoutDisposition: 'completed_active_product_turn',
      aliasId,
      retiredGeneration: 1,
      codexThreadId: 'thread-1',
      codexTurnId: 'turn-1',
      terminal: 'interrupted',
      closeoutDigest: 'a'.repeat(64),
      retirementTransactionDigest: 'b'.repeat(64),
      archiveDisposition: 'durable_cleanup_pending',
      archiveIntentDigest: 'c'.repeat(64),
      scopeClosureEvidenceDigest: 'd'.repeat(64),
    })
    assert.equal((await operation).ok, true)
    assert.deepEqual(requests, [{
      aliasId,
      aliasGeneration: 1,
      readyRunId: 'request-pending',
    }])
    const state = useAgent.getState()
    assert.equal(state.sessions[sessionId], undefined)
    assert.equal(state.retiredScopeIds[aliasId], true)
    assert.equal(state.scopes.some((candidate) => candidate.id === aliasId), false)
    assert.equal(state.currentScopeId, null)
    assert.equal(state.isStreaming, false)
    assert.equal(state.composerLocked, false)
  } finally {
    restore()
  }
})

test('late reset success cannot overwrite a new run in the same generation', async () => {
  seedStore()
  const pending = deferred<LifecycleResult>()
  const requests: unknown[] = []
  const restore = installAgentApi({
    resetSession: (request: unknown) => {
      requests.push(request)
      return pending.promise
    },
  })
  try {
    const operation = useAgent.getState().resetCurrentConversation()
    useAgent.setState((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...state.sessions[sessionId],
          lifecyclePendingAction: null,
          lifecycleError: null,
          isStreaming: true,
          foregroundBusy: true,
          composerLocked: true,
          streamingMessageId: 'response-B',
          streamingRequestId: 'run-B',
        },
      },
      lifecyclePendingAction: null,
      lifecycleError: null,
      isStreaming: true,
      foregroundBusy: true,
      composerLocked: true,
      streamingMessageId: 'response-B',
      streamingRequestId: 'run-B',
    }))
    pending.resolve({
      ok: true,
      action: 'reset',
      aliasId,
      retiredGeneration: 1,
      newGeneration: 2,
      transactionDigest: 'stale-reset-success-same-generation',
    })
    assert.equal((await operation).ok, true)
    assert.deepEqual(requests, [{
      aliasId,
      aliasGeneration: 1,
      readyRunId: 'request-pending',
    }])
    const slice = useAgent.getState().sessions[sessionId]
    assert.ok(slice)
    assert.equal(slice.aliasGeneration, 1)
    assert.equal(slice.streamingRequestId, 'run-B')
    assert.equal(slice.streamingMessageId, 'response-B')
    assert.equal(slice.composerLocked, true)
    assert.equal(useAgent.getState().retiredScopeIds[aliasId], undefined)
  } finally {
    restore()
  }
})
