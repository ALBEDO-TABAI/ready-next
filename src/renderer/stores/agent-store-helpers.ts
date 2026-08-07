/**
 * agent-store-helpers.ts — useAgent 前置块纯移动拆分（2026-07-05 B8 式 P 级）。
 *
 * 本文件内容整块搬自 src/renderer/stores/useAgent.ts（字节原样，仅 import/export
 * 接线变动；可变模块级单例连同全部 owner 函数整簇搬入，
 * ES module 单例语义不变）。
 * 铁律：本文件不得 import ./useAgent（防环）。
 */
import { syncActiveScopeRunAliases } from '../modules/agent/runtimeDriver'
import { extractAttachmentsFromMeta as extractPersistedAttachments } from '../modules/agent/messageComposer'
import { defaultAgentEmoji } from '../../shared/agent-identity'
import type {
  Agent,
  AgentMessage,
  AskUserQuestionsCardState,
  ChatAttachment,
  ChatConversation,
  ConversationScope,
  ScopeRunState,
} from '../modules/agent/types'
import type {
  AgentState,
  PendingContinuationIntent,
  SessionSlice,
  SessionSliceState,
} from './agent-store-types'

const FALLBACK_AGENTS: readonly Agent[] = [
  { name: 'butler', displayName: '管家', avatar: '🤖', status: 'idle', selected: true },
  { name: 'copywriter', displayName: '文案', avatar: '✍️', status: 'idle', selected: false },
  { name: 'video-editor', displayName: '剪辑', avatar: '🎬', status: 'idle', selected: false },
  { name: 'analyst', displayName: '分析', avatar: '📊', status: 'idle', selected: false },
  { name: 'operator', displayName: '运营', avatar: '📈', status: 'idle', selected: false },
]

export interface AgentPersonalityListItem {
  agentName: string
  displayName?: string
  metaJson?: Record<string, unknown>
}

export interface AgentRegistryListItem {
  id: string
  name: string
  status: 'active' | 'disabled' | 'retired' | 'merged'
}

export function cloneFallbackAgents(): Agent[] {
  return FALLBACK_AGENTS.map((agent) => ({ ...agent }))
}

function readPersonalityEmoji(metaJson?: Record<string, unknown>): string {
  const emoji = metaJson?.emoji
  return typeof emoji === 'string' && emoji.trim() ? emoji : '🤖'
}

export function mapPersonalitiesToAgents(
  personalities: AgentPersonalityListItem[],
  previousAgents: Agent[],
  currentAgent: string,
): { agents: Agent[]; currentAgent: string } {
  const source = personalities.length > 0 ? personalities : cloneFallbackAgents().map((agent) => ({
    agentName: agent.name,
    displayName: agent.displayName,
    metaJson: { emoji: agent.avatar },
  }))
  const nextCurrentAgent = source.some((item) => item.agentName === currentAgent)
    ? currentAgent
    : source[0].agentName
  const agents = source.map((item) => {
    const previous = previousAgents.find((agent) => agent.name === item.agentName)
    return {
      name: item.agentName,
      displayName: item.displayName || item.agentName,
      avatar: readPersonalityEmoji(item.metaJson),
      status: 'idle' as const,
      selected: previous?.selected ?? item.agentName === nextCurrentAgent,
    }
  })
  return { agents, currentAgent: nextCurrentAgent }
}

export function mapRegistryToAgents(
  registryAgents: AgentRegistryListItem[],
  previousAgents: Agent[],
  currentAgent: string,
): { agents: Agent[]; currentAgent: string } {
  const active = registryAgents.filter((agent) => agent.status === 'active')
  const source = active.length > 0 ? active : cloneFallbackAgents().map((agent) => ({
    id: agent.name,
    name: agent.displayName,
    status: 'active' as const,
  }))
  const nextCurrentAgent = source.some((item) => item.id === currentAgent)
    ? currentAgent
    : source[0].id
  const agents = source.map((item) => {
    const previous = previousAgents.find((agent) => agent.name === item.id)
    return {
      name: item.id,
      displayName: item.name || item.id,
      avatar: previous?.avatar || defaultAgentEmoji(item.id),
      status: 'idle' as const,
      selected: previous?.selected ?? item.id === nextCurrentAgent,
    }
  })
  return { agents, currentAgent: nextCurrentAgent }
}

