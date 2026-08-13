import { createEmptyScopeRunState } from './scopeRunState'
import type { ScopeRunState } from './types'
import { emitRendererAgentMetric } from './rendererMetrics'
import { reportInfrastructureTimeoutToMain } from './runtime-driver-watchdog-main-report'
import {
  activeSessionKeyFromState,
  normalizeSessionSlice,
  sessionKeyForScopeId,
  withSessionSliceAndActiveRuntimeMirror,
  type AgentStoreLike,
} from './runtime-driver-session-state'

const INFRASTRUCTURE_TIMEOUT_MS = 60_000
const ACTIVE_RUN_INFRASTRUCTURE_TIMEOUT_MS = 5 * 60_000
// B step 1 — the renderer→main liveness round-trip can take well over 1s, so a
// 1s ack races it: evidence showed only 3/10 reports reached main, and
// the 7 "lost" ones triggered the renderer's local false-recovery (contract
// breach). A 5s ack lets a slow-but-alive main reliably answer so the renderer
// only declares lost-track when main is genuinely unreachable.
// B step 2 (Option A) — when main is unreachable (report returns null after the
// 5s ack) the renderer must NOT locally claim recovery. It re-arms a bounded
// retry instead; a terminal event from main cancels it via clearInfrastructure-
// Watchdog. Only after retries are exhausted does it surface an HONEST
// run-state-unknown notice (never "已自动恢复"). ~3 × 8s ≈ a bounded wait, far
// better than a 15-min lock and never a false "stopped" claim.
const INFRASTRUCTURE_TIMEOUT_REPORT_RETRY_DELAY_MS = 2_000
const INFRASTRUCTURE_TIMEOUT_REPORT_MAX_RETRIES = 1

interface InfrastructureWatchdog {
  scopeId: string
  requestId: string
  timer: ReturnType<typeof setTimeout>
  startedAt: number
  timeoutMs: number
  /** B step 2 — main-unreachable report retries already attempted. */
  reportRetries?: number
}

