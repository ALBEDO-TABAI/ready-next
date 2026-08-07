import { create } from 'zustand'
import {
  createEmptyScopeRunState,
  isForegroundBusyScopeRunState,
  isStreamingScopeRunState,
  phaseToToolTraceStatus,
} from '../modules/agent/scopeRunState'
import {
  buildComposedAgentInputWithDiagnostics,
  filterAttachmentsForComposedAgentInput,
  resolveReferencedFilePoolAttachments,
  serializePersistedAttachments as serializeAttachments,
} from '../modules/agent/messageComposer'
import { mapBackendErrorToFriendly } from '../modules/agent/error-message-mapping'
import { emitRendererAgentMetric } from '../modules/agent/rendererMetrics'
import { createAgentRuntimeDriver } from '../modules/agent/runtimeDriver'
import { installAgentPanelTestHarness } from '../modules/agent/agentPanelTestHarness'
import {
  mapSendScopedResponseToMessageResult,
  type IngressAdmittedEvent,
  type PrePersistenceErrorKind,
  type SendMessageResult,
  type TerminalErrorKind,
} from '../../shared/ipc-contracts/agent-runtime'

import type {
  Agent,
  AgentMessage,
  AskUserQuestionsCardState,
  AttachmentPreviewState,
  ChatAttachment,
  ChatConversation,
  ConversationScope,
  ScopeRunState,
  ToolTraceEvent,
} from '../modules/agent/types'
import type { AgentSendResult, AgentState, SessionSlice } from './agent-store-types'
import type { AgentPersonalityListItem, AgentRegistryListItem } from './agent-store-helpers'
import {
  activeSessionKey,
  cloneFallbackAgents,
  generateId,
  generateSessionId,
  getScopeRunStateForScope,
  isLiveSession,
  isSameAttachmentPoolEntry,
  lookupSessionByConversation,
  makeEmptySessionSlice,
  mapPersonalitiesToAgents,
  mapRegistryToAgents,
  mapScopeToConversation,
  mirrorFromSessionSlice,
  normalizeSessionSlice,
  rebuildAgentMessageFromRow,
  recordCardFallback,
  recordOrphanedCard,
  removeFromFilePool,
  routeCardToSession,
  sessionKeyForScopeId,
  shouldKeepInFilePool,
  shouldPreserveContinuationIntent,
  withActiveSessionMessagesMirror,
  withSessionSlice,
  withSessionSliceAndActiveMirror,
} from './agent-store-helpers'

export type {
  Agent,
  AgentArtifact,
  AgentMessage,
  AskUserQuestionsCardState,
  AttachmentPreviewState,
  ChatAttachment,
  ChatConversation,
  ConversationScope,
  ScopeRunState,
  ToolTraceEvent,
} from '../modules/agent/types'

// 纯移动拆分接线（2026-07-05）：以下符号已整块搬至 ./agent-store-types 与
// ./agent-store-helpers，此处显式转出以保持 useAgent 的对外导出面零变化。
export type {
  PendingContinuationIntent,
  SendMessageResult,
  SessionSlice,
  SessionSliceState,
} from './agent-store-types'
export type { CardRoutingDecision } from './agent-store-helpers'
export {
  __getCardRoutingMetricsForTesting,
  __resetCardRoutingMetricsForTesting,
  getSessionSlice,
  isLiveSession,
  lookupSessionByConversation,
  routeCardToSession,
  selectActiveScopeRunStates,
  selectActiveSessionSlice,
  selectAgents,
  selectAttachments,
  selectConversations,
  selectFilePool,
  selectScopes,
  selectSessionOrder,
} from './agent-store-helpers'

type PendingIngressSnapshot = {
  requestId: string
  scopeId: string
  userMessageId: string
  responseMessageId: string
  agent: string
  content: string
  timestamp: Date
  attachments: ChatAttachment[]
}

const pendingIngressSnapshots = new Map<string, PendingIngressSnapshot>()

function rejectedMessageResult(errorKind: PrePersistenceErrorKind): SendMessageResult {
  return {
    success: false,
    disposition: 'rejected_before_persistence',
    shouldClearInput: false,
    preserveInput: true,
    errorKind,
  }
}

function hasUnresolvedLifecycleUncertainty(slice: SessionSlice): boolean {
  return slice.lifecycleError?.code === 'interrupt_state_unknown'
    || slice.lifecycleError?.code === 'compaction_state_unknown'
}

function terminalReasonFromSendError(
  errorKind: TerminalErrorKind,
): ScopeRunState['terminalReason'] {
  switch (errorKind) {
    case 'superseded':
      return 'cancelled_runtime'
    case 'circuit_break':
    case 'unknown':
      return 'infra_error'
    default:
      return errorKind
  }
}

