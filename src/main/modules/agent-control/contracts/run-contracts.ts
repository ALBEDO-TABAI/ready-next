/**
 * Stage U PR U4.1a — WIRE / INTERNAL classification (locked).
 *
 * This file is being bisected by Stage U PRs U4.1a–e. The full
 * classification table is the single source of truth at
 * `docs/superpowers/plans/U4.1-run-contracts-export-classification.md`.
 *
 * Summary:
 *   - 2 WIRE exports (TaskProjectionRecord, TaskProjectionChangeEvent)
 *     will move to `src/shared/ipc-contracts/task-projection.ts` in U4.1b.
 *   - 63 INTERNAL exports will move to `run-contracts-internal.ts`
 *     (currently empty skeleton) in U4.1d.
 *   - This file itself is deleted in U4.1e.
 *
 * Do NOT add new exports to this file. Add WIRE types directly to
 * `src/shared/ipc-contracts/`; add INTERNAL types to
 * `run-contracts-internal.ts`. The check-wire-contract-isolation.cjs
 * gate (activating in U4.1d) will fence src/preload/ and src/renderer/
 * from importing run-contracts-internal.
 */

// Stage U PR U4.1c — wire-canonical task-projection types live in
// src/shared/ipc-contracts/task-projection.ts. Main re-exports them
// below so the ~56 in-tree callsites continue to compile unchanged.
// Strict ScopeRun* unions on TaskProjectionRecord are still allowed:
// callsites that need the narrow type cast via `as ScopeRunWaitingFor`
// at the read site.
// Stage U PR U4.1c (deferred) — full sub-type migration would require
// widespread call-site casts (ScopeRunTaskStep['status'] vs wire
// TaskStepStatus differs; main-internal TaskStep extends with fields
// the wire shape doesn't carry). Re-exporting wire types here would
// regress active-skill-context / skill-child-runner / task-step-runtime
// typing. The wire module continues to publish a permissive superset
// for renderer serialization (only TaskProjectionChangeEvent moved in
// U4.1b is currently wire-canonical).
import type {
  ConversationScope,
  ScopeRunEventPayload,
  ScopeRunMemoryCapture,
  ScopeRunResumableAction,
  ScopeRunSkillProgress,
  ScopeRunTaskContinuation,
  ScopeRunTaskStep,
  ScopeRunWaitingFor,
} from './types'
import type { IntentClassification } from '../intent-classifier'
import type { PromptAssemblyResult } from '../prompt-assembly'
import type { RecentSkillRunForResume } from '../skills/skill-turn-identity-snapshot'
import type { RequestEnvelope } from './request-envelope'
import type { ContinuationIntent, ContinuationState } from './continuation-state'
import type { DomainAdapter } from '../domain-adapters/domain-adapter'
import type { ToolExecutionHooks } from '../tools-runtime/tool-execution-hooks'
import type { ToolRuntimeContext } from '../tools-runtime/tool-runtime'
import type { HookRegistry } from '../system-reminders/hook-registry'
import type { SkillTaskSupervisorSnapshot } from '../skills/skill-task-supervisor'
import type { TurnTerminalReason } from '../runtime-core/turn-frame'
import type { CapabilityGroupId } from '../../../../shared/ai-capability-groups'
import type { SkillChildRunStatus as SharedSkillChildRunStatus } from '../../../../shared/skill-child-run-status'
import type { ContextUsageSnapshot } from '../../../../shared/context-usage-types'
import type { SkillRunContract } from './skill-run-contract'
import type { RecoveryRecord, ToolSnapshot } from './tool-telemetry-contracts'
import type {
  TurnModelResponse,
  TurnProviderContext,
  TurnSimpleResponse,
  TurnToolBatchResult,
  TurnToolCall,
  TurnToolExecutionResult,
} from './turn-response-contracts'

export type {
  SkillRunContract,
} from './skill-run-contract'

export type {
  RecoveryRecord,
  ToolSnapshot,
} from './tool-telemetry-contracts'

export type {
  TurnModelResponse,
  TurnProviderContext,
  TurnShortcutResult,
  TurnSimpleResponse,
  TurnToolBatchResult,
  TurnToolCall,
  TurnToolCallParseError,
  TurnToolExecutionResult,
} from './turn-response-contracts'

