import { create } from 'zustand'
import {
  createEmptyScopeRunState,
  getActiveScopeRunState,
  isForegroundBusyScopeRunState,
  isStreamingScopeRunState,
  phaseToToolTraceStatus,
} from '../modules/agent/scopeRunState'
import type { TaskDisclosureState, TaskSectionKey } from '../modules/agent/taskCardViewModel'
import { runDocCommand as executeDocCommand } from '../modules/agent/documentActions'
import { runSkillCommand as executeSkillCommand } from '../modules/agent/commandHandlers'
import {
  buildComposedAgentInputWithDiagnostics,
  filterAttachmentsForComposedAgentInput,
  extractAttachmentsFromMeta as extractPersistedAttachments,
  persistMessage as persistChatMessage,
  serializePersistedAttachments as serializeAttachments,
} from '../modules/agent/messageComposer'
import { mapBackendErrorToFriendly } from '../modules/agent/error-message-mapping'
import { emitRendererAgentMetric } from '../modules/agent/rendererMetrics'
import { createAgentRuntimeDriver, syncActiveScopeRunAliases } from '../modules/agent/runtimeDriver'
import {
  ScopeCreatePersistenceMetricThrottle,
  type ScopeCreatePersistenceSite,
} from '../modules/agent/scope-create-persistence-metrics'

/**
 * Stage 3 W4 — observability-only throttle for createLocalScope IPC failures
 * across newSession + 4 sendMessage bootstrap sites. The retry chain at
 * sendMessage's "Conversation scope not found" handler still drives behavior;
 * this throttle adds a renderer-channel metric so operators can see when
 * scope persistence is failing without changing user-visible UI.
 */
const scopeCreatePersistenceMetricThrottle = new ScopeCreatePersistenceMetricThrottle(
  5 * 60_000,
  () => Date.now(),
  (payload) => {
    emitRendererAgentMetric('scope_create_persistence_failed', { ...payload })
  },
)

async function callCreateLocalScopeWithMetric(
  agent: string,
  scopeId: string | null,
  site: ScopeCreatePersistenceSite,
  invoke: () => Promise<{ success: boolean; data?: unknown } | null | undefined>,
): Promise<{ success: boolean; data?: unknown } | null> {
  try {
    const result = await invoke()
    if (!result || !result.success || result.data == null) {
      scopeCreatePersistenceMetricThrottle.maybeEmit(site, 'result_failure', scopeId, agent)
      return result ?? null
    }
    return result
  } catch {
    scopeCreatePersistenceMetricThrottle.maybeEmit(site, 'ipc_rejected', scopeId, agent)
    return null
  }
}
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

export interface PendingContinuationIntent {
  taskId: string
  executionId?: string
  stepId?: string
  blockedReason?: string
  responseText?: string
  todoId?: string
  todoTitle?: string
  pauseReason?: string
  detachedTaskId?: string
  taskRunId?: string
  jobId?: string
  skillId?: string
  action?: string
  runStatePath?: string
  outputDir?: string
  progressFingerprint?: string
}

interface AgentSendResult {
  success: boolean
  error?: string | null
  errorKind?: string | null
  persistence?: {
    scope?: string | null
    message?: string | null
    attachments?: string | null
  } | null
}

export interface SendMessageResult {
  success: boolean
  shouldClearInput: boolean
  preserveInput: boolean
  errorKind?: string | null
}

interface AgentState {
  agents: Agent[]
  messages: AgentMessage[]
  currentAgent: string
  inputValue: string
  pendingContinuationIntent: PendingContinuationIntent | null
  isStreaming: boolean
  foregroundBusy: boolean
  composerLocked: boolean
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
  taskDisclosureState: Record<string, TaskDisclosureState>

