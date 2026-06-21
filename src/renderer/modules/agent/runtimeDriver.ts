import { createEmptyScopeRunState, deriveScopeRunStatePatch, getActiveScopeRunState, isForegroundBusyScopeRunState, isScopeRunPhase, mergeArtifacts, phaseToToolTraceStatus } from './scopeRunState'
import { persistAssistantMessage, extractAttachmentsFromMeta } from './messageComposer'
import { executeModuleToolAction, handleModuleToolAction } from './moduleExecutor'
import { cancelAllPendingWidgetWrites } from './documentActions'
import type { Agent, AgentMessage, ConversationScope, ScopeRunState } from './types'
import { useMode } from '../../stores/useMode'
import { extractSkillCommandFromText, runSkillCommand } from './commandHandlers'
import { mapBackendErrorToFriendly } from './error-message-mapping'
import { emitRendererAgentMetric } from './rendererMetrics'

interface AgentStoreLike {
  getState: () => any
  setState: (partial: any) => void
}

const PRIMARY_SESSION_KEY = '__primary__'

function activeSessionKeyFromState(state: any): string {
  return state?.activeSessionId || state?.sessionId || PRIMARY_SESSION_KEY
}

function makeEmptySessionSlice(conversationId: string | null = null): Record<string, unknown> {
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

function normalizeSessionSlice(slice: any): Record<string, any> {
  const fallback = makeEmptySessionSlice(slice?.conversationId ?? null)
  return {
    ...fallback,
    ...(slice || {}),
    messages: slice?.messages ?? [],
    scopeRunStates: slice?.scopeRunStates ?? {},
    taskDisclosureState: slice?.taskDisclosureState ?? {},
  }
}

function sessionKeyForScopeId(state: any, scopeId: string | null | undefined): string {
  if (scopeId && state?.sessions) {
    for (const [sessionId, sliceInput] of Object.entries(state.sessions as Record<string, unknown>)) {
      const slice = normalizeSessionSlice(sliceInput)
      if (slice.conversationId === scopeId) return sessionId
    }
  }
  return activeSessionKeyFromState(state)
}

function withSessionSliceAndActiveRuntimeMirror(
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

function withActiveSessionMessagesMirror(state: any, messages: AgentMessage[]): { messages: AgentMessage[]; sessions: Record<string, unknown> } {
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

interface RunPayloadLike {
  // Stage V V3.2 — IPC push payloads now standardise sessionId as
  // `string | null` (null = global event). RunPayloadLike accepts both the
  // legacy optional form and the V3.2 nullable form so this helper can
  // consume push payloads directly without per-callsite normalization.
  sessionId?: string | null
  runId?: string
  agent?: string
  scopeId?: string
}

function generateResponseSegmentId(): string {
  return `response-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function buildTaskSnapshotMeta(scopeId: string, scope: ConversationScope | null, runState: ScopeRunState | null): Record<string, unknown> | undefined {
  if (!runState) return undefined
  return {
    taskSnapshot: {
      scopeId,
      agent: runState.agent,
      taskId: runState.taskId || null,
      title: scope?.title || '任务',
      taskTitle: runState.taskTitle || null,
      taskSummary: runState.taskSummary || null,
      steps: runState.steps || [],
      currentStepId: runState.currentStepId || null,
      waitingFor: runState.waitingFor || 'none',
      resumableActions: runState.resumableActions || [],
      recentArtifacts: runState.recentArtifacts || [],
      taskContinuation: runState.taskContinuation || null,
      progress: runState.progress || null,
      memoryCapture: runState.memoryCapture || null,
      blockedReason: runState.blockedReason || null,
      error: runState.error || null,
      updatedAt: runState.updatedAt || new Date().toISOString(),
      responseMessageId: runState.responseMessageId || null,
      phase: runState.phase,
      terminalReason: runState.terminalReason || null,
      toolTrace: (runState.toolTrace || []).map((event) => ({
        id: event.id,
        kind: event.kind,
        text: event.text,
        timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : String(event.timestamp),
      })),
    },
  }
}

function buildToolTraceSnapshotMeta(runState: ScopeRunState | null): Record<string, unknown> | undefined {
  if (!runState) return undefined
  const startIndex = Math.max(0, runState.responseSegmentToolTraceStart || 0)
  const toolTraceSnapshot = (runState.toolTrace || []).slice(startIndex).map((event) => ({
    id: event.id,
    kind: event.kind,
    text: event.text,
    timestamp: event.timestamp instanceof Date ? event.timestamp.toISOString() : String(event.timestamp),
  }))

  if (toolTraceSnapshot.length === 0) return undefined
  return { toolTraceSnapshot }
}

function buildResponseSegmentMeta(scopeId: string, scope: ConversationScope | null, runState: ScopeRunState | null): Record<string, unknown> | undefined {
  const taskMeta = buildTaskSnapshotMeta(scopeId, scope, runState)
  const toolMeta = buildToolTraceSnapshotMeta(runState)
  if (!taskMeta && !toolMeta) return undefined
  return {
    ...(taskMeta || {}),
    ...(toolMeta || {}),
  }
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
    meta: { transient: true },
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

/**
 * Stage X2.6 — infrastructure timeout safety net.
 *
 * Default bootstrap window: 60s. If the send never produces any runtime
 * liveness, the driver fires `infrastructure_timeout`:
 * unlocks the originating session's composer, clears its in-flight
 * request handle, and toasts "Ready lost track of this request;
 * recovered automatically".
 *
 * Independent of `ProviderTerminalError` because no error was ever
 * delivered (main process crashed, IPC dropped, etc.). See plan §7.2
 * last paragraph.
 */
const INFRASTRUCTURE_TIMEOUT_MS = 60_000
const ACTIVE_RUN_INFRASTRUCTURE_TIMEOUT_MS = 5 * 60_000

interface InfrastructureWatchdog {
  scopeId: string
  requestId: string
  timer: ReturnType<typeof setTimeout>
  startedAt: number
  timeoutMs: number
}

export function createAgentRuntimeDriver(store: AgentStoreLike) {
  let listenersInitialized = false

  // Keyed by `${scopeId}::${requestId}` — at most one watchdog per
  // in-flight send. Cleared by any terminal-event handler below.
  const infrastructureWatchdogs = new Map<string, InfrastructureWatchdog>()
  let lastInfrastructureToastAt = 0

  function watchdogKey(scopeId: string, requestId: string): string {
    return `${scopeId}::${requestId}`
  }

  function clearInfrastructureWatchdogForScope(scopeId: string): void {
    for (const [key, watchdog] of infrastructureWatchdogs) {
      if (watchdog.scopeId !== scopeId) continue
      clearTimeout(watchdog.timer)
      infrastructureWatchdogs.delete(key)
    }
  }

  function clearInfrastructureWatchdog(scopeId: string, requestId: string | null | undefined): void {
    if (!requestId) {
      clearInfrastructureWatchdogForScope(scopeId)
      return
    }
    const key = watchdogKey(scopeId, requestId)
    const watchdog = infrastructureWatchdogs.get(key)
    if (!watchdog) return
    clearTimeout(watchdog.timer)
    infrastructureWatchdogs.delete(key)
  }

  function reportInfrastructureTimeoutToMain(scopeId: string, requestId: string, elapsedMs: number): void {
    const report = typeof window !== 'undefined'
      ? window.electronAPI?.agent?.reportInfrastructureTimeout
      : undefined
    if (typeof report !== 'function') return
    void report({ scopeId, requestId, elapsedMs }).catch(() => undefined)
  }

  function fireInfrastructureTimeout(scopeId: string, requestId: string): void {
    const key = watchdogKey(scopeId, requestId)
    const watchdog = infrastructureWatchdogs.get(key)
    if (!watchdog) return
    infrastructureWatchdogs.delete(key)
    // Sanity: if the session is no longer streaming this request, nothing
    // to recover. Could happen if a terminal event arrived in the same
    // tick the timer fired.
    const state = store.getState()
    const runState = state.scopeRunStates?.[scopeId]
    if (runState && runState.requestId !== requestId) return

    reportInfrastructureTimeoutToMain(scopeId, requestId, watchdog.timeoutMs)

    store.setState((current: { currentScopeId?: string | null; sessions?: Record<string, unknown>; currentAgent?: string }) => {
      const sessionId = sessionKeyForScopeId(current, scopeId)
      const currentSlice = normalizeSessionSlice(current.sessions?.[sessionId])
      const previousRun = currentSlice.scopeRunStates[scopeId] || runState || createEmptyScopeRunState({
        scopeId,
        agent: state.currentAgent || current.currentAgent || 'butler',
        requestId,
        phase: 'error',
      })
      return {
        ...withSessionSliceAndActiveRuntimeMirror(
          current,
          sessionId,
          {
            isStreaming: false,
            foregroundBusy: false,
            composerLocked: false,
            streamingMessageId: null,
            streamingRequestId: null,
            scopeRunStates: {
              ...currentSlice.scopeRunStates,
              [scopeId]: {
                ...previousRun,
                scopeId,
                requestId,
                phase: 'error',
                terminalReason: 'infra_error',
                error: 'Ready 跟丢了这次请求，已自动恢复，可重新发送。',
                updatedAt: new Date().toISOString(),
              },
            },
          },
        ),
        ...(current.currentScopeId === scopeId ? { toolTraceStatus: 'error' as const } : {}),
      }
    })

    if (state.currentScopeId === scopeId && typeof state.addMessage === 'function') {
      state.addMessage({
        id: `infra-timeout-${Date.now()}`,
        agent: state.currentAgent || 'butler',
        content: 'Ready 跟丢了这次请求，已自动恢复，可重新发送。',
        type: 'system',
        timestamp: new Date(),
      })
    }
    lastInfrastructureToastAt = Date.now()
    emitRendererAgentMetric('renderer_infrastructure_timeout_fired', {
      scopeId,
      requestId,
      elapsedMs: watchdog.timeoutMs,
    })
  }

  function armInfrastructureWatchdog(scopeId: string, requestId: string, options?: { timeoutMs?: number }): void {
    if (!scopeId || !requestId) return
    // Re-arming the same scope+requestId resets the timer.
    clearInfrastructureWatchdog(scopeId, requestId)
    const timeoutMs = options?.timeoutMs ?? INFRASTRUCTURE_TIMEOUT_MS
    const timer = setTimeout(() => fireInfrastructureTimeout(scopeId, requestId), timeoutMs)
    infrastructureWatchdogs.set(watchdogKey(scopeId, requestId), {
      scopeId,
      requestId,
      timer,
      startedAt: Date.now(),
      timeoutMs,
    })
  }

  function refreshInfrastructureWatchdog(scopeId: string, requestId: string | null | undefined): void {
    if (!scopeId || !requestId) return
    const key = watchdogKey(scopeId, requestId)
    const watchdog = infrastructureWatchdogs.get(key)
    if (!watchdog) return
    clearTimeout(watchdog.timer)
    const timer = setTimeout(() => fireInfrastructureTimeout(scopeId, requestId), ACTIVE_RUN_INFRASTRUCTURE_TIMEOUT_MS)
    infrastructureWatchdogs.set(key, {
      ...watchdog,
      timer,
      timeoutMs: ACTIVE_RUN_INFRASTRUCTURE_TIMEOUT_MS,
    })
  }

  function completeScopeRunAfterSendSuccess(scopeId: string, requestId: string): void {
    clearInfrastructureWatchdog(scopeId, requestId)
    let persistedRunState: ScopeRunState | null = null
    store.setState((state: any) => {
      const sessionId = sessionKeyForScopeId(state, scopeId)
      const currentSlice = normalizeSessionSlice(state.sessions?.[sessionId])
      const previous = currentSlice.scopeRunStates[scopeId] || state.scopeRunStates?.[scopeId] || null
      if (previous?.requestId && previous.requestId !== requestId) return {}

      const activeRequestId = currentSlice.streamingRequestId || state.streamingRequestId || null
      const ownsScope = (
        currentSlice.conversationId === scopeId ||
        state.currentScopeId === scopeId ||
        activeRequestId === requestId
      )
      if (!ownsScope) return {}
      if (!previous && activeRequestId !== requestId) return {}

      const nextRun = previous
        ? {
          ...previous,
          scopeId,
          phase: previous.terminalReason ? previous.phase : 'done',
          terminalReason: previous.terminalReason || 'done',
          updatedAt: new Date().toISOString(),
        }
        : null
      persistedRunState = nextRun
      return withSessionSliceAndActiveRuntimeMirror(state, sessionId, {
        scopeRunStates: nextRun
          ? {
            ...currentSlice.scopeRunStates,
            [scopeId]: nextRun,
          }
          : currentSlice.scopeRunStates,
        isStreaming: false,
        foregroundBusy: false,
        composerLocked: false,
        streamingMessageId: null,
        streamingRequestId: null,
      })
    })

    if (persistedRunState) {
      const state = store.getState()
      const sessionId = sessionKeyForScopeId(state, scopeId)
      const currentSlice = normalizeSessionSlice(state.sessions?.[sessionId])
      void persistAssistantMessageForRun(scopeId, currentSlice.scopeRunStates[scopeId] || state.scopeRunStates?.[scopeId] || persistedRunState)
    }
  }

  function upsertScopeRunState(
    scopeId: string,
    updater: (previous: ScopeRunState | null) => ScopeRunState,
  ): void {
    store.setState((state: any) => {
      const sessionId = sessionKeyForScopeId(state, scopeId)
      const currentSlice = normalizeSessionSlice(state.sessions?.[sessionId])
      const previous = currentSlice.scopeRunStates[scopeId] || state.scopeRunStates?.[scopeId] || null
      const produced = updater(previous)
      const hasTerminalReasonField = Object.prototype.hasOwnProperty.call(produced, 'terminalReason')
      const sameRun = Boolean(
        previous?.terminalReason &&
        previous.requestId &&
        produced.requestId &&
        previous.requestId === produced.requestId,
      )
      const next = !hasTerminalReasonField && sameRun
        ? { ...produced, terminalReason: previous.terminalReason }
        : produced
      const nextScopeRunStates = {
        ...currentSlice.scopeRunStates,
        [scopeId]: next,
      }
      return withSessionSliceAndActiveRuntimeMirror(state, sessionId, {
        scopeRunStates: nextScopeRunStates,
      })
    })
  }

  function finalizeScopeRunAfterStreamDone(scopeId: string, fallbackRunState: ScopeRunState | null): void {
    store.setState((state: any) => {
      const sessionId = sessionKeyForScopeId(state, scopeId)
      const currentSlice = normalizeSessionSlice(state.sessions?.[sessionId])
      const previous = currentSlice.scopeRunStates[scopeId] || state.scopeRunStates?.[scopeId] || fallbackRunState || null
      const nextScopeRunStates = previous
        ? {
          ...currentSlice.scopeRunStates,
          [scopeId]: {
            ...previous,
            scopeId,
            phase: 'done',
            terminalReason: previous.terminalReason || 'done',
            updatedAt: new Date().toISOString(),
          },
        }
        : currentSlice.scopeRunStates

      return withSessionSliceAndActiveRuntimeMirror(state, sessionId, {
        scopeRunStates: nextScopeRunStates,
        ...(currentSlice.conversationId === scopeId
          ? {
            isStreaming: false,
            foregroundBusy: false,
            composerLocked: false,
            streamingMessageId: null,
            streamingRequestId: null,
          }
          : {}),
      })
    })
  }

  function resolveScopeIdForRunPayload(payload: RunPayloadLike): string | null {
    if (typeof payload.scopeId === 'string' && payload.scopeId.trim()) {
      return payload.scopeId.trim()
    }
    if (typeof payload.sessionId === 'string' && payload.sessionId.trim()) {
      return payload.sessionId.trim()
    }
    if (!payload.runId) return null
    const entries = Object.entries(store.getState().scopeRunStates as Record<string, ScopeRunState>)
    for (const [scopeId, runState] of entries) {
      if (runState.requestId !== payload.runId) continue
      if (payload.agent && runState.agent !== payload.agent) continue
      return scopeId
    }
    return null
  }

  function activateWorkbenchMode(mode: 'browser' | 'document' | 'rss' | 'calendar'): void {
    const modeStore = useMode.getState()
    modeStore.setWorkbenchMode(mode)
    modeStore.setReadySubMode(mode)
  }

  async function persistAssistantMessageForRun(scopeId: string, runState: ScopeRunState | null): Promise<void> {
    if (!runState?.responseMessageId) return
    const state = store.getState()
    const currentScope = (state.scopes.find((item: ConversationScope) => item.id === scopeId) || state.currentScope || null) as ConversationScope | null
    const currentMessage = state.messages.find((item: AgentMessage) => item.id === runState.responseMessageId)
    const content = currentMessage?.content || runState.responseBuffer || ''
    const snapshotMeta = buildResponseSegmentMeta(scopeId, currentScope, runState)
    if (snapshotMeta) {
      store.setState((current: any) => {
        const messages = current.messages.map((item: AgentMessage) =>
          item.id === runState.responseMessageId
            ? { ...item, meta: { ...(item.meta || {}), ...snapshotMeta } }
            : item,
        )
        return withActiveSessionMessagesMirror(current, messages)
      })
    }
    const result = await persistAssistantMessage(scopeId, runState.responseMessageId, content, currentScope, snapshotMeta)
    if (!result.success) {
      emitRendererAgentMetric('renderer_assistant_persistence_failed', {
        scopeId,
        responseMessageId: runState.responseMessageId,
        error: result.error || 'assistant persist failed',
      })
    }
  }

  function sealResponseSegment(scopeId: string, runState: ScopeRunState | null): void {
    if (!runState?.responseMessageId) return
    const state = store.getState()
    const currentScope = (state.scopes.find((item: ConversationScope) => item.id === scopeId) || state.currentScope || null) as ConversationScope | null
    const currentMessage = state.messages.find((item: AgentMessage) => item.id === runState.responseMessageId)
    const content = currentMessage?.content || runState.responseBuffer || ''
    if (!content.trim()) return
    const segmentMeta = buildResponseSegmentMeta(scopeId, currentScope, runState)
    if (segmentMeta) {
      store.setState((current: any) => {
        const messages = current.messages.map((item: AgentMessage) =>
          item.id === runState.responseMessageId
            ? { ...item, meta: { ...(item.meta || {}), ...segmentMeta } }
            : item,
        )
        return withActiveSessionMessagesMirror(current, messages)
      })
    }
    void persistAssistantMessage(scopeId, runState.responseMessageId, content, currentScope, segmentMeta)
      .then((result) => {
        if (result.success) return
        emitRendererAgentMetric('renderer_assistant_persistence_failed', {
          scopeId,
          responseMessageId: runState.responseMessageId,
          error: result.error || 'assistant persist failed',
        })
      })
  }

  async function maybeAutoExecuteAssistantSkillCommand(scopeId: string, runState: ScopeRunState | null): Promise<void> {
    if (!runState?.responseMessageId) return
    const state = store.getState()
    if (state.currentScopeId !== scopeId) return
    const currentMessage = state.messages.find((item: AgentMessage) => item.id === runState.responseMessageId)
    const content = String(currentMessage?.content || runState.responseBuffer || '')
    const command = extractSkillCommandFromText(content)
    if (!command) return

    const responseIndex = state.messages.findIndex((item: AgentMessage) => item.id === runState.responseMessageId)
    const sourceMessages = responseIndex >= 0 ? state.messages.slice(0, responseIndex) : state.messages
    const latestUserWithAttachments = [...sourceMessages]
      .reverse()
      .find((item: AgentMessage) => item.type === 'user' && Array.isArray(item.attachments) && item.attachments.length > 0)
    const attachments = latestUserWithAttachments?.attachments || []

    const result = await runSkillCommand(command, attachments)
    if (!result.handled) return

    const appended = `\n\n[系统已自动执行技能命令]\n${result.text}`
    store.setState((current: any) => {
      const messages = current.messages.map((item: AgentMessage) =>
        item.id === runState.responseMessageId ? { ...item, content: `${item.content}${appended}` } : item,
      )
      const sessionId = sessionKeyForScopeId(current, scopeId)
      const slice = normalizeSessionSlice(current.sessions?.[sessionId])
      return {
        ...withSessionSliceAndActiveRuntimeMirror(current, sessionId, {
          messages,
          scopeRunStates: {
            ...slice.scopeRunStates,
            [scopeId]: slice.scopeRunStates[scopeId]
            ? {
              ...slice.scopeRunStates[scopeId],
              responseBuffer: `${slice.scopeRunStates[scopeId].responseBuffer || ''}${appended}`,
              latestText: result.text.slice(-500),
              updatedAt: new Date().toISOString(),
            }
            : slice.scopeRunStates[scopeId],
          },
        }),
      }
    })
  }

  function initAgentListeners(): () => void {
    if (listenersInitialized) return () => { /* already initialized */ }
    if (typeof window === 'undefined' || !window.electronAPI) return () => { /* no electronAPI */ }

    listenersInitialized = true
    void store.getState().loadSendPreferences()

    const cleanupStream = window.electronAPI.agent.onStream((data) => {
      const scopeId = resolveScopeIdForRunPayload(data)
      if (!scopeId) return

      if (data.type === 'done') {
        // Stage X2.6 — any terminal event for this scope clears the
        // infrastructure-timeout watchdog so it doesn't fire a false
        // positive after a normal completion.
        const runStateForClear = store.getState().scopeRunStates[scopeId] || null
        clearInfrastructureWatchdog(scopeId, runStateForClear?.requestId || (typeof data.runId === 'string' ? data.runId : null))
        const runState = runStateForClear
        void (async () => {
          let finalized = false
          const finalize = () => {
            finalizeScopeRunAfterStreamDone(scopeId, store.getState().scopeRunStates[scopeId] || runState)
            finalized = true
          }
          try {
            await maybeAutoExecuteAssistantSkillCommand(scopeId, runState)
            finalize()
            await persistAssistantMessageForRun(scopeId, store.getState().scopeRunStates[scopeId] || runState)
          } catch (error) {
            emitRendererAgentMetric('renderer_assistant_done_finalize_failed', {
              scopeId,
              responseMessageId: runState?.responseMessageId || null,
              error: error instanceof Error ? error.message : String(error),
            })
          } finally {
            if (!finalized) finalize()
          }
        })()
        return
      }

      if (data.type !== 'text' || !data.chunk) return

      const currentState = store.getState()
      const runState = currentState.scopeRunStates[scopeId] || null
      refreshInfrastructureWatchdog(scopeId, runState?.requestId || (typeof data.runId === 'string' ? data.runId : null))
      const previousMessage = runState?.responseMessageId
        ? currentState.messages.find((item: AgentMessage) => item.id === runState.responseMessageId) || null
        : null
      const shouldStartNewSegment = Boolean(
        runState?.responseSegmentBreakPending ||
        !runState?.responseMessageId ||
        (scopeId === currentState.currentScopeId && runState?.responseMessageId && !previousMessage),
      )

      let targetResponseMessageId = runState?.responseMessageId || null
      let nextBuffer = `${runState?.responseBuffer || ''}${data.chunk}`

      if (shouldStartNewSegment) {
        if (runState?.responseSegmentBreakPending) {
          sealResponseSegment(scopeId, runState)
        }
        targetResponseMessageId = generateResponseSegmentId()
        nextBuffer = data.chunk
        // EP2 P0-2 — write-through: every streamed segment lands in the
        // scope's live cache so a later loadScope can restore it whether or
        // not this scope is in the foreground right now.
        currentState.appendScopeLiveMessage(scopeId, {
          id: targetResponseMessageId,
          agent: data.agent,
          content: data.chunk,
          type: 'agent',
          timestamp: new Date(),
          meta: { transient: true },
        })
        if (scopeId === currentState.currentScopeId) {
          currentState.addMessage({
            id: targetResponseMessageId,
            agent: data.agent,
            content: data.chunk,
            type: 'agent',
            timestamp: new Date(),
            meta: { transient: true },
          })
          store.setState((state: any) => withSessionSliceAndActiveRuntimeMirror(
            state,
            sessionKeyForScopeId(state, scopeId),
            { streamingMessageId: targetResponseMessageId },
          ))
        }
      } else if (targetResponseMessageId) {
        upsertStreamedSegmentCache(currentState, scopeId, targetResponseMessageId, data.chunk, nextBuffer, data.agent)
        if (
          scopeId === currentState.currentScopeId &&
          currentState.messages.some((item: AgentMessage) => item.id === targetResponseMessageId)
        ) {
          currentState.appendToMessage(targetResponseMessageId, data.chunk)
        }
      }

      upsertScopeRunState(scopeId, (previous) => ({
        scopeId,
        agent: previous?.agent || data.agent,
        requestId: previous?.requestId || (typeof data.runId === 'string' ? data.runId : null),
        phase: previous?.phase === 'takeover' ? previous.phase : 'responding',
        toolTrace: previous?.toolTrace || [],
        startedAt: previous?.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        latestText: nextBuffer.slice(-500),
        module: previous?.module || null,
        intent: previous?.intent || null,
        executionKind: previous?.executionKind || null,
        jobId: previous?.jobId || null,
        artifactRefs: previous?.artifactRefs || [],
        memoryRefs: previous?.memoryRefs || [],
        triggerHits: previous?.triggerHits || [],
        contextBudget: previous?.contextBudget || null,
        ownerResourceId: previous?.ownerResourceId || null,
        lastEvidenceAt: previous?.lastEvidenceAt || null,
        blockedReason: previous?.blockedReason || null,
        controllerId: previous?.controllerId || null,
        ownerTabId: previous?.ownerTabId || null,
        checkpointExpiresAt: previous?.checkpointExpiresAt || null,
        responseMessageId: targetResponseMessageId,
        responseBuffer: nextBuffer,
        responseSegmentBreakPending: false,
        responseSegmentToolTraceStart: shouldStartNewSegment
          ? (previous?.toolTrace || []).length
          : (previous?.responseSegmentToolTraceStart ?? 0),
        stepMetrics: previous?.stepMetrics || { toolCalls: 0, toolResults: 0, lastToolAt: null },
        designPhase: previous?.designPhase || null,
        designTodo: previous?.designTodo || [],
        designReviewSummary: previous?.designReviewSummary || null,
        ownedNodeIds: previous?.ownedNodeIds || [],
        repairScope: previous?.repairScope || null,
        taskTitle: previous?.taskTitle || null,
        taskSummary: previous?.taskSummary || null,
        steps: previous?.steps || [],
        currentStepId: previous?.currentStepId || null,
        waitingFor: previous?.waitingFor || 'none',
        resumableActions: previous?.resumableActions || [],
        recentArtifacts: previous?.recentArtifacts || [],
        taskContinuation: previous?.taskContinuation || null,
        memoryCapture: previous?.memoryCapture || null,
        error: previous?.error || null,
      }))
    })

    const cleanupStatus = window.electronAPI.agent.onStatusChange((data) => {
      const { agents, setAgents } = store.getState()
      setAgents(agents.map((agent: Agent) => agent.name === data.agent ? { ...agent, status: data.status as Agent['status'] } : agent))
    })

    const cleanupError = window.electronAPI.agent.onError((data) => {
      const scopeId = resolveScopeIdForRunPayload(data)
      if (!scopeId) return

      // Phase 3: double-defense — AbortError is already short-circuited inside
      // turn-engine before emitRuntimeError fires, but if anything ever leaks
      // through as 'aborted' we still want to avoid showing a capsule OR a
      // system message (cancellation has its own runComplete path).
      if (data.errorKind === 'aborted') return

      const recoverable = data.recoverable === true

      const state = store.getState()
      const runState = state.scopeRunStates[scopeId] || null
      // Stage X2.6 — clear infrastructure watchdog on any non-recoverable
      // terminal error. Recoverable errors (soft capsule) leave the
      // request in-flight so the watchdog must keep ticking.
      if (!recoverable) {
        clearInfrastructureWatchdog(scopeId, runState?.requestId || (typeof data.runId === 'string' ? data.runId : null))
      }

      if (recoverable) {
        const friendly = mapBackendErrorToFriendly({
          error: data.error,
          errorKind: data.errorKind || 'unknown',
        })
        emitRendererAgentMetric('renderer_friendly_error_surfaced', {
          scopeId,
          agent: data.agent,
          errorKind: data.errorKind || 'unknown',
        })
        // Only mutate the softError slot — do NOT touch phase, error,
        // blockedReason, toolTraceStatus, and do NOT persist an assistant
        // message. The turn continues; the capsule is purely a renderer hint.
        upsertScopeRunState(scopeId, (previous) => ({
          scopeId,
          agent: previous?.agent || data.agent,
          requestId: previous?.requestId || (typeof data.runId === 'string' ? data.runId : null),
          phase: previous?.phase || 'idle',
          toolTrace: previous?.toolTrace || [],
          startedAt: previous?.startedAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          latestText: previous?.latestText || null,
          module: previous?.module || null,
          intent: previous?.intent || null,
          executionKind: previous?.executionKind || null,
          jobId: previous?.jobId || null,
          artifactRefs: previous?.artifactRefs || [],
          memoryRefs: previous?.memoryRefs || [],
          triggerHits: previous?.triggerHits || [],
          contextBudget: previous?.contextBudget || null,
          ownerResourceId: previous?.ownerResourceId || null,
          lastEvidenceAt: previous?.lastEvidenceAt || null,
          blockedReason: previous?.blockedReason || null,
          controllerId: previous?.controllerId || null,
          ownerTabId: previous?.ownerTabId || null,
          checkpointExpiresAt: previous?.checkpointExpiresAt || null,
          responseMessageId: previous?.responseMessageId || null,
          responseBuffer: previous?.responseBuffer || '',
          stepMetrics: previous?.stepMetrics || { toolCalls: 0, toolResults: 0, lastToolAt: null },
          designPhase: previous?.designPhase || null,
          designTodo: previous?.designTodo || [],
          designReviewSummary: previous?.designReviewSummary || null,
          ownedNodeIds: previous?.ownedNodeIds || [],
          repairScope: previous?.repairScope || null,
          taskTitle: previous?.taskTitle || null,
          taskSummary: previous?.taskSummary || null,
          steps: previous?.steps || [],
          currentStepId: previous?.currentStepId || null,
          waitingFor: previous?.waitingFor || 'none',
          resumableActions: previous?.resumableActions || [],
          recentArtifacts: previous?.recentArtifacts || [],
          taskContinuation: previous?.taskContinuation || null,
          memoryCapture: previous?.memoryCapture || null,
          error: previous?.error || null,
          softError: {
            message: data.error,
            errorKind: data.errorKind || 'unknown',
            toolName: data.toolName || null,
            friendlyMessage: friendly.friendlyMessage,
            technicalDetails: friendly.technicalDetails || null,
            receivedAt: new Date().toISOString(),
          },
        }))
        return
      }

      // Terminal path — unchanged behavior, plus clear softError so a stale
      // capsule does not linger behind a newer system-message error.
      const friendly = mapBackendErrorToFriendly({
        error: data.error,
        errorKind: data.errorKind || 'unknown',
      })
      emitRendererAgentMetric('renderer_friendly_error_surfaced', {
        scopeId,
        agent: data.agent,
        errorKind: data.errorKind || 'unknown',
      })
      // Stage X2.4 — terminal unwind targets the SESSION THAT OWNS THE
      // SCOPE, not the active session. This is the explicit cross-state
      // model the plan §0.5/§7.1 calls for: the "session that was locked
      // at send start" is recovered via `sessionKeyForScopeId(state,
      // scopeId)` (the scope→session map maintained by the session-slice
      // contract). If the user clicked into another tab mid-send, the
      // active session has moved but the lock unwind must still target
      // the originating session so its composer becomes usable when the
      // user clicks back into it. Stage X2.5: streamingRequestId clear
      // hides the Stop button for the originating session too.
      store.setState((state: any) => ({
        ...withSessionSliceAndActiveRuntimeMirror(
          state,
          sessionKeyForScopeId(state, scopeId),
          {
            isStreaming: false,
            foregroundBusy: false,
            composerLocked: false,
            streamingMessageId: null,
            streamingRequestId: null,
          },
        ),
        // Only mutate the visible top-level toolTraceStatus when the
        // affected session is the active one — the parked-session
        // tooltrace mirror is recomputed when the user switches to it.
        ...(state.currentScopeId === scopeId ? { toolTraceStatus: 'error' as const } : {}),
      }))
      // The system-message error capsule is part of the visible
      // transcript, so it only renders for the active scope. The
      // originating session (when parked) still gets phase=error in its
      // scope run state below, which the projection card surfaces when
      // the user returns to the tab.
      if (state.currentScopeId === scopeId) {
        state.addMessage({
          id: `error-${Date.now()}`,
          agent: data.agent,
          content: friendly.friendlyMessage,
          type: 'system',
          timestamp: new Date(),
        })
      }

      upsertScopeRunState(scopeId, (previous) => ({
        scopeId,
        agent: previous?.agent || data.agent,
        requestId: previous?.requestId || (typeof data.runId === 'string' ? data.runId : null),
        phase: 'error',
        toolTrace: previous?.toolTrace || [],
        startedAt: previous?.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        latestText: previous?.latestText || friendly.friendlyMessage,
        module: previous?.module || null,
        intent: previous?.intent || null,
        executionKind: previous?.executionKind || null,
        jobId: previous?.jobId || null,
        artifactRefs: previous?.artifactRefs || [],
        memoryRefs: previous?.memoryRefs || [],
        triggerHits: previous?.triggerHits || [],
        contextBudget: previous?.contextBudget || null,
        ownerResourceId: previous?.ownerResourceId || null,
        lastEvidenceAt: previous?.lastEvidenceAt || null,
        blockedReason: friendly.friendlyMessage,
        controllerId: previous?.controllerId || null,
        ownerTabId: previous?.ownerTabId || null,
        checkpointExpiresAt: null,
        responseMessageId: previous?.responseMessageId || null,
        responseBuffer: previous?.responseBuffer || '',
        stepMetrics: previous?.stepMetrics || { toolCalls: 0, toolResults: 0, lastToolAt: null },
        designPhase: previous?.designPhase || null,
        designTodo: previous?.designTodo || [],
        designReviewSummary: previous?.designReviewSummary || null,
        ownedNodeIds: previous?.ownedNodeIds || [],
        repairScope: previous?.repairScope || null,
        taskTitle: previous?.taskTitle || null,
        taskSummary: previous?.taskSummary || null,
        steps: previous?.steps || [],
        currentStepId: previous?.currentStepId || null,
        waitingFor: previous?.waitingFor || 'none',
        resumableActions: previous?.resumableActions || [],
        recentArtifacts: previous?.recentArtifacts || [],
        taskContinuation: previous?.taskContinuation || null,
        memoryCapture: previous?.memoryCapture || null,
        error: friendly.friendlyMessage,
        softError: null,
      }))
      void persistAssistantMessageForRun(scopeId, runState)
    })

    let toolActionQueue: Promise<void> = Promise.resolve()
    const cleanupToolAction = window.electronAPI.agent.onToolAction((data) => {
      toolActionQueue = toolActionQueue
        .then(async () => {
          const scopeId = resolveScopeIdForRunPayload(data)
          if (!scopeId) return
          const agentName = typeof data.agent === 'string' && data.agent.trim() ? data.agent : store.getState().currentAgent
          const tool = String(data.tool || '').trim()
          const args = (data.args || {}) as Record<string, unknown>
          const runId = typeof data.runId === 'string' ? data.runId : null
          const handled = await handleModuleToolAction({
            scopeId,
            agentName,
            tool,
            args,
            runId,
            activateWorkbenchMode,
            upsertScopeRunState,
            getScopeRunState: () => store.getState().scopeRunStates[scopeId] || null,
          })
          if (!handled) return
        })
        .catch((error) => {
          const scopeId = resolveScopeIdForRunPayload(data)
          if (!scopeId) return
          upsertScopeRunState(scopeId, (previous) => ({
            scopeId,
            agent: previous?.agent || store.getState().currentAgent,
            requestId: previous?.requestId || (typeof data.runId === 'string' ? data.runId : null),
            phase: 'error',
            toolTrace: [
              ...(previous?.toolTrace || []),
              {
                id: `toolerr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                kind: 'result',
                text: `工具执行失败：${error instanceof Error ? error.message : String(error)}`,
                timestamp: new Date(),
              },
            ],
            startedAt: previous?.startedAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            latestText: previous?.latestText || null,
            module: previous?.module || null,
            intent: previous?.intent || null,
            executionKind: previous?.executionKind || null,
            jobId: previous?.jobId || null,
            artifactRefs: previous?.artifactRefs || [],
            memoryRefs: previous?.memoryRefs || [],
            triggerHits: previous?.triggerHits || [],
            contextBudget: previous?.contextBudget || null,
            ownerResourceId: previous?.ownerResourceId || null,
            lastEvidenceAt: previous?.lastEvidenceAt || null,
            blockedReason: error instanceof Error ? error.message : String(error),
            controllerId: previous?.controllerId || null,
            ownerTabId: previous?.ownerTabId || null,
            checkpointExpiresAt: previous?.checkpointExpiresAt || null,
            responseMessageId: previous?.responseMessageId || null,
            responseBuffer: previous?.responseBuffer || '',
            stepMetrics: previous?.stepMetrics || { toolCalls: 0, toolResults: 0, lastToolAt: null },
            designPhase: previous?.designPhase || null,
            designTodo: previous?.designTodo || [],
            designReviewSummary: previous?.designReviewSummary || null,
            ownedNodeIds: previous?.ownedNodeIds || [],
            repairScope: previous?.repairScope || null,
            taskTitle: previous?.taskTitle || null,
            taskSummary: previous?.taskSummary || null,
            steps: previous?.steps || [],
            currentStepId: previous?.currentStepId || null,
            waitingFor: previous?.waitingFor || 'none',
            resumableActions: previous?.resumableActions || [],
            recentArtifacts: previous?.recentArtifacts || [],
            taskContinuation: previous?.taskContinuation || null,
            memoryCapture: previous?.memoryCapture || null,
            error: error instanceof Error ? error.message : String(error),
          }))
        })
    })

    const logToolEvent = (payload: {
      type: 'dispatch' | 'ack' | 'watchdog' | 'cancel' | 'self-rescue' | 'duplicate'
      requestId: string
      tool: string
      scopeId?: string | null
      elapsedMs?: number
      error?: string
    }) => {
      try { window.electronAPI.tools?.logToolEvent?.(payload) } catch { /* ignore */ }
    }

    // Per-scope serialized queue: prevents one stuck tool from blocking other scopes.
    // scopeless requests each get an ephemeral chain keyed by requestId so they never block.
    const scopeQueues = new Map<string, Promise<void>>()
    // Per-request cancellation latch: cancel IPC from main flips these to settle the queued task early.
    // `cancelled` is checked at runWithWatchdog entry so a cancel that arrives while the request is
    //   still queued (before its turn) is honored. `queuedAt` powers the self-rescue TTL — if an entry
    //   sits in the queue for > 180s without execution, runWithWatchdog treats it as cancelled.
    const QUEUE_SELF_RESCUE_MS = 180_000
    const activeToolRequests = new Map<string, {
      settled: boolean
      cancelled: boolean
      abort: () => void
      queuedAt: number
    }>()

    const budgetForTool = (tool: string): number => {
      const name = String(tool || '').trim().toLowerCase()
      if (!name) return 15_000
      if (name.startsWith('skill_') || name.startsWith('skill:')) return 120_000
      if (name.startsWith('browser_') || name.startsWith('browser:')) return 60_000
      if (name.startsWith('document_') || name.startsWith('document:')) return 30_000
      if (name.startsWith('feishu_') || name.startsWith('feishu:')) return 30_000
      return 15_000
    }

    const runWithWatchdog = async (data: {
      requestId: string
      agent?: string
      // Stage V V3.2 — push payload sessionId is `string | null` (V3.2 contract).
      sessionId?: string | null
      runId?: string
      tool: string
      args: Record<string, unknown>
    }): Promise<void> => {
      const requestId = data.requestId
      const existing = activeToolRequests.get(requestId)
      const now = Date.now()
      const queuedTooLong = existing && now - existing.queuedAt > QUEUE_SELF_RESCUE_MS
      // Cancel IPC may have flipped the latch while this request was still queued.
      if (existing?.cancelled || queuedTooLong) {
        activeToolRequests.delete(requestId)
        const elapsed = existing ? now - existing.queuedAt : undefined
        logToolEvent({
          type: queuedTooLong ? 'self-rescue' : 'cancel',
          requestId,
          tool: String(data.tool || ''),
          scopeId: resolveScopeIdForRunPayload(data),
          elapsedMs: typeof elapsed === 'number' ? elapsed : undefined,
          error: queuedTooLong ? 'queue-self-rescue' : 'cancelled',
        })
        await window.electronAPI.agent.completeToolActionRequest({
          requestId,
          handled: false,
          error: queuedTooLong ? 'queue-self-rescue' : 'cancelled',
        }).catch(() => { /* ignore */ })
        return
      }
      if (existing?.settled) { activeToolRequests.delete(requestId); return }

      const scopeId = resolveScopeIdForRunPayload(data)
      if (!scopeId) {
        activeToolRequests.delete(requestId)
        await window.electronAPI.agent.completeToolActionRequest({
          requestId,
          handled: false,
          error: 'Scope run not found for tool action request',
        })
        return
      }

      const agentName = typeof data.agent === 'string' && data.agent.trim() ? data.agent : store.getState().currentAgent
      const tool = String(data.tool || '').trim()
      const args = (data.args || {}) as Record<string, unknown>
      const runId = typeof data.runId === 'string' ? data.runId : null
      const budgetMs = budgetForTool(tool)

      const startedAt = Date.now()
      let watchdog: ReturnType<typeof setTimeout> | null = null
      const watchdogPromise = new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => {
          const entry = activeToolRequests.get(requestId)
          if (entry && !entry.settled) {
            entry.settled = true
            const message = `renderer-watchdog:${budgetMs}`
            logToolEvent({
              type: 'watchdog',
              requestId,
              tool,
              scopeId,
              elapsedMs: budgetMs,
              error: message,
            })
            reject(new Error(message))
          }
        }, budgetMs)
      })
      const cancelPromise = new Promise<never>((_, reject) => {
        const entry = activeToolRequests.get(requestId)
        if (entry) {
          // Share the latch with the queue-level abort so cancels that raced ahead (cancelled=true)
          //   still propagate into the race when runWithWatchdog finally enters.
          if (entry.cancelled) {
            entry.settled = true
            logToolEvent({
              type: 'cancel',
              requestId,
              tool,
              scopeId,
              elapsedMs: Date.now() - startedAt,
            })
            reject(new Error('cancelled'))
            return
          }
          entry.abort = () => {
            if (entry.settled) return
            entry.cancelled = true
            entry.settled = true
            logToolEvent({
              type: 'cancel',
              requestId,
              tool,
              scopeId,
              elapsedMs: Date.now() - startedAt,
            })
            reject(new Error('cancelled'))
          }
        }
      })

      try {
        const result = await Promise.race([
          executeModuleToolAction({
            scopeId,
            agentName,
            tool,
            args,
            runId,
            activateWorkbenchMode,
            upsertScopeRunState,
            getScopeRunState: () => store.getState().scopeRunStates[scopeId] || null,
          }),
          watchdogPromise,
          cancelPromise,
        ])
        await window.electronAPI.agent.completeToolActionRequest({
          requestId,
          handled: result.handled,
          payload: result.payload,
        })
        logToolEvent({
          type: 'ack',
          requestId,
          tool,
          scopeId,
          elapsedMs: Date.now() - startedAt,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // For cancelled we've already been told; still ack so main's pending map releases even if
        // the cancel IPC was missed. completeToolActionRequest on an unknown id is a no-op.
        await window.electronAPI.agent.completeToolActionRequest({
          requestId,
          handled: false,
          error: message,
        }).catch(() => { /* ignore */ })
        throw error
      } finally {
        if (watchdog) clearTimeout(watchdog)
        activeToolRequests.delete(requestId)
      }
    }

    const cleanupToolActionRequest = window.electronAPI.agent.onToolActionRequest
      ? window.electronAPI.agent.onToolActionRequest((data) => {
        const scopeIdForLog = resolveScopeIdForRunPayload(data)
        const queueKey = scopeIdForLog || `scopeless:${data.requestId}`
        // Idempotent: if we already have an entry for this requestId, ignore the duplicate dispatch.
        //   This guards against IPC replay and covers G-Z9.
        if (activeToolRequests.has(data.requestId)) {
          logToolEvent({
            type: 'duplicate',
            requestId: data.requestId,
            tool: String(data.tool || ''),
            scopeId: scopeIdForLog,
            error: 'duplicate-dispatch',
          })
          try {
            // fire-and-forget: best-effort acknowledgement of a duplicate dispatch so the main side can clear the pending request; the duplicate is already a no-op upstream.
            void window.electronAPI.agent.completeToolActionRequest?.({
              requestId: data.requestId,
              handled: false,
              error: 'duplicate-dispatch',
            }).catch(() => { /* ignore */ })
          } catch { /* ignore */ }
          return
        }
        // Queue-level abort: flipping `cancelled` guarantees runWithWatchdog's entry check sees
        //   the cancel even if the request is still waiting its turn in the scope queue.
        const abortFromQueue = () => {
          const entry = activeToolRequests.get(data.requestId)
          if (!entry || entry.settled) return
          entry.cancelled = true
          entry.settled = true
        }
        activeToolRequests.set(data.requestId, {
          settled: false,
          cancelled: false,
          abort: abortFromQueue,
          queuedAt: Date.now(),
        })
        logToolEvent({
          type: 'dispatch',
          requestId: data.requestId,
          tool: String(data.tool || ''),
          scopeId: scopeIdForLog,
        })
        const prev = scopeQueues.get(queueKey) || Promise.resolve()
        const next = prev
          .catch(() => { /* previous task's error already handled */ })
          .then(() => runWithWatchdog(data))
          .catch(async (error) => {
            const scopeId = resolveScopeIdForRunPayload(data)
            if (scopeId) {
              upsertScopeRunState(scopeId, (previous) => ({
                scopeId,
                agent: previous?.agent || store.getState().currentAgent,
                requestId: previous?.requestId || (typeof data.runId === 'string' ? data.runId : null),
                phase: 'error',
                toolTrace: [
                  ...(previous?.toolTrace || []),
                  {
                    id: `toolreqerr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    kind: 'result',
                    text: `工具执行失败：${error instanceof Error ? error.message : String(error)}`,
                    timestamp: new Date(),
                  },
                ],
                startedAt: previous?.startedAt || new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                latestText: previous?.latestText || null,
                module: previous?.module || null,
                intent: previous?.intent || null,
                executionKind: previous?.executionKind || null,
                jobId: previous?.jobId || null,
                artifactRefs: previous?.artifactRefs || [],
                memoryRefs: previous?.memoryRefs || [],
                triggerHits: previous?.triggerHits || [],
                contextBudget: previous?.contextBudget || null,
                ownerResourceId: previous?.ownerResourceId || null,
                lastEvidenceAt: previous?.lastEvidenceAt || null,
                blockedReason: error instanceof Error ? error.message : String(error),
                controllerId: previous?.controllerId || null,
                ownerTabId: previous?.ownerTabId || null,
                checkpointExpiresAt: previous?.checkpointExpiresAt || null,
                responseMessageId: previous?.responseMessageId || null,
                responseBuffer: previous?.responseBuffer || '',
                stepMetrics: previous?.stepMetrics || { toolCalls: 0, toolResults: 0, lastToolAt: null },
                designPhase: previous?.designPhase || null,
                designTodo: previous?.designTodo || [],
                designReviewSummary: previous?.designReviewSummary || null,
                ownedNodeIds: previous?.ownedNodeIds || [],
                repairScope: previous?.repairScope || null,
                taskTitle: previous?.taskTitle || null,
                taskSummary: previous?.taskSummary || null,
                steps: previous?.steps || [],
                currentStepId: previous?.currentStepId || null,
                waitingFor: previous?.waitingFor || 'none',
                resumableActions: previous?.resumableActions || [],
                recentArtifacts: previous?.recentArtifacts || [],
                taskContinuation: previous?.taskContinuation || null,
                memoryCapture: previous?.memoryCapture || null,
                error: error instanceof Error ? error.message : String(error),
              }))
            }
            // runWithWatchdog already acked main; nothing else to do.
          })
        scopeQueues.set(queueKey, next)
        void next.finally(() => {
          if (scopeQueues.get(queueKey) === next) scopeQueues.delete(queueKey)
        })
      })
      : () => { /* older test stubs */ }

    const cleanupCancelToolActionRequest = window.electronAPI.agent.onCancelToolActionRequest
      ? window.electronAPI.agent.onCancelToolActionRequest((data) => {
        const ids = Array.isArray(data?.requestIds) ? data.requestIds : []
        for (const rid of ids) {
          const entry = activeToolRequests.get(rid)
          if (!entry || entry.settled) continue
          entry.abort()
        }
        // Any queued widget writes that haven't yet committed to the store should
        // treat this as a preempt — bump the per-tab epoch so the runUpdate
        // closures bail before setTabContent instead of landing old content.
        if (ids.length > 0) cancelAllPendingWidgetWrites()
      })
      : () => { /* older test stubs */ }

    const cleanupScopeRunEvent = window.electronAPI.agent.onScopeRunEvent
      ? window.electronAPI.agent.onScopeRunEvent((event: any) => {
        if (!event.scopeId) return
        if (!isScopeRunPhase(event.phase) || event.phase === 'idle') return

        upsertScopeRunState(event.scopeId, (previous) => {
          if (
            event.type !== 'started'
            && event.runId
            && previous?.requestId
            && previous.requestId !== event.runId
          ) {
            return previous
          }
          const currentState = store.getState()
          const activeMessage = previous?.responseMessageId
            ? currentState.messages.find((item: AgentMessage) => item.id === previous.responseMessageId) || null
            : null
          const shouldBreakSegment = Boolean(
            event.toolEvent &&
            previous?.responseMessageId &&
            String(activeMessage?.content || previous?.responseBuffer || '').trim(),
          )
          const toolTrace = previous?.toolTrace || []
          const nextTrace = event.toolEvent
            ? [
              ...toolTrace,
              {
                id: event.toolEvent.id,
                kind: event.toolEvent.kind,
                text: event.toolEvent.text,
                timestamp: new Date(event.toolEvent.timestamp),
              },
            ]
            : toolTrace
          const patch = deriveScopeRunStatePatch(event, previous)

          return {
            scopeId: event.scopeId,
            agent: previous?.agent || event.agent,
            requestId: event.runId || previous?.requestId || null,
            taskId: event.taskId || previous?.taskId || patch.taskContinuation?.taskId || null,
            phase: patch.phase || event.phase,
            terminalReason: patch.terminalReason ?? null,
            toolTrace: nextTrace,
            startedAt: previous?.startedAt || event.timestamp,
            updatedAt: event.timestamp,
            latestText: patch.latestText ?? previous?.latestText ?? null,
            module: patch.module ?? event.module ?? previous?.module ?? null,
            intent: patch.intent ?? event.intent ?? previous?.intent ?? null,
            executionKind: patch.executionKind ?? event.executionKind ?? previous?.executionKind ?? null,
            jobId: patch.jobId ?? event.jobId ?? previous?.jobId ?? null,
            artifactRefs: mergeArtifacts(previous?.artifactRefs, patch.artifactRefs ?? event.artifactRefs),
            memoryRefs: patch.memoryRefs ?? event.memoryRefs ?? previous?.memoryRefs ?? [],
            triggerHits: patch.triggerHits ?? event.triggerHits ?? previous?.triggerHits ?? [],
            contextBudget: patch.contextBudget ?? event.contextBudget ?? previous?.contextBudget ?? null,
            ownerResourceId: patch.ownerResourceId ?? event.ownerResourceId ?? previous?.ownerResourceId ?? null,
            lastEvidenceAt: patch.lastEvidenceAt ?? event.lastEvidenceAt ?? previous?.lastEvidenceAt ?? null,
            blockedReason: patch.blockedReason ?? previous?.blockedReason ?? null,
            controllerId: patch.controllerId ?? previous?.controllerId ?? null,
            ownerTabId: patch.ownerTabId ?? previous?.ownerTabId ?? null,
            checkpointExpiresAt: patch.checkpointExpiresAt ?? previous?.checkpointExpiresAt ?? null,
            responseMessageId: previous?.responseMessageId || null,
            responseBuffer: previous?.responseBuffer || '',
            responseSegmentBreakPending: shouldBreakSegment
              ? true
              : previous?.responseSegmentBreakPending ?? false,
            responseSegmentToolTraceStart: previous?.responseSegmentToolTraceStart ?? 0,
            stepMetrics: patch.stepMetrics ?? previous?.stepMetrics ?? { toolCalls: 0, toolResults: 0, lastToolAt: null },
            designPhase: patch.designPhase ?? previous?.designPhase ?? null,
            designTodo: patch.designTodo ?? previous?.designTodo ?? [],
            designReviewSummary: patch.designReviewSummary ?? previous?.designReviewSummary ?? null,
            ownedNodeIds: patch.ownedNodeIds ?? previous?.ownedNodeIds ?? [],
            repairScope: patch.repairScope ?? previous?.repairScope ?? null,
            taskTitle: patch.taskTitle ?? previous?.taskTitle ?? null,
            taskSummary: patch.taskSummary ?? previous?.taskSummary ?? null,
            steps: patch.steps ?? previous?.steps ?? [],
            currentStepId: patch.currentStepId ?? previous?.currentStepId ?? null,
            waitingFor: patch.waitingFor ?? previous?.waitingFor ?? 'none',
            resumableActions: patch.resumableActions ?? previous?.resumableActions ?? [],
            recentArtifacts: patch.recentArtifacts ?? previous?.recentArtifacts ?? [],
            taskContinuation: patch.taskContinuation ?? previous?.taskContinuation ?? null,
            memoryCapture: patch.memoryCapture ?? previous?.memoryCapture ?? null,
            error: patch.error ?? event.error ?? previous?.error ?? null,
          }
        })

        const currentState = store.getState()
        const detachedJobEvent = event.module === 'skill' && event.executionKind === 'job' && String(event.taskId || '').startsWith('detached:')
        refreshInfrastructureWatchdog(event.scopeId, event.runId || store.getState().scopeRunStates[event.scopeId]?.requestId || null)
        // Stage X2.4 — `started` mirror still keys off the active scope
        // (the `streamingRequestId` mirror is the top-level alias and is
        // only meaningful for the active session; parked sessions read
        // their own slice's `streamingRequestId` directly).
        if (
          currentState.currentScopeId === event.scopeId &&
          event.type === 'started' &&
          !detachedJobEvent
        ) {
          store.setState((state: any) => withSessionSliceAndActiveRuntimeMirror(
            state,
            sessionKeyForScopeId(state, event.scopeId),
            { streamingRequestId: event.runId || currentState.streamingRequestId },
          ))
        }
        // Stage X2.4 — terminal events always unwind the originating
        // session's slice, even when the user has switched away. See the
        // onError comment block above for the rationale.
        const terminalRunEvent = Boolean(
          store.getState().scopeRunStates[event.scopeId]?.terminalReason ||
          event.phase === 'done' ||
          event.phase === 'error' ||
          event.phase === 'cancelled',
        )
        if (terminalRunEvent) {
          const latestRunState = store.getState().scopeRunStates[event.scopeId] || null
          // Stage X2.6 — terminal scope-run event clears the
          // infrastructure watchdog for this scope.
          clearInfrastructureWatchdog(
            event.scopeId,
            latestRunState?.requestId || (typeof event.runId === 'string' ? event.runId : null),
          )
          store.setState((state: any) => ({
            ...withSessionSliceAndActiveRuntimeMirror(
              state,
              sessionKeyForScopeId(state, event.scopeId),
              {
                isStreaming: false,
                foregroundBusy: false,
                composerLocked: false,
                streamingMessageId: null,
                streamingRequestId: null,
              },
            ),
            // Top-level toolTraceStatus is the active-session mirror, so
            // only refresh it when the terminal event belongs to the
            // currently-visible scope.
            ...(state.currentScopeId === event.scopeId
              ? { toolTraceStatus: phaseToToolTraceStatus(latestRunState?.phase || event.phase, latestRunState?.terminalReason || event.terminalReason) }
              : {}),
          }))
        }
        if (
          event.terminalReason ||
          event.phase === 'done' ||
          event.phase === 'error' ||
          event.phase === 'cancelled'
        ) {
          void persistAssistantMessageForRun(event.scopeId, store.getState().scopeRunStates[event.scopeId] || null)
        }
      })
      : () => { /* older test stubs */ }

    const cleanupConversationEvent = window.electronAPI.agent.onConversationEvent((data) => {
      const event = data as {
        type: 'scope_created' | 'scope_updated' | 'message_added'
        scope: ConversationScope
        message?: {
          id: string
          role: string
          content: string
          timestamp: string
          meta?: Record<string, unknown>
        }
      }
      store.setState((state: any) => {
        const existing = state.scopes.find((scope: ConversationScope) => scope.id === event.scope.id)
        const mergedScopes = existing
          ? state.scopes.map((scope: ConversationScope) => scope.id === event.scope.id ? event.scope : scope)
          : [event.scope, ...state.scopes]
        const nextState: Record<string, unknown> = {
          scopes: mergedScopes,
          conversations: mergedScopes.map((scope: ConversationScope) => ({
            id: scope.id,
            agent: scope.agent,
            title: scope.title,
            created_at: scope.createdAt,
            updated_at: scope.updatedAt,
          })),
        }

        if (state.currentScopeId === event.scope.id) {
          nextState.currentScope = event.scope
        }

        if (event.type === 'message_added' && event.message) {
          // EP2 P0-2 — a persisted message supersedes its live-cache twin for
          // ANY scope (the DB row is what the next loadScope returns).
          const live = state.scopeLiveMessages?.[event.scope.id]
          if (live && live.some((item: AgentMessage) => item.id === event.message!.id)) {
            nextState.scopeLiveMessages = {
              ...state.scopeLiveMessages,
              [event.scope.id]: live.filter((item: AgentMessage) => item.id !== event.message!.id),
            }
          }
        }
        if (event.type === 'message_added' && event.message && state.currentScopeId === event.scope.id) {
          const nextMessage: AgentMessage = {
            id: event.message.id,
            agent: event.scope.agent,
            content: event.message.content,
            type: event.message.role === 'user' ? 'user' : event.message.role === 'assistant' ? 'agent' : 'system',
            timestamp: new Date(event.message.timestamp),
            attachments: extractAttachmentsFromMeta(event.message.meta),
            meta: event.message.meta || {},
          }
          const hasMessage = state.messages.some((message: AgentMessage) => message.id === nextMessage.id)
          Object.assign(
            nextState,
            withActiveSessionMessagesMirror(
              state,
              hasMessage ? state.messages : [...state.messages, nextMessage],
            ),
          )
        }

        return nextState
      })
    })

    return () => {
      listenersInitialized = false
      cleanupStream()
      cleanupStatus()
      cleanupError()
      cleanupToolAction()
      cleanupToolActionRequest()
      cleanupCancelToolActionRequest()
      cleanupScopeRunEvent()
      cleanupConversationEvent()
    }
  }

  return {
    initAgentListeners,
    upsertScopeRunState,
    resolveScopeIdForRunPayload,
    armInfrastructureWatchdog,
    clearInfrastructureWatchdog,
    completeScopeRunAfterSendSuccess,
    // Test seam: lets the X2.6 behavior test fire the watchdog with a
    // short timeout (or 0) so it doesn't actually wait 60 seconds.
    __getInfrastructureTimeoutMs: () => INFRASTRUCTURE_TIMEOUT_MS,
    __getLastInfrastructureToastAt: () => lastInfrastructureToastAt,
  }
}
