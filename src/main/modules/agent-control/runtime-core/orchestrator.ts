import { EventEmitter } from 'events'
import { randomUUID } from 'node:crypto'
import { MAX_AGENT_SESSIONS } from '../../../../shared/agent-session-limits'
import { DomainAdapterHost } from '../domain-adapters/domain-adapter-host'
import type { MultimodalBlock } from '../contracts/run-contracts'
import type { BrowserController } from '../../browser-engine/ipc-handler'
import type { SidecarManager } from '../sidecar-manager'
import type { AgentControlRuntime } from './runtime'
import type { ExecutionHostRequest, ExecutionHostResult } from '../contracts/run-contracts'
import type { IntentClassification } from '../intent-classifier'
import type { RequestEnvelope } from '../contracts/request-envelope'
import type { ContinuationIntent, ContinuationState } from '../contracts/continuation-state'
import type { AbortInitiator } from '../contracts/run-contracts-internal'
import { AgentSessionManager, parseSessionKey } from '../session/session-manager'
import { createScopedRunCollector, type SendAndCollectResult } from '../task-projection/run-collector'
import { RunCleanupRegistry, type RunCleanupCallback } from '../task-projection/run-cleanup-registry'
import type { DomainAdapter } from '../domain-adapters/domain-adapter'
import type { AgentTaskState } from '../contracts/types'
import {
  AgentSdkRuntime,
  type AgentSdkRuntimeDeps,
} from './agent-sdk-runtime'
import { getEphemeralExecutionStore } from '../../tools/skill-primitives/ephemeral-execution-store'
import { getAskUserQuestionsStore } from '../../tools/builtins/ask-user-questions-store'

interface SessionDescriptor {
  agent: string
  sessionId?: string
}

/**
 * Stage V V3.1 — public shape returned by `listAllSessions()`. Consumers
 * (IPC handler `agent:listActiveSessions`, renderer session tab UI, etc.)
 * address sessions by `(agent, sessionId)` rather than the raw composite
 * key. `sessionId === null` indicates a legacy single-session entry
 * (composite key without `::` suffix).
 */
export interface SessionSummary {
  agent: string
  sessionId: string | null
  state: AgentTaskState
  lastTurnAt: string
  error?: string
}

interface ReadyAgentOrchestratorOptions {
  browserController?: BrowserController
  sidecarManager?: SidecarManager
  agentSdkRuntimeDeps?: AgentSdkRuntimeDeps
  mainRunNoProgressTimeoutMs?: number
  nowMs?: () => number
  scheduleNoProgressCheck?: (callback: () => void, delayMs: number) => unknown
  clearNoProgressCheck?: (handle: unknown) => void
}

export interface ChildLivenessProvider {
  hasActiveChildRunForScope(scopeId: string): boolean
}

const DEFAULT_MAIN_RUN_NO_PROGRESS_TIMEOUT_MS = 15 * 60 * 1000

interface ActiveRunLiveness {
  agent: string
  sessionId?: string
  requestId: string
  lastProgressAt: number
  timer: unknown | null
  /**
   * Per-run no-progress timeout (B step 3). Defaults to the global
   * mainRunNoProgressTimeoutMs (long) — only an EXPLICIT, proven-quick caller
   * passes a shorter value. We never infer a short timeout from a coarse
   * task_type, so a long collection is never false-killed.
   */
  noProgressTimeoutMs: number
  defaultNoProgressTimeout: boolean
}

type SendAndCollectExecutionResult = SendAndCollectResult & {
  scopeRunAuthority?: ExecutionHostResult['scopeRunAuthority']
  contextUsage?: ExecutionHostResult['contextUsage']
}

type PersonaSystemPromptResolver = (agent: string, scopeId: string | undefined) => Promise<string | undefined>

export interface StopActiveGenerationResult {
  runId: string | null
}

export interface RequestScopedStopActiveGenerationResult extends StopActiveGenerationResult {
  state: 'cancel_requested' | 'stale' | 'not_found'
  activeRunId?: string | null
}

export type RequestScopedActiveRunInspection =
  | { state: 'active'; runId: string }
  | { state: 'stale'; runId: null; activeRunId: string }
  | { state: 'not_found'; runId: null }

interface CompactSessionReport {
  beforeTokens: number
  afterTokens: number
  droppedItems: number
  truncatedToolResults: number
  summarized: boolean
}

export type CompactSessionResult =
  | { status: 'compacted' | 'noop'; report: CompactSessionReport }
  | { status: 'queued' }
  | { status: 'not_found' | 'superseded'; message: string }

type CompactableAgentSdkRuntime = AgentSdkRuntime & {
  compactSession?: (
    name: string,
    reason?: string,
  ) => CompactSessionResult | Promise<CompactSessionResult>
}