export function createRuntimeDriverWatchdog(store: AgentStoreLike) {
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

  function getScopeRunStateFromState(state: any, scopeId: string | null | undefined): ScopeRunState | null {
    if (!scopeId) return null
    const sessionId = sessionKeyForScopeId(state, scopeId)
    const currentSlice = normalizeSessionSlice(state.sessions?.[sessionId])
    const fromCurrentSlice = currentSlice.scopeRunStates?.[scopeId] || null
    if (fromCurrentSlice) return fromCurrentSlice
    const fromTopLevel = state.scopeRunStates?.[scopeId] || null
    if (fromTopLevel) return fromTopLevel
    for (const sliceInput of Object.values(state.sessions || {}) as unknown[]) {
      const slice = normalizeSessionSlice(sliceInput)
      const candidate = slice.scopeRunStates?.[scopeId] || null
      if (candidate) return candidate
    }
    return null
  }

  function findScopeIdByRunId(state: any, runId: string | null | undefined, agent?: string): string | null {
    const requestId = typeof runId === 'string' && runId.trim() ? runId.trim() : null
    if (!requestId) return null
    const scan = (scopeRunStates: Record<string, ScopeRunState> | null | undefined): string | null => {
      for (const [scopeId, runState] of Object.entries(scopeRunStates || {})) {
        if (runState.requestId !== requestId) continue
        if (agent && runState.agent !== agent) continue
        return scopeId
      }
      return null
    }
    const activeSessionId = activeSessionKeyFromState(state)
    const activeSlice = normalizeSessionSlice(state.sessions?.[activeSessionId])
    const fromActiveSlice = scan(activeSlice.scopeRunStates)
    if (fromActiveSlice) return fromActiveSlice
    for (const sliceInput of Object.values(state.sessions || {}) as unknown[]) {
      const slice = normalizeSessionSlice(sliceInput)
      const fromSlice = scan(slice.scopeRunStates)
      if (fromSlice) return fromSlice
    }
    return scan(state.scopeRunStates)
  }

  function finalizeDoneRunState(previous: ScopeRunState, scopeId: string): ScopeRunState {
    const updatedAt = new Date().toISOString()
    const hasArtifacts = (previous.recentArtifacts || []).length > 0 || (previous.artifactRefs || []).length > 0
    const existingActions = previous.resumableActions || []
    const resumableActions: ScopeRunState['resumableActions'] = existingActions.some((action) => action && action !== 'none')
      ? existingActions
      : hasArtifacts ? ['open_artifact'] : ['none']
    return {
      ...previous,
      scopeId,
      phase: 'done',
      terminalReason: previous.terminalReason || 'done',
      waitingFor: 'none',
      checkpointExpiresAt: null,
      resumableActions,
      steps: (previous.steps || []).map((step) => (
        step.status === 'running' || step.status === 'pending'
          ? { ...step, status: 'done', detail: step.detail || '已完成', updatedAt }
          : step
      )),
      updatedAt,
    }
  }

  async function fireInfrastructureTimeout(scopeId: string, requestId: string): Promise<void> {
    const key = watchdogKey(scopeId, requestId)
    const watchdog = infrastructureWatchdogs.get(key)
    if (!watchdog) return
    const reportRetries = watchdog.reportRetries ?? 0
    // P1 race fix — do NOT delete the watchdog before awaiting the main report.
    // If main's terminal event arrives during the (up to 5s) report wait, its
    // handler calls clearInfrastructureWatchdog → deletes THIS entry; we detect
    // that after the await and bail, so a slow-but-alive main's real terminal is
    // never overwritten by a local retry / infra_error. (Deleting upfront made
    // the terminal handler's clear a no-op against an already-empty slot.)
    const state = store.getState()
    const runState = getScopeRunStateFromState(state, scopeId)
    if (runState && runState.requestId !== requestId) {
      infrastructureWatchdogs.delete(key)
      return
    }

    const mainReport = await reportInfrastructureTimeoutToMain(scopeId, requestId, watchdog.timeoutMs)
    const mainState = mainReport.kind === 'authoritative' ? mainReport.state : null
    const activeRunId = mainReport.kind === 'authoritative' ? mainReport.activeRunId : null

    // A terminal event during the report wait cleared (or a refresh replaced)
    // our entry — main resolved authoritatively; do not re-arm or overwrite.
    if (infrastructureWatchdogs.get(key) !== watchdog) return
    const afterRun = getScopeRunStateFromState(store.getState(), scopeId)
    if (afterRun && afterRun.requestId !== requestId) {
      infrastructureWatchdogs.delete(key)
      return
    }
    // We still own the resolution — take the entry out of the map now.
    infrastructureWatchdogs.delete(key)

    if (mainState === 'stale' && activeRunId) {
      const replacementRequestId = activeRunId
      store.setState((current: {
        currentAgent?: string
        sessions?: Record<string, unknown>
      }) => {
        const sessionId = sessionKeyForScopeId(current, scopeId)
        const currentSlice = normalizeSessionSlice(current.sessions?.[sessionId])
        const previousRun = currentSlice.scopeRunStates[scopeId]
          || runState
          || createEmptyScopeRunState({
            scopeId,
            agent: state.currentAgent || current.currentAgent || 'butler',
            requestId: replacementRequestId,
            phase: 'planning',
          })
        return withSessionSliceAndActiveRuntimeMirror(current, sessionId, {
          isStreaming: true,
          foregroundBusy: true,
          composerLocked: true,
          streamingRequestId: replacementRequestId,
          scopeRunStates: {
            ...currentSlice.scopeRunStates,
            [scopeId]: {
              ...previousRun,
              requestId: replacementRequestId,
              phase: previousRun.phase === 'done'
                || previousRun.phase === 'error'
                || previousRun.phase === 'cancelled'
                ? 'planning'
                : previousRun.phase,
              terminalReason: null,
              error: undefined,
              updatedAt: new Date().toISOString(),
            },
          },
        })
      })
      armInfrastructureWatchdog(scopeId, replacementRequestId, {
        timeoutMs: ACTIVE_RUN_INFRASTRUCTURE_TIMEOUT_MS,
      })
      emitRendererAgentMetric('renderer_infrastructure_timeout_replacement_run', {
        scopeId,
        staleRequestId: requestId,
        activeRunId: replacementRequestId,
        elapsedMs: watchdog.timeoutMs,
      })
      return
    }

    if (mainReport.kind === 'invalid_response') {
      const timer = setTimeout(
        () => { void fireInfrastructureTimeout(scopeId, requestId) },
        ACTIVE_RUN_INFRASTRUCTURE_TIMEOUT_MS,
      )
      const unref = (timer as { unref?: unknown }).unref
      if (typeof unref === 'function') unref.call(timer)
      infrastructureWatchdogs.set(key, {
        ...watchdog,
        timer,
        timeoutMs: ACTIVE_RUN_INFRASTRUCTURE_TIMEOUT_MS,
        reportRetries: 0,
      })
      emitRendererAgentMetric('renderer_infrastructure_timeout_invalid_response', {
        scopeId,
        requestId,
        elapsedMs: watchdog.timeoutMs,
      })
      return
    }

    if (mainState === 'active' || mainState === 'paused_user_input') {
      const timer = setTimeout(() => { void fireInfrastructureTimeout(scopeId, requestId) }, ACTIVE_RUN_INFRASTRUCTURE_TIMEOUT_MS)
      const unref = (timer as { unref?: unknown }).unref
      if (typeof unref === 'function') unref.call(timer)
      infrastructureWatchdogs.set(key, {
        ...watchdog,
        timer,
        timeoutMs: ACTIVE_RUN_INFRASTRUCTURE_TIMEOUT_MS,
        reportRetries: 0,
      })
      emitRendererAgentMetric(
        mainState === 'active'
          ? 'renderer_infrastructure_timeout_active_run'
          : 'renderer_infrastructure_timeout_paused_user_input',
        {
          scopeId,
          requestId,
          elapsedMs: watchdog.timeoutMs,
        },
      )
      return
    }

    // B step 2 (Option A) — main UNREACHABLE (report returned null). The renderer
    // must NOT locally claim recovery. Re-arm a bounded retry and keep the run
    // locked: we don't know main's state, and a terminal event from main (which
    // clears this watchdog) is the authoritative resolution we wait for. Only
    // after retries are exhausted do we surface an HONEST unknown-state notice.
    if (mainState === null && reportRetries < INFRASTRUCTURE_TIMEOUT_REPORT_MAX_RETRIES) {
      const timer = setTimeout(() => { void fireInfrastructureTimeout(scopeId, requestId) }, INFRASTRUCTURE_TIMEOUT_REPORT_RETRY_DELAY_MS)
      const unref = (timer as { unref?: unknown }).unref
      if (typeof unref === 'function') unref.call(timer)
      infrastructureWatchdogs.set(key, { ...watchdog, timer, reportRetries: reportRetries + 1 })
      emitRendererAgentMetric('renderer_infrastructure_timeout_report_retry', {
        scopeId, requestId, attempt: reportRetries + 1, elapsedMs: watchdog.timeoutMs,
      })
      return
    }

    // Resolve. `null` here = retries exhausted, main genuinely unreachable.
    // `not_found` = main answered that the run is gone → quiet unlock, no
    // alarming message. A typed `stale + activeRunId` returned earlier after
    // transferring the lock to that replacement. NEVER claim the
    // run was "已自动恢复" — that false claim invited duplicate resends while a
    // live main run continued.
    const mainUnreachable = mainState === null
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
                terminalReason: mainUnreachable ? 'infra_error' : 'main_no_progress_timeout',
                error: mainUnreachable
                  ? 'Ready 暂时联系不上后台，已解锁输入；这次请求的实际状态未知，请先确认结果，不要重复发送同一任务。'
                  : '这次请求超时，Ready 已请求停止当前运行，可重新发送。',
                updatedAt: new Date().toISOString(),
              },
            },
          },
        ),
        ...(current.currentScopeId === scopeId ? { toolTraceStatus: 'error' as const } : {}),
      }
    })

    // Only the genuinely-unreachable case surfaces a message, and it states
    // honest uncertainty (not a false recovery). When main answered, the run is
    // being closed out on main authority — no renderer-side claim needed.
    if (mainUnreachable && state.currentScopeId === scopeId && typeof state.addMessage === 'function') {
      state.addMessage({
        id: `infra-timeout-${Date.now()}`,
        agent: state.currentAgent || 'butler',
        content: 'Ready 暂时联系不上后台，已解锁输入；这次请求的实际状态未知，请先确认结果，不要重复发送同一任务。',
        type: 'system',
        timestamp: new Date(),
      })
    }
    lastInfrastructureToastAt = Date.now()
    emitRendererAgentMetric('renderer_infrastructure_timeout_fired', {
      scopeId,
      requestId,
      elapsedMs: watchdog.timeoutMs,
      mainState,
      reportRetries,
    })
  }

  function armInfrastructureWatchdog(scopeId: string, requestId: string, options?: { timeoutMs?: number }): void {
    if (!scopeId || !requestId) return
    // Re-arming the same scope+requestId resets the timer.
    clearInfrastructureWatchdog(scopeId, requestId)
    const timeoutMs = options?.timeoutMs ?? INFRASTRUCTURE_TIMEOUT_MS
    const timer = setTimeout(() => { void fireInfrastructureTimeout(scopeId, requestId) }, timeoutMs)
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


  return {
    armInfrastructureWatchdog,
    clearInfrastructureWatchdog,
    refreshInfrastructureWatchdog,
    getScopeRunStateFromState,
    findScopeIdByRunId,
    finalizeDoneRunState,
    getInfrastructureTimeoutMs: () => INFRASTRUCTURE_TIMEOUT_MS,
    getLastInfrastructureToastAt: () => lastInfrastructureToastAt,
  }
}
