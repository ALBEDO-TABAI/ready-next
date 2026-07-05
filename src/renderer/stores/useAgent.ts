import { create } from 'zustand'
import {
  createEmptyScopeRunState,
  getActiveScopeRunState,
  isForegroundBusyScopeRunState,
  isStreamingScopeRunState,
  normalizeTerminalReason,
  phaseToToolTraceStatus,
} from '../modules/agent/scopeRunState'
import { runDocCommand as executeDocCommand } from '../modules/agent/documentActions'
import { runSkillCommand as executeSkillCommand } from '../modules/agent/commandHandlers'
import {
  buildComposedAgentInputWithDiagnostics,
  filterAttachmentsForComposedAgentInput,
  persistMessage as persistChatMessage,
  serializePersistedAttachments as serializeAttachments,
} from '../modules/agent/messageComposer'
import { mapBackendErrorToFriendly } from '../modules/agent/error-message-mapping'
import { emitRendererAgentMetric } from '../modules/agent/rendererMetrics'
import { boundedCancelWithFallback } from '../modules/agent/boundedCancelWithFallback'
import { createAgentRuntimeDriver, syncActiveScopeRunAliases } from '../modules/agent/runtimeDriver'
import { installAgentPanelTestHarness } from '../modules/agent/agentPanelTestHarness'
import { computeDesiredRoots, useWorkspace } from './useWorkspace'
import { MAX_AGENT_SESSIONS } from '../../shared/agent-session-limits'

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
  callCreateLocalScopeWithMetric,
  cloneFallbackAgents,
  DEFAULT_SEND_COALESCE_WINDOW_MS,
  generateId,
  generateSessionId,
  getScopeRunStateForScope,
  isLiveSession,
  isSameAttachmentPoolEntry,
  makeEmptySessionSlice,
  mapPersonalitiesToAgents,
  mapRegistryToAgents,
  mapScopeRunPhaseToSessionState,
  mapScopeToConversation,
  mirrorFromSessionSlice,
  normalizeSessionSlice,
  persistLocalConversationScope,
  rebuildAgentMessageFromRow,
  recordCardFallback,
  recordOrphanedCard,
  removeFromFilePool,
  routeCardToSession,
  scopeCreatePersistenceMetricThrottle,
  sessionKeyForScopeId,
  shouldKeepInFilePool,
  shouldPreserveContinuationIntent,
  withActiveSessionConversationMirror,
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
  selectPendingSendForActive,
  selectScopes,
  selectSessionOrder,
} from './agent-store-helpers'

// Concurrent-live session cap. Single source of truth lives in
// `src/shared/agent-session-limits.ts` so the renderer "+" disable and the main
// orchestrator's admission guard never diverge (a 5-vs-3 split let sessions look
// creatable but get rejected on send). Re-exported for the existing call sites.
export { MAX_AGENT_SESSIONS }

/**
 * Stage V V3.3c — replace per-module `let` globals with per-sessionId Maps so
 * concurrent sessions (V3.3b roadmap) do not collide on a single shared
 * timer/buffer. Today only one session is active at a time; the Map keying
 * isolates against future multi-session selectors and against dev HMR
 * reloads that would otherwise re-evaluate this module and leak the
 * previous timer.
 */
const pendingSendTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingSendBuffers = new Map<
  string,
  {
    scopeId: string | null
    agent: string
    parts: string[]
  }
>()
let bypassCoalescingOnce = false

/**
 * Pure cleanup routine shared by the Vite HMR dispose hook and the V3.3c
 * behavior test. Exported under a `__` prefix so it is obvious this is not a
 * production-call surface.
 */
export function __disposePendingSendCoalescingForHMR(): void {
  pendingSendTimers.forEach((timer) => clearTimeout(timer))
  pendingSendTimers.clear()
  pendingSendBuffers.clear()
}

/**
 * V3.3c test introspection — returns the count of currently buffered sessions
 * and outstanding timers. The Maps themselves are intentionally not exported
 * so call sites cannot mutate the coalescing fleet directly.
 */
export function __getPendingSendCoalescingFleetSizeForTesting(): {
  timers: number
  buffers: number
  bufferedKeys: readonly string[]
} {
  return {
    timers: pendingSendTimers.size,
    buffers: pendingSendBuffers.size,
    bufferedKeys: Array.from(pendingSendBuffers.keys()),
  }
}

// Vite HMR dispose — when this module is hot-replaced in dev we must clear any
// outstanding setTimeout handles and discard buffered messages so they don't
// fire against a stale store closure or duplicate-send after reload.
if (typeof import.meta !== 'undefined' && (import.meta as unknown as { hot?: { dispose: (cb: () => void) => void } }).hot) {
  ;(import.meta as unknown as { hot: { dispose: (cb: () => void) => void } }).hot.dispose(() => {
    __disposePendingSendCoalescingForHMR()
  })
}

/**
 * Stage U (PR 1, B.5) — flip a card's renderer-only `localDisabled` flag.
 * Used by the sendMessage cancel hook when the IPC cancel times out: we keep
 * `status:'pending'` (no terminal write) but disable the submit button so
 * the user can't double-submit while the cancel races behind the scenes.
 */