export interface RunMessageBlock {
  type: string
  text?: string
  base64?: string
  mimeType?: string
}

export type RunMessage = string | RunMessageBlock[]

export interface TurnEngineSessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | Array<Record<string, unknown>>
}

export interface TurnEngineSession {
  messages: TurnEngineSessionMessage[]
  /**
   * B-stage: this is load-bearing. DirectChat owns the controller and
   * AgentControlRuntime registers it so in-flight SkillChildSubAgent runs
   * can receive parent-session aborts without touching turn-engine.execute().
   */
  abortController: AbortController | null
  systemPrompt: string
  generation: number
  activeRunId: string | null
  preferTextToolBridge: boolean
  lastDocumentContextInput?: string | null
}

export interface TurnTranscriptEvent {
  kind: 'output' | 'status' | 'error' | 'tool_action' | 'structured_payload'
  type?: string
  chunk?: string
  status?: string
  terminalReason?: TurnTerminalReason | null
  error?: string
  tool?: string
  args?: Record<string, unknown>
  projectionPatch?: Record<string, unknown> | null
}

// Stage U PR U4.1c (deferred) — these sub-types stay inline on the main
// side because each one carries sub-tle status-union differences with
// ScopeRun* sibling types that would require widespread call-site casts
// to bridge. A follow-up PR can co-locate them after a dedicated audit
// of every TaskStep status touchpoint. The wire module
// (src/shared/ipc-contracts/task-projection.ts) carries a permissive
// superset for renderer-facing serialization only.
import type { TaskType as SharedTaskType } from '../../../../shared/task-types'
export type TaskType = SharedTaskType

export type TaskInteractionState =
  | 'running'
  | 'awaiting_clarification'
  | 'awaiting_confirmation'
  | 'human_takeover'
  | 'suspended'
  | 'resuming'
  | 'check_in_pending'

export interface TaskStep {
  id: string
  description: string
  title?: string
  status?: ScopeRunTaskStep['status']
  detail?: string | null
  updatedAt?: string
  toolHints?: string[]
  budget?: number
  dependsOn?: string[]
  childTasks?: TaskStepChildTask[]
}

export interface TaskStepChildTask {
  taskId: string
  taskType: TaskType
  status: UnifiedTaskState['status']
  summary?: string | null
  artifactSummary?: string | null
  updatedAt?: string | null
}

export interface TaskBudget {
  taskType: TaskType
  maxIterations: number
  maxToolCalls: number
  maxParallelToolGroups: number
  reservedToolCalls?: number
  iterationsUsed?: number
  toolCallsUsed?: number
  parallelToolGroupsUsed?: number
  frozen?: boolean
  bootstrapBudget?: boolean
  stepBudget?: {
    stepId?: string | null
    maxIterations: number
    remainingIterations?: number
  } | null
}

export type BudgetWarningLevel = 'none' | 'warning' | 'converge' | 'exhausted'

export interface StepBudgetState {
  stepId?: string | null
  maxIterations: number
  remainingIterations: number
}

export interface TaskBudgetRuntime {
  taskType: TaskType
  budget: RunBudgetSeed
  usage: RunBudgetUsage
  stepBudget: StepBudgetState | null
  warningLevel: BudgetWarningLevel
  frozen: boolean
  bootstrapBudget: boolean
  lease?: SkillBudgetLeaseState | null
}

export type SkillBudgetLeaseDecision =
  | 'active'
  | 'renew'
  | 'pause'
  | 'handoff_background'
  | 'close'

export interface SkillBudgetLeaseState {
  leaseId: string
  createdAt: string
  leaseSizeIterations: number
  maxRenewals: number
  hardCapIterations: number
  renewalsUsed: number
  currentLeaseEndIteration: number
  hardCapIteration: number
  lastFingerprint: string | null
  renewedFingerprints: string[]
  leasesWithoutFingerprintChange: number
  repeatedUnchangedObservations: number
  repeatedRecoverableErrors: number
  repeatedRecoverableErrorKind: string | null
  repeatedToolCallStreak: number
  pidOnlyRenewalsUsed: number
  decision: SkillBudgetLeaseDecision
  reason: string | null
  progressScore: number
  wasteScore: number
}

