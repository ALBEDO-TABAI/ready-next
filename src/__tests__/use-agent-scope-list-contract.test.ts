import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

if (typeof (globalThis as any).window === 'undefined') {
  ;(globalThis as any).window = globalThis
}

const { useAgent } = await import('../renderer/stores/useAgent')

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
  })
}

function installElectronApiMock(params: {
  listConversationScopes: () => Promise<unknown>
  getConversations?: (agent: string) => Promise<unknown>
}): { legacyCalls: () => number } {
  let legacyCallCount = 0
  ;(globalThis as any).window.electronAPI = {
    agent: {
      listConversationScopes: params.listConversationScopes,
      emitRendererMetric: async () => ({ success: true }),
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
})
