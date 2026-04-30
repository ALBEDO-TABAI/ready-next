import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ConversationScope,
  ScopeRunEventPayload,
  ScopeRunMemoryCapture,
  ScopeRunResumableAction,
  ScopeRunTaskContinuation,
  ScopeRunTaskStep,
  ScopeRunWaitingFor,
} from './types'
import type { IntentClassification } from './intent-classifier'
import type { PromptAssemblyResult } from './prompt-assembly'
import type { RequestEnvelope } from './request-envelope'
import type { ContinuationIntent, ContinuationState } from './continuation-state'
import type { DomainAdapter } from './domain-adapter'
import type { ToolExecutionHooks } from './tool-execution-hooks'
import type { ToolRuntimeContext } from './tool-runtime'
import type { SkillTaskSupervisorSnapshot } from './skill-task-supervisor'
import type { ReferenceSkillHint } from './skill-reference-hints'
import type { TurnFrame, TurnFramePatch, TurnTerminalReason } from './turn-frame'
import type { CapabilityGroupId } from '../../../shared/ai-capability-groups'
import type { AIModelConfig } from '../../../shared/ai-providers'

/**
 * ────────────────────────────────────────────────────────────────────────
 * SKILL RUN CONTRACT — additive amendment rule (Wave 1 → 2/3 interface lock)
 * ────────────────────────────────────────────────────────────────────────
 *
 * The `SkillRunContract` interface and `loadSkillRunContract` loader below
 * are the durable source of truth that survives across turns. They are the
 * Wave 1 → Wave 2/3 interface that producer teams (Gamma + Delta) emit
 * patches for, and consumer teams (Epsilon + Zeta) read action input from.
 *
 * Wave 2/3 teams MAY append optional fields to `SkillRunContract` without
 * re-opening Beta if and only if ALL of the following hold:
 *   1. The field is optional (`?:`) or nullable (`| null`).
 *   2. The field is appended at the end of the interface (no rename, no
 *      type narrowing of an existing field).
 *   3. `loadSkillRunContract(...)` is updated to populate the field or
 *      explicitly leave it null (no silent drop).
 *   4. `buildContractFramePatch(snapshot)` is updated so the new field
 *      flows through `framePatch.runContract`.
 *
 * Required fields, type narrowing, or rename → re-open Beta and block
 * downstream waves.
 * ────────────────────────────────────────────────────────────────────────
 */

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
  error?: string
  tool?: string
  args?: Record<string, unknown>
  projectionPatch?: Record<string, unknown> | null
}

export type TaskType =
  | 'direct_answer'
  | 'short_task'
  | 'multi_step_task'
  | 'media_task'
  | 'continuation'

export type TaskInteractionState =
  | 'running'
  | 'awaiting_clarification'
  | 'awaiting_confirmation'
  | 'human_takeover'
  | 'suspended'
  | 'resuming'

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

export interface RecoveryRecord {
  kind:
    | 'rate_limit'
    | 'context_overflow'
    | 'timeout_model'
    | 'timeout_tool'
    | 'auth'
    | 'transient'
    | 'host_unavailable'
  source: 'model_request' | 'tool_execution' | 'runtime'
  message: string
  attempt: number
  recovered: boolean
  timestamp: string
}

export interface ToolSnapshot {
  stage: 'host_prepared' | 'host_effective' | 'tool_loop_request' | 'provider_request' | 'provider_response'
  source: 'host' | 'provider'
  iteration: number
  provider: string
  baseUrl: string
  model: string
  wireApi?: 'responses' | 'chat/completions' | null
  browserDecisionMode?: string | null
  browserHostAvailable?: boolean | null
  hasTools: boolean
  allowBrowserTools: boolean
  visibleCapabilityGroupIds: CapabilityGroupId[]
  suppressedCapabilityGroupIds: CapabilityGroupId[]
  allowedToolNames: string[]
  requestedTransport: 'native' | 'text' | 'none'
  effectiveTransport: 'native' | 'text' | 'none'
  supportsNativeTools: boolean
  preferTextToolBridge: boolean
  fallbackReason?: string | null
  toolCallsCount?: number | null
  mismatch?: boolean
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
  preferredExecutor?: 'browser' | 'document' | 'skill' | 'rss' | 'calendar' | 'feishu' | 'none'
}

