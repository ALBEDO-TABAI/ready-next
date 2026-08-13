import { create } from 'zustand'
import {
  createEmptyScopeRunState,
  isForegroundBusyScopeRunState,
  isStreamingScopeRunState
} from '../modules/agent/scopeRunState'
import {
  buildCodexIngressInputWithDiagnostics,
  filterAttachmentsForComposedAgentInput,
  resolveReferencedFilePoolAttachments,
  serializePersistedAttachments as serializeAttachments,
} from '../modules/agent/messageComposer'
import { mapBackendErrorToFriendly } from '../modules/agent/error-message-mapping'
import { emitRendererAgentMetric } from '../modules/agent/rendererMetrics'
import { createAgentRuntimeDriver } from '../modules/agent/runtimeDriver'
import { installAgentRuntimeReadyHydration } from '../modules/agent/agent-runtime-ready'
import { installAgentPanelTestHarness } from '../modules/agent/agentPanelTestHarness'
import { buildCodexCurrentDocumentAnchor } from '../modules/agent/codexCurrentDocumentAnchor'
import {
  captureComposerAuthority,
  isComposerAuthorityCurrent,
} from '../modules/agent/composer-authority'
import { useMode } from './useMode'
import {
  mapSendScopedResponseToMessageResult,
  type IngressAdmittedEvent,
  type PrePersistenceErrorKind,
  type SendMessageResult,
  type TerminalErrorKind,
} from '../../shared/ipc-contracts/agent-runtime'
import type { LifecycleOperationProjection } from '../../shared/ipc-contracts/agent-lifecycle-snapshot'
import type { AgentRuntimeReadinessSnapshot } from '../../shared/ipc-contracts/agent-runtime-readiness'

import type {
  AgentMessage,
  AskUserQuestionsCardState, ChatAttachment, ConversationScope,
  ScopeRunState
} from '../modules/agent/types'
import type { AgentSendResult, AgentState, SessionSlice } from './agent-store-types'
import type { AgentRegistryListItem } from './agent-store-helpers'
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
import {
  parseActionAuthorizationMode,
  type ActionAuthorizationMode,
} from '../../shared/action-authorization-mode'

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
  originAliasGeneration: number | null
  originMessageVisibilityEpoch: number
  originSessionKey: string
}

const pendingIngressSnapshots = new Map<string, PendingIngressSnapshot>()
const actionAuthorizationModeRequestRevisions = new Map<string, number>()
let createSessionRequestRevision = 0
const sessionCreationsInFlight = new Set<Promise<void>>()

function beginSessionCreation(): () => void {
  let release!: () => void
  const completion = new Promise<void>((resolve) => { release = resolve })
  sessionCreationsInFlight.add(completion)
  return () => {
    sessionCreationsInFlight.delete(completion)
    release()
  }
}

function pendingIngressOriginMatches(
  state: AgentState,
  pending: Pick<
    PendingIngressSnapshot,
    'scopeId' | 'originAliasGeneration' | 'originMessageVisibilityEpoch' | 'originSessionKey'
  >,
): boolean {
  const slice = normalizeSessionSlice(state.sessions[pending.originSessionKey])
  return Boolean(
    state.sessions[pending.originSessionKey]
    && !state.retiredScopeIds[pending.scopeId]
    && slice.conversationId === pending.scopeId
    && slice.aliasGeneration === pending.originAliasGeneration
    && slice.messageVisibilityEpoch === pending.originMessageVisibilityEpoch,
  )
}

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

function canResetUnknownCompaction(slice: SessionSlice, aliasId: string): boolean {
  const error = slice.lifecycleError
  return error?.action === 'manual_compact'
    && error.code === 'compaction_state_unknown'
    && error.aliasId === aliasId
    && error.aliasGeneration === slice.aliasGeneration
}

type LifecycleHydrationFingerprint = {
  sessionKey: string
  aliasGeneration: number
  streamingRequestId: string | null
  lifecyclePendingAction: SessionSlice['lifecyclePendingAction']
  lifecycleErrorEvidence: string | null
  runRequestId: string | null
  runPhase: ScopeRunState['phase'] | null
  runUpdatedAt: string | null
}

function lifecycleHydrationFingerprint(
  state: AgentState,
  aliasId: string,
): LifecycleHydrationFingerprint | null {
  const sessionKey = sessionKeyForScopeId(state, aliasId)
  const slice = normalizeSessionSlice(state.sessions[sessionKey]) as SessionSlice
  if (slice.conversationId !== aliasId || slice.aliasGeneration === null) return null
  const run = slice.scopeRunStates[aliasId] || null
  return {
    sessionKey,
    aliasGeneration: slice.aliasGeneration,
    streamingRequestId: slice.streamingRequestId,
    lifecyclePendingAction: slice.lifecyclePendingAction,
    lifecycleErrorEvidence: slice.lifecycleError?.evidenceDigest || null,
    runRequestId: run?.requestId || null,
    runPhase: run?.phase || null,
    runUpdatedAt: run?.updatedAt || null,
  }
}

function lifecycleHydrationStillCurrent(
  state: AgentState,
  aliasId: string,
  baseline: LifecycleHydrationFingerprint,
): boolean {
  const current = lifecycleHydrationFingerprint(state, aliasId)
  return Boolean(current
    && current.sessionKey === baseline.sessionKey
    && current.aliasGeneration === baseline.aliasGeneration
    && current.streamingRequestId === baseline.streamingRequestId
    && current.lifecyclePendingAction === baseline.lifecyclePendingAction
    && current.lifecycleErrorEvidence === baseline.lifecycleErrorEvidence
    && current.runRequestId === baseline.runRequestId
    && current.runPhase === baseline.runPhase
    && current.runUpdatedAt === baseline.runUpdatedAt)
}

