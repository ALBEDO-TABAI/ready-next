import { deriveScopeRunStatePatch, isScopeRunPhase, mergeArtifacts, phaseToToolTraceStatus } from './scopeRunState'
import { extractAttachmentsFromMeta } from './messageComposer'
import type { AgentMessage, ConversationScope, ScopeRunState } from './types'
import { mapScopeRunPhaseToSessionState } from '../../stores/agent-store-helpers'
import {
  makeEmptySessionSlice,
  sessionKeyForScopeId,
  withActiveSessionMessagesMirror,
  withSessionSliceAndActiveRuntimeMirror,
  type AgentStoreLike,
} from './runtime-driver-session-state'

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

        return {
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
          memoryRefs: patch.memoryRefs ?? event.memoryRefs ?? previousForRun?.memoryRefs ?? [],
          triggerHits: patch.triggerHits ?? event.triggerHits ?? previousForRun?.triggerHits ?? [],
          contextBudget: patch.contextBudget ?? event.contextBudget ?? previousForRun?.contextBudget ?? null,
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
          steps: patch.steps ?? previousForRun?.steps ?? [],
          currentStepId: patch.currentStepId ?? previousForRun?.currentStepId ?? null,
          waitingFor: patch.waitingFor ?? previousForRun?.waitingFor ?? 'none',
          resumableActions: patch.resumableActions ?? previousForRun?.resumableActions ?? [],
          recentArtifacts: patch.recentArtifacts ?? previousForRun?.recentArtifacts ?? [],
          taskContinuation: patch.taskContinuation ?? previousForRun?.taskContinuation ?? null,
          memoryCapture: patch.memoryCapture ?? previousForRun?.memoryCapture ?? null,
          error: patch.error ?? event.error ?? previousForRun?.error ?? null,
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
        const existing = prev.sessions[sessionId]
        // Skip lazy creation only for non-terminal phases — terminal ones
        // must always be recorded so a late `done` for an unseen session
        // doesn't leave routing accepting it.
        const nextSlice = existing
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
        // 2026-07-05 渠道双回复修复：main 持久化的 assistant 消息同时收编
        // renderer 流出来的瞬影段（不同 id、相同内容、meta.transient）——
        // 渠道 run 的 renderer 不再持久化，瞬影只在此处被真值行替换。
        const incomingContent = String(event.message.content || '').trim()
        const supersedesTransientTwin = (item: AgentMessage): boolean => Boolean(
          event.message!.role === 'assistant'
          && item.type === 'agent'
          && (item.meta as { transient?: boolean } | undefined)?.transient
          && String(item.content || '').trim() === incomingContent,
        )
        const live = state.scopeLiveMessages?.[event.scope.id]
        if (live && live.some((item: AgentMessage) => item.id === event.message!.id || supersedesTransientTwin(item))) {
          nextState.scopeLiveMessages = {
            ...state.scopeLiveMessages,
            [event.scope.id]: live.filter((item: AgentMessage) =>
              item.id !== event.message!.id && !supersedesTransientTwin(item)),
          }
        }
        if (state.currentScopeId === event.scope.id) {
          const nextMessage: AgentMessage = {
            id: event.message.id,
            agent: event.scope.agent,
            content: event.message.content,
            type: event.message.role === 'user' ? 'user' : event.message.role === 'assistant' ? 'agent' : 'system',
            timestamp: new Date(event.message.timestamp),
            attachments: extractAttachmentsFromMeta(event.message.meta),
            meta: event.message.meta || {},
          }
          const baseMessages = state.messages.filter((item: AgentMessage) => !supersedesTransientTwin(item))
          const hasMessage = baseMessages.some((message: AgentMessage) => message.id === nextMessage.id)
          Object.assign(
            nextState,
            withActiveSessionMessagesMirror(
              state,
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
