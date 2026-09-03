// Legacy design types (design mode removed)
import type { ContextUsageSnapshot } from '../../../shared/context-usage-types'

type DesignLayoutBounds = { x: number; y: number; w: number; h: number }
type DesignLayoutDigest = Record<string, unknown>
type DesignRepairScope = 'run-owned' | 'selected'
type DesignControllerPhase = string
type DesignStyleSystem = Record<string, unknown>

export interface AskUserQuestionsCardState {
  cardId: string
  status: 'pending' | 'submitted' | 'cancelled' | 'timeout'
  questions: Array<{
    id: string
    question: string
    kind: 'single_choice' | 'multi_choice' | 'free_text'
    options?: string[] | null
    placeholder?: string | null
    required?: boolean
  }>
  askedAt: number
  answers?: Array<{ id: string; answer: string | string[] }>
  answeredAt?: number
  cancelReason?: string
  cancelledAt?: number
  /**
   * Stage U (PR 1, B.5) — renderer-only flag set when sendMessage's pre-send
   * cancel hook timed out (2s). The card stays `status:'pending'` but submit
   * is disabled and a "取消处理中…" hint shows so the user can't double-submit
   * while the in-flight cancel races behind the scenes. Never persisted —
   * absent in `meta_json.askUserQuestions`. Once the late cancel actually
   * lands, the normal cancel flow flips status to 'cancelled' and this flag
   * becomes moot.
   */
  localDisabled?: boolean
}

export interface AgentMessage {
  id: string
  agent: string
  content: string
  type: 'user' | 'agent' | 'system' | 'ask_user_questions'
  timestamp: Date
  attachments?: ChatAttachment[]
  meta?: Record<string, unknown>
  /**
   * Populated when `type === 'ask_user_questions'`. The chat panel renders
   * `AskUserQuestionsCard` for these messages and persistence (DB
   * meta_json.askUserQuestions) matches this shape.
   */
  askUserQuestions?: AskUserQuestionsCardState
}

export interface Agent {
  name: string
  displayName: string
  avatar: string
  status: 'idle' | 'working' | 'done' | 'error' | 'cancelled'
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
    | 'document-tab'
    | 'document-quote'
    | 'document-widget-target'
    | 'calendar-event'
    | 'rss-item'
    | 'rss-source'
    | 'mcp-resource'
    | 'channel'
    | 'generated-image'
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
  eventId?: string
  rssItemId?: string
  rssSourceId?: string
  mcpServerId?: string
  mcpResourceUri?: string
  mcpCatalogGeneration?: number
  mcpCatalogDigest?: string
  mcpContentDigest?: string
  startTime?: string
  endTime?: string
  calendarId?: string
  description?: string
  location?: string
  allDay?: boolean
  contentType?: string
  platform?: string[] | string
  publishStatus?: string
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
  aliasGeneration: number | null
  latestAliasGeneration?: number | null
  messageVisibilityEpoch: number
  agent: string
  activeAgentId: string
  handoffGeneration: number
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
  /** 工具名（SDK executor 事件携带；orchestrator 输出流事件缺省）。 */
  toolName?: string
  /** 仅供活动分类，不在展开详情中直接显示内部工具名。 */
  hideToolName?: boolean
  /** L3 详情：call = 入参 JSON 预览，result = 输出全文（main 侧已脱敏截断）。 */
  detail?: string
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
  | 'research'
  | 'map'
  | 'system'
export type ModuleExecutionKind = 'deterministic' | 'interactive' | 'job' | 'pipeline'
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

export interface ScopeRunTaskContinuation {
  kind?: string | null
  checkpointId?: string | null
  browserTaskId?: string | null
  suspensionReason?: string | null
  suspensionRequest?: import('../../../shared/browser-workflow-control').BrowserConfirmationSuspensionRequest | null
  taskId?: string | null
  // Phase 4: executionId is optional — the skill_executions state machine is
  // retired, so skill-sourced continuations no longer carry an executionId.
  // Kept optional for backward compatibility with other continuation sources.
  executionId?: string | null
  stepId?: string | null
  resumeKind?: 'snapshot' | 'paused' | 'done_residual' | null
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
  budgetLease?: {
    leaseId: string
    decision: 'active' | 'renew' | 'pause' | 'handoff_background' | 'close'
    reason: string | null
    renewalsUsed: number
    progressScore: number
    wasteScore: number
    lastFingerprint: string | null
    currentLeaseEndIteration: number
  } | null
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
  contextUsage?: ContextUsageSnapshot | null
}

export interface ScopeRunStepMetrics {
  toolCalls: number
  toolResults: number
  lastToolAt: string | null
}

export interface ScopeRunActivityNarration {
  itemId: string
  source: 'commentary' | 'reasoning_summary'
  text: string
  status: 'streaming' | 'completed'
}

export type ScopeRunTerminalReason =
  | 'done'
  | 'checkpoint_budget'
  | 'checkpoint_incomplete'
  | 'checkpoint_background'
  | 'checkpoint_user_input'
  | 'manual_suspend'
  | 'blocked_config'
  | 'blocked_external'
  | 'blocked_tool_error'
  | 'delivery_failed'
  | 'tool_unavailable'
  | 'no_artifact'
  | 'proof_gap'
  | 'adjudication_degraded'
  | 'browser_transaction_unconfirmed'
  | 'failed_skill'
  | 'resume_launch_failed'
  | 'persistence_failed'
  | 'cancelled_user'
  | 'cancelled_runtime'
  | 'main_no_progress_timeout'
  | 'context_overflow'
  // Legacy persisted events are normalized on read, but renderer keeps
  // this for older scope-run payloads still in memory.
  | 'infra_error'

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
  friendlyMessage?: string
  technicalDetails?: string | null
  receivedAt: string
}

export interface ScopeRunState {
  scopeId: string
  agent: string
  ownerAgentId?: string | null
  executionBinding?: import('../../../shared/agent-execution-profile').TaskExecutionBinding | null
  executionAgentDisplayName?: string | null
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
  terminalReason?: ScopeRunTerminalReason | null
  toolTrace: ToolTraceEvent[]
  productTurnReceiptRevision?: number
  productTurnPresentationDigest?: string
  productTurnCanonicalMessageId?: string
  activityNarration?: ScopeRunActivityNarration | null
  startedAt: string | null
  updatedAt: string | null
  latestText?: string | null
  module?: AgentModuleKind | null
  intent?: string | null
  executionKind?: ModuleExecutionKind | null
  jobId?: string | null
  artifactRefs?: AgentArtifact[]
  contextUsage?: ContextUsageSnapshot | null
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
  progress?: ScopeRunSkillProgress | null
  executionDiagnostics?: ScopeRunExecutionDiagnostics | null
}

export interface AttachmentPreviewState {
  attachment: ChatAttachment
  mode: 'image' | 'video' | 'text' | 'file'
  content?: string
  error?: string | null
}
