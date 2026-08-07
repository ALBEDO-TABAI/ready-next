import assert from 'node:assert/strict'
import test from 'node:test'

import type { SendScopedResponse } from '../shared/ipc-contracts/agent-runtime'
import type { ConversationScope } from '../renderer/modules/agent/types'
import { makeEmptySessionSlice } from '../renderer/stores/agent-store-helpers'
import {
  applyIngressAdmitted,
  useAgent,
} from '../renderer/stores/useAgent'

const scope: ConversationScope = {
  id: 'scope-codex-renderer',
  agent: 'butler',
  activeAgentId: 'butler',
  handoffGeneration: 0,
  title: '新对话',
  sourceKind: 'local',
  sourceId: 'app',
  threadKey: 'scope-codex-renderer',
  meta: { sourceLabel: '应用内', createdBy: 'app' },
  createdAt: '2026-08-07T00:00:00.000Z',
  updatedAt: '2026-08-07T00:00:00.000Z',
  lastMessageAt: null,
}

function seedStore(inputValue: string) {
  const slice = {
    ...makeEmptySessionSlice(scope.id),
    inputValue,
    aliasGeneration: 1,
  }
  useAgent.setState({
    messages: [],
    currentAgent: 'butler',
    inputValue,
    currentScopeId: scope.id,
    currentScope: scope,
    scopes: [scope],
    conversations: [],
    attachments: [],
    filePool: [],
    pendingContinuationIntent: null,
    pendingContinuationDraftAnchor: null,
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    scopeRunStates: {},
    toolTrace: [],
    toolTraceStatus: 'idle',
    sessions: { 'session-codex-renderer': slice },
    activeSessionId: 'session-codex-renderer',
    sessionId: 'session-codex-renderer',
    sessionOrder: ['session-codex-renderer'],
    taskDisclosureState: {},
  })
}

function installElectronApi(
  sendScoped: (payload: any) => Promise<SendScopedResponse>,
  options?: {
    readFileForAI?: (path: string) => Promise<{ success: false; error: string }>
  },
) {
  const settingKeys: string[] = []
  const previousWindow = globalThis.window
  const windowStub = {
    electronAPI: {
      agent: { sendScoped },
      chat: options?.readFileForAI
        ? { readFileForAI: options.readFileForAI }
        : undefined,
      settings: {
        async get(key: string) {
          settingKeys.push(key)
          return { success: true, data: null }
        },
      },
    },
  }
  Object.defineProperty(globalThis, 'window', {
    value: windowStub,
    configurable: true,
  })
  return {
    settingKeys,
    restore() {
      if (previousWindow) {
        Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true })
      } else {
        delete (globalThis as typeof globalThis & { window?: Window }).window
      }
    },
  }
}

async function waitFor<T>(read: () => T | null): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = read()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('condition_not_observed')
}

test('renderer keeps composer and transcript untouched until durable admission', async () => {
  seedStore('请处理这条消息')
  let capturedPayload: any = null
  let settle!: (result: SendScopedResponse) => void
  const terminal = new Promise<SendScopedResponse>((resolve) => { settle = resolve })
  const electron = installElectronApi(async (payload) => {
    capturedPayload = payload
    return terminal
  })

  try {
    const sendPromise = useAgent.getState().sendMessage('请处理这条消息')
    const payload = await waitFor(() => capturedPayload)

    let state = useAgent.getState()
    assert.equal(state.inputValue, '请处理这条消息')
    assert.equal(state.messages.length, 0)
    assert.equal(state.isStreaming, false)

    assert.equal(applyIngressAdmitted({
      type: 'ingress_admitted',
      requestId: payload.requestId,
      scopeId: payload.scopeId,
      originUserMessageId: payload.userMessage.id,
      ingressAdmittedRevision: 1,
      ingressAdmittedDigest: 'admission-digest',
      admittedAt: '2026-08-07T00:00:01.000Z',
    }), true)

    state = useAgent.getState()
    assert.equal(state.inputValue, '')
    assert.deepEqual(state.messages.map((message) => message.type), ['user', 'agent'])
    assert.equal(state.isStreaming, true)

    settle({
      success: false,
      disposition: 'terminal_failure_after_persistence',
      ownerRunId: payload.requestId,
      shouldClearInput: true,
      preserveInput: false,
      retryableByUser: false,
      persistence: {
        scope: 'pre-existing',
        message: 'persisted',
        attachments: 'none',
        inputAttachments: 'none',
      },
      error: 'provider_failed',
      errorKind: 'blocked_external',
      productOutcomeDigest: 'product-outcome-digest',
    })
    const result = await sendPromise
    assert.equal(result.disposition, 'terminal_failure_after_persistence')
    assert.equal(useAgent.getState().isStreaming, false)
  } finally {
    electron.restore()
  }
})

