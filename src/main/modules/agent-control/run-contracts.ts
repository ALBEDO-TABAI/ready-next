import type {
  ConversationScope,
  ScopeRunMemoryCapture,
  ScopeRunResumableAction,
  ScopeRunTaskContinuation,
  ScopeRunTaskStep,
} from './types'
import type { PromptAssemblyResult } from './prompt-assembly'
import type { CapabilityGroupId } from '../../../shared/ai-capability-groups'

export interface RunMessageBlock {
  type: string
  text?: string
  base64?: string
  mimeType?: string
}

export type RunMessage = string | RunMessageBlock[]

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
  fallback?: {
    happened: boolean
    kind: string
    attempts: number
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