export class ReadyAgentOrchestrator extends EventEmitter {
  /**
   * Stage V V3.5 — hard cap on concurrent live sessions enforced at the
   * main-process entry (plan §4 V3.5 / §10 R12). Defense in depth: the
   * renderer's V3.4a disable is advisory; if a developer bypasses the UI
   * via devtools (R12 risk), this cap still rejects the request. A
   * "live" session is one whose state is NOT in the terminal set
   * `{ done, failed, cancelled, closed }` — see `countLiveSessions()`.
   *
   * Reuse of an already-tracked sessionId never counts (it is not a new
   * session, just a continuation of the existing turn loop), so this
   * cap only fires when a NOVEL sessionId would push the live count
   * past the limit.
   *
   * The value is the shared `MAX_AGENT_SESSIONS` — the SAME constant the
   * renderer uses to enable/disable the "+" button — so the UI affordance and
   * this guard can never diverge (a renderer-5 / main-3 split let sessions look
   * creatable but get rejected here on send). See
   * `src/shared/agent-session-limits.ts` + `agent-session-limit-parity.test.ts`.
   */
  private static readonly MAX_CONCURRENT_SESSIONS = MAX_AGENT_SESSIONS
  private readonly domainAdapterHost: DomainAdapterHost
  private readonly sdkEngine: AgentSdkRuntime
  private readonly sessions: AgentSessionManager
  private readonly descriptors = new Map<string, SessionDescriptor>()
  private readonly runCleanupRegistry = new RunCleanupRegistry()
  private readonly activeRunIds = new Map<string, string>()
  private readonly activeRunLiveness = new Map<string, ActiveRunLiveness>()
  private readonly mainRunNoProgressTimeoutMs: number
  private readonly nowMs: () => number
  private readonly scheduleNoProgressCheck: (callback: () => void, delayMs: number) => unknown
  private readonly clearNoProgressCheck: (handle: unknown) => void
  private personaResolver: PersonaSystemPromptResolver | null = null
  private childLivenessProvider: ChildLivenessProvider | null = null

  constructor(options?: ReadyAgentOrchestratorOptions) {
    super()
    this.mainRunNoProgressTimeoutMs = typeof options?.mainRunNoProgressTimeoutMs === 'number' && Number.isFinite(options.mainRunNoProgressTimeoutMs) && options.mainRunNoProgressTimeoutMs > 0
      ? options.mainRunNoProgressTimeoutMs
      : DEFAULT_MAIN_RUN_NO_PROGRESS_TIMEOUT_MS
    this.nowMs = options?.nowMs || (() => Date.now())
    this.scheduleNoProgressCheck = options?.scheduleNoProgressCheck || ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearNoProgressCheck = options?.clearNoProgressCheck || ((handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    })
    this.domainAdapterHost = new DomainAdapterHost()
    this.sdkEngine = new AgentSdkRuntime({
      domainAdapters: this.domainAdapterHost.getDomainAdapters(),
      skillContextOrchestrator: this.domainAdapterHost.getSkillContextOrchestrator(),
      ...options?.agentSdkRuntimeDeps,
    })
    this.sessions = new AgentSessionManager()
    this.sdkEngine.setRunCleanupRegistry({
      registerRunCleanup: (runId, cleanup) => {
        this.registerRunCleanup(runId, cleanup)
      },
    })

    // Stage U PR U1.3 + P6f + Phase C C3 — the legacy engine is fully out of
    // this loop: DomainAdapterHost now carries the adapter assembly /
    // SkillContextOrchestrator / dependency wiring, and the SDK runtime is
    // the single renderer-facing emission producer and live turn executor.
    this.bindEngineEvents(this.sdkEngine)

    if (options?.browserController) {
      this.setBrowserController(options.browserController)
    }

    if (options?.sidecarManager) {
      this.setSidecarManager(options.sidecarManager)
    }
  }

  private bindEngineEvents(engine: AgentSdkRuntime): void {
    engine.on('output', (payload) => {
      const descriptor = this.resolveDescriptor(payload.agent)
      const taskKey = this.toTaskKey(descriptor.agent, descriptor.sessionId)
      this.refreshActiveRunProgressForEvent(payload.agent, descriptor, this.readPayloadRunId(payload))
      if (payload.type === 'done') {
        this.sessions.setState(taskKey, 'done')
      } else if (payload.type === 'error') {
        this.sessions.setState(taskKey, 'failed', typeof payload.chunk === 'string' ? payload.chunk : undefined)
      } else if (payload.type === 'tool_use') {
        this.sessions.setState(taskKey, 'tool_running')
      } else {
        this.sessions.setState(taskKey, 'responding')
      }
      this.emit('output', {
        ...payload,
        agent: descriptor.agent,
        sessionId: descriptor.sessionId,
      })
    })

    engine.on('status', (payload) => {
      const descriptor = this.resolveDescriptor(payload.agent)
      const taskKey = this.toTaskKey(descriptor.agent, descriptor.sessionId)
      this.refreshActiveRunProgressForEvent(payload.agent, descriptor, this.readPayloadRunId(payload))
      if (payload.status === 'working') {
        this.sessions.setState(taskKey, 'planning')
      } else if (payload.status === 'done') {
        this.sessions.setState(taskKey, 'done')
      } else if (payload.status === 'cancelled') {
        this.sessions.setState(taskKey, 'cancelled')
      } else if (payload.status === 'error') {
        this.sessions.setState(taskKey, 'failed')
      }
      this.emit('status', {
        ...payload,
        agent: descriptor.agent,
        sessionId: descriptor.sessionId,
      })
    })

    engine.on('error', (payload) => {
      const descriptor = this.resolveDescriptor(payload.agent)
      const taskKey = this.toTaskKey(descriptor.agent, descriptor.sessionId)
      this.refreshActiveRunProgressForEvent(payload.agent, descriptor, this.readPayloadRunId(payload))
      this.sessions.setState(taskKey, 'failed', payload.error)
      this.emit('error', {
        ...payload,
        agent: descriptor.agent,
        sessionId: descriptor.sessionId,
      })
    })

    engine.on('toolAction', (payload) => {
      const descriptor = this.resolveDescriptor(payload.agent)
      this.refreshActiveRunProgressForEvent(payload.agent, descriptor, this.readPayloadRunId(payload))
      this.emit('toolAction', {
        ...payload,
        agent: descriptor.agent,
        sessionId: descriptor.sessionId,
      })
    })
  }