const CLOSED_SESSION_STATES: ReadonlySet<SessionSliceState> = new Set(['closed'])

export function makeEmptySessionSlice(conversationId: string | null = null): SessionSlice {
  return {
    messages: [],
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    scopeRunStates: {},
    taskDisclosureState: {},
    lifecyclePendingAction: null,
    lifecycleError: null,
    state: 'live',
    conversationId,
    aliasGeneration: null,
    inputValue: '',
  }
}

export function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function mapScopeToConversation(scope: ConversationScope): ChatConversation {
  return {
    id: scope.id,
    agent: scope.agent,
    title: scope.title,
    created_at: scope.createdAt,
    updated_at: scope.updatedAt,
  }
}

const CONTINUATION_DRAFT_PATTERN =
  /^(?:请|请你|麻烦你)?(?:(?:继续(?:当前|这个|刚才|上次|任务|处理|执行|完成|一下)?|接着(?:来|做|处理|执行|完成)?|恢复(?:上次|刚才|当前)?|重试(?:一次|一下)?|重试刚才的任务|再试(?:一次|一下)?|再来(?:一次|一下)?|重新(?:跑|执行|做|开始)(?:一次|一下|一轮|一遍)?|从头(?:跑|来|做|开始|重新)(?:一次|一下|一轮|一遍)?|确认继续|暂不继续|我已完成|人工步骤已完成|请重试刚才的任务)(?:$|[\s，。,.!?！？])|继续后台任务(?:$|\s)|(?:continue|retry|resume)(?:$|\s))/i

/** Sentinel key when the store has no `sessionId` yet (very early bootstrap). */
const PRIMARY_SESSION_KEY = '__primary__'

export function activeSessionKey(state: AgentState | null | undefined): string {
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
  return normalizeSessionSlice(state.sessions[id])
}

// =============================================================================
// W4.5 per-area selectors — declared narrow read paths per ownership area.
// Each selector returns a referentially-stable narrow slice when the upstream
// state has not changed; pinned by useAgent-area-selector-contract.test.ts.
// =============================================================================

/** W4.5 area S — direct field read for the active session's slice. */
export function selectActiveSessionSlice(state: AgentState): SessionSlice {
  return getSessionSlice(state)
}

/** W4.5 area S — direct field read for `sessionOrder`. */
export function selectSessionOrder(state: AgentState): readonly string[] {
  return state.sessionOrder
}

/** W4.5 area J — direct field read for the active session's scopeRunStates map. */
export function selectActiveScopeRunStates(state: AgentState): Record<string, ScopeRunState> {
  return state.scopeRunStates
}

/** W4.5 area U — direct field read for the agents list. */
export function selectAgents(state: AgentState): readonly Agent[] {
  return state.agents
}

/** W4.5 area U — direct field read for the attachments list. */
export function selectAttachments(state: AgentState): readonly ChatAttachment[] {
  return state.attachments
}

/** W4.5 area U — direct field read for the file pool. */
export function selectFilePool(state: AgentState): readonly ChatAttachment[] {
  return state.filePool
}

/** W4.5 area D — direct field read for the conversations list. */
export function selectConversations(state: AgentState): readonly ChatConversation[] {
  return state.conversations
}

/** W4.5 area D — direct field read for the scopes list. */
export function selectScopes(state: AgentState): readonly ConversationScope[] {
  return state.scopes
}

/** V3.3a write-side helper used by the coalescing path. */
export function withSessionSlice(
  state: AgentState,
  sessionId: string,
  patch: Partial<SessionSlice>,
): Pick<AgentState, 'sessions'> {
  const current = normalizeSessionSlice(state.sessions[sessionId])
  return {
    sessions: {
      ...state.sessions,
      [sessionId]: { ...current, ...patch },
    },
  }
}

export function normalizeSessionSlice(slice: Partial<SessionSlice> | null | undefined): SessionSlice {
  const fallback = makeEmptySessionSlice(slice?.conversationId ?? null)
  return {
    ...fallback,
    ...slice,
    messages: slice?.messages ?? fallback.messages,
    scopeRunStates: slice?.scopeRunStates ?? fallback.scopeRunStates,
    taskDisclosureState: slice?.taskDisclosureState ?? fallback.taskDisclosureState,
  }
}

