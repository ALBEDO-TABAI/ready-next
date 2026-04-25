// Legacy design types (design mode removed)
type DesignLayoutBounds = { x: number; y: number; w: number; h: number }
type DesignLayoutDigest = Record<string, unknown>
type DesignRepairScope = 'run-owned' | 'selected'
type DesignControllerPhase = string
type DesignStyleSystem = Record<string, unknown>

export interface AgentMessage {
  id: string
  agent: string
  content: string
  type: 'user' | 'agent' | 'system'
  timestamp: Date
  attachments?: ChatAttachment[]
  meta?: Record<string, unknown>
}

export interface Agent {
  name: string
  displayName: string
  avatar: string
  status: 'idle' | 'working' | 'done' | 'error' | 'cancelled'
  selected: boolean
}

export interface ChatAttachment {
  id: string
  name: string
  path: string
  type: 'image' | 'video' | 'text' | 'spreadsheet' | 'other'
  isDirectory?: boolean
  size: number
  ext: string
  source?:
    | 'file'
    | 'browser-tab'
    | 'skill-folder'
    | 'design-project'
    | 'document-quote'
    | 'document-widget-target'
    | 'channel'
  browserTabId?: string
  url?: string
  title?: string
  documentTitle?: string
  tabId?: string
  widgetTitle?: string
  widgetId?: string
  widgetCode?: string
  widgetMode?: string
  heading?: string
  selection?: string
  lineStart?: number
  lineEnd?: number
  sectionTitle?: string
  excerpt?: string
  capturedAt?: number
  skillId?: string
  skillFolderPath?: string
  dirty?: boolean
  saveStatus?: string
  snapshotHash?: string
  selectionSummary?: string
  selectedElementCount?: number
  selectionBounds?: DesignLayoutBounds | null
  currentToolContext?: string
  layoutDigest?: DesignLayoutDigest
  latestReviewSummary?: string
  repairScope?: DesignRepairScope
}

export interface ChatConversation {
  id: string
  agent: string
  title: string
  created_at: string
  updated_at: string
}

export interface ConversationScope {
  id: string
  agent: string
  title: string
  parentConversationId?: string | null
  lineageRootId?: string | null
  resumeTitle?: string | null
  sourceKind: 'local' | 'channel'
  sourceId: string
  threadKey: string
  meta: Record<string, unknown>
  createdAt: string
  updatedAt: string
  lastMessageAt?: string | null
}

export interface ToolTraceEvent {
  id: string
  kind: 'call' | 'result'
  text: string
  timestamp: Date
}

export type AgentModuleKind =
  | 'browser'
  | 'document'
  | 'design'
  | 'skill'
  | 'video'
  | 'rss'
  | 'calendar'
  | 'feishu'
  | 'system'
export type ModuleExecutionKind = 'deterministic' | 'interactive' | 'job' | 'pipeline'
export type AgentMemoryLayer = 'l0' | 'l1' | 'l2' | 'recall'
export type AgentMemorySourceType =
  | 'resident_agent'
  | 'resident_user'
  | 'scope_memory'
  | 'trigger_rule'
  | 'session_recall'

export interface AgentMemoryRef {
  id: string
  layer: AgentMemoryLayer
  sourceType: AgentMemorySourceType
  title: string
  summary?: string | null
  path?: string | null
  triggerId?: string | null
  sensitive?: boolean
  loadedAt: string
}

export interface AgentTriggerHit {
  id: string
  label: string
  module?: AgentModuleKind | null
  blocking: boolean
  refs: string[]
}

export interface AgentContextBudget {
  totalChars: number
  l0Chars: number
  l1Chars: number
  l2Chars: number
  droppedRefs: string[]
}

export interface AgentArtifact {
  id: string
  module: AgentModuleKind
  kind: string
  label: string
  path?: string | null
  url?: string | null
  mimeType?: string | null
  sourceRunId?: string | null
  createdAt: string
  meta?: Record<string, unknown>
}

export type ScopeRunTaskStepStatus = 'pending' | 'running' | 'blocked' | 'done' | 'error'
export type ScopeRunWaitingFor =
  | 'input'
  | 'confirmation'
  | 'agent_result'
  // B Phase 1 PR2 T1-8: primitive_ask_user → 'clarification' — drives the
  // SkillAskUserPrompt capsule.
  | 'clarification'
  | 'background'
  | 'none'
export type ScopeRunResumableAction = 'continue' | 'retry' | 'open_artifact' | 'cancel' | 'none'

export interface ScopeRunTaskStep {
  id: string
  title: string
  status: ScopeRunTaskStepStatus
  detail?: string | null
  updatedAt: string
}

