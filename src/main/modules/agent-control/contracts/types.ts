import type { TurnTerminalReason } from '../runtime-core/turn-frame'
import type { TaskType } from '../../../../shared/task-types'
import type { ContextUsageSnapshot } from '../../../../shared/context-usage-types'
import type { ProductTurnReceipt } from '../../../../shared/ipc-contracts/agent-runtime'

export type ChannelAdapterType =
  | 'local-debug'
  | 'generic-webhook'
  | 'feishu-bot'
  | 'feishu-app'
  | 'telegram-bot'
  | 'wechat-openclaw'

export type ConversationSourceKind = 'local' | 'channel'

export type AgentTaskState =
  | 'queued'
  | 'planning'
  | 'tool_running'
  | 'responding'
  | 'done'
  | 'failed'
  | 'cancelled'
  // `closed` retires the conversation alias. Turn-terminal states such as
  // done/failed/cancelled remain reusable for a later native turn.
  | 'closed'

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

export type AgentRuntimeKernel = 'codex-native'

export interface AgentRuntimeStatus {
  orchestrator: AgentRuntimeKernel
  sidecarEnabled: boolean
  sidecar: HeartbeatSnapshot['sidecar']
  channels: {
    total: number
    enabled: number
    connected: number
    errors: number
    byType: Record<string, number>
  }
  heartbeat: HeartbeatSnapshot
}

export interface ConversationScope {
  id: string
  aliasGeneration: number | null
  latestAliasGeneration?: number | null
  messageVisibilityEpoch: number
  agent: string
  activeAgentId: string
  handoffGeneration: number
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
  /** 工具名（activity-capsule L3 详情标题；SDK executor 事件携带）。 */
  toolName?: string
  /**
   * L3 详情：call = 过滤秘密键后的入参 JSON，result = 脱敏输出全文。由
   * `tool-trace-detail.ts` 构建（截断/上限在构建侧强制），仅在比 `text`
   * 预览多出信息时携带。
   */
  detail?: string
}

export interface ScopeRunActivityNarration {
  itemId: string
  source: 'commentary' | 'reasoning_summary'
  text: string
  status: 'streaming' | 'completed'
}

export type ScopeRunTaskStepStatus = 'pending' | 'running' | 'blocked' | 'done' | 'error'
export type ScopeRunWaitingFor =
  | 'input'
  | 'confirmation'
  | 'agent_result'
  | 'clarification'
  | 'background'
  | 'verification'
  | 'none'
export type ScopeRunResumableAction = 'continue' | 'retry' | 'open_artifact' | 'cancel' | 'none'

export interface ScopeRunTaskStep {
  id: string
  title: string
  status: ScopeRunTaskStepStatus
  detail?: string | null
  updatedAt: string
}

export type ScopeRunResumeKind = 'snapshot' | 'paused' | 'done_residual'

export interface ScopeRunTaskContinuation {
  kind?: string | null
  checkpointId?: string | null
  browserTaskId?: string | null
  suspensionReason?: string | null
  suspensionRequest?: import('../../../../shared/browser-workflow-control').BrowserConfirmationSuspensionRequest | null
  taskId?: string | null
  executionId?: string | null
  stepId?: string | null
  resumeKind?: ScopeRunResumeKind | null
  blockerType?: string | null
  targetUrl?: string | null
  todoId?: string | null
  todoTitle?: string | null
  pauseReason?: string | null
  childRunId?: string | null
  detachedTaskId?: string | null
  taskRunId?: string | null
  jobId?: string | null
  skillId?: string | null
  action?: string | null
  runStatePath?: string | null
  outputDir?: string | null
  progressFingerprint?: string | null
  progress?: ScopeRunSkillProgress | null
}

export interface ScopeRunSkillProgress {
  stage: string | null
  completed: number | null
  total: number | null
  coverage: number | null
  overallCoverage?: number | null
  fingerprint: string | null
  updatedAt: string | null
  lastError: string | null
  detail?: string | null
  activityUpdatedAt?: string | null
  handoff?: ScopeRunSkillHandoff | null
}

