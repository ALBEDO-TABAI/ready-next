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
import type { CapabilityGroupId } from '../../../shared/ai-capability-groups'
import type { AIModelConfig } from '../../../shared/ai-providers'

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
}

export interface ExecutionTurnResult {
  success: boolean
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
  | 'budget_exhausted'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'

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
