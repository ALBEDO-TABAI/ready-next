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
const { collapseAdjacentDuplicateAssistantTail } = await import('../renderer/modules/agent/runtimeDriver')

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

  it('collapses adjacent duplicated assistant status phrases at the stream tail', () => {
    const duplicated = '我先加载所有参考文件，然后生成完整方案。好，所有参考文件已加载完毕。现在开始生成完整的岩洞晨光风线下门店设计方案，先写主体提案文档。好，所有参考文件已加载完毕。现在开始生成完整的岩洞晨光风线下门店设计方案，先写主体提案文档。'
    assert.strictEqual(
      collapseAdjacentDuplicateAssistantTail(duplicated),
      '我先加载所有参考文件，然后生成完整方案。好，所有参考文件已加载完毕。现在开始生成完整的岩洞晨光风线下门店设计方案，先写主体提案文档。',
    )
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

    const testWindow = globalThis as typeof globalThis & { window: { electronAPI?: unknown } }
    testWindow.window.electronAPI = {
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

  it('re-persists the assistant message snapshot after the final scope run state arrives', async () => {
    const listeners: {
      onStream?: (data: { agent: string; sessionId?: string; runId?: string; chunk: string; type: string }) => void
      onStatusChange?: (data: unknown) => void
      onError?: (data: unknown) => void
      onToolAction?: (data: unknown) => void
      onScopeRunEvent?: (data: unknown) => void
      onConversationEvent?: (data: unknown) => void
    } = {}
    const savedMessages: Array<Record<string, unknown>> = []

    const testWindow = globalThis as typeof globalThis & { window: { electronAPI?: unknown } }
    testWindow.window.electronAPI = {
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
      chat: {
        saveMessage: async (payload: Record<string, unknown>) => {
          savedMessages.push(payload)
          return { success: true }
        },
      },
      settings: {
        get: async () => ({ success: false }),
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
          content: '广州明天雷阵雨转多云，28/24℃。',
          type: 'agent',
          timestamp: new Date('2026-03-07T09:00:01.000Z'),
          meta: {},
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
          latestText: '广州明天雷阵雨转多云，28/24℃。',
          blockedReason: null,
          controllerId: null,
          ownerTabId: null,
          checkpointExpiresAt: null,
          responseMessageId: 'msg-a',
          responseBuffer: '广州明天雷阵雨转多云，28/24℃。',
          responseSegmentBreakPending: false,
          responseSegmentToolTraceStart: 0,
          stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
          taskTitle: '正在理解需求',
          taskSummary: '正在整理任务边界、上下文与可用能力',
          steps: [],
          currentStepId: null,
          waitingFor: 'none',
          resumableActions: [],
          recentArtifacts: [],
          taskContinuation: null,
          memoryCapture: null,
          error: null,
        },
      },
    })

    listeners.onStream?.({
      agent: 'butler',
      sessionId: 'scope-a',
      runId: 'req-a',
      chunk: '',
      type: 'done',
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    listeners.onScopeRunEvent?.({
      scopeId: 'scope-a',
      agent: 'butler',
      runId: 'req-a',
      phase: 'done',
      taskTitle: '最新信息查询',
      taskSummary: '已完成网页查询',
      currentStepId: 'final_reconcile',
      waitingFor: 'none',
      resumableActions: ['none'],
      steps: [
        {
          id: 'final_reconcile',
          title: '结果复核',
          status: 'done',
          updatedAt: '2026-03-07T09:00:03.000Z',
        },
      ],
      timestamp: '2026-03-07T09:00:03.000Z',
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.ok(savedMessages.length >= 2)
    assert.strictEqual(savedMessages[0]?.meta?.taskSnapshot?.phase, 'done')
    const lastSaved = savedMessages.at(-1)
    assert.strictEqual(lastSaved?.meta?.taskSnapshot?.phase, 'done')
    assert.strictEqual(lastSaved?.meta?.taskSnapshot?.taskTitle, '最新信息查询')
    assert.strictEqual(lastSaved?.meta?.taskSnapshot?.taskSummary, '已完成网页查询')

    cleanup()
  })

  it('clears streaming state when stream done arrives before the final scope event', async () => {
    const listeners: {
      onStream?: (data: { agent: string; sessionId?: string; runId?: string; chunk: string; type: string }) => void
      onStatusChange?: (data: unknown) => void
      onError?: (data: unknown) => void
      onToolAction?: (data: unknown) => void
      onScopeRunEvent?: (data: unknown) => void
      onConversationEvent?: (data: unknown) => void
    } = {}
    const savedMessages: Array<Record<string, unknown>> = []

    const testWindow = globalThis as typeof globalThis & { window: { electronAPI?: unknown } }
    testWindow.window.electronAPI = {
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
        emitRendererMetric: async () => ({ success: true }),
      },
      chat: {
        saveMessage: async (payload: Record<string, unknown>) => {
          savedMessages.push(payload)
          return { success: true }
        },
      },
      settings: {
        get: async () => ({ success: false }),
      },
    }

    const { initAgentListeners } = await import('../renderer/stores/useAgent')
    const cleanup = initAgentListeners()

    useAgent.setState({
      currentScopeId: 'scope-stuck',
      currentScope: {
        id: 'scope-stuck',
        agent: 'butler',
        title: 'Scope Stuck',
        sourceKind: 'local',
        sourceId: 'app',
        threadKey: 'scope-stuck',
        meta: {},
        createdAt: '2026-03-07T09:00:00.000Z',
        updatedAt: '2026-03-07T09:00:00.000Z',
      },
      scopes: [
        {
          id: 'scope-stuck',
          agent: 'butler',
          title: 'Scope Stuck',
          sourceKind: 'local',
          sourceId: 'app',
          threadKey: 'scope-stuck',
          meta: {},
          createdAt: '2026-03-07T09:00:00.000Z',
          updatedAt: '2026-03-07T09:00:00.000Z',
        },
      ],
      messages: [
        {
          id: 'msg-stuck',
          agent: 'butler',
          content: '已经完成。',
          type: 'agent',
          timestamp: new Date('2026-03-07T09:00:01.000Z'),
          meta: {},
        },
      ],
      isStreaming: true,
      streamingMessageId: 'msg-stuck',
      streamingRequestId: 'req-stuck',
      toolTraceStatus: 'running',
      scopeRunStates: {
        'scope-stuck': {
          scopeId: 'scope-stuck',
          agent: 'butler',
          requestId: 'req-stuck',
          phase: 'responding',
          toolTrace: [],
          startedAt: '2026-03-07T09:00:00.000Z',
          updatedAt: '2026-03-07T09:00:01.000Z',
          latestText: '已经完成。',
          blockedReason: null,
          controllerId: null,
          ownerTabId: null,
          checkpointExpiresAt: null,
          responseMessageId: 'msg-stuck',
          responseBuffer: '已经完成。',
          responseSegmentBreakPending: false,
          responseSegmentToolTraceStart: 0,
          stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
          error: null,
        },
      },
    })

    listeners.onStream?.({
      agent: 'butler',
      sessionId: 'scope-stuck',
      runId: 'req-stuck',
      chunk: '',
      type: 'done',
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    const state = useAgent.getState()
    assert.strictEqual(state.isStreaming, false)
    assert.strictEqual(state.streamingMessageId, null)
    assert.strictEqual(state.streamingRequestId, null)
    assert.strictEqual(state.toolTraceStatus, 'done')
    assert.strictEqual(state.scopeRunStates['scope-stuck']?.phase, 'done')
    assert.strictEqual(state.scopeRunStates['scope-stuck']?.terminalReason, 'done')
    const lastSavedMeta = savedMessages.at(-1)?.meta as { taskSnapshot?: { phase?: string } } | undefined
    assert.strictEqual(lastSavedMeta?.taskSnapshot?.phase, 'done')

    cleanup()
  })

  it('clears streaming state when the final scope event arrives without a stream done event', async () => {
    const listeners: {
      onStream?: (data: { agent: string; sessionId?: string; runId?: string; chunk: string; type: string }) => void
      onStatusChange?: (data: unknown) => void
      onError?: (data: unknown) => void
      onToolAction?: (data: unknown) => void
      onScopeRunEvent?: (data: unknown) => void
      onConversationEvent?: (data: unknown) => void
    } = {}
    const savedMessages: Array<Record<string, unknown>> = []

    const testWindow = globalThis as typeof globalThis & { window: { electronAPI?: unknown } }
    testWindow.window.electronAPI = {
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
        emitRendererMetric: async () => ({ success: true }),
      },
      chat: {
        saveMessage: async (payload: Record<string, unknown>) => {
          savedMessages.push(payload)
          return { success: true }
        },
      },
      settings: {
        get: async () => ({ success: false }),
      },
    }

    const { initAgentListeners } = await import('../renderer/stores/useAgent')
    const cleanup = initAgentListeners()

    useAgent.setState({
      currentScopeId: 'scope-final-only',
      currentScope: {
        id: 'scope-final-only',
        agent: 'butler',
        title: 'Scope Final Only',
        sourceKind: 'local',
        sourceId: 'app',
        threadKey: 'scope-final-only',
        meta: {},
        createdAt: '2026-03-07T09:00:00.000Z',
        updatedAt: '2026-03-07T09:00:00.000Z',
      },
      scopes: [
        {
          id: 'scope-final-only',
          agent: 'butler',
          title: 'Scope Final Only',
          sourceKind: 'local',
          sourceId: 'app',
          threadKey: 'scope-final-only',
          meta: {},
          createdAt: '2026-03-07T09:00:00.000Z',
          updatedAt: '2026-03-07T09:00:00.000Z',
        },
      ],
      messages: [
        {
          id: 'msg-final-only',
          agent: 'butler',
          content: '好的，我现在开始持续跟进。',
          type: 'agent',
          timestamp: new Date('2026-03-07T09:00:01.000Z'),
          meta: {},
        },
      ],
      isStreaming: true,
      streamingMessageId: 'msg-final-only',
      streamingRequestId: 'req-final-only',
      toolTraceStatus: 'running',
      scopeRunStates: {
        'scope-final-only': {
          scopeId: 'scope-final-only',
          agent: 'butler',
          requestId: 'req-final-only',
          phase: 'responding',
          toolTrace: [],
          startedAt: '2026-03-07T09:00:00.000Z',
          updatedAt: '2026-03-07T09:00:01.000Z',
          latestText: '好的，我现在开始持续跟进。',
          blockedReason: null,
          controllerId: null,
          ownerTabId: null,
          checkpointExpiresAt: null,
          responseMessageId: 'msg-final-only',
          responseBuffer: '好的，我现在开始持续跟进。',
          responseSegmentBreakPending: false,
          responseSegmentToolTraceStart: 0,
          stepMetrics: { toolCalls: 0, toolResults: 0, lastToolAt: null },
          error: null,
        },
      },
    })

    listeners.onScopeRunEvent?.({
      scopeId: 'scope-final-only',
      agent: 'butler',
      runId: 'req-final-only',
      phase: 'done',
      terminalReason: 'done',
      timestamp: '2026-03-07T09:00:03.000Z',
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    const state = useAgent.getState()
    assert.strictEqual(state.isStreaming, false)
    assert.strictEqual(state.streamingMessageId, null)
    assert.strictEqual(state.streamingRequestId, null)
    assert.strictEqual(state.toolTraceStatus, 'done')
    assert.strictEqual(state.scopeRunStates['scope-final-only']?.phase, 'done')
    assert.strictEqual(state.scopeRunStates['scope-final-only']?.terminalReason, 'done')
    assert.strictEqual((savedMessages.at(-1)?.meta as { taskSnapshot?: { phase?: string } } | undefined)?.taskSnapshot?.phase, 'done')

    cleanup()
  })
})