  private readPayloadRunId(payload: { runId?: unknown }): string | undefined {
    return typeof payload.runId === 'string' && payload.runId.length > 0
      ? payload.runId
      : undefined
  }

  private refreshActiveRunProgressForEvent(
    rawAgentKey: string,
    descriptor: SessionDescriptor,
    requestId?: string,
  ): void {
    const parsed = parseSessionKey(rawAgentKey)
    const parsedSessionId = parsed.sessionId ?? undefined
    if (this.refreshActiveRunProgress(parsed.agent, parsedSessionId, requestId)) return
    this.refreshActiveRunProgress(descriptor.agent, descriptor.sessionId, requestId)
  }

  private registerActiveRun(
    agent: string,
    sessionId: string | undefined,
    requestId: string,
    noProgressTimeoutMs?: number,
  ): void {
    const taskKey = this.toTaskKey(agent, sessionId)
    this.clearActiveRunIfMatches(taskKey)
    this.activeRunIds.set(taskKey, requestId)
    // Default long; an explicit value may only SHORTEN (proven-quick callers).
    // A finite positive value is clamped to ≤ the global default so a per-run
    // value can never EXTEND the guard; anything else falls back to the global.
    const resolvedTimeoutMs = typeof noProgressTimeoutMs === 'number'
      && Number.isFinite(noProgressTimeoutMs) && noProgressTimeoutMs > 0
      ? Math.min(noProgressTimeoutMs, this.mainRunNoProgressTimeoutMs)
      : this.mainRunNoProgressTimeoutMs
    this.activeRunLiveness.set(taskKey, {
      agent,
      sessionId,
      requestId,
      lastProgressAt: this.nowMs(),
      timer: null,
      noProgressTimeoutMs: resolvedTimeoutMs,
      defaultNoProgressTimeout: resolvedTimeoutMs === this.mainRunNoProgressTimeoutMs,
    })
    this.scheduleRunNoProgressGuard(taskKey, requestId)
  }

  private clearActiveRunIfMatches(taskKey: string, requestId?: string): string | null {
    const activeRunId = this.activeRunIds.get(taskKey) || null
    const liveness = this.activeRunLiveness.get(taskKey) || null
    if (requestId && activeRunId && activeRunId !== requestId) return null
    if (requestId && !activeRunId && liveness?.requestId !== requestId) return null
    if (activeRunId) {
      this.activeRunIds.delete(taskKey)
    }
    this.clearRunNoProgressGuard(taskKey, requestId)
    return activeRunId || liveness?.requestId || null
  }

  private clearRunNoProgressGuard(taskKey: string, requestId?: string): void {
    const liveness = this.activeRunLiveness.get(taskKey)
    if (!liveness) return
    if (requestId && liveness.requestId !== requestId) return
    if (liveness.timer) {
      this.clearNoProgressCheck(liveness.timer)
    }
    this.activeRunLiveness.delete(taskKey)
  }

  refreshActiveRunProgress(agent: string, sessionId: string | undefined, requestId?: string): boolean {
    const taskKey = this.toTaskKey(agent, sessionId)
    const activeRunId = this.activeRunIds.get(taskKey)
    if (!activeRunId) return false
    if (requestId && activeRunId !== requestId) return false
    const liveness = this.activeRunLiveness.get(taskKey)
    if (!liveness || liveness.requestId !== activeRunId) return false
    liveness.lastProgressAt = this.nowMs()
    this.scheduleRunNoProgressGuard(taskKey, activeRunId)
    return true
  }

  isActiveRun(agent: string, sessionId: string | undefined, requestId: string): boolean {
    if (!agent || !requestId) return false
    return this.activeRunIds.get(this.toTaskKey(agent, sessionId)) === requestId
  }

  getActiveRunId(agent: string, sessionId: string | undefined): string | null {
    if (!agent) return null
    return this.activeRunIds.get(this.toTaskKey(agent, sessionId)) || null
  }

  inspectActiveRunIfMatches(
    agent: string,
    sessionId: string | undefined,
    requestId: string,
  ): RequestScopedActiveRunInspection {
    const activeRunId = this.activeRunIds.get(this.toTaskKey(agent, sessionId)) || null
    if (!activeRunId) return { state: 'not_found', runId: null }
    if (activeRunId !== requestId) return { state: 'stale', runId: null, activeRunId }
    return { state: 'active', runId: activeRunId }
  }

  isActiveRunAwaitingUserInput(agent: string, sessionId: string | undefined, requestId: string): boolean {
    if (!this.isActiveRun(agent, sessionId, requestId)) return false
    return getEphemeralExecutionStore().hasPendingForRun(agent, sessionId ?? null, requestId)
      || getAskUserQuestionsStore().hasPendingForRun(agent, sessionId ?? null, requestId)
  }