export interface ContinuationBudgetRestoreDiagnostics {
  inheritedBudget: boolean
  restoredUsage: boolean
  grantedIterationSafetyFloor: boolean
  grantedToolCallSafetyFloor: boolean
  grantedStepBudgetSafetyFloor: boolean
}

export interface ToolResolutionDiagnostics {
  visibleGroupToolCounts?: Partial<Record<CapabilityGroupId, number>>
  groupSchemaErrors?: Partial<Record<CapabilityGroupId, string>>
  usedStaticFallbackGroups?: CapabilityGroupId[]
  invariantViolations?: string[]
}

export interface ToolResourceTag {
  domain:
    | 'browser'
    | 'document'
    | 'rss'
    | 'calendar'
    | 'feishu'
    | 'map'
    | 'skill'
    | 'memory'
    | 'session'
    | 'system'
  accessMode: 'read' | 'write' | 'interactive'
}

export interface TaskTypeResolution {
  taskType: TaskType
  executionChain: 'direct' | 'tool_loop' | 'planner' | 'domain_executor' | 'continuation'
  degradationReason?: string | null
  requiresPlanner: boolean
  preferredExecutor?: 'browser' | 'document' | 'skill' | 'rss' | 'calendar' | 'feishu' | 'research' | 'map' | 'none'
}

export interface TaskExecutionRoute {
  taskId: string
  taskType: TaskType
  chain: TaskTypeResolution['executionChain']
  executor: 'direct' | 'tool_loop' | 'planner' | 'browser' | 'document' | 'skill' | 'rss' | 'calendar' | 'feishu' | 'research' | 'map'
  steps: TaskStep[]
  currentStepId?: string | null
  degradationReason?: string | null
  continuation?: {
    taskId: string
    module?: TaskProjectionRecord['module']
    continuationRef?: ScopeRunTaskContinuation | null
    blockedReason?: string | null
    resumableActions?: ScopeRunResumableAction[]
    interactionState?: TaskInteractionState
    currentStepId?: string | null
    budgetRuntime?: TaskBudgetRuntime | null
    budgetRestore?: ContinuationBudgetRestoreDiagnostics | null
  } | null
}

// Stage U PR U4.1c — TaskProjectionRecord + UnifiedTaskState retain
// strict ScopeRun* sub-typing on the main side (they're not yet
// candidates for wire re-export because the cast surface would be too
// wide). Wire-side simplified TaskProjectionRecord lives at
// src/shared/ipc-contracts/task-projection.ts for renderer consumers;
// main side keeps the strict inline definition below until a follow-up
// PR co-locates the ScopeRun* family.
export interface UnifiedTaskState {
  taskId: string
  runId?: string | null
  scopeId?: string | null
  taskType: TaskType
  status: SharedSkillChildRunStatus
  interactionState: TaskInteractionState
  waitingFor: ScopeRunWaitingFor
  steps: TaskStep[]
  currentStepId?: string | null
  budget?: TaskBudget | null
  budgetUsagePercent?: number | null
  recoveryHistory?: RecoveryRecord[]
}

export interface TaskProjectionRecord {
  taskId: string
  scopeId: string
  runId: string
  parentTaskId?: string | null
  parentStepId?: string | null
  taskType: TaskType
  module: string
  taskTitle?: string | null
  taskSummary?: string | null
  status: UnifiedTaskState['status']
  interactionState: TaskInteractionState
  waitingFor?: ScopeRunWaitingFor
  steps: TaskStep[]
  currentStepId?: string | null
  budget?: TaskBudget | null
  budgetUsagePercent?: number | null
  budgetWarningLevel?: BudgetWarningLevel | null
  recoveryHistory?: RecoveryRecord[]
  degradationReason?: string | null
  blockedReason?: string | null
  resumableActions?: ScopeRunResumableAction[]
  continuationRef?: ScopeRunTaskContinuation | null
  progress?: ScopeRunSkillProgress | null
  recentArtifacts?: ScopeRunEventPayload['artifactRefs']
  /**
   * Stage Q (Stage 11) — derived-at-read truth from main side. Renderer
   * must consume directly and NOT recompute from `resumableActions` /
   * `taskRunId` / `interactionState` (Stage Q audit §C-9 / contract C7).
   */
  canResume?: boolean
  /**
   * EP2-Q1 — task quality fields (migration 054). Shapes stay permissive
   * here; Q2 (criteria templates) and Q3/Q4 (proof/checkin writers) own
   * the concrete schemas. All reads/writes go through the repository —
   * raw SQL against these columns is a contract violation.
   */
  criteria?: Record<string, unknown> | null
  checkins?: unknown[] | null
  proofRefs?: unknown[] | null
  learningRefs?: unknown[] | null
  /** EP3-A1 — task owner agent (migration 056). Write value comes ONLY from
   *  the A4 handoff adoption; everything else reads. */
  ownerAgentId?: string | null
  /** EP3-PK1 — packet marker (09 §2): 'parent' | 'child' | null. The ONLY
   *  packet discriminator across UI/stats/adapters/tests. */
  packetRole?: 'parent' | 'child' | null
  /** EP3-PK1 — reference strings only (paths/card slugs/packet ids). */
  contextRefs?: string[] | null
  createdAt: string
  updatedAt: string
}

