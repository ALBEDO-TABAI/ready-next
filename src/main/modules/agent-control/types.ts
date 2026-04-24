export type ChannelAdapterType =
  | 'local-debug'
  | 'generic-webhook'
  | 'feishu-bot'
  | 'feishu-app'
  | 'telegram-bot'

export type ConversationSourceKind = 'local' | 'channel'

export type AgentTaskState =
  | 'queued'
  | 'planning'
  | 'tool_running'
  | 'responding'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface ChannelAttachment {
  name: string
  url?: string
  path?: string
  mimeType?: string
  size?: number
  type?: 'image' | 'video' | 'text' | 'spreadsheet' | 'other'
  ext?: string
  remoteId?: string
}

export interface ChannelEnvelope {
  id: string
  source: ChannelAdapterType | string
  thread: string
  sender: string
  text: string
  attachments: ChannelAttachment[]
  timestamp: string
  idempotencyKey: string
}

export interface AgentChannelConfig {
  id: string
  type: ChannelAdapterType
  name: string
  enabled: boolean
  config: Record<string, unknown>
  lastError?: string | null
  lastSeenAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface CronTask {
  id: string
  name: string
  cronExpr: string
  prompt: string
  channelId?: string | null
  enabled: boolean
  payload?: Record<string, unknown>
  lastRunAt?: string | null
  nextRunAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface HeartbeatComponentSnapshot {
  healthy: boolean
  lastBeatAt?: string
  error?: string
}

export interface HeartbeatSnapshot {
  sidecar: {
    status: 'starting' | 'running' | 'stopped' | 'error'
    pid?: number
    port?: number
    lastBeatAt?: string
    error?: string
  }
  adapters: Array<
    HeartbeatComponentSnapshot & {
      id: string
      type: ChannelAdapterType
      status?: 'starting' | 'running' | 'stopped' | 'error'
    }
  >
  orchestrator: HeartbeatComponentSnapshot & { activeTasks: number }
  toolGateway: HeartbeatComponentSnapshot & { availableTools: number }
}

export interface AgentRuntimeStatus {
  orchestrator: 'claude-sdk'
  sidecarEnabled: boolean
  sidecar: HeartbeatSnapshot['sidecar']
  channels: {
    total: number
    enabled: number
    connected: number
    errors: number
    byType: Record<string, number>
  }
  schedules: {
    total: number
    enabled: number
  }
  heartbeat: HeartbeatSnapshot
}

export interface ConversationScope {
  id: string
  agent: string
  userId?: string
  title: string
  parentConversationId?: string | null
  lineageRootId?: string | null
  resumeTitle?: string | null
  sourceKind: ConversationSourceKind
  sourceId: string
  threadKey: string
  meta: Record<string, unknown>
  createdAt: string
  updatedAt: string
  lastMessageAt?: string | null
}

export interface ConversationScopeMessage {
  id: string
  conversationId: string
  role: string
  content: string
  timestamp: string
  meta: Record<string, unknown>
}

export interface ConversationEventPayload {
  type: 'scope_created' | 'scope_updated' | 'message_added'
  scope: ConversationScope
  message?: ConversationScopeMessage
}

export interface ConversationAttachment {
  attachmentId: string
  scopeId: string
  sourceMessageId: string
  name: string
  path: string
  type: 'image' | 'video' | 'text' | 'spreadsheet' | 'other'
  size: number
  ext: string
  url?: string | null
  mimeType?: string | null
  remoteId?: string | null
  channelId?: string | null
  threadKey?: string | null
  createdAt: string
}

export interface ScopeRunTraceItem {
  id: string
  kind: 'call' | 'result'
  text: string
  timestamp: string
}

export type ScopeRunMemorySourceType =
  | 'resident_agent'
  | 'resident_user'
  | 'scope_memory'
  | 'trigger_rule'
  | 'session_recall'

export interface ScopeRunMemoryRef {
  id: string
  layer: 'l0' | 'l1' | 'l2' | 'recall'
  sourceType: ScopeRunMemorySourceType
  title: string
  summary?: string | null
  path?: string | null
  triggerId?: string | null
  sensitive?: boolean
  loadedAt: string
}

export interface ScopeRunTriggerHit {
  id: string
  label: string
  module?:
    | 'browser'
    | 'document'
    | 'design'
    | 'skill'
    | 'video'
    | 'rss'
    | 'calendar'
    | 'feishu'
    | 'system'
  blocking: boolean
  refs: string[]
}

export interface ScopeRunContextBudget {
  totalChars: number
  l0Chars: number
  l1Chars: number
  l2Chars: number
  droppedRefs: string[]
}

export type ScopeRunTaskStepStatus = 'pending' | 'running' | 'blocked' | 'done' | 'error'
export type ScopeRunWaitingFor =
  | 'input'
  | 'confirmation'
  | 'agent_result'
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
  executionId: string
  stepId?: string | null
  blockerType?: string | null
  targetUrl?: string | null
}

export interface ScopeRunMemoryCaptureItem {
  memoryId: string
  category: 'user_preference' | 'summary'
  sourceType: Exclude<ScopeRunMemorySourceType, 'session_recall'>
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
  taskBudgetRuntime?: import('./run-contracts').TaskBudgetRuntime | null
  compression?: {
    historyCompressed: boolean
    toolTraceCompressed: boolean
    artifactSummaryUsed: boolean
  } | null
  budget?: {
    maxIterations?: number
    maxToolCalls?: number
    maxParallelToolGroups?: number
    reservedToolCalls?: number
    iterationsUsed?: number
    toolCallsUsed?: number
    parallelToolGroupsUsed?: number
  } | null
  fallback?: {
    happened: boolean
    kind: string
    attempts: number
  } | null
  toolSnapshots?: import('./run-contracts').ToolSnapshot[] | null
  toolResolution?: import('./run-contracts').ToolResolutionDiagnostics | null
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
  continuationBudgetRestore?: {
    inheritedBudget: boolean
    restoredUsage: boolean
    grantedIterationSafetyFloor: boolean
    grantedToolCallSafetyFloor: boolean
  } | null
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

export interface ScopeRunSummary {
  scopeId: string
  agent: string
  title: string
  sourceKind: ConversationSourceKind
  sourceId: string
  channelKey: string
  threadKey: string
  phase: ScopeRunEventPayload['phase']
  taskId?: string | null
  parentTaskId?: string | null
  parentStepId?: string | null
  taskTitle?: string | null
  taskSummary?: string | null
  taskType?: 'direct_answer' | 'short_task' | 'multi_step_task' | 'media_task' | 'continuation'
  interactionState?:
    | 'running'
    | 'awaiting_clarification'
    | 'awaiting_confirmation'
    | 'human_takeover'
    | 'suspended'
    | 'resuming'
  steps?: ScopeRunTaskStep[]
  currentStepId?: string | null
  waitingFor?: ScopeRunWaitingFor
  resumableActions?: ScopeRunResumableAction[]
  recentArtifacts?: ScopeRunEventPayload['artifactRefs']
  taskContinuation?: ScopeRunTaskContinuation | null
  memoryCapture?: ScopeRunMemoryCapture | null
  executionDiagnostics?: ScopeRunExecutionDiagnostics | null
  budgetUsagePercent?: number | null
  recoveryHistory?: ScopeRunExecutionDiagnostics['recoveryHistory']
  degradationReason?: string | null
  stepBudget?: ScopeRunExecutionDiagnostics['stepBudget']
  budgetWarningLevel?: ScopeRunExecutionDiagnostics['budgetWarningLevel']
  taskProjectionId?: string | null
  blockedReason?: string | null
  error?: string | null
  updatedAt: string
}

export interface ScopeRunEventPayload {
  type: 'started' | 'updated' | 'finished'
  scopeId: string
  agent: string
  runId?: string
  taskId?: string
  parentTaskId?: string
  parentStepId?: string
  phase:
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
  latestText?: string
  module?:
    | 'browser'
    | 'document'
    | 'design'
    | 'skill'
    | 'video'
    | 'rss'
    | 'calendar'
    | 'feishu'
    | 'system'
  intent?: string
  executionKind?: 'deterministic' | 'interactive' | 'job' | 'pipeline'
  jobId?: string
  artifactRefs?: Array<{
    id: string
    module: string
    kind: string
    label: string
    path?: string | null
    url?: string | null
    mimeType?: string | null
    sourceRunId?: string | null
    createdAt: string
    meta?: Record<string, unknown>
  }>
  memoryRefs?: ScopeRunMemoryRef[]
  triggerHits?: ScopeRunTriggerHit[]
  contextBudget?: ScopeRunContextBudget | null
  ownerResourceId?: string
  lastEvidenceAt?: string
  toolEvent?: ScopeRunTraceItem
  error?: string
  /** Phase 3: structured error classification surfaced at the agent:error boundary. */
  errorKind?: string
  /** Phase 3: true when the error should be shown as a soft-failure capsule (no system message). */
  recoverable?: boolean
  /** Phase 3: attached tool name (when the error originated from a tool host). */
  toolName?: string
  blockedReason?: string | null
  controllerId?: string
  ownerTabId?: string
  checkpointExpiresAt?: number
  taskTitle?: string
  taskSummary?: string
  taskType?: 'direct_answer' | 'short_task' | 'multi_step_task' | 'media_task' | 'continuation'
  interactionState?:
    | 'running'
    | 'awaiting_clarification'
    | 'awaiting_confirmation'
    | 'human_takeover'
    | 'suspended'
    | 'resuming'
  steps?: ScopeRunTaskStep[]
  currentStepId?: string | null
  waitingFor?: ScopeRunWaitingFor
  resumableActions?: ScopeRunResumableAction[]
  budgetUsagePercent?: number
  recoveryHistory?: ScopeRunExecutionDiagnostics['recoveryHistory']
  degradationReason?: string
  stepBudget?: ScopeRunExecutionDiagnostics['stepBudget']
  budgetWarningLevel?: ScopeRunExecutionDiagnostics['budgetWarningLevel']
  taskProjectionId?: string
  recentArtifacts?: Array<{
    id: string
    module: string
    kind: string
    label: string
    path?: string | null
    url?: string | null
    mimeType?: string | null
    sourceRunId?: string | null
    createdAt: string
    meta?: Record<string, unknown>
  }>
  taskContinuation?: ScopeRunTaskContinuation | null
  memoryCapture?: ScopeRunMemoryCapture | null
  executionDiagnostics?: ScopeRunExecutionDiagnostics | null
  stepMetrics?: {
    toolCalls: number
    toolResults: number
    lastToolAt: string | null
  }
  timestamp: string
}

export interface SidecarStatus {
  state: 'starting' | 'running' | 'stopped' | 'error'
  host: string
  port: number | null
  pid: number | null
  startedAt: string | null
  lastHeartbeatAt: string | null
  error: string | null
}