test('terminal success replaces the transient bubble with one canonical assistant message', async () => {
  seedStore('请给我最终答案')
  useAgent.setState((state) => ({
    sessions: {
      ...state.sessions,
      'session-codex-renderer': {
        ...state.sessions['session-codex-renderer'],
        state: 'done',
      },
    },
  }))
  let capturedPayload: any = null
  let settle!: (result: SendScopedResponse) => void
  const terminal = new Promise<SendScopedResponse>((resolve) => { settle = resolve })
  const electron = installElectronApi(async (payload) => {
    capturedPayload = payload
    return terminal
  })

  try {
    const sendPromise = useAgent.getState().sendMessage('请给我最终答案')
    const payload = await waitFor(() => capturedPayload)
    assert.equal(applyIngressAdmitted({
      type: 'ingress_admitted',
      requestId: payload.requestId,
      scopeId: payload.scopeId,
      originUserMessageId: payload.userMessage.id,
      ingressAdmittedRevision: 2,
      ingressAdmittedDigest: 'success-admission-digest',
      admittedAt: '2026-08-07T00:00:01.000Z',
    }), true)
    assert.equal(useAgent.getState().sessions['session-codex-renderer']?.state, 'live')

    settle({
      success: true,
      disposition: 'terminal_success',
      ownerRunId: payload.requestId,
      shouldClearInput: true,
      preserveInput: false,
      retryableByUser: false,
      persistence: {
        scope: 'pre-existing',
        message: 'persisted',
        attachments: 'none',
        inputAttachments: 'none',
      },
      responseText: '这是最终答案',
      canonicalMessage: {
        id: 'assistant-canonical-1',
        conversationId: scope.id,
        role: 'assistant',
        content: '这是最终答案',
        timestamp: new Date(new Date(payload.userMessage.timestamp).getTime() + 1).toISOString(),
        meta: { ownerRunId: payload.requestId },
      },
      canonicalMessageDigest: 'canonical-message-digest',
    })

    const result = await sendPromise
    const state = useAgent.getState()
    assert.equal(result.disposition, 'terminal_success')
    assert.deepEqual(state.messages.map((message) => message.id), [
      payload.userMessage.id,
      'assistant-canonical-1',
    ])
    assert.deepEqual(state.messages.map((message) => message.type), ['user', 'agent'])
    assert.equal(state.messages[1]?.content, '这是最终答案')
    assert.equal(state.isStreaming, false)
    assert.equal(state.foregroundBusy, false)
    assert.equal(state.composerLocked, false)
  } finally {
    electron.restore()
  }
})

