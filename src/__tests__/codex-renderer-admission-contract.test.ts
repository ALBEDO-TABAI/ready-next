import assert from 'node:assert/strict'
import test from 'node:test'

import type { SendScopedResponse } from '../shared/ipc-contracts/agent-runtime'
import type { ConversationScope } from '../renderer/modules/agent/types'
import { createEmptyScopeRunState } from '../renderer/modules/agent/scopeRunState'
import { makeEmptySessionSlice } from '../renderer/stores/agent-store-helpers'
import { withReceiptV3Fields } from './product-turn-action-projection-fixture'
import {
  applyIngressAdmitted,
  useAgent,
} from '../renderer/stores/useAgent'

const scope: ConversationScope = {
  id: 'scope-codex-renderer',
  aliasGeneration: 1,
  messageVisibilityEpoch: 0,
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

function seedStore(
  inputValue: string,
  aliasGeneration: number | null = 1,
  latestAliasGeneration?: number | null,
) {
  const scoped = {
    ...scope,
    aliasGeneration,
    latestAliasGeneration: latestAliasGeneration ?? aliasGeneration,
  }
  const slice = {
    ...makeEmptySessionSlice(scope.id),
    inputValue,
    aliasGeneration,
  }
  useAgent.setState({
    messages: [],
    currentAgent: 'butler',
    inputValue,
    currentScopeId: scoped.id,
    currentScope: scoped,
    scopes: [scoped],
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

function failureCanonical(runId: string, scopeId = scope.id) {
  const canonicalMessage = {
    id: `assistant:task:${runId}:terminal`,
    conversationId: scopeId,
    role: 'assistant' as const,
    content: '本轮未能完成，已有结果已保留。',
    timestamp: '2026-08-07T00:00:02.000Z',
    meta: { runId },
  }
  return {
    responseText: canonicalMessage.content,
    canonicalMessage,
    canonicalMessageDigest: `canonical-${runId}`,
  }
}

test('renderer keeps composer and transcript untouched until durable admission', async () => {
  seedStore('请处理这条消息', 1)
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
      aliasGeneration: 6,
      messageVisibilityEpoch: 0,
      ingressAdmittedRevision: 1,
      ingressAdmittedDigest: 'admission-digest',
      admittedAt: '2026-08-07T00:00:01.000Z',
    }), true)

    state = useAgent.getState()
    assert.equal(state.inputValue, '')
    assert.deepEqual(state.messages.map((message) => message.type), ['user', 'agent'])
    assert.equal(state.isStreaming, true)
    assert.equal(state.sessions['session-codex-renderer']?.aliasGeneration, 6)

    settle({
      success: false,
      disposition: 'terminal_failure_after_persistence',
      ownerRunId: payload.requestId,
      aliasGeneration: 6,
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
      ...failureCanonical(payload.requestId, payload.scopeId),
    })
    const result = await sendPromise
    assert.equal(result.disposition, 'terminal_failure_after_persistence')
    assert.equal(useAgent.getState().isStreaming, false)
    assert.deepEqual(
      useAgent.getState().messages.filter((message) => message.type === 'agent').map((message) => message.content),
      ['本轮未能完成，已有结果已保留。'],
    )
  } finally {
    electron.restore()
  }
})

