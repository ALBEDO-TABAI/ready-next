import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert'

const storage = new Map<string, string>()

;(globalThis as any).localStorage = {
  getItem: (key: string): string | null => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => { storage.clear() },
}

;(globalThis as any).document = {
  documentElement: {
    setAttribute: () => {},
    getAttribute: () => null,
  },
}

;(globalThis as any).matchMedia = () => ({
  matches: false,
  media: '',
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
})

if (typeof (globalThis as any).window === 'undefined') {
  ;(globalThis as any).window = globalThis
}

const { useAgent } = await import('../renderer/stores/useAgent')

describe('agent message preservation', () => {
  beforeEach(() => {
    storage.clear()
    ;(globalThis as any).window.electronAPI = undefined
    useAgent.setState({
      agents: [{ name: 'butler', displayName: '管家', avatar: '', status: 'idle', selected: true }],
      messages: [],
      currentAgent: 'butler',
      currentScopeId: null,
      currentScope: null,
      scopes: [],
      inputValue: '',
      isStreaming: false,
      streamingMessageId: null,
      streamingRequestId: null,
      conversations: [],
      conversationId: null,
      attachments: [],
      filePool: [],
    })
  })

  it('preserves local transient assistant segments when the active scope reloads', async () => {
    ;(globalThis as any).window.electronAPI = {
      agent: {
        getConversationScopeMessages: async () => ({
          success: true,
          data: [
            {
              id: 'persisted-user',
              role: 'user',
              content: '旧问题',
              timestamp: '2026-03-31T10:00:00.000Z',
              meta: {},
            },
          ],
        }),
      },
    }

    useAgent.setState({
      currentScopeId: 'scope-a',
      currentScope: {
        id: 'scope-a',
        agent: 'butler',
        title: 'Scope A',
        sourceKind: 'local',
        sourceId: 'app',
        threadKey: 'scope-a',
        meta: {},
        createdAt: '2026-03-31T10:00:00.000Z',
        updatedAt: '2026-03-31T10:00:00.000Z',
      },
      scopes: [
        {
          id: 'scope-a',
          agent: 'butler',
          title: 'Scope A',
          sourceKind: 'local',
          sourceId: 'app',
          threadKey: 'scope-a',
          meta: {},
          createdAt: '2026-03-31T10:00:00.000Z',
          updatedAt: '2026-03-31T10:00:00.000Z',
        },
      ],
      messages: [
        {
          id: 'persisted-user',
          agent: 'butler',
          content: '旧问题',
          type: 'user',
          timestamp: new Date('2026-03-31T10:00:00.000Z'),
        },
        {
          id: 'transient-agent-1',
          agent: 'butler',
          content: '正在处理中的上文',
          type: 'agent',
          timestamp: new Date('2026-03-31T10:00:10.000Z'),
          meta: { transient: true },
        },
      ],
      scopeRunStates: {
        'scope-a': {
          scopeId: 'scope-a',
          agent: 'butler',
          requestId: 'req-a',
          phase: 'responding',
          toolTrace: [],
          startedAt: '2026-03-31T10:00:05.000Z',
          updatedAt: '2026-03-31T10:00:10.000Z',
          latestText: '正在处理中的上文',
          blockedReason: null,
          controllerId: null,
          ownerTabId: null,
          checkpointExpiresAt: null,
          responseMessageId: 'transient-agent-1',
          responseBuffer: '正在处理中的上文',
          responseSegmentBreakPending: false,
          responseSegmentToolTraceStart: 0,
          stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
          error: null,
        },
      },
    })

    await useAgent.getState().loadScope('scope-a')

    const state = useAgent.getState()
    assert.strictEqual(state.messages.length, 2)
    assert.strictEqual(state.messages[0].id, 'persisted-user')
    assert.strictEqual(state.messages[1].id, 'transient-agent-1')
    assert.strictEqual(state.messages[1].content, '正在处理中的上文')
  })
})