test('terminal response reconciles durable admission when its push event was lost', async () => {
  seedStore('通知丢失也只能执行一次')
  let capturedPayload: any = null
  const electron = installElectronApi(async (payload) => {
    capturedPayload = payload
    return {
      success: true,
      disposition: 'terminal_success',
      ownerRunId: payload.requestId,
      shouldClearInput: true,
      preserveInput: false,
      retryableByUser: false,
      persistence: {
        scope: 'pre-existing',
        message: 'persisted',
        attachments: 'none',
        inputAttachments: 'none',
      },
      responseText: '只发布一次',
      canonicalMessage: {
        id: 'assistant-lost-admission-event',
        conversationId: scope.id,
        role: 'assistant',
        content: '只发布一次',
        timestamp: new Date(new Date(payload.userMessage.timestamp).getTime() + 1).toISOString(),
        meta: { ownerRunId: payload.requestId },
      },
      canonicalMessageDigest: 'lost-admission-event-canonical-digest',
    }
  })

  try {
    const result = await useAgent.getState().sendMessage('通知丢失也只能执行一次')
    const state = useAgent.getState()
    assert.equal(result.disposition, 'terminal_success')
    assert.ok(capturedPayload)
    assert.equal(state.inputValue, '')
    assert.deepEqual(state.messages.map((message) => message.id), [
      capturedPayload.userMessage.id,
      'assistant-lost-admission-event',
    ])
    assert.equal(state.messages.filter((message) => message.type === 'user').length, 1)
    assert.equal(state.messages.filter((message) => message.type === 'agent').length, 1)
    assert.equal(state.isStreaming, false)
  } finally {
    electron.restore()
  }
})

test('unreadable attachment is rejected before admission without changing visible state', async () => {
  seedStore('读取这个附件')
  const attachment = {
    id: 'attachment-missing-1',
    name: 'missing.txt',
    path: '/definitely/missing.txt',
    type: 'text' as const,
    size: 10,
    ext: '.txt',
    source: 'file' as const,
  }
  useAgent.setState({ attachments: [attachment] })
  let calls = 0
  const electron = installElectronApi(async () => {
    calls += 1
    throw new Error('must_not_send')
  }, {
    readFileForAI: async () => ({ success: false, error: 'file_not_found' }),
  })

  try {
    const result = await useAgent.getState().sendMessage('读取这个附件')
    const state = useAgent.getState()
    assert.equal(result.disposition, 'rejected_before_persistence')
    assert.equal(result.errorKind, 'attachment_unavailable')
    assert.equal(calls, 0)
    assert.equal(state.inputValue, '读取这个附件')
    assert.deepEqual(state.attachments, [attachment])
    assert.equal(state.messages.length, 0)
    assert.equal(state.isStreaming, false)
  } finally {
    electron.restore()
  }
})

test('late admission for a removed origin session cannot bleed into the active session', async () => {
  seedStore('来自已关闭对话的请求')
  let capturedPayload: any = null
  let settle!: (result: SendScopedResponse) => void
  const terminal = new Promise<SendScopedResponse>((resolve) => { settle = resolve })
  const electron = installElectronApi(async (payload) => {
    capturedPayload = payload
    return terminal
  })

  try {
    const sendPromise = useAgent.getState().sendMessage('来自已关闭对话的请求')
    const payload = await waitFor(() => capturedPayload)
    const activeScope: ConversationScope = {
      ...scope,
      id: 'scope-still-active',
      title: '仍在使用的对话',
      threadKey: 'scope-still-active',
    }
    const activeSlice = {
      ...makeEmptySessionSlice(activeScope.id),
      inputValue: '当前草稿',
      aliasGeneration: 1,
    }
    useAgent.setState({
      sessions: { 'session-still-active': activeSlice },
      sessionOrder: ['session-still-active'],
      activeSessionId: 'session-still-active',
      sessionId: 'session-still-active',
      currentScope: activeScope,
      currentScopeId: activeScope.id,
      conversationId: activeScope.id,
      scopes: [activeScope],
      conversations: [],
      messages: [],
      inputValue: '当前草稿',
      isStreaming: false,
      foregroundBusy: false,
      composerLocked: false,
      streamingMessageId: null,
      streamingRequestId: null,
      scopeRunStates: {},
    })

    assert.equal(applyIngressAdmitted({
      type: 'ingress_admitted',
      requestId: payload.requestId,
      scopeId: payload.scopeId,
      originUserMessageId: payload.userMessage.id,
      ingressAdmittedRevision: 3,
      ingressAdmittedDigest: 'removed-origin-admission-digest',
      admittedAt: '2026-08-07T00:00:01.000Z',
    }), false)

    settle({
      success: true,
      disposition: 'terminal_success',
      ownerRunId: payload.requestId,
      shouldClearInput: true,
      preserveInput: false,
      retryableByUser: false,
      persistence: {
        scope: 'pre-existing',
        message: 'persisted',
        attachments: 'none',
        inputAttachments: 'none',
      },
      responseText: '不应该进入当前对话',
      canonicalMessage: {
        id: 'assistant-removed-origin',
        conversationId: scope.id,
        role: 'assistant',
        content: '不应该进入当前对话',
        timestamp: '2026-08-07T00:00:02.000Z',
        meta: {},
      },
      canonicalMessageDigest: 'removed-origin-canonical-digest',
    })
    await sendPromise

    const state = useAgent.getState()
    assert.equal(state.currentScopeId, activeScope.id)
    assert.equal(state.inputValue, '当前草稿')
    assert.equal(state.messages.length, 0)
    assert.equal(state.isStreaming, false)
  } finally {
    electron.restore()
  }
})