export function mirrorFromSessionSlice(
  state: AgentState,
  sliceInput: Partial<SessionSlice> | null | undefined,
): Pick<
  AgentState,
  | 'messages'
  | 'inputValue'
  | 'isStreaming'
  | 'foregroundBusy'
  | 'composerLocked'
  | 'streamingMessageId'
  | 'streamingRequestId'
  | 'conversationId'
  | 'currentScopeId'
  | 'currentScope'
  | 'scopeRunStates'
  | 'toolTrace'
  | 'toolTraceStatus'
  | 'taskDisclosureState'
> {
  const slice = normalizeSessionSlice(sliceInput)
  const currentScopeId = slice.conversationId
  const currentScope = currentScopeId
    ? state.scopes.find((item) => item.id === currentScopeId)
      || (state.currentScope?.id === currentScopeId ? state.currentScope : null)
    : null
  const aliases = syncActiveScopeRunAliases({
    currentScopeId,
    scopeRunStates: slice.scopeRunStates,
  })
  return {
    messages: slice.messages,
    inputValue: slice.inputValue,
    isStreaming: slice.isStreaming || aliases.isStreaming,
    foregroundBusy: slice.foregroundBusy || aliases.foregroundBusy,
    composerLocked: slice.composerLocked || aliases.composerLocked,
    streamingMessageId: slice.streamingMessageId,
    streamingRequestId: slice.streamingRequestId,
    conversationId: currentScopeId,
    currentScopeId,
    currentScope,
    scopeRunStates: slice.scopeRunStates,
    toolTrace: aliases.toolTrace,
    toolTraceStatus: aliases.toolTraceStatus,
    taskDisclosureState: slice.taskDisclosureState,
  }
}

export function withSessionSliceAndActiveMirror(
  state: AgentState,
  sessionId: string,
  patch: Partial<SessionSlice>,
): Pick<AgentState, 'sessions'> | (Pick<AgentState, 'sessions'> & ReturnType<typeof mirrorFromSessionSlice>) {
  const current = normalizeSessionSlice(state.sessions[sessionId])
  const nextSlice = { ...current, ...patch }
  const sessionsPatch = {
    sessions: {
      ...state.sessions,
      [sessionId]: nextSlice,
    },
  }
  if (activeSessionKey(state) !== sessionId) return sessionsPatch
  return {
    ...sessionsPatch,
    ...mirrorFromSessionSlice(state, nextSlice),
  }
}

export function sessionKeyForScopeId(state: AgentState, scopeId: string | null | undefined): string {
  if (scopeId) {
    for (const [sessionId, sliceInput] of Object.entries(state.sessions)) {
      const slice = normalizeSessionSlice(sliceInput)
      if (slice.conversationId === scopeId) return sessionId
    }
  }
  return activeSessionKey(state)
}

export function getScopeRunStateForScope(state: AgentState, scopeId: string | null | undefined): ScopeRunState | null {
  if (!scopeId) return null
  const sessionKey = sessionKeyForScopeId(state, scopeId)
  const slice = normalizeSessionSlice(state.sessions[sessionKey])
  return slice.scopeRunStates[scopeId] || state.scopeRunStates[scopeId] || null
}

function withSessionMessagesMirror(
  state: AgentState,
  sessionId: string,
  messages: AgentMessage[],
): Pick<AgentState, 'messages' | 'sessions'> {
  return {
    ...withSessionSlice(state, sessionId, { messages }),
    messages,
  }
}

export function withActiveSessionMessagesMirror(
  state: AgentState,
  messages: AgentMessage[],
): Pick<AgentState, 'messages' | 'sessions'> {
  return withSessionMessagesMirror(state, activeSessionKey(state), messages)
}

// =============================================================================
// V3.3d listener-side direct-setState routing helpers
// =============================================================================

/**
 * Returns true iff `id` resolves to a session slice whose conversation alias
 * is still open. A terminal turn does not retire its Codex thread; only an
 * explicit close makes the renderer session unavailable.
 *
 * `lookupSessionByConversation` uses the same exclusion set.
 */
