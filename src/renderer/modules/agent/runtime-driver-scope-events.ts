import { deriveScopeRunStatePatch, isScopeRunPhase, mergeArtifacts, phaseToToolTraceStatus } from './scopeRunState'
import { extractAttachmentsFromMeta } from './messageComposer'
import type { AgentMessage, ConversationScope, ScopeRunState } from './types'
import { mapScopeRunPhaseToSessionState } from '../../stores/agent-store-helpers'
import {
  makeEmptySessionSlice,
  normalizeSessionSlice,
  sessionKeyForScopeId,
  withActiveSessionMessagesMirror,
  withSessionSliceAndActiveRuntimeMirror,
  type AgentStoreLike,
} from './runtime-driver-session-state'
import { applyProductTurnReceipt, mergeProductTurnActionProjections } from './productTurnReceipt'
import { useMode } from '../../stores/useMode'

function scopeRunEventMatchesCurrentIdentity(
  state: any,
  event: {
    scopeId?: unknown
    aliasGeneration?: unknown
    messageVisibilityEpoch?: unknown
  },
): boolean {
  if (typeof event.scopeId !== 'string'
    || !Number.isSafeInteger(event.aliasGeneration)
    || !Number.isSafeInteger(event.messageVisibilityEpoch)) return false
  const scope = state.scopes?.find((candidate: ConversationScope) => candidate.id === event.scopeId)
  if (!scope
    || scope.aliasGeneration !== event.aliasGeneration
    || scope.messageVisibilityEpoch !== event.messageVisibilityEpoch) return false
  const sessionKey = sessionKeyForScopeId(state, event.scopeId)
  const slice = normalizeSessionSlice(state.sessions?.[sessionKey])
  return slice.conversationId === event.scopeId
    && slice.aliasGeneration === event.aliasGeneration
    && slice.messageVisibilityEpoch === event.messageVisibilityEpoch
}