test('admission after a tab switch updates only the originating session', async () => {
  seedStore('同样的草稿内容')
  const destinationAttachment = {
    id: 'attachment-after-tab-switch',
    name: '当前会话.txt',
    path: '/tmp/current-session.txt',
    type: 'text' as const,
    size: 12,
    ext: '.txt',
    source: 'file' as const,
  }
  const destinationContinuation = { taskId: 'destination-task' }
  let capturedPayload: any = null
  let settle!: (result: SendScopedResponse) => void
  const terminal = new Promise<SendScopedResponse>((resolve) => { settle = resolve })
  const electron = installElectronApi(async (payload) => {
    capturedPayload = payload
    return terminal
  })

  try {
    const sendPromise = useAgent.getState().sendMessage('同样的草稿内容')
    const payload = await waitFor(() => capturedPayload)
    const nextScope: ConversationScope = {
      ...scope,
      id: 'scope-after-tab-switch',
      title: '切换后的对话',
      threadKey: 'scope-after-tab-switch',
    }
    const beforeSwitch = useAgent.getState()
    useAgent.setState({
      sessions: {
        ...beforeSwitch.sessions,
        'session-after-tab-switch': {
          ...makeEmptySessionSlice(nextScope.id),
          inputValue: '同样的草稿内容',
          aliasGeneration: 1,
        },
      },
      sessionOrder: ['session-codex-renderer', 'session-after-tab-switch'],
      activeSessionId: 'session-after-tab-switch',
      sessionId: 'session-after-tab-switch',
      currentScope: nextScope,
      currentScopeId: nextScope.id,
      conversationId: nextScope.id,
      scopes: [scope, nextScope],
      messages: [],
      inputValue: '同样的草稿内容',
      attachments: [destinationAttachment],
      pendingContinuationIntent: destinationContinuation,
      pendingContinuationDraftAnchor: '同样的草稿内容',
    })

    assert.equal(applyIngressAdmitted({
      type: 'ingress_admitted',
      requestId: payload.requestId,
      scopeId: payload.scopeId,
      originUserMessageId: payload.userMessage.id,
      ingressAdmittedRevision: 4,
      ingressAdmittedDigest: 'switched-session-admission-digest',
      admittedAt: '2026-08-07T00:00:01.000Z',
    }), true)

    let state = useAgent.getState()
    assert.equal(state.activeSessionId, 'session-after-tab-switch')
    assert.equal(state.inputValue, '同样的草稿内容')
    assert.deepEqual(state.messages, [])
    assert.equal(state.sessions['session-after-tab-switch']?.inputValue, '同样的草稿内容')
    assert.equal(state.sessions['session-codex-renderer']?.inputValue, '')
    assert.deepEqual(state.attachments, [destinationAttachment])
    assert.deepEqual(state.pendingContinuationIntent, destinationContinuation)
    assert.equal(state.pendingContinuationDraftAnchor, '同样的草稿内容')
    assert.deepEqual(
      state.sessions['session-codex-renderer']?.messages.map((message) => message.type),
      ['user', 'agent'],
    )

    settle({
      success: false,
      disposition: 'terminal_failure_after_persistence',
      ownerRunId: payload.requestId,
      shouldClearInput: true,
      preserveInput: false,
      retryableByUser: false,
      persistence: {
        scope: 'pre-existing',
        message: 'persisted',
        attachments: 'none',
        inputAttachments: 'none',
      },
      error: 'provider_failed',
      errorKind: 'blocked_external',
      productOutcomeDigest: 'switched-session-outcome-digest',
    })
    await sendPromise

    state = useAgent.getState()
    assert.equal(state.activeSessionId, 'session-after-tab-switch')
    assert.equal(state.inputValue, '同样的草稿内容')
    assert.deepEqual(state.messages, [])
    assert.deepEqual(state.attachments, [destinationAttachment])
    assert.deepEqual(state.pendingContinuationIntent, destinationContinuation)
    assert.equal(state.pendingContinuationDraftAnchor, '同样的草稿内容')
  } finally {
    electron.restore()
  }
})

