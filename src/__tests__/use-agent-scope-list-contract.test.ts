import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { makeEmptySessionSlice } from '../renderer/stores/agent-store-helpers'

if (typeof (globalThis as any).window === 'undefined') {
  ;(globalThis as any).window = globalThis
}

const { hydrateAgentScopesAfterRuntimeReady, useAgent } = await import('../renderer/stores/useAgent')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function resetAgentStore(): void {
  useAgent.setState({
    messages: [],
    currentAgent: 'butler',
    currentScopeId: null,
    currentScope: null,
    scopes: [],
    conversations: [],
    conversationId: null,
    toolTrace: [],
    toolTraceStatus: 'idle',
    isStreaming: false,
    streamingRequestId: null,
    pendingContinuationIntent: null,
    sessions: {},
    sessionOrder: [],
    activeSessionId: null,
    retiredScopeIds: {},
    scopeAuthorityRevision: 0,
    scopeListRequestRevision: 0,
  })
}

function installElectronApiMock(params: {
  listConversationScopes: () => Promise<unknown>
  getConversationScopeMessages?: (scopeId: string) => Promise<unknown>
  getConversations?: (agent: string) => Promise<unknown>
  createSession?: () => Promise<unknown>
  closeSession?: () => Promise<unknown>
  resetSession?: () => Promise<unknown>
  readCodexLifecycleSnapshot?: () => Promise<unknown>
  listPendingAskUserQuestions?: () => Promise<unknown>
}): { legacyCalls: () => number } {
  let legacyCallCount = 0
  ;(globalThis as any).window.electronAPI = {
    agent: {
      listConversationScopes: params.listConversationScopes,
      getConversationScopeMessages: params.getConversationScopeMessages,
      createSession: params.createSession,
      closeSession: params.closeSession,
      resetSession: params.resetSession,
      readCodexLifecycleSnapshot: params.readCodexLifecycleSnapshot,
      emitRendererMetric: async () => ({ success: true }),
    },
    agentInteraction: {
      listPendingAskUserQuestions: params.listPendingAskUserQuestions
        || (async () => ({ success: true, data: [] })),
    },
    chat: {
      getConversations: async (agent: string) => {
        legacyCallCount += 1
        return params.getConversations?.(agent) ?? { success: true, data: [] }
      },
    },
  }
  return { legacyCalls: () => legacyCallCount }
}

