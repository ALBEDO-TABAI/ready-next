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
import { boundedCancelWithFallback } from '../modules/agent/boundedCancelWithFallback'
import { createAgentRuntimeDriver, syncActiveScopeRunAliases } from '../modules/agent/runtimeDriver'
import { installAgentPanelTestHarness } from '../modules/agent/agentPanelTestHarness'
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
  AskUserQuestionsCardState,
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
  AskUserQuestionsCardState,
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
  childRunId?: string
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

/**
 * Stage V V3.3a bootstrap half-step (delivered alongside V3.3c).
 *
 * Per-session slice of state that today only carries the coalescing
 * indicators. Subsequent V3.3b passes will move messages / inputValue /
 * streaming flags / scopeRunStates / taskProjections into this slice as
 * separate atomic changes. Until then, top-level `pendingSendCount` and
 * `pendingSendFlushAt` are kept as a read-through mirror so existing
 * ChatPanel/ChatInput selectors and the agent-panel test harness keep
 * working without renderer-side edits.
 *
 * V3.3d adds `state` + `conversationId` so the listener-side direct-setState
 * routing path (`routeCardToSession`) can validate a pushed card's
 * `sessionId` is still live, and fall back via conversationId when the
 * push payload's sessionId is null / stale / unknown.
 */
export type SessionSliceState = 'live' | 'done' | 'error' | 'cancelled' | 'closed'

const TERMINAL_SESSION_STATES: ReadonlySet<SessionSliceState> = new Set([
  'done',
  'error',
  'cancelled',
  'closed',
])

export interface SessionSlice {
  pendingSendCount: number
  pendingSendFlushAt: number | null
  /** V3.3d — terminal exclusion set drives `isLiveSession`. */
  state: SessionSliceState
  /** V3.3d — backing field for `lookupSessionByConversation`. */
  conversationId: string | null
  /**
   * V3.3b.1 — per-session composer draft. The top-level `inputValue` field
   * is a read-through mirror of `sessions[activeSessionId].inputValue`;
   * consumers (ChatPanel/ChatInput/ChatMessages/ChatAttachments) still read
   * `state.inputValue` and will be migrated in a later V3.3b.X step.
   */
  inputValue: string
}

function makeEmptySessionSlice(conversationId: string | null = null): SessionSlice {
  return {
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    state: 'live',
    conversationId,
    inputValue: '',
  }
}

