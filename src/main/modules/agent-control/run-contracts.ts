import type {
  ConversationScope,
  ScopeRunMemoryCapture,
  ScopeRunResumableAction,
  ScopeRunTaskContinuation,
  ScopeRunTaskStep,
} from './types'
import type { IntentClassification } from './intent-classifier'
import type { PromptAssemblyResult } from './prompt-assembly'
import type { RequestEnvelope } from './request-envelope'
import type { CapabilityGroupId } from '../../../shared/ai-capability-groups'

export interface RunMessageBlock {
  type: string
  text?: string
  base64?: string
  mimeType?: string
}

export type RunMessage = string | RunMessageBlock[]

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
}

export interface TaskBudget {
  taskType: TaskType
  maxIterations: number
  maxToolCalls: number
  maxParallelToolGroups: number
  stepBudget?: {
    maxIterations: number
    remainingIterations?: number
  } | null
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
  taskType: TaskType
  module: string
  status: UnifiedTaskState['status']
  interactionState: TaskInteractionState
  steps: TaskStep[]
  currentStepId?: string | null
  budget?: TaskBudget | null
  budgetUsagePercent?: number | null
  recoveryHistory?: RecoveryRecord[]
  blockedReason?: string | null
  resumableActions?: ScopeRunResumableAction[]
  continuationRef?: ScopeRunTaskContinuation | null
  createdAt: string
  updatedAt: string
}

export interface TaskProjectionStore {
  create(record: TaskProjectionRecord): void | Promise<void>
  update(taskId: string, patch: Partial<TaskProjectionRecord>): void | Promise<void>
  get(taskId: string): TaskProjectionRecord | null | Promise<TaskProjectionRecord | null>
  listByScope(scopeId: string): TaskProjectionRecord[] | Promise<TaskProjectionRecord[]>
}

export interface RunBudgetSeed {
  maxIterations: number
  maxToolCalls: number
  maxParallelToolGroups: number
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
  compression?: {
    historyCompressed: boolean
    toolTraceCompressed: boolean
    artifactSummaryUsed: boolean
  } | null
  budget?: Partial<RunBudgetSeed & RunBudgetUsage> | null
  stepBudget?: {
    maxIterations?: number
    remainingIterations?: number
  } | null
  budgetUsagePercent?: number | null
  fallback?: {
    happened: boolean
    kind: string
    attempts: number
  } | null
  recoveryHistory?: RecoveryRecord[] | null
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
  budget?: RunBudgetSeed
}

export interface RunCoordinatorResult {
  success: boolean
  error?: string
}

export interface ExecutionHostRequest {
  agent: string
  sessionId?: string
  requestId?: string
  systemPrompt?: string
  message: RunMessage
  requestEnvelope?: RequestEnvelope
  intentClassification?: IntentClassification
  budget?: RunBudgetSeed
  budgetState?: RunBudgetUsage
}

export interface ExecutionHostResult {
  success: boolean
  finalText: string
  cancelled: boolean
  usedTools: string[]
  error?: string
  budgetState?: RunBudgetUsage
  taskType?: TaskType
  interactionState?: TaskInteractionState
  taskProjectionId?: string | null
  executionDiagnostics?: ExecutionRunDiagnostics | null
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
  waitingFor?: 'input' | 'confirmation' | 'agent_result' | 'background' | 'none'
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
