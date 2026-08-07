import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  CreateSessionResult,
  LifecycleResult,
} from '../shared/ipc-contracts/agent-runtime'
import type { AgentMessage, ConversationScope } from '../renderer/modules/agent/types'
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
  const restore = installAgentApi({ createSession: () => pending.promise })
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
  let closeRequest: { aliasId: string; aliasGeneration: number } | null = null
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
    closeSession: async (request: { aliasId: string; aliasGeneration: number }) => {
      closeRequest = request
      return closeFailure
    },
  })
  try {
    await useAgent.getState().loadScopes()
    assert.equal(useAgent.getState().sessions[sessionId]?.aliasGeneration, 7)
    assert.deepEqual(await useAgent.getState().closeSession(sessionId), closeFailure)
    assert.deepEqual(closeRequest, { aliasId, aliasGeneration: 7 })
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

test('unknown lifecycle state blocks repeat actions until reconciliation', async () => {
  seedStore()
  let calls = 0
  let sendCalls = 0
  const restore = installAgentApi({
    kill: async () => {
      calls += 1
      return failure('stop', 'interrupt_state_unknown')
    },
    resetSession: async () => {
      calls += 1
      return failure('reset')
    },
    sendScoped: async () => {
      sendCalls += 1
      throw new Error('must_not_send_while_lifecycle_unknown')
    },
  })
  try {
    const first = await useAgent.getState().stopStreaming()
    assert.equal(first.ok, false)
    await assert.rejects(
      useAgent.getState().stopStreaming(),
      /lifecycle_reconciliation_required/,
    )
    await assert.rejects(
      useAgent.getState().resetCurrentConversation(),
      /lifecycle_reconciliation_required/,
    )
    const sendResult = await useAgent.getState().sendMessage('不能在状态未知时继续')
    assert.equal(sendResult.disposition, 'rejected_before_persistence')
    assert.equal(sendResult.errorKind, 'conversation_reset_required')
    assert.equal(calls, 1)
    assert.equal(sendCalls, 0)
    assert.deepEqual(useAgent.getState().messages, [message])
  } finally {
    restore()
  }
})