  private scheduleRunNoProgressGuard(taskKey: string, requestId: string): void {
    const liveness = this.activeRunLiveness.get(taskKey)
    if (!liveness || liveness.requestId !== requestId) return
    if (liveness.timer) {
      this.clearNoProgressCheck(liveness.timer)
      liveness.timer = null
    }
    const elapsedMs = Math.max(0, this.nowMs() - liveness.lastProgressAt)
    const delayMs = Math.max(0, liveness.noProgressTimeoutMs - elapsedMs)
    const timer = this.scheduleNoProgressCheck(() => {
      this.handleRunNoProgressTimeout(taskKey, requestId)
    }, delayMs)
    const unref = timer && (timer as { unref?: unknown }).unref
    if (typeof unref === 'function') {
      unref.call(timer)
    }
    liveness.timer = timer
  }

  private handleRunNoProgressTimeout(taskKey: string, requestId: string): void {
    const liveness = this.activeRunLiveness.get(taskKey)
    if (!liveness || liveness.requestId !== requestId) return
    if (this.activeRunIds.get(taskKey) !== requestId) return
    const elapsedMs = Math.max(0, this.nowMs() - liveness.lastProgressAt)
    if (elapsedMs < liveness.noProgressTimeoutMs) {
      this.scheduleRunNoProgressGuard(taskKey, requestId)
      return
    }
    if (
      liveness.defaultNoProgressTimeout
      && this.isActiveRunAwaitingUserInput(liveness.agent, liveness.sessionId, requestId)
    ) {
      liveness.lastProgressAt = this.nowMs()
      this.scheduleRunNoProgressGuard(taskKey, requestId)
      return
    }
    const stopped = this.interruptActiveRunIfMatches(
      liveness.agent,
      liveness.sessionId,
      requestId,
      'timeout',
    )
    if (stopped.state === 'cancel_requested') {
      this.sessions.setState(taskKey, 'cancelled', 'main_no_progress_timeout')
    }
  }

  getRuntimeKernel(): 'ready-agent-sdk' {
    return 'ready-agent-sdk'
  }

  private toInternalSessionKey(agent: string, sessionId?: string): string {
    return sessionId ? `${agent}::${sessionId}` : agent
  }

  private toTaskKey(agent: string, sessionId?: string): string {
    return sessionId ? `${agent}::${sessionId}` : agent
  }

  /**
   * Stage V V3.5 — count sessions that are NOT in a terminal state.
   * Terminal set: `done`, `failed`, `cancelled`, `closed` (matches the
   * V3.3d `isLiveSession` predicate semantics from the renderer side so
   * the two layers agree on what "live" means).
   *
   * Backed by `AgentSessionManager.listStatesEnriched()` (added in V3.1)
   * so a single source of truth governs both `listAllSessions()` and the
   * limit check; if the terminal set ever grows, both layers move in
   * lockstep through the manager.
   */
  private countLiveSessions(): number {
    let count = 0
    for (const snap of this.sessions.listStatesEnriched()) {
      if (
        snap.state !== 'done' &&
        snap.state !== 'failed' &&
        snap.state !== 'cancelled' &&
        snap.state !== 'closed'
      ) {
        count += 1
      }
    }
    return count
  }

  /**
   * Stage V V3.5 — build the structured `session_limit_exceeded` error
   * thrown by `send()` / `newSession()` when admitting a NOVEL sessionId
   * would push the live count past `MAX_CONCURRENT_SESSIONS`. Carries
   * `code` + `maxSessions` + `liveCount` so the IPC layer can echo them
   * back to the renderer without re-parsing the message string.
   */
  private buildSessionLimitError(liveCount: number): Error & {
    code: 'SESSION_LIMIT'
    maxSessions: number
    liveCount: number
  } {
    const err = new Error('session_limit_exceeded') as Error & {
      code: 'SESSION_LIMIT'
      maxSessions: number
      liveCount: number
    }
    err.code = 'SESSION_LIMIT'
    err.maxSessions = ReadyAgentOrchestrator.MAX_CONCURRENT_SESSIONS
    err.liveCount = liveCount
    return err
  }

  /**
   * Stage V V3.5 — true if the (agent, sessionId) tuple is already
   * tracked in the session manager (any state, including terminal).
   * Used by the limit check to distinguish "novel session being
   * admitted" from "continuation of an existing session" — only the
   * former is subject to the cap.
   */
  private isKnownSession(agent: string, sessionId?: string): boolean {
    return this.sessions.has(this.toTaskKey(agent, sessionId))
  }

  private resolveDescriptor(internalKey: string): SessionDescriptor {
    const descriptor = this.descriptors.get(internalKey)
    if (descriptor) return descriptor
    const marker = internalKey.indexOf('::')
    if (marker === -1) {
      return { agent: internalKey }
    }
    return {
      agent: internalKey.slice(0, marker),
      sessionId: internalKey.slice(marker + 2),
    }
  }

  setBrowserController(controller: BrowserController): void {
    this.domainAdapterHost.setBrowserController(controller)
    this.sdkEngine.setBrowserController(controller)
  }

  hasBrowserController(): boolean {
    return this.domainAdapterHost.hasBrowserController()
  }

  /** P1 (2026-07-03) — active browser tab URL for site-card domain matching. */
  getActiveBrowserUrl(): string | null {
    return this.domainAdapterHost.getActiveBrowserUrl()
  }

  getDomainAdapters(): ReadonlyArray<DomainAdapter> {
    return this.domainAdapterHost.getDomainAdapters()
  }

