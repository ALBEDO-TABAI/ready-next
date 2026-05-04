/**
 * A1 SubAgent contract.
 *
 * A SubAgent value represents one lifecycle instance. `lifecycleId` is minted
 * for the current run, `durableRunId` is optional future persistence identity,
 * and `artifactDir` is a separate reusable output location.
 *
 * AbortSignal contract (A1): callers pass one flat AbortSignal into one
 * SubAgent lifecycle. The caller owns the abort source; the SubAgent owns only
 * cleanup registered through `SubAgentCleanupHandle`. Parent-child signal trees
 * and cross-process recovery are out of scope for A1.
 *
 * Recovery contract: A1 intentionally does not expose a `restoreFrom` hook.
 * B will introduce factory-based restore when child-runner migration gives the
 * persisted row shape a single owner.
 *
 * Implementations yield only work events (`progress` / `paused`) and return a
 * `SubAgentRunResult`. The runner owns `started` and `terminal` framing.
 */

export type SubAgentLifecycleState =
  | 'pending'
  | 'running'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type SubAgentCloseState = Exclude<
  SubAgentLifecycleState,
  'pending' | 'running'
>

export type SubAgentPauseReason =
  | 'budget'
  | 'recoverable'
  | 'background'
  | 'external'

export type SubAgentTerminalReason =
  | 'completed'
  | 'aborted'
  | 'cancelled_user'
  | 'failed_subagent'
  | 'host_unavailable'
  | 'persistence_failed'
  | 'blocked_external'
  | 'blocked_config'
  | 'checkpoint_budget'
  | 'checkpoint_background'
  | 'process_restarted'

export type SubAgentPermissionMode =
  | 'inherit'
  | 'restricted'
  | 'internal'

export type SubAgentCleanupCallback = () => void | Promise<void>

export interface SubAgentCleanupHandle {
  register(callback: SubAgentCleanupCallback): void
  drain(timeoutMs?: number): Promise<void>
}

export interface SubAgentLogger {
  debug?(message: string, metadata?: unknown): void
  info?(message: string, metadata?: unknown): void
  warn?(message: string, metadata?: unknown): void
  error?(message: string, metadata?: unknown): void
}

export interface SubAgentContext {
  readonly abortSignal: AbortSignal
  readonly cleanup: SubAgentCleanupHandle
  readonly permissionMode?: SubAgentPermissionMode | null
  readonly systemPrompt?: string | null
  readonly parentScopeId?: string | null
  readonly parentSessionId?: string | null
  readonly logger?: SubAgentLogger
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SubAgentProgress {
  readonly stage?: string | null
  readonly totalUnits?: number | null
  readonly completedUnits?: number | null
  readonly coverageRatio?: number | null
  readonly overallCoverageRatio?: number | null
  readonly fingerprint?: string | null
}

export interface SubAgentError {
  readonly kind: string
  readonly message: string
  readonly stack?: string
  readonly cause?: unknown
}

export interface SubAgentProgressWorkEvent {
  readonly type: 'progress'
  readonly message: string
  readonly payload?: unknown
  readonly progress?: SubAgentProgress | null
}

export interface SubAgentPausedWorkEvent {
  readonly type: 'paused'
  readonly pauseReason: SubAgentPauseReason
  readonly reason: string
  readonly message?: string | null
  readonly payload?: unknown
  readonly progress?: SubAgentProgress | null
}

export type SubAgentWorkEvent =
  | SubAgentProgressWorkEvent
  | SubAgentPausedWorkEvent

export interface SubAgentRunResult {
  readonly state?: SubAgentCloseState
  readonly terminalReason?: SubAgentTerminalReason
  readonly outputDir?: string | null
  readonly runStatePath?: string | null
  readonly sceneScoresPath?: string | null
  readonly deliveryReportPath?: string | null
  readonly progress?: SubAgentProgress | null
  readonly framePatch?: unknown
  readonly projectionPatch?: unknown
  readonly error?: SubAgentError | null
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SubAgentCloseEvent {
  readonly lifecycleId: string
  readonly durableRunId?: string | null
  readonly subagentName: string
  readonly state: SubAgentCloseState
  readonly terminalReason: SubAgentTerminalReason
  readonly terminalAt: string
  readonly artifactDir: string | null
  readonly outputDir?: string | null
  readonly runStatePath?: string | null
  readonly sceneScoresPath?: string | null
  readonly deliveryReportPath?: string | null
  readonly progress?: SubAgentProgress | null
  readonly framePatch?: unknown
  readonly projectionPatch?: unknown
  readonly error?: SubAgentError | null
  readonly parentScopeId?: string | null
  readonly parentSessionId?: string | null
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SubAgentStartedEvent {
  readonly type: 'started'
  readonly lifecycleId: string
  readonly durableRunId?: string | null
  readonly subagentName: string
  readonly artifactDir: string | null
  readonly startedAt: string
}

export interface SubAgentProgressEvent extends SubAgentProgressWorkEvent {
  readonly lifecycleId: string
  readonly durableRunId?: string | null
  readonly subagentName: string
}

export interface SubAgentPausedEvent extends SubAgentPausedWorkEvent {
  readonly lifecycleId: string
  readonly durableRunId?: string | null
  readonly subagentName: string
}

export interface SubAgentTerminalEvent {
  readonly type: 'terminal'
  readonly lifecycleId: string
  readonly durableRunId?: string | null
  readonly subagentName: string
  readonly state: SubAgentCloseState
  readonly terminalReason: SubAgentTerminalReason
  readonly closeEvent: SubAgentCloseEvent
}

export type SubAgentEvent =
  | SubAgentStartedEvent
  | SubAgentProgressEvent
  | SubAgentPausedEvent
  | SubAgentTerminalEvent

export interface SubAgent {
  readonly lifecycleId: string
  readonly durableRunId?: string | null
  readonly subagentName: string
  readonly artifactDir: string | null
  run(
    context: SubAgentContext,
  ): AsyncGenerator<SubAgentWorkEvent, SubAgentRunResult | void, void>
}
