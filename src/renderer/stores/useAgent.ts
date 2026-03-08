import { create } from 'zustand'
import {
  createEmptyScopeRunState,
  getActiveScopeRunState,
  isActiveScopePhase,
  phaseToToolTraceStatus,
} from '../modules/agent/scopeRunState'
import { runDocCommand as executeDocCommand } from '../modules/agent/documentActions'
import { runSkillCommand as executeSkillCommand } from '../modules/agent/commandHandlers'
import {
  buildComposedAgentInput,
  extractAttachmentsFromMeta as extractPersistedAttachments,
  persistMessage as persistChatMessage,
  serializePersistedAttachments as serializeAttachments,
} from '../modules/agent/messageComposer'
import { createAgentRuntimeDriver } from '../modules/agent/runtimeDriver'
import type {
  Agent,
  AgentMessage,
  AttachmentPreviewState,
  ChatAttachment,
  ChatConversation,
  ConversationScope,
  ScopeRunState,
  ToolTraceEvent,
} from '../modules/agent/types'

export type {
  Agent,
  AgentArtifact,
  AgentMessage,
  AttachmentPreviewState,
  ChatAttachment,
  ChatConversation,
  ConversationScope,
  ScopeRunState,
  ToolTraceEvent,
} from '../modules/agent/types'

interface AgentState {
  agents: Agent[]
  messages: AgentMessage[]
  currentAgent: string
  inputValue: string
  isStreaming: boolean
  streamingMessageId: string | null
  streamingRequestId: string | null
  sessionId: string
  conversationId: string | null
  conversations: ChatConversation[]
  currentScopeId: string | null
  currentScope: ConversationScope | null
  scopes: ConversationScope[]
  scopeRunStates: Record<string, ScopeRunState>
  toolTrace: ToolTraceEvent[]
  toolTraceStatus: 'idle' | 'running' | 'done' | 'error' | 'cancelled'
  attachments: ChatAttachment[]
  filePool: ChatAttachment[]
  activeAttachmentPreview: AttachmentPreviewState | null
  sendCoalescingEnabled: boolean
  sendCoalescingWindowMs: number
  pendingSendCount: number
  pendingSendFlushAt: number | null

  setAgents: (agents: Agent[]) => void
  selectAgent: (name: string) => void
  toggleAgentSelection: (name: string) => void
  addMessage: (message: AgentMessage) => void
  appendToMessage: (id: string, chunk: string) => void
  setInputValue: (value: string) => void
  setIsStreaming: (streaming: boolean) => void
  sendMessage: (content: string) => Promise<void>
  stopStreaming: () => void
  undoLastMessage: () => void
  newSession: () => void
  loadScopes: () => Promise<void>
  loadScope: (scopeId: string) => Promise<void>
  setCurrentScope: (scopeId: string) => Promise<void>
  sendMessageToScope: (scopeId: string, content: string) => Promise<void>
  clearToolTrace: () => void
  loadConversations: () => Promise<void>
  loadConversation: (convId: string) => Promise<void>
  deleteConversation: (convId: string) => Promise<void>
  addAttachments: (files: ChatAttachment[]) => void
  removeAttachment: (id: string) => void
  clearAttachments: () => void
  setActiveAttachmentPreview: (preview: AttachmentPreviewState | null) => void
  loadSendPreferences: () => Promise<void>
  setSendCoalescingEnabled: (enabled: boolean) => Promise<void>
  setSendCoalescingWindowMs: (windowMs: number) => Promise<void>
  pickFiles: () => Promise<void>
}

function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function mapScopeToConversation(scope: ConversationScope): ChatConversation {
  return {
    id: scope.id,
    agent: scope.agent,
    title: scope.title,
    created_at: scope.createdAt,
    updated_at: scope.updatedAt,
  }
}

const DEFAULT_SEND_COALESCE_WINDOW_MS = 1200

let pendingSendTimer: ReturnType<typeof setTimeout> | null = null
let pendingSendBuffer:
  | {
    scopeId: string | null
    agent: string
    parts: string[]
  }
  | null = null
let bypassCoalescingOnce = false