function commitPersistedIngressSnapshot(input: {
  requestId: string
  scopeId: string
  originUserMessageId: string
  admittedAt: string
}): boolean {
  const pending = pendingIngressSnapshots.get(input.requestId)
  if (
    !pending
    || pending.scopeId !== input.scopeId
    || pending.userMessageId !== input.originUserMessageId
  ) return false
  const currentState = useAgent.getState()
  const sessionKey = sessionKeyForScopeId(currentState, pending.scopeId)
  if (
    !currentState.sessions[sessionKey]
    || !isLiveSession(currentState, sessionKey)
    || normalizeSessionSlice(currentState.sessions[sessionKey]).conversationId !== pending.scopeId
  ) {
    pendingIngressSnapshots.delete(input.requestId)
    return false
  }
  pendingIngressSnapshots.delete(input.requestId)

  useAgent.setState((state) => {
    const slice = normalizeSessionSlice(state.sessions[sessionKey])
    const originIsActive = activeSessionKey(state) === sessionKey
    const userMessage: AgentMessage = {
      id: pending.userMessageId,
      agent: pending.agent,
      content: pending.content,
      type: 'user',
      timestamp: pending.timestamp,
      attachments: pending.attachments.length > 0 ? pending.attachments : undefined,
    }
    const responseMessage: AgentMessage = {
      id: pending.responseMessageId,
      agent: pending.agent,
      content: '',
      type: 'agent',
      timestamp: new Date(input.admittedAt),
      meta: { transient: true, runId: pending.requestId, scopeId: pending.scopeId },
    }
    const messages = [
      ...slice.messages.filter((message) => (
        message.id !== pending.userMessageId && message.id !== pending.responseMessageId
      )),
      userMessage,
      responseMessage,
    ]
    const shouldClearComposer = slice.inputValue.trim() === pending.content.trim()
    const next = withSessionSliceAndActiveMirror(state, sessionKey, {
      messages,
      inputValue: shouldClearComposer ? '' : slice.inputValue,
      streamingMessageId: pending.responseMessageId,
      streamingRequestId: pending.requestId,
      isStreaming: true,
      foregroundBusy: true,
      composerLocked: true,
      state: 'live',
      scopeRunStates: {
        ...slice.scopeRunStates,
        [pending.scopeId]: {
          ...createEmptyScopeRunState({
            scopeId: pending.scopeId,
            agent: pending.agent,
            requestId: pending.requestId,
            phase: 'planning',
            responseMessageId: pending.responseMessageId,
          }),
          startedAt: input.admittedAt,
          updatedAt: input.admittedAt,
        },
      },
    })
    return {
      ...next,
      ...(originIsActive
        ? {
            attachments: state.attachments.filter((attachment) => (
              !pending.attachments.some((candidate) => candidate.id === attachment.id)
            )),
            pendingContinuationIntent: null,
            pendingContinuationDraftAnchor: null,
          }
        : {}),
    }
  })

  const state = useAgent.getState()
  const scope = state.scopes.find((candidate) => candidate.id === pending.scopeId) || null
  if (scope && (scope.title === '新对话' || scope.title === '未命名会话')) {
    const title = pending.content.slice(0, 20)
      || (pending.attachments[0]?.name ? `附件: ${pending.attachments[0].name}` : '新对话')
    const nextScope = { ...scope, title, updatedAt: input.admittedAt }
    useAgent.setState((current) => {
      const scopes = current.scopes.map((candidate) => (
        candidate.id === pending.scopeId ? nextScope : candidate
      ))
      return {
        currentScope: current.currentScopeId === pending.scopeId ? nextScope : current.currentScope,
        scopes,
        conversations: scopes.map(mapScopeToConversation),
      }
    })
    void window.electronAPI?.chat?.updateConversationTitle({ id: pending.scopeId, title })
      .catch(() => undefined)
  }

  agentRuntimeDriver.armInfrastructureWatchdog(pending.scopeId, pending.requestId)
  return true
}

export function applyIngressAdmitted(event: IngressAdmittedEvent): boolean {
  return commitPersistedIngressSnapshot(event)
}

