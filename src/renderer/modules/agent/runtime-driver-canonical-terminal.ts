import type { CanonicalAssistantMessage } from '../../../shared/ipc-contracts/canonical-message'
import type { AgentMessage, ConversationScope, ScopeRunState } from './types'
import { useMode } from '../../stores/useMode'
import { rebuildAgentMessageFromRow } from '../../stores/agent-store-helpers'
import { emitRendererAgentMetric } from './rendererMetrics'
import { isForegroundBusyScopeRunState } from './scopeRunState'
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
  function completeScopeRunAfterSendSuccess(
    scopeId: string,
    requestId: string,
    options?: {
      canonicalMessage?: CanonicalAssistantMessage | null
      canonicalMessageDigest?: string | null
      acceptedAsSteering?: boolean
      ownerRunId?: string | null
      previousOwnerRun?: ScopeRunState | null
    },
  ): void {
    if (options?.acceptedAsSteering) {
      clearInfrastructureWatchdog(scopeId, requestId)
      store.setState((state: any) => {
        const sessionId = sessionKeyForScopeId(state, scopeId)
        const currentSlice = normalizeSessionSlice(state.sessions?.[sessionId])
        const currentRun = currentSlice.scopeRunStates[scopeId] || getScopeRunStateFromState(state, scopeId)
        const ownerRunId = options.ownerRunId || options.previousOwnerRun?.requestId || currentRun?.requestId || null
        const restoredRun = currentRun?.requestId !== requestId
          ? currentRun
          : options.previousOwnerRun?.requestId === ownerRunId
            ? options.previousOwnerRun
            : currentRun && ownerRunId
              ? {
                ...currentRun,
                requestId: ownerRunId,
                responseMessageId: null,
                responseBuffer: '',
                terminalReason: null,
                updatedAt: new Date().toISOString(),
              }
              : currentRun
        const isFakeTransient = (message: AgentMessage): boolean => {
          const meta = (message.meta || {}) as Record<string, unknown>
          return meta.transient === true && meta.runId === requestId
        }
        const nextMessages = (currentSlice.messages || state.messages || []).filter((message: AgentMessage) => !isFakeTransient(message))
        const nextLive = Array.isArray(state.scopeLiveMessages?.[scopeId])
          ? state.scopeLiveMessages[scopeId].filter((message: AgentMessage) => !isFakeTransient(message))
          : []
        const ownerStillBusy = isForegroundBusyScopeRunState(restoredRun)
        return {
          ...withSessionSliceAndActiveRuntimeMirror(state, sessionId, {
            messages: nextMessages,
            scopeRunStates: restoredRun
              ? { ...currentSlice.scopeRunStates, [scopeId]: restoredRun }
              : currentSlice.scopeRunStates,
            isStreaming: ownerStillBusy,
            foregroundBusy: ownerStillBusy,
            composerLocked: ownerStillBusy,
            streamingMessageId: ownerStillBusy ? restoredRun?.responseMessageId || null : null,
            streamingRequestId: ownerStillBusy ? ownerRunId : null,
          }),
          scopeLiveMessages: {
            ...(state.scopeLiveMessages || {}),
            [scopeId]: nextLive,
          },
        }
      })
      return
    }

    if (!options?.canonicalMessage) {
      const currentRun = getScopeRunStateFromState(store.getState(), scopeId)
      if (currentRun?.requestId === requestId && currentRun.terminalReason) {
        clearInfrastructureWatchdog(scopeId, requestId)
        return
      }
      emitRendererAgentMetric('renderer_send_success_without_canonical_terminal', {
        scopeId,
        requestId,
      })
      return
    }

    clearInfrastructureWatchdog(scopeId, requestId)
    let persistedRunState: ScopeRunState | null = null
    store.setState((state: any) => {
      const sessionId = sessionKeyForScopeId(state, scopeId)
      const currentSlice = normalizeSessionSlice(state.sessions?.[sessionId])
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
        isStreaming: false,
        foregroundBusy: false,
        composerLocked: false,
        streamingMessageId: null,
        streamingRequestId: null,
      })
    })

    if (persistedRunState && options?.canonicalMessage) {
      const state = store.getState()
      const latestRunState = getScopeRunStateFromState(state, scopeId) || persistedRunState
      void reconcileCanonicalTerminalMessage(
        scopeId,
        latestRunState,
        options.canonicalMessage,
        options.canonicalMessageDigest,
      )
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

  function finalizeScopeRunAfterStreamDone(scopeId: string, fallbackRunState: ScopeRunState | null): void {
    store.setState((state: any) => {
      const sessionId = sessionKeyForScopeId(state, scopeId)
      const currentSlice = normalizeSessionSlice(state.sessions?.[sessionId])
      const previous = currentSlice.scopeRunStates[scopeId] || getScopeRunStateFromState(state, scopeId) || fallbackRunState || null
      const nextScopeRunStates = previous
        ? {
          ...currentSlice.scopeRunStates,
          [scopeId]: finalizeDoneRunState(previous, scopeId),
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
    runState: ScopeRunState | null,
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

    store.setState((state: any) => {
      const sessionId = sessionKeyForScopeId(state, scopeId)
      const currentSlice = normalizeSessionSlice(state.sessions?.[sessionId])
      const previous = currentSlice.scopeRunStates[scopeId] || getScopeRunStateFromState(state, scopeId) || runState
      const transientResponseId = previous?.responseMessageId || runState?.responseMessageId || null
      const ownerRunId = previous?.requestId || runState?.requestId || null
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
    return true
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