  setSidecarManager(manager: SidecarManager): void {
    this.sdkEngine.setSidecarManager(manager)
  }

  setRuntime(runtime: AgentControlRuntime): void {
    this.domainAdapterHost.setRuntime(runtime)
    this.sdkEngine.setRuntime(runtime)
  }

  setRendererToolActionRequester(
    requester: ((payload: {
      agent?: string
      sessionId?: string
      runId?: string
      tool: string
      args: Record<string, unknown>
    }) => Promise<Record<string, unknown>>) | null,
  ): void {
    this.sdkEngine.setRendererToolActionRequester(requester)
  }

  setCancelPendingToolActions(
    canceller: ((agent: string, sessionId?: string) => void) | null,
  ): void {
    this.sdkEngine.setCancelPendingToolActions(canceller)
  }

  setPersonaResolver(resolver: PersonaSystemPromptResolver | null): void {
    this.personaResolver = resolver
  }

  async send(
    agent: string,
    message: string | MultimodalBlock[],
    sessionId?: string,
    requestId?: string,
    taskId?: string,
    systemPrompt?: string,
    requestEnvelope?: RequestEnvelope,
    intentClassification?: IntentClassification,
    budget?: ExecutionHostRequest['budget'],
    budgetState?: ExecutionHostRequest['budgetState'],
    taskBudgetRuntime?: ExecutionHostRequest['taskBudgetRuntime'],
    continuationIntent?: ContinuationIntent | null,
    continuationState?: ContinuationState | null,
    sessionIdOverride?: string,
    sourceMessageId?: string | null,
    executionBinding?: ExecutionHostRequest['executionBinding'],
    executionProfile?: ExecutionHostRequest['executionProfile'],
    noProgressTimeoutMs?: number,
    deliveryMode?: ExecutionHostRequest['deliveryMode'],
    messageVisibilityEpoch?: number,
  ): Promise<{
    success: boolean
    error?: string
    finalText?: string
    cancelled?: boolean
    taskId?: ExecutionHostResult['taskId']
    usedTools?: ExecutionHostResult['usedTools']
    taskType?: ExecutionHostResult['taskType']
    interactionState?: ExecutionHostResult['interactionState']
    taskProjectionId?: ExecutionHostResult['taskProjectionId']
    executionDiagnostics?: ExecutionHostResult['executionDiagnostics']
    contextUsage?: ExecutionHostResult['contextUsage']
    projectionTruth?: ExecutionHostResult['projectionTruth']
    terminalReason?: ExecutionHostResult['terminalReason']
    scopeRunAuthority?: ExecutionHostResult['scopeRunAuthority']
    canonicalMessage?: ExecutionHostResult['canonicalMessage']
    canonicalMessageDigest?: ExecutionHostResult['canonicalMessageDigest']
  }> {
    const effectiveRequestId = requestId || randomUUID()
    const effectiveSessionId = sessionIdOverride || sessionId
    const internalKey = this.toInternalSessionKey(agent, effectiveSessionId)
    const taskKey = this.toTaskKey(agent, effectiveSessionId)
    // Stage V V3.5 — main-side hard cap (plan §4 V3.5 / §10 R12). A
    // NOVEL (agent, sessionId) tuple cannot be admitted if the live
    // count is already at MAX_CONCURRENT_SESSIONS. Continuation of an
    // existing session (any tracked state, terminal included) bypasses
    // the check because it does not grow the live working set.
    if (!this.isKnownSession(agent, effectiveSessionId)) {
      const live = this.countLiveSessions()
      if (live >= ReadyAgentOrchestrator.MAX_CONCURRENT_SESSIONS) {
        throw this.buildSessionLimitError(live)
      }
    }
    this.descriptors.set(internalKey, { agent, sessionId })
    this.sessions.setState(taskKey, 'queued')
    this.registerActiveRun(agent, effectiveSessionId, effectiveRequestId, noProgressTimeoutMs)
    try {
      let resolvedSystemPrompt = systemPrompt
      if (systemPrompt === undefined && this.personaResolver) {
        try {
          resolvedSystemPrompt = await this.personaResolver(agent, sessionId)
        } catch (error) {
          this.sessions.setState(
            taskKey,
            'failed',
            error instanceof Error ? error.message : String(error),
          )
          throw error
        }
      }
      if (resolvedSystemPrompt) {
        this.sdkEngine.setSystemPrompt(internalKey, resolvedSystemPrompt)
      }
      const result = await this.sdkEngine.sendMessage(internalKey, message, effectiveRequestId, {
        taskId,
        publicSessionId: sessionId,
        messageVisibilityEpoch,
        requestEnvelope,
        intentClassification,
        budget,
        budgetState,
        taskBudgetRuntime,
        continuationIntent,
        continuationState,
        sourceMessageId: sourceMessageId ?? null,
        executionBinding,
        executionProfile,
        deliveryMode,
      })
      if (!result.success) {
        this.sessions.setState(taskKey, 'failed', result.error)
      }
      return result
    } finally {
      this.clearActiveRunIfMatches(taskKey, effectiveRequestId)
      await this.drainRunCleanup(effectiveRequestId)
    }
  }