/**
 * Stage U PR U4.1b — `TaskProjectionChangeEvent` (and its reason union)
 * is now sourced from the canonical wire-contract module at
 * `src/shared/ipc-contracts/task-projection.ts`. Re-exported here so
 * existing main-side imports continue to work without change.
 *
 * Stage O original definition was the renderer-facing
 * `agent:taskProjectionsChanged` push event payload; the wire module
 * preserves that contract verbatim.
 */
import type { TaskProjectionChangeEvent as TaskProjectionChangeEventWire, TaskProjectionChangeReason as TaskProjectionChangeReasonWire } from '../../../../shared/ipc-contracts/task-projection'
export type TaskProjectionChangeEvent = TaskProjectionChangeEventWire
export type TaskProjectionChangeReason = TaskProjectionChangeReasonWire

/**
 * Stage O — write options. `silent: true` suppresses the change event;
 * used by `task-projection-reconciler.ts` whose writes are themselves
 * driven by a renderer fetch (without `silent` we'd loop fetch → reconcile
 * → push → fetch). `reasonHint` lets the caller upgrade the emit reason
 * (default reason is derived from operation type).
 */
export interface TaskProjectionWriteOptions {
  silent?: boolean
  reasonHint?: TaskProjectionChangeReason
}

export interface TaskProjectionStore {
  create(record: TaskProjectionRecord, options?: TaskProjectionWriteOptions): void | Promise<void>
  update(taskId: string, patch: Partial<TaskProjectionRecord>, options?: TaskProjectionWriteOptions): void | Promise<void>
  get(taskId: string): TaskProjectionRecord | null | Promise<TaskProjectionRecord | null>
  listByScope(scopeId: string): TaskProjectionRecord[] | Promise<TaskProjectionRecord[]>
  listByParentTask(parentTaskId: string): TaskProjectionRecord[] | Promise<TaskProjectionRecord[]>
  /**
   * Locates legacy `module='system' task_type='short_task'` projection rows
   * whose recentArtifacts share the given outputDir or runStatePath. Used
   * by Stage 6 supersede semantics so a newly-committed skill-keyed row
   * (`skill:detached:` / `skill:run_state:` / `skill:output:`) can mark
   * its legacy ancestors as superseded. Implementations may filter in
   * memory; only non-terminal rows (`running`/`blocked`/`queued`) need to
   * be returned, but returning more is acceptable — callers filter.
   */
  findByArtifactSiblings?(args: {
    scopeId: string
    skillId: string | null
    outputDir: string | null
    runStatePath: string | null
  }): TaskProjectionRecord[] | Promise<TaskProjectionRecord[]>
}

export interface RunBudgetSeed {
  maxIterations: number
  maxToolCalls: number
  maxParallelToolGroups: number
  reservedToolCalls?: number
}

export interface RunBudgetUsage {
  iterationsUsed: number
  toolCallsUsed: number
  parallelToolGroupsUsed: number
}

export interface RunBudgetHint {
  maxIterations?: number
  reserveToolCalls?: number
}

