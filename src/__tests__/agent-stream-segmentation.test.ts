import { beforeEach, describe, it } from 'node:test'
import assert from 'node:assert'

const storage = new Map<string, string>()

const localStorageMock = {
  getItem: (key: string): string | null => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => { storage.clear() },
}

;(globalThis as any).localStorage = localStorageMock
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

describe('agent stream segmentation', () => {
  beforeEach(() => {
    storage.clear()
    ;(globalThis as any).window.electronAPI = undefined
    useAgent.setState({
      agents: [
        { name: 'butler', displayName: '管家', avatar: '', status: 'idle', selected: true },
      ],
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

  it('starts a new assistant reply segment after tool events instead of appending into the older reply', async () => {
    const listeners: {
      onStream?: (data: { agent: string; sessionId?: string; runId?: string; chunk: string; type: string }) => void
      onStatusChange?: (data: unknown) => void
      onError?: (data: unknown) => void
      onToolAction?: (data: unknown) => void
      onScopeRunEvent?: (data: unknown) => void
      onConversationEvent?: (data: unknown) => void
    } = {}

    ;(globalThis as any).window.electronAPI = {
      agent: {
        onStream: (cb: (data: { agent: string; sessionId?: string; runId?: string; chunk: string; type: string }) => void) => {
          listeners.onStream = cb
          return () => { listeners.onStream = undefined }
        },
        onStatusChange: (cb: (data: unknown) => void) => {
          listeners.onStatusChange = cb
          return () => { listeners.onStatusChange = undefined }
        },
        onError: (cb: (data: unknown) => void) => {
          listeners.onError = cb
          return () => { listeners.onError = undefined }
        },
        onToolAction: (cb: (data: unknown) => void) => {
          listeners.onToolAction = cb
          return () => { listeners.onToolAction = undefined }
        },
        onScopeRunEvent: (cb: (data: unknown) => void) => {
          listeners.onScopeRunEvent = cb
          return () => { listeners.onScopeRunEvent = undefined }
        },
        onConversationEvent: (cb: (data: unknown) => void) => {
          listeners.onConversationEvent = cb
          return () => { listeners.onConversationEvent = undefined }
        },
      },
    }

    const { initAgentListeners } = await import('../renderer/stores/useAgent')
    const cleanup = initAgentListeners()

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
        createdAt: '2026-03-07T09:00:00.000Z',
        updatedAt: '2026-03-07T09:00:00.000Z',
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
          createdAt: '2026-03-07T09:00:00.000Z',
          updatedAt: '2026-03-07T09:00:00.000Z',
        },
      ],
      messages: [
        {
          id: 'msg-a',
          agent: 'butler',
          content: '第一段回复',
          type: 'agent',
          timestamp: new Date('2026-03-07T09:00:01.000Z'),
        },
      ],
      scopeRunStates: {
        'scope-a': {
          scopeId: 'scope-a',
          agent: 'butler',
          requestId: 'req-a',
          phase: 'responding',
          toolTrace: [],
          startedAt: '2026-03-07T09:00:00.000Z',
          updatedAt: '2026-03-07T09:00:01.000Z',
          latestText: '第一段回复',
          blockedReason: null,
          controllerId: null,
          ownerTabId: null,
          checkpointExpiresAt: null,
          responseMessageId: 'msg-a',
          responseBuffer: '第一段回复',
          responseSegmentBreakPending: false,
          responseSegmentToolTraceStart: 0,
          stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
          error: null,
        },
      },
    })

    listeners.onScopeRunEvent?.({
      scopeId: 'scope-a',
      agent: 'butler',
      runId: 'req-a',
      phase: 'tool_running',
      timestamp: '2026-03-07T09:00:02.000Z',
      toolEvent: {
        id: 'tool-1',
        kind: 'call',
        text: 'browser_click_at(x=512,y=880)',
        timestamp: '2026-03-07T09:00:02.000Z',
      },
    })

    listeners.onStream?.({
      agent: 'butler',
      sessionId: 'scope-a',
      runId: 'req-a',
      chunk: '第二段回复',
      type: 'text',
    })

    const state = useAgent.getState()
    assert.strictEqual(state.messages[0].id, 'msg-a')
    assert.strictEqual(state.messages[0].content, '第一段回复')
    assert.strictEqual(state.messages.length, 2)
    assert.strictEqual(state.messages[1].content, '第二段回复')
    assert.notStrictEqual(state.messages[1].id, 'msg-a')
    assert.strictEqual(state.scopeRunStates['scope-a']?.responseMessageId, state.messages[1].id)

    cleanup()
  })
})