  async sendAndCollect(
    agent: string,
    message: string | MultimodalBlock[],
    sessionId?: string,
    requestId?: string,
    taskId?: string,
    systemPrompt?: string,
    requestEnvelope?: RequestEnvelope,
    intentClassification?: IntentClassification,
    budget?: ExecutionHostRequest['budget'],
    budgetState?: ExecutionHostRequest['budgetState'],
    taskBudgetRuntime?: ExecutionHostRequest['taskBudgetRuntime'],
    continuationIntent?: ContinuationIntent | null,
    continuationState?: ContinuationState | null,
    sessionIdOverride?: string,
    sourceMessageId?: string | null,
    executionBinding?: ExecutionHostRequest['executionBinding'],
    executionProfile?: ExecutionHostRequest['executionProfile'],
    deliveryMode?: ExecutionHostRequest['deliveryMode'],
    messageVisibilityEpoch?: number,
  ): Promise<SendAndCollectExecutionResult> {
    const collector = createScopedRunCollector({ agent, sessionId, requestId })
    const cleanupFns: Array<() => void> = []

    this.on('output', collector.handleOutput)
    this.on('status', collector.handleStatus)
    this.on('error', collector.handleError)
    cleanupFns.push(() => this.off('output', collector.handleOutput))
    cleanupFns.push(() => this.off('status', collector.handleStatus))
    cleanupFns.push(() => this.off('error', collector.handleError))

    let executionDiagnostics: ExecutionHostResult['executionDiagnostics'] | null = null
    let resolvedTaskId: ExecutionHostResult['taskId']
    let taskType: ExecutionHostResult['taskType']
    let interactionState: ExecutionHostResult['interactionState']
    let taskProjectionId: ExecutionHostResult['taskProjectionId']
    let projectionTruth: ExecutionHostResult['projectionTruth']
    let terminalReason: ExecutionHostResult['terminalReason']
    let scopeRunAuthority: ExecutionHostResult['scopeRunAuthority']
    let contextUsage: ExecutionHostResult['contextUsage']
    let canonicalMessage: ExecutionHostResult['canonicalMessage']
    let canonicalMessageDigest: ExecutionHostResult['canonicalMessageDigest']
    let usedToolsFromExecution: string[] | null = null
    const sendResultPromise = this.send(
      agent,
      message,
      sessionId,
      requestId,
      taskId,
      systemPrompt,
      requestEnvelope,
      intentClassification,
      budget,
      budgetState,
      taskBudgetRuntime,
      continuationIntent,
      continuationState,
      sessionIdOverride,
      sourceMessageId,
      executionBinding,
      executionProfile,
      undefined,
      deliveryMode,
      messageVisibilityEpoch,
    ).then((result) => {
      executionDiagnostics = result.executionDiagnostics || null
      resolvedTaskId = result.taskId
      taskType = result.taskType
      interactionState = result.interactionState
      taskProjectionId = result.taskProjectionId
      projectionTruth = result.projectionTruth
      terminalReason = result.terminalReason
      scopeRunAuthority = result.scopeRunAuthority
      contextUsage = result.contextUsage
      canonicalMessage = result.canonicalMessage
      canonicalMessageDigest = result.canonicalMessageDigest
      usedToolsFromExecution = result.usedTools || null
      if (!result.success) {
        collector.handleError({
          agent,
          sessionId,
          runId: requestId,
          error: result.error || 'Agent execution failed',
        })
        collector.handleStatus({
          agent,
          sessionId,
          runId: requestId,
          status: 'error',
        })
      }
      return result
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      collector.handleError({
        agent,
        sessionId,
        runId: requestId,
        error: message || 'Agent execution failed',
      })
      collector.handleStatus({
        agent,
        sessionId,
        runId: requestId,
        status: 'error',
      })
      return null
    })

    try {
      const firstResult = await Promise.race([
        collector.result.then((result) => ({ source: 'collector' as const, result })),
        sendResultPromise.then((result) => ({ source: 'send' as const, result })),
      ])
      if (firstResult.source === 'send') {
        const executionResult = firstResult.result
        if (executionResult) {
          return {
            success: executionResult.success,
            finalText: executionResult.finalText || '',
            cancelled: Boolean(executionResult.cancelled),
            usedTools: usedToolsFromExecution || executionResult.usedTools || [],
            error: executionResult.error,
            taskId: resolvedTaskId || executionResult.taskId || undefined,
            taskType: taskType || executionResult.taskType,
            interactionState: interactionState || executionResult.interactionState,
            taskProjectionId: taskProjectionId || executionResult.taskProjectionId,
            executionDiagnostics: executionDiagnostics || executionResult.executionDiagnostics || null,
            projectionTruth: projectionTruth || executionResult.projectionTruth,
            terminalReason: terminalReason || executionResult.terminalReason || (executionResult.cancelled ? 'cancelled_runtime' : null),
            scopeRunAuthority: scopeRunAuthority || executionResult.scopeRunAuthority,
            contextUsage: contextUsage || executionResult.contextUsage || null,
            canonicalMessage: canonicalMessage || executionResult.canonicalMessage,
            canonicalMessageDigest: canonicalMessageDigest || executionResult.canonicalMessageDigest,
          }
        }
        return {
          success: false,
          finalText: '',
          cancelled: false,
          usedTools: [],
          error: 'Agent execution failed',
        }
      }
      const result = firstResult.result
      await sendResultPromise
      return {
        ...result,
        usedTools: usedToolsFromExecution || result.usedTools,
        taskId: resolvedTaskId || undefined,
        taskType,
        interactionState,
        taskProjectionId,
        executionDiagnostics,
        projectionTruth,
        terminalReason,
        scopeRunAuthority,
        contextUsage,
        canonicalMessage,
        canonicalMessageDigest,
      }
    } finally {
      while (cleanupFns.length > 0) {
        cleanupFns.pop()?.()
      }
    }
  }