export interface ExecutionRunDiagnostics {
  taskId?: string | null
  taskBudgetRuntime?: TaskBudgetRuntime | null
  compression?: {
    historyCompressed: boolean
    toolTraceCompressed: boolean
    artifactSummaryUsed: boolean
  } | null
  budget?: Partial<RunBudgetSeed & RunBudgetUsage> | null
  stepBudget?: {
    stepId?: string | null
    maxIterations?: number
    remainingIterations?: number
  } | null
  budgetUsagePercent?: number | null
  budgetWarningLevel?: BudgetWarningLevel | null
  providerDiagnostics?: {
    provider?: string | null
    agentProtocol?: string | null
    wireApi?: string | null
    contextWindow?: number | null
    protocolSource?: 'explicit' | 'inferred' | null
    contextWindowSource?: 'explicit' | 'model' | 'fallback' | null
  } | null
  contextUsage?: ContextUsageSnapshot | null
  budgetLease?: {
    leaseId: string
    decision: SkillBudgetLeaseDecision
    reason: string | null
    renewalsUsed: number
    progressScore: number
    wasteScore: number
    lastFingerprint: string | null
    currentLeaseEndIteration: number
  } | null
  fallback?: {
    happened: boolean
    kind: string
    attempts: number
  } | null
  toolSnapshots?: ToolSnapshot[] | null
  toolResolution?: ToolResolutionDiagnostics | null
  recoveryHistory?: RecoveryRecord[] | null
  continuationBudgetRestore?: ContinuationBudgetRestoreDiagnostics | null
  degradationReason?: string | null
  pipeline?: {
    document?: {
      phase?: string
      chunkCount?: number
      selectedChunkCount?: number
      promptChars?: number
      cacheHit?: boolean
      usedSectionAnchors?: boolean
    } | null
  } | null
}

export interface RunCoordinatorRequest {
  scope: ConversationScope
  message: RunMessage
  coordinators: ReadonlyArray<DomainAdapter>
  requestId?: string
  sourceMessageId?: string | null
  taskId?: string
  parentTaskId?: string
  parentStepId?: string
  sessionIdOverride?: string
  workspaceRoots?: string[]
  budget?: RunBudgetSeed
  continuationIntent?: ContinuationIntent | null
}

export type ScopeRunAuthority = {
  state: 'lost'
  reason: 'superseded_by_newer_send' | 'preempted_by_newer_send' | 'preempted_by_same_user'
  currentRunId?: string | null
}

export interface RunCoordinatorResult {
  success: boolean
  error?: string
  errorKind?: string
  scopeRunAuthority?: ScopeRunAuthority
}

export interface ExecutionHostRequest {
  agent: string
  sessionId?: string
  sessionIdOverride?: string
  requestId?: string
  sourceMessageId?: string | null
  taskId?: string
  parentTaskId?: string
  parentStepId?: string
  systemPrompt?: string
  message: RunMessage
  requestEnvelope?: RequestEnvelope
  intentClassification?: IntentClassification
  budget?: RunBudgetSeed
  budgetState?: RunBudgetUsage
  taskBudgetRuntime?: TaskBudgetRuntime
  continuationIntent?: ContinuationIntent | null
  continuationState?: ContinuationState | null
}

export interface ExecutionHostResult {
  success: boolean
  finalText: string
  cancelled: boolean
  usedTools: string[]
  error?: string
  taskId?: string | null
  budgetState?: RunBudgetUsage
  taskBudgetRuntime?: TaskBudgetRuntime
  taskType?: TaskType
  interactionState?: TaskInteractionState
  taskProjectionId?: string | null
  executionDiagnostics?: ExecutionRunDiagnostics | null
  contextUsage?: ContextUsageSnapshot | null
  projectionTruth?: ProjectionTruthSnapshot | null
  skillTaskLifecycle?: SkillTaskLifecycleSignal | null
  terminalReason?: TurnTerminalReason | null
  scopeRunAuthority?: ScopeRunAuthority
}

export interface ExecutionTurnResult {
  success: boolean
  status?: 'done' | 'error' | 'cancelled' | 'checkpoint'
  finalText: string
  cancelled: boolean
  usedTools: string[]
  error?: string
  taskId?: string | null
  taskType?: TaskType
  interactionState?: TaskInteractionState
  taskProjectionId?: string | null
  executionDiagnostics?: ExecutionRunDiagnostics | null
  contextUsage?: ContextUsageSnapshot | null
  projectionTruth?: ProjectionTruthSnapshot | null
  skillTaskLifecycle?: SkillTaskLifecycleSignal | null
  terminalReason?: TurnTerminalReason | null
  scopeRunAuthority?: ScopeRunAuthority
}