test('a newly admitted turn keeps the previous context meter until exact native usage arrives', async () => {
  seedStore('继续', 1)
  const contextUsage = {
    usedInputTokens: 64_000,
    windowTokens: 128_000,
    ratio: 0.5,
    windowSource: 'model' as const,
    source: 'last_model_request' as const,
    timestamp: '2026-08-07T00:00:00.000Z',
  }
  useAgent.setState((state) => {
    const session = state.sessions['session-codex-renderer']
    const scopeRun = {
      ...createEmptyScopeRunState({
        scopeId: scope.id,
        agent: 'butler',
        requestId: 'run-previous',
      }),
      phase: 'done' as const,
      terminalReason: 'done',
      startedAt: contextUsage.timestamp,
      updatedAt: contextUsage.timestamp,
      latestText: '上一轮',
      contextUsage,
    }
    return {
      scopeRunStates: { [scope.id]: scopeRun },
      sessions: {
        ...state.sessions,
        'session-codex-renderer': {
          ...session,
          scopeRunStates: { [scope.id]: scopeRun },
        },
      },
    }
  })
  let capturedPayload: any = null
  let settle!: (result: SendScopedResponse) => void
  const terminal = new Promise<SendScopedResponse>((resolve) => { settle = resolve })
  const electron = installElectronApi(async (payload) => {
    capturedPayload = payload
    return terminal
  })

  try {
    const sending = useAgent.getState().sendMessage('继续')
    const payload = await waitFor(() => capturedPayload)
    assert.equal(applyIngressAdmitted({
      type: 'ingress_admitted',
      requestId: payload.requestId,
      scopeId: payload.scopeId,
      originUserMessageId: payload.userMessage.id,
      aliasGeneration: 2,
      messageVisibilityEpoch: 0,
      ingressAdmittedRevision: 2,
      ingressAdmittedDigest: 'context-preservation-admission',
      admittedAt: '2026-08-07T00:00:01.000Z',
    }), true)

    assert.deepEqual(useAgent.getState().scopeRunStates[scope.id]?.contextUsage, contextUsage)
    settle({
      success: false,
      disposition: 'terminal_failure_after_persistence',
      ownerRunId: payload.requestId,
      aliasGeneration: 2,
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
      ...failureCanonical(payload.requestId, payload.scopeId),
    })
    await sending
  } finally {
    electron.restore()
  }
})