  async executeAndCollect(request: ExecutionHostRequest): Promise<ExecutionHostResult> {
    const result = await this.sendAndCollect(
      request.agent,
      request.message as string | MultimodalBlock[],
      request.sessionId,
      request.requestId,
      request.taskId,
      request.systemPrompt,
      request.requestEnvelope,
      request.intentClassification,
      request.budget,
      request.budgetState,
      request.taskBudgetRuntime,
      request.continuationIntent,
      request.continuationState,
      request.sessionIdOverride,
      request.sourceMessageId ?? null,
      request.executionBinding,
      request.executionProfile,
      request.deliveryMode,
      request.messageVisibilityEpoch,
    )
    return {
      success: result.success,
      finalText: result.finalText,
      cancelled: result.cancelled,
      usedTools: result.usedTools,
      error: result.error,
      taskId: result.taskId,
      budgetState: request.budgetState,
      taskBudgetRuntime: result.executionDiagnostics?.taskBudgetRuntime || request.taskBudgetRuntime,
      taskType: result.taskType,
      interactionState: result.interactionState,
      taskProjectionId: result.taskProjectionId,
      executionDiagnostics: result.executionDiagnostics || null,
      projectionTruth: result.projectionTruth || null,
      terminalReason: result.terminalReason || null,
      scopeRunAuthority: result.scopeRunAuthority,
      contextUsage: result.contextUsage || null,
      canonicalMessage: result.canonicalMessage,
      canonicalMessageDigest: result.canonicalMessageDigest,
      executionBinding: request.executionBinding,
      executionAgentDisplayName: request.executionProfile.name,
    }
  }

  newSession(agent: string, sessionId?: string): void {
    // Stage V V3.5 — same cap as `send()` (plan §4 V3.5 / §10 R12).
    // Reusing an already-tracked (agent, sessionId) tuple is a session
    // *reset*, not a new admission, so it bypasses the check. A novel
    // tuple is rejected when the current live count is already at the
    // cap so the renderer's V3.4a UI disable cannot be silently
    // bypassed via devtools.
    if (!this.isKnownSession(agent, sessionId)) {
      const live = this.countLiveSessions()
      if (live >= ReadyAgentOrchestrator.MAX_CONCURRENT_SESSIONS) {
        throw this.buildSessionLimitError(live)
      }
    }
    const internalKey = this.toInternalSessionKey(agent, sessionId)
    this.descriptors.set(internalKey, { agent, sessionId })
    this.domainAdapterHost.resetSession(internalKey)
    this.sdkEngine.newSession(internalKey)
    this.sessions.setState(this.toTaskKey(agent, sessionId), 'done')
  }

  resetScopeContext(scopeId: string, messageVisibilityEpoch: number): void {
    const normalizedScopeId = String(scopeId || '').trim()
    if (!normalizedScopeId || !Number.isSafeInteger(messageVisibilityEpoch) || messageVisibilityEpoch < 0) {
      throw new Error('scope_context_reset_identity_invalid')
    }
    this.sdkEngine.clearScopeContext(normalizedScopeId)
    const resetAgents = new Set<string>()
    for (const [internalKey, descriptor] of this.descriptors) {
      if (descriptor.sessionId !== normalizedScopeId) continue
      resetAgents.add(descriptor.agent)
      this.stopActiveGeneration(descriptor.agent, normalizedScopeId, 'preempted')
      this.sdkEngine.resetSessionContext(
        internalKey,
        normalizedScopeId,
        messageVisibilityEpoch,
      )
      this.sessions.setState(this.toTaskKey(descriptor.agent, normalizedScopeId), 'done')
    }
    this.domainAdapterHost.resetScopeContext(normalizedScopeId, [...resetAgents])
  }

  registerRunCleanup(runId: string, cleanup: RunCleanupCallback): void {
    this.runCleanupRegistry.register(runId, cleanup)
  }

  async drainRunCleanup(runId: string, timeoutMs = 1_500): Promise<void> {
    try {
      await this.runCleanupRegistry.drain(runId, timeoutMs)
    } catch (error) {
      console.warn('[ReadyAgentOrchestrator] Run cleanup failed:', error)
    }
  }

  private stopActiveGeneration(
    agent: string,
    sessionId: string | undefined,
    initiator: AbortInitiator,
  ): StopActiveGenerationResult {
    const taskKey = this.toTaskKey(agent, sessionId)
    const runId = this.activeRunIds.get(taskKey) || null
    const internalKey = this.toInternalSessionKey(agent, sessionId)
    this.sdkEngine.stopGeneration(internalKey, initiator)
    if (runId) {
      this.clearActiveRunIfMatches(taskKey, runId)
      void this.drainRunCleanup(runId)
    }
    return { runId }
  }

  kill(agent: string, sessionId?: string): void {
    const taskKey = this.toTaskKey(agent, sessionId)
    this.stopActiveGeneration(agent, sessionId, 'user_stop')
    this.sessions.setState(taskKey, 'cancelled')
  }

  hasActiveRun(agent: string, sessionId?: string): boolean {
    return this.activeRunIds.has(this.toTaskKey(agent, sessionId))
  }