export function isLiveSession(
  state: AgentState,
  id: string | null | undefined,
): id is string {
  if (!id) return false
  const slice = state.sessions[id]
  return !!slice && !CLOSED_SESSION_STATES.has(slice.state)
}

/**
 * Returns the id of an open session whose `slice.conversationId`
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
    if (CLOSED_SESSION_STATES.has(slice.state)) continue
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

export function recordOrphanedCard(cardId: string, reason: string): void {
  cardRoutingMetrics.orphaned.push({ cardId, reason, at: Date.now() })
}

export function recordCardFallback(cardId: string, reason: string): void {
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
 * Resolve a pushed ask_user_questions card without crossing conversation
 * boundaries. A durable conversation binding wins over a conflicting session
 * id. The active session is only a fallback when the event carries no
 * conversation identity at all.
 */
export function routeCardToSession(
  state: AgentState,
  event: { sessionId: string | null; conversationId: string | null; cardId: string },
): CardRoutingDecision {
  const validSessionId = isLiveSession(state, event.sessionId) ? event.sessionId : null
  const byConversation = lookupSessionByConversation(state, event.conversationId)

  if (event.conversationId) {
    if (byConversation) {
      if (validSessionId && validSessionId !== byConversation) {
        return { targetSessionId: byConversation, metric: 'session-conversation-conflict' }
      }
      return {
        targetSessionId: byConversation,
        metric: validSessionId
          ? null
          : !event.sessionId
            ? 'null-sessionId'
            : !state.sessions[event.sessionId]
              ? 'unknown-session'
              : 'closed-session',
      }
    }

    if (validSessionId) {
      const boundConversationId = normalizeSessionSlice(state.sessions[validSessionId]).conversationId
      if (!boundConversationId || boundConversationId === event.conversationId) {
        return { targetSessionId: validSessionId, metric: null }
      }
      return { targetSessionId: null, metric: 'session-conversation-conflict' }
    }
    return { targetSessionId: null, metric: 'conversation-session-not-found' }
  }

  const activeSessionId = isLiveSession(state, state.activeSessionId)
    ? state.activeSessionId
    : null
  const targetSessionId = validSessionId ?? activeSessionId

  if (!targetSessionId) {
    return { targetSessionId: null, metric: 'no-active-session-and-keys-null' }
  }
  if (targetSessionId !== event.sessionId) {
    const reason =
      !event.sessionId
        ? 'null-sessionId'
        : !state.sessions[event.sessionId]
          ? 'unknown-session'
          : 'closed-session'
    return { targetSessionId, metric: reason }
  }
  return { targetSessionId, metric: null }
}

/**
 * Map agent runtime `ScopeRunEventData['phase']` → `SessionSliceState`.
 * Only terminal phases produce a transition; non-terminal phases keep the
 * slice in `'live'` so the routing helpers continue to accept it.
 */
export function mapScopeRunPhaseToSessionState(
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

function normalizeContinuationDraftText(value: string): string {
  return String(value || '').trim().replace(/\s+/g, '')
}

export function shouldPreserveContinuationIntent(params: {
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

export function rebuildAgentMessageFromRow(row: ChatRowFromIPC, agent: string): AgentMessage {
  const meta = (row.meta || {}) as Record<string, unknown>
  const executionAgentId = row.role === 'assistant' && typeof meta.executionAgentId === 'string' && meta.executionAgentId.trim()
    ? meta.executionAgentId.trim()
    : agent
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
    agent: executionAgentId,
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

export function isSameAttachmentPoolEntry(a: ChatAttachment, b: ChatAttachment): boolean {
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

export function shouldKeepInFilePool(attachment: ChatAttachment): boolean {
  return attachment.source !== 'document-widget-target'
}

export function removeFromFilePool(
  filePool: ChatAttachment[],
  removedAttachment: ChatAttachment,
  remainingAttachments: ChatAttachment[],
): ChatAttachment[] {
  const stillReferenced = remainingAttachments.some((attachment) => isSameAttachmentPoolEntry(attachment, removedAttachment))
  if (stillReferenced) return filePool
  return filePool.filter((attachment) => !isSameAttachmentPoolEntry(attachment, removedAttachment))
}