  setAgents: (agents: Agent[]) => void
  selectAgent: (name: string) => void
  toggleAgentSelection: (name: string) => void
  addMessage: (message: AgentMessage) => void
  appendToMessage: (id: string, chunk: string) => void
  setInputValue: (value: string, options?: { preserveContinuationIntent?: boolean }) => void
  setComposerDraft: (value: string, continuationIntent?: PendingContinuationIntent | null) => void
  clearPendingContinuationIntent: () => void
  setIsStreaming: (streaming: boolean) => void
  sendMessage: (content: string) => Promise<SendMessageResult>
  stopStreaming: () => void
  undoLastMessage: () => void
  newSession: () => void
  loadScopes: () => Promise<void>
  loadScope: (scopeId: string) => Promise<void>
  setCurrentScope: (scopeId: string) => Promise<void>
  sendMessageToScope: (scopeId: string, content: string) => Promise<void>
  clearToolTrace: () => void
  /** Phase 3: dismiss the soft-failure capsule for a given scope. */
  dismissSoftError: (scopeId: string) => void
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
  setTaskSectionExpanded: (taskKey: string, sectionKey: TaskSectionKey, expanded: boolean) => void
  toggleTaskSection: (taskKey: string, sectionKey: TaskSectionKey) => void
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

async function persistLocalConversationScope(scope: ConversationScope | null): Promise<void> {
  if (!scope || scope.sourceKind !== 'local') return
  if (typeof window === 'undefined' || !window.electronAPI?.chat?.createConversation) return
  await window.electronAPI.chat.createConversation({
    id: scope.id,
    agent: scope.agent,
    title: scope.title || '新对话',
  }).catch(() => undefined)
}

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

function isSameAttachmentPoolEntry(a: ChatAttachment, b: ChatAttachment): boolean {
  if (a.source === 'document-quote' || b.source === 'document-quote' || a.source === 'document-widget-target' || b.source === 'document-widget-target') {
    return (
      a.source === b.source &&
      a.path === b.path &&
      a.widgetTitle === b.widgetTitle &&
      a.lineStart === b.lineStart &&
      a.lineEnd === b.lineEnd &&
      (a.selection || '') === (b.selection || '')
    )
  }
  return a.path === b.path
}

function shouldKeepInFilePool(attachment: ChatAttachment): boolean {
  return attachment.source !== 'document-quote' && attachment.source !== 'document-widget-target'
}

function removeFromFilePool(
  filePool: ChatAttachment[],
  removedAttachment: ChatAttachment,
  remainingAttachments: ChatAttachment[],
): ChatAttachment[] {
  const stillReferenced = remainingAttachments.some((attachment) => isSameAttachmentPoolEntry(attachment, removedAttachment))
  if (stillReferenced) return filePool
  return filePool.filter((attachment) => !isSameAttachmentPoolEntry(attachment, removedAttachment))
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
  pendingContinuationIntent: null,
  isStreaming: false,
  foregroundBusy: false,
  composerLocked: false,
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
  taskDisclosureState: {},

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

  setInputValue: (value, options) => set({
    inputValue: value,
    pendingContinuationIntent: options?.preserveContinuationIntent
      ? get().pendingContinuationIntent
      : null,
  }),

  setComposerDraft: (value, continuationIntent) => set({
    inputValue: value,
    pendingContinuationIntent: continuationIntent || null,
  }),

  clearPendingContinuationIntent: () => set({ pendingContinuationIntent: null }),

  setIsStreaming: (streaming) => set({
    isStreaming: streaming,
    foregroundBusy: streaming,
    composerLocked: streaming,
  }),

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

  setTaskSectionExpanded: (taskKey, sectionKey, expanded) => set((state) => ({
    taskDisclosureState: {
      ...state.taskDisclosureState,
      [taskKey]: {
        ...(state.taskDisclosureState[taskKey] || {}),
        [sectionKey]: expanded,
      },
    },
  })),

  toggleTaskSection: (taskKey, sectionKey) => set((state) => {
    const currentValue = Boolean(state.taskDisclosureState[taskKey]?.[sectionKey])
    return {
      taskDisclosureState: {
        ...state.taskDisclosureState,
        [taskKey]: {
          ...(state.taskDisclosureState[taskKey] || {}),
          [sectionKey]: !currentValue,
        },
      },
    }
  }),

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

  dismissSoftError: (scopeId: string) => set((state) => {
    const currentRun = state.scopeRunStates[scopeId]
    if (!currentRun || !currentRun.softError) return state
    return {
      scopeRunStates: {
        ...state.scopeRunStates,
        [scopeId]: { ...currentRun, softError: null },
      },
    }
  }),

  stopStreaming: () => {
    const { currentAgent, currentScopeId, isStreaming } = get()
    const activeRunState = getActiveScopeRunState(get().scopeRunStates, currentScopeId)
    const shouldStopForegroundRun = activeRunState
      ? isForegroundBusyScopeRunState(activeRunState)
      : isStreaming
    if (!shouldStopForegroundRun) {
      set((state) => ({
        ...syncActiveScopeRunAliases({
          currentScopeId: state.currentScopeId,
          scopeRunStates: state.scopeRunStates,
        }),
      }))
      return
    }
    if (currentScopeId) {
      set((state) => {
        const previous = state.scopeRunStates[currentScopeId] || createEmptyScopeRunState({
          scopeId: currentScopeId,
          agent: state.currentAgent,
        })
        const nextRun: ScopeRunState = {
          ...previous,
          phase: 'cancelled',
          updatedAt: new Date().toISOString(),
          blockedReason: '用户已停止',
          toolTrace: [
            ...(previous.toolTrace || []),
            {
              id: `cancel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: 'result',
              text: '已停止当前运行。',
              timestamp: new Date(),
            },
          ],
        }
        const nextScopeRunStates = {
          ...state.scopeRunStates,
          [currentScopeId]: nextRun,
        }
        return {
          scopeRunStates: nextScopeRunStates,
          streamingMessageId: null,
          streamingRequestId: null,
          ...syncActiveScopeRunAliases({
            currentScopeId: state.currentScopeId,
            scopeRunStates: nextScopeRunStates,
          }),
        }
      })
    } else {
      set({
        isStreaming: false,
        foregroundBusy: false,
        composerLocked: false,
        streamingMessageId: null,
        streamingRequestId: null,
        toolTraceStatus: 'cancelled',
      })
    }
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
      pendingContinuationIntent: null,
      isStreaming: false,
      foregroundBusy: false,
      composerLocked: false,
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
    const fallbackScopeId = `conv-${generateId('local')}`
    const fallbackScope: ConversationScope = {
      id: fallbackScopeId,
      agent: currentAgent,
      title: '新对话',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: fallbackScopeId,
      meta: { sourceLabel: '应用内', createdBy: 'app' },
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
      foregroundBusy: false,
      composerLocked: false,
      streamingMessageId: null,
      streamingRequestId: null,
      sessionId: generateSessionId(),
      conversationId: fallbackScope.id,
      currentScopeId: fallbackScope.id,
      currentScope: fallbackScope,
      scopes: [fallbackScope, ...get().scopes.filter((item) => item.id !== fallbackScope.id)],
      conversations: [mapScopeToConversation(fallbackScope), ...get().conversations.filter((item) => item.id !== fallbackScope.id)],
      scopeRunStates: {
        ...get().scopeRunStates,
        [fallbackScope.id]: createEmptyScopeRunState({ scopeId: fallbackScope.id, agent: currentAgent }),
      },
      toolTrace: [],
      toolTraceStatus: 'idle',
      attachments: [],
      filePool: [],
      pendingContinuationIntent: null,
      taskDisclosureState: {},
    })
    void persistLocalConversationScope(fallbackScope)

    if (typeof window !== 'undefined' && window.electronAPI?.agent?.createLocalScope !== undefined) {
      void window.electronAPI.agent.createLocalScope(currentAgent, fallbackScope.id)
        .then((result) => {
          if (!result.success || !result.data) {
            scopeCreatePersistenceMetricThrottle.maybeEmit('newSession', 'result_failure', fallbackScope.id, currentAgent)
            return
          }
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
        .catch((err) => {
          scopeCreatePersistenceMetricThrottle.maybeEmit('newSession', 'ipc_rejected', fallbackScope.id, currentAgent)
          console.error(err)
        })
    }
  },

  loadScopes: async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.agent) return
    try {
      const { currentAgent } = get()
      const result = await window.electronAPI.agent.listConversationScopes(currentAgent)
      let scopes: ConversationScope[] = result.success && Array.isArray(result.data)
        ? result.data as unknown as ConversationScope[]
        : []
      if (
        scopes.length === 0 &&
        typeof window !== 'undefined' &&
        window.electronAPI?.chat?.getConversations
      ) {
        const fallback = await window.electronAPI.chat.getConversations(currentAgent).catch(() => null)
        if (fallback?.success && Array.isArray(fallback.data)) {
          scopes = fallback.data.map((conversation) => ({
            id: conversation.id,
            agent: conversation.agent,
            title: conversation.title,
            sourceKind: 'local',
            sourceId: 'app',
            threadKey: conversation.id,
            meta: { sourceLabel: '应用内', createdBy: 'app' },
            createdAt: conversation.created_at,
            updatedAt: conversation.updated_at,
            lastMessageAt: conversation.updated_at,
          }))
        }
      }
      if (scopes.length === 0) return
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
        isStreaming: isStreamingScopeRunState(activeRunState),
        streamingRequestId: activeRunState?.requestId || null,
        pendingContinuationIntent: null,
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
      const currentMessages = get().currentScopeId === scopeId ? get().messages : []
      const transientMessages = currentMessages.filter((message) =>
        message.meta?.transient &&
        !messages.some((persisted) => persisted.id === message.id),
      )
      if (transientMessages.length > 0) {
        messages.push(...transientMessages)
        messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      }
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
        isStreaming: isStreamingScopeRunState(activeRunState),
        streamingMessageId: null,
        streamingRequestId: activeRunState?.requestId || null,
        toolTrace: activeRunState?.toolTrace || [],
        toolTraceStatus: phaseToToolTraceStatus(activeRunState?.phase),
        attachments: [],
        filePool: [],
        pendingContinuationIntent: null,
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
    filePool: [
      ...state.filePool,
      ...files.filter((file) =>
        shouldKeepInFilePool(file) &&
        !state.filePool.some((poolItem) => isSameAttachmentPoolEntry(poolItem, file)),
      ),
    ],
  })),

  removeAttachment: (id: string) => set((state) => {
    const removedAttachment = state.attachments.find((attachment) => attachment.id === id)
    const nextAttachments = state.attachments.filter((attachment) => attachment.id !== id)
    return {
      attachments: nextAttachments,
      filePool: removedAttachment
        ? removeFromFilePool(state.filePool, removedAttachment, nextAttachments)
        : state.filePool,
    }
  }),

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
          ext: f.ext,
          source: 'file',
        }))
        get().addAttachments(attachments)
      }
    } catch { /* ignore */ }
  },

  sendMessage: async (content: string) => {
    const normalizedContent = content.trim()
    const { attachments: pendingAttachments } = get()
    if (!normalizedContent && pendingAttachments.length === 0) {
      return { success: false, shouldClearInput: false, preserveInput: true, errorKind: 'empty_input' }
    }

    const stateBeforeSend = get()
    const runBeforeSend = getActiveScopeRunState(
      stateBeforeSend.scopeRunStates,
      stateBeforeSend.currentScopeId,
    )
    const foregroundBusyBeforeSend = runBeforeSend
      ? isForegroundBusyScopeRunState(runBeforeSend)
      : stateBeforeSend.isStreaming
    const shouldCoalesce =
      !bypassCoalescingOnce &&
      !foregroundBusyBeforeSend &&
      !stateBeforeSend.pendingContinuationIntent &&
      stateBeforeSend.sendCoalescingEnabled &&
      normalizedContent.length > 0 &&
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
      return { success: true, shouldClearInput: true, preserveInput: false }
    }

    bypassCoalescingOnce = false
    const {
      currentAgent,
      addMessage,
      setIsStreaming,
      attachments,
      currentScope,
      currentScopeId,
      pendingContinuationIntent,
    } = get()

    let scope = currentScope
    let scopeId = currentScopeId
    let localScopeBootstrapAttempted = false
    if ((!scope || !scopeId) && typeof window !== 'undefined' && window.electronAPI?.agent?.createLocalScope !== undefined) {
      localScopeBootstrapAttempted = true
      const created = await callCreateLocalScopeWithMetric(
        currentAgent,
        null,
        'sendMessage_no_scope',
        () => window.electronAPI!.agent!.createLocalScope(currentAgent),
      )
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
      window.electronAPI?.agent?.createLocalScope !== undefined
    ) {
      localScopeBootstrapAttempted = true
      const created = await callCreateLocalScopeWithMetric(
        currentAgent,
        scopeId ?? null,
        'sendMessage_local_scope_missing',
        () => window.electronAPI!.agent!.createLocalScope(currentAgent, scopeId || undefined),
      )
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
      window.electronAPI?.agent?.createLocalScope !== undefined
    ) {
      localScopeBootstrapAttempted = true
      const created = await callCreateLocalScopeWithMetric(
        currentAgent,
        scopeId ?? null,
        'sendMessage_agent_mismatch',
        () => window.electronAPI!.agent!.createLocalScope(currentAgent),
      )
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
      return { success: false, shouldClearInput: false, preserveInput: true, errorKind: 'scope_missing' }
    }
    let activeScope = scope
    let activeScopeId = scopeId
    await persistLocalConversationScope(activeScope)
    if (
      !localScopeBootstrapAttempted &&
      activeScope.sourceKind === 'local' &&
      typeof window !== 'undefined' &&
      window.electronAPI?.agent?.createLocalScope !== undefined
    ) {
      const ensured = await callCreateLocalScopeWithMetric(
        activeScope.agent,
        activeScope.id,
        'sendMessage_ensure',
        () => window.electronAPI!.agent!.createLocalScope(activeScope.agent, activeScope.id),
      )
      if (ensured?.success && ensured.data) {
        const nextScope = ensured.data as unknown as ConversationScope
        activeScope = nextScope
        activeScopeId = nextScope.id
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

    // Capture and validate attachments before clearing visible composer state.
    const currentAttachments = filterAttachmentsForComposedAgentInput(content, [...attachments])
    const { filePool } = get()
    const composedInput = await buildComposedAgentInputWithDiagnostics({
      content,
      attachments: currentAttachments,
      filePool,
    })
    if (composedInput.diagnostics.inputFailedCount > 0) {
      const firstFailure = composedInput.diagnostics.inputFailures[0]
      const friendly = mapBackendErrorToFriendly({
        error: firstFailure?.reason || 'attachment input failed',
        errorKind: 'attachment_unavailable',
      })
      emitRendererAgentMetric('renderer_attachment_input_failed', {
        scopeId: activeScopeId,
        agent: currentAgent,
        failedCount: composedInput.diagnostics.inputFailedCount,
      })
      emitRendererAgentMetric('renderer_friendly_error_surfaced', {
        scopeId: activeScopeId,
        agent: currentAgent,
        errorKind: 'attachment_unavailable',
      })
      addMessage({
        id: `error-${Date.now()}`,
        agent: currentAgent,
        content: friendly.friendlyMessage,
        type: 'system',
        timestamp: new Date(),
      })
      return {
        success: false,
        shouldClearInput: false,
        preserveInput: true,
        errorKind: 'attachment_unavailable',
      }
    }
    set((state) => ({
      attachments: [],
      filePool: state.filePool.filter((attachment) => attachment.source !== 'document-quote'),
    }))

    // Build display content (include @[filename] references)
    const userMsgId = generateId('msg')
    const userTimestamp = new Date()
    addMessage({
      id: userMsgId,
      agent: currentAgent,
      content,
      type: 'user',
      timestamp: userTimestamp,
      attachments: currentAttachments.length > 0 ? [...currentAttachments] : undefined
    })

    const persistedAttachments = serializeAttachments(currentAttachments)
    const userMessageMeta = {
      sourceKind: activeScope.sourceKind,
      sourceId: activeScope.sourceId,
      threadKey: activeScope.threadKey,
      direction: 'local-input',
      attachments: persistedAttachments.length > 0 ? persistedAttachments : undefined,
    }

    if ((activeScope.title === '新对话' || activeScope.title === '未命名会话') && typeof window !== 'undefined' && window.electronAPI?.chat) {
      const firstAttachmentName = currentAttachments[0]?.name
      const title = content.slice(0, 20) || (firstAttachmentName ? `附件: ${firstAttachmentName}` : '新对话')
      if (title) {
        void window.electronAPI.chat.updateConversationTitle({ id: activeScopeId, title }).catch(() => undefined)
        const nextScope = { ...activeScope, title, updatedAt: new Date().toISOString() }
        set((state) => {
          const scopes = state.scopes.map((item) => item.id === activeScopeId ? nextScope : item)
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
        await persistChatMessage(activeScopeId, userMsgId, 'user', content, userMessageMeta)
        const responseId = generateId('response')
        addMessage({
          id: responseId,
          agent: currentAgent,
          content: commandResult.text,
          type: commandResult.isError ? 'system' : 'agent',
          timestamp: new Date(),
        })
        persistChatMessage(scopeId, responseId, 'assistant', commandResult.text)
        return { success: true, shouldClearInput: true, preserveInput: false }
      }
    }

    const activeRunBeforeNewSend = getActiveScopeRunState(get().scopeRunStates, activeScopeId)
    const shouldKillForegroundRun = activeRunBeforeNewSend
      ? isForegroundBusyScopeRunState(activeRunBeforeNewSend)
      : get().isStreaming
    if (typeof window !== 'undefined' && window.electronAPI && shouldKillForegroundRun) {
      await window.electronAPI.agent.kill(currentAgent, activeScopeId).catch(console.error)
    }

    setIsStreaming(true)
    const requestId = generateId('req')

    const responseId = generateId('response')
    addMessage({
      id: responseId,
      agent: currentAgent,
      content: '',
      type: 'agent',
      timestamp: new Date(),
      meta: { transient: true },
    })
    set((state) => ({
      streamingMessageId: responseId,
      streamingRequestId: requestId,
      toolTrace: [],
      toolTraceStatus: 'running',
      scopeRunStates: {
        ...state.scopeRunStates,
        [activeScopeId]: {
          ...createEmptyScopeRunState({
            scopeId: activeScopeId,
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
        const finalMessage = composedInput.message

        const sendWithCurrentScope = async (): Promise<AgentSendResult> => (
          window.electronAPI.agent.sendScoped
            ? window.electronAPI.agent.sendScoped({
              scopeId: activeScopeId,
              agent: activeScope.agent,
              message: finalMessage,
              requestId,
              userMessage: {
                id: userMsgId,
                content,
                timestamp: userTimestamp.toISOString(),
                meta: userMessageMeta,
                attachmentConfirmation: {
                  selectedCount: currentAttachments.length,
                  metadataCount: persistedAttachments.length,
                  inputIncludedCount: composedInput.diagnostics.inputIncludedCount,
                  inputFailedCount: composedInput.diagnostics.inputFailedCount,
                },
              },
              continuationIntent: pendingContinuationIntent || undefined,
            })
            : window.electronAPI.agent.send(currentAgent, finalMessage, activeScopeId, requestId)
        )

        let result = await sendWithCurrentScope()
        if (
          !result.success &&
          activeScope.sourceKind === 'local' &&
          /Conversation scope not found:/i.test(String(result.error || ''))
        ) {
          await persistLocalConversationScope(activeScope)
          if (window.electronAPI.agent.createLocalScope) {
            const recovered = await window.electronAPI.agent.createLocalScope(activeScope.agent, activeScope.id).catch(() => null)
            if (recovered?.success && recovered.data) {
              const nextScope = recovered.data as unknown as ConversationScope
              activeScope = nextScope
              activeScopeId = nextScope.id
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
          result = await sendWithCurrentScope()
        }

        if (!result.success) {
          if (get().streamingRequestId !== requestId) {
            return { success: false, shouldClearInput: false, preserveInput: true, errorKind: result.errorKind || 'stale_request' }
          }
          const friendly = mapBackendErrorToFriendly({
            error: result.error || '发送失败',
            errorKind: result.errorKind || undefined,
          })
          emitRendererAgentMetric('renderer_send_persistence_failed', {
            scopeId: activeScopeId,
            agent: currentAgent,
            errorKind: result.errorKind || 'unknown',
            messageStatus: result.persistence?.message || null,
            attachmentStatus: result.persistence?.attachments || null,
          })
          emitRendererAgentMetric('renderer_friendly_error_surfaced', {
            scopeId: activeScopeId,
            agent: currentAgent,
            errorKind: result.errorKind || 'unknown',
          })
          set((state) => ({
            messages: state.messages.map(m =>
              m.id === responseId
                ? { ...m, content: friendly.friendlyMessage, type: 'system' as const }
                : m
            ),
            attachments: result.persistence?.message === 'failed' ? currentAttachments : state.attachments,
            isStreaming: false,
            foregroundBusy: false,
            composerLocked: false,
            streamingMessageId: null,
            streamingRequestId: null,
            scopeRunStates: {
              ...state.scopeRunStates,
              [activeScopeId]: {
                ...(state.scopeRunStates[activeScopeId] || {
                  scopeId: activeScopeId,
                  agent: currentAgent,
                  requestId,
                  toolTrace: [],
                  startedAt: new Date().toISOString(),
                }),
                requestId,
                phase: 'error',
                updatedAt: new Date().toISOString(),
                error: friendly.friendlyMessage,
              },
            },
            toolTraceStatus: 'error',
          }))
          const preserveInput = result.persistence?.message !== 'persisted'
          return {
            success: false,
            shouldClearInput: !preserveInput,
            preserveInput,
            errorKind: result.errorKind || 'unknown',
          }
        }
        set({ pendingContinuationIntent: null })
        // Stream data arrives via onStream listener
        // Persistence of assistant message happens in onStream 'done' handler
        return { success: true, shouldClearInput: true, preserveInput: false }
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
              set({
                isStreaming: false,
                foregroundBusy: false,
                composerLocked: false,
                streamingMessageId: null,
                streamingRequestId: null,
              })
            }
          }
        }, 30)
        return { success: true, shouldClearInput: true, preserveInput: false }
      }
    } catch (error) {
      if (get().streamingRequestId !== requestId) {
        return { success: false, shouldClearInput: false, preserveInput: true, errorKind: 'stale_request' }
      }
      const rawError = error instanceof Error ? error.message : String(error)
      const friendly = mapBackendErrorToFriendly({ error: rawError })
      emitRendererAgentMetric('renderer_friendly_error_surfaced', {
        scopeId: activeScopeId,
        agent: currentAgent,
        errorKind: 'unknown',
      })
      set((state) => ({
        messages: state.messages.map(m =>
          m.id === responseId
            ? { ...m, content: friendly.friendlyMessage, type: 'system' as const }
            : m
        ),
        isStreaming: false,
        foregroundBusy: false,
        composerLocked: false,
        streamingMessageId: null,
        streamingRequestId: null,
        scopeRunStates: {
          ...state.scopeRunStates,
          [activeScopeId]: {
            ...(state.scopeRunStates[activeScopeId] || {
              scopeId: activeScopeId,
              agent: currentAgent,
              requestId,
              toolTrace: [],
              startedAt: new Date().toISOString(),
            }),
            requestId,
            phase: 'error',
            updatedAt: new Date().toISOString(),
            error: friendly.friendlyMessage,
          },
        },
        toolTraceStatus: 'error',
      }))
      return { success: false, shouldClearInput: false, preserveInput: true, errorKind: 'unknown' }
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