  setChildLivenessProvider(provider: ChildLivenessProvider | null): void {
    this.childLivenessProvider = provider
  }

  isScopeLive(agent: string, scopeId: string): boolean {
    return this.hasActiveRun(agent, scopeId)
      || (this.childLivenessProvider?.hasActiveChildRunForScope(scopeId) ?? false)
  }

  interruptActiveRunIfMatches(
    agent: string,
    sessionId: string | undefined,
    requestId: string,
    initiator: AbortInitiator,
  ): RequestScopedStopActiveGenerationResult {
    const taskKey = this.toTaskKey(agent, sessionId)
    const activeRunId = this.activeRunIds.get(taskKey) || null
    if (!activeRunId) {
      return { state: 'not_found', runId: null }
    }
    if (activeRunId !== requestId) {
      return { state: 'stale', runId: null, activeRunId }
    }
    const stopped = this.stopActiveGeneration(agent, sessionId, initiator)
    return { state: 'cancel_requested', runId: stopped.runId }
  }

  async compactSession(agent: string, sessionId?: string): Promise<CompactSessionResult> {
    const internalKey = this.toInternalSessionKey(agent, sessionId)
    const compact = (this.sdkEngine as CompactableAgentSdkRuntime).compactSession
    if (typeof compact !== 'function') {
      throw new Error('compact_session_unavailable')
    }
    return compact.call(this.sdkEngine, internalKey, 'manual')
  }

  getSessionManager(): AgentSessionManager {
    return this.sessions
  }

  /**
   * Stage V V3.1 — enumerate all sessions tracked by the orchestrator,
   * parsed into `(agent, sessionId)` tuples. The IPC channel
   * `agent:listActiveSessions` (V3.2) and the renderer session tab UI
   * (V3.4a) consume this. Returned order matches `listStatesEnriched()`:
   * most-recently-updated first.
   *
   * NOTE: returns *all* sessions (including terminal `done` / `failed` /
   * `cancelled` / `closed`); callers that want only live sessions filter
   * with the V3.3d `isLiveSession` predicate. Including terminal entries
   * is deliberate so the UI can render a final state for a closed tab
   * before it is dismissed.
   */
  listAllSessions(): SessionSummary[] {
    return this.sessions.listStatesEnriched().map((snap) => ({
      agent: snap.descriptor.agent,
      sessionId: snap.descriptor.sessionId,
      state: snap.state,
      lastTurnAt: snap.updatedAt,
      error: snap.error,
    }))
  }

  /**
   * Stage V V3.1 — close a session by its `(agent, sessionId)` tuple.
   *
   * Cleanup sequence:
   *   1. Stop any in-flight generation on both runtimes (DirectChat +
   *      AgentSdk) — symmetric to `kill()` so an active turn cannot
   *      survive the close.
   *   2. Drop the engine pool entry (`removeSession` on each runtime) so
   *      a later `send()` to the same key starts from a clean memory
   *      session rather than reusing stale history.
   *   3. Drop the descriptor cache entry so a future re-creation does
   *      not see a stale public-vs-internal binding.
   *   4. Mark the session-manager state as `'closed'` (terminal) so the
   *      renderer's `isLiveSession` guard filters it out of fallback
   *      lookup (V3.3d codex round-7).
   *
   * Idempotent: returns `{ closed: false }` if the session was not known
   * to the session manager beforehand; `{ closed: true }` otherwise.
   * Calling `closeSession` twice in a row resolves `{ closed: true }`
   * then `{ closed: false }` — the second call is a no-op observable
   * by the boolean.
   */
  async closeSession(agent: string, sessionId?: string): Promise<{ closed: boolean }> {
    const internalKey = this.toInternalSessionKey(agent, sessionId)
    const taskKey = this.toTaskKey(agent, sessionId)
    const prior = this.sessions.getState(taskKey)
    // Idempotency: a re-close on an already-`'closed'` session is a
    // no-op and reports `closed: false` — the boolean reflects whether
    // *this* call performed the close, not whether the session exists.
    const wasLive = !!prior && prior.state !== 'closed'

    // 1 — stop in-flight generation on the SDK runtime so an active turn
    // cannot survive the close (Phase C C3: DirectChatEngine wire removed —
    // its stopGeneration had zero live effect, abortController was never
    // assigned since the legacy execution path died).
    try {
      this.sdkEngine.stopGeneration(internalKey, 'process_exit')
    } catch (error) {
      console.warn('[ReadyAgentOrchestrator] closeSession: sdkEngine.stopGeneration failed:', error)
    }

    // 3 — drop descriptor cache entry.
    this.descriptors.delete(internalKey)

    // 4 — flush projection state. If an active runId is still tracked
    // (e.g. closeSession is invoked concurrently with a turn), drain its
    // cleanup so the registry does not leak. Then mark the session
    // `'closed'` so the V3.3d guard rejects it as a live target.
    const runId = this.activeRunIds.get(taskKey)
    if (runId) {
      this.clearActiveRunIfMatches(taskKey, runId)
      void this.drainRunCleanup(runId)
    }
    if (wasLive) {
      this.sessions.setState(taskKey, 'closed')
    }
    return { closed: wasLive }
  }
}

// Stage V V3.1 — re-export the descriptor parser so consumers that need
// the parse helper (renderer payload validator, IPC fixtures) can import
// from a single orchestrator entry point.
export { parseSessionKey }