describe('useAgent scope list contract', () => {
  beforeEach(() => {
    resetAgentStore()
    ;(globalThis as any).window.electronAPI = undefined
  })

  it('does not repopulate scoped conversations from the retired chat conversation path', async () => {
    const mock = installElectronApiMock({
      listConversationScopes: async () => ({ success: true, data: [] }),
      getConversations: async () => ({
        success: true,
        data: [
          {
            id: 'legacy-conv',
            agent: 'butler',
            title: 'Legacy conversation',
            created_at: '2026-05-05T09:00:00.000Z',
            updated_at: '2026-05-05T09:30:00.000Z',
          },
        ],
      }),
    })

    await useAgent.getState().loadScopes()

    assert.equal(useAgent.getState().scopes.length, 0)
    assert.equal(mock.legacyCalls(), 0)
  })

  it('loads scoped conversations directly when the scoped API has data', async () => {
    const mock = installElectronApiMock({
      listConversationScopes: async () => ({
        success: true,
        data: [
          {
            id: 'scope-ready',
            agent: 'butler',
            title: 'Scoped conversation',
            sourceKind: 'local',
            sourceId: 'app',
            threadKey: 'scope-ready',
            meta: { sourceLabel: '应用内' },
            createdAt: '2026-05-05T09:00:00.000Z',
            updatedAt: '2026-05-05T09:30:00.000Z',
            lastMessageAt: '2026-05-05T09:30:00.000Z',
          },
        ],
      }),
    })

    await useAgent.getState().loadScopes()

    assert.equal(useAgent.getState().scopes.length, 1)
    assert.equal(useAgent.getState().currentScopeId, 'scope-ready')
    assert.equal(mock.legacyCalls(), 0)
  })

  it('removes a closed scope and its stale session slice during hydration', async () => {
    const closedScope = {
      id: 'scope-closed',
      agent: 'butler',
      activeAgentId: 'butler',
      handoffGeneration: 0,
      title: 'Closed',
      sourceKind: 'local' as const,
      sourceId: 'app',
      threadKey: 'scope-closed',
      meta: {},
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      lastMessageAt: null,
    }
    const activeScope = {
      ...closedScope,
      id: 'scope-active',
      title: 'Active',
      threadKey: 'scope-active',
    }
    installElectronApiMock({
      listConversationScopes: async () => ({ success: true, data: [activeScope] }),
    })
    useAgent.setState({
      currentScopeId: closedScope.id,
      currentScope: closedScope,
      scopes: [closedScope, activeScope],
      sessions: {
        'session-closed': makeEmptySessionSlice(closedScope.id),
        'session-active': makeEmptySessionSlice(activeScope.id),
      },
      sessionOrder: ['session-closed', 'session-active'],
      activeSessionId: 'session-closed',
      sessionId: 'session-closed',
    })

    await useAgent.getState().loadScopes()

    const state = useAgent.getState()
    assert.deepEqual(state.scopes.map((scope) => scope.id), [activeScope.id])
    assert.deepEqual(Object.keys(state.sessions), ['session-active'])
    assert.deepEqual(state.sessionOrder, ['session-active'])
    assert.equal(state.currentScopeId, activeScope.id)
    assert.equal(state.activeSessionId, 'session-active')
  })

  it('clears every stale scope and session when cold hydration returns none', async () => {
    const staleScope = {
      id: 'scope-only-closed',
      agent: 'butler',
      activeAgentId: 'butler',
      handoffGeneration: 0,
      title: 'Closed',
      sourceKind: 'local' as const,
      sourceId: 'app',
      threadKey: 'scope-only-closed',
      meta: {},
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      lastMessageAt: null,
    }
    installElectronApiMock({
      listConversationScopes: async () => ({ success: true, data: [] }),
    })
    useAgent.setState({
      currentScopeId: staleScope.id,
      currentScope: staleScope,
      scopes: [staleScope],
      sessions: { 'session-stale': makeEmptySessionSlice(staleScope.id) },
      sessionOrder: ['session-stale'],
      activeSessionId: 'session-stale',
      sessionId: 'session-stale',
      isStreaming: true,
      foregroundBusy: true,
      composerLocked: true,
      streamingMessageId: 'streaming-stale',
      streamingRequestId: 'run-stale',
      scopeRunStates: {
        [staleScope.id]: {
          scopeId: staleScope.id,
          agent: 'butler',
          requestId: 'run-stale',
          phase: 'responding',
          toolTrace: [],
          startedAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-12T00:00:00.000Z',
        },
      },
      toolTrace: [{ id: 'tool-stale', kind: 'tool', text: 'stale', timestamp: new Date() }],
      toolTraceStatus: 'running',
      attachments: [{
        id: 'attachment-stale',
        name: 'stale.txt',
        path: '/tmp/stale.txt',
        type: 'text',
        size: 1,
        ext: '.txt',
        source: 'file',
      }],
      messages: [{
        id: 'stale-message',
        agent: 'butler',
        content: 'stale',
        type: 'agent',
        timestamp: new Date('2026-08-12T00:00:00.000Z'),
      }],
    })

    await useAgent.getState().loadScopes()

    const state = useAgent.getState()
    assert.deepEqual(state.scopes, [])
    assert.deepEqual(state.sessions, {})
    assert.deepEqual(state.sessionOrder, [])
    assert.equal(state.currentScopeId, null)
    assert.equal(state.activeSessionId, null)
    assert.deepEqual(state.messages, [])
    assert.equal(state.isStreaming, false)
    assert.equal(state.foregroundBusy, false)
    assert.equal(state.composerLocked, false)
    assert.equal(state.streamingMessageId, null)
    assert.equal(state.streamingRequestId, null)
    assert.deepEqual(state.scopeRunStates, {})
    assert.deepEqual(state.toolTrace, [])
    assert.equal(state.toolTraceStatus, 'idle')
    assert.deepEqual(state.attachments, [])
  })

  it('ignores a scope-list response captured before durable close completed', async () => {
    const listed = deferred<unknown>()
    const closedScope = {
      id: 'scope-close-race',
      aliasGeneration: 1,
      agent: 'butler',
      activeAgentId: 'butler',
      handoffGeneration: 0,
      title: 'Closing',
      sourceKind: 'local' as const,
      sourceId: 'app',
      threadKey: 'scope-close-race',
      meta: {},
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      lastMessageAt: null,
    }
    installElectronApiMock({
      listConversationScopes: () => listed.promise,
      closeSession: async () => ({
        ok: true,
        action: 'close',
        closeoutDisposition: 'never_started',
        aliasId: closedScope.id,
        retiredGeneration: 1,
        retirementTransactionDigest: 'a'.repeat(64),
        archiveDisposition: 'not_required',
        scopeClosureEvidenceDigest: 'b'.repeat(64),
      }),
    })
    useAgent.setState({
      currentScopeId: closedScope.id,
      currentScope: closedScope,
      scopes: [closedScope],
      sessions: {
        'session-close-race': {
          ...makeEmptySessionSlice(closedScope.id),
          aliasGeneration: 1,
        },
      },
      sessionOrder: ['session-close-race'],
      activeSessionId: 'session-close-race',
      sessionId: 'session-close-race',
    })

    const loading = useAgent.getState().loadScopes()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const closed = await useAgent.getState().closeSession('session-close-race')
    assert.equal(closed.ok, true)
    listed.resolve({ success: true, data: [closedScope] })
    assert.equal(await loading, false)

    const state = useAgent.getState()
    assert.equal(state.retiredScopeIds[closedScope.id], true)
    assert.deepEqual(state.scopes, [])
    assert.deepEqual(state.sessions, {})
    assert.equal(state.currentScopeId, null)
  })

  it('ignores missing and delayed message reads after a scope closes', async () => {
    const messages = deferred<unknown>()
    let messageReads = 0
    const scope = {
      id: 'scope-message-race',
      aliasGeneration: 1,
      agent: 'butler',
      activeAgentId: 'butler',
      handoffGeneration: 0,
      title: 'Closing',
      sourceKind: 'local' as const,
      sourceId: 'app',
      threadKey: 'scope-message-race',
      meta: {},
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      lastMessageAt: null,
    }
    installElectronApiMock({
      listConversationScopes: async () => ({ success: true, data: [] }),
      getConversationScopeMessages: () => {
        messageReads += 1
        return messages.promise
      },
      closeSession: async () => ({
        ok: true,
        action: 'close',
        closeoutDisposition: 'never_started',
        aliasId: scope.id,
        retiredGeneration: 1,
        retirementTransactionDigest: 'c'.repeat(64),
        archiveDisposition: 'not_required',
        scopeClosureEvidenceDigest: 'd'.repeat(64),
      }),
    })
    useAgent.setState({
      currentScopeId: scope.id,
      currentScope: scope,
      scopes: [scope],
      sessions: {
        'session-message-race': {
          ...makeEmptySessionSlice(scope.id),
          aliasGeneration: 1,
        },
      },
      sessionOrder: ['session-message-race'],
      activeSessionId: 'session-message-race',
      sessionId: 'session-message-race',
    })

    const loading = useAgent.getState().loadScope(scope.id)
    await new Promise<void>((resolve) => setImmediate(resolve))
    await useAgent.getState().closeSession('session-message-race')
    messages.resolve({
      success: true,
      data: [{
        id: 'late-message',
        role: 'assistant',
        content: 'late',
        timestamp: '2026-08-12T00:01:00.000Z',
        meta: {},
      }],
    })
    await loading
    await useAgent.getState().loadScope(scope.id)

    const state = useAgent.getState()
    assert.equal(messageReads, 1)
    assert.deepEqual(state.sessions, {})
    assert.deepEqual(state.scopes, [])
    assert.equal(state.currentScopeId, null)
    assert.deepEqual(state.messages, [])
  })

  it('a delayed message read cannot refill the transcript after reset advances generation', async () => {
    const messages = deferred<unknown>()
    const scope = {
      id: 'scope-reset-message-race',
      aliasGeneration: 1,
      agent: 'butler',
      activeAgentId: 'butler',
      handoffGeneration: 0,
      title: 'Resetting',
      sourceKind: 'local' as const,
      sourceId: 'app',
      threadKey: 'scope-reset-message-race',
      meta: {},
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      lastMessageAt: null,
    }
    installElectronApiMock({
      listConversationScopes: async () => ({ success: true, data: [scope] }),
      getConversationScopeMessages: () => messages.promise,
      resetSession: async () => ({
        ok: true,
        action: 'reset',
        aliasId: scope.id,
        retiredGeneration: 1,
        newGeneration: 2,
        transactionDigest: 'a'.repeat(64),
      }),
    })
    useAgent.setState({
      currentScopeId: scope.id,
      currentScope: scope,
      scopes: [scope],
      messages: [{
        id: 'old-message',
        agent: 'butler',
        content: 'old',
        type: 'agent',
        timestamp: new Date('2026-08-12T00:00:00.000Z'),
      }],
      scopeLiveMessages: {
        [scope.id]: [{
          id: 'old-live-message',
          agent: 'butler',
          content: 'old live',
          type: 'agent',
          timestamp: new Date('2026-08-12T00:00:00.000Z'),
        }],
      },
      sessions: {
        'session-reset-message-race': {
          ...makeEmptySessionSlice(scope.id),
          aliasGeneration: 1,
          messages: [{
            id: 'old-message',
            agent: 'butler',
            content: 'old',
            type: 'agent',
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
          }],
        },
      },
      sessionOrder: ['session-reset-message-race'],
      activeSessionId: 'session-reset-message-race',
      sessionId: 'session-reset-message-race',
      aliasGeneration: 1,
    })

    const loading = useAgent.getState().loadScope(scope.id)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const reset = await useAgent.getState().resetCurrentConversation()
    assert.equal(reset.ok, true)
    messages.resolve({
      success: true,
      data: [{
        id: 'late-old-generation-message',
        role: 'assistant',
        content: 'late old generation',
        timestamp: '2026-08-12T00:01:00.000Z',
        meta: {},
      }],
    })
    await loading

    const state = useAgent.getState()
    assert.equal(state.retiredScopeIds[scope.id], undefined)
    assert.equal(state.scopes[0]?.id, scope.id)
    assert.equal(state.scopes[0]?.aliasGeneration, 2)
    assert.equal(state.sessions['session-reset-message-race']?.aliasGeneration, 2)
    assert.deepEqual(state.sessions['session-reset-message-race']?.messages, [])
    assert.deepEqual(state.messages, [])
    assert.equal(state.scopeLiveMessages[scope.id], undefined)
  })

  it('a delayed create uses current state and cannot restore a scope closed meanwhile', async () => {
    const created = deferred<unknown>()
    const scopeA = {
      id: 'scope-create-race-a',
      aliasGeneration: 1,
      agent: 'butler',
      activeAgentId: 'butler',
      handoffGeneration: 0,
      title: 'A',
      sourceKind: 'local' as const,
      sourceId: 'app',
      threadKey: 'scope-create-race-a',
      meta: {},
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      lastMessageAt: null,
    }
    installElectronApiMock({
      listConversationScopes: async () => ({ success: true, data: [] }),
      createSession: () => created.promise,
      closeSession: async () => ({
        ok: true,
        action: 'close',
        closeoutDisposition: 'never_started',
        aliasId: scopeA.id,
        retiredGeneration: 1,
        retirementTransactionDigest: 'e'.repeat(64),
        archiveDisposition: 'not_required',
        scopeClosureEvidenceDigest: 'f'.repeat(64),
      }),
    })
    useAgent.setState({
      currentScopeId: scopeA.id,
      currentScope: scopeA,
      scopes: [scopeA],
      sessions: {
        'session-create-race-a': {
          ...makeEmptySessionSlice(scopeA.id),
          aliasGeneration: 1,
        },
      },
      sessionOrder: ['session-create-race-a'],
      activeSessionId: 'session-create-race-a',
      sessionId: 'session-create-race-a',
    })

    const creating = useAgent.getState().createNewSession()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await useAgent.getState().closeSession('session-create-race-a')
    created.resolve({
      ok: true,
      action: 'create',
      aliasId: 'scope-create-race-b',
      aliasGeneration: 1,
      persistedAt: '2026-08-12T00:01:00.000Z',
    })
    const result = await creating
    assert.equal(result.ok, true)

    const state = useAgent.getState()
    assert.equal(state.retiredScopeIds[scopeA.id], true)
    assert.deepEqual(state.scopes.map((scope) => scope.id), ['scope-create-race-b'])
    assert.equal(Object.values(state.sessions)
      .some((slice) => slice.conversationId === scopeA.id), false)
    assert.equal(Object.values(state.sessions)
      .some((slice) => slice.conversationId === 'scope-create-race-b'), true)
  })

  it('reuses a scope hydrated before its delayed create response arrives', async () => {
    const created = deferred<unknown>()
    const hydratedScope = {
      id: 'scope-create-hydrated',
      aliasGeneration: 2,
      agent: 'butler',
      activeAgentId: 'butler',
      handoffGeneration: 0,
      title: 'Hydrated first',
      sourceKind: 'local' as const,
      sourceId: 'app',
      threadKey: 'scope-create-hydrated',
      meta: {},
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      lastMessageAt: null,
    }
    installElectronApiMock({
      listConversationScopes: async () => ({ success: true, data: [hydratedScope] }),
      createSession: () => created.promise,
    })

    const creating = useAgent.getState().createNewSession()
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(await useAgent.getState().loadScopes(), true)
    created.resolve({
      ok: true,
      action: 'create',
      aliasId: hydratedScope.id,
      aliasGeneration: 1,
      persistedAt: '2026-08-12T00:00:00.000Z',
    })
    await creating

    const state = useAgent.getState()
    assert.deepEqual(state.scopes.map((scope) => scope.id), [hydratedScope.id])
    assert.equal(Object.values(state.sessions)
      .filter((slice) => slice.conversationId === hydratedScope.id).length, 1)
    assert.equal(state.sessionOrder.length, 1)
    assert.equal(state.scopes[0].aliasGeneration, 2)
    assert.equal(Object.values(state.sessions)[0].aliasGeneration, 2)
  })

  it('startup hydration waits for an explicit session create instead of stealing activation', async () => {
    const created = deferred<unknown>()
    let createCalls = 0
    installElectronApiMock({
      listConversationScopes: async () => ({ success: true, data: [] }),
      createSession: () => {
        createCalls += 1
        return created.promise
      },
    })

    const creating = useAgent.getState().createNewSession()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const hydrating = hydrateAgentScopesAfterRuntimeReady()
    await new Promise<void>((resolve) => setImmediate(resolve))

    created.resolve({
      ok: true,
      action: 'create',
      aliasId: 'scope-explicit-during-startup',
      aliasGeneration: 1,
      persistedAt: '2026-08-13T00:00:00.000Z',
    })
    await Promise.all([creating, hydrating])

    const state = useAgent.getState()
    assert.equal(createCalls, 1)
    assert.equal(state.currentScopeId, 'scope-explicit-during-startup')
    assert.ok(state.activeSessionId)
    assert.equal(
      state.sessions[state.activeSessionId!]?.conversationId,
      'scope-explicit-during-startup',
    )
  })

  it('never redirects a send for a closed target into the current active scope', async () => {
    const activeScope = {
      id: 'scope-send-active',
      aliasGeneration: 1,
      agent: 'butler',
      activeAgentId: 'butler',
      handoffGeneration: 0,
      title: 'Active',
      sourceKind: 'local' as const,
      sourceId: 'app',
      threadKey: 'scope-send-active',
      meta: {},
      createdAt: '2026-08-12T00:00:00.000Z',
      updatedAt: '2026-08-12T00:00:00.000Z',
      lastMessageAt: null,
    }
    const closedScopeId = 'scope-send-closed'
    installElectronApiMock({
      listConversationScopes: async () => ({ success: true, data: [activeScope] }),
      getConversationScopeMessages: async () => ({ success: false, error: 'conversation_scope_closed_or_missing' }),
    })
    const originalSendMessage = useAgent.getState().sendMessage
    let sends = 0
    useAgent.setState({
      currentScopeId: activeScope.id,
      currentScope: activeScope,
      scopes: [activeScope],
      retiredScopeIds: { [closedScopeId]: true },
      sendMessage: async () => {
        sends += 1
        throw new Error('unexpected_send')
      },
    })
    try {
      await assert.rejects(
        () => useAgent.getState().sendMessageToScope(closedScopeId, 'must not redirect'),
        /conversation_scope_closed_or_missing/,
      )
      assert.equal(sends, 0)
      assert.equal(useAgent.getState().currentScopeId, activeScope.id)
    } finally {
      useAgent.setState({ sendMessage: originalSendMessage })
    }
  })

  it('a delayed scope list cannot roll back a newer alias generation', async () => {
    const listed = deferred<unknown>()
    installElectronApiMock({ listConversationScopes: () => listed.promise })
    const baseScope = {
      id: 'scope-generation',
      aliasGeneration: 1,
      agent: 'butler',
      activeAgentId: 'butler',
      handoffGeneration: 0,
      title: 'Generation',
      sourceKind: 'local' as const,
      sourceId: 'app',
      threadKey: 'scope-generation',
      meta: { sourceLabel: '应用内' },
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
      lastMessageAt: null,
    }
    useAgent.setState({
      currentScopeId: baseScope.id,
      currentScope: baseScope,
      scopes: [baseScope],
      conversations: [],
      sessions: {
        'session-generation': {
          ...makeEmptySessionSlice(baseScope.id),
          aliasGeneration: 1,
        },
      },
      activeSessionId: 'session-generation',
      sessionId: 'session-generation',
      sessionOrder: ['session-generation'],
      aliasGeneration: 1,
    })

    const loading = useAgent.getState().loadScopes()
    await new Promise<void>((resolve) => setImmediate(resolve))
    useAgent.setState((state) => ({
      sessions: {
        ...state.sessions,
        'session-generation': {
          ...state.sessions['session-generation'],
          aliasGeneration: 2,
        },
      },
      scopes: [{ ...baseScope, aliasGeneration: 2 }],
      currentScope: { ...baseScope, aliasGeneration: 2 },
      aliasGeneration: 2,
    }))
    listed.resolve({ success: true, data: [baseScope] })
    await loading

    const state = useAgent.getState()
    assert.equal(state.sessions['session-generation']?.aliasGeneration, 2)
    assert.equal(state.scopes[0]?.aliasGeneration, 2)
    assert.equal(state.currentScope?.aliasGeneration, 2)
    assert.equal(state.aliasGeneration, 2)
  })

  it('hydrates selected scoped messages on cold start', async () => {
    let loadedScopeId: string | null = null
    installElectronApiMock({
      listConversationScopes: async () => ({
        success: true,
        data: [
          {
            id: 'scope-with-history',
            agent: 'butler',
            title: 'Yesterday test session',
            sourceKind: 'local',
            sourceId: 'app',
            threadKey: 'scope-with-history',
            meta: { sourceLabel: '应用内' },
            createdAt: '2026-05-18T10:00:00.000Z',
            updatedAt: '2026-05-18T10:02:00.000Z',
            lastMessageAt: '2026-05-18T10:02:00.000Z',
          },
        ],
      }),
      getConversationScopeMessages: async (scopeId: string) => {
        loadedScopeId = scopeId
        return {
          success: true,
          data: [
            {
              id: 'msg-user-1',
              role: 'user',
              content: '昨天的测试问题',
              timestamp: '2026-05-18T10:01:00.000Z',
              meta: {},
            },
            {
              id: 'msg-agent-1',
              role: 'assistant',
              content: '昨天的测试回复',
              timestamp: '2026-05-18T10:02:00.000Z',
              meta: {},
            },
          ],
        }
      },
    })
    useAgent.setState({
      messages: [
        {
          id: 'welcome',
          agent: 'butler',
          content: 'welcome',
          type: 'agent',
          timestamp: new Date('2026-05-19T00:00:00.000Z'),
        },
      ],
    })

    await useAgent.getState().loadScopes()

    const state = useAgent.getState()
    assert.equal(loadedScopeId, 'scope-with-history')
    assert.equal(state.currentScopeId, 'scope-with-history')
    assert.equal(state.messages.length, 2)
    assert.equal(state.messages[0].content, '昨天的测试问题')
    assert.equal(state.messages[1].content, '昨天的测试回复')
  })

  it('runtime-ready retry creates exactly one initial scope after the pre-registration pull failed', async () => {
    let listCalls = 0
    let createCalls = 0
    installElectronApiMock({
      listConversationScopes: async () => {
        listCalls += 1
        if (listCalls === 1) throw new Error('handler_not_registered')
        return { success: true, data: [] }
      },
      createSession: async () => {
        createCalls += 1
        return {
          ok: true,
          action: 'create',
          aliasId: 'scope-created-after-ready',
          aliasGeneration: 1,
          persistedAt: '2026-08-11T10:00:00.000Z',
        }
      },
    })

    assert.equal(await useAgent.getState().loadScopes(), false)
    await Promise.all([
      hydrateAgentScopesAfterRuntimeReady(),
      hydrateAgentScopesAfterRuntimeReady(),
    ])

    assert.equal(createCalls, 1)
    assert.equal(useAgent.getState().scopes[0]?.id, 'scope-created-after-ready')
  })

  it('runtime-ready retry restores the durable run and pending question card', async () => {
    const scope = {
      id: 'scope-ready-recovered',
      aliasGeneration: 2,
      agent: 'butler',
      activeAgentId: 'butler',
      handoffGeneration: 0,
      title: 'Recovered',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: 'scope-ready-recovered',
      meta: { sourceLabel: '应用内' },
      createdAt: '2026-08-11T10:00:00.000Z',
      updatedAt: '2026-08-11T10:00:01.000Z',
      lastMessageAt: null,
    }
    installElectronApiMock({
      listConversationScopes: async () => ({ success: true, data: [scope] }),
      readCodexLifecycleSnapshot: async () => ({
        success: true,
        data: {
          identity: { aliasId: scope.id, aliasGeneration: 2 },
          activeReadyRunId: 'run-recovered',
          latestReadyRunId: 'run-recovered',
          snapshot: 'product_turn_interruptible',
          interruptRequested: false,
          interruptAcknowledged: false,
          requestedAction: null,
          evidenceDigest: 'recovered-evidence',
        },
      }),
      listPendingAskUserQuestions: async () => ({
        success: true,
        data: [{
          cardId: 'card-recovered',
          conversationId: scope.id,
          questions: [{ id: 'q1', question: '继续吗？', type: 'text', required: true }],
          askedAt: Date.now(),
        }],
      }),
    })

    await hydrateAgentScopesAfterRuntimeReady()

    const state = useAgent.getState()
    assert.equal(state.streamingRequestId, 'run-recovered')
    assert.equal(state.composerLocked, true)
    assert.equal(state.messages.some((message) => message.id === 'card-recovered'), true)
  })
})
