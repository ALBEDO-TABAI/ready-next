import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

if (typeof (globalThis as any).window === 'undefined') {
  ;(globalThis as any).window = globalThis
}

const { useAgent } = await import('../renderer/stores/useAgent')

type MetricEvent = {
  name: string
  payload: Record<string, unknown>
}

const metrics: MetricEvent[] = []

function resetAgentStore(): void {
  metrics.length = 0
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
  })
}

function conversation(id: string) {
  return {
    id,
    agent: 'butler',
    title: `Conversation ${id}`,
    created_at: '2026-05-05T09:00:00.000Z',
    updated_at: '2026-05-05T09:30:00.000Z',
  }
}

function installElectronApiMock(params: {
  listConversationScopes: () => Promise<unknown>
  getConversations?: (agent: string) => Promise<unknown>
}): { fallbackCalls: () => number } {
  let fallbackCallCount = 0
  ;(globalThis as any).window.electronAPI = {
    agent: {
      listConversationScopes: params.listConversationScopes,
      emitRendererMetric: async (name: string, payload: Record<string, unknown>) => {
        metrics.push({ name, payload })
        return { success: true }
      },
    },
    chat: {
      getConversations: async (agent: string) => {
        fallbackCallCount += 1
        return params.getConversations?.(agent) ?? { success: true, data: [] }
      },
    },
  }
  return { fallbackCalls: () => fallbackCallCount }
}

describe('useAgent legacy conversations fallback metric', () => {
  beforeEach(() => {
    resetAgentStore()
    ;(globalThis as any).window.electronAPI = undefined
  })

  it('emits empty_scopes when scoped result is empty and legacy fallback returns conversations', async () => {
    installElectronApiMock({
      listConversationScopes: async () => ({ success: true, data: [] }),
      getConversations: async () => ({
        success: true,
        data: [conversation('conv-a'), conversation('conv-b')],
      }),
    })

    await useAgent.getState().loadScopes()

    assert.strictEqual(useAgent.getState().scopes.length, 2)
    assert.deepStrictEqual(metrics, [
      {
        name: 'legacy_conversations_fallback_used',
        payload: {
          agent: 'butler',
          reason: 'empty_scopes',
          returnedCount: 2,
        },
      },
    ])
  })

  it('emits scope_list_failed when scoped list fails and legacy fallback returns conversations', async () => {
    installElectronApiMock({
      listConversationScopes: async () => ({ success: false, error: 'scope unavailable' }),
      getConversations: async () => ({
        success: true,
        data: [conversation('conv-fallback')],
      }),
    })

    await useAgent.getState().loadScopes()

    assert.strictEqual(useAgent.getState().scopes.length, 1)
    assert.deepStrictEqual(metrics, [
      {
        name: 'legacy_conversations_fallback_used',
        payload: {
          agent: 'butler',
          reason: 'scope_list_failed',
          returnedCount: 1,
        },
      },
    ])
  })

  it('does not emit when scoped result is available', async () => {
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
      getConversations: async () => ({
        success: true,
        data: [conversation('legacy-unused')],
      }),
    })

    await useAgent.getState().loadScopes()

    assert.strictEqual(useAgent.getState().scopes.length, 1)
    assert.strictEqual(mock.fallbackCalls(), 0)
    assert.deepStrictEqual(metrics, [])
  })
})
