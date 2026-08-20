import { executeModuleToolAction, handleModuleToolAction } from './moduleExecutor'
import { cancelAllPendingWidgetWrites } from './documentActions'
import type { Agent, ScopeRunState } from './types'
import { mapBackendErrorToFriendly } from './error-message-mapping'
import { emitRendererAgentMetric } from './rendererMetrics'
import {
  createRuntimeDriverCanonicalTerminal,
} from './runtime-driver-canonical-terminal'
import { installRuntimeDriverScopeEvents } from './runtime-driver-scope-events'
import {
  normalizeSessionSlice, sessionKeyForScopeId,
  withSessionSliceAndActiveRuntimeMirror,
  type AgentStoreLike
} from './runtime-driver-session-state'
import { installRuntimeDriverStreamEvents } from './runtime-driver-stream-events'
import { createRuntimeDriverWatchdog } from './runtime-driver-watchdog'

export {
  collapseAdjacentDuplicateAssistantTail,
  syncActiveScopeRunAliases,
  upsertStreamedSegmentCache,
} from './runtime-driver-session-state'

/**
 * Stage X2.6 — infrastructure timeout safety net.
 *
 * Default bootstrap window: 60s. If the renderer has not observed runtime
 * liveness by then, it asks main for the request's authoritative state.
 * A matching active run is never cancelled here: the probe is re-armed on a
 * longer interval and main's independent no-progress guard remains the only
 * authority allowed to stop a live request.
 *
 * Independent of `ProviderTerminalError` because no error was ever
 * delivered (main process crashed, IPC dropped, etc.). See plan §7.2
 * last paragraph.
 */