export function installRuntimeDriverScopeEvents(deps: {
  store: AgentStoreLike
  upsertScopeRunState(scopeId: string, updater: (previous: ScopeRunState | null) => ScopeRunState): void
  refreshInfrastructureWatchdog(scopeId: string, requestId: string | null | undefined): void
  clearInfrastructureWatchdog(scopeId: string, requestId: string | null | undefined): void
}) {
  const { store, upsertScopeRunState, refreshInfrastructureWatchdog, clearInfrastructureWatchdog } = deps
  const cleanupScopeRunEvent = window.electronAPI.agent.onScopeRunEvent
    ? window.electronAPI.agent.onScopeRunEvent((event: any) => {
      if (!event.scopeId) return
      if (!isScopeRunPhase(event.phase) || event.phase === 'idle') return
      const authoritative = store.getState()
      if (authoritative.retiredScopeIds?.[event.scopeId]
        || !scopeRunEventMatchesCurrentIdentity(authoritative, event)) return

      upsertScopeRunState(event.scopeId, (previous) => {
        const startedNewRun = Boolean(
          event.type === 'started' &&
          event.runId &&
          previous?.requestId &&
          previous.requestId !== event.runId,
        )
        const previousForRun = startedNewRun ? null : previous
        if (
          event.type !== 'started'
          && event.runId
          && previous?.requestId
          && previous.requestId !== event.runId
        ) {
          return previous
        }
        const currentState = store.getState()
        const activeMessage = previousForRun?.responseMessageId
          ? currentState.messages.find((item: AgentMessage) => item.id === previousForRun.responseMessageId) || null
          : null
        const shouldBreakSegment = Boolean(
          event.toolEvent &&
          previousForRun?.responseMessageId &&
          String(activeMessage?.content || previousForRun?.responseBuffer || '').trim(),
        )
        const toolTrace = previousForRun?.toolTrace || []
        const nextTrace = event.toolEvent
          ? [
            ...toolTrace,
            {
              id: event.toolEvent.id,
              kind: event.toolEvent.kind,
              text: event.toolEvent.text,
              timestamp: new Date(event.toolEvent.timestamp),
              ...(typeof event.toolEvent.toolName === 'string' && event.toolEvent.toolName
                ? { toolName: event.toolEvent.toolName }
                : {}),
              ...(typeof event.toolEvent.detail === 'string' && event.toolEvent.detail
                ? { detail: event.toolEvent.detail }
                : {}),
            },
          ]
          : toolTrace
        const patch = deriveScopeRunStatePatch(event, previousForRun)

        const nextRun: ScopeRunState = {
          scopeId: event.scopeId,
          agent: previousForRun?.agent || event.agent,
          ownerAgentId: event.ownerAgentId ?? previousForRun?.ownerAgentId ?? null,
          executionBinding: event.executionBinding ?? previousForRun?.executionBinding ?? null,
          executionAgentDisplayName: event.executionAgentDisplayName ?? previousForRun?.executionAgentDisplayName ?? null,
          requestId: event.runId || previousForRun?.requestId || null,
          taskId: event.taskId || previousForRun?.taskId || patch.taskContinuation?.taskId || null,
          phase: patch.phase || event.phase,
          terminalReason: patch.terminalReason ?? null,
          toolTrace: nextTrace,
          startedAt: previousForRun?.startedAt || event.timestamp,
          updatedAt: event.timestamp,
          latestText: patch.latestText ?? previousForRun?.latestText ?? null,
          module: patch.module ?? event.module ?? previousForRun?.module ?? null,
          intent: patch.intent ?? event.intent ?? previousForRun?.intent ?? null,
          executionKind: patch.executionKind ?? event.executionKind ?? previousForRun?.executionKind ?? null,
          jobId: patch.jobId ?? event.jobId ?? previousForRun?.jobId ?? null,
          artifactRefs: mergeArtifacts(previousForRun?.artifactRefs, patch.artifactRefs ?? event.artifactRefs),
          contextUsage: patch.contextUsage ?? event.contextUsage ?? previousForRun?.contextUsage ?? null,
          ownerResourceId: patch.ownerResourceId ?? event.ownerResourceId ?? previousForRun?.ownerResourceId ?? null,
          lastEvidenceAt: patch.lastEvidenceAt ?? event.lastEvidenceAt ?? previousForRun?.lastEvidenceAt ?? null,
          blockedReason: patch.blockedReason ?? previousForRun?.blockedReason ?? null,
          controllerId: patch.controllerId ?? previousForRun?.controllerId ?? null,
          ownerTabId: patch.ownerTabId ?? previousForRun?.ownerTabId ?? null,
          checkpointExpiresAt: patch.checkpointExpiresAt ?? previousForRun?.checkpointExpiresAt ?? null,
          responseMessageId: previousForRun?.responseMessageId || null,
          responseBuffer: previousForRun?.responseBuffer || '',
          responseSegmentBreakPending: shouldBreakSegment
            ? true
            : previousForRun?.responseSegmentBreakPending ?? false,
          responseSegmentToolTraceStart: previousForRun?.responseSegmentToolTraceStart ?? 0,
          stepMetrics: patch.stepMetrics ?? previousForRun?.stepMetrics ?? { toolCalls: 0, toolResults: 0, lastToolAt: null },
          designPhase: patch.designPhase ?? previousForRun?.designPhase ?? null,
          designTodo: patch.designTodo ?? previousForRun?.designTodo ?? [],
          designReviewSummary: patch.designReviewSummary ?? previousForRun?.designReviewSummary ?? null,
          ownedNodeIds: patch.ownedNodeIds ?? previousForRun?.ownedNodeIds ?? [],
          repairScope: patch.repairScope ?? previousForRun?.repairScope ?? null,
          taskTitle: patch.taskTitle ?? previousForRun?.taskTitle ?? null,
          taskSummary: patch.taskSummary ?? previousForRun?.taskSummary ?? null,
          activityNarration: patch.activityNarration ?? null,
          steps: patch.steps ?? previousForRun?.steps ?? [],
          currentStepId: patch.currentStepId ?? previousForRun?.currentStepId ?? null,
          waitingFor: patch.waitingFor ?? previousForRun?.waitingFor ?? 'none',
          resumableActions: patch.resumableActions ?? previousForRun?.resumableActions ?? [],
          recentArtifacts: patch.recentArtifacts ?? previousForRun?.recentArtifacts ?? [],
          taskContinuation: patch.taskContinuation ?? previousForRun?.taskContinuation ?? null,
          error: patch.error ?? event.error ?? previousForRun?.error ?? null,
        }
        return event.productTurnReceipt
          ? applyProductTurnReceipt(nextRun, event.productTurnReceipt)
          : nextRun
      })

      if (event.productTurnReceipt) {
        store.setState((state: any) => {
          if (!scopeRunEventMatchesCurrentIdentity(state, event)) return state
          const sessionId = sessionKeyForScopeId(state, event.scopeId)
          const slice = normalizeSessionSlice(state.sessions?.[sessionId])
          if (event.productTurnReceipt.readyScopeId !== event.scopeId) return state
          return withSessionSliceAndActiveRuntimeMirror(state, sessionId, {
            productTurnActionProjectionByRunId: mergeProductTurnActionProjections({
              existing: slice.productTurnActionProjectionByRunId,
              incoming: [event.productTurnReceipt.actionProjection],
              head: slice.scopeHeadActionProjection,
              workbenchMode: useMode.getState().workbenchMode,
            }),
          })
        })
      }

      if (!scopeRunEventMatchesCurrentIdentity(store.getState(), event)) return
      const detachedJobEvent = event.module === 'skill' && event.executionKind === 'job' && String(event.taskId || '').startsWith('detached:')
      refreshInfrastructureWatchdog(event.scopeId, event.runId || store.getState().scopeRunStates[event.scopeId]?.requestId || null)
      // Every foreground run owns its session slice even when that session is
      // parked. The helper mirrors to top-level state only when the owner is
      // active, so background started events cannot leave two run identities.
      if (
        event.type === 'started' &&
        !detachedJobEvent &&
        typeof event.runId === 'string' &&
        event.runId.trim()
      ) {
        store.setState((state: any) => (
          scopeRunEventMatchesCurrentIdentity(state, event)
            ? withSessionSliceAndActiveRuntimeMirror(
                state,
                sessionKeyForScopeId(state, event.scopeId),
                { streamingRequestId: event.runId.trim() },
              )
            : state
        ))
      }
      // Failure and cancellation events unwind the originating session's
      // slice even when the user has switched away. Successful completion
      // stays locked until the canonical assistant message is reconciled by
      // the stream-done or send-success path.
      const terminalRunEvent = Boolean(
        store.getState().scopeRunStates[event.scopeId]?.terminalReason ||
        event.phase === 'done' ||
        event.phase === 'error' ||
        event.phase === 'cancelled',
      )
      const stateAfterRunPatch = store.getState()
      if (!scopeRunEventMatchesCurrentIdentity(stateAfterRunPatch, event)) return
      const ownerSessionId = sessionKeyForScopeId(stateAfterRunPatch, event.scopeId)
      const ownerSlice = normalizeSessionSlice(stateAfterRunPatch.sessions?.[ownerSessionId])
      const eventRunId = typeof event.runId === 'string' && event.runId.trim()
        ? event.runId.trim()
        : null
      const scopeRunRequestId = typeof ownerSlice.scopeRunStates[event.scopeId]?.requestId === 'string'
        && ownerSlice.scopeRunStates[event.scopeId]?.requestId?.trim()
        ? ownerSlice.scopeRunStates[event.scopeId]?.requestId?.trim()
        : null
      const exactTerminalRunEvent = Boolean(
        terminalRunEvent &&
        eventRunId &&
        ownerSlice.streamingRequestId === eventRunId &&
        scopeRunRequestId === eventRunId,
      )
      const reconcileUnknownStop = ownerSlice.lifecyclePendingAction === 'stopping'
        || (
          ownerSlice.lifecycleError?.action === 'stop'
          && ownerSlice.lifecycleError.code === 'interrupt_state_unknown'
        )
      const unlockFromScopeEvent = exactTerminalRunEvent && event.phase !== 'done'
      if (exactTerminalRunEvent) {
        if (!scopeRunEventMatchesCurrentIdentity(store.getState(), event)) return
        const latestRunState = ownerSlice.scopeRunStates[event.scopeId] || null
        // Stage X2.6 — terminal scope-run event clears the
        // infrastructure watchdog for this scope.
        clearInfrastructureWatchdog(
          event.scopeId,
          eventRunId,
        )
        store.setState((state: any) => {
          if (!scopeRunEventMatchesCurrentIdentity(state, event)) return state
          const foldedMessages = (state.messages as AgentMessage[]).map((message) => {
            if (
              message.type !== 'ask_user_questions'
              || message.askUserQuestions?.status !== 'pending'
            ) return message
            return {
              ...message,
              askUserQuestions: {
                ...message.askUserQuestions,
                status: 'cancelled' as const,
                cancelReason: 'app_restart',
                cancelledAt: Date.now(),
              },
            }
          })
          return {
            ...withSessionSliceAndActiveRuntimeMirror(
              {
                ...state,
                ...withActiveSessionMessagesMirror(state, foldedMessages),
              },
              sessionKeyForScopeId(state, event.scopeId),
              {
                ...(reconcileUnknownStop
                  ? { lifecyclePendingAction: null, lifecycleError: null }
                  : {}),
                ...(unlockFromScopeEvent
                  ? {
                    isStreaming: false,
                    foregroundBusy: false,
                    composerLocked: false,
                    streamingMessageId: null,
                    streamingRequestId: null,
                  }
                  : {}),
              },
            ),
            // Top-level toolTraceStatus is the active-session mirror, so
            // only refresh it when the terminal event belongs to the
            // currently-visible scope.
            ...(state.currentScopeId === event.scopeId
              ? { toolTraceStatus: phaseToToolTraceStatus(latestRunState?.phase || event.phase, latestRunState?.terminalReason || event.terminalReason) }
              : {}),
          }
        })
      }
    })
    : () => { /* older test stubs */ }

  // Phase D D2（2026-07-05）：会话路由的 scopeRunEvent 终态转移原是
  // useAgent.initAgentInteractionListeners 里的并行旁路订阅（双真相源），
  // 迁入本枢纽成为第二订阅——注册序与旧结构一致（枢纽主订阅在前），
  // renderer 全域每个 run 通道只剩 runtimeDriver 一个订阅文件（D3 gate 钉）。
  const cleanupScopeRunRouting = window.electronAPI.agent.onScopeRunEvent
    ? window.electronAPI.agent.onScopeRunEvent((event: any) => {
      const sessionId = (event as { sessionId?: string | null }).sessionId
      if (!sessionId) return
      const nextState = mapScopeRunPhaseToSessionState(event.phase)
      if (!nextState) return
      store.setState((prev: any) => {
        if (prev.retiredScopeIds?.[event.scopeId]
          || !scopeRunEventMatchesCurrentIdentity(prev, event)) return prev
        const eventRunId = typeof event.runId === 'string' && event.runId.trim()
          ? event.runId.trim()
          : null
        const ownerSessionId = sessionKeyForScopeId(prev, event.scopeId)
        const ownerSlice = normalizeSessionSlice(prev.sessions?.[ownerSessionId])
        const currentRunId = ownerSlice.scopeRunStates[event.scopeId]?.requestId || null
        if (eventRunId && currentRunId && eventRunId !== currentRunId) return prev
        const existing = prev.sessions[sessionId]
        if (!existing) return prev
        const nextSlice = { ...existing, state: nextState }
        return {
          sessions: {
            ...prev.sessions,
            [sessionId]: nextSlice,
          },
        }
      })
    })
    : () => { /* older preview stubs do not surface onScopeRunEvent */ }

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
      if (state.retiredScopeIds?.[event.scope.id]) return state
      const existing = state.scopes.find((scope: ConversationScope) => scope.id === event.scope.id)
      if (!existing && event.type !== 'scope_created') return state
      const existingVisibilityEpoch = existing?.messageVisibilityEpoch ?? 0
      const eventVisibilityEpoch = Number.isSafeInteger(event.scope.messageVisibilityEpoch)
        ? event.scope.messageVisibilityEpoch
        : 0
      const eventAliasGeneration = Number.isSafeInteger(event.scope.aliasGeneration)
        ? event.scope.aliasGeneration
        : existing?.aliasGeneration
      event.scope = {
        ...event.scope,
        aliasGeneration: eventAliasGeneration,
        messageVisibilityEpoch: eventVisibilityEpoch,
      }
      if (existing && eventVisibilityEpoch < existingVisibilityEpoch) return state
      if (existing
        && typeof existing.aliasGeneration === 'number'
        && typeof event.scope.aliasGeneration === 'number'
        && event.scope.aliasGeneration < existing.aliasGeneration) return state
      let workingState = state
      if (existing && eventVisibilityEpoch > existingVisibilityEpoch) {
        const sessionKey = sessionKeyForScopeId(state, event.scope.id)
        const previousSlice = normalizeSessionSlice(state.sessions?.[sessionKey])
        const nextSlice = {
          ...makeEmptySessionSlice(event.scope.id),
          aliasGeneration: typeof event.scope.aliasGeneration === 'number'
            ? Math.max(event.scope.aliasGeneration, previousSlice.aliasGeneration ?? 0)
            : previousSlice.aliasGeneration,
          messageVisibilityEpoch: eventVisibilityEpoch,
        }
        const scopeLiveMessages = { ...(state.scopeLiveMessages || {}) }
        delete scopeLiveMessages[event.scope.id]
        const sessions = { ...state.sessions, [sessionKey]: nextSlice }
        workingState = {
          ...state,
          sessions,
          scopeLiveMessages,
          ...(state.currentScopeId === event.scope.id
            ? {
                messages: [],
                scopeRunStates: {},
                isStreaming: false,
                foregroundBusy: false,
                composerLocked: false,
                streamingMessageId: null,
                streamingRequestId: null,
                attachments: [],
                filePool: [],
                activeAttachmentPreview: null,
                pendingContinuationIntent: null,
                pendingContinuationDraftAnchor: null,
                toolTrace: [],
                toolTraceStatus: 'idle',
                composerAuthorityRevision: Number(state.composerAuthorityRevision || 0) + 1,
              }
            : {}),
        }
      } else if (existing && typeof eventAliasGeneration === 'number') {
        const sessionKey = sessionKeyForScopeId(state, event.scope.id)
        const previousSlice = normalizeSessionSlice(state.sessions?.[sessionKey])
        if (previousSlice.aliasGeneration !== eventAliasGeneration) {
          workingState = {
            ...state,
            sessions: {
              ...state.sessions,
              [sessionKey]: {
                ...previousSlice,
                aliasGeneration: eventAliasGeneration,
              },
            },
          }
        }
      }
      const mergedScopes = existing
        ? workingState.scopes.map((scope: ConversationScope) => scope.id === event.scope.id ? event.scope : scope)
        : [event.scope, ...workingState.scopes]
      const nextState: Record<string, unknown> = {
        ...workingState,
        scopes: mergedScopes,
        conversations: mergedScopes.map((scope: ConversationScope) => ({
          id: scope.id,
          agent: scope.agent,
          title: scope.title,
          created_at: scope.createdAt,
          updated_at: scope.updatedAt,
        })),
        ...(!existing || eventVisibilityEpoch > existingVisibilityEpoch
          ? { scopeAuthorityRevision: Number(workingState.scopeAuthorityRevision || 0) + 1 }
          : {}),
      }

      if (workingState.currentScopeId === event.scope.id) {
        nextState.currentScope = event.scope
      }

      if (event.type === 'message_added' && event.message) {
        // EP2 P0-2 — a persisted message supersedes its live-cache twin for
        // ANY scope (the DB row is what the next loadScope returns).
        // 2026-07-05 渠道双回复修复：main 持久化的 assistant 消息同时收编
        // renderer 流出来的瞬影段（不同 id、相同内容、meta.transient）——
        // 渠道 run 的 renderer 不再持久化，瞬影只在此处被真值行替换。
        const incomingContent = String(event.message.content || '').trim()
        const incomingRunId = typeof event.message.meta?.runId === 'string'
          ? event.message.meta.runId.trim()
          : ''
        const activeRunId = typeof workingState.scopeRunStates?.[event.scope.id]?.requestId === 'string'
          ? workingState.scopeRunStates[event.scope.id].requestId.trim()
          : ''
        const supersedesTransientTwin = (item: AgentMessage): boolean => Boolean(
          event.message!.role === 'assistant'
          && item.type === 'agent'
          && (item.meta as { transient?: boolean } | undefined)?.transient
          && (() => {
            const transientRunId = typeof item.meta?.runId === 'string'
              ? item.meta.runId.trim()
              : ''
            if (incomingRunId || transientRunId) {
              return Boolean(incomingRunId && transientRunId && incomingRunId === transientRunId)
            }
            return !activeRunId
          })()
          && String(item.content || '').trim() === incomingContent,
        )
        const live = workingState.scopeLiveMessages?.[event.scope.id]
        if (live && live.some((item: AgentMessage) => item.id === event.message!.id || supersedesTransientTwin(item))) {
          nextState.scopeLiveMessages = {
            ...workingState.scopeLiveMessages,
            [event.scope.id]: live.filter((item: AgentMessage) =>
              item.id !== event.message!.id && !supersedesTransientTwin(item)),
          }
        }
        if (workingState.currentScopeId === event.scope.id) {
          const nextMessage: AgentMessage = {
            id: event.message.id,
            agent: event.scope.agent,
            content: event.message.content,
            type: event.message.role === 'user' ? 'user' : event.message.role === 'assistant' ? 'agent' : 'system',
            timestamp: new Date(event.message.timestamp),
            attachments: extractAttachmentsFromMeta(event.message.meta),
            meta: event.message.meta || {},
          }
          const baseMessages = workingState.messages.filter((item: AgentMessage) => !supersedesTransientTwin(item))
          const hasMessage = baseMessages.some((message: AgentMessage) => message.id === nextMessage.id)
          Object.assign(
            nextState,
            withActiveSessionMessagesMirror(
              workingState,
              hasMessage ? baseMessages : [...baseMessages, nextMessage],
            ),
          )
        }
      }

      return nextState
    })
  })


  return { cleanupScopeRunEvent, cleanupScopeRunRouting, cleanupConversationEvent }
}