export type SkillTaskLifecycleState =
  | 'background_running'
  | 'budget_paused'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled'

export type SkillTaskLifecycleReason =
  | 'background_running'
  | 'background_handoff'
  | 'budget_exhausted'
  | 'recoverable_paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'primitive_observation'
  | 'supervisor_close'

export interface SkillTaskLifecycleSignal {
  state: SkillTaskLifecycleState
  reason: SkillTaskLifecycleReason
  phase: ScopeRunEventPayload['phase']
  interactionState: TaskInteractionState
  waitingFor: ScopeRunWaitingFor
  resumableActions: ScopeRunResumableAction[]
  blockedReason: string | null
  taskContinuation: ScopeRunTaskContinuation | null
}

export interface ProjectionTruthSnapshot {
  projectionPatch: Record<string, unknown> | null
  transcriptEvents: TurnTranscriptEvent[]
  /**
   * Lightweight, flat structural view of the active TurnFrame skill slice.
   * Intentionally inlined (not importing TurnFrameSkillSlice) so projection
   * sync can read frame signals without taking a runtime dependency on the
   * full frame module.
   *
   * Stage F1 (Zeta) — `runContract` carries the durable cross-turn contract
   * truth so projection sync can prefer contract-derived status / liveness
   * / progress / artifact paths over the older summary+artifact heuristics.
   * The shape is intentionally inlined too (a flat structural mirror of
   * `SkillRunContract`) so consumers do not pull the full contract module.
   */
  frameSnapshot?: {
    skill: {
      skillId: string
      skillName: string | null
      source: string
      detachedTaskId: string | null
      runStatePath: string | null
      outputDir: string | null
      action: string | null
      staleBlockerReason: string | null
      runContract?: {
        skillId: string
        action: string | null
        toolName: string | null
        actionInput: Record<string, unknown> | null
        originalInput: Record<string, unknown> | null
        sourceUrl: string | null
        taskRunId: string | null
        detachedTaskId: string | null
        jobId: string | null
        outputDir: string | null
        runStatePath: string | null
        artifactPaths: {
          sceneScoresPath: string | null
          deliveryReportPath: string | null
        }
        status: SkillRunContract['status'] | null
        liveness: SkillRunContract['liveness'] | null
        progress: {
          stage: string | null
          totalUnits: number | null
          completedUnits: number | null
          coverageRatio: number | null
        } | null
        blocker: {
          reason: string | null
          stale: boolean
        } | null
        projectionIdentity: {
          stableKey: string | null
        } | null
        /**
         * Phase 7 — child-run handle. When non-empty the projection
         * primary key MUST be `skill-child:<childRunId>` so two skills
         * sharing one outputDir do not alias.
         */
        childRunId?: string | null
      } | null
    } | null
    /** Per-turn terminal reason captured at frame closure. */
    terminalReason?: TurnTerminalReason | null
  } | null
}

export interface WorkerSessionIdentity {
  taskId: string
  workerSessionId: string
  parentTaskId: string
  parentStepId: string
}

export interface SubtaskInlineWorkerUpdate {
  phase?: ScopeRunEventPayload['phase']
  taskSummary?: string | null
  steps?: ScopeRunTaskStep[]
  currentStepId?: string | null
  waitingFor?: ScopeRunWaitingFor
  resumableActions?: ScopeRunResumableAction[]
  blockedReason?: string | null
  interactionState?: TaskInteractionState
  recentArtifacts?: ScopeRunEventPayload['artifactRefs']
  error?: string | null
}

export interface SubtaskInlineWorkerResult {
  finalText?: string
  taskSummary?: string | null
  steps?: ScopeRunTaskStep[]
  currentStepId?: string | null
  waitingFor?: ScopeRunWaitingFor
  resumableActions?: ScopeRunResumableAction[]
  blockedReason?: string | null
  interactionState?: TaskInteractionState
  recentArtifacts?: ScopeRunEventPayload['artifactRefs']
  projectionTruth?: ProjectionTruthSnapshot | null
}

export interface SubtaskInlineWorkerContext {
  identity: WorkerSessionIdentity
  emitUpdate: (payload: SubtaskInlineWorkerUpdate) => void
}