function setCardLocallyDisabled(cardId: string, disabled: boolean): void {
  useAgent.setState((prev) => {
    const messages = prev.messages.map((m) => {
      if (m.id !== cardId || m.type !== 'ask_user_questions' || !m.askUserQuestions) return m
      return {
        ...m,
        askUserQuestions: {
          ...m.askUserQuestions,
          localDisabled: disabled,
        },
      }
    })
    return withActiveSessionMessagesMirror(prev, messages)
  })
}

interface CancelPendingAskUserQuestionsOptions {
  /** Cap the wait at this many ms. After this, log a metric, mark the card
   *  locally disabled, and let the caller proceed. Default 2000ms. */
  timeoutMs?: number
}

/**
 * Stage U (PR 1, B.5) — cancel the most-recent pending ask_user_questions
 * card for the current scope, bounded by `timeoutMs` (default 2s).
 *
 * Algorithm lives in `boundedCancelWithFallback` for testability; this
 * function is the renderer-bound thin wrapper that resolves the target
 * cardId from useAgent state and wires up the side effects.
 *
 * Outcomes:
 *   - normal path (< timeoutMs): cancel IPC returns, card folds to
 *     `cancelled (user_typed_instead | cancel_persist_failed)`.
 *   - timeout path: card is marked `localDisabled = true` so submit is
 *     blocked, metric emitted, caller proceeds. Late cancel arrival still
 *     flips the card to terminal (the fold callback is idempotent — only
 *     applies if status is still 'pending').
 */
async function cancelPendingAskUserQuestionsForCurrentScope(
  options: CancelPendingAskUserQuestionsOptions = {},
): Promise<{ kind: 'no_pending' | 'cancelled' | 'timeout' | 'error'; cardId?: string }> {
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? options.timeoutMs
    : 2000
  const state = useAgent.getState()
  const scopeId = state.currentScopeId
  if (!scopeId) return { kind: 'no_pending' }
  const api = window.electronAPI?.agentInteraction
  if (!api) return { kind: 'no_pending' }

  let targetCardId: string | null = null
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const msg = state.messages[i]
    if (msg.type !== 'ask_user_questions') continue
    if (!msg.askUserQuestions || msg.askUserQuestions.status !== 'pending') continue
    targetCardId = msg.askUserQuestions.cardId
    break
  }
  if (!targetCardId) return { kind: 'no_pending' }
  const cardId = targetCardId

  const outcome = await boundedCancelWithFallback({
    cancelIpc: () => api.cancelAskUserQuestions({ cardId, reason: 'user_typed_instead' }),
    onTimeout: () => {
      setCardLocallyDisabled(cardId, true)
      emitRendererAgentMetric('ask_user_questions_cancel_pre_send_timeout', {
        cardId,
        timeoutMs,
      })
    },
    onCancelLanded: (result) => {
      const r = result as { success: boolean; errorKind?: string }
      const cancelledAt = Date.now()
      useAgent.setState((prev) => {
        const messages = prev.messages.map((m) => {
          if (m.id !== cardId || m.type !== 'ask_user_questions' || !m.askUserQuestions) return m
          // Only fold if still pending — if a previous timeout already locally
          // disabled it and a late cancel arrives, override to cancelled.
          if (m.askUserQuestions.status !== 'pending') return m
          return {
            ...m,
            askUserQuestions: {
              ...m.askUserQuestions,
              status: 'cancelled' as const,
              cancelReason: r.success
                ? 'user_typed_instead'
                : (r.errorKind === 'cancel_persist_failed' ? 'cancel_persist_failed' : 'user_typed_instead'),
              cancelledAt,
              localDisabled: false,
            },
          }
        })
        return withActiveSessionMessagesMirror(prev, messages)
      })
    },
    onCancelError: (err) => {
      // PR 1 B.5 (review patch) — cancel IPC rejected within the 2s window.
      // Without this branch, the old card would stay pending + still
      // submittable while sendMessage proceeds, re-opening the "stale card
      // contaminates new turn" window. Mirror the timeout side effect:
      //   - mark card locally disabled so submit is blocked
      //   - emit metric so the failure is observable (re-uses the timeout
      //     metric since both are "the cancel did not land cleanly before
      //     the new message went out" — we differentiate via reason kind)
      setCardLocallyDisabled(cardId, true)
      emitRendererAgentMetric('ask_user_questions_cancel_pre_send_timeout', {
        cardId,
        timeoutMs,
        kind: 'ipc_rejected',
        errorMessage: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
      })
    },
    timeoutMs,
  })

  if (outcome.kind === 'cancelled') return { kind: 'cancelled', cardId }
  if (outcome.kind === 'timeout') return { kind: 'timeout', cardId }
  return { kind: 'error', cardId }
}

function clearPendingSendBufferState(sessionId?: string | null) {
  let storeStateForKey: AgentState | null = null
  try {
    storeStateForKey = useAgent.getState()
  } catch {
    /* silent-catch: store may be unavailable during module bootstrap; buffer cleanup is best-effort */
    storeStateForKey = null
  }
  const id = sessionId ?? activeSessionKey(storeStateForKey)
  const existingTimer = pendingSendTimers.get(id)
  if (existingTimer) {
    clearTimeout(existingTimer)
    pendingSendTimers.delete(id)
  }
  pendingSendBuffers.delete(id)
  try {
    useAgent.setState((state) => {
      const activeId = activeSessionKey(state)
      const slicePatch = withSessionSlice(state, id, { pendingSendCount: 0, pendingSendFlushAt: null })
      // Mirror onto top-level only when the cleared session matches the
      // currently-active one — otherwise we'd zero out the visible counter
      // for a different session that is still buffering.
      if (activeId === id) {
        return {
          ...slicePatch,
          pendingSendCount: 0,
          pendingSendFlushAt: null,
        }
      }
      return slicePatch
    })
  } catch {
    /* silent-catch: setState may be unavailable during bootstrap; timer cleanup already completed */
  }
}