export interface ScopeRunSkillHandoff {
  status: 'pending' | 'in_progress' | 'pending_retry' | 'blocked' | 'failed' | 'completed'
  kind: 'audiovisual_report' | 'generic'
  taskName: string
  userMessage: string
  actionLabel: string
  attemptCount: number
  lastErrorKind: string | null
  lastErrorMessage: string | null
  taskPath: string | null
  outputPath: string | null
  updatedAt: string | null
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
  contextUsage?: ContextUsageSnapshot | null
  budgetLease?: import('./run-contracts').ExecutionRunDiagnostics['budgetLease']
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
    grantedStepBudgetSafetyFloor: boolean
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
  aliasGeneration?: number | null
  messageVisibilityEpoch?: number
  visibilityOwnerKind?: 'product_alias' | 'context_background'
  agent: string
  title: string
  sourceKind: ConversationSourceKind
  sourceId: string
  channelKey: string
  threadKey: string
  phase: ScopeRunEventPayload['phase']
  runId?: string | null
  taskId?: string | null
  parentTaskId?: string | null
  parentStepId?: string | null
  taskTitle?: string | null
  taskSummary?: string | null
  taskType?: TaskType
  interactionState?:
    | 'running'
    | 'awaiting_clarification'
    | 'awaiting_confirmation'
    | 'human_takeover'
    | 'suspended'
    | 'resuming'
    | 'check_in_pending'
  steps?: ScopeRunTaskStep[]
  currentStepId?: string | null
  waitingFor?: ScopeRunWaitingFor
  resumableActions?: ScopeRunResumableAction[]
  recentArtifacts?: ScopeRunEventPayload['artifactRefs']
  taskContinuation?: ScopeRunTaskContinuation | null
  progress?: ScopeRunSkillProgress | null
  executionDiagnostics?: ScopeRunExecutionDiagnostics | null
  contextUsage?: ContextUsageSnapshot | null
  budgetUsagePercent?: number | null
  recoveryHistory?: ScopeRunExecutionDiagnostics['recoveryHistory']
  degradationReason?: string | null
  stepBudget?: ScopeRunExecutionDiagnostics['stepBudget']
  budgetWarningLevel?: ScopeRunExecutionDiagnostics['budgetWarningLevel']
  taskProjectionId?: string | null
  blockedReason?: string | null
  error?: string | null
  terminalReason?: TurnTerminalReason | null
  updatedAt: string
}

export interface ScopeRunEventPayload {
  type: 'started' | 'updated' | 'finished'
  scopeId: string
  aliasGeneration?: number | null
  messageVisibilityEpoch?: number
  visibilityOwnerKind?: 'product_alias' | 'context_background'
  visibilityOwnerLedger?: {
    kind: 'run_meta' | 'skill_task_run' | 'task_projection'
    id: string
  }
  agent: string
  ownerAgentId?: string | null
  taskOrigin?: import('../../../../shared/agent-execution-profile').TaskCreationOrigin
  executionBinding?: import('../../../../shared/agent-execution-profile').TaskExecutionBinding | null
  executionAgentDisplayName?: string | null
  handoffGeneration?: number
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
  terminalReason?: TurnTerminalReason | null
  productTurnReceipt?: ProductTurnReceipt
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
    | 'research'
    | 'map'
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
  contextUsage?: ContextUsageSnapshot | null
  ownerResourceId?: string
  lastEvidenceAt?: string
  toolEvent?: ScopeRunTraceItem
  activityNarration?: ScopeRunActivityNarration | null
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
  taskType?: TaskType
  interactionState?:
    | 'running'
    | 'awaiting_clarification'
    | 'awaiting_confirmation'
    | 'human_takeover'
    | 'suspended'
    | 'resuming'
    | 'check_in_pending'
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
  progress?: ScopeRunSkillProgress | null
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