export interface SubtaskRunRequest {
  scope: ConversationScope
  parentTaskId: string
  parentStepId: string
  taskTitle: string
  module: ScopeRunEventPayload['module']
  taskType: TaskType
  initialSummary?: string | null
  initialSteps?: ScopeRunTaskStep[]
  runInlineWorker?: (context: SubtaskInlineWorkerContext) => Promise<SubtaskInlineWorkerResult>
}

export interface SubtaskRunResult {
  taskId: string
  status: 'done' | 'error' | 'cancelled'
  finalText: string
  error?: string
  projectionTruth?: ProjectionTruthSnapshot | null
}

export interface TurnEngineHost<TSession extends TurnEngineSession = TurnEngineSession> {
  log: (message: string) => void
  maxToolIterations: number
  browserController?: unknown | null
  sidecarManager?: unknown | null
  runtime?: {
    isChannelTypeAvailable?: (channelType: string) => boolean
    getConversationScope?: (sessionId: string) => unknown
  } | null
  requestModuleToolAction?: ((tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>) | undefined
  registerRunCleanup?: ((cleanup: () => void | Promise<void>) => void) | undefined
  hookRegistry?: HookRegistry | null
  providerContext: TurnProviderContext
  isBrowserAgentV3Enabled: () => boolean
  resolveContinuationProjection: (sessionId: string | undefined, userText: string, options?: {
    explicitTaskId?: string | null
    allowImplicitContinuation?: boolean
  }) => TaskProjectionRecord | null
  resolveRecentSkillRun?: (sessionId: string | undefined) => {
    toolName: string
    skillId: string
    action: string
    success: boolean
    summary: string
    updatedAt: number
  } | null
  /**
   * Stage Q (Stage 11) — formal interface declaration for what was
   * previously two `(host as unknown as ...)` type punctures in
   * `turn-engine.ts:1612, 1644`. Resolves the most-recent skill task
   * run from the SQLite repository when `resolveRecentSkillRun` is
   * insufficient (the latter projects from the in-memory ledger; this
   * one queries the durable run row).
   */
  resolveRecentSkillTaskRun?: (sessionId: string | undefined) => RecentSkillRunForResume | null
  skillTaskSupervisor?: {
    inspectLatestSkillTask: (params: {
      sessionId?: string | null
      scopeId?: string | null
      skillId?: string | null
    }) => SkillTaskSupervisorSnapshot
  } | null
  getIncomingAttachmentHints: (content: RunMessage) => { count: number; latestName?: string }
  collectRecentPureUserInputs: (messages: TurnEngineSessionMessage[], limit?: number) => string[]
  sessionHasMediaInputs: (messages: TurnEngineSessionMessage[]) => boolean
  sessionHasVideoInputs: (messages: TurnEngineSessionMessage[]) => boolean
  resolveActiveWidgetEditLease?: () => import('../widget-edit-lease').ActiveWidgetEditLease | null
  refreshActiveWidgetEditLease?: (ttlMs?: number) => import('../widget-edit-lease').ActiveWidgetEditLease | null
  domainAdapters?: DomainAdapter[]
  skillContextOrchestrator: unknown
  browserDomainOrchestrator: unknown
  documentToolLoopOrchestrator: unknown
  designToolLoopOrchestrator: unknown
  hostCapabilityDispatcher: unknown
  executeToolCall: (
    toolName: string,
    args: Record<string, unknown>,
    context: unknown,
  ) => Promise<TurnToolExecutionResult['result']>
  requestSimpleText: (params: {
    session: TSession
    signal: AbortSignal
    providerContext: TurnProviderContext
    enableKimiWebSearch?: boolean
    timeoutMs?: number
  }) => Promise<TurnSimpleResponse>
  requestToolLoopResponse: (params: {
    session: TSession
    signal: AbortSignal
    toolPolicy: unknown
    allowedToolNames?: string[] | null
    hasTools?: boolean
    allowBrowserTools?: boolean
    providerContext: TurnProviderContext
    hasVideoInputs: boolean
    browserDecisionMode?: string | null
    runtimeSnapshot?: {
      browserHostAvailable?: boolean
      groups?: Partial<Record<CapabilityGroupId, { status: string }>>
    } | null
    visibleCapabilityGroupIds?: CapabilityGroupId[]
    suppressedCapabilityGroupIds?: CapabilityGroupId[]
    capabilityLogLine?: string | null
    iteration?: number
    requestedTransport?: 'native' | 'text' | 'none'
    supportsNativeTools?: boolean
    preferTextToolBridgeOnce?: boolean
    onBeforeRetry?: (result: unknown, attempt: number) => Promise<void> | void
  }) => Promise<TurnModelResponse>
  executeToolBatch: (params: {
    toolCalls: TurnToolCall[]
    context: ToolRuntimeContext
    executeTool?: (toolCall: TurnToolCall) => Promise<unknown>
    hooks?: ToolExecutionHooks
    onGroupStart?: (group: { mode: 'parallel' | 'serial'; toolCalls: TurnToolCall[] }) => void
    budget?: RunBudgetSeed
    budgetState?: RunBudgetUsage
    signal?: AbortSignal
  }) => Promise<TurnToolBatchResult>
}

export interface TurnEngineRequest<TSession extends TurnEngineSession = TurnEngineSession> {
  runId: string
  taskId: string
  parentTaskId?: string
  parentStepId?: string
  agentName: string
  sessionId?: string
  session: TSession
  content: RunMessage
  requestEnvelope?: RequestEnvelope
  intentClassification?: IntentClassification
  budget?: RunBudgetSeed
  budgetState?: RunBudgetUsage
  taskBudgetRuntime?: TaskBudgetRuntime | null
  continuationState?: ContinuationState | null
  abortSignal: AbortSignal
  ensureNotAborted: () => void
  emitters: {
    emitOutput: (
      chunk: string,
      type: string,
      options?: {
        projectionPatch?: Record<string, unknown> | null
      },
    ) => void
    emitStatus: (status: string, terminalReason?: TurnTerminalReason | null) => void
    emitRuntimeError: (error: unknown, options?: { toolName?: string }) => void
    emitToolAction: (tool: string, args: Record<string, unknown>) => void
  }
  host: TurnEngineHost<TSession>
}

export interface ToolVisibilityPlan {
  hasTools: boolean
  keepToolsWithVideo: boolean
  allowBrowserTools: boolean
  preferredSkillToolNames?: string[] | null
  visibleCapabilityGroupIds?: CapabilityGroupId[]
  hostOnlyCapabilityIds?: CapabilityGroupId[]
  suppressedCapabilityGroupIds?: CapabilityGroupId[]
  capabilityReasons?: Partial<Record<CapabilityGroupId, string>>
}

export interface ToolDispatchDecision {
  transport: 'native' | 'text' | 'none'
  supportsNativeTools: boolean
  preferTextToolBridge: boolean
}

export interface DomainOrchestrationDecision {
  domain: 'browser' | 'document' | 'design' | 'none'
  mode: 'deterministic' | 'tool_loop' | 'none'
  reason: string
}

export interface RunProjectionPatch {
  taskType?: TaskType
  module?: ScopeRunEventPayload['module'] | string | null
  skillExecutionForm?: 'direct' | 'child_loop' | 'python' | null
  taskTitle?: string | null
  taskSummary?: string | null
  interactionState?: TaskInteractionState
  steps?: ScopeRunTaskStep[]
  currentStepId?: string | null
  waitingFor?: 'input' | 'confirmation' | 'agent_result' | 'background' | 'clarification' | 'verification' | 'none'
  resumableActions?: ScopeRunResumableAction[]
  taskContinuation?: ScopeRunTaskContinuation | null
  blockedReason?: string | null
  progress?: ScopeRunSkillProgress | null
  recentArtifacts?: ScopeRunEventPayload['artifactRefs']
}

export type PreparedRunPayload = PromptAssemblyResult

export interface RunCompletionHooks {
  onSuccess?: (result: ExecutionHostResult) => Promise<void> | void
  onFailure?: (error: string, result: ExecutionHostResult) => Promise<void> | void
}

export interface ReflectionResultHook {
  onMemoryCapture?: (memoryCapture: ScopeRunMemoryCapture) => Promise<void> | void
}

export type { LoadSkillRunContractParams } from './skill-run-contract-loader'
export { buildContractFramePatch, loadSkillRunContract } from './skill-run-contract-loader'
export { shouldParentForceLongSkillTool, isParentForceForbiddenByManifest } from './skill-parent-force-fence'
export { FRAME_PATCH_EMITTING_TOOL_NAMES, isFramePatchEmittingToolName } from './skill-frame-patch-tool-names'