async function hydrateCodexLifecycleScope(scope: ConversationScope): Promise<void> {
  const api = typeof window !== 'undefined'
    ? window.electronAPI?.agent?.readCodexLifecycleSnapshot
    : null
  if (!api || typeof scope.aliasGeneration !== 'number') return
  const baseline = lifecycleHydrationFingerprint(useAgent.getState(), scope.id)
  if (!baseline || baseline.aliasGeneration !== scope.aliasGeneration) return
  let result: Awaited<ReturnType<typeof api>>
  try {
    result = await api({ aliasId: scope.id, aliasGeneration: scope.aliasGeneration })
  } catch {
    return
  }
  if (!result.success || !result.data) return
  const projection = result.data as LifecycleOperationProjection
  if (
    projection.identity.aliasId !== scope.id
    || projection.identity.aliasGeneration !== scope.aliasGeneration
    || projection.snapshot === 'invariant_violation'
  ) return
  const snapshotRunId = projection.activeReadyRunId || projection.latestReadyRunId
  if (
    baseline.streamingRequestId
    && projection.snapshot !== 'idle_never_started'
    && snapshotRunId !== baseline.streamingRequestId
  ) return

  useAgent.setState((state) => {
    if (!lifecycleHydrationStillCurrent(state, scope.id, baseline)) return state
    const sessionKey = baseline.sessionKey
    const slice = normalizeSessionSlice(state.sessions[sessionKey]) as SessionSlice
    const activeProduct = projection.activeReadyRunId && (
      projection.snapshot === 'thread_start_pending'
      || projection.snapshot === 'turn_start_pending'
      || projection.snapshot === 'product_turn_interruptible'
      || projection.snapshot === 'product_turn_interrupt_unknown'
      || projection.snapshot === 'product_turn_engine_terminal_closeout_pending'
      || projection.snapshot === 'host_failure_closeout_pending'
    )

    if (activeProduct) {
      const previousRun = slice.scopeRunStates[scope.id]
      const restoredRun = previousRun?.requestId === projection.activeReadyRunId
        ? previousRun
        : createEmptyScopeRunState({
            scopeId: scope.id,
            agent: scope.agent,
            requestId: projection.activeReadyRunId,
            phase: 'responding',
          })
      const run = isForegroundBusyScopeRunState(restoredRun)
        ? restoredRun
        : { ...restoredRun, phase: 'responding' as const, terminalReason: null, error: null }
      const lifecycleError = projection.snapshot === 'product_turn_interrupt_unknown'
        && projection.requestedAction
        ? {
            ok: false as const,
            action: projection.requestedAction,
            code: 'interrupt_state_unknown' as const,
            preserveUi: true as const,
            aliasId: scope.id,
            aliasGeneration: projection.identity.aliasGeneration,
            evidenceDigest: projection.evidenceDigest,
          }
        : null
      return withSessionSliceAndActiveMirror(state, sessionKey, {
        scopeRunStates: { ...slice.scopeRunStates, [scope.id]: run },
        isStreaming: true,
        foregroundBusy: true,
        composerLocked: true,
        streamingMessageId: run.responseMessageId || null,
        streamingRequestId: projection.activeReadyRunId,
        lifecyclePendingAction: projection.interruptRequested
          && projection.requestedAction
          && projection.snapshot !== 'product_turn_interrupt_unknown'
          ? projection.requestedAction === 'stop'
            ? 'stopping'
            : projection.requestedAction === 'close'
              ? 'closing'
              : 'resetting'
          : null,
        lifecycleError,
      })
    }

    if (
      projection.snapshot === 'manual_compaction_pending'
      || projection.snapshot === 'manual_compaction_unknown'
    ) {
      return withSessionSliceAndActiveMirror(state, sessionKey, {
        isStreaming: false,
        foregroundBusy: true,
        composerLocked: true,
        streamingMessageId: null,
        streamingRequestId: null,
        lifecyclePendingAction: projection.snapshot === 'manual_compaction_pending'
          ? 'compacting'
          : null,
        lifecycleError: projection.snapshot === 'manual_compaction_unknown'
          ? {
              ok: false as const,
              action: 'manual_compact' as const,
              code: 'compaction_state_unknown' as const,
              preserveUi: true as const,
              aliasId: scope.id,
              aliasGeneration: projection.identity.aliasGeneration,
              evidenceDigest: projection.evidenceDigest,
            }
          : null,
      })
    }

    if (
      projection.snapshot === 'idle_never_started'
      || projection.snapshot === 'idle_ready_terminal_no_native'
      || projection.snapshot === 'idle_native_thread'
    ) {
      const scopeRunStates = { ...slice.scopeRunStates }
      delete scopeRunStates[scope.id]
      return withSessionSliceAndActiveMirror(state, sessionKey, {
        scopeRunStates,
        isStreaming: false,
        foregroundBusy: false,
        composerLocked: false,
        streamingMessageId: null,
        streamingRequestId: null,
        lifecyclePendingAction: null,
        lifecycleError: null,
      })
    }
    return state
  })
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

function commitPersistedIngressSnapshot(input: Pick<
  IngressAdmittedEvent,
  'requestId' | 'scopeId' | 'originUserMessageId' | 'aliasGeneration' | 'messageVisibilityEpoch' | 'admittedAt'
>): boolean {
  const pending = pendingIngressSnapshots.get(input.requestId)
  if (
    !pending
    || pending.scopeId !== input.scopeId
    || pending.userMessageId !== input.originUserMessageId
    || pending.originMessageVisibilityEpoch !== input.messageVisibilityEpoch
  ) return false
  const currentState = useAgent.getState()
  const sessionKey = pending.originSessionKey
  if (!pendingIngressOriginMatches(currentState, pending)
    || !isLiveSession(currentState, sessionKey)) {
    pendingIngressSnapshots.delete(input.requestId)
    return false
  }
  let committed = false
  useAgent.setState((state) => {
    const slice = normalizeSessionSlice(state.sessions[sessionKey])
    if (!pendingIngressOriginMatches(state, pending)) return state
    const admittedGeneration = input.aliasGeneration ?? pending.originAliasGeneration
    const generationMatches = admittedGeneration !== null
      && (pending.originAliasGeneration === null
        || admittedGeneration >= pending.originAliasGeneration)
      && slice.messageVisibilityEpoch === input.messageVisibilityEpoch
    if (!generationMatches) return state
    committed = true
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
      aliasGeneration: admittedGeneration,
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
    const scopes = state.scopes.map((candidate) => (
      candidate.id === pending.scopeId
        ? { ...candidate, aliasGeneration: admittedGeneration }
        : candidate
    ))
    return {
      ...next,
      scopes,
      conversations: scopes.map(mapScopeToConversation),
      currentScope: state.currentScope?.id === pending.scopeId
        ? { ...state.currentScope, aliasGeneration: admittedGeneration }
        : state.currentScope,
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
  pendingIngressSnapshots.delete(input.requestId)
  if (!committed) return false

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

function appendComposerAttachments(
  state: AgentState,
  files: ChatAttachment[],
): Pick<AgentState, 'attachments' | 'filePool'> {
  return {
    attachments: [...state.attachments, ...files],
    filePool: [
      ...state.filePool,
      ...files.filter((file) =>
        shouldKeepInFilePool(file)
        && !state.filePool.some((poolItem) => isSameAttachmentPoolEntry(poolItem, file)),
      ),
    ],
  }
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
  retiredScopeIds: {},
  scopeAuthorityRevision: 0,
  composerAuthorityRevision: 0,
  scopeListRequestRevision: 0,
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
    let registryAgents: AgentRegistryListItem[] = []
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

    set((current) => {
      const resolved = mapRegistryToAgents(registryAgents, current.agents, current.currentAgent)
      if (resolved.currentAgent === current.currentAgent) return resolved
      return {
        ...resolved,
        attachments: [],
        filePool: [],
        activeAttachmentPreview: null,
        pendingContinuationIntent: null,
        pendingContinuationDraftAnchor: null,
        composerAuthorityRevision: current.composerAuthorityRevision + 1,
      }
    })
  },

  selectAgent: (name) => set((state) => {
    if (state.currentAgent === name) return state
    return {
      currentAgent: name,
      attachments: [],
      filePool: [],
      activeAttachmentPreview: null,
      pendingContinuationIntent: null,
      pendingContinuationDraftAnchor: null,
      composerAuthorityRevision: state.composerAuthorityRevision + 1,
    }
  }),

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

  setActionAuthorizationMode: async (mode: ActionAuthorizationMode) => {
    const normalizedMode = parseActionAuthorizationMode(mode)
    if (normalizedMode !== mode) throw new Error('action_authorization_mode_invalid')
    const state = get()
    const scopeId = state.currentScopeId
    const api = typeof window !== 'undefined' ? window.electronAPI?.agent : null
    if (!scopeId || !api?.setActionAuthorizationMode) {
      throw new Error('action_authorization_mode_unavailable')
    }
    const expectedMessageVisibilityEpoch = state.currentScope?.messageVisibilityEpoch
    if (!Number.isSafeInteger(expectedMessageVisibilityEpoch)) {
      throw new Error('action_authorization_scope_identity_invalid')
    }
    const requestRevision = (actionAuthorizationModeRequestRevisions.get(scopeId) || 0) + 1
    actionAuthorizationModeRequestRevisions.set(scopeId, requestRevision)
    const result = await api.setActionAuthorizationMode(
      scopeId,
      normalizedMode,
      expectedMessageVisibilityEpoch as number,
    )
    if (!result.success
      || !result.data
      || result.data.scopeId !== scopeId
      || result.data.mode !== normalizedMode
      || result.data.messageVisibilityEpoch !== expectedMessageVisibilityEpoch) {
      throw new Error(result.error || 'action_authorization_mode_persist_failed')
    }
    set((current) => {
      if (actionAuthorizationModeRequestRevisions.get(scopeId) !== requestRevision
        || current.retiredScopeIds[scopeId]
        || !current.scopes.some((scope) => scope.id === scopeId)) return current
      const scopes = current.scopes.map((scope) => scope.id === scopeId
        ? {
            ...scope,
            meta: {
              ...scope.meta,
              actionAuthorizationMode: normalizedMode,
            },
          }
        : scope)
      return {
        scopes,
        ...(current.currentScopeId === scopeId && current.currentScope?.id === scopeId
          ? {
              currentScope: {
                ...current.currentScope,
                meta: {
                  ...current.currentScope.meta,
                  actionAuthorizationMode: normalizedMode,
                },
              },
            }
          : {}),
      }
    })
  },

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
    if (state.activeSessionId === id) return state
    const slice = normalizeSessionSlice(state.sessions[id])
    return {
      activeSessionId: id,
      ...mirrorFromSessionSlice(state, slice),
      attachments: [],
      filePool: [],
      activeAttachmentPreview: null,
      pendingContinuationIntent: null,
      pendingContinuationDraftAnchor: null,
      scopeAuthorityRevision: state.scopeAuthorityRevision + 1,
      composerAuthorityRevision: state.composerAuthorityRevision + 1,
    }
  }),

  createNewSession: async () => {
    const api = typeof window !== 'undefined' ? window.electronAPI?.agent : null
    if (!api?.createSession) throw new Error('agent_create_session_unavailable')
    const finishCreation = beginSessionCreation()
    try {
      const state = get()
      const requestedAgent = state.currentAgent
      const composerAuthority = captureComposerAuthority(state)
      const requestRevision = ++createSessionRequestRevision
      const result = await api.createSession({ agentId: requestedAgent })
      if (!result.ok) return result

      const id = generateSessionId()
      const scope: ConversationScope = {
        id: result.aliasId,
        aliasGeneration: result.aliasGeneration,
        messageVisibilityEpoch: 0,
        agent: requestedAgent,
        activeAgentId: requestedAgent,
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
        messageVisibilityEpoch: 0,
      }
      set((current) => {
        if (current.retiredScopeIds[result.aliasId]) return current
        const existingScope = current.scopes.find((candidate) => candidate.id === result.aliasId)
        const reconciledGeneration = Math.max(
          result.aliasGeneration,
          typeof existingScope?.aliasGeneration === 'number' ? existingScope.aliasGeneration : 0,
        )
        const reconciledScope = existingScope
          ? { ...scope, ...existingScope, aliasGeneration: reconciledGeneration }
          : { ...scope, aliasGeneration: reconciledGeneration }
        const retainedScopes = current.scopes.filter((candidate) => (
          candidate.id !== scope.id && !current.retiredScopeIds[candidate.id]
        ))
        const scopes = [reconciledScope, ...retainedScopes]
        const matchingSessionIds = Object.entries(current.sessions)
          .filter(([, candidate]) => normalizeSessionSlice(candidate).conversationId === result.aliasId)
          .map(([sessionId]) => sessionId)
        const targetSessionId = matchingSessionIds[0] || id
        const existingSlice = normalizeSessionSlice(current.sessions[targetSessionId])
        const reconciledSlice: SessionSlice = {
          ...(matchingSessionIds.length > 0 ? existingSlice : slice),
          conversationId: result.aliasId,
          aliasGeneration: Math.max(
            reconciledGeneration,
            existingSlice.aliasGeneration ?? 0,
          ),
        }
        const nextSessions = Object.fromEntries(
          Object.entries(current.sessions).filter(([sessionId]) => (
            !matchingSessionIds.includes(sessionId) || sessionId === targetSessionId
          )),
        ) as Record<string, SessionSlice>
        nextSessions[targetSessionId] = reconciledSlice
        const nextOrder = current.sessionOrder.filter((sessionId) => (
          !matchingSessionIds.includes(sessionId) || sessionId === targetSessionId
        ))
        if (!nextOrder.includes(targetSessionId)) nextOrder.push(targetSessionId)
        const durableMerge = {
          sessions: nextSessions,
          sessionOrder: nextOrder,
          scopes,
          conversations: scopes.map(mapScopeToConversation),
          scopeAuthorityRevision: current.scopeAuthorityRevision + 1,
        }
        if (requestRevision !== createSessionRequestRevision
          || !isComposerAuthorityCurrent(current, composerAuthority)) return durableMerge
        return {
          ...durableMerge,
          activeSessionId: targetSessionId,
          sessionId: targetSessionId,
          ...mirrorFromSessionSlice({ ...current, scopes }, reconciledSlice),
          attachments: [],
          filePool: [],
          activeAttachmentPreview: null,
          pendingContinuationIntent: null,
          pendingContinuationDraftAnchor: null,
          toolTrace: [],
          toolTraceStatus: 'idle',
          composerAuthorityRevision: current.composerAuthorityRevision + 1,
        }
      })
      return result
    } finally {
      finishCreation()
    }
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
    const capturedReadyRunId = slice.streamingRequestId
    if (slice.lifecyclePendingAction) throw new Error('lifecycle_action_pending')
    const exactInterruptRetry = slice.lifecycleError?.action === 'close'
      && slice.lifecycleError.code === 'interrupt_state_unknown'
      && slice.lifecycleError.aliasId === aliasId
      && slice.lifecycleError.aliasGeneration === slice.aliasGeneration
    const priorLifecycleError = exactInterruptRetry ? slice.lifecycleError : null
    if (hasUnresolvedLifecycleUncertainty(slice) && !exactInterruptRetry) {
      throw new Error('lifecycle_reconciliation_required')
    }
    set((current) => withSessionSliceAndActiveMirror(current, id, {
      lifecyclePendingAction: 'closing',
      lifecycleError: null,
    }))
    const setCloseTargetIfCurrent = (patch: Partial<SessionSlice>): boolean => {
      let applied = false
      set((current) => {
        const currentSlice = normalizeSessionSlice(current.sessions[id])
        if (
          currentSlice.conversationId !== aliasId
          || currentSlice.aliasGeneration !== slice.aliasGeneration
          || currentSlice.streamingRequestId !== capturedReadyRunId
          || currentSlice.lifecyclePendingAction !== 'closing'
        ) return current
        applied = true
        return withSessionSliceAndActiveMirror(current, id, patch)
      })
      return applied
    }
    let result: Awaited<ReturnType<typeof window.electronAPI.agent.closeSession>>
    try {
      result = await window.electronAPI.agent.closeSession({
        aliasId,
        aliasGeneration: slice.aliasGeneration,
        readyRunId: capturedReadyRunId,
      })
    } catch (error) {
      setCloseTargetIfCurrent({
        lifecyclePendingAction: null,
        lifecycleError: priorLifecycleError,
      })
      throw error
    }
    if (!result.ok) {
      setCloseTargetIfCurrent({
        lifecyclePendingAction: null,
        lifecycleError: result,
      })
      return result
    }
    if (result.action !== 'close') {
      setCloseTargetIfCurrent({
        lifecyclePendingAction: null,
        lifecycleError: priorLifecycleError,
      })
      throw new Error('lifecycle_result_action_mismatch')
    }

    set((current) => {
      const removedSessionIds = new Set(Object.entries(current.sessions)
        .filter(([, candidate]) => normalizeSessionSlice(candidate).conversationId === aliasId)
        .map(([sessionId]) => sessionId))
      const nextOrder = current.sessionOrder.filter((entry) => !removedSessionIds.has(entry))
      const nextSessions = Object.fromEntries(Object.entries(current.sessions)
        .filter(([sessionId]) => !removedSessionIds.has(sessionId))) as Record<string, SessionSlice>
      const nextActiveId = current.activeSessionId && !removedSessionIds.has(current.activeSessionId)
        ? current.activeSessionId
        : (nextOrder[0] ?? null)
      const nextSlice = nextActiveId ? normalizeSessionSlice(nextSessions[nextActiveId]) : null
      const closedActiveSession = current.activeSessionId === null
        || removedSessionIds.has(current.activeSessionId)
      const nextScopes = current.scopes.filter((scope) => scope.id !== aliasId)
      const nextLiveMessages = { ...current.scopeLiveMessages }
      delete nextLiveMessages[aliasId]
      const stateForMirror = {
        ...current,
        scopes: nextScopes,
        currentScope: current.currentScope?.id === aliasId ? null : current.currentScope,
      }
      return {
        sessions: nextSessions,
        sessionOrder: nextOrder,
        activeSessionId: nextActiveId,
        sessionId: nextActiveId ?? current.sessionId,
        retiredScopeIds: { ...current.retiredScopeIds, [aliasId]: true },
        scopeAuthorityRevision: current.scopeAuthorityRevision + 1,
        scopeLiveMessages: nextLiveMessages,
        scopes: nextScopes,
        conversations: nextScopes.map(mapScopeToConversation),
        ...(nextSlice
          ? mirrorFromSessionSlice(stateForMirror, nextSlice)
          : mirrorFromSessionSlice(stateForMirror, makeEmptySessionSlice())),
        ...(closedActiveSession ? {
          attachments: [],
          filePool: [],
          activeAttachmentPreview: null,
          pendingContinuationIntent: null,
          pendingContinuationDraftAnchor: null,
          composerAuthorityRevision: current.composerAuthorityRevision + 1,
        } : {}),
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
    const stoppedRequestId = slice.streamingRequestId
    if (!stoppedRequestId) throw new Error('active_run_not_bound')
    if (slice.lifecyclePendingAction) throw new Error('lifecycle_action_pending')
    const exactInterruptRetry = slice.lifecycleError?.action === 'stop'
      && slice.lifecycleError.code === 'interrupt_state_unknown'
      && slice.lifecycleError.aliasId === aliasId
      && slice.lifecycleError.aliasGeneration === slice.aliasGeneration
    const priorLifecycleError = exactInterruptRetry ? slice.lifecycleError : null
    if (hasUnresolvedLifecycleUncertainty(slice) && !exactInterruptRetry) {
      throw new Error('lifecycle_reconciliation_required')
    }
    set((current) => withSessionSliceAndActiveMirror(current, sessionKey, {
      lifecyclePendingAction: 'stopping',
      lifecycleError: null,
    }))
    const setStopTargetIfCurrent = (patch: Partial<SessionSlice>): boolean => {
      let applied = false
      set((current) => {
        const currentSlice = normalizeSessionSlice(current.sessions[sessionKey])
        if (
          currentSlice.conversationId !== aliasId
          || currentSlice.aliasGeneration !== slice.aliasGeneration
          || currentSlice.streamingRequestId !== stoppedRequestId
        ) return current
        applied = true
        return withSessionSliceAndActiveMirror(current, sessionKey, patch)
      })
      return applied
    }
    let result: Awaited<ReturnType<typeof window.electronAPI.agent.kill>>
    try {
      result = await window.electronAPI.agent.kill({
        aliasId,
        aliasGeneration: slice.aliasGeneration,
        readyRunId: stoppedRequestId,
      })
    } catch (error) {
      setStopTargetIfCurrent({
        lifecyclePendingAction: null,
        lifecycleError: priorLifecycleError,
      })
      throw error
    }
    if (!result.ok) {
      if (result.code === 'no_active_operation') {
        const applied = setStopTargetIfCurrent({
          lifecyclePendingAction: null,
          lifecycleError: null,
          streamingMessageId: null,
          streamingRequestId: null,
          isStreaming: false,
          foregroundBusy: false,
          composerLocked: false,
        })
        if (applied) agentRuntimeDriver.clearInfrastructureWatchdog(aliasId, stoppedRequestId)
        return result
      }
      setStopTargetIfCurrent({
        lifecyclePendingAction: null,
        lifecycleError: result,
      })
      return result
    }
    if (result.action !== 'stop') {
      setStopTargetIfCurrent({
        lifecyclePendingAction: null,
        lifecycleError: priorLifecycleError,
      })
      throw new Error('lifecycle_result_action_mismatch')
    }
    const applied = setStopTargetIfCurrent({
      lifecyclePendingAction: null,
      lifecycleError: null,
      streamingMessageId: null,
      streamingRequestId: null,
      isStreaming: false,
      foregroundBusy: false,
      composerLocked: false,
    })
    if (applied) agentRuntimeDriver.clearInfrastructureWatchdog(aliasId, stoppedRequestId)
    return result
  },

  resetCurrentConversation: async () => {
    const state = get()
    const aliasId = state.currentScopeId
    if (!aliasId || !window.electronAPI?.agent?.resetSession) throw new Error('alias_not_bound')
    const sessionKey = sessionKeyForScopeId(state, aliasId)
    const slice = normalizeSessionSlice(state.sessions[sessionKey])
    if (slice.aliasGeneration === null) throw new Error('alias_not_bound')
    const capturedReadyRunId = slice.streamingRequestId
    if (slice.lifecyclePendingAction) throw new Error('lifecycle_action_pending')
    const exactInterruptRetry = slice.lifecycleError?.action === 'reset'
      && slice.lifecycleError.code === 'interrupt_state_unknown'
      && slice.lifecycleError.aliasId === aliasId
      && slice.lifecycleError.aliasGeneration === slice.aliasGeneration
    if (
      hasUnresolvedLifecycleUncertainty(slice)
      && !exactInterruptRetry
      && !canResetUnknownCompaction(slice, aliasId)
    ) throw new Error('lifecycle_reconciliation_required')
    const priorLifecycleError = exactInterruptRetry || canResetUnknownCompaction(slice, aliasId)
      ? slice.lifecycleError
      : null
    set((current) => withSessionSliceAndActiveMirror(current, sessionKey, {
      lifecyclePendingAction: 'resetting',
      lifecycleError: null,
    }))
    const setResetTargetIfCurrent = (patch: Partial<SessionSlice>): boolean => {
      let applied = false
      set((current) => {
        const currentSlice = normalizeSessionSlice(current.sessions[sessionKey])
        if (
          currentSlice.conversationId !== aliasId
          || currentSlice.aliasGeneration !== slice.aliasGeneration
          || currentSlice.streamingRequestId !== capturedReadyRunId
          || currentSlice.lifecyclePendingAction !== 'resetting'
        ) return current
        applied = true
        return withSessionSliceAndActiveMirror(current, sessionKey, patch)
      })
      return applied
    }
    let result: Awaited<ReturnType<typeof window.electronAPI.agent.resetSession>>
    try {
      result = await window.electronAPI.agent.resetSession({
        aliasId,
        aliasGeneration: slice.aliasGeneration,
        readyRunId: capturedReadyRunId,
      })
    } catch (error) {
      setResetTargetIfCurrent({
        lifecyclePendingAction: null,
        lifecycleError: priorLifecycleError,
      })
      throw error
    }
    if (!result.ok) {
      setResetTargetIfCurrent({
        lifecyclePendingAction: null,
        lifecycleError: result,
      })
      return result
    }
    if (result.action !== 'reset') {
      setResetTargetIfCurrent({
        lifecyclePendingAction: null,
        lifecycleError: priorLifecycleError,
      })
      throw new Error('lifecycle_result_action_mismatch')
    }
    const invalidatedIngressRequestIds: string[] = []
    let resetApplied = false
    set((current) => {
      const currentSlice = normalizeSessionSlice(current.sessions[sessionKey])
      if (
        currentSlice.conversationId !== aliasId
        || currentSlice.aliasGeneration !== slice.aliasGeneration
        || currentSlice.streamingRequestId !== capturedReadyRunId
        || currentSlice.lifecyclePendingAction !== 'resetting'
      ) return current
      resetApplied = true
      for (const [requestId, pending] of pendingIngressSnapshots) {
        if (pending.scopeId === aliasId
          && pending.originAliasGeneration === slice.aliasGeneration
          && pending.originMessageVisibilityEpoch === slice.messageVisibilityEpoch) {
          invalidatedIngressRequestIds.push(requestId)
        }
      }
      const scopes = current.scopes.map((candidate) => (
        candidate.id === aliasId
          ? {
              ...candidate,
              aliasGeneration: result.newGeneration,
              messageVisibilityEpoch: currentSlice.messageVisibilityEpoch + 1,
            }
          : candidate
      ))
      const currentScope = current.currentScope?.id === aliasId
        ? {
            ...current.currentScope,
            aliasGeneration: result.newGeneration,
            messageVisibilityEpoch: currentSlice.messageVisibilityEpoch + 1,
          }
        : current.currentScope
      const next = withSessionSliceAndActiveMirror(current, sessionKey, {
        ...makeEmptySessionSlice(aliasId),
        aliasGeneration: result.newGeneration,
        messageVisibilityEpoch: currentSlice.messageVisibilityEpoch + 1,
      })
      const lifecyclePatch = activeSessionKey(current) === sessionKey
        ? {
            ...next,
            attachments: [],
            filePool: [],
            activeAttachmentPreview: null,
            pendingContinuationIntent: null,
            pendingContinuationDraftAnchor: null,
            toolTrace: [],
            toolTraceStatus: 'idle' as const,
          }
        : next
      const scopeLiveMessages = { ...current.scopeLiveMessages }
      delete scopeLiveMessages[aliasId]
      return {
        ...lifecyclePatch,
        scopes,
        conversations: scopes.map(mapScopeToConversation),
        currentScope,
        scopeLiveMessages,
        scopeAuthorityRevision: current.scopeAuthorityRevision + 1,
        composerAuthorityRevision: current.composerAuthorityRevision + 1,
      }
    })
    if (resetApplied) {
      for (const requestId of invalidatedIngressRequestIds) {
        pendingIngressSnapshots.delete(requestId)
        agentRuntimeDriver.clearInfrastructureWatchdog(aliasId, requestId)
      }
      agentRuntimeDriver.clearInfrastructureWatchdog(aliasId, capturedReadyRunId)
    }
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
    if (typeof window === 'undefined' || !window.electronAPI?.agent) return false
    try {
      const requestRevision = get().scopeListRequestRevision + 1
      const authorityRevision = get().scopeAuthorityRevision
      set({ scopeListRequestRevision: requestRevision })
      const { currentAgent } = get()
      const result = await window.electronAPI.agent.listConversationScopes(currentAgent)
      if (!result.success || !Array.isArray(result.data)) return false
      const currentAuthority = get()
      if (currentAuthority.scopeListRequestRevision !== requestRevision
        || currentAuthority.scopeAuthorityRevision !== authorityRevision) return false
      const scopes = (result.data as unknown as ConversationScope[])
        .filter((scope) => !currentAuthority.retiredScopeIds[scope.id])
      if (scopes.length === 0) {
        const emptySlice = makeEmptySessionSlice()
        set((state) => {
          const composerInvalidated = Boolean(
            state.activeSessionId
            || state.currentScopeId
            || state.attachments.length > 0
            || state.filePool.length > 0
            || state.activeAttachmentPreview
            || state.pendingContinuationIntent,
          )
          return {
            sessions: {},
            sessionOrder: [],
            activeSessionId: null,
            sessionId: state.sessionId,
            scopes: [],
            conversations: [],
            scopeLiveMessages: {},
            scopeAuthorityRevision: state.scopeAuthorityRevision + 1,
            ...mirrorFromSessionSlice({ ...state, scopes: [], currentScope: null }, emptySlice),
            attachments: [],
            filePool: [],
            activeAttachmentPreview: null,
            pendingContinuationIntent: null,
            pendingContinuationDraftAnchor: null,
            ...(composerInvalidated
              ? { composerAuthorityRevision: state.composerAuthorityRevision + 1 }
              : {}),
          }
        })
        return true
      }
      const previousScopeId = get().currentScopeId
      const requestedCurrentScope = scopes.find((scope) => scope.id === previousScopeId) || scopes[0] || null
      set((state) => {
        const loadedScopeIds = new Set(scopes.map((scope) => scope.id))
        const nextSessions: typeof state.sessions = {}
        const nextOrder = state.sessionOrder.filter((sessionKey) => {
          const conversationId = normalizeSessionSlice(state.sessions[sessionKey]).conversationId
          if (!conversationId || !loadedScopeIds.has(conversationId)) return false
          nextSessions[sessionKey] = state.sessions[sessionKey]
          return true
        })
        const sessionByScope = new Map<string, string>()
        for (const [sessionKey, sliceInput] of Object.entries(nextSessions)) {
          const conversationId = normalizeSessionSlice(sliceInput).conversationId
          if (conversationId) sessionByScope.set(conversationId, sessionKey)
        }
        const reconciledScopes = scopes.map((scope) => {
          const sessionKey = sessionByScope.get(scope.id) || scope.id
          const slice = normalizeSessionSlice(nextSessions[sessionKey])
          const loadedGeneration = typeof scope.aliasGeneration === 'number'
            ? scope.aliasGeneration
            : null
          const aliasGeneration = slice.aliasGeneration === null
            ? loadedGeneration
            : loadedGeneration === null
              ? slice.aliasGeneration
              : Math.max(slice.aliasGeneration, loadedGeneration)
          const loadedVisibilityEpoch = Number.isSafeInteger(scope.messageVisibilityEpoch)
            ? scope.messageVisibilityEpoch
            : 0
          const messageVisibilityEpoch = Math.max(
            slice.messageVisibilityEpoch,
            loadedVisibilityEpoch,
          )
          nextSessions[sessionKey] = loadedVisibilityEpoch > slice.messageVisibilityEpoch
            ? {
                ...makeEmptySessionSlice(scope.id),
                aliasGeneration,
                messageVisibilityEpoch,
              }
            : {
                ...slice,
                conversationId: scope.id,
                aliasGeneration,
                messageVisibilityEpoch,
              }
          sessionByScope.set(scope.id, sessionKey)
          if (!nextOrder.includes(sessionKey)) nextOrder.push(sessionKey)
          return { ...scope, aliasGeneration, messageVisibilityEpoch }
        })

        const scopeLiveMessages = { ...state.scopeLiveMessages }
        for (const scope of reconciledScopes) {
          const previous = state.scopes.find((candidate) => candidate.id === scope.id)
          if ((previous?.messageVisibilityEpoch ?? 0) < scope.messageVisibilityEpoch) {
            delete scopeLiveMessages[scope.id]
          }
        }

        const currentScope = requestedCurrentScope
          ? reconciledScopes.find((scope) => scope.id === requestedCurrentScope.id) || null
          : null

        const sessionKey = currentScope
          ? (sessionByScope.get(currentScope.id) || activeSessionKey(state))
          : activeSessionKey(state)
        const previousTargetSlice = normalizeSessionSlice(state.sessions[sessionKey])
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
          aliasGeneration: currentScope?.aliasGeneration ?? slice.aliasGeneration,
          scopeRunStates: nextScopeRunStates,
          isStreaming: isStreamingScopeRunState(activeRunState),
          foregroundBusy: isForegroundBusyScopeRunState(activeRunState),
          composerLocked: isForegroundBusyScopeRunState(activeRunState),
          streamingRequestId: activeRunState?.requestId || null,
        }
        nextSessions[sessionKey] = nextSlice
        const stateWithScopes = { ...state, scopes: reconciledScopes }
        const composerInvalidated = state.activeSessionId !== sessionKey
          || state.currentScopeId !== (currentScope?.id || null)
          || nextSlice.messageVisibilityEpoch > previousTargetSlice.messageVisibilityEpoch
          || Boolean(currentScope && currentScope.agent !== state.currentAgent)
        return {
          sessions: nextSessions,
          sessionOrder: nextOrder,
          activeSessionId: sessionKey,
          sessionId: sessionKey,
          ...mirrorFromSessionSlice(stateWithScopes, nextSlice),
          scopes: reconciledScopes,
          conversations: reconciledScopes.map(mapScopeToConversation),
          currentAgent: currentScope?.agent || state.currentAgent,
          scopeLiveMessages,
          scopeAuthorityRevision: state.scopeAuthorityRevision + 1,
          ...(composerInvalidated ? {
            pendingContinuationIntent: null,
            pendingContinuationDraftAnchor: null,
            attachments: [],
            filePool: [],
            activeAttachmentPreview: null,
            composerAuthorityRevision: state.composerAuthorityRevision + 1,
          } : {}),
        }
      })
      // ChatPanel registers runtime listeners before calling loadScopes. Read
      // the durable owner only after the alias slices exist, then apply it by
      // exact generation/run CAS so a concurrent ingress or terminal event wins.
      const reconciledScopes = get().scopes.filter((candidate) => (
        scopes.some((loaded) => loaded.id === candidate.id)
      ))
      await Promise.all(reconciledScopes.map((candidate) => hydrateCodexLifecycleScope(candidate)))
      const currentScope = get().currentScope
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
      return true
    } catch {
      return false
    }
  },

  loadScope: async (scopeId: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.agent) return
    try {
      const authorityRevision = get().scopeAuthorityRevision
      if (get().retiredScopeIds[scopeId]
        || !get().scopes.some((scope) => scope.id === scopeId)) return
      const result = await window.electronAPI.agent.getConversationScopeMessages(scopeId)
      if (!result.success || !result.data) return
      const authoritative = get()
      if (authoritative.scopeAuthorityRevision !== authorityRevision
        || authoritative.retiredScopeIds[scopeId]
        || !authoritative.scopes.some((scope) => scope.id === scopeId)) return
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
        const loadedAliasGeneration = typeof scope?.aliasGeneration === 'number'
          ? scope.aliasGeneration
          : null
        const aliasGeneration = slice.aliasGeneration === null
          ? loadedAliasGeneration
          : loadedAliasGeneration === null
            ? slice.aliasGeneration
            : Math.max(slice.aliasGeneration, loadedAliasGeneration)
        const nextScopeRunStates = activeRunState
          ? { ...slice.scopeRunStates, [scopeId]: activeRunState }
          : slice.scopeRunStates
        const nextSlice: SessionSlice = {
          ...slice,
          messages,
          conversationId: scopeId,
          aliasGeneration,
          messageVisibilityEpoch: scope?.messageVisibilityEpoch ?? slice.messageVisibilityEpoch,
          scopeRunStates: nextScopeRunStates,
          isStreaming: isStreamingScopeRunState(activeRunState),
          foregroundBusy: isForegroundBusyScopeRunState(activeRunState),
          composerLocked: isForegroundBusyScopeRunState(activeRunState),
          streamingMessageId: null,
          streamingRequestId: activeRunState?.requestId || null,
        }
        const nextScope = scope
          ? { ...scope, aliasGeneration }
          : null
        const scopes = state.scopes.map((candidate) => (
          candidate.id === scopeId && nextScope ? nextScope : candidate
        ))
        const composerInvalidated = state.activeSessionId !== sessionKey
          || state.currentScopeId !== scopeId
          || nextSlice.messageVisibilityEpoch > slice.messageVisibilityEpoch
          || Boolean(nextScope && nextScope.agent !== state.currentAgent)
        return {
          sessions: { ...state.sessions, [sessionKey]: nextSlice },
          activeSessionId: sessionKey,
          sessionId: sessionKey,
          ...mirrorFromSessionSlice(state, nextSlice),
          scopes,
          conversations: scopes.map(mapScopeToConversation),
          currentScope: nextScope,
          currentAgent: nextScope?.agent || state.currentAgent,
          ...(composerInvalidated ? {
            attachments: [],
            filePool: [],
            activeAttachmentPreview: null,
            pendingContinuationIntent: null,
            pendingContinuationDraftAnchor: null,
            composerAuthorityRevision: state.composerAuthorityRevision + 1,
          } : {}),
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
  addAttachments: (files: ChatAttachment[]) => set((state) => (
    appendComposerAttachments(state, files)
  )),

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
    const composerAuthority = captureComposerAuthority(get())
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
        set((state) => (
          isComposerAuthorityCurrent(state, composerAuthority)
            ? appendComposerAttachments(state, attachments)
            : state
        ))
      }
    } catch { /* ignore */ }
  },

  sendMessage: async (content: string, options?: {
    codexExternalReadSlice?: Record<string, unknown>
  }) => {
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
    const originComposerAuthority = captureComposerAuthority(get())
    if (
      originComposerAuthority.sessionId !== originSessionKey
      || originComposerAuthority.scopeId !== currentScopeId
      || originComposerAuthority.sessionConversationId !== currentScopeId
    ) return rejectedMessageResult('conversation_reset_required')
    if (originSlice.aliasGeneration === null) {
      return rejectedMessageResult('conversation_reset_required')
    }
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
    const referencedPoolAttachments = resolveReferencedFilePoolAttachments(content, filePool)
    const messageAttachments = [...currentAttachments]
    for (const attachment of referencedPoolAttachments) {
      if (!messageAttachments.some((candidate) => isSameAttachmentPoolEntry(candidate, attachment))) {
        messageAttachments.push(attachment)
      }
    }
    const composedInput = await buildCodexIngressInputWithDiagnostics({
      content,
      attachments: messageAttachments,
    })
    if (composedInput.diagnostics.inputFailedCount > 0) {
      emitRendererAgentMetric('renderer_attachment_input_failed', {
        scopeId: activeScopeId,
        agent: activeAgentName,
        failedCount: composedInput.diagnostics.inputFailedCount,
      })
      return rejectedMessageResult('attachment_unavailable')
    }
    let currentDocumentAnchor
    try {
      currentDocumentAnchor = await buildCodexCurrentDocumentAnchor(activeScopeId)
    } catch {
      return rejectedMessageResult('attachment_unavailable')
    }
    const beforeDispatch = get()
    if (
      !isComposerAuthorityCurrent(beforeDispatch, originComposerAuthority)
      || activeSessionKey(beforeDispatch) !== originSessionKey
      || !pendingIngressOriginMatches(beforeDispatch, {
        scopeId: activeScopeId,
        originAliasGeneration: originSlice.aliasGeneration,
        originMessageVisibilityEpoch: originSlice.messageVisibilityEpoch,
        originSessionKey,
      })
    ) return rejectedMessageResult('conversation_reset_required')

    const userMsgId = generateId('msg')
    const userTimestamp = new Date()

    const persistedAttachments = serializeAttachments(messageAttachments)
    const userMessageMeta = {
      sourceKind: activeScope.sourceKind,
      sourceId: activeScope.sourceId,
      threadKey: activeScope.threadKey,
      direction: 'local-input',
      workbenchMode: useMode.getState().workbenchMode,
      actionAuthorizationMode: parseActionAuthorizationMode(
        activeScope.meta.actionAuthorizationMode,
      ),
      attachments: persistedAttachments.length > 0 ? persistedAttachments : undefined,
      ...(options?.codexExternalReadSlice
        ? { codexExternalReadSlice: options.codexExternalReadSlice }
        : {}),
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
      attachments: messageAttachments,
      originAliasGeneration: originSlice.aliasGeneration,
      originMessageVisibilityEpoch: originSlice.messageVisibilityEpoch,
      originSessionKey,
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
          expectedAliasGeneration: originSlice.aliasGeneration as number,
          expectedMessageVisibilityEpoch: originSlice.messageVisibilityEpoch,
          resources: composedInput.resources,
          currentDocumentAnchor,
          userMessage: {
            id: userMsgId,
            content,
            timestamp: userTimestamp.toISOString(),
            meta: userMessageMeta,
            attachmentConfirmation: {
              selectedCount: messageAttachments.length,
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
            aliasGeneration: result.aliasGeneration,
            messageVisibilityEpoch: originSlice.messageVisibilityEpoch,
            admittedAt: userTimestamp.toISOString(),
          })
        }

        if (!result.success) {
          const mapped = mapSendScopedResponseToMessageResult(result)
          if (result.disposition !== 'terminal_failure_after_persistence') {
            const pending = pendingIngressSnapshots.get(requestId)
            const friendly = mapBackendErrorToFriendly({
              error: result.error,
              errorKind: result.errorKind,
            })
            const receivedAt = new Date().toISOString()
            set((state) => {
              if (!pending || pendingIngressSnapshots.get(requestId) !== pending
                || !pendingIngressOriginMatches(state, pending)) return {}
              const sessionKey = pending.originSessionKey
              const slice = normalizeSessionSlice(state.sessions[sessionKey])
              if (!state.sessions[sessionKey] || slice.conversationId !== activeScopeId) return {}
              const currentRun = slice.scopeRunStates[activeScopeId]
                || createEmptyScopeRunState({ scopeId: activeScopeId, agent: activeAgentName })
              const nextScopeRunStates = {
                ...slice.scopeRunStates,
                [activeScopeId]: {
                  ...currentRun,
                  updatedAt: receivedAt,
                  softError: {
                    message: result.error,
                    errorKind: result.errorKind,
                    toolName: null,
                    friendlyMessage: friendly.friendlyMessage,
                    technicalDetails: friendly.technicalDetails || null,
                    receivedAt,
                  },
                },
              }
              return {
                sessions: {
                  ...state.sessions,
                  [sessionKey]: { ...slice, scopeRunStates: nextScopeRunStates },
                },
                ...(state.activeSessionId === sessionKey ? { scopeRunStates: nextScopeRunStates } : {}),
              }
            })
            pendingIngressSnapshots.delete(requestId)
            emitRendererAgentMetric('renderer_friendly_error_surfaced', {
              scopeId: activeScopeId,
              agent: activeAgentName,
              errorKind: result.errorKind,
            })
            return mapped
          }
          agentRuntimeDriver.clearInfrastructureWatchdog(activeScopeId, requestId)
          const friendly = mapBackendErrorToFriendly({
            error: result.error,
            errorKind: result.errorKind,
          })
          set((state) => {
            const sessionKey = originSessionKey
            const slice = normalizeSessionSlice(state.sessions[sessionKey])
            if (!state.sessions[sessionKey]
              || slice.conversationId !== activeScopeId
              || slice.messageVisibilityEpoch !== originSlice.messageVisibilityEpoch
              || slice.streamingRequestId !== requestId
              || (typeof result.aliasGeneration === 'number'
                && slice.aliasGeneration !== result.aliasGeneration)) return {}
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
        await agentRuntimeDriver.completeScopeRunAfterSendSuccess(activeScopeId, requestId, {
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
        const sessionKey = originSessionKey
        const slice = normalizeSessionSlice(state.sessions[sessionKey])
        if (!state.sessions[sessionKey]
          || slice.conversationId !== activeScopeId
          || slice.messageVisibilityEpoch !== originSlice.messageVisibilityEpoch
          || slice.streamingRequestId !== requestId) return {}
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
    const authoritative = get()
    if (authoritative.retiredScopeIds[scopeId]
      || authoritative.currentScopeId !== scopeId
      || authoritative.currentScope?.id !== scopeId) {
      throw new Error('conversation_scope_closed_or_missing')
    }
    await get().sendMessage(content)
  }
}))

let initialSessionCreation: Promise<void> | null = null

export async function hydrateAgentScopesAfterRuntimeReady(): Promise<void> {
  const loaded = await useAgent.getState().loadScopes()
  if (!loaded || useAgent.getState().scopes.length > 0) return
  if (sessionCreationsInFlight.size > 0) {
    await Promise.all([...sessionCreationsInFlight])
    if (useAgent.getState().scopes.length > 0) return
  }
  if (!initialSessionCreation) {
    const creation = useAgent.getState().createNewSession().then(() => undefined)
    initialSessionCreation = creation.finally(() => { initialSessionCreation = null })
  }
  await initialSessionCreation
}

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
  const authorityRevision = useAgent.getState().scopeAuthorityRevision
  const result = await api.listPendingAskUserQuestions()
  if (!result || !result.success || !Array.isArray(result.data)) return
  if (useAgent.getState().scopeAuthorityRevision !== authorityRevision) return
  for (const card of result.data) {
    if (useAgent.getState().scopeAuthorityRevision !== authorityRevision) return
    if (!askUserCardMatchesCurrentIdentity(card)) continue
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

function askUserCardMatchesCurrentIdentity(card: {
  conversationId: string | null
  readyRunId?: string | null
  aliasGeneration?: number | null
  messageVisibilityEpoch?: number | null
}): boolean {
  if (typeof card.aliasGeneration !== 'number'
    && typeof card.messageVisibilityEpoch !== 'number'
    && !card.readyRunId) return true
  if (!card.conversationId
    || typeof card.messageVisibilityEpoch !== 'number'
    || !card.readyRunId) return false
  const state = useAgent.getState()
  const sessionKey = sessionKeyForScopeId(state, card.conversationId)
  const slice = normalizeSessionSlice(state.sessions[sessionKey])
  const runId = slice.streamingRequestId
    || slice.scopeRunStates[card.conversationId]?.requestId
    || null
  return slice.conversationId === card.conversationId
    && (typeof card.aliasGeneration !== 'number'
      || slice.aliasGeneration === card.aliasGeneration)
    && slice.messageVisibilityEpoch === card.messageVisibilityEpoch
    && runId === card.readyRunId
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
    if (!askUserCardMatchesCurrentIdentity(event)) return
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
  const runtimeReadyApi = window.electronAPI?.agent as {
    readRuntimeReady?: () => Promise<AgentRuntimeReadinessSnapshot>
    onRuntimeReady?: (listener: (snapshot: AgentRuntimeReadinessSnapshot) => void) => () => void
  } | undefined
  const readRuntimeReady = runtimeReadyApi?.readRuntimeReady
  const onRuntimeReady = runtimeReadyApi?.onRuntimeReady
  const offRuntimeReady = readRuntimeReady && onRuntimeReady
    ? installAgentRuntimeReadyHydration({
        read: readRuntimeReady,
        subscribe: onRuntimeReady,
        hydrate: async () => {
          await useAgent.getState().reloadAgents()
          await hydrateAgentScopesAfterRuntimeReady()
        },
      })
    : () => {}
  return () => {
    try { window.removeEventListener('ready:agent-registry-changed', onAgentRegistryChanged) } catch { /* ignore */ }
    try { offRuntime() } catch { /* ignore */ }
    try { offAgentInteraction() } catch { /* ignore */ }
    try { offIngressAdmitted() } catch { /* ignore */ }
    try { offRuntimeReady() } catch { /* ignore */ }
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