async function flushPendingSendBuffer(sessionId?: string | null) {
  let storeStateForKey: AgentState | null = null
  try {
    storeStateForKey = useAgent.getState()
  } catch {
    /* silent-catch: store may be unavailable during module bootstrap; flush falls back to active session */
    storeStateForKey = null
  }
  const id = sessionId ?? activeSessionKey(storeStateForKey)
  const buffered = pendingSendBuffers.get(id) ?? null
  clearPendingSendBufferState(id)
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
  sendCoalescingEnabled: true,
  sendCoalescingWindowMs: DEFAULT_SEND_COALESCE_WINDOW_MS,
  pendingSendCount: 0,
  pendingSendFlushAt: null,
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

  // =========================================================================
  // V3.4a — renderer-side session tab actions
  // =========================================================================
  // The renderer enforces the MAX_AGENT_SESSIONS live-session cap on the create
  // side; the main-process orchestrator enforces the SAME shared cap (V3.5) as
  // defense in depth. setActiveSessionId mirrors the
  // per-session `inputValue` onto the top-level field to match the
  // V3.3b.1 read-through-mirror contract; selectors that still read
  // `state.inputValue` keep observing the active session's draft.

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

  createNewSession: () => {
    const state = get()
    // Count only LIVE sessions against the cap. Terminal sessions
    // (done/error/cancelled/closed) are finished work whose conversation is
    // persisted and reachable via history (loadScope re-materializes it on
    // demand), so they must neither block a new conversation nor linger in
    // memory — prune them here. Without this the button silently dead-ends
    // once N conversations exist, because there is no UI to close a session.
    // Returns null only when N sessions are genuinely still live, which the
    // caller surfaces as a disabled "+".
    const liveOrder = state.sessionOrder.filter((sid) => isLiveSession(state, sid))
    if (liveOrder.length >= MAX_AGENT_SESSIONS) return null
    const id = generateSessionId()
    const slice = makeEmptySessionSlice()
    // Keep live sessions plus anything still in flight, prune the rest. The
    // streaming/busy guard matters because a re-activated terminal session can
    // stream again without flipping back to 'live' (non-terminal run phases do
    // not transition the slice state), so isLiveSession alone would mis-prune a
    // session whose run is still going.
    const kept = state.sessionOrder.filter((sid) => {
      const existing = state.sessions[sid]
      return isLiveSession(state, sid) || !!existing?.isStreaming || !!existing?.foregroundBusy
    })
    const nextSessions: Record<string, SessionSlice> = { [id]: slice }
    for (const sid of kept) nextSessions[sid] = state.sessions[sid]
    set({
      sessions: nextSessions,
      sessionOrder: [...kept, id],
      activeSessionId: id,
      // Mirror the fresh slice's defaults onto the top-level fields so the
      // composer/coalescer selectors observe a clean slate for the new tab.
      ...mirrorFromSessionSlice(state, slice),
    })
    return id
  },

  closeSession: (id) => set((state) => {
    if (!state.sessionOrder.includes(id)) return state
    const nextOrder = state.sessionOrder.filter((entry) => entry !== id)
    const nextSessions = { ...state.sessions }
    delete nextSessions[id]
    // Re-route the active session when the closed tab was active: pick the
    // first remaining entry; if the list is now empty, drop activeSessionId
    // to null (the bootstrap state SessionTabs treats as the empty case).
    const nextActiveId = state.activeSessionId === id
      ? (nextOrder[0] ?? null)
      : state.activeSessionId
    const nextSlice = nextActiveId ? normalizeSessionSlice(nextSessions[nextActiveId]) : null
    const mirrorPatch = nextSlice
      ? mirrorFromSessionSlice(state, nextSlice)
      : state.activeSessionId === id
        ? mirrorFromSessionSlice(state, makeEmptySessionSlice())
        : {}
    return {
      sessions: nextSessions,
      sessionOrder: nextOrder,
      activeSessionId: nextActiveId,
      ...mirrorPatch,
    }
  }),

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
        const sessionKey = sessionKeyForScopeId(state, currentScopeId)
        const slice = normalizeSessionSlice(state.sessions[sessionKey])
        const previous = slice.scopeRunStates[currentScopeId] || createEmptyScopeRunState({
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
          ...slice.scopeRunStates,
          [currentScopeId]: nextRun,
        }
        return withSessionSliceAndActiveMirror(state, sessionKey, {
          scopeRunStates: nextScopeRunStates,
          streamingMessageId: null,
          streamingRequestId: null,
          isStreaming: false,
          foregroundBusy: false,
          composerLocked: false,
        })
      })
    } else {
      set((state) => ({
        ...withSessionSliceAndActiveMirror(state, activeSessionKey(state), {
          isStreaming: false,
          foregroundBusy: false,
          composerLocked: false,
          streamingMessageId: null,
          streamingRequestId: null,
        }),
        toolTraceStatus: 'cancelled',
      }))
    }
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.agent.kill(currentAgent, currentScopeId || undefined).catch(console.error)
    }
    // Stage X2.6 — user-initiated stop clears the infrastructure
    // watchdog for the active scope (any in-flight requestId for this
    // scope).
    if (currentScopeId) {
      agentRuntimeDriver.clearInfrastructureWatchdog(currentScopeId, null)
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

    set((state) => ({
      ...withSessionSliceAndActiveMirror(state, activeSessionKey(state), {
        messages: restored,
        inputValue: undoneContent,
        isStreaming: false,
        foregroundBusy: false,
        composerLocked: false,
        streamingMessageId: null,
        streamingRequestId: null,
        scopeRunStates: {},
        taskDisclosureState: {},
      }),
      pendingContinuationIntent: null,
      pendingContinuationDraftAnchor: null,
      toolTrace: [],
      toolTraceStatus: 'idle',
    }))
  },

  newSession: () => {
    const { currentAgent } = get()
    const agentData = get().agents.find(a => a.name === currentAgent)
    const displayName = agentData?.displayName || '管家'
    const fallbackScopeId = `conv-${generateId('local')}`
    const nextSessionId = generateSessionId()
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
    const nextMessages: AgentMessage[] = [
      {
        id: `welcome-${Date.now()}`,
        agent: currentAgent,
        content: `你好！我是 Ready 的${displayName} Agent。新的对话已开始，有什么我可以帮你的？`,
        type: 'agent',
        timestamp: new Date()
      }
    ]

    set((state) => {
      const previousActiveSessionId = state.activeSessionId
      const nextSessions = { ...state.sessions }
      const sessionOrder = previousActiveSessionId && state.sessionOrder.includes(previousActiveSessionId)
        ? state.sessionOrder.map((entry) => entry === previousActiveSessionId ? nextSessionId : entry)
        : state.sessionOrder
      const nextScopeRunStates = {
        [fallbackScope.id]: createEmptyScopeRunState({ scopeId: fallbackScope.id, agent: currentAgent }),
      }
      return {
        sessions: {
          ...nextSessions,
          [nextSessionId]: {
            ...makeEmptySessionSlice(fallbackScope.id),
            messages: nextMessages,
            inputValue: '',
            scopeRunStates: nextScopeRunStates,
            taskDisclosureState: {},
          },
        },
        activeSessionId: nextSessionId,
        sessionOrder,
        messages: nextMessages,
        isStreaming: false,
        foregroundBusy: false,
        composerLocked: false,
        streamingMessageId: null,
        streamingRequestId: null,
        sessionId: nextSessionId,
        conversationId: fallbackScope.id,
        currentScopeId: fallbackScope.id,
        currentScope: fallbackScope,
        scopes: [fallbackScope, ...state.scopes.filter((item) => item.id !== fallbackScope.id)],
        conversations: [mapScopeToConversation(fallbackScope), ...state.conversations.filter((item) => item.id !== fallbackScope.id)],
        scopeRunStates: nextScopeRunStates,
        toolTrace: [],
        toolTraceStatus: 'idle',
        attachments: [],
        filePool: [],
        pendingContinuationIntent: null,
        pendingContinuationDraftAnchor: null,
        taskDisclosureState: {},
      }
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
          useAgent.setState((state) => ({
            ...withActiveSessionConversationMirror(state, scope.id),
            currentScopeId: scope.id,
            currentScope: scope,
            conversationId: scope.id,
            scopes: updatedScopes,
            conversations: updatedScopes.map(mapScopeToConversation),
          }))
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
      const scopes: ConversationScope[] = result.success && Array.isArray(result.data)
        ? result.data as unknown as ConversationScope[]
        : []
      if (scopes.length === 0) return
      const previousScopeId = get().currentScopeId
      const currentScope = scopes.find((scope) => scope.id === previousScopeId) || scopes[0] || null
      set((state) => {
        const activeRunState = getScopeRunStateForScope(state, currentScope?.id || null)
        const sessionKey = activeSessionKey(state)
        const slice = normalizeSessionSlice(state.sessions[sessionKey])
        const nextScopeRunStates = currentScope?.id && activeRunState
          ? { ...slice.scopeRunStates, [currentScope.id]: activeRunState }
          : slice.scopeRunStates
        return {
        ...withSessionSliceAndActiveMirror({ ...state, scopes }, sessionKey, {
          conversationId: currentScope?.id || null,
          scopeRunStates: nextScopeRunStates,
          isStreaming: isStreamingScopeRunState(activeRunState),
          foregroundBusy: isForegroundBusyScopeRunState(activeRunState),
          composerLocked: isForegroundBusyScopeRunState(activeRunState),
          streamingRequestId: activeRunState?.requestId || null,
        }),
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
      const currentMessages = get().currentScopeId === scopeId ? get().messages : []
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
        const sessionKey = activeSessionKey(state)
        const slice = normalizeSessionSlice(state.sessions[sessionKey])
        const nextScopeRunStates = activeRunState
          ? { ...slice.scopeRunStates, [scopeId]: activeRunState }
          : slice.scopeRunStates
        return {
        ...withSessionSliceAndActiveMirror(state, sessionKey, {
          messages,
          conversationId: scopeId,
          scopeRunStates: nextScopeRunStates,
          isStreaming: isStreamingScopeRunState(activeRunState),
          foregroundBusy: isForegroundBusyScopeRunState(activeRunState),
          composerLocked: isForegroundBusyScopeRunState(activeRunState),
          streamingMessageId: null,
          streamingRequestId: activeRunState?.requestId || null,
        }),
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
      return { success: false, shouldClearInput: false, preserveInput: true, errorKind: 'empty_input' }
    }

    // agent_interaction — if there's a pending ask_user_questions card in
    // this scope, cancel it BEFORE pushing the new prose into the model.
    // The cancel reason 'user_typed_instead' tells the tool handler to
    // return errorKind=user_skipped so the model treats it as "user
    // replied with prose" instead of a hard failure.
    //
    // PR 1 B.5 — bounded await (2000ms hard cap). On timeout the old card is
    // locally disabled (`localDisabled = true`) so the user can't double-submit
    // while the late cancel races behind the scenes. We then proceed to send
    // the new message — the user must never be blocked on a stuck IPC.
    await cancelPendingAskUserQuestionsForCurrentScope({ timeoutMs: 2000 })

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
      const sessionKey = activeSessionKey(stateBeforeSend)
      const existingBuffer = pendingSendBuffers.get(sessionKey) ?? null
      const sameBufferedTarget =
        existingBuffer &&
        existingBuffer.scopeId === targetScopeId &&
        existingBuffer.agent === targetAgent

      if (existingBuffer && !sameBufferedTarget) {
        await flushPendingSendBuffer(sessionKey)
      }

      let buffer = pendingSendBuffers.get(sessionKey) ?? null
      if (buffer && sameBufferedTarget) {
        buffer.parts.push(normalizedContent)
      } else {
        buffer = {
          scopeId: targetScopeId,
          agent: targetAgent,
          parts: [normalizedContent],
        }
        pendingSendBuffers.set(sessionKey, buffer)
      }

      const existingTimer = pendingSendTimers.get(sessionKey)
      if (existingTimer) clearTimeout(existingTimer)
      const flushAt = Date.now() + stateBeforeSend.sendCoalescingWindowMs
      pendingSendTimers.set(
        sessionKey,
        setTimeout(() => {
          void flushPendingSendBuffer(sessionKey)
        }, stateBeforeSend.sendCoalescingWindowMs),
      )

      const nextCount = buffer.parts.length
      set((state) => {
        const activeId = activeSessionKey(state)
        const slicePatch = withSessionSlice(state, sessionKey, {
          pendingSendCount: nextCount,
          pendingSendFlushAt: flushAt,
        })
        // Mirror to top-level mirror only when the buffered session is the
        // currently-active one (so ChatInput's coalescing indicator tracks the
        // session the composer is bound to).
        if (activeId === sessionKey) {
          return {
            ...slicePatch,
            pendingSendCount: nextCount,
            pendingSendFlushAt: flushAt,
          }
        }
        return slicePatch
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

    let activeAgentName = currentAgent
    let prerouteSuggestion: { targetAgentId: string; tier: 'state' | 'precedent' } | null = null
    if (!currentScope && !currentScopeId && normalizedContent && typeof window !== 'undefined' && window.electronAPI?.agent?.sessionPrerouteEvaluate) {
      const preroute = await window.electronAPI.agent.sessionPrerouteEvaluate(normalizedContent).catch(() => null)
      const prerouteData = preroute?.success ? preroute.data : null
      const decision = prerouteData?.decision ?? null
      if (prerouteData && prerouteData.effect !== 'none' && decision && decision.tier !== 'fallback') {
        if (prerouteData.effect === 'route') {
          activeAgentName = decision.targetAgentId
          set({ currentAgent: activeAgentName })
        } else {
          prerouteSuggestion = { targetAgentId: decision.targetAgentId, tier: decision.tier }
        }
      }
    }

    let scope = currentScope
    let scopeId = currentScopeId
    let localScopeBootstrapAttempted = false
    if ((!scope || !scopeId) && typeof window !== 'undefined' && window.electronAPI?.agent?.createLocalScope !== undefined) {
      localScopeBootstrapAttempted = true
      const created = await callCreateLocalScopeWithMetric(
        activeAgentName,
        null,
        'sendMessage_no_scope',
        () => window.electronAPI!.agent!.createLocalScope(activeAgentName),
      )
      if (created?.success && created.data) {
        const nextScope = created.data as unknown as ConversationScope
        scope = nextScope
        scopeId = nextScope.id
        const updatedScopes = [nextScope, ...get().scopes.filter((item) => item.id !== nextScope.id)]
        set((state) => ({
          ...withActiveSessionConversationMirror(state, nextScope.id),
          currentScopeId: nextScope.id,
          currentScope: nextScope,
          conversationId: nextScope.id,
          scopes: updatedScopes,
          conversations: updatedScopes.map(mapScopeToConversation),
        }))
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
        activeAgentName,
        scopeId ?? null,
        'sendMessage_local_scope_missing',
        () => window.electronAPI!.agent!.createLocalScope(activeAgentName, scopeId || undefined),
      )
      if (created?.success && created.data) {
        const nextScope = created.data as unknown as ConversationScope
        scope = nextScope
        scopeId = nextScope.id
        const updatedScopes = [nextScope, ...get().scopes.filter((item) => item.id !== nextScope.id)]
        set((state) => ({
          ...withActiveSessionConversationMirror(state, nextScope.id),
          currentScopeId: nextScope.id,
          currentScope: nextScope,
          conversationId: nextScope.id,
          scopes: updatedScopes,
          conversations: updatedScopes.map(mapScopeToConversation),
        }))
      }
    }
    if (
      scope &&
      scope.sourceKind === 'local' &&
      scope.agent !== activeAgentName &&
      typeof window !== 'undefined' &&
      window.electronAPI?.agent?.createLocalScope !== undefined
    ) {
      localScopeBootstrapAttempted = true
      const created = await callCreateLocalScopeWithMetric(
        activeAgentName,
        scopeId ?? null,
        'sendMessage_agent_mismatch',
        () => window.electronAPI!.agent!.createLocalScope(activeAgentName),
      )
      if (created?.success && created.data) {
        const nextScope = created.data as unknown as ConversationScope
        scope = nextScope
        scopeId = nextScope.id
        const updatedScopes = [nextScope, ...get().scopes.filter((item) => item.id !== nextScope.id)]
        set((state) => ({
          ...withActiveSessionConversationMirror(state, nextScope.id),
          currentScopeId: nextScope.id,
          currentScope: nextScope,
          conversationId: nextScope.id,
          scopes: updatedScopes,
          conversations: updatedScopes.map(mapScopeToConversation),
        }))
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
        set((state) => ({
          ...withActiveSessionConversationMirror(state, nextScope.id),
          currentScopeId: nextScope.id,
          currentScope: nextScope,
          conversationId: nextScope.id,
          scopes: updatedScopes,
          conversations: updatedScopes.map(mapScopeToConversation),
        }))
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
        agent: activeAgentName,
        failedCount: composedInput.diagnostics.inputFailedCount,
      })
      emitRendererAgentMetric('renderer_friendly_error_surfaced', {
        scopeId: activeScopeId,
        agent: activeAgentName,
        errorKind: 'attachment_unavailable',
      })
      addMessage({
        id: `error-${Date.now()}`,
        agent: activeAgentName,
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
      filePool: state.filePool,
    }))

    if (prerouteSuggestion) {
      addMessage({
        id: generateId('system'),
        agent: activeAgentName,
        content: prerouteSuggestion.tier === 'state'
          ? `这条消息看起来和进行中的任务有关，建议交给 ${prerouteSuggestion.targetAgentId} 继续处理。`
          : `这条消息命中了专项处理经验，建议交给 ${prerouteSuggestion.targetAgentId} 处理。`,
        type: 'system',
        timestamp: new Date(),
      })
    }

    // Build display content (include @[filename] references)
    const userMsgId = generateId('msg')
    const userTimestamp = new Date()
    addMessage({
      id: userMsgId,
      agent: activeAgentName,
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
        // fire-and-forget: persist the auto-generated conversation title; the optimistic in-memory update right below keeps the UI consistent regardless of IPC outcome.
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
          agent: activeAgentName,
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
      await window.electronAPI.agent.kill(activeAgentName, activeScopeId).catch(console.error)
    }

    setIsStreaming(true)
    const requestId = generateId('req')

    const responseId = generateId('response')
    addMessage({
      id: responseId,
      agent: activeAgentName,
      content: '',
      type: 'agent',
      timestamp: new Date(),
      meta: { transient: true },
    })
    set((state) => {
      const sessionKey = sessionKeyForScopeId(state, activeScopeId)
      const slice = normalizeSessionSlice(state.sessions[sessionKey])
      return withSessionSliceAndActiveMirror(state, sessionKey, {
        streamingMessageId: responseId,
        streamingRequestId: requestId,
        isStreaming: true,
        foregroundBusy: true,
        composerLocked: true,
        scopeRunStates: {
          ...slice.scopeRunStates,
          [activeScopeId]: {
          ...createEmptyScopeRunState({
            scopeId: activeScopeId,
            agent: activeAgentName,
            requestId,
            phase: 'planning',
            responseMessageId: responseId,
          }),
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      })
    })

    // Stage X2.6 — arm the infrastructure-timeout watchdog. The runtime
    // driver auto-clears the watchdog on any terminal IPC (onError /
    // onStream done / onScopeRunEvent terminal phase). If 60s elapses
    // with no terminal event of any kind (e.g. main crashed, IPC dropped,
    // request never reached provider), the watchdog unlocks the
    // originating session and surfaces a "Ready lost track of this
    // request; recovered automatically" toast. See plan §7.2 last
    // paragraph.
    agentRuntimeDriver.armInfrastructureWatchdog(activeScopeId, requestId)

    try {
      if (typeof window !== 'undefined' && window.electronAPI) {
        const finalMessage = composedInput.message
        const workspaceState = useWorkspace.getState()
        const workspaceRoots = computeDesiredRoots({
          workspaceRoot: workspaceState.workspaceRoot,
          pinnedFolders: workspaceState.pinnedFolders,
        })

        const sendWithCurrentScope = async (): Promise<AgentSendResult> => (
          window.electronAPI.agent.sendScoped
            ? window.electronAPI.agent.sendScoped({
              scopeId: activeScopeId,
              agent: activeScope.agent,
              message: finalMessage,
              requestId,
              ...(workspaceRoots.length > 0 ? { workspaceRoots } : {}),
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
            : window.electronAPI.agent.send(activeAgentName, finalMessage, activeScopeId, requestId)
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
              set((state) => ({
                ...withActiveSessionConversationMirror(state, nextScope.id),
                currentScopeId: nextScope.id,
                currentScope: nextScope,
                conversationId: nextScope.id,
                scopes: updatedScopes,
                conversations: updatedScopes.map(mapScopeToConversation),
              }))
            }
          }
          result = await sendWithCurrentScope()
        }

        if (!result.success) {
          // Stage X2.6 — local-failure unwind: the IPC returned an
          // immediate failure (no terminal-event flow). Clear the
          // infrastructure watchdog explicitly since the auto-clear
          // path only fires on IPC terminal events.
          agentRuntimeDriver.clearInfrastructureWatchdog(activeScopeId, requestId)
          if (get().streamingRequestId !== requestId) {
            return { success: false, shouldClearInput: false, preserveInput: true, errorKind: result.errorKind || 'stale_request' }
          }
          const messageStatus = result.persistence?.message || null
          const friendly = mapBackendErrorToFriendly({
            error: result.error || undefined,
            errorKind: result.errorKind || undefined,
          })
          const persistedUserMessage = messageStatus === 'persisted'
          const failureTerminalReason = normalizeTerminalReason(result.errorKind)
          const existingResponse = get().messages.find((message) => message.id === responseId) || null
          const canKeepExistingResponse = Boolean(
            failureTerminalReason === 'adjudication_degraded'
            && String(existingResponse?.content || '').trim(),
          )
          const isDegradedCompletion = canKeepExistingResponse
          emitRendererAgentMetric(
            persistedUserMessage
              ? 'renderer_send_failed_after_persisted_message'
              : 'renderer_send_persistence_failed',
            {
              scopeId: activeScopeId,
              agent: activeAgentName,
              errorKind: result.errorKind || 'unknown',
              messageStatus,
              attachmentStatus: result.persistence?.attachments || null,
            },
          )
          emitRendererAgentMetric('renderer_friendly_error_surfaced', {
            scopeId: activeScopeId,
            agent: activeAgentName,
            errorKind: result.errorKind || 'unknown',
          })
          set((state) => {
            const messages = state.messages.map(m =>
              m.id === responseId
                ? canKeepExistingResponse
                  ? m
                  : { ...m, content: friendly.friendlyMessage, type: 'system' as const }
                : m
            )
            const sessionKey = sessionKeyForScopeId(state, activeScopeId)
            const slice = normalizeSessionSlice(state.sessions[sessionKey])
            const nextPhase = isDegradedCompletion ? 'done' as const : 'error' as const
            return {
              ...withSessionSliceAndActiveMirror(state, sessionKey, {
                messages,
                isStreaming: false,
                foregroundBusy: false,
                composerLocked: false,
                streamingMessageId: null,
                streamingRequestId: null,
                scopeRunStates: {
                  ...slice.scopeRunStates,
                  [activeScopeId]: {
                    ...(slice.scopeRunStates[activeScopeId] || {
                      scopeId: activeScopeId,
                      agent: activeAgentName,
                      requestId,
                      toolTrace: [],
                      startedAt: new Date().toISOString(),
                    }),
                    requestId,
                    phase: nextPhase,
                    terminalReason: failureTerminalReason,
                    updatedAt: new Date().toISOString(),
                    error: isDegradedCompletion ? null : friendly.friendlyMessage,
                  },
                },
              }),
              attachments: result.persistence?.message === 'failed' ? currentAttachments : state.attachments,
              toolTraceStatus: isDegradedCompletion ? 'done' : 'error',
            }
          })
          const preserveInput = !isDegradedCompletion && result.persistence?.message !== 'persisted'
          return {
            success: isDegradedCompletion,
            shouldClearInput: !preserveInput,
            preserveInput,
            errorKind: result.errorKind || 'unknown',
          }
        }
        const backendResponseText = typeof result.responseText === 'string'
          ? result.responseText.trim()
          : ''
        if (backendResponseText) {
          get().appendToMessage(responseId, backendResponseText)
        }
        agentRuntimeDriver.completeScopeRunAfterSendSuccess(activeScopeId, requestId, {
          backendRecoveredResponse: Boolean(backendResponseText),
        })
        set({ pendingContinuationIntent: null, pendingContinuationDraftAnchor: null })
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
              set((state) => withSessionSliceAndActiveMirror(state, activeSessionKey(state), {
                isStreaming: false,
                foregroundBusy: false,
                composerLocked: false,
                streamingMessageId: null,
                streamingRequestId: null,
              }))
            }
          }
        }, 30)
        return { success: true, shouldClearInput: true, preserveInput: false }
      }
    } catch (error) {
      // Stage X2.6 — local-failure unwind: the IPC threw synchronously
      // (e.g. preload not available, network refused before IPC). Clear
      // the watchdog so it doesn't fire 60s later after a long-since
      // failed send.
      agentRuntimeDriver.clearInfrastructureWatchdog(activeScopeId, requestId)
      if (get().streamingRequestId !== requestId) {
        return { success: false, shouldClearInput: false, preserveInput: true, errorKind: 'stale_request' }
      }
      const rawError = error instanceof Error ? error.message : String(error)
      const friendly = mapBackendErrorToFriendly({ error: rawError })
      emitRendererAgentMetric('renderer_friendly_error_surfaced', {
        scopeId: activeScopeId,
        agent: activeAgentName,
        errorKind: 'unknown',
      })
      set((state) => {
        const messages = state.messages.map(m =>
          m.id === responseId
            ? { ...m, content: friendly.friendlyMessage, type: 'system' as const }
            : m
        )
        const sessionKey = sessionKeyForScopeId(state, activeScopeId)
        const slice = normalizeSessionSlice(state.sessions[sessionKey])
        return {
          ...withSessionSliceAndActiveMirror(state, sessionKey, {
            messages,
            isStreaming: false,
            foregroundBusy: false,
            composerLocked: false,
            streamingMessageId: null,
            streamingRequestId: null,
            scopeRunStates: {
              ...slice.scopeRunStates,
              [activeScopeId]: {
                ...(slice.scopeRunStates[activeScopeId] || {
                  scopeId: activeScopeId,
                  agent: activeAgentName,
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
          }),
          toolTraceStatus: 'error',
        }
      })
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

export function initAgentInteractionListeners(): () => void {
  const api = typeof window !== 'undefined' ? window.electronAPI?.agentInteraction : null
  if (!api) return () => {}
  // Hydrate any pending cards left from a mid-flight renderer reload.
  // fire-and-forget: bootstrap-time hydration; if it fails, the live onAskUserQuestionsCard subscription below will deliver the next card and the user can re-trigger any missing one.
  api.listPendingAskUserQuestions().then((result) => {
    if (!result || !result.success || !Array.isArray(result.data)) return
    const state = useAgent.getState()
    const agent = state.currentAgent
    const existingIds = new Set(state.messages.map((m) => m.id))
    const additions: AgentMessage[] = []
    for (const card of result.data) {
      if (existingIds.has(card.cardId)) continue
      // Hydrate only into the current scope to avoid leaking cards from a
      // different conversation into the active view. The DB row already
      // belongs to the right conversation via conversation_id.
      if (card.conversationId && state.currentScopeId && card.conversationId !== state.currentScopeId) continue
      additions.push(makeMessageFromPushedCard({
        cardId: card.cardId,
        sessionId: state.currentScopeId,
        conversationId: card.conversationId,
        questions: card.questions as AskUserQuestionsCardState['questions'],
        askedAt: card.askedAt,
      }, agent))
    }
    if (additions.length > 0) {
      useAgent.setState((prev) => {
        const messages = [...prev.messages, ...additions].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
        return withActiveSessionMessagesMirror(prev, messages)
      })
    }
    // fire-and-forget: hydrate-failure swallow — see the matching comment on listPendingAskUserQuestions above; the live subscription is the canonical card delivery path.
  }).catch(() => { /* ignore hydrate failures */ })

  const unsubscribePush = api.onAskUserQuestionsCard((event) => {
    // V3.3d — route through the 3-level fallback chain instead of writing
    // directly to top-level `messages`. The pre-V3.3d guard
    // (`event.conversationId !== state.currentScopeId → drop`) is replaced
    // by `routeCardToSession`, which preserves the "do not bleed across
    // active scope" intent while also serving multi-session UIs: when the
    // target session is not the active one, the card lands in that
    // session's slice and surfaces when the user switches; only the
    // double-null + no-active case drops outright.
    const decision = routeCardToSession(useAgent.getState(), {
      sessionId: event.sessionId,
      conversationId: event.conversationId,
      cardId: event.cardId,
    })
    if (!decision.targetSessionId) {
      recordOrphanedCard(event.cardId, 'no-active-session-and-keys-null')
      return
    }
    if (decision.metric) recordCardFallback(event.cardId, decision.metric)

    const agent = useAgent.getState().currentAgent
    const message = makeMessageFromPushedCard({
      cardId: event.cardId,
      sessionId: decision.targetSessionId,
      conversationId: event.conversationId,
      questions: event.questions as AskUserQuestionsCardState['questions'],
      askedAt: event.askedAt,
    }, agent)

    useAgent.setState((prev) => {
      // Lazily create the target slice (e.g. when the card lands in a
      // session whose slice hasn't been touched yet) so the conversationId
      // backing field is populated for future lookups.
      const existingSlice = prev.sessions[decision.targetSessionId!]
      const existingMessages = existingSlice?.messages ?? []
      const nextMessages = existingMessages.some((m) => m.id === message.id)
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
      const sessionsPatch: Pick<AgentState, 'sessions'> = {
        sessions: {
          ...prev.sessions,
          [decision.targetSessionId!]: nextSlice,
        },
      }
      // Mirror into top-level `messages` only when the routed target is the
      // active session. Background-session cards stay parked in that slice
      // and surface when the user switches tabs.
      //
      // Compare against `activeSessionKey(prev)`, NOT the raw `activeSessionId`
      // field: top-level `messages` is the mirror of `sessions[activeSessionKey]`,
      // and `activeSessionKey` falls back to `sessionId`/`PRIMARY_SESSION_KEY`
      // when `activeSessionId` is null (the normal state after `loadScope`,
      // which never assigns `activeSessionId`). Comparing against the raw
      // null field left the routed card stranded in the active slice with no
      // top-level mirror, so it only surfaced once an unrelated active-slice
      // write (e.g. expanding a tool-trace section) re-ran the mirror.
      if (decision.targetSessionId === activeSessionKey(prev)) {
        return {
          ...sessionsPatch,
          messages: nextMessages,
        }
      }
      return sessionsPatch
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
    // ignore — tests may install a minimal global window.
  }
  const offRuntime = agentRuntimeDriver.initAgentListeners()
  const offAgentInteraction = initAgentInteractionListeners()
  return () => {
    try { window.removeEventListener('ready:agent-registry-changed', onAgentRegistryChanged) } catch { /* ignore */ }
    try { offRuntime() } catch { /* ignore */ }
    try { offAgentInteraction() } catch { /* ignore */ }
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