export interface TaskExecutionRoute {
  taskId: string
  taskType: TaskType
  chain: TaskTypeResolution['executionChain']
  executor: 'direct' | 'tool_loop' | 'planner' | 'browser' | 'document' | 'skill' | 'rss' | 'calendar' | 'feishu'
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

export interface UnifiedTaskState {
  taskId: string
  runId?: string | null
  scopeId?: string | null
  taskType: TaskType
  status: 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled'
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
  recentArtifacts?: ScopeRunEventPayload['artifactRefs']
  createdAt: string
  updatedAt: string
}

export interface TaskProjectionStore {
  create(record: TaskProjectionRecord): void | Promise<void>
  update(taskId: string, patch: Partial<TaskProjectionRecord>): void | Promise<void>
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
  requestId?: string
  taskId?: string
  parentTaskId?: string
  parentStepId?: string
  sessionIdOverride?: string
  budget?: RunBudgetSeed
  continuationIntent?: ContinuationIntent | null
}

export interface RunCoordinatorResult {
  success: boolean
  error?: string
}

export interface ExecutionHostRequest {
  agent: string
  sessionId?: string
  sessionIdOverride?: string
  requestId?: string
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
  projectionTruth?: ProjectionTruthSnapshot | null
  skillTaskLifecycle?: SkillTaskLifecycleSignal | null
  terminalReason?: TurnTerminalReason | null
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
  projectionTruth?: ProjectionTruthSnapshot | null
  skillTaskLifecycle?: SkillTaskLifecycleSignal | null
  terminalReason?: TurnTerminalReason | null
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

export interface TurnProviderContext {
  config: AIModelConfig
  baseUrl: string
  provider?: unknown
  isKimi: boolean
  isKimiCoding: boolean
  useAnthropicProtocol: boolean
  supportsToolCalls: boolean
  supportsVideoBlock: boolean
  hasRawVideoInIncoming: boolean
}

export interface TurnSimpleResponse {
  text: string
  fallback?: {
    happened: boolean
    kind: string
    attempts: number
  } | null
}

export interface TurnToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface TurnToolExecutionResult {
  id: string
  name: string
  input: Record<string, unknown>
  result: {
    text: string
    shape?: string
    data?: unknown
    projectionPatch?: Record<string, unknown> | null
    interactionHint?: string | null
  }
}

export interface TurnToolBatchResult {
  results: TurnToolExecutionResult[]
  budgetLimited: boolean
  recoveryHistory: RecoveryRecord[]
}

export interface TurnModelResponse extends TurnSimpleResponse {
  toolCalls: TurnToolCall[]
  stopReason: string
  reasoningContent?: unknown
  providerResponseId?: string
  rawText?: string
  toolTransport?: 'native' | 'text'
  toolSnapshots?: ToolSnapshot[]
  recoveryHistory?: RecoveryRecord[]
}

export interface TurnShortcutResult {
  finalText?: string | null
  error?: string
  interactionState?: TaskInteractionState
  status?: 'done' | 'error' | 'cancelled'
  success?: boolean
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
  resolveActiveWidgetEditLease?: () => import('./widget-edit-lease').ActiveWidgetEditLease | null
  refreshActiveWidgetEditLease?: (ttlMs?: number) => import('./widget-edit-lease').ActiveWidgetEditLease | null
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
    compressContext?: () => Promise<boolean> | boolean
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
    emitStatus: (status: string) => void
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
  taskTitle?: string | null
  taskSummary?: string | null
  steps?: ScopeRunTaskStep[]
  currentStepId?: string | null
  waitingFor?: 'input' | 'confirmation' | 'agent_result' | 'background' | 'clarification' | 'none'
  resumableActions?: ScopeRunResumableAction[]
  taskContinuation?: ScopeRunTaskContinuation | null
  blockedReason?: string | null
}

export type PreparedRunPayload = PromptAssemblyResult

export interface RunCompletionHooks {
  onSuccess?: (result: ExecutionHostResult) => Promise<void> | void
  onFailure?: (error: string, result: ExecutionHostResult) => Promise<void> | void
}

export interface ReflectionResultHook {
  onMemoryCapture?: (memoryCapture: ScopeRunMemoryCapture) => Promise<void> | void
}

// ────────────────────────────────────────────────────────────────────────
// SkillRunContract (Stage C — durable long-skill ownership)
// ────────────────────────────────────────────────────────────────────────

/**
 * `SkillRunContract` is the durable, cross-turn source of truth for a long
 * skill run. Where `TurnFrame` is per-turn coordination glue and
 * `TurnFramePatch` is intra-turn update messages, this contract preserves
 * the handles, paths, validated action input, status, liveness, progress,
 * and force-loop guard state needed to resume the run on the next turn.
 *
 * The contract is a READ MODEL over existing durable sources:
 *   - `<outputDir>/run_state.json` (Zeta, Wave 3)
 *   - `task_projection_records` (sibling row by stable identity / artifact)
 *   - `SkillTaskSupervisorSnapshot` (live runtime observation)
 *   - session continuity / reference-skill hint
 *
 * It is intentionally NOT a new SQLite table in this route.
 *
 * Shape per source-plan §5.1.
 */
export interface SkillRunContract {
  skillId: string
  skillName: string | null
  toolName: string | null
  action: string | null
  /** Validated or validate-ready input for the next typed action. */
  actionInput: Record<string, unknown> | null
  /** User/source input retained so action input can be rebuilt later. */
  originalInput: Record<string, unknown> | null
  sourceUrl: string | null
  taskRunId: string | null
  detachedTaskId: string | null
  jobId: string | null
  outputDir: string | null
  runStatePath: string | null
  /** Allowed read/write surface for current skill artifacts. */
  artifactRoots: string[]
  artifactPaths: {
    sceneScoresPath: string | null
    deliveryReportPath: string | null
  }
  status:
    | 'unknown'
    | 'running'
    | 'recoverable_paused'
    | 'blocked'
    | 'ready_to_resume'
    | 'completed'
    | 'failed'
  liveness: TurnFrame['liveness']
  progress: TurnFrame['progress']
  blocker: {
    reason: string | null
    stale: boolean
  }
  projectionIdentity: {
    stableKey: string | null
    supersedesProjectionIds: string[]
  }
  /**
   * Cross-turn force-loop guard. Compared on `(toolName, inputDigest)` so
   * repeated identical force calls are blocked while genuinely new input
   * can still run. Owned by the contract — not a `turn-engine.ts` local —
   * so a new turn cannot rebuild the frame and force the same tool forever.
   */
  forceLoopGuard: {
    lastForceToolName: string | null
    lastForceInputDigest: string | null
    lastForceToolDispatchedAt: string | null
    consecutiveForceCount: number
  }
  updatedAt: string
}

/**
 * Canonical list of tool names whose results emit a `framePatch.runContract`
 * (or a structurally-equivalent contract update). Used by Gamma's Wave 2
 * parallelism gate (`tool-parallelism-policy.ts`) to ensure no
 * frame-mutating skill tool is ever marked read-only parallel-safe.
 *
 * Static names are listed verbatim. The dynamic typed action wrapper
 * `skill_<id>_<action>` is matched via `isFramePatchEmittingToolName(name)`
 * since the exact tool name varies per skill manifest.
 */
export const FRAME_PATCH_EMITTING_TOOL_NAMES: readonly string[] = [
  'skill_inspect_run_state',
  'skill_patch_config',
  'skill_start_detached',
  'skill_cancel_detached',
  'skill_inspect_detached',
] as const

/**
 * Predicate matching any tool name that emits a frame-patch `runContract`
 * update — both the static primitives in `FRAME_PATCH_EMITTING_TOOL_NAMES`
 * and the dynamic typed action wrappers `skill_<id>_<action>`.
 *
 * Gamma's parallelism gate must use this predicate (not the static list
 * alone) so typed actions are correctly excluded from the read-only
 * parallel-safe set.
 */
export function isFramePatchEmittingToolName(toolName: string): boolean {
  if (!toolName || typeof toolName !== 'string') return false
  if (FRAME_PATCH_EMITTING_TOOL_NAMES.includes(toolName)) return true
  // Dynamic typed actions are exposed as `skill_<id>_<action>`. The
  // primitives list above is exhaustive for non-typed names; anything
  // else that begins with `skill_` and is not a primitive is a typed
  // action emitter.
  if (!toolName.startsWith('skill_')) return false
  const PRIMITIVE_NAMES = new Set([
    'skill_ask_user',
    'skill_run_shell',
    'skill_write_artifact',
    'skill_read_artifact',
    'skill_patch_config',
    'skill_start_detached',
    'skill_inspect_detached',
    'skill_cancel_detached',
    'skill_inspect_run_state',
  ])
  return !PRIMITIVE_NAMES.has(toolName)
}

export interface LoadSkillRunContractParams {
  scopeId?: string | null
  sessionId?: string | null
  skillId?: string | null
  outputDir?: string | null
  runStatePath?: string | null
  supervisorSnapshot?: SkillTaskSupervisorSnapshot | null
  /**
   * Sibling projection row found by `outputDir` / `runStatePath` lookup.
   * Wave 1 callers may pass null; Zeta wires sibling lookup in Wave 3.
   */
  projectionSibling?: TaskProjectionRecord | null
  /** Reference-skill hint (`rememberLastReferenceSkill`) for the session. */
  referenceHint?: ReferenceSkillHint | null
  /** Original user/source input the contract should preserve for rebuilds. */
  originalInput?: Record<string, unknown> | null
  /** Source URL extracted from the original request, when known. */
  sourceUrl?: string | null
  /** Tool name expected to fulfil the next forced action. */
  toolName?: string | null
  /** Validated typed action input the next force-tool dispatch may use. */
  actionInput?: Record<string, unknown> | null
  /** Job id (typed action wrapper sets this when known). */
  jobId?: string | null
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readStringField(
  source: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!source || typeof source !== 'object') return null
  const value = (source as Record<string, unknown>)[key]
  return trimmed(value)
}

function readObjectField(
  source: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  if (!source || typeof source !== 'object') return null
  const value = (source as Record<string, unknown>)[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function dedupePaths(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    const t = trimmed(v)
    if (!t || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}

function statusFromSupervisorSnapshot(
  snapshot: SkillTaskSupervisorSnapshot,
): SkillRunContract['status'] {
  switch (snapshot.status) {
    case 'running':
    case 'background_running':
      return 'running'
    case 'recoverable_paused':
    case 'budget_paused':
      return 'recoverable_paused'
    case 'blocked':
      return 'blocked'
    case 'done':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'failed'
    default:
      return 'unknown'
  }
}

function livenessFromSupervisorSnapshot(
  snapshot: SkillTaskSupervisorSnapshot | null | undefined,
): TurnFrame['liveness'] {
  if (!snapshot) return 'unknown'
  if (snapshot.status === 'done') return 'done'
  if (snapshot.status === 'failed') return 'failed'
  if (snapshot.hasLiveWork) return 'running_process'
  if (snapshot.hasRecentProgress) return 'recent_progress'
  if (snapshot.status === 'recoverable_paused' || snapshot.status === 'budget_paused') return 'recoverable_paused'
  if (snapshot.status === 'blocked') return 'blocked'
  return 'unknown'
}

function progressFromSnapshot(
  snapshot: SkillTaskSupervisorSnapshot | null | undefined,
): TurnFrame['progress'] {
  const p = snapshot?.progress || null
  return {
    stage: trimmed(p?.currentStage),
    totalUnits: typeof p?.totalScenes === 'number' ? p.totalScenes : null,
    completedUnits: typeof p?.completedScenes === 'number' ? p.completedScenes : null,
    coverageRatio: typeof p?.coverageRatio === 'number' ? p.coverageRatio : null,
    fingerprint: snapshot?.progressFingerprint || null,
  }
}

/**
 * Run-state JSON shape we care about. Only the fields the contract surfaces
 * are extracted; unknown / extra fields are tolerated. Field name aliases
 * mirror `skill-task-supervisor.ts::readRunStateInfo` so VEA's snake_case
 * vnext payload and any camelCase variants both work.
 */
interface ParsedRunState {
  status: string | null
  currentStage: string | null
  totalScenes: number | null
  completedScenes: number | null
  coverageRatio: number | null
}

function pickStringAlias(rec: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = rec[key]
    const t = trimmed(v)
    if (t) return t
  }
  return null
}

function pickNumberAlias(rec: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = rec[key]
    if (v === null || v === undefined) continue
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * Wave 3 (Zeta) — read `<outputDir>/run_state.json` and extract the
 * progress/status fields the contract surfaces. Failures (file missing,
 * unreadable, malformed JSON) return `null` — the caller falls back to
 * supervisor / projection signals.
 */
function readRunStateForContract(outputDir: string | null, runStatePath: string | null): {
  parsed: ParsedRunState
  resolvedPath: string | null
} | null {
  const candidatePath = trimmed(runStatePath) || (outputDir ? join(outputDir, 'run_state.json') : null)
  if (!candidatePath) return null
  let raw: string
  try {
    raw = readFileSync(candidatePath, 'utf-8')
  } catch {
    return null
  }
  let rec: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    rec = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const status = pickStringAlias(rec, ['status'])?.toLowerCase() || null
  const currentStage = pickStringAlias(rec, [
    'current_stage',
    'currentStage',
    'current_step',
    'currentStep',
  ])
  const totalScenes = pickNumberAlias(rec, ['total_scenes', 'totalScenes'])
  const completedScenes = pickNumberAlias(rec, ['completed_scenes', 'completedScenes'])
  const coverageRatio = pickNumberAlias(rec, ['coverage_ratio', 'coverageRatio'])
  return {
    parsed: {
      status,
      currentStage,
      totalScenes,
      completedScenes,
      coverageRatio,
    },
    resolvedPath: candidatePath,
  }
}

function statusFromRunStateString(status: string | null): SkillRunContract['status'] | null {
  if (!status) return null
  switch (status) {
    case 'running':
      return 'running'
    case 'recoverable_paused':
    case 'budget_paused':
    case 'paused':
      return 'recoverable_paused'
    case 'blocked':
      return 'blocked'
    case 'ready_to_resume':
      return 'ready_to_resume'
    case 'done':
    case 'completed':
      return 'completed'
    case 'failed':
    case 'error':
      return 'failed'
    case 'cancelled':
      return 'failed'
    default:
      return null
  }
}

/**
 * Build a fresh `SkillRunContract` as a read model over durable sources.
 *
 * Wave 1 minimum: synthesize from `SkillTaskSupervisorSnapshot` + projection
 * sibling row + reference-skill hint + caller-supplied original/typed input.
 * Returns `null` if there is not enough signal to anchor a real run
 * (no skillId AND no outputDir AND no taskRunId AND no detachedTaskId).
 *
 * Wave 3 (Zeta) — when `outputDir` (or `runStatePath`) is provided, the
 * loader also reads `<outputDir>/run_state.json` and uses any parsed
 * progress/status to fill fields the supervisor snapshot left empty.
 * Caller params and the snapshot still win; run_state is the lowest
 * priority source.
 */
export function loadSkillRunContract(
  params: LoadSkillRunContractParams,
): SkillRunContract | null {
  const snapshot = params.supervisorSnapshot || null
  const projection = params.projectionSibling || null
  const referenceHint = params.referenceHint || null

  const skillId = trimmed(params.skillId)
    || trimmed(snapshot?.skillId)
    || trimmed(referenceHint?.id)
  const outputDir = trimmed(params.outputDir) || trimmed(snapshot?.outputDir)
  const runStatePathInitial = trimmed(params.runStatePath) || trimmed(snapshot?.runStatePath)
  const taskRunId = trimmed(snapshot?.taskRunId)
  const detachedTaskId = trimmed(snapshot?.detachedTaskId)

  // Minimum anchoring signal: need at least one durable handle OR a
  // skillId + outputDir pair to build a meaningful contract.
  if (!skillId && !outputDir && !taskRunId && !detachedTaskId) {
    return null
  }

  // Wave 3 (Zeta) — read run_state.json once for the lowest-priority
  // progress/status fallback. Caller params and supervisor snapshot still
  // win; run_state only fills fields they left empty.
  const runStateRead = readRunStateForContract(outputDir, runStatePathInitial)
  const runState = runStateRead?.parsed ?? null
  const runStatePath = runStatePathInitial || runStateRead?.resolvedPath || null

  const skillName = trimmed(referenceHint?.name) || skillId

  const action = trimmed(snapshot?.action)
  const sceneScoresPath = trimmed(snapshot?.sceneScoresPath)
  const deliveryReportPath = trimmed(snapshot?.deliveryReportPath)

  const blockerReason = snapshot && Array.isArray(snapshot.blockers) && snapshot.blockers.length > 0
    ? trimmed(snapshot.blockers[0])
    : trimmed(snapshot?.pauseReason)

  // Status priority: explicit supervisor snapshot wins; otherwise fall back
  // to run_state.json's recovered status; otherwise 'unknown'.
  let status: SkillRunContract['status']
  if (snapshot) {
    status = statusFromSupervisorSnapshot(snapshot)
  } else {
    status = statusFromRunStateString(runState?.status ?? null) || 'unknown'
  }

  const projectionStableKey = projection
    ? trimmed(projection.taskId) || `${projection.scopeId}:${projection.module}:${projection.taskType}`
    : null

  const artifactRoots = dedupePaths([outputDir])

  // Wave 1 contract: action input is whatever the caller supplied (typed
  // action wrapper, restart fixture). Zeta will widen this in W3 by reading
  // <outputDir>/run_state.json. Wave 3 (Epsilon) note: when the supervisor
  // snapshot's `resumePayload` carries `actionInput` / `originalInput`
  // (typed action wrapper writes these so a paused skill can resume), the
  // loader prefers caller params and otherwise falls back to the payload —
  // strictly additive, no required-field changes.
  const resumePayloadActionInput = readObjectField(snapshot?.resumePayload, 'actionInput')
  const resumePayloadOriginalInput = readObjectField(snapshot?.resumePayload, 'originalInput')

  const actionInput = params.actionInput && Object.keys(params.actionInput).length > 0
    ? { ...params.actionInput }
    : resumePayloadActionInput && Object.keys(resumePayloadActionInput).length > 0
      ? { ...resumePayloadActionInput }
      : null

  const originalInput = params.originalInput && Object.keys(params.originalInput).length > 0
    ? { ...params.originalInput }
    : resumePayloadOriginalInput && Object.keys(resumePayloadOriginalInput).length > 0
      ? { ...resumePayloadOriginalInput }
      : null

  const sourceUrl = trimmed(params.sourceUrl)
    || trimmed(readStringField(snapshot?.resumePayload, 'sourceUrl'))
    || trimmed(readStringField(snapshot?.resumePayload, 'url'))
    || (resumePayloadOriginalInput
      ? trimmed(readStringField(resumePayloadOriginalInput, 'url'))
      : null)

  return {
    skillId: skillId || (skillName ?? '') || '',
    skillName,
    toolName: trimmed(params.toolName),
    action,
    actionInput,
    originalInput,
    sourceUrl,
    taskRunId,
    detachedTaskId,
    jobId: trimmed(params.jobId),
    outputDir,
    runStatePath,
    artifactRoots,
    artifactPaths: {
      sceneScoresPath,
      deliveryReportPath,
    },
    status,
    liveness: livenessFromSupervisorSnapshot(snapshot),
    progress: (() => {
      const fromSnapshot = progressFromSnapshot(snapshot)
      if (!runState) return fromSnapshot
      // Lowest priority — only fill when snapshot left the field empty.
      return {
        stage: fromSnapshot.stage ?? runState.currentStage,
        totalUnits: fromSnapshot.totalUnits ?? runState.totalScenes,
        completedUnits: fromSnapshot.completedUnits ?? runState.completedScenes,
        coverageRatio: fromSnapshot.coverageRatio ?? runState.coverageRatio,
        fingerprint: fromSnapshot.fingerprint,
      }
    })(),
    blocker: {
      reason: blockerReason,
      stale: Boolean(snapshot?.stale),
    },
    projectionIdentity: {
      stableKey: projectionStableKey,
      supersedesProjectionIds: [],
    },
    forceLoopGuard: {
      lastForceToolName: null,
      lastForceInputDigest: null,
      lastForceToolDispatchedAt: null,
      consecutiveForceCount: 0,
    },
    updatedAt: snapshot?.observedAt || new Date().toISOString(),
  }
}

/**
 * Helper that producer teams (Gamma + Delta) call to produce a consistent
 * `TurnFramePatch` carrying a `runContract` partial. The returned patch
 * also forwards `activeArtifactRoots` and `livenessHint` so the same
 * snapshot drives the durable run-time slots.
 *
 * The patch's `runContract` is treated as a partial: only fields that the
 * loader populated (non-null / non-empty) are emitted, so downstream
 * `mergeTurnFramePatches` can field-by-field merge with last-write-wins
 * across multiple producers in the same batch.
 */
export function buildContractFramePatch(
  snapshot: {
    contract: SkillRunContract | null
    activeArtifactRoots?: string[] | null
    livenessHint?: TurnFrame['liveness'] | null
    configValidation?: TurnFramePatch['configValidation']
  },
): TurnFramePatch {
  const patch: TurnFramePatch = {}
  const contract = snapshot.contract
  if (contract) {
    patch.runContract = {
      skillId: contract.skillId,
      skillName: contract.skillName,
      toolName: contract.toolName,
      action: contract.action,
      actionInput: contract.actionInput,
      originalInput: contract.originalInput,
      sourceUrl: contract.sourceUrl,
      taskRunId: contract.taskRunId,
      detachedTaskId: contract.detachedTaskId,
      jobId: contract.jobId,
      outputDir: contract.outputDir,
      runStatePath: contract.runStatePath,
      artifactRoots: [...(contract.artifactRoots || [])],
      artifactPaths: { ...contract.artifactPaths },
      status: contract.status,
      liveness: contract.liveness,
      progress: { ...contract.progress },
      blocker: { ...contract.blocker },
      projectionIdentity: {
        stableKey: contract.projectionIdentity.stableKey,
        supersedesProjectionIds: [...contract.projectionIdentity.supersedesProjectionIds],
      },
      forceLoopGuard: { ...contract.forceLoopGuard },
      updatedAt: contract.updatedAt,
    }
    const handles: NonNullable<TurnFramePatch['discoveredHandles']> = {}
    if (contract.taskRunId) handles.taskRunId = contract.taskRunId
    if (contract.detachedTaskId) handles.detachedTaskId = contract.detachedTaskId
    if (contract.runStatePath) handles.runStatePath = contract.runStatePath
    if (contract.outputDir) handles.outputDir = contract.outputDir
    if (contract.action) handles.action = contract.action
    if (Object.keys(handles).length > 0) {
      patch.discoveredHandles = handles
    }
  }

  const allRoots = dedupePaths([
    ...(Array.isArray(snapshot.activeArtifactRoots) ? snapshot.activeArtifactRoots : []),
    ...(contract?.artifactRoots || []),
  ])
  if (allRoots.length > 0) {
    patch.activeArtifactRoots = allRoots
  }

  if (snapshot.livenessHint) {
    patch.livenessHint = snapshot.livenessHint
  } else if (contract?.liveness && contract.liveness !== 'unknown') {
    patch.livenessHint = contract.liveness
  }

  if (snapshot.configValidation) {
    patch.configValidation = { ...snapshot.configValidation }
  }

  return patch
}