function clearPendingSendBufferState() {
  if (pendingSendTimer) {
    clearTimeout(pendingSendTimer)
    pendingSendTimer = null
  }
  pendingSendBuffer = null
  try {
    useAgent.setState({ pendingSendCount: 0, pendingSendFlushAt: null })
  } catch {
    /* ignore during bootstrap */
  }
}

async function flushPendingSendBuffer() {
  const buffered = pendingSendBuffer
  clearPendingSendBufferState()
  if (!buffered) return

  const merged = buffered.parts
    .map((item) => item.trim())
    .filter(Boolean)
    .join('\n\n')
  if (!merged) return

  bypassCoalescingOnce = true
  try {
    const state = useAgent.getState()
    if (buffered.scopeId && state.currentScopeId !== buffered.scopeId) {
      await state.loadScope(buffered.scopeId).catch(() => undefined)
    } else if (!buffered.scopeId && state.currentAgent !== buffered.agent) {
      state.selectAgent(buffered.agent)
    }
    await useAgent.getState().sendMessage(merged)
  } finally {
    bypassCoalescingOnce = false
  }
}

export const useAgent = create<AgentState>((set, get) => ({
  agents: [
    { name: 'butler', displayName: '管家', avatar: '🤖', status: 'idle', selected: true },
    { name: 'copywriter', displayName: '文案', avatar: '✍️', status: 'idle', selected: false },
    { name: 'video-editor', displayName: '剪辑', avatar: '🎬', status: 'idle', selected: false },
    { name: 'analyst', displayName: '分析', avatar: '📊', status: 'idle', selected: false }
  ],
  messages: [
    {
      id: 'welcome',
      agent: 'butler',
      content: '你好！我是 Ready 的管家 Agent。我可以帮你协调文案、剪辑、分析等 Agent 完成自媒体创作任务。今天想做什么？',
      type: 'agent',
      timestamp: new Date()
    }
  ],
  currentAgent: 'butler',
  inputValue: '',
  isStreaming: false,
  streamingMessageId: null,
  streamingRequestId: null,
  sessionId: generateSessionId(),
  conversationId: null,
  conversations: [],
  currentScopeId: null,
  currentScope: null,
  scopes: [],
  scopeRunStates: {},
  toolTrace: [],
  toolTraceStatus: 'idle',
  attachments: [],
  filePool: [],
  activeAttachmentPreview: null,
  sendCoalescingEnabled: true,
  sendCoalescingWindowMs: DEFAULT_SEND_COALESCE_WINDOW_MS,
  pendingSendCount: 0,
  pendingSendFlushAt: null,

  setAgents: (agents) => set({ agents }),

  selectAgent: (name) => set({ currentAgent: name }),

  toggleAgentSelection: (name) => set((state) => ({
    agents: state.agents.map(a =>
      a.name === name ? { ...a, selected: !a.selected } : a
    )
  })),

  addMessage: (message) => set((state) => ({
    messages: [...state.messages, message]
  })),

  appendToMessage: (id, chunk) => set((state) => ({
    messages: state.messages.map(m =>
      m.id === id ? { ...m, content: m.content + chunk } : m
    )
  })),

  setInputValue: (value) => set({ inputValue: value }),

  setIsStreaming: (streaming) => set({ isStreaming: streaming }),

  setActiveAttachmentPreview: (preview) => set({ activeAttachmentPreview: preview }),

  loadSendPreferences: async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.settings) return
    try {
      const [enabledResult, windowResult] = await Promise.all([
        window.electronAPI.settings.get('agent_message_coalesce_enabled'),
        window.electronAPI.settings.get('agent_message_coalesce_window_ms'),
      ])
      set({
        sendCoalescingEnabled: enabledResult.success ? enabledResult.data !== 'false' : true,
        sendCoalescingWindowMs: windowResult.success && Number(windowResult.data) > 0
          ? Math.max(0, Math.min(5000, Number(windowResult.data)))
          : DEFAULT_SEND_COALESCE_WINDOW_MS,
      })
    } catch {
      set({
        sendCoalescingEnabled: true,
        sendCoalescingWindowMs: DEFAULT_SEND_COALESCE_WINDOW_MS,
      })
    }
  },

  setSendCoalescingEnabled: async (enabled) => {
    set({ sendCoalescingEnabled: enabled })
    if (typeof window !== 'undefined' && window.electronAPI?.settings) {
      await window.electronAPI.settings
        .set('agent_message_coalesce_enabled', enabled ? 'true' : 'false')
        .catch(() => undefined)
    }
    if (!enabled) {
      await flushPendingSendBuffer().catch(() => undefined)
    }
  },

  setSendCoalescingWindowMs: async (windowMs) => {
    const nextValue = Math.max(0, Math.min(5000, Math.round(windowMs)))
    set({ sendCoalescingWindowMs: nextValue })
    if (typeof window !== 'undefined' && window.electronAPI?.settings) {
      await window.electronAPI.settings
        .set('agent_message_coalesce_window_ms', String(nextValue))
        .catch(() => undefined)
    }
  },

  clearToolTrace: () => set((state) => {
    const scopeId = state.currentScopeId
    if (!scopeId) {
      return { toolTrace: [], toolTraceStatus: 'idle' }
    }
    const currentRun = state.scopeRunStates[scopeId]
    return {
      scopeRunStates: {
        ...state.scopeRunStates,
        [scopeId]: currentRun
          ? { ...currentRun, toolTrace: [] }
          : createEmptyScopeRunState({ scopeId, agent: state.currentAgent }),
      },
      toolTrace: [],
      toolTraceStatus: currentRun ? phaseToToolTraceStatus(currentRun.phase) : 'idle',
    }
  }),

  stopStreaming: () => {
    const { currentAgent, currentScopeId } = get()
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.agent.kill(currentAgent, currentScopeId || undefined).catch(console.error)
    }
  },

  undoLastMessage: () => {
    const { messages, currentAgent, currentScopeId, isStreaming } = get()
    if (isStreaming) return

    let lastUserIdx = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'user') {
        lastUserIdx = i
        break
      }
    }
    if (lastUserIdx <= 0) return

    const undoneContent = messages[lastUserIdx].content
    const restored = messages.slice(0, lastUserIdx)

    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.agent.newSession(currentAgent, currentScopeId || undefined).catch(console.error)
    }

    set({
      messages: restored,
      inputValue: undoneContent,
      isStreaming: false,
      streamingMessageId: null,
      streamingRequestId: null,
      toolTrace: [],
      toolTraceStatus: 'idle',
    })
  },

  newSession: () => {
    const { currentAgent } = get()
    const agentData = get().agents.find(a => a.name === currentAgent)
    const displayName = agentData?.displayName || '管家'
    const fallbackScope: ConversationScope = {
      id: `conv-${generateId('local')}`,
      agent: currentAgent,
      title: '新对话',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: '',
      meta: { sourceLabel: '应用内' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastMessageAt: null,
    }

    set({
      messages: [
        {
          id: `welcome-${Date.now()}`,
          agent: currentAgent,
          content: `你好！我是 Ready 的${displayName} Agent。新的对话已开始，有什么我可以帮你的？`,
          type: 'agent',
          timestamp: new Date()
        }
      ],
      isStreaming: false,
      streamingMessageId: null,
      streamingRequestId: null,
      sessionId: generateSessionId(),
      conversationId: fallbackScope.id,
      currentScopeId: fallbackScope.id,
      currentScope: fallbackScope,
      scopeRunStates: {
        ...get().scopeRunStates,
        [fallbackScope.id]: createEmptyScopeRunState({ scopeId: fallbackScope.id, agent: currentAgent }),
      },
      toolTrace: [],
      toolTraceStatus: 'idle',
      attachments: [],
      filePool: []
    })

    if (typeof window !== 'undefined' && window.electronAPI?.agent?.createLocalScope) {
      void window.electronAPI.agent.createLocalScope(currentAgent)
        .then((result) => {
          if (!result.success || !result.data) return
          const scope = result.data as unknown as ConversationScope
          const currentState = useAgent.getState()
          const updatedScopes = [scope, ...currentState.scopes.filter((item) => item.id !== scope.id)]
          useAgent.setState({
            currentScopeId: scope.id,
            currentScope: scope,
            conversationId: scope.id,
            scopes: updatedScopes,
            conversations: updatedScopes.map(mapScopeToConversation),
          })
        })
        .catch(console.error)
    }
  },

  loadScopes: async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.agent) return
    try {
      const { currentAgent } = get()
      const result = await window.electronAPI.agent.listConversationScopes(currentAgent)
      if (!result.success || !result.data) return
      const scopes = result.data as unknown as ConversationScope[]
      const currentScopeId = get().currentScopeId
      const currentScope = scopes.find((scope) => scope.id === currentScopeId) || scopes[0] || null
      const activeRunState = getActiveScopeRunState(get().scopeRunStates, currentScope?.id || null)
      set({
        scopes,
        conversations: scopes.map(mapScopeToConversation),
        currentScopeId: currentScope?.id || null,
        currentScope: currentScope || null,
        conversationId: currentScope?.id || null,
        currentAgent: currentScope?.agent || get().currentAgent,
        toolTrace: activeRunState?.toolTrace || [],
        toolTraceStatus: phaseToToolTraceStatus(activeRunState?.phase),
        isStreaming: isActiveScopePhase(activeRunState?.phase),
        streamingRequestId: activeRunState?.requestId || null,
      })
    } catch { /* ignore */ }
  },

  loadScope: async (scopeId: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.agent) return
    try {
      const result = await window.electronAPI.agent.getConversationScopeMessages(scopeId)
      if (!result.success || !result.data) return
      const scopes = get().scopes
      const scope = scopes.find((item) => item.id === scopeId) || null
      const activeRunState = getActiveScopeRunState(get().scopeRunStates, scopeId)
      const messages: AgentMessage[] = result.data.map((m: { id: string; role: string; content: string; timestamp: string; meta?: Record<string, unknown> }) => ({
        id: m.id,
        agent: scope?.agent || get().currentAgent,
        content: m.content,
        type: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'agent' : 'system',
        timestamp: new Date(m.timestamp),
        attachments: extractPersistedAttachments(m.meta),
        meta: m.meta || {},
      }))
      if (
        activeRunState?.responseMessageId &&
        activeRunState.responseBuffer &&
        !messages.some((item) => item.id === activeRunState.responseMessageId)
      ) {
        messages.push({
          id: activeRunState.responseMessageId,
          agent: scope?.agent || get().currentAgent,
          content: activeRunState.responseBuffer,
          type: 'agent',
          timestamp: new Date(activeRunState.updatedAt || Date.now()),
          meta: { transient: true },
        })
      }
      set({
        messages,
        currentScopeId: scopeId,
        currentScope: scope,
        conversationId: scopeId,
        currentAgent: scope?.agent || get().currentAgent,
        isStreaming: isActiveScopePhase(activeRunState?.phase),
        streamingMessageId: null,
        streamingRequestId: activeRunState?.requestId || null,
        toolTrace: activeRunState?.toolTrace || [],
        toolTraceStatus: phaseToToolTraceStatus(activeRunState?.phase),
        attachments: [],
        filePool: [],
      })
    } catch { /* ignore */ }
  },

  setCurrentScope: async (scopeId: string) => {
    await get().loadScope(scopeId)
  },

  // W2: Load conversations list
  loadConversations: async () => {
    await get().loadScopes()
  },

  // W2: Load a specific conversation
  loadConversation: async (convId: string) => {
    await get().loadScope(convId)
  },

  // W2: Delete conversation
  deleteConversation: async (convId: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.chat) return
    try {
      await window.electronAPI.chat.deleteConversation(convId)
      const { conversations, scopes, currentScopeId } = get()
      set({
        conversations: conversations.filter(c => c.id !== convId),
        scopes: scopes.filter(scope => scope.id !== convId),
      })
      // If we're viewing the deleted conversation, start fresh
      if (currentScopeId === convId) {
        get().newSession()
      }
    } catch { /* ignore */ }
  },

  // W3: Add attachments
  addAttachments: (files: ChatAttachment[]) => set((state) => ({
    attachments: [...state.attachments, ...files],
    filePool: [...state.filePool, ...files.filter(f => !state.filePool.some(p => p.path === f.path))]
  })),

  removeAttachment: (id: string) => set((state) => ({
    attachments: state.attachments.filter(a => a.id !== id)
  })),

  clearAttachments: () => set({ attachments: [] }),

  // W3: Pick files via system dialog
  pickFiles: async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.chat) return
    try {
      const result = await window.electronAPI.chat.pickFiles()
      if (result.success && result.data && result.data.length > 0) {
        const attachments: ChatAttachment[] = result.data.map((f: { name: string; path: string; type: string; size: number; ext: string }) => ({
          id: generateId('attach'),
          name: f.name,
          path: f.path,
          type: f.type as ChatAttachment['type'],
          size: f.size,
          ext: f.ext
        }))
        get().addAttachments(attachments)
      }
    } catch { /* ignore */ }
  },

  sendMessage: async (content: string) => {
    const normalizedContent = content.trim()
    if (!normalizedContent) return

    const stateBeforeSend = get()
    const shouldCoalesce =
      !bypassCoalescingOnce &&
      !stateBeforeSend.isStreaming &&
      stateBeforeSend.sendCoalescingEnabled &&
      !normalizedContent.startsWith('/') &&
      stateBeforeSend.sendCoalescingWindowMs > 0

    if (shouldCoalesce) {
      const targetScopeId = stateBeforeSend.currentScopeId || null
      const targetAgent = stateBeforeSend.currentAgent
      const sameBufferedTarget =
        pendingSendBuffer &&
        pendingSendBuffer.scopeId === targetScopeId &&
        pendingSendBuffer.agent === targetAgent

      if (pendingSendBuffer && !sameBufferedTarget) {
        await flushPendingSendBuffer()
      }

      if (sameBufferedTarget && pendingSendBuffer) {
        pendingSendBuffer.parts.push(normalizedContent)
      } else {
        pendingSendBuffer = {
          scopeId: targetScopeId,
          agent: targetAgent,
          parts: [normalizedContent],
        }
      }

      if (pendingSendTimer) clearTimeout(pendingSendTimer)
      const flushAt = Date.now() + stateBeforeSend.sendCoalescingWindowMs
      pendingSendTimer = setTimeout(() => {
        void flushPendingSendBuffer()
      }, stateBeforeSend.sendCoalescingWindowMs)

      set({
        pendingSendCount: pendingSendBuffer.parts.length,
        pendingSendFlushAt: flushAt,
      })
      return
    }

    bypassCoalescingOnce = false
    const { currentAgent, addMessage, setIsStreaming, attachments, currentScope, currentScopeId } = get()

    let scope = currentScope
    let scopeId = currentScopeId
    if ((!scope || !scopeId) && typeof window !== 'undefined' && window.electronAPI?.agent?.createLocalScope) {
      const created = await window.electronAPI.agent.createLocalScope(currentAgent).catch(() => null)
      if (created?.success && created.data) {
        const nextScope = created.data as unknown as ConversationScope
        scope = nextScope
        scopeId = nextScope.id
        const updatedScopes = [nextScope, ...get().scopes.filter((item) => item.id !== nextScope.id)]
        set({
          currentScopeId: nextScope.id,
          currentScope: nextScope,
          conversationId: nextScope.id,
          scopes: updatedScopes,
          conversations: updatedScopes.map(mapScopeToConversation),
        })
      }
    }
    if (!scope || !scopeId) {
      get().newSession()
      scope = get().currentScope
      scopeId = get().currentScopeId
    }
    if (
      scope &&
      scope.sourceKind === 'local' &&
      !get().scopes.some((item) => item.id === scopeId) &&
      typeof window !== 'undefined' &&
      window.electronAPI?.agent?.createLocalScope
    ) {
      const created = await window.electronAPI.agent.createLocalScope(currentAgent).catch(() => null)
      if (created?.success && created.data) {
        const nextScope = created.data as unknown as ConversationScope
        scope = nextScope
        scopeId = nextScope.id
        const updatedScopes = [nextScope, ...get().scopes.filter((item) => item.id !== nextScope.id)]
        set({
          currentScopeId: nextScope.id,
          currentScope: nextScope,
          conversationId: nextScope.id,
          scopes: updatedScopes,
          conversations: updatedScopes.map(mapScopeToConversation),
        })
      }
    }
    if (
      scope &&
      scope.sourceKind === 'local' &&
      scope.agent !== currentAgent &&
      typeof window !== 'undefined' &&
      window.electronAPI?.agent?.createLocalScope
    ) {
      const created = await window.electronAPI.agent.createLocalScope(currentAgent).catch(() => null)
      if (created?.success && created.data) {
        const nextScope = created.data as unknown as ConversationScope
        scope = nextScope
        scopeId = nextScope.id
        const updatedScopes = [nextScope, ...get().scopes.filter((item) => item.id !== nextScope.id)]
        set({
          currentScopeId: nextScope.id,
          currentScope: nextScope,
          conversationId: nextScope.id,
          scopes: updatedScopes,
          conversations: updatedScopes.map(mapScopeToConversation),
        })
      }
    }
    if (!scope || !scopeId) return
    const activeScope = scope

    // Capture attachments before clearing
    const currentAttachments = [...attachments]
    set({ attachments: [] })

    // Build display content (include @[filename] references)
    const userMsgId = generateId('msg')
    addMessage({
      id: userMsgId,
      agent: currentAgent,
      content,
      type: 'user',
      timestamp: new Date(),
      attachments: currentAttachments.length > 0 ? [...currentAttachments] : undefined
    })

    // Persist user message
    const persistedAttachments = serializeAttachments(currentAttachments)
    await persistChatMessage(scopeId, userMsgId, 'user', content, {
      sourceKind: activeScope.sourceKind,
      sourceId: activeScope.sourceId,
      threadKey: activeScope.threadKey,
      direction: 'local-input',
      attachments: persistedAttachments.length > 0 ? persistedAttachments : undefined,
    })

    if ((activeScope.title === '新对话' || activeScope.title === '未命名会话') && typeof window !== 'undefined' && window.electronAPI?.chat) {
      const firstAttachmentName = currentAttachments[0]?.name
      const title = content.slice(0, 20) || (firstAttachmentName ? `附件: ${firstAttachmentName}` : '新对话')
      if (title) {
        void window.electronAPI.chat.updateConversationTitle({ id: scopeId, title }).catch(() => undefined)
        const nextScope = { ...activeScope, title, updatedAt: new Date().toISOString() }
        set((state) => {
          const scopes = state.scopes.map((item) => item.id === scopeId ? nextScope : item)
          return {
            currentScope: nextScope,
            scopes,
            conversations: scopes.map(mapScopeToConversation),
          }
        })
      }
    }

    const trimmedInput = content.trim()
    if (trimmedInput.startsWith('/skill') || trimmedInput.startsWith('/doc')) {
      const commandResult = trimmedInput.startsWith('/skill')
        ? await executeSkillCommand(trimmedInput, currentAttachments)
        : await executeDocCommand(trimmedInput)

      if (commandResult.handled) {
        const responseId = generateId('response')
        addMessage({
          id: responseId,
          agent: currentAgent,
          content: commandResult.text,
          type: commandResult.isError ? 'system' : 'agent',
          timestamp: new Date(),
        })
        persistChatMessage(scopeId, responseId, 'assistant', commandResult.text)
        return
      }
    }

    if (typeof window !== 'undefined' && window.electronAPI && get().isStreaming) {
      await window.electronAPI.agent.kill(currentAgent, scopeId).catch(console.error)
    }

    setIsStreaming(true)
    const requestId = generateId('req')

    const responseId = generateId('response')
    addMessage({
      id: responseId,
      agent: currentAgent,
      content: '',
      type: 'agent',
      timestamp: new Date()
    })
    set((state) => ({
      streamingMessageId: responseId,
      streamingRequestId: requestId,
      toolTrace: [],
      toolTraceStatus: 'running',
      scopeRunStates: {
        ...state.scopeRunStates,
        [scopeId]: {
          ...createEmptyScopeRunState({
            scopeId,
            agent: currentAgent,
            requestId,
            phase: 'planning',
            responseMessageId: responseId,
          }),
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    }))

    try {
      if (typeof window !== 'undefined' && window.electronAPI) {
        // W5: Build multimodal content — read files and build enhanced message
        const { filePool } = get()
        const finalMessage = await buildComposedAgentInput({
          content,
          attachments: currentAttachments,
          filePool,
        })

        const result = window.electronAPI.agent.sendScoped
          ? await window.electronAPI.agent.sendScoped(scopeId, finalMessage, requestId)
          : await window.electronAPI.agent.send(currentAgent, finalMessage, scopeId || undefined, requestId)

        if (!result.success) {
          if (get().streamingRequestId !== requestId) {
            return
          }
          set((state) => ({
            messages: state.messages.map(m =>
              m.id === responseId
                ? { ...m, content: `${result.error || '发送失败'}`, type: 'system' as const }
                : m
            ),
            isStreaming: false,
            streamingMessageId: null,
            streamingRequestId: null,
            scopeRunStates: {
              ...state.scopeRunStates,
              [scopeId]: {
                ...(state.scopeRunStates[scopeId] || {
                  scopeId,
                  agent: currentAgent,
                  requestId,
                  toolTrace: [],
                  startedAt: new Date().toISOString(),
                }),
                requestId,
                phase: 'error',
                updatedAt: new Date().toISOString(),
                error: result.error || '发送失败',
              },
            },
            toolTraceStatus: 'error',
          }))
        }
        // Stream data arrives via onStream listener
        // Persistence of assistant message happens in onStream 'done' handler
      } else {
        // Mock response for browser-only development
        const mockResponses = [
          `收到你的消息: "${content}"\n\n我正在处理中...这是模拟回复，在 Electron 环境中会连接到 Claude API。\n\n### 功能列表\n- **文案创作**: 帮助撰写高质量内容\n- **数据分析**: 分析热门趋势\n- *视频脚本*: 创作视频脚本\n\n\`\`\`javascript\nconsole.log("Hello Ready!")\n\`\`\``,
          `好的，我来帮你处理: "${content}"\n\n当前运行在浏览器预览模式，Agent 功能需要在 Electron 中使用。\n\n## 提示\n1. 启动 Electron 应用\n2. 配置 \`ANTHROPIC_API_KEY\`\n3. 即可使用 **AI Agent** 能力`,
          `了解！"${content}" 这个需求我可以帮你完成。\n\n提示：启动 Electron 应用并配置 ANTHROPIC_API_KEY 即可使用真实 AI 能力。`
        ]
        const mockReply = mockResponses[Math.floor(Math.random() * mockResponses.length)]

        let i = 0
        const typeInterval = setInterval(() => {
          if (i < mockReply.length) {
            const chunk = mockReply.slice(i, i + Math.floor(Math.random() * 3) + 1)
            get().appendToMessage(responseId, chunk)
            i += chunk.length
          } else {
            clearInterval(typeInterval)
            if (get().streamingRequestId === requestId) {
              set({ isStreaming: false, streamingMessageId: null, streamingRequestId: null })
            }
          }
        }, 30)
      }
    } catch (error) {
      if (get().streamingRequestId !== requestId) return
      set((state) => ({
        messages: state.messages.map(m =>
          m.id === responseId
            ? { ...m, content: `错误: ${error instanceof Error ? error.message : String(error)}`, type: 'system' as const }
            : m
        ),
        isStreaming: false,
        streamingMessageId: null,
        streamingRequestId: null,
        scopeRunStates: {
          ...state.scopeRunStates,
          [scopeId]: {
            ...(state.scopeRunStates[scopeId] || {
              scopeId,
              agent: currentAgent,
              requestId,
              toolTrace: [],
              startedAt: new Date().toISOString(),
            }),
            requestId,
            phase: 'error',
            updatedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          },
        },
        toolTraceStatus: 'error',
      }))
    }
  }
  ,

  sendMessageToScope: async (scopeId: string, content: string) => {
    if (get().currentScopeId !== scopeId) {
      await get().loadScope(scopeId)
    }
    await get().sendMessage(content)
  }
}))

const agentRuntimeDriver = createAgentRuntimeDriver(useAgent as unknown as { getState: () => unknown; setState: (partial: unknown) => void })

export function initAgentListeners(): () => void {
  return agentRuntimeDriver.initAgentListeners()
}
