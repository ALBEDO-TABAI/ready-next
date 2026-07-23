import { createEmptyScopeRunState, getActiveScopeRunState, isForegroundBusyScopeRunState, phaseToToolTraceStatus } from './scopeRunState'
import type { AgentMessage, ScopeRunState } from './types'

export interface AgentStoreLike {
  getState: () => any
  setState: (partial: any) => void
}

const PRIMARY_SESSION_KEY = '__primary__'

function comparableAssistantTextSegment(text: string): string {
  return String(text || '').replace(/\s+/g, '')
}

export function collapseAdjacentDuplicateAssistantTail(text: string): string {
  let next = String(text || '')
  for (let pass = 0; pass < 3; pass += 1) {
    const trailing = next.match(/\s*$/)?.[0] || ''
    const body = trailing ? next.slice(0, -trailing.length) : next
    let collapsed: string | null = null
    const maxLen = Math.floor(body.length / 2)
    for (let len = maxLen; len >= 12; len -= 1) {
      const left = body.slice(body.length - len * 2, body.length - len)
      const right = body.slice(body.length - len)
      if (!left || !right) continue
      if (comparableAssistantTextSegment(left) !== comparableAssistantTextSegment(right)) continue
      collapsed = `${body.slice(0, body.length - len)}${trailing}`
      break
    }
    if (!collapsed || collapsed === next) return next
    next = collapsed
  }
  return next
}

export function activeSessionKeyFromState(state: any): string {
  return state?.activeSessionId || state?.sessionId || PRIMARY_SESSION_KEY
}

export function makeEmptySessionSlice(conversationId: string | null = null): Record<string, unknown> {
  return {
    messages: [],
    pendingSendCount: 0,
    pendingSendFlushAt: null,
    isStreaming: false,
    foregroundBusy: false,
    composerLocked: false,
    streamingMessageId: null,
    streamingRequestId: null,
    scopeRunStates: {},
    taskDisclosureState: {},
    state: 'live',
    conversationId,
    inputValue: '',
  }
}

export function normalizeSessionSlice(slice: any): Record<string, any> {
  const fallback = makeEmptySessionSlice(slice?.conversationId ?? null)
  return {
    ...fallback,
    ...(slice || {}),
    messages: slice?.messages ?? [],
    scopeRunStates: slice?.scopeRunStates ?? {},
    taskDisclosureState: slice?.taskDisclosureState ?? {},
  }
}

export function sessionKeyForScopeId(state: any, scopeId: string | null | undefined): string {
  if (scopeId && state?.sessions) {
    for (const [sessionId, sliceInput] of Object.entries(state.sessions as Record<string, unknown>)) {
      const slice = normalizeSessionSlice(sliceInput)
      if (slice.conversationId === scopeId) return sessionId
    }
  }
  return activeSessionKeyFromState(state)
}

export function withSessionSliceAndActiveRuntimeMirror(
  state: any,
  sessionId: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const currentSlice = normalizeSessionSlice(state.sessions?.[sessionId])
  const nextSlice = { ...currentSlice, ...patch }
  const sessions = {
    ...(state.sessions || {}),
    [sessionId]: nextSlice,
  }
  if (activeSessionKeyFromState(state) !== sessionId) return { sessions }
  const aliases = syncActiveScopeRunAliases({
    currentScopeId: state.currentScopeId,
    scopeRunStates: nextSlice.scopeRunStates || {},
  })
  const messages = Object.prototype.hasOwnProperty.call(patch, 'messages')
    ? nextSlice.messages || []
    : (currentSlice.messages?.length ? currentSlice.messages : state.messages || [])
  return {
    sessions,
    messages,
    scopeRunStates: nextSlice.scopeRunStates || {},
    isStreaming: Boolean(nextSlice.isStreaming) || aliases.isStreaming,
    foregroundBusy: Boolean(nextSlice.foregroundBusy) || aliases.foregroundBusy,
    composerLocked: Boolean(nextSlice.composerLocked) || aliases.composerLocked,
    streamingMessageId: nextSlice.streamingMessageId ?? null,
    streamingRequestId: nextSlice.streamingRequestId ?? null,
    toolTrace: aliases.toolTrace,
    toolTraceStatus: aliases.toolTraceStatus,
  }
}

export function withActiveSessionMessagesMirror(state: any, messages: AgentMessage[]): { messages: AgentMessage[]; sessions: Record<string, unknown> } {
  const sessionId = activeSessionKeyFromState(state)
  const currentSlice = normalizeSessionSlice(state.sessions?.[sessionId])
  return {
    messages,
    sessions: {
      ...(state.sessions || {}),
      [sessionId]: {
        ...currentSlice,
        messages,
      },
    },
  }
}

export interface RunPayloadLike {
  // Stage V V3.2 — IPC push payloads now standardise sessionId as
  // `string | null` (null = global event). RunPayloadLike accepts both the
  // legacy optional form and the V3.2 nullable form so this helper can
  // consume push payloads directly without per-callsite normalization.
  sessionId?: string | null
  runId?: string
  agent?: string
  scopeId?: string
}

export function generateResponseSegmentId(): string {
  return `response-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * EP2 P0-2 follow-up — the REAL send path creates the reply message BEFORE
 * the first chunk arrives, so the live cache may have no twin yet: a bare
 * append would no-op and the segment would never be cached (Codex gap 1).
 * Upsert with the ACCUMULATED buffer so the cache entry always carries the
 * full text so far. Exported for the real-chain regression test.
 */
export function upsertStreamedSegmentCache(
  state: {
    scopeLiveMessages?: Record<string, AgentMessage[]>
    appendToScopeLiveMessage: (scopeId: string, messageId: string, chunk: string) => void
    appendScopeLiveMessage: (scopeId: string, message: AgentMessage) => void
  },
  scopeId: string,
  messageId: string,
  chunk: string,
  accumulated: string,
  agent: string,
  runId?: string | null,
): void {
  const cachedTwin = (state.scopeLiveMessages?.[scopeId] || [])
    .some((item) => item.id === messageId)
  if (cachedTwin) {
    state.appendToScopeLiveMessage(scopeId, messageId, chunk)
    return
  }
  state.appendScopeLiveMessage(scopeId, {
    id: messageId,
    agent,
    content: accumulated,
    type: 'agent',
    timestamp: new Date(),
    meta: {
      transient: true,
      ...(runId ? { runId } : {}),
      scopeId,
    },
  })
}

export function syncActiveScopeRunAliases(
  state: Pick<{ currentScopeId: string | null; scopeRunStates: Record<string, ScopeRunState> }, 'currentScopeId' | 'scopeRunStates'>,
): Pick<{ isStreaming: boolean; foregroundBusy: boolean; composerLocked: boolean; toolTrace: ScopeRunState['toolTrace']; toolTraceStatus: 'idle' | 'running' | 'done' | 'error' | 'cancelled' }, 'isStreaming' | 'foregroundBusy' | 'composerLocked' | 'toolTrace' | 'toolTraceStatus'> {
  const activeRunState = getActiveScopeRunState(state.scopeRunStates, state.currentScopeId)
  const foregroundBusy = isForegroundBusyScopeRunState(activeRunState)
  return {
    isStreaming: foregroundBusy,
    foregroundBusy,
    composerLocked: foregroundBusy,
    toolTrace: activeRunState?.toolTrace || [],
    toolTraceStatus: phaseToToolTraceStatus(activeRunState?.phase, activeRunState?.terminalReason),
  }
}