export const useAgent = create<AgentState>((set, get) => ({
  agents: cloneFallbackAgents(),
  scopeLiveMessages: {},
  appendScopeLiveMessage: (scopeId, message) => set((state) => {
    const existing = state.scopeLiveMessages[scopeId] || []
    if (existing.some((item) => item.id === message.id)) return {}
    return { scopeLiveMessages: { ...state.scopeLiveMessages, [scopeId]: [...existing, message] } }
  }),
  appendToScopeLiveMessage: (scopeId, messageId, chunk) => set((state) => {
    const existing = state.scopeLiveMessages[scopeId]
    if (!existing) return {}
    let touched = false
    const next = existing.map((item) => {
      if (item.id !== messageId) return item
      touched = true
      return { ...item, content: `${item.content}${chunk}` }
    })
    return touched ? { scopeLiveMessages: { ...state.scopeLiveMessages, [scopeId]: next } } : {}
  }),
  pruneScopeLiveMessages: (scopeId, persistedIds) => set((state) => {
    const existing = state.scopeLiveMessages[scopeId]
    if (!existing || existing.length === 0) return {}
    const drop = new Set(persistedIds)
    const next = existing.filter((item) => !drop.has(item.id))
    if (next.length === existing.length) return {}
    return { scopeLiveMessages: { ...state.scopeLiveMessages, [scopeId]: next } }
  }),
  messages: [],
  currentAgent: 'butler',
  inputValue: '',
  pendingContinuationIntent: null,
  pendingContinuationDraftAnchor: null,
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
  // V3.3a bootstrap — sessions Record + activeSessionId top-level fields.
  // The slice store starts empty; the first coalescing write seeds the
  // entry for the active session key (derived from `sessionId`).
  sessions: {},
  activeSessionId: null,
  // V3.4a — sessionOrder seeds empty; SessionTabs renders nothing in the
  // cold-start state, keeping the V6 fixture (chat-panel-baseline) at 4/4.
  sessionOrder: [],
  taskDisclosureState: {},

  setAgents: (agents) => set({ agents }),

  reloadAgents: async () => {
    const previousState = get()
    let registryAgents: AgentRegistryListItem[] = []
    let personalities: AgentPersonalityListItem[] = []
    try {
      const api = typeof window !== 'undefined' ? window.electronAPI?.agent : undefined
      const result = await api?.listRegistry?.()
      if (result?.success && Array.isArray(result.data)) {
        registryAgents = result.data
      }
    } catch {
      // silent-catch: registry IPC failure degrades to an empty list until the next registry-changed reload
      registryAgents = []
    }

    if (registryAgents.length === 0) {
      try {
        const api = typeof window !== 'undefined' ? window.electronAPI?.agentPersonality : undefined
        const result = await api?.list?.()
      if (result?.success && Array.isArray(result.data)) {
        personalities = result.data
      }
      } catch {
        // silent-catch: agent personalities are optional; fall back to built-in agents if the bridge is unavailable.
        personalities = []
      }
    }

    const { agents, currentAgent } = registryAgents.length > 0
      ? mapRegistryToAgents(registryAgents, previousState.agents, previousState.currentAgent)
      : mapPersonalitiesToAgents(personalities, previousState.agents, previousState.currentAgent)
    set({ agents, currentAgent })
  },

  selectAgent: (name) => set({ currentAgent: name }),

  toggleAgentSelection: (name) => set((state) => ({
    agents: state.agents.map(a =>
      a.name === name ? { ...a, selected: !a.selected } : a
    )
  })),

  addMessage: (message) => set((state) => (
    withActiveSessionMessagesMirror(state, [...state.messages, message])
  )),

  appendToMessage: (id, chunk) => set((state) => (
    withActiveSessionMessagesMirror(state, state.messages.map(m =>
      m.id === id ? { ...m, content: m.content + chunk } : m
    ))
  )),

  setInputValue: (value, options) => set((state) => {
    const preserveContinuation = shouldPreserveContinuationIntent({
      preserveRequested: options?.preserveContinuationIntent,
      pendingIntent: state.pendingContinuationIntent,
      draftAnchor: state.pendingContinuationDraftAnchor,
      nextValue: value,
    })
    // V3.3b.1 — write per-session slice (source of truth) and mirror to the
    // top-level `inputValue` so existing ChatPanel/ChatInput consumers see
    // the same value until their selector migration lands in V3.3b.X.
    const sessionKey = activeSessionKey(state)
    const slicePatch = withSessionSlice(state, sessionKey, { inputValue: value })
    return {
      ...slicePatch,
      inputValue: value,
      pendingContinuationIntent: preserveContinuation ? state.pendingContinuationIntent : null,
      pendingContinuationDraftAnchor: preserveContinuation ? state.pendingContinuationDraftAnchor : null,
    }
  }),

  setComposerDraft: (value, continuationIntent) => set((state) => ({
    ...withSessionSlice(state, activeSessionKey(state), { inputValue: value }),
    inputValue: value,
    pendingContinuationIntent: continuationIntent || null,
    pendingContinuationDraftAnchor: continuationIntent ? value : null,
  })),

  clearPendingContinuationIntent: () => set({
    pendingContinuationIntent: null,
    pendingContinuationDraftAnchor: null,
  }),

  setIsStreaming: (streaming) => set((state) => withSessionSliceAndActiveMirror(
    state,
    activeSessionKey(state),
    {
      isStreaming: streaming,
      foregroundBusy: streaming,
      composerLocked: streaming,
    },
  )),

  setActiveAttachmentPreview: (preview) => set({ activeAttachmentPreview: preview }),

  setTaskSectionExpanded: (taskKey, sectionKey, expanded) => set((state) => {
    const sessionKey = activeSessionKey(state)
    const slice = normalizeSessionSlice(state.sessions[sessionKey])
    return withSessionSliceAndActiveMirror(state, sessionKey, {
      taskDisclosureState: {
        ...slice.taskDisclosureState,
        [taskKey]: {
          ...(slice.taskDisclosureState[taskKey] || {}),
          [sectionKey]: expanded,
        },
      },
    })
  }),

  toggleTaskSection: (taskKey, sectionKey) => set((state) => {
    const sessionKey = activeSessionKey(state)
    const slice = normalizeSessionSlice(state.sessions[sessionKey])
    const currentValue = Boolean(slice.taskDisclosureState[taskKey]?.[sectionKey])
    return withSessionSliceAndActiveMirror(state, sessionKey, {
      taskDisclosureState: {
        ...slice.taskDisclosureState,
        [taskKey]: {
          ...(slice.taskDisclosureState[taskKey] || {}),
          [sectionKey]: !currentValue,
        },
      },
    })
  }),

  // Session tab actions commit only after the matching Main lifecycle promise.

  setActiveSessionId: (id) => set((state) => {
    // Defensive: a tab strip click should only ever target a session that
    // currently exists in sessionOrder. If the id is unknown (e.g. it was
    // closed concurrently), do nothing — the SessionTabs renderer will
    // re-render with the up-to-date list on the next frame.
    if (!state.sessionOrder.includes(id)) return state
    const slice = normalizeSessionSlice(state.sessions[id])
    return {
      activeSessionId: id,
      ...mirrorFromSessionSlice(state, slice),
    }
  }),

  createNewSession: async () => {
    const api = typeof window !== 'undefined' ? window.electronAPI?.agent : null
    if (!api?.createSession) throw new Error('agent_create_session_unavailable')
    const result = await api.createSession()
    if (!result.ok) return result

    const state = get()
    const id = generateSessionId()
    const scope: ConversationScope = {
      id: result.aliasId,
      aliasGeneration: result.aliasGeneration,
      agent: state.currentAgent,
      activeAgentId: state.currentAgent,
      handoffGeneration: 0,
      title: '新对话',
      sourceKind: 'local',
      sourceId: 'app',
      threadKey: result.aliasId,
      meta: { sourceLabel: '应用内', createdBy: 'app' },
      createdAt: result.persistedAt,
      updatedAt: result.persistedAt,
      lastMessageAt: null,
    }
    const slice: SessionSlice = {
      ...makeEmptySessionSlice(result.aliasId),
      aliasGeneration: result.aliasGeneration,
    }
    const scopes = [scope, ...state.scopes.filter((candidate) => candidate.id !== scope.id)]
    set({
      sessions: { ...state.sessions, [id]: slice },
      sessionOrder: [...state.sessionOrder, id],
      activeSessionId: id,
      sessionId: id,
      scopes,
      conversations: scopes.map(mapScopeToConversation),
      ...mirrorFromSessionSlice({ ...state, scopes }, slice),
      attachments: [],
      pendingContinuationIntent: null,
      pendingContinuationDraftAnchor: null,
      toolTrace: [],
      toolTraceStatus: 'idle',
    })
    return result
  },

  closeSession: async (id) => {
    const state = get()
    if (!state.sessionOrder.includes(id)) throw new Error('session_not_found')
    const slice = normalizeSessionSlice(state.sessions[id])
    const aliasId = slice.conversationId
    if (
      !aliasId
      || slice.aliasGeneration === null
      || !window.electronAPI?.agent?.closeSession
    ) throw new Error('alias_not_bound')
    if (slice.lifecyclePendingAction) throw new Error('lifecycle_action_pending')
    if (hasUnresolvedLifecycleUncertainty(slice)) throw new Error('lifecycle_reconciliation_required')
    set((current) => withSessionSliceAndActiveMirror(current, id, {
      lifecyclePendingAction: 'closing',
      lifecycleError: null,
    }))
    let result: Awaited<ReturnType<typeof window.electronAPI.agent.closeSession>>
    try {
      result = await window.electronAPI.agent.closeSession({
        aliasId,
        aliasGeneration: slice.aliasGeneration,
      })
    } catch (error) {
      set((current) => withSessionSliceAndActiveMirror(current, id, {
        lifecyclePendingAction: null,
      }))
      throw error
    }
    if (!result.ok) {
      set((current) => withSessionSliceAndActiveMirror(current, id, {
        lifecyclePendingAction: null,
        lifecycleError: result,
      }))
      return result
    }
    if (result.action !== 'close') {
      set((current) => withSessionSliceAndActiveMirror(current, id, {
        lifecyclePendingAction: null,
      }))
      throw new Error('lifecycle_result_action_mismatch')
    }

    set((current) => {
      const nextOrder = current.sessionOrder.filter((entry) => entry !== id)
      const nextSessions = { ...current.sessions }
      delete nextSessions[id]
      const nextActiveId = current.activeSessionId === id
        ? (nextOrder[0] ?? null)
        : current.activeSessionId
      const nextSlice = nextActiveId ? normalizeSessionSlice(nextSessions[nextActiveId]) : null
      return {
        sessions: nextSessions,
        sessionOrder: nextOrder,
        activeSessionId: nextActiveId,
        sessionId: nextActiveId ?? current.sessionId,
        ...(nextSlice
          ? mirrorFromSessionSlice(current, nextSlice)
          : mirrorFromSessionSlice(current, makeEmptySessionSlice())),
      }
    })
    return result
  },

  clearToolTrace: () => set((state) => {
    const scopeId = state.currentScopeId
    if (!scopeId) {
      return { toolTrace: [], toolTraceStatus: 'idle' }
    }
    const sessionKey = sessionKeyForScopeId(state, scopeId)
    const slice = normalizeSessionSlice(state.sessions[sessionKey])
    const currentRun = slice.scopeRunStates[scopeId]
    return withSessionSliceAndActiveMirror(state, sessionKey, {
      scopeRunStates: {
        ...slice.scopeRunStates,
        [scopeId]: currentRun
          ? { ...currentRun, toolTrace: [] }
          : createEmptyScopeRunState({ scopeId, agent: state.currentAgent }),
      },
    })
  }),

  dismissSoftError: (scopeId: string) => set((state) => {
    const sessionKey = sessionKeyForScopeId(state, scopeId)
    const slice = normalizeSessionSlice(state.sessions[sessionKey])
    const currentRun = slice.scopeRunStates[scopeId]
    if (!currentRun || !currentRun.softError) return state
    return withSessionSliceAndActiveMirror(state, sessionKey, {
      scopeRunStates: {
        ...slice.scopeRunStates,
        [scopeId]: { ...currentRun, softError: null },
      },
    })
  }),

  stopStreaming: async () => {
    const state = get()
    const aliasId = state.currentScopeId
    if (!aliasId || !window.electronAPI?.agent?.kill) throw new Error('alias_not_bound')
    const sessionKey = sessionKeyForScopeId(state, aliasId)
    const slice = normalizeSessionSlice(state.sessions[sessionKey])
    if (slice.aliasGeneration === null) throw new Error('alias_not_bound')
    if (slice.lifecyclePendingAction) throw new Error('lifecycle_action_pending')
    if (hasUnresolvedLifecycleUncertainty(slice)) throw new Error('lifecycle_reconciliation_required')
    set((current) => withSessionSliceAndActiveMirror(current, sessionKey, {
      lifecyclePendingAction: 'stopping',
      lifecycleError: null,
    }))
    let result: Awaited<ReturnType<typeof window.electronAPI.agent.kill>>
    try {
      result = await window.electronAPI.agent.kill({
        aliasId,
        aliasGeneration: slice.aliasGeneration,
      })
    } catch (error) {
      set((current) => withSessionSliceAndActiveMirror(current, sessionKey, {
        lifecyclePendingAction: null,
      }))
      throw error
    }
    if (!result.ok) {
      set((current) => withSessionSliceAndActiveMirror(current, sessionKey, {
        lifecyclePendingAction: null,
        lifecycleError: result,
      }))
      return result
    }
    if (result.action !== 'stop') {
      set((current) => withSessionSliceAndActiveMirror(current, sessionKey, {
        lifecyclePendingAction: null,
      }))
      throw new Error('lifecycle_result_action_mismatch')
    }
    set((current) => withSessionSliceAndActiveMirror(current, sessionKey, {
      lifecyclePendingAction: null,
      lifecycleError: null,
      streamingMessageId: null,
      streamingRequestId: null,
      isStreaming: false,
      foregroundBusy: false,
      composerLocked: false,
    }))
    agentRuntimeDriver.clearInfrastructureWatchdog(aliasId, null)
    return result
  },

  resetCurrentConversation: async () => {
    const state = get()
    const aliasId = state.currentScopeId
    if (!aliasId || !window.electronAPI?.agent?.resetSession) throw new Error('alias_not_bound')
    const sessionKey = sessionKeyForScopeId(state, aliasId)
    const slice = normalizeSessionSlice(state.sessions[sessionKey])
    if (slice.aliasGeneration === null) throw new Error('alias_not_bound')
    if (slice.lifecyclePendingAction) throw new Error('lifecycle_action_pending')
    if (hasUnresolvedLifecycleUncertainty(slice)) throw new Error('lifecycle_reconciliation_required')
    set((current) => withSessionSliceAndActiveMirror(current, sessionKey, {
      lifecyclePendingAction: 'resetting',
      lifecycleError: null,
    }))
    let result: Awaited<ReturnType<typeof window.electronAPI.agent.resetSession>>
    try {
      result = await window.electronAPI.agent.resetSession({
        aliasId,
        aliasGeneration: slice.aliasGeneration,
      })
    } catch (error) {
      set((current) => withSessionSliceAndActiveMirror(current, sessionKey, {
        lifecyclePendingAction: null,
      }))
      throw error
    }
    if (!result.ok) {
      set((current) => withSessionSliceAndActiveMirror(current, sessionKey, {
        lifecyclePendingAction: null,
        lifecycleError: result,
      }))
      return result
    }
    if (result.action !== 'reset') {
      set((current) => withSessionSliceAndActiveMirror(current, sessionKey, {
        lifecyclePendingAction: null,
      }))
      throw new Error('lifecycle_result_action_mismatch')
    }
    set((current) => {
      const next = withSessionSliceAndActiveMirror(current, sessionKey, {
        ...makeEmptySessionSlice(aliasId),
        aliasGeneration: result.newGeneration,
      })
      return activeSessionKey(current) === sessionKey
        ? {
            ...next,
            attachments: [],
            pendingContinuationIntent: null,
            pendingContinuationDraftAnchor: null,
            toolTrace: [],
            toolTraceStatus: 'idle',
          }
        : next
    })
    return result
  },

  compactCurrentSession: async () => {
    const state = get()
    const aliasId = state.currentScopeId
    if (!aliasId || !window.electronAPI?.agent?.compactSession) throw new Error('alias_not_bound')
    const sessionKey = sessionKeyForScopeId(state, aliasId)
    const slice = normalizeSessionSlice(state.sessions[sessionKey])
    if (slice.aliasGeneration === null) throw new Error('alias_not_bound')
    if (slice.lifecyclePendingAction) throw new Error('lifecycle_action_pending')
    if (hasUnresolvedLifecycleUncertainty(slice)) throw new Error('lifecycle_reconciliation_required')
    set((current) => withSessionSliceAndActiveMirror(current, sessionKey, {
      lifecyclePendingAction: 'compacting',
      lifecycleError: null,
    }))
    let result: Awaited<ReturnType<typeof window.electronAPI.agent.compactSession>>
    try {
      result = await window.electronAPI.agent.compactSession({
        aliasId,
        aliasGeneration: slice.aliasGeneration,
      })
    } catch (error) {
      set((current) => withSessionSliceAndActiveMirror(current, sessionKey, {
        lifecyclePendingAction: null,
      }))
      throw error
    }
    if (result.ok && result.action !== 'manual_compact') {
      set((current) => withSessionSliceAndActiveMirror(current, sessionKey, {
        lifecyclePendingAction: null,
      }))
      throw new Error('lifecycle_result_action_mismatch')
    }
    set((current) => withSessionSliceAndActiveMirror(current, sessionKey, {
      lifecyclePendingAction: null,
      lifecycleError: result.ok ? null : result,
    }))
    return result
  },

  loadScopes: async () => {
    if (typeof window === 'undefined' || !window.electronAPI?.agent) return
    try {
      const { currentAgent } = get()
      const result = await window.electronAPI.agent.listConversationScopes(currentAgent)
      const scopes: ConversationScope[] = result.success && Array.isArray(result.data)
        ? result.data as unknown as ConversationScope[]
        : []
      if (scopes.length === 0) return
      const previousScopeId = get().currentScopeId
      const currentScope = scopes.find((scope) => scope.id === previousScopeId) || scopes[0] || null
      set((state) => {
        const nextSessions = { ...state.sessions }
        const nextOrder = [...state.sessionOrder]
        const sessionByScope = new Map<string, string>()
        for (const [sessionKey, sliceInput] of Object.entries(state.sessions)) {
          const conversationId = normalizeSessionSlice(sliceInput).conversationId
          if (conversationId) sessionByScope.set(conversationId, sessionKey)
        }
        for (const scope of scopes) {
          const sessionKey = sessionByScope.get(scope.id) || scope.id
          const slice = normalizeSessionSlice(nextSessions[sessionKey])
          nextSessions[sessionKey] = {
            ...slice,
            conversationId: scope.id,
            aliasGeneration: typeof scope.aliasGeneration === 'number'
              ? scope.aliasGeneration
              : null,
          }
          sessionByScope.set(scope.id, sessionKey)
          if (!nextOrder.includes(sessionKey)) nextOrder.push(sessionKey)
        }

        const sessionKey = currentScope
          ? (sessionByScope.get(currentScope.id) || activeSessionKey(state))
          : activeSessionKey(state)
        const slice = normalizeSessionSlice(nextSessions[sessionKey])
        const activeRunState = getScopeRunStateForScope({
          ...state,
          sessions: nextSessions,
        }, currentScope?.id || null)
        const nextScopeRunStates = currentScope?.id && activeRunState
          ? { ...slice.scopeRunStates, [currentScope.id]: activeRunState }
          : slice.scopeRunStates
        const nextSlice = {
          ...slice,
          conversationId: currentScope?.id || null,
          aliasGeneration: typeof currentScope?.aliasGeneration === 'number'
            ? currentScope.aliasGeneration
            : null,
          scopeRunStates: nextScopeRunStates,
          isStreaming: isStreamingScopeRunState(activeRunState),
          foregroundBusy: isForegroundBusyScopeRunState(activeRunState),
          composerLocked: isForegroundBusyScopeRunState(activeRunState),
          streamingRequestId: activeRunState?.requestId || null,
        }
        nextSessions[sessionKey] = nextSlice
        const stateWithScopes = { ...state, scopes }
        return {
          sessions: nextSessions,
          sessionOrder: nextOrder,
          activeSessionId: sessionKey,
          sessionId: sessionKey,
          ...mirrorFromSessionSlice(stateWithScopes, nextSlice),
          scopes,
          conversations: scopes.map(mapScopeToConversation),
          currentAgent: currentScope?.agent || get().currentAgent,
          pendingContinuationIntent: null,
          pendingContinuationDraftAnchor: null,
        }
      })
      const hasOnlyWelcomeMessages = get().messages.every((message) => /^welcome(?:-|$)/.test(message.id))
      if (
        currentScope?.id &&
        currentScope.lastMessageAt &&
        (previousScopeId !== currentScope.id || hasOnlyWelcomeMessages) &&
        typeof window.electronAPI.agent.getConversationScopeMessages === 'function'
      ) {
        await get().loadScope(currentScope.id)
      }
      await hydratePendingAskUserQuestionsCards()
    } catch { /* ignore */ }
  },

  loadScope: async (scopeId: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.agent) return
    try {
      const result = await window.electronAPI.agent.getConversationScopeMessages(scopeId)
      if (!result.success || !result.data) return
      const scopes = get().scopes
      const scope = scopes.find((item) => item.id === scopeId) || null
      const activeRunState = getScopeRunStateForScope(get(), scopeId)
      const messages: AgentMessage[] = result.data.map((m: { id: string; role: string; content: string; timestamp: string; meta?: Record<string, unknown> }) =>
        rebuildAgentMessageFromRow(m, scope?.agent || get().currentAgent),
      )
      const targetSessionKey = sessionKeyForScopeId(get(), scopeId)
      const currentMessages = normalizeSessionSlice(get().sessions[targetSessionKey]).messages
      const transientMessages = currentMessages.filter((message) =>
        message.meta?.transient &&
        !messages.some((persisted) => persisted.id === message.id),
      )
      if (transientMessages.length > 0) {
        messages.push(...transientMessages)
      }
      // EP2 P0-2 — merge the scope's live cache: segments streamed while this
      // scope was in the background are NOT in the DB yet; without this the
      // DB-only load makes them vanish until the run persists at terminal.
      const persistedIds = new Set(messages.map((item) => item.id))
      const liveCached = (get().scopeLiveMessages[scopeId] || []).filter((item) => !persistedIds.has(item.id))
      if (liveCached.length > 0) {
        messages.push(...liveCached)
      }
      if (transientMessages.length > 0 || liveCached.length > 0) {
        messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      }
      // prune cache entries the DB already covers (terminal persistence done)
      get().pruneScopeLiveMessages(scopeId, [...persistedIds])
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
      set((state) => {
        const sessionKey = sessionKeyForScopeId(state, scopeId)
        const slice = normalizeSessionSlice(state.sessions[sessionKey])
        const nextScopeRunStates = activeRunState
          ? { ...slice.scopeRunStates, [scopeId]: activeRunState }
          : slice.scopeRunStates
        const nextSlice: SessionSlice = {
          ...slice,
          messages,
          conversationId: scopeId,
          aliasGeneration: typeof scope?.aliasGeneration === 'number'
            ? scope.aliasGeneration
            : null,
          scopeRunStates: nextScopeRunStates,
          isStreaming: isStreamingScopeRunState(activeRunState),
          foregroundBusy: isForegroundBusyScopeRunState(activeRunState),
          composerLocked: isForegroundBusyScopeRunState(activeRunState),
          streamingMessageId: null,
          streamingRequestId: activeRunState?.requestId || null,
        }
        return {
          sessions: { ...state.sessions, [sessionKey]: nextSlice },
          activeSessionId: sessionKey,
          sessionId: sessionKey,
          ...mirrorFromSessionSlice(state, nextSlice),
          currentScope: scope,
          currentAgent: scope?.agent || get().currentAgent,
          attachments: [],
          filePool: [],
          pendingContinuationIntent: null,
          pendingContinuationDraftAnchor: null,
        }
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
    if (typeof window === 'undefined' || !window.electronAPI?.chat || !window.electronAPI.agent?.closeSession) {
      throw new Error('conversation_delete_unavailable')
    }
    const visibleSessionId = lookupSessionByConversation(get(), convId)
    if (!visibleSessionId) throw new Error('conversation_lifecycle_binding_unavailable')
    const closeResult = await get().closeSession(visibleSessionId)
    if (!closeResult.ok) throw new Error(closeResult.code)

    set((state) => {
      const scopes = state.scopes.filter((candidate) => candidate.id !== convId)
      return {
        conversations: state.conversations.filter((candidate) => candidate.id !== convId),
        scopes,
        currentScope: state.currentScope?.id === convId ? null : state.currentScope,
        currentScopeId: state.currentScopeId === convId ? null : state.currentScopeId,
        conversationId: state.conversationId === convId ? null : state.conversationId,
      }
    })
  },

  renameConversation: async (convId: string, title: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.chat) return
    const nextTitle = title.trim()
    if (!nextTitle) return
    try {
      await window.electronAPI.chat.updateConversationTitle({ id: convId, title: nextTitle })
      // DB bumps updated_at on rename (database.ts updateConversationTitle), so
      // mirror that here to keep the optimistic in-memory ordering in sync.
      const now = new Date().toISOString()
      const { scopes, currentScope } = get()
      const updatedScopes = scopes.map((scope) =>
        scope.id === convId ? { ...scope, title: nextTitle, updatedAt: now } : scope,
      )
      set({
        scopes: updatedScopes,
        currentScope: currentScope && currentScope.id === convId
          ? { ...currentScope, title: nextTitle, updatedAt: now }
          : currentScope,
        conversations: updatedScopes.map(mapScopeToConversation),
      })
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
      throw new Error('empty_input')
    }
    const {
      currentAgent,
      attachments,
      currentScope,
      currentScopeId,
      pendingContinuationIntent,
    } = get()

    if (pendingContinuationIntent) return rejectedMessageResult('conversation_reset_required')
    if (!currentScope || !currentScopeId) return rejectedMessageResult('scope_missing')
    if (currentScope.agent !== currentAgent) {
      return rejectedMessageResult('conversation_reset_required')
    }
    const originSessionKey = sessionKeyForScopeId(get(), currentScopeId)
    const originSlice = normalizeSessionSlice(get().sessions[originSessionKey])
    if (originSlice.lifecyclePendingAction) return rejectedMessageResult('thread_busy')
    if (hasUnresolvedLifecycleUncertainty(originSlice)) {
      return rejectedMessageResult('conversation_reset_required')
    }
    const activeAgentName = currentAgent
    const activeScope = currentScope
    const activeScopeId = currentScopeId

    // Capture and validate attachments before clearing visible composer state.
    const currentAttachments = filterAttachmentsForComposedAgentInput(content, [...attachments])
    const { filePool } = get()
    const composedInput = await buildComposedAgentInputWithDiagnostics({
      content,
      attachments: currentAttachments,
      filePool,
    })
    if (composedInput.diagnostics.inputFailedCount > 0) {
      emitRendererAgentMetric('renderer_attachment_input_failed', {
        scopeId: activeScopeId,
        agent: activeAgentName,
        failedCount: composedInput.diagnostics.inputFailedCount,
      })
      return rejectedMessageResult('attachment_unavailable')
    }

    const userMsgId = generateId('msg')
    const userTimestamp = new Date()

    const referencedPoolAttachments = resolveReferencedFilePoolAttachments(content, filePool)
    const messageAttachments = [...currentAttachments]
    for (const attachment of referencedPoolAttachments) {
      if (!messageAttachments.some((candidate) => isSameAttachmentPoolEntry(candidate, attachment))) {
        messageAttachments.push(attachment)
      }
    }
    const persistedAttachments = serializeAttachments(messageAttachments)
    const userMessageMeta = {
      sourceKind: activeScope.sourceKind,
      sourceId: activeScope.sourceId,
      threadKey: activeScope.threadKey,
      direction: 'local-input',
      attachments: persistedAttachments.length > 0 ? persistedAttachments : undefined,
    }

    const requestId = generateId('req')
    const responseId = generateId('response')
    pendingIngressSnapshots.set(requestId, {
      requestId,
      scopeId: activeScopeId,
      userMessageId: userMsgId,
      responseMessageId: responseId,
      agent: activeAgentName,
      content,
      timestamp: userTimestamp,
      attachments: currentAttachments,
    })

    try {
      if (typeof window === 'undefined' || !window.electronAPI?.agent?.sendScoped) {
        pendingIngressSnapshots.delete(requestId)
        return rejectedMessageResult('host_unavailable')
      }
        const finalMessage = composedInput.message
        const result: AgentSendResult = await window.electronAPI.agent.sendScoped({
          scopeId: activeScopeId,
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
        })

        if (
          pendingIngressSnapshots.has(requestId)
          && (result.disposition === 'terminal_success'
            || result.disposition === 'terminal_failure_after_persistence')
        ) {
          commitPersistedIngressSnapshot({
            requestId,
            scopeId: activeScopeId,
            originUserMessageId: userMsgId,
            admittedAt: userTimestamp.toISOString(),
          })
        }

        if (!result.success) {
          const mapped = mapSendScopedResponseToMessageResult(result)
          if (result.disposition !== 'terminal_failure_after_persistence') {
            pendingIngressSnapshots.delete(requestId)
            return mapped
          }
          agentRuntimeDriver.clearInfrastructureWatchdog(activeScopeId, requestId)
          const friendly = mapBackendErrorToFriendly({
            error: result.error,
            errorKind: result.errorKind,
          })
          set((state) => {
            const sessionKey = sessionKeyForScopeId(state, activeScopeId)
            const slice = normalizeSessionSlice(state.sessions[sessionKey])
            if (!state.sessions[sessionKey] || slice.conversationId !== activeScopeId) return {}
            const currentRun = slice.scopeRunStates[activeScopeId]
            const terminalReason = terminalReasonFromSendError(result.errorKind)
            return withSessionSliceAndActiveMirror(state, sessionKey, {
              messages: slice.messages.map((message) => (
                message.id === responseId
                  ? { ...message, content: friendly.friendlyMessage, type: 'system' as const }
                  : message
              )),
              isStreaming: false,
              foregroundBusy: false,
              composerLocked: false,
              streamingMessageId: null,
              streamingRequestId: null,
              scopeRunStates: currentRun
                ? {
                    ...slice.scopeRunStates,
                    [activeScopeId]: {
                      ...currentRun,
                      phase: terminalReason === 'checkpoint_budget'
                        ? 'checkpoint'
                        : terminalReason === 'cancelled_user'
                          || terminalReason === 'cancelled_runtime'
                          || terminalReason === 'main_no_progress_timeout'
                          ? 'cancelled'
                          : 'error',
                      terminalReason,
                      error: result.error,
                      updatedAt: new Date().toISOString(),
                    },
                  }
                : slice.scopeRunStates,
            })
          })
          return mapped
        }
        agentRuntimeDriver.completeScopeRunAfterSendSuccess(activeScopeId, requestId, {
          canonicalMessage: result.canonicalMessage,
          canonicalMessageDigest: result.canonicalMessageDigest,
        })
        return mapSendScopedResponseToMessageResult(result)
    } catch (error) {
      const admissionWasObserved = !pendingIngressSnapshots.has(requestId)
      pendingIngressSnapshots.delete(requestId)
      if (!admissionWasObserved) return rejectedMessageResult('host_unavailable')
      agentRuntimeDriver.clearInfrastructureWatchdog(activeScopeId, requestId)
      const friendly = mapBackendErrorToFriendly({
        error: error instanceof Error ? error.message : String(error),
        errorKind: 'unknown',
      })
      set((state) => {
        const sessionKey = sessionKeyForScopeId(state, activeScopeId)
        const slice = normalizeSessionSlice(state.sessions[sessionKey])
        if (!state.sessions[sessionKey] || slice.conversationId !== activeScopeId) return {}
        const currentRun = slice.scopeRunStates[activeScopeId]
        return withSessionSliceAndActiveMirror(state, sessionKey, {
          messages: slice.messages.map((message) => (
            message.id === responseId
              ? { ...message, content: friendly.friendlyMessage, type: 'system' as const }
              : message
          )),
          isStreaming: false,
          foregroundBusy: false,
          composerLocked: false,
          streamingMessageId: null,
          streamingRequestId: null,
          scopeRunStates: currentRun
            ? {
                ...slice.scopeRunStates,
                [activeScopeId]: {
                  ...currentRun,
                  phase: 'error',
                  terminalReason: 'infra_error',
                  error: error instanceof Error ? error.message : String(error),
                  updatedAt: new Date().toISOString(),
                },
              }
            : slice.scopeRunStates,
        })
      })
      return {
        success: false,
        disposition: 'terminal_failure_after_persistence',
        shouldClearInput: true,
        preserveInput: false,
        errorKind: 'unknown',
      }
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
installAgentPanelTestHarness(useAgent as unknown as Parameters<typeof installAgentPanelTestHarness>[0])

function makeMessageFromPushedCard(
  event: { cardId: string; sessionId: string | null; conversationId: string | null; questions: AskUserQuestionsCardState['questions']; askedAt: number },
  agent: string,
): AgentMessage {
  return {
    id: event.cardId,
    agent,
    content: `等待用户回答 ${event.questions.length} 个问题`,
    type: 'ask_user_questions',
    timestamp: new Date(event.askedAt || Date.now()),
    meta: {
      askUserQuestions: {
        cardId: event.cardId,
        status: 'pending',
        questions: event.questions,
        askedAt: event.askedAt,
      },
    },
    askUserQuestions: {
      cardId: event.cardId,
      status: 'pending',
      questions: event.questions,
      askedAt: event.askedAt,
    },
  }
}

function upsertAskUserCard(
  targetSessionId: string,
  event: {
    cardId: string
    conversationId: string | null
    questions: AskUserQuestionsCardState['questions']
    askedAt: number
  },
): void {
  const agent = useAgent.getState().currentAgent
  const message = makeMessageFromPushedCard({
    ...event,
    sessionId: targetSessionId,
  }, agent)

  useAgent.setState((prev) => {
    const existingSlice = prev.sessions[targetSessionId]
    if (
      existingSlice?.conversationId
      && event.conversationId
      && existingSlice.conversationId !== event.conversationId
    ) return {}

    const existingMessages = existingSlice?.messages ?? []
    const nextMessages = existingMessages.some((candidate) => candidate.id === message.id)
      ? existingMessages
      : [...existingMessages, message].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    const nextSlice: SessionSlice = existingSlice
      ? {
          ...existingSlice,
          messages: nextMessages,
          conversationId: existingSlice.conversationId ?? event.conversationId,
        }
      : {
          ...makeEmptySessionSlice(event.conversationId),
          messages: nextMessages,
        }
    const sessions = {
      ...prev.sessions,
      [targetSessionId]: nextSlice,
    }
    return targetSessionId === activeSessionKey(prev)
      ? { sessions, messages: nextMessages }
      : { sessions }
  })
}

export async function hydratePendingAskUserQuestionsCards(): Promise<void> {
  const api = typeof window !== 'undefined' ? window.electronAPI?.agentInteraction : null
  if (!api) return
  const result = await api.listPendingAskUserQuestions()
  if (!result || !result.success || !Array.isArray(result.data)) return
  for (const card of result.data) {
    const decision = routeCardToSession(useAgent.getState(), {
      sessionId: null,
      conversationId: card.conversationId,
      cardId: card.cardId,
    })
    if (!decision.targetSessionId) {
      recordOrphanedCard(card.cardId, decision.metric || 'pending-card-session-not-found')
      continue
    }
    if (decision.metric) recordCardFallback(card.cardId, decision.metric)
    upsertAskUserCard(decision.targetSessionId, {
      cardId: card.cardId,
      conversationId: card.conversationId,
      questions: card.questions as AskUserQuestionsCardState['questions'],
      askedAt: card.askedAt,
    })
  }
}

export function initAgentInteractionListeners(): () => void {
  const api = typeof window !== 'undefined' ? window.electronAPI?.agentInteraction : null
  if (!api) return () => {}
  // A true cold renderer starts with no session slices. `loadScopes` restores
  // every durable alias and then calls the same hydrator. Hot remounts already
  // have slices, so they can hydrate immediately.
  if (Object.keys(useAgent.getState().sessions).length > 0) {
    void hydratePendingAskUserQuestionsCards().catch(() => { /* ignore hydrate failures */ })
  }

  const unsubscribePush = api.onAskUserQuestionsCard((event) => {
    // Route by the durable conversation binding. Background-session cards
    // stay in that slice; conflicting identities never fall into the active
    // conversation.
    const decision = routeCardToSession(useAgent.getState(), {
      sessionId: event.sessionId,
      conversationId: event.conversationId,
      cardId: event.cardId,
    })
    if (!decision.targetSessionId) {
      recordOrphanedCard(event.cardId, decision.metric || 'ask-card-session-not-found')
      return
    }
    if (decision.metric) recordCardFallback(event.cardId, decision.metric)

    upsertAskUserCard(decision.targetSessionId, {
      cardId: event.cardId,
      conversationId: event.conversationId,
      questions: event.questions as AskUserQuestionsCardState['questions'],
      askedAt: event.askedAt,
    })
  })

  // Phase D D2（2026-07-05）：scopeRunEvent 的会话路由终态转移已迁入
  // runtimeDriver 单枢纽（renderer 每个 run 通道只允许一个订阅文件），
  // 本处不再并行订阅——双真相源收敛，行为逐字保留在枢纽侧。

  return () => {
    try { unsubscribePush() } catch { /* ignore */ }
  }
}

export function initAgentListeners(): () => void {
  void useAgent.getState().reloadAgents()
  const onAgentRegistryChanged = () => void useAgent.getState().reloadAgents()
  try {
    window.addEventListener('ready:agent-registry-changed', onAgentRegistryChanged)
  } catch {
    // silent-catch: ignore — tests may install a minimal global window.
  }
  const offRuntime = agentRuntimeDriver.initAgentListeners()
  const offAgentInteraction = initAgentInteractionListeners()
  const offIngressAdmitted = window.electronAPI?.agent?.onIngressAdmitted?.((event) => {
    applyIngressAdmitted(event)
  }) || (() => {})
  return () => {
    try { window.removeEventListener('ready:agent-registry-changed', onAgentRegistryChanged) } catch { /* ignore */ }
    try { offRuntime() } catch { /* ignore */ }
    try { offAgentInteraction() } catch { /* ignore */ }
    try { offIngressAdmitted() } catch { /* ignore */ }
  }
}

/**
 * Stage U (PR 1, B.2/B.4a) — fold an ask_user_questions card to the local
 * `cancelled` terminal state without going through IPC. Used when:
 *   - Submit returned `waiting_task_gone` (DB row missing): card is dead;
 *     show user the diagnostic reason instead of leaving it spinning.
 *   - Cancel returned `cancel_persist_failed` (DB write failed): in-memory
 *     Promise already rejected; UI must terminate so we don't keep showing
 *     pending. Boot sweep will clean up the DB residue.
 */
function foldCardLocallyToCancelled(cardId: string, cancelReason: string): void {
  const cancelledAt = Date.now()
  useAgent.setState((prev) => {
    const messages = prev.messages.map((m) => {
      if (m.id !== cardId || m.type !== 'ask_user_questions' || !m.askUserQuestions) return m
      return {
        ...m,
        askUserQuestions: {
          ...m.askUserQuestions,
          status: 'cancelled' as const,
          cancelReason,
          cancelledAt,
        },
      }
    })
    return withActiveSessionMessagesMirror(prev, messages)
  })
}

/**
 * Submit handler used by `AskUserQuestionsCard`. Pushes answers to main and
 * updates the local message state on success so the card immediately flips
 * to its collapsed view (no need to wait for a re-hydrate round-trip).
 */
export async function submitAskUserQuestionsAnswers(
  cardId: string,
  answers: Array<{ id: string; answer: string | string[] }>,
): Promise<{ success: boolean; error?: string }> {
  const api = window.electronAPI?.agentInteraction
  if (!api) return { success: false, error: 'agentInteraction API not available' }
  const result = await api.submitAskUserQuestions({ cardId, answers })
  const r = result as { success: boolean; error?: string; errorKind?: string }
  if (r.success) {
    const answeredAt = Date.now()
    useAgent.setState((prev) => {
      const messages = prev.messages.map((m) => {
        if (m.id !== cardId || m.type !== 'ask_user_questions' || !m.askUserQuestions) return m
        return {
          ...m,
          askUserQuestions: {
            ...m.askUserQuestions,
            status: 'submitted' as const,
            answers,
            answeredAt,
          },
        }
      })
      return withActiveSessionMessagesMirror(prev, messages)
    })
  } else if (r.errorKind === 'waiting_task_gone') {
    // PR 1 B.2 (row missing) — card row was swept; main has already
    // rejected the in-memory Promise. Fold UI to a diagnostic cancelled.
    foldCardLocallyToCancelled(cardId, 'card_row_missing')
  } else if (r.errorKind === 'card_resolver_missed') {
    // PR 1 B.3 — submit hit a resolver race; main rolled back the DB row.
    // Mirror it locally so the card immediately collapses.
    foldCardLocallyToCancelled(cardId, 'card_resolver_missed')
  }
  // 'persistence_failed' / 'input_validation' / 'overlapping_card' are
  // recoverable — keep UI pending so the user can retry / fix.
  return r
}

/**
 * Cancel handler used by `AskUserQuestionsCard`'s skip button (and by the
 * pre-send hook when the user types a new message while a card is pending).
 */
export async function cancelAskUserQuestionsCard(
  cardId: string,
  reason: string = 'user_cancelled',
): Promise<{ success: boolean; error?: string }> {
  const api = window.electronAPI?.agentInteraction
  if (!api) return { success: false, error: 'agentInteraction API not available' }
  const result = await api.cancelAskUserQuestions({ cardId, reason }) as {
    success: boolean
    error?: string
    errorKind?: string
  }
  if (result.success) {
    foldCardLocallyToCancelled(cardId, reason)
  } else if (result.errorKind === 'cancel_persist_failed') {
    // PR 1 B.4a — in-memory store.reject succeeded; only the DB write failed.
    // The model is already unblocked. UI must NOT keep showing pending — fold
    // locally with the diagnostic reason. Boot sweep will reconcile DB later.
    foldCardLocallyToCancelled(cardId, 'cancel_persist_failed')
  }
  return result
}