export interface ScopeRunTaskContinuation {
  taskId?: string | null
  // Phase 4: executionId is optional — the skill_executions state machine is
  // retired, so skill-sourced continuations no longer carry an executionId.
  // Kept optional for backward compatibility with other continuation sources.
  executionId?: string | null
  stepId?: string | null
  blockerType?: string | null
  targetUrl?: string | null
}

export interface ScopeRunMemoryCaptureItem {
  memoryId: string
  category: 'user_preference' | 'summary'
  sourceType: Exclude<AgentMemorySourceType, 'session_recall'>
  title: string
  summary?: string | null
}

export interface ScopeRunMemoryCapture {
  status: 'ready' | 'dismissed' | 'reverted'
  createdAt: string
  note?: string | null
  items: ScopeRunMemoryCaptureItem[]
}

export interface ScopeRunExecutionDiagnostics {
  taskId?: string | null
  compression?: {
    historyCompressed: boolean
    toolTraceCompressed: boolean
    artifactSummaryUsed: boolean
  } | null
  budget?: {
    maxIterations?: number
    maxToolCalls?: number
    maxParallelToolGroups?: number
    iterationsUsed?: number
    toolCallsUsed?: number
    parallelToolGroupsUsed?: number
  } | null
  stepBudget?: {
    stepId?: string | null
    maxIterations?: number
    remainingIterations?: number
  } | null
  budgetUsagePercent?: number | null
  budgetWarningLevel?: 'none' | 'warning' | 'converge' | 'exhausted' | null
  recoveryHistory?: Array<{
    kind: string
    source: string
    message: string
    attempt: number
    recovered: boolean
    timestamp: string
  }> | null
  degradationReason?: string | null
  fallback?: {
    happened: boolean
    kind: string
    attempts: number
  } | null
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

export interface ScopeRunStepMetrics {
  toolCalls: number
  toolResults: number
  lastToolAt: string | null
}

/**
 * Phase 3 — soft-failure capsule payload carried on ScopeRunState.softError.
 *
 * Populated when agent:error arrives with recoverable=true. Capsule UI reads
 * this slot; dismissing the capsule sets it back to null. Terminal errors
 * also set it to null (they take the system-message path instead).
 */
export interface SoftErrorInfo {
  message: string
  errorKind: string
  toolName: string | null
  receivedAt: string
}

export interface ScopeRunState {
  scopeId: string
  agent: string
  requestId: string | null
  taskId?: string | null
  phase:
    | 'idle'
    | 'queued'
    | 'planning'
    | 'tool_running'
    | 'checkpoint'
    | 'takeover'
    | 'resuming'
    | 'responding'
    | 'done'
    | 'error'
    | 'cancelled'
  toolTrace: ToolTraceEvent[]
  startedAt: string | null
  updatedAt: string | null
  latestText?: string | null
  module?: AgentModuleKind | null
  intent?: string | null
  executionKind?: ModuleExecutionKind | null
  jobId?: string | null
  artifactRefs?: AgentArtifact[]
  memoryRefs?: AgentMemoryRef[]
  triggerHits?: AgentTriggerHit[]
  contextBudget?: AgentContextBudget | null
  ownerResourceId?: string | null
  lastEvidenceAt?: string | null
  blockedReason?: string | null
  controllerId?: string | null
  ownerTabId?: string | null
  checkpointExpiresAt?: number | null
  responseMessageId?: string | null
  responseBuffer?: string
  responseSegmentBreakPending?: boolean
  responseSegmentToolTraceStart?: number | null
  stepMetrics?: ScopeRunStepMetrics
  error?: string | null
  /** Phase 3: soft-failure capsule state; null means no capsule is shown. */
  softError?: SoftErrorInfo | null
  designPhase?: DesignControllerPhase | null
  designTodo?: Array<{
    id: string
    title: string
    status: 'pending' | 'running' | 'done' | 'error'
  }>
  designReviewSummary?: string | null
  ownedNodeIds?: string[]
  repairScope?: DesignRepairScope | null
  scenePlanId?: string | null
  boardId?: string | null
  styleSystem?: DesignStyleSystem | null
  reviewFailures?: string[]
  lastAcceptedScreenshot?: string | null
  taskTitle?: string | null
  taskSummary?: string | null
  steps?: ScopeRunTaskStep[]
  currentStepId?: string | null
  waitingFor?: ScopeRunWaitingFor
  resumableActions?: ScopeRunResumableAction[]
  recentArtifacts?: AgentArtifact[]
  taskContinuation?: ScopeRunTaskContinuation | null
  memoryCapture?: ScopeRunMemoryCapture | null
  executionDiagnostics?: ScopeRunExecutionDiagnostics | null
}

export interface AttachmentPreviewState {
  attachment: ChatAttachment
  mode: 'image' | 'video' | 'text' | 'file'
  content?: string
  error?: string | null
}
