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
    | 'document-tab'
    | 'document-quote'
    | 'document-widget-target'
    | 'calendar-event'
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
  rulesChars?: number
  knowledgeIndexChars?: number
  agentRoutingChars?: number
  recallChars?: number
  autoRecallChars?: number
  sectionChars?: Record<string, number>
  totalBytes?: number
  sectionBytes?: Record<string, number>
  truncations?: string[]
  truncationReasons?: Record<string, 'section_budget'>
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
  browserCollectionConsent?: BrowserCollectionConsentProgress | null
  browserActionSession?: BrowserActionSessionProgress | null
}

export interface BrowserCollectionConsentProgress {
  requestId: string
  consentKind: 'partial_collection' | 'high_control_url_batch_downgrade'
  sourceTaskId: string
  targetHost?: string | null
  warningText?: string | null
  message?: string | null
  createdAt?: string | null
}

export interface BrowserActionSessionProgress {
  targetTabId: string | null
  targetFrameId: string | null
  frameUrl: string | null
  frameOrigin: string | null
  currentUrl: string | null
  origin: string | null
  lastAction: string | null
  lastFollowedTab: {
    tabId: string
    url: string | null
    title: string | null
    reason: string | null
  } | null
  transactionStatus: 'active' | 'confirmed'
  confirmation: {
    confirmed: true
    source: 'page_text' | 'public_url' | 'network' | 'site_strategy'
    signal: string
    urlHash?: string | null
    resourceIdHash?: string | null
    statusCode?: number | null
    textHash?: string | null
    observedAt: string
  } | null
  nextSuggestedAction: string | null
  updatedAt: string
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

export type ScopeRunTerminalReason =
  | 'done'
  | 'checkpoint_budget'
  | 'checkpoint_background'
  | 'checkpoint_user_input'
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
  memoryCapture?: ScopeRunMemoryCapture | null
  executionDiagnostics?: ScopeRunExecutionDiagnostics | null
}

export interface AttachmentPreviewState {
  attachment: ChatAttachment
  mode: 'image' | 'video' | 'text' | 'file'
  content?: string
  error?: string | null
}