for (const literal of ['/skill summarize', '/doc rewrite']) {
  test(`${literal} is one ordinary send and pre-persistence rejection preserves UI`, async () => {
    seedStore(literal)
    let calls = 0
    const electron = installElectronApi(async () => {
      calls += 1
      return {
        success: false,
        disposition: 'rejected_before_persistence',
        shouldClearInput: false,
        preserveInput: true,
        retryableByUser: true,
        persistence: {
          scope: 'pre-existing',
          message: 'skipped',
          attachments: 'none',
          inputAttachments: 'none',
        },
        error: 'start_identity_capacity_exhausted',
        errorKind: 'start_identity_capacity_exhausted',
        admissionEvidenceDigest: 'capacity-digest',
      }
    })

    try {
      const result = await useAgent.getState().sendMessage(literal)
      assert.equal(calls, 1)
      assert.equal(result.disposition, 'rejected_before_persistence')
      assert.equal(useAgent.getState().inputValue, literal)
      assert.equal(useAgent.getState().messages.length, 0)
      assert.equal(electron.settingKeys.includes('agent_message_coalesce_enabled'), false)
      assert.equal(electron.settingKeys.includes('agent_message_coalesce_window_ms'), false)
    } finally {
      electron.restore()
    }
  })
}

test('pending ask-user card stays pending while Main admission returns thread_busy', async () => {
  seedStore('新的普通输入')
  useAgent.setState(() => ({
    messages: [{
      id: 'ask-card-1',
      agent: 'butler',
      content: '请选择',
      type: 'ask_user_questions',
      timestamp: new Date('2026-08-07T00:00:00.000Z'),
      askUserQuestions: {
        cardId: 'ask-card-1',
        status: 'pending',
        questions: [],
        askedAt: Date.parse('2026-08-07T00:00:00.000Z'),
      },
    }],
  }))
  let calls = 0
  const electron = installElectronApi(async () => {
    calls += 1
    return {
      success: false,
      disposition: 'rejected_before_persistence',
      shouldClearInput: false,
      preserveInput: true,
      retryableByUser: false,
      persistence: {
        scope: 'pre-existing',
        message: 'skipped',
        attachments: 'none',
        inputAttachments: 'none',
      },
      error: 'thread_busy',
      errorKind: 'thread_busy',
      admissionEvidenceDigest: 'ask-card-thread-busy-digest',
    }
  })

  try {
    const result = await useAgent.getState().sendMessage('新的普通输入')
    assert.equal(result.disposition, 'rejected_before_persistence')
    assert.equal(result.errorKind, 'thread_busy')
    assert.equal(calls, 1)
    assert.equal(useAgent.getState().messages[0]?.askUserQuestions?.status, 'pending')
    assert.equal(useAgent.getState().inputValue, '新的普通输入')
  } finally {
    electron.restore()
  }
})
