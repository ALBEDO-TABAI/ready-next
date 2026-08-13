import type { AgentMessage, ScopeRunState } from './types'
import { emitRendererAgentMetric } from './rendererMetrics'
import {
  collapseAdjacentDuplicateAssistantTail,
  generateResponseSegmentId,
  normalizeSessionSlice,
  sessionKeyForScopeId,
  upsertStreamedSegmentCache,
  withSessionSliceAndActiveRuntimeMirror,
  type AgentStoreLike,
  type RunPayloadLike,
} from './runtime-driver-session-state'

export function installRuntimeDriverStreamEvents(deps: {
  store: AgentStoreLike
  resolveScopeIdForRunPayload(payload: RunPayloadLike): string | null
  refreshInfrastructureWatchdog(scopeId: string, requestId: string | null | undefined): void
  clearInfrastructureWatchdog(scopeId: string, requestId: string | null | undefined): void
  reconcileCanonicalTerminalMessage(scopeId: string, requestId: string, canonicalMessage: any, digest?: string | null): Promise<boolean>
  finalizeScopeRunAfterStreamDone(scopeId: string, requestId: string): void
  upsertScopeRunState(scopeId: string, updater: (previous: ScopeRunState | null) => ScopeRunState): void
}): () => void {
  const {
    store,
    resolveScopeIdForRunPayload,
    refreshInfrastructureWatchdog,
    clearInfrastructureWatchdog,
    reconcileCanonicalTerminalMessage,
    finalizeScopeRunAfterStreamDone,
    upsertScopeRunState,
  } = deps
  const cleanupStream = window.electronAPI.agent.onStream((data) => {
    const scopeId = resolveScopeIdForRunPayload(data)
    if (!scopeId) return
    if (data.type !== 'done' && data.type !== 'text') return
    if (data.type === 'text' && !data.chunk) return

    const requestId = typeof data.runId === 'string' && data.runId.trim()
      ? data.runId.trim()
      : null
    if (!requestId) return
    const currentState = store.getState()
    const ownerSessionId = sessionKeyForScopeId(currentState, scopeId)
    const ownerSlice = normalizeSessionSlice(currentState.sessions?.[ownerSessionId])
    const runState = ownerSlice.scopeRunStates[scopeId] || null
    if (
      !currentState.sessions?.[ownerSessionId]
      || ownerSlice.conversationId !== scopeId
      || ownerSlice.streamingRequestId !== requestId
      || runState?.requestId !== requestId
    ) return

    if (data.type === 'done') {
      // Stage X2.6 — any terminal event for this scope clears the
      // infrastructure-timeout watchdog so it doesn't fire a false
      // positive after a normal completion.
      void (async () => {
        try {
          if (data.canonicalMessage) {
            clearInfrastructureWatchdog(scopeId, requestId)
            await reconcileCanonicalTerminalMessage(
              scopeId,
              requestId,
              data.canonicalMessage,
              data.canonicalMessageDigest,
            )
            finalizeScopeRunAfterStreamDone(scopeId, requestId)
            return
          }
          emitRendererAgentMetric('renderer_done_without_canonical_terminal', {
            scopeId,
            requestId,
          })
        } catch (error) {
          emitRendererAgentMetric('renderer_assistant_done_finalize_failed', {
            scopeId,
            responseMessageId: runState?.responseMessageId || null,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })()
      return
    }

    refreshInfrastructureWatchdog(scopeId, requestId)
    const previousMessage = runState?.responseMessageId
      ? currentState.messages.find((item: AgentMessage) => item.id === runState.responseMessageId) || null
      : null
    const shouldStartNewSegment = Boolean(
      runState?.responseSegmentBreakPending ||
      !runState?.responseMessageId ||
      (scopeId === currentState.currentScopeId && runState?.responseMessageId && !previousMessage),
    )

    const previousBuffer = runState?.responseBuffer || ''
    const executionAgentId = runState?.executionBinding?.effectiveAgentId || data.agent
    let targetResponseMessageId = runState?.responseMessageId || null
    let nextBuffer = collapseAdjacentDuplicateAssistantTail(`${previousBuffer}${data.chunk}`)
    let chunkForDisplay = nextBuffer.startsWith(previousBuffer) ? nextBuffer.slice(previousBuffer.length) : data.chunk

    if (shouldStartNewSegment) {
      targetResponseMessageId = generateResponseSegmentId()
      nextBuffer = collapseAdjacentDuplicateAssistantTail(data.chunk)
      chunkForDisplay = nextBuffer
      if (!chunkForDisplay.trim()) return
      // EP2 P0-2 — write-through: every streamed segment lands in the
      // scope's live cache so a later loadScope can restore it whether or
      // not this scope is in the foreground right now.
      currentState.appendScopeLiveMessage(scopeId, {
        id: targetResponseMessageId,
        agent: executionAgentId,
        content: chunkForDisplay,
        type: 'agent',
        timestamp: new Date(),
        meta: {
          transient: true,
          runId: requestId,
          scopeId,
        },
      })
      if (scopeId === currentState.currentScopeId) {
        currentState.addMessage({
          id: targetResponseMessageId,
          agent: executionAgentId,
          content: chunkForDisplay,
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
      upsertStreamedSegmentCache(
        currentState,
        scopeId,
        targetResponseMessageId,
        chunkForDisplay,
        nextBuffer,
        executionAgentId,
        requestId,
      )
      if (
        chunkForDisplay &&
        scopeId === currentState.currentScopeId &&
        currentState.messages.some((item: AgentMessage) => item.id === targetResponseMessageId)
      ) {
        currentState.appendToMessage(targetResponseMessageId, chunkForDisplay)
      }
    }

    upsertScopeRunState(scopeId, (previous) => ({
      scopeId,
      agent: previous?.agent || data.agent,
      requestId: previous?.requestId || requestId,
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


  return cleanupStream
}