test('same-history generation rollover admits the pending message without erasing history', async () => {
  seedStore('新一轮消息', 1)
  const oldMessage = {
    id: 'history-before-rollover',
    agent: 'butler',
    content: '旧历史',
    type: 'agent' as const,
    timestamp: new Date('2026-08-07T00:00:00.000Z'),
  }
  useAgent.setState((state) => ({
    messages: [oldMessage],
    sessions: {
      ...state.sessions,
      'session-codex-renderer': {
        ...state.sessions['session-codex-renderer'],
        messages: [oldMessage],
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
    const sending = useAgent.getState().sendMessage('新一轮消息')
    const payload = await waitFor(() => capturedPayload)
    assert.equal(payload.expectedAliasGeneration, 1)
    assert.equal(payload.expectedMessageVisibilityEpoch, 0)

    assert.equal(applyIngressAdmitted({
      type: 'ingress_admitted',
      requestId: payload.requestId,
      scopeId: payload.scopeId,
      originUserMessageId: payload.userMessage.id,
      aliasGeneration: 2,
      messageVisibilityEpoch: 0,
      ingressAdmittedRevision: 2,
      ingressAdmittedDigest: 'same-history-rollover-admission',
      admittedAt: '2026-08-07T00:00:01.000Z',
    }), true)

    const admitted = useAgent.getState()
    assert.equal(admitted.sessions['session-codex-renderer']?.aliasGeneration, 2)
    assert.equal(admitted.sessions['session-codex-renderer']?.messageVisibilityEpoch, 0)
    assert.equal(admitted.currentScope?.aliasGeneration, 2)
    assert.deepEqual(admitted.messages.map((message) => message.id), [
      oldMessage.id,
      payload.userMessage.id,
      admitted.streamingMessageId,
    ])

    settle({
      success: false,
      disposition: 'terminal_failure_after_persistence',
      ownerRunId: payload.requestId,
      aliasGeneration: 2,
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
      productOutcomeDigest: 'same-history-rollover-terminal',
      ...failureCanonical(payload.requestId, payload.scopeId),
    })
    await sending
  } finally {
    electron.restore()
  }
})

test('new-history admission rejects a pending message from the previous visibility epoch', async () => {
  seedStore('重置前的消息', 1)
  let capturedPayload: any = null
  let settle!: (result: SendScopedResponse) => void
  const terminal = new Promise<SendScopedResponse>((resolve) => { settle = resolve })
  const electron = installElectronApi(async (payload) => {
    capturedPayload = payload
    return terminal
  })

  try {
    const sending = useAgent.getState().sendMessage('重置前的消息')
    const payload = await waitFor(() => capturedPayload)
    assert.equal(applyIngressAdmitted({
      type: 'ingress_admitted',
      requestId: payload.requestId,
      scopeId: payload.scopeId,
      originUserMessageId: payload.userMessage.id,
      aliasGeneration: 2,
      messageVisibilityEpoch: 1,
      ingressAdmittedRevision: 3,
      ingressAdmittedDigest: 'new-history-stale-admission',
      admittedAt: '2026-08-07T00:00:01.000Z',
    }), false)
    assert.deepEqual(useAgent.getState().messages, [])
    assert.equal(useAgent.getState().sessions['session-codex-renderer']?.aliasGeneration, 1)
    assert.equal(useAgent.getState().sessions['session-codex-renderer']?.messageVisibilityEpoch, 0)

    settle({
      success: false,
      disposition: 'rejected_before_persistence',
      ownerRunId: null,
      shouldClearInput: false,
      preserveInput: true,
      retryableByUser: false,
      persistence: {
        scope: 'none',
        message: 'none',
        attachments: 'none',
        inputAttachments: 'none',
      },
      error: 'stale_generation',
      errorKind: 'conversation_reset_required',
      admissionEvidenceDigest: 'new-history-stale-rejection',
    })
    await sending
  } finally {
    electron.restore()
  }
})

test('an admission from the pre-reset generation cannot roll back the current generation', async () => {
  seedStore('旧轮等待中的消息', 1)
  let capturedPayload: any = null
  let settle!: (result: SendScopedResponse) => void
  const terminal = new Promise<SendScopedResponse>((resolve) => { settle = resolve })
  const electron = installElectronApi(async (payload) => {
    capturedPayload = payload
    return terminal
  })

  try {
    const sendPromise = useAgent.getState().sendMessage('旧轮等待中的消息')
    const payload = await waitFor(() => capturedPayload)
    useAgent.setState((state) => ({
      sessions: {
        ...state.sessions,
        'session-codex-renderer': {
          ...state.sessions['session-codex-renderer'],
          aliasGeneration: 2,
        },
      },
      scopes: state.scopes.map((candidate) => (
        candidate.id === scope.id ? { ...candidate, aliasGeneration: 2 } : candidate
      )),
      currentScope: state.currentScope?.id === scope.id
        ? { ...state.currentScope, aliasGeneration: 2 }
        : state.currentScope,
      aliasGeneration: 2,
    }))

    assert.equal(applyIngressAdmitted({
      type: 'ingress_admitted',
      requestId: payload.requestId,
      scopeId: payload.scopeId,
      originUserMessageId: payload.userMessage.id,
      aliasGeneration: 1,
      messageVisibilityEpoch: 0,
      ingressAdmittedRevision: 1,
      ingressAdmittedDigest: 'stale-admission-digest',
      admittedAt: '2026-08-07T00:00:01.000Z',
    }), false)
    assert.equal(useAgent.getState().sessions['session-codex-renderer']?.aliasGeneration, 2)
    assert.equal(useAgent.getState().currentScope?.aliasGeneration, 2)

    settle({
      success: false,
      disposition: 'rejected_before_persistence',
      ownerRunId: null,
      shouldClearInput: false,
      preserveInput: true,
      retryableByUser: false,
      persistence: {
        scope: 'none',
        message: 'none',
        attachments: 'none',
        inputAttachments: 'none',
      },
      error: 'stale_generation',
      errorKind: 'conversation_reset_required',
      admissionEvidenceDigest: 'stale-generation-evidence',
    })
    await sendPromise
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
      aliasGeneration: 1,
      messageVisibilityEpoch: 0,
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
  seedStore('通知丢失也只能执行一次', 1)
  let capturedPayload: any = null
  const electron = installElectronApi(async (payload) => {
    capturedPayload = payload
    const canonicalMessage = {
      id: 'assistant-lost-admission-event',
      conversationId: scope.id,
      role: 'assistant' as const,
      content: '只发布一次',
      timestamp: new Date(new Date(payload.userMessage.timestamp).getTime() + 1).toISOString(),
      meta: { ownerRunId: payload.requestId },
    }
    return {
      success: true,
      disposition: 'terminal_success',
      ownerRunId: payload.requestId,
      aliasGeneration: 6,
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
      canonicalMessage,
      canonicalMessageDigest: 'lost-admission-event-canonical-digest',
      productTurnReceipt: {
        ...withReceiptV3Fields({ readyRunId: payload.requestId }),
        readyRunId: payload.requestId,
        readyTaskId: 'task-lost-admission-event',
        readyScopeId: scope.id,
        messageVisibilityEpoch: 0,
        revision: 1,
        terminal: 'done',
        canonicalMessage,
        canonicalMessageDigest: 'lost-admission-event-canonical-digest',
        tools: [],
        artifacts: [],
        memory: null,
        contextUsage: {
          usedInputTokens: 6_400,
          windowTokens: 128_000,
          ratio: 0.05,
          windowSource: 'model',
          source: 'last_model_request',
          timestamp: '2026-08-07T00:00:01.500Z',
        },
        failure: null,
        publicationSealDigest: null,
        presentationDigest: 'a'.repeat(64),
      },
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
    assert.equal(state.sessions['session-codex-renderer']?.aliasGeneration, 6)
    assert.equal(state.currentScope?.aliasGeneration, 6)
    assert.equal(state.scopes.find((candidate) => candidate.id === scope.id)?.aliasGeneration, 6)
    assert.equal(state.scopeRunStates[scope.id]?.contextUsage?.usedInputTokens, 6_400)
  } finally {
    electron.restore()
  }
})

test('stale terminal response cannot roll back a newer alias generation', async () => {
  seedStore('旧轮终态不应覆盖新轮', 1)
  let capturedPayload: any = null
  let settle!: (result: SendScopedResponse) => void
  const terminal = new Promise<SendScopedResponse>((resolve) => { settle = resolve })
  const electron = installElectronApi(async (payload) => {
    capturedPayload = payload
    return terminal
  })

  try {
    const sendPromise = useAgent.getState().sendMessage('旧轮终态不应覆盖新轮')
    const payload = await waitFor(() => capturedPayload)
    useAgent.setState((state) => ({
      sessions: {
        ...state.sessions,
        'session-codex-renderer': {
          ...state.sessions['session-codex-renderer'],
          aliasGeneration: 2,
        },
      },
      scopes: state.scopes.map((candidate) => (
        candidate.id === scope.id ? { ...candidate, aliasGeneration: 2 } : candidate
      )),
      currentScope: state.currentScope?.id === scope.id
        ? { ...state.currentScope, aliasGeneration: 2 }
        : state.currentScope,
      aliasGeneration: 2,
    }))

    settle({
      success: true,
      disposition: 'terminal_success',
      ownerRunId: payload.requestId,
      aliasGeneration: 1,
      shouldClearInput: true,
      preserveInput: false,
      retryableByUser: false,
      persistence: {
        scope: 'pre-existing',
        message: 'persisted',
        attachments: 'none',
        inputAttachments: 'none',
      },
      responseText: '旧轮答案',
      canonicalMessage: {
        id: 'assistant-stale-terminal',
        conversationId: scope.id,
        role: 'assistant',
        content: '旧轮答案',
        timestamp: new Date(new Date(payload.userMessage.timestamp).getTime() + 1).toISOString(),
        meta: { ownerRunId: payload.requestId },
      },
      canonicalMessageDigest: 'stale-terminal-canonical-digest',
    })
    await sendPromise

    const state = useAgent.getState()
    assert.equal(state.sessions['session-codex-renderer']?.aliasGeneration, 2)
    assert.equal(state.currentScope?.aliasGeneration, 2)
    assert.equal(state.messages.length, 0)
    assert.equal(state.inputValue, '旧轮终态不应覆盖新轮')
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
      error: 'codex_explicit_resource_unavailable',
      errorKind: 'attachment_unavailable',
      admissionEvidenceDigest: 'missing-attachment-digest',
    }
  })

  try {
    const result = await useAgent.getState().sendMessage('读取这个附件')
    const state = useAgent.getState()
    assert.equal(result.disposition, 'rejected_before_persistence')
    assert.equal(result.errorKind, 'attachment_unavailable')
    assert.equal(calls, 1)
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
      aliasGeneration: 1,
      messageVisibilityEpoch: 0,
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
      aliasGeneration: 1,
      messageVisibilityEpoch: 0,
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
      ...failureCanonical(payload.requestId, payload.scopeId),
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

test('pre-persistence provider rejection keeps the draft and surfaces a visible failure', async () => {
  seedStore('hi')
  const electron = installElectronApi(async () => ({
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
    error: 'gateway_reasoning_capability_unsupported',
    errorKind: 'host_unavailable',
    admissionEvidenceDigest: 'reasoning-capability-digest',
  }))

  try {
    const result = await useAgent.getState().sendMessage('hi')
    const state = useAgent.getState()
    assert.equal(result.disposition, 'rejected_before_persistence')
    assert.equal(state.inputValue, 'hi')
    assert.equal(state.messages.length, 0)
    assert.equal(state.scopeRunStates[scope.id]?.softError?.message, 'gateway_reasoning_capability_unsupported')
    assert.match(state.scopeRunStates[scope.id]?.softError?.friendlyMessage || '', /模型|推理/)
  } finally {
    electron.restore()
  }
})

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

test('publication-diverged follow-up send omits retired generation and lets Main resolve the thread', async () => {
  seedStore('看看能不能看到我现在在看的小红书笔记，帮我总结概述一下', null, 2)
  let capturedPayload: any = null
  const electron = installElectronApi(async (payload) => {
    capturedPayload = payload
    return {
      success: false,
      disposition: 'rejected_before_persistence',
      shouldClearInput: false,
      preserveInput: true,
      retryableByUser: false,
      persistence: {
        scope: 'none',
        message: 'none',
        attachments: 'none',
        inputAttachments: 'none',
      },
      error: 'should_not_block_before_ipc',
      errorKind: 'host_unavailable',
      admissionEvidenceDigest: 'publication-diverged-follow-up',
    }
  })
  try {
    const result = await useAgent.getState().sendMessage(
      '看看能不能看到我现在在看的小红书笔记，帮我总结概述一下',
    )
    assert.equal('expectedAliasGeneration' in capturedPayload, false)
    assert.equal(capturedPayload?.scopeId, scope.id)
    assert.equal(result.disposition, 'rejected_before_persistence')
    assert.equal(result.errorKind, 'host_unavailable')
  } finally {
    electron.restore()
  }
})

test('a conversation without an active generation still reaches Main', async () => {
  seedStore('从未绑定的对话', null, null)
  let calls = 0
  let capturedPayload: any = null
  const electron = installElectronApi(async (payload) => {
    calls += 1
    capturedPayload = payload
    return {
      success: false,
      disposition: 'rejected_before_persistence',
      shouldClearInput: false,
      preserveInput: true,
      retryableByUser: false,
      persistence: {
        scope: 'none',
        message: 'none',
        attachments: 'none',
        inputAttachments: 'none',
      },
      error: 'codex_alias_binding_missing',
      errorKind: 'conversation_reset_required',
      admissionEvidenceDigest: 'never-bound-follow-up',
    }
  })
  try {
    const result = await useAgent.getState().sendMessage('从未绑定的对话')
    assert.equal(calls, 1)
    assert.equal('expectedAliasGeneration' in capturedPayload, false)
    assert.equal(result.disposition, 'rejected_before_persistence')
    assert.equal(result.errorKind, 'conversation_reset_required')
  } finally {
    electron.restore()
  }
})
