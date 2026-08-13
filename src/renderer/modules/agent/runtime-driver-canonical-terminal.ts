import type { CanonicalAssistantMessage } from '../../../shared/ipc-contracts/canonical-message'
import type { AgentMessage, ConversationScope, ScopeRunState } from './types'
import { useMode } from '../../stores/useMode'
import { rebuildAgentMessageFromRow } from '../../stores/agent-store-helpers'
import { emitRendererAgentMetric } from './rendererMetrics'
import {
  normalizeSessionSlice,
  sessionKeyForScopeId,
  withSessionSliceAndActiveRuntimeMirror,
  type AgentStoreLike,
  type RunPayloadLike,
} from './runtime-driver-session-state'

export function createRuntimeDriverCanonicalTerminal(deps: {
  store: AgentStoreLike
  clearInfrastructureWatchdog(scopeId: string, requestId: string | null | undefined): void
  getScopeRunStateFromState(state: any, scopeId: string | null | undefined): ScopeRunState | null
  findScopeIdByRunId(state: any, runId: string | null | undefined, agent?: string): string | null
  finalizeDoneRunState(previous: ScopeRunState, scopeId: string): ScopeRunState
}) {
  const { store, clearInfrastructureWatchdog, getScopeRunStateFromState, findScopeIdByRunId, finalizeDoneRunState } = deps
  async function completeScopeRunAfterSendSuccess(
    scopeId: string,
    requestId: string,
    options: {
      canonicalMessage: CanonicalAssistantMessage
      canonicalMessageDigest: string
    },
  ): Promise<void> {
    clearInfrastructureWatchdog(scopeId, requestId)
    let persistedRunState: ScopeRunState | null = null
    store.setState((state: any) => {
      const sessionId = sessionKeyForScopeId(state, scopeId)
      const currentSlice = normalizeSessionSlice(state.sessions?.[sessionId])
      if (!state.sessions?.[sessionId] || currentSlice.conversationId !== scopeId) return {}
      const previous = currentSlice.scopeRunStates[scopeId] || getScopeRunStateFromState(state, scopeId)
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
        ? previous.terminalReason
          ? { ...previous, scopeId, updatedAt: new Date().toISOString() }
          : finalizeDoneRunState(previous, scopeId)
        : null
      persistedRunState = nextRun
      return withSessionSliceAndActiveRuntimeMirror(state, sessionId, {
        scopeRunStates: nextRun
          ? {
            ...currentSlice.scopeRunStates,
            [scopeId]: nextRun,
          }
          : currentSlice.scopeRunStates,
      })
    })

    if (persistedRunState) {
      await reconcileCanonicalTerminalMessage(
        scopeId,
        requestId,
        options.canonicalMessage,
        options.canonicalMessageDigest,
      )
      store.setState((nextState: any) => {
        const sessionId = sessionKeyForScopeId(nextState, scopeId)
        const currentSlice = normalizeSessionSlice(nextState.sessions?.[sessionId])
        if (!nextState.sessions?.[sessionId] || currentSlice.conversationId !== scopeId) return {}
        const previous = currentSlice.scopeRunStates[scopeId] || getScopeRunStateFromState(nextState, scopeId)
        if (currentSlice.streamingRequestId !== requestId || previous?.requestId !== requestId) return {}
        return withSessionSliceAndActiveRuntimeMirror(nextState, sessionId, {
          scopeRunStates: previous
            ? {
              ...currentSlice.scopeRunStates,
              [scopeId]: previous.terminalReason
                ? previous
                : finalizeDoneRunState(previous, scopeId),
            }
            : currentSlice.scopeRunStates,
          isStreaming: false,
          foregroundBusy: false,
          composerLocked: false,
          streamingMessageId: null,
          streamingRequestId: null,
        })
      })
    }
  }

  function upsertScopeRunState(
    scopeId: string,
    updater: (previous: ScopeRunState | null) => ScopeRunState,
  ): void {
    store.setState((state: any) => {
      const sessionId = sessionKeyForScopeId(state, scopeId)
      const currentSlice = normalizeSessionSlice(state.sessions?.[sessionId])
      const previous = currentSlice.scopeRunStates[scopeId] || getScopeRunStateFromState(state, scopeId)
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

  function finalizeScopeRunAfterStreamDone(scopeId: string, requestId: string): void {
    store.setState((state: any) => {
      const sessionId = sessionKeyForScopeId(state, scopeId)
      const currentSlice = normalizeSessionSlice(state.sessions?.[sessionId])
      if (!state.sessions?.[sessionId] || currentSlice.conversationId !== scopeId) return {}
      const previous = currentSlice.scopeRunStates[scopeId] || null
      if (currentSlice.streamingRequestId !== requestId || previous?.requestId !== requestId) return {}

      return withSessionSliceAndActiveRuntimeMirror(state, sessionId, {
        scopeRunStates: {
          ...currentSlice.scopeRunStates,
          [scopeId]: finalizeDoneRunState(previous, scopeId),
        },
        isStreaming: false,
        foregroundBusy: false,
        composerLocked: false,
        streamingMessageId: null,
        streamingRequestId: null,
      })
    })
  }

  function resolveScopeIdForRunPayload(payload: RunPayloadLike): string | null {
    const state = store.getState()
    if (typeof payload.scopeId === 'string' && payload.scopeId.trim()) {
      return payload.scopeId.trim()
    }
    if (typeof payload.sessionId === 'string' && payload.sessionId.trim()) {
      const sessionId = payload.sessionId.trim()
      const sessionSlice = state.sessions?.[sessionId]
        ? normalizeSessionSlice(state.sessions[sessionId])
        : null
      if (sessionSlice?.conversationId) return sessionSlice.conversationId
      return sessionId
    }
    if (!payload.runId) return null
    return findScopeIdByRunId(state, payload.runId, payload.agent)
  }

  function activateWorkbenchMode(mode: 'browser' | 'document' | 'rss' | 'calendar'): void {
    const modeStore = useMode.getState()
    modeStore.setWorkbenchMode(mode)
    modeStore.setReadySubMode(mode)
  }

  async function reconcileCanonicalTerminalMessage(
    scopeId: string,
    requestId: string,
    expected: CanonicalAssistantMessage,
    canonicalMessageDigest: string | null | undefined,
  ): Promise<boolean> {
    if (
      !expected?.id ||
      expected.conversationId !== scopeId ||
      expected.role !== 'assistant'
    ) {
      emitRendererAgentMetric('renderer_canonical_terminal_invalid', {
        scopeId,
        messageId: expected?.id || null,
        conversationId: expected?.conversationId || null,
      })
      return false
    }

    let canonicalRow: CanonicalAssistantMessage = expected
    const getMessages = window.electronAPI?.agent?.getConversationScopeMessages
    if (typeof getMessages === 'function') {
      try {
        const result = await getMessages(scopeId)
        const persisted = result.success && Array.isArray(result.data)
          ? result.data.find((item) => item.id === expected.id)
          : null
        if (persisted?.role === 'assistant' && persisted.conversationId === scopeId) {
          canonicalRow = {
            id: persisted.id,
            conversationId: persisted.conversationId,
            role: 'assistant',
            content: persisted.content,
            timestamp: persisted.timestamp,
            meta: persisted.meta || {},
          }
          if (
            persisted.content !== expected.content ||
            persisted.timestamp !== expected.timestamp
          ) {
            emitRendererAgentMetric('renderer_canonical_terminal_mismatch', {
              scopeId,
              messageId: expected.id,
              canonicalMessageDigest: canonicalMessageDigest || null,
            })
          }
        } else {
          emitRendererAgentMetric('renderer_canonical_terminal_readback_missing', {
            scopeId,
            messageId: expected.id,
            canonicalMessageDigest: canonicalMessageDigest || null,
          })
        }
      } catch (error) {
        emitRendererAgentMetric('renderer_canonical_terminal_readback_failed', {
          scopeId,
          messageId: expected.id,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    let reconciled = false
    store.setState((state: any) => {
      const sessionId = sessionKeyForScopeId(state, scopeId)
      const currentSlice = normalizeSessionSlice(state.sessions?.[sessionId])
      if (!state.sessions?.[sessionId] || currentSlice.conversationId !== scopeId) return {}
      const previous = currentSlice.scopeRunStates[scopeId] || null
      if (currentSlice.streamingRequestId !== requestId || previous?.requestId !== requestId) return {}
      const transientResponseId = previous.responseMessageId || null
      const ownerRunId = previous.requestId
      const scope = state.scopes.find((item: ConversationScope) => item.id === scopeId) || state.currentScope || null
      const canonicalMessage = rebuildAgentMessageFromRow(
        canonicalRow,
        previous?.executionBinding?.effectiveAgentId || scope?.agent || previous?.agent || 'butler',
      )
      const existingMessages = currentSlice.messages || []
      const nextMessages = existingMessages
        .filter((item: AgentMessage) => {
          if (item.id === canonicalMessage.id) return false
          if (transientResponseId && transientResponseId !== canonicalMessage.id && item.id === transientResponseId) return false
          const meta = (item.meta || {}) as Record<string, unknown>
          return !(ownerRunId && meta.transient === true && meta.runId === ownerRunId)
        })
        .concat(canonicalMessage)
        .sort((left: AgentMessage, right: AgentMessage) => left.timestamp.getTime() - right.timestamp.getTime())
      const nextRun = previous
        ? {
          ...previous,
          responseMessageId: canonicalMessage.id,
          responseBuffer: canonicalMessage.content,
          latestText: canonicalMessage.content.slice(-500),
          updatedAt: new Date().toISOString(),
        }
        : previous
      const live = Array.isArray(state.scopeLiveMessages?.[scopeId])
        ? state.scopeLiveMessages[scopeId]
        : []
      const nextLive = live.filter((item: AgentMessage) => {
        if (item.id === canonicalMessage.id) return false
        if (transientResponseId && transientResponseId !== canonicalMessage.id && item.id === transientResponseId) return false
        const meta = (item.meta || {}) as Record<string, unknown>
        return !(ownerRunId && meta.transient === true && meta.runId === ownerRunId)
      })
      reconciled = true
      return {
        ...withSessionSliceAndActiveRuntimeMirror(state, sessionId, {
          messages: nextMessages,
          scopeRunStates: nextRun
            ? { ...currentSlice.scopeRunStates, [scopeId]: nextRun }
            : currentSlice.scopeRunStates,
          streamingMessageId: null,
        }),
        scopeLiveMessages: {
          ...(state.scopeLiveMessages || {}),
          [scopeId]: nextLive,
        },
      }
    })
    return reconciled
  }


  return {
    completeScopeRunAfterSendSuccess,
    upsertScopeRunState,
    finalizeScopeRunAfterStreamDone,
    resolveScopeIdForRunPayload,
    reconcileCanonicalTerminalMessage,
    activateWorkbenchMode,
  }
}