interface AgentState {
  agents: Agent[]
  messages: AgentMessage[]
  currentAgent: string
  inputValue: string
  pendingContinuationIntent: PendingContinuationIntent | null
  pendingContinuationDraftAnchor: string | null
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
  /**
   * V3.3c — top-level mirror of `sessions[activeSessionId].pendingSendCount`.
   * Source of truth lives in `sessions[id]`; the top-level value is rewritten
   * alongside every slice write so existing ChatPanel/ChatInput selectors and
   * the agent-panel test harness keep observing the active-session value.
   */
  pendingSendCount: number
  /** V3.3c — top-level mirror of `sessions[activeSessionId].pendingSendFlushAt`. */
  pendingSendFlushAt: number | null
  /** V3.3a bootstrap — per-sessionId slice store. */
  sessions: Record<string, SessionSlice>
  /** V3.3a bootstrap — active sessionId selector; nullable until first write. */
  activeSessionId: string | null
  /**
   * V3.4a — render-order list for session tabs. Source of truth for tab
   * ordering and the renderer-side ≤3 hard limit. Entries appear here in
   * the order they were created via `createNewSession`; `closeSession`
   * removes the matching id. The list is empty in the cold-start state so
   * the SessionTabs strip renders nothing (V6 fixture-compatible).
   */
  sessionOrder: string[]
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
  /**
   * V3.4a — set the active session and mirror the per-session draft
   * (`inputValue`) onto the top-level field so existing ChatInput selectors
   * keep observing the active session's value. No-op if `id` is not present
   * in `sessionOrder` (defensive: prevents activating a closed session).
   */
  setActiveSessionId: (id: string) => void
  /**
   * V3.4a — create a fresh session slice, append its id to `sessionOrder`,
   * and switch the active session to it. Rejected (no-op) when the
   * renderer-side hard limit is reached (`sessionOrder.length >= 3`); the
   * caller can re-read `sessionOrder.length` after the call to detect this.
   * Returns the newly created session id, or `null` if rejected.
   */
  createNewSession: () => string | null
  /**
   * V3.4a — drop a session from the tab strip. Removes the entry from
   * `sessions` and `sessionOrder`; when `id === activeSessionId`, switches
   * the active session to the first remaining tab (or `null` if none).
   * No-op if `id` is not present.
   */
  closeSession: (id: string) => void
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
const CONTINUATION_DRAFT_PATTERN =
  /^(?:请|请你|麻烦你)?(?:(?:继续(?:当前|这个|刚才|上次|任务|处理|执行|完成|一下)?|接着(?:来|做|处理|执行|完成)?|恢复(?:上次|刚才|当前)?|重试(?:一次|一下)?|重试刚才的任务|再试(?:一次|一下)?|再来(?:一次|一下)?|重新(?:跑|执行|做|开始)(?:一次|一下|一轮|一遍)?|从头(?:跑|来|做|开始|重新)(?:一次|一下|一轮|一遍)?|确认继续|暂不继续|我已完成|人工步骤已完成|请重试刚才的任务)(?:$|[\s，。,.!?！？])|继续后台任务(?:$|\s)|(?:continue|retry|resume)(?:$|\s))/i

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

/** Sentinel key when the store has no `sessionId` yet (very early bootstrap). */
const PRIMARY_SESSION_KEY = '__primary__'

function activeSessionKey(state: AgentState | null | undefined): string {
  if (!state) return PRIMARY_SESSION_KEY
  return state.activeSessionId || state.sessionId || PRIMARY_SESSION_KEY
}

/**
 * V3.3a read-side selector. Falls back to the active session, then primary,
 * then a zero slice so consumers never observe `undefined` during bootstrap
 * (e.g. before the store has finished initialising on first render).
 */
export function getSessionSlice(state: AgentState, sessionId?: string | null): SessionSlice {
  const id = sessionId ?? state.activeSessionId ?? state.sessionId ?? PRIMARY_SESSION_KEY
  return state.sessions[id] ?? makeEmptySessionSlice()
}

/** V3.3a write-side helper used by the coalescing path. */
function withSessionSlice(
  state: AgentState,
  sessionId: string,
  patch: Partial<SessionSlice>,
): Pick<AgentState, 'sessions'> {
  const current = state.sessions[sessionId] ?? makeEmptySessionSlice()
  return {
    sessions: {
      ...state.sessions,
      [sessionId]: { ...current, ...patch },
    },
  }
}

// =============================================================================
// V3.3d listener-side direct-setState routing helpers
// =============================================================================

/**
 * Returns true iff `id` resolves to a session slice that exists and is not
 * in a terminal state (`done` / `error` / `cancelled` / `closed`).
 *
 * `lookupSessionByConversation` uses the same exclusion set so a terminated
 * session never re-enters via the conversationId fallback (v8 codex round-7).
 */
export function isLiveSession(
  state: AgentState,
  id: string | null | undefined,
): id is string {
  if (!id) return false
  const slice = state.sessions[id]
  return !!slice && !TERMINAL_SESSION_STATES.has(slice.state)
}

/**
 * Returns the id of the most-recent live session whose `slice.conversationId`
 * matches the given conversationId. When multiple live sessions match, the
 * one whose id equals `state.activeSessionId` is preferred; otherwise the
 * first encountered is returned. Returns `null` when no live match exists.
 */
export function lookupSessionByConversation(
  state: AgentState,
  conversationId: string | null | undefined,
): string | null {
  if (!conversationId) return null
  const matches: string[] = []
  for (const [id, slice] of Object.entries(state.sessions)) {
    if (slice.conversationId !== conversationId) continue
    if (TERMINAL_SESSION_STATES.has(slice.state)) continue
    matches.push(id)
  }
  if (matches.length === 0) return null
  const preferred = matches.find((id) => id === state.activeSessionId)
  return preferred ?? matches[0]
}

/**
 * V3.3d metric stubs. Today they emit a `console.warn` in non-test
 * environments and bump a module-level counter exported for behavior tests.
 * Wiring to the real renderer metrics infra is a deliberate follow-up so
 * this PR remains a pure routing change.
 */
interface CardRoutingMetricsState {
  orphaned: Array<{ cardId: string; reason: string; at: number }>
  fallback: Array<{ cardId: string; reason: string; at: number }>
}

const cardRoutingMetrics: CardRoutingMetricsState = {
  orphaned: [],
  fallback: [],
}

function recordOrphanedCard(cardId: string, reason: string): void {
  cardRoutingMetrics.orphaned.push({ cardId, reason, at: Date.now() })
}

function recordCardFallback(cardId: string, reason: string): void {
  cardRoutingMetrics.fallback.push({ cardId, reason, at: Date.now() })
}

/** V3.3d test introspection — read-only snapshot of the routing metrics. */
export function __getCardRoutingMetricsForTesting(): {
  orphaned: ReadonlyArray<{ cardId: string; reason: string; at: number }>
  fallback: ReadonlyArray<{ cardId: string; reason: string; at: number }>
} {
  return {
    orphaned: cardRoutingMetrics.orphaned.slice(),
    fallback: cardRoutingMetrics.fallback.slice(),
  }
}

/** V3.3d test introspection — reset between behavior test cases. */
export function __resetCardRoutingMetricsForTesting(): void {
  cardRoutingMetrics.orphaned.length = 0
  cardRoutingMetrics.fallback.length = 0
}

export interface CardRoutingDecision {
  targetSessionId: string | null
  metric: string | null
}

/**
 * Three-level fallback chain used by `initAgentInteractionListeners` to route
 * a pushed ask_user_questions card to the right session slice:
 *
 *   1. `event.sessionId` — accepted only when `isLiveSession` is true
 *   2. `lookupSessionByConversation(event.conversationId)` — terminated
 *      sessions are filtered out by the same exclusion set
 *   3. `state.activeSessionId` — last-resort so a live card still renders
 *
 * Returns `targetSessionId = null` only when all three resolve to null —
 * i.e. there is no live session and no active session to surface into. The
 * caller drops the card and records an orphan metric in that case.
 *
 * When `targetSessionId !== event.sessionId` we annotate the metric with
 * the reason the original `event.sessionId` was rejected: `null-sessionId`,
 * `unknown-session`, or `stale-or-terminated-session`.
 */
export function routeCardToSession(
  state: AgentState,
  event: { sessionId: string | null; conversationId: string | null; cardId: string },
): CardRoutingDecision {
  const validSessionId = isLiveSession(state, event.sessionId) ? event.sessionId : null
  const byConversation = lookupSessionByConversation(state, event.conversationId)
  const targetSessionId = validSessionId ?? byConversation ?? state.activeSessionId

  if (!targetSessionId) {
    return { targetSessionId: null, metric: 'no-active-session-and-keys-null' }
  }
  if (targetSessionId !== event.sessionId) {
    const reason =
      !event.sessionId
        ? 'null-sessionId'
        : !state.sessions[event.sessionId]
          ? 'unknown-session'
          : 'stale-or-terminated-session'
    return { targetSessionId, metric: reason }
  }
  return { targetSessionId, metric: null }
}

/**
 * Map agent runtime `ScopeRunEventData['phase']` → `SessionSliceState`.
 * Only terminal phases produce a transition; non-terminal phases keep the
 * slice in `'live'` so the routing helpers continue to accept it.
 */
function mapScopeRunPhaseToSessionState(
  phase: string,
): SessionSliceState | null {
  switch (phase) {
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'cancelled':
      return 'cancelled'
    default:
      return null
  }
}

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

function normalizeContinuationDraftText(value: string): string {
  return String(value || '').trim().replace(/\s+/g, '')
}

function shouldPreserveContinuationIntent(params: {
  preserveRequested?: boolean
  pendingIntent: PendingContinuationIntent | null
  draftAnchor: string | null
  nextValue: string
}): boolean {
  if (!params.preserveRequested || !params.pendingIntent) return false
  const next = normalizeContinuationDraftText(params.nextValue)
  if (!next) return true

  const anchor = normalizeContinuationDraftText(params.draftAnchor || '')
  if (anchor && (next.startsWith(anchor) || anchor.startsWith(next))) return true

  return CONTINUATION_DRAFT_PATTERN.test(params.nextValue.trim())
}

async function persistLocalConversationScope(scope: ConversationScope | null): Promise<void> {
  if (!scope || scope.sourceKind !== 'local') return
  if (typeof window === 'undefined' || !window.electronAPI?.chat?.createConversation) return
  await window.electronAPI.chat.createConversation({
    id: scope.id,
    agent: scope.agent,
    title: scope.title || '新对话',
  }).catch(() => undefined)
}

interface ChatRowFromIPC {
  id: string
  role: string
  content: string
  timestamp: string
  meta?: Record<string, unknown>
}

function extractAskUserCardState(
  meta: Record<string, unknown>,
  fallbackCardId: string,
  fallbackAskedAtIso: string,
): AskUserQuestionsCardState | null {
  const aug = meta.askUserQuestions
  if (!aug || typeof aug !== 'object') return null
  const augRecord = aug as Record<string, unknown>
  const rawStatus = augRecord.status
  const status: AskUserQuestionsCardState['status'] =
    rawStatus === 'pending' || rawStatus === 'submitted' || rawStatus === 'cancelled' || rawStatus === 'timeout'
      ? rawStatus
      : 'cancelled'
  const rawQuestions = Array.isArray(augRecord.questions) ? augRecord.questions : []
  const questions: AskUserQuestionsCardState['questions'] = rawQuestions
    .filter((q): q is Record<string, unknown> => Boolean(q) && typeof q === 'object')
    .map((q) => {
      const kindRaw = q.kind
      const kind: AskUserQuestionsCardState['questions'][number]['kind'] =
        kindRaw === 'single_choice' || kindRaw === 'multi_choice' || kindRaw === 'free_text'
          ? kindRaw
          : 'free_text'
      return {
        id: typeof q.id === 'string' ? q.id : '',
        question: typeof q.question === 'string' ? q.question : '',
        kind,
        options: Array.isArray(q.options) ? q.options.filter((o): o is string => typeof o === 'string') : null,
        placeholder: typeof q.placeholder === 'string' ? q.placeholder : null,
        required: typeof q.required === 'boolean' ? q.required : true,
      }
    })
    .filter((q) => q.id && q.question)
  const rawAnswers = Array.isArray(augRecord.answers) ? augRecord.answers : null
  let answers: AskUserQuestionsCardState['answers']
  if (rawAnswers) {
    const collected: Array<{ id: string; answer: string | string[] }> = []
    for (const a of rawAnswers) {
      if (!a || typeof a !== 'object') continue
      const record = a as Record<string, unknown>
      const id = typeof record.id === 'string' ? record.id : ''
      if (!id) continue
      const value = record.answer
      if (typeof value === 'string') {
        collected.push({ id, answer: value })
      } else if (Array.isArray(value)) {
        collected.push({ id, answer: value.filter((v): v is string => typeof v === 'string') })
      }
    }
    answers = collected
  }
  return {
    cardId: typeof augRecord.cardId === 'string' ? augRecord.cardId : fallbackCardId,
    status,
    questions,
    askedAt: typeof augRecord.askedAt === 'number' ? augRecord.askedAt : Date.parse(fallbackAskedAtIso),
    answers,
    answeredAt: typeof augRecord.answeredAt === 'number' ? augRecord.answeredAt : undefined,
    cancelReason: typeof augRecord.cancelReason === 'string' ? augRecord.cancelReason : undefined,
    cancelledAt: typeof augRecord.cancelledAt === 'number' ? augRecord.cancelledAt : undefined,
  }
}

/**
 * Stage U (PR 1, B.5) — flip a card's renderer-only `localDisabled` flag.
 * Used by the sendMessage cancel hook when the IPC cancel times out: we keep
 * `status:'pending'` (no terminal write) but disable the submit button so
 * the user can't double-submit while the cancel races behind the scenes.
 */
function setCardLocallyDisabled(cardId: string, disabled: boolean): void {
  useAgent.setState((prev) => ({
    messages: prev.messages.map((m) => {
      if (m.id !== cardId || m.type !== 'ask_user_questions' || !m.askUserQuestions) return m
      return {
        ...m,
        askUserQuestions: {
          ...m.askUserQuestions,
          localDisabled: disabled,
        },
      }
    }),
  }))
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
      useAgent.setState((prev) => ({
        messages: prev.messages.map((m) => {
          if (m.id !== cardId || m.type !== 'ask_user_questions' || !m.askUserQuestions) return m
          // Only fold if still pending — if a previous timeout already locally
          // disabled it and a late cancel arrives, override to cancelled.
          if (m.askUserQuestions.status !== 'pending') return m
          return {
            ...m,
            askUserQuestions: {
              ...m.askUserQuestions,
              status: 'cancelled',
              cancelReason: r.success
                ? 'user_typed_instead'
                : (r.errorKind === 'cancel_persist_failed' ? 'cancel_persist_failed' : 'user_typed_instead'),
              cancelledAt,
              localDisabled: false,
            },
          }
        }),
      }))
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

function rebuildAgentMessageFromRow(row: ChatRowFromIPC, agent: string): AgentMessage {
  const meta = (row.meta || {}) as Record<string, unknown>
  const cardState = row.role === 'agent_card'
    ? extractAskUserCardState(meta, row.id, row.timestamp)
    : null
  const isAskUserCard = cardState !== null
  const type: AgentMessage['type'] = isAskUserCard
    ? 'ask_user_questions'
    : row.role === 'user'
      ? 'user'
      : row.role === 'assistant'
        ? 'agent'
        : 'system'
  const message: AgentMessage = {
    id: row.id,
    agent,
    content: row.content,
    type,
    timestamp: new Date(row.timestamp),
    attachments: extractPersistedAttachments(meta),
    meta,
  }
  if (cardState) {
    message.askUserQuestions = cardState
  }
  return message
}

function clearPendingSendBufferState(sessionId?: string | null) {
  let storeStateForKey: AgentState | null = null
  try {
    storeStateForKey = useAgent.getState()
  } catch {
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

async function flushPendingSendBuffer(sessionId?: string | null) {
  let storeStateForKey: AgentState | null = null
  try {
    storeStateForKey = useAgent.getState()
  } catch {
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

  setComposerDraft: (value, continuationIntent) => set({
    inputValue: value,
    pendingContinuationIntent: continuationIntent || null,
    pendingContinuationDraftAnchor: continuationIntent ? value : null,
  }),

  clearPendingContinuationIntent: () => set({
    pendingContinuationIntent: null,
    pendingContinuationDraftAnchor: null,
  }),

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

  // =========================================================================
  // V3.4a — renderer-side session tab actions
  // =========================================================================
  // The renderer enforces the ≤3 session hard limit on the create side; the
  // main-process complement (V3.5) is a deliberate follow-up so this PR
  // stays a renderer-only change. setActiveSessionId mirrors the
  // per-session `inputValue` onto the top-level field to match the
  // V3.3b.1 read-through-mirror contract; selectors that still read
  // `state.inputValue` keep observing the active session's draft.

  setActiveSessionId: (id) => set((state) => {
    // Defensive: a tab strip click should only ever target a session that
    // currently exists in sessionOrder. If the id is unknown (e.g. it was
    // closed concurrently), do nothing — the SessionTabs renderer will
    // re-render with the up-to-date list on the next frame.
    if (!state.sessionOrder.includes(id)) return state
    const slice = state.sessions[id] ?? makeEmptySessionSlice()
    return {
      activeSessionId: id,
      inputValue: slice.inputValue,
      pendingSendCount: slice.pendingSendCount,
      pendingSendFlushAt: slice.pendingSendFlushAt,
    }
  }),

  createNewSession: () => {
    const state = get()
    // Renderer-side hard limit (plan §4 V3.4 + V3.5). Main-side enforcement
    // lands in V3.5. Returning null lets the caller surface UI feedback
    // without throwing.
    if (state.sessionOrder.length >= 3) return null
    const id = generateSessionId()
    const slice = makeEmptySessionSlice()
    set({
      sessions: { ...state.sessions, [id]: slice },
      sessionOrder: [...state.sessionOrder, id],
      activeSessionId: id,
      // Mirror the fresh slice's defaults onto the top-level fields so the
      // composer/coalescer selectors observe a clean slate for the new tab.
      inputValue: slice.inputValue,
      pendingSendCount: slice.pendingSendCount,
      pendingSendFlushAt: slice.pendingSendFlushAt,
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
    const nextSlice = nextActiveId ? nextSessions[nextActiveId] : null
    const mirrorPatch = nextSlice
      ? {
          inputValue: nextSlice.inputValue,
          pendingSendCount: nextSlice.pendingSendCount,
          pendingSendFlushAt: nextSlice.pendingSendFlushAt,
        }
      : state.activeSessionId === id
        ? { inputValue: '', pendingSendCount: 0, pendingSendFlushAt: null }
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
      pendingContinuationDraftAnchor: null,
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
      pendingContinuationDraftAnchor: null,
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
      const scopes: ConversationScope[] = result.success && Array.isArray(result.data)
        ? result.data as unknown as ConversationScope[]
        : []
      if (scopes.length === 0) return
      const previousScopeId = get().currentScopeId
      const currentScope = scopes.find((scope) => scope.id === previousScopeId) || scopes[0] || null
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
        pendingContinuationDraftAnchor: null,
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
      const activeRunState = getActiveScopeRunState(get().scopeRunStates, scopeId)
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
        pendingContinuationDraftAnchor: null,
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

function initAgentInteractionListeners(): () => void {
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
      useAgent.setState((prev) => ({
        messages: [...prev.messages, ...additions].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
      }))
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
      const nextSlice: SessionSlice = existingSlice
        ? {
          ...existingSlice,
          conversationId: existingSlice.conversationId ?? event.conversationId,
        }
        : makeEmptySessionSlice(event.conversationId)
      const sessionsPatch: Pick<AgentState, 'sessions'> = {
        sessions: {
          ...prev.sessions,
          [decision.targetSessionId!]: nextSlice,
        },
      }
      // Mirror into top-level `messages` only when the routed target is the
      // active session. Background-session cards land in the slice and will
      // surface on session switch (V3.3b will move messages to the slice).
      if (decision.targetSessionId === prev.activeSessionId) {
        if (prev.messages.some((m) => m.id === message.id)) return sessionsPatch
        return {
          ...sessionsPatch,
          messages: [...prev.messages, message].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime()),
        }
      }
      return sessionsPatch
    })
  })

  // V3.3d — keep `sessions[sessionId].state` in sync with the runtime
  // scopeRunEvent stream so `isLiveSession` / `lookupSessionByConversation`
  // see terminal sessions and stop routing pushed cards into them. Only
  // terminal phases (done / error / cancelled) trigger a transition;
  // non-terminal phases keep the slice in `live`. Sessions are lazily
  // created when an event arrives ahead of any other slice write so the
  // routing helpers can immediately classify them.
  const agentApi = typeof window !== 'undefined' ? window.electronAPI?.agent : null
  const unsubscribeScopeRunEvent = agentApi && typeof agentApi.onScopeRunEvent === 'function'
    ? agentApi.onScopeRunEvent((event) => {
      const sessionId = (event as { sessionId?: string | null }).sessionId
      if (!sessionId) return
      const nextState = mapScopeRunPhaseToSessionState(event.phase)
      if (!nextState) return
      useAgent.setState((prev) => {
        const existing = prev.sessions[sessionId]
        // Skip lazy creation only for non-terminal phases — terminal ones
        // must always be recorded so a late `done` for an unseen session
        // doesn't leave routing accepting it.
        const nextSlice: SessionSlice = existing
          ? { ...existing, state: nextState }
          : { ...makeEmptySessionSlice(), state: nextState }
        return {
          sessions: {
            ...prev.sessions,
            [sessionId]: nextSlice,
          },
        }
      })
    })
    : () => { /* ignore — older preview stubs do not surface onScopeRunEvent */ }

  return () => {
    try { unsubscribePush() } catch { /* ignore */ }
    try { unsubscribeScopeRunEvent() } catch { /* ignore */ }
  }
}

export function initAgentListeners(): () => void {
  const offRuntime = agentRuntimeDriver.initAgentListeners()
  const offAgentInteraction = initAgentInteractionListeners()
  return () => {
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
  useAgent.setState((prev) => ({
    messages: prev.messages.map((m) => {
      if (m.id !== cardId || m.type !== 'ask_user_questions' || !m.askUserQuestions) return m
      return {
        ...m,
        askUserQuestions: {
          ...m.askUserQuestions,
          status: 'cancelled',
          cancelReason,
          cancelledAt,
        },
      }
    }),
  }))
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
    useAgent.setState((prev) => ({
      messages: prev.messages.map((m) => {
        if (m.id !== cardId || m.type !== 'ask_user_questions' || !m.askUserQuestions) return m
        return {
          ...m,
          askUserQuestions: {
            ...m.askUserQuestions,
            status: 'submitted',
            answers,
            answeredAt,
          },
        }
      }),
    }))
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