export function createAgentRuntimeDriver(store: AgentStoreLike) {
  let listenersInitialized = false
  const watchdog = createRuntimeDriverWatchdog(store)
  const {
    armInfrastructureWatchdog,
    clearInfrastructureWatchdog,
    refreshInfrastructureWatchdog,
    getScopeRunStateFromState,
    findScopeIdByRunId,
    finalizeDoneRunState,
  } = watchdog

  const canonicalTerminal = createRuntimeDriverCanonicalTerminal({
    store,
    clearInfrastructureWatchdog,
    getScopeRunStateFromState,
    findScopeIdByRunId,
    finalizeDoneRunState,
  })
  const {
    completeScopeRunAfterSendSuccess,
    upsertScopeRunState,
    finalizeScopeRunAfterStreamDone,
    resolveScopeIdForRunPayload,
    reconcileCanonicalTerminalMessage,
    activateWorkbenchMode,
  } = canonicalTerminal

  function normalizeRunId(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null
  }

  function isCurrentScopeRun(scopeId: string, rawRunId: unknown): boolean {
    const runId = normalizeRunId(rawRunId)
    if (!runId) return false
    const state = store.getState()
    const sessionId = sessionKeyForScopeId(state, scopeId)
    const slice = normalizeSessionSlice(state.sessions?.[sessionId])
    const streamingRequestId = normalizeRunId(slice.streamingRequestId)
    const currentRun = slice.scopeRunStates[scopeId] || getScopeRunStateFromState(state, scopeId)
    const scopeRunRequestId = normalizeRunId(currentRun?.requestId)
    if (streamingRequestId && scopeRunRequestId) {
      return streamingRequestId === runId && scopeRunRequestId === runId
    }
    if (streamingRequestId) return streamingRequestId === runId
    if (scopeRunRequestId !== runId) return false
    return !currentRun?.terminalReason
      && currentRun?.phase !== 'done'
      && currentRun?.phase !== 'error'
      && currentRun?.phase !== 'cancelled'
  }

  function upsertCurrentScopeRun(
    scopeId: string,
    runId: string,
    updater: (previous: ScopeRunState | null) => ScopeRunState,
  ): void {
    if (!isCurrentScopeRun(scopeId, runId)) return
    upsertScopeRunState(scopeId, (previous) => {
      if (previous?.requestId && previous.requestId !== runId) return previous
      return updater(previous)
    })
  }

  function initAgentListeners(): () => void {
    if (listenersInitialized) return () => { /* already initialized */ }
    if (typeof window === 'undefined' || !window.electronAPI) return () => { /* no electronAPI */ }

    listenersInitialized = true

    const cleanupStream = installRuntimeDriverStreamEvents({
      store,
      resolveScopeIdForRunPayload,
      refreshInfrastructureWatchdog,
      clearInfrastructureWatchdog,
      reconcileCanonicalTerminalMessage,
      finalizeScopeRunAfterStreamDone,
      upsertScopeRunState,
    })

    const cleanupStatus = window.electronAPI.agent.onStatusChange((data) => {
      if (data.agent !== 'butler') return
      store.getState().setReadyStatus(data.status as Agent['status'])
    })

    const cleanupError = window.electronAPI.agent.onError((data) => {
      const scopeId = resolveScopeIdForRunPayload(data)
      if (!scopeId) return
      if (!isCurrentScopeRun(scopeId, data.runId)) return

      // Phase 3: double-defense — AbortError is already short-circuited inside
      // turn-engine before emitRuntimeError fires, but if anything ever leaks
      // through as 'aborted' we still want to avoid showing a capsule OR a
      // system message (cancellation has its own runComplete path).
      if (data.errorKind === 'aborted') return

      const recoverable = data.recoverable === true

      const state = store.getState()
      const runState = getScopeRunStateFromState(state, scopeId)
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
        error: friendly.friendlyMessage,
        softError: null,
      }))
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
          const runId = normalizeRunId(data.runId)
          if (!runId || !isCurrentScopeRun(scopeId, runId)) return
          const handled = await handleModuleToolAction({
            scopeId,
            agentName,
            tool,
            args,
            runId,
            activateWorkbenchMode,
            upsertScopeRunState: (targetScopeId, updater) => {
              if (targetScopeId !== scopeId) return
              upsertCurrentScopeRun(targetScopeId, runId, updater)
            },
            getScopeRunState: () => isCurrentScopeRun(scopeId, runId)
              ? getScopeRunStateFromState(store.getState(), scopeId)
              : null,
          })
          if (!isCurrentScopeRun(scopeId, runId)) return
          if (!handled) return
        })
        .catch((error) => {
          const scopeId = resolveScopeIdForRunPayload(data)
          const runId = normalizeRunId(data.runId)
          if (!scopeId || !runId || !isCurrentScopeRun(scopeId, runId)) return
          upsertCurrentScopeRun(scopeId, runId, (previous) => ({
            scopeId,
            agent: previous?.agent || store.getState().currentAgent,
            requestId: previous?.requestId || runId,
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

      const runId = normalizeRunId(data.runId)
      if (!runId || !isCurrentScopeRun(scopeId, runId)) {
        activeToolRequests.delete(requestId)
        logToolEvent({
          type: 'cancel',
          requestId,
          tool: String(data.tool || ''),
          scopeId,
          error: 'stale_run',
        })
        await window.electronAPI.agent.completeToolActionRequest({
          requestId,
          handled: false,
          error: 'stale_run',
        }).catch(() => { /* ignore */ })
        return
      }

      const agentName = typeof data.agent === 'string' && data.agent.trim() ? data.agent : store.getState().currentAgent
      const tool = String(data.tool || '').trim()
      const args = (data.args || {}) as Record<string, unknown>
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
            upsertScopeRunState: (targetScopeId, updater) => {
              if (targetScopeId !== scopeId) return
              upsertCurrentScopeRun(targetScopeId, runId, updater)
            },
            getScopeRunState: () => isCurrentScopeRun(scopeId, runId)
              ? getScopeRunStateFromState(store.getState(), scopeId)
              : null,
          }),
          watchdogPromise,
          cancelPromise,
        ])
        if (!isCurrentScopeRun(scopeId, runId)) {
          await window.electronAPI.agent.completeToolActionRequest({
            requestId,
            handled: false,
            error: 'stale_run',
          })
          logToolEvent({
            type: 'cancel',
            requestId,
            tool,
            scopeId,
            elapsedMs: Date.now() - startedAt,
            error: 'stale_run',
          })
          return
        }
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
        const stillCurrent = isCurrentScopeRun(scopeId, runId)
        const message = stillCurrent
          ? error instanceof Error ? error.message : String(error)
          : 'stale_run'
        // For cancelled we've already been told; still ack so main's pending map releases even if
        // the cancel IPC was missed. completeToolActionRequest on an unknown id is a no-op.
        await window.electronAPI.agent.completeToolActionRequest({
          requestId,
          handled: false,
          error: message,
        }).catch(() => { /* ignore */ })
        if (!stillCurrent) return
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
            const runId = normalizeRunId(data.runId)
            if (scopeId && runId && isCurrentScopeRun(scopeId, runId)) {
              upsertCurrentScopeRun(scopeId, runId, (previous) => ({
                scopeId,
                agent: previous?.agent || store.getState().currentAgent,
                requestId: previous?.requestId || runId,
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

    const {
      cleanupScopeRunEvent,
      cleanupScopeRunRouting,
      cleanupConversationEvent,
    } = installRuntimeDriverScopeEvents({
      store,
      upsertScopeRunState,
      refreshInfrastructureWatchdog,
      clearInfrastructureWatchdog,
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
      cleanupScopeRunRouting()
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
    __getInfrastructureTimeoutMs: watchdog.getInfrastructureTimeoutMs,
    __getLastInfrastructureToastAt: watchdog.getLastInfrastructureToastAt,
  }
}
