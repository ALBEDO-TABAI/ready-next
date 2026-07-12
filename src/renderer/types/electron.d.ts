import type { BrowserDiagnosticsData } from '../modules/browser/types'
import type { BrowserUtilityMenuRequest } from '../../shared/browser-utility-menu'
import type { BrowserViewIntent, BrowserViewIntentAck } from '../../shared/browser-view-intent'
import type {
  BrowserCookieDomainGroup,
  BrowserPrivacySummary,
  BrowsingDataType,
  ClearBrowsingDataResult,
} from '../../shared/browser-privacy'
import type { NativeContextMenuRequest, NativeContextMenuResponse } from '../../shared/native-context-menu'
import type { CapabilityRuntimeSnapshot } from '../../shared/ai-capability-runtime'
import type { RendererAgentMetricName } from '../../shared/renderer-agent-metrics'
import type { ContextUsageSnapshot } from '../../shared/context-usage-types'
import type { ModelPackDownloadUpdate, ModelPackId, ModelPackSelfTestReport, ModelPackStatus, ModelSource } from '../../shared/model-pack-types'
import type { RuntimeStatus, RuntimeProvisionProgress } from '../../shared/runtime-provision-types'
import type { SkillSourceSelfTestReport } from '../../shared/skill-source-types'
import type {
  AgentBrowserCollectionTask,
  AgentBrowserControlState,
  AgentBrowserSurface,
  BrowserLeaseSurfaceSnapshot,
} from '../modules/browser/useAgentBrowserSupervision'
import type {
  PetActivitySnapshot,
  PetDefinition,
  PetSettings,
  PetStickyNote,
  PetStickyNoteInput,
  PetWindowSnapshot,
} from '../../shared/pet'
import type {
  RSSBenchmarkResultData,
  RSSDiagnosticsData,
  RSSHubChromiumStatusData,
  RSSHubRuntimeStatusData,
  RSSStatusData,
  RSSUpdateTaskStatusData
} from '../modules/rss/types'
import type { ThemeOption, ResolvedTheme, ThemeSkin } from '../stores/useTheme'
import type { TaskType } from '../../shared/task-types'
import type {
  FileEmergenceGetSnapshotPayload,
  FileEmergenceRecordActivityPayload,
  FileEmergenceRecordReadingSessionPayload,
  FileEmergenceRenameProjectPayload,
  FileEmergenceAssignFilePayload,
  FileEmergenceCreateProjectForFilePayload,
  FileEmergenceFeedbackPayload,
  FileEmergenceSnapshot,
} from '../../shared/file-emergence'
// Stage U PR U4.v2-2 / U4.v2-3 — TaskProjectionRecordData +
// TaskProjectionChangeEventData both derive from the canonical wire
// contract instead of hand-mirroring it. ScopeRun* sub-fields keep
// their strict renderer-side aliases (Phase 4 v2 scope: wire's
// ScopeRun fields are intentionally unknown to stay free of src/main/
// imports).
import type {
  TaskProjectionRecord as TaskProjectionRecordWire,
  TaskProjectionChangeEvent as TaskProjectionChangeEventWire,
} from '../../shared/ipc-contracts/task-projection'
import type {
  DocumentMarkDraft,
  DocumentMarkPatch,
  DocumentMarkRecord,
} from '../../shared/document-side-panels'
import type {
  DocumentExportMarkdownBundlePayload,
  DocumentExportPdfPayload,
  DocumentExportResult,
} from '../../shared/document-export'
import type {
  BrowserLockOverlayIPCResult,
  BrowserLockOverlaySnapshot,
} from '../../shared/browser-lock-overlay'
import type {
  VerticalRailOverlayCommand,
  VerticalRailOverlaySnapshot,
} from '../../shared/browser-vertical-rail-overlay'
import type {
  BrowserFastCardContextActionEvent,
  FastCardOverlayCommand,
  FastCardOverlaySnapshot,
  FastCardDescribeImageRequest,
  FastCardDescribeImageResult,
  FastCardIPCResult,
  FastCardResolveVideoRequest,
  FastCardResolveVideoResult,
  FastCardTranslateRequest,
  FastCardTranslateResult,
} from '../../shared/fastcard'
import type {
  ReadyBoardAsset,
  ReadyBoardAssetKind,
  ReadyBoardState,
} from '../../shared/ready-board'
import type {
  AgentSystemStudioConfirmContentEditInput,
  AgentSystemStudioContentEditProposal,
  AgentSystemStudioRejectContentEditInput,
  AgentSystemStudioRoutingSimulation,
  AgentSystemStudioSnapshot,
  AgentSystemStudioStageContentEditInput,
} from '../../shared/agent-system-studio'
import type {
  SpecialistAgentBlueprint,
  SpecialistBlueprintAdmissionVerdict,
  SpecialistBlueprintStatus,
} from '../../shared/agent-specialist-blueprint'
import type { SpecialistBlueprintClarificationContract } from '../../shared/agent-specialist-blueprint-clarification'

// Type declarations for window.electronAPI exposed by preload

// =============================================================================
// Base IPC Response Types
// =============================================================================

/** Base response shape used across most IPC handlers */
interface IPCResponse<T = void> {
  success: boolean
  data?: T
  error?: string
  mock?: boolean
  errorKind?: string
}

interface SendScopedResponse {
  success: boolean
  error?: string | null
  errorKind?: string | null
  responseText?: string | null
  persistence?: {
    scope: 'pre-existing' | 'lazy-created' | 'failed'
    message: 'persisted' | 'failed' | 'skipped'
    attachments: 'metadata_persisted' | 'metadata_partial' | 'metadata_failed' | 'none'
    inputAttachments: 'included' | 'partial' | 'failed' | 'none'
  }
}

// =============================================================================
// Agent API Types
// =============================================================================

type ChannelAdapterType =
  | 'local-debug'
  | 'generic-webhook'
  | 'feishu-bot'
  | 'feishu-app'
  | 'telegram-bot'
  | 'wechat-openclaw'

interface AgentChannelConfigData {
  id: string
  type: ChannelAdapterType
  name: string
  enabled: boolean
  config: Record<string, unknown>
  createdAt: string
  updatedAt: string
  lastError?: string | null
  lastSeenAt?: string | null
}

interface AgentRegistryRecordData {
  id: string
  name: string
  charter: string | null
  personaRef: string | null
  status: 'active' | 'disabled' | 'retired' | 'merged'
  parentAgentId: string | null
  derivationReason: string | null
  mergedIntoAgentId: string | null
  createdAt: string
}

interface AgentDerivationMigrationCandidateData {
  relPath: string
  title: string
  description: string
}

interface AgentDerivationCandidateData {
  candidateRelPath: string
  title: string
  description: string
  bodyPreview: string
  evidenceDates: string[]
  defaultSpecialistId: string
  defaultName: string
  defaultCharter: string
  defaultSeedRulesText: string
  defaultRoutingTriggers: string[]
  migrationCandidates: AgentDerivationMigrationCandidateData[]
}

interface AgentDerivationConfirmData {
  blueprint: SpecialistAgentBlueprint
  blueprintId: string
  specialistId: string
  status: SpecialistBlueprintStatus
  verdict: SpecialistBlueprintAdmissionVerdict
  missing: string[]
  clarification?: SpecialistBlueprintClarificationContract
  createdAgent: false
  routingActivated: false
  migratedCards: []
}

interface SpecialistAgentCreateResultData {
  agent: AgentRegistryRecordData
  rulesRelPath: string
  foundationRelPath?: string
  seedRelPaths: string[]
  routingCardRelPath: string
  migratedCards: Array<{ from: string; to: string }>
}

interface SpecialistBlueprintAdmissionData {
  blueprint: SpecialistAgentBlueprint
  verdict: SpecialistBlueprintAdmissionVerdict
  missing: string[]
}

interface SpecialistBlueprintConfirmationData {
  blueprint: SpecialistAgentBlueprint
  tokenId: string
  contentHash: string
}

interface SpecialistBlueprintConfirmCreateData {
  blueprint: SpecialistAgentBlueprint
  result: SpecialistAgentCreateResultData
}

interface AgentRegistryKnowledgeCardData {
  relPath: string
  title: string
  description: string
  status: string
}

interface AgentCronTaskData {
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

interface AgentHeartbeatSnapshot {
  sidecar: {
    status: 'starting' | 'running' | 'stopped' | 'error'
    pid?: number
    port?: number
    lastBeatAt?: string
    error?: string
  }
  adapters: Array<{
    id: string
    type: ChannelAdapterType
    healthy: boolean
    status?: 'starting' | 'running' | 'stopped' | 'error'
    lastBeatAt?: string
    error?: string
  }>
  orchestrator: {
    healthy: boolean
    activeTasks: number
    lastBeatAt?: string
    error?: string
  }
  toolGateway: {
    healthy: boolean
    availableTools: number
    lastBeatAt?: string
    error?: string
  }
}

interface AgentRuntimeStatusData {
  orchestrator: 'ready-agent-sdk'
  sidecarEnabled: boolean
  sidecar: AgentHeartbeatSnapshot['sidecar']
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
  heartbeat: AgentHeartbeatSnapshot
}

interface AgentCompactSessionReportData {
  beforeTokens: number
  afterTokens: number
  droppedItems: number
  truncatedToolResults: number
  summarized: boolean
}

type AgentCompactSessionData =
  | { status: 'compacted' | 'noop'; report: AgentCompactSessionReportData }
  | { status: 'queued' }
  | { status: 'not_found' | 'superseded'; message: string }

type CapabilityRuntimeSnapshotData = CapabilityRuntimeSnapshot

type ConversationSourceKind = 'local' | 'channel'

interface ConversationScopeData {
  id: string
  agent: string
  activeAgentId: string
  handoffGeneration: number
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

interface ConversationScopeMessageData {
  id: string
  conversationId: string
  role: string
  content: string
  timestamp: string
  meta: Record<string, unknown>
}

interface ConversationEventData {
  type: 'scope_created' | 'scope_updated' | 'message_added'
  scope: ConversationScopeData
  message?: ConversationScopeMessageData
  /**
   * Stage V V3.2 — top-level mirror of `scope.id` so renderer listeners can
   * route per-session without reaching into the nested scope object. null
   * when the push is not session-scoped (currently always set by main).
   */
  sessionId: string | null
}

interface ConversationAttachmentData {
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

interface RemoteAttachmentCacheStatsData {
  totalFiles: number
  totalBytes: number
  targetPath: string
  channels: Array<{
    channelId: string
    files: number
    bytes: number
  }>
}

interface ScopeRunTraceItemData {
  id: string
  kind: 'call' | 'result'
  text: string
  timestamp: string
  toolName?: string
  detail?: string
}

interface ScopeRunMemoryRefData {
  id: string
  layer: 'l0' | 'l1' | 'l2' | 'recall'
  sourceType:
    | 'resident_agent'
    | 'resident_user'
    | 'scope_memory'
    | 'trigger_rule'
    | 'session_recall'
  title: string
  summary?: string | null
  path?: string | null
  triggerId?: string | null
  sensitive?: boolean
  loadedAt: string
}

interface ScopeRunTriggerHitData {
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
    | 'research'
    | 'system'
  blocking: boolean
  refs: string[]
}

interface ScopeRunContextBudgetData {
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

type ScopeRunTaskStepStatusData = 'pending' | 'running' | 'blocked' | 'done' | 'error'
type ScopeRunWaitingForData = 'input' | 'confirmation' | 'agent_result' | 'background' | 'verification' | 'none'
type ScopeRunResumableActionData = 'continue' | 'retry' | 'open_artifact' | 'cancel' | 'none'

interface ScopeRunTaskStepData {
  id: string
  title: string
  status: ScopeRunTaskStepStatusData
  detail?: string | null
  updatedAt: string
}

interface ScopeRunTaskContinuationData {
  taskId?: string | null
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
  progress?: ScopeRunSkillProgressData | null
}

interface ScopeRunSkillProgressData {
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
  handoff?: ScopeRunSkillHandoffData | null
  browserCollectionConsent?: BrowserCollectionConsentProgressData | null
  browserActionSession?: BrowserActionSessionProgressData | null
}

interface BrowserCollectionConsentProgressData {
  requestId: string
  consentKind: 'partial_collection' | 'high_control_url_batch_downgrade'
  sourceTaskId: string
  targetHost?: string | null
  warningText?: string | null
  message?: string | null
  createdAt?: string | null
}

interface BrowserActionSessionProgressData {
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

interface ScopeRunSkillHandoffData {
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

interface ContinuationIntentData {
  taskId: string
  executionId?: string
  stepId?: string
  blockedReason?: string
  responseText?: string
  todoId?: string
  todoTitle?: string
  resumeKind?: 'snapshot' | 'paused' | 'done_residual'
  pauseReason?: string
  childRunId?: string
  detachedTaskId?: string
  taskRunId?: string
  jobId?: string
  skillId?: string
  action?: string
  runStatePath?: string
  outputDir?: string
  progressFingerprint?: string
}

interface ScopeRunMemoryCaptureItemData {
  memoryId: string
  category: 'user_preference' | 'summary'
  sourceType: 'resident_agent' | 'resident_user' | 'scope_memory' | 'trigger_rule'
  title: string
  summary?: string | null
}

interface ScopeRunMemoryCaptureData {
  status: 'ready' | 'dismissed' | 'reverted'
  createdAt: string
  note?: string | null
  items: ScopeRunMemoryCaptureItemData[]
}

interface ScopeRunExecutionDiagnosticsData {
  taskBudgetRuntime?: {
    taskType: TaskTypeData
    budget: {
      maxIterations: number
      maxToolCalls: number
      maxParallelToolGroups: number
    }
    usage: {
      iterationsUsed: number
      toolCallsUsed: number
      parallelToolGroupsUsed: number
    }
    stepBudget?: {
      stepId?: string | null
      maxIterations: number
      remainingIterations: number
    } | null
    warningLevel: 'none' | 'warning' | 'converge' | 'exhausted'
    frozen: boolean
  } | null
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
  fallback?: {
    happened: boolean
    kind: string
    attempts: number
  } | null
  stepBudget?: {
    stepId?: string | null
    maxIterations?: number
    remainingIterations?: number
  } | null
  budgetUsagePercent?: number | null
  budgetWarningLevel?: 'none' | 'warning' | 'converge' | 'exhausted' | null
  recoveryHistory?: RecoveryRecordData[] | null
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
  contextUsage?: ContextUsageSnapshot | null
}

type TaskTypeData = TaskType

type TaskInteractionStateData =
  | 'running'
  | 'awaiting_clarification'
  | 'awaiting_confirmation'
  | 'human_takeover'
  | 'suspended'
  | 'resuming'
  | 'check_in_pending'

type TaskProjectionStatusData = 'queued' | 'running' | 'recoverable_paused' | 'budget_paused' | 'blocked' | 'completed' | 'failed' | 'killed'

interface TaskBudgetData {
  taskType: TaskTypeData
  maxIterations: number
  maxToolCalls: number
  maxParallelToolGroups: number
  stepBudget?: {
    stepId?: string | null
    maxIterations: number
    remainingIterations?: number
  } | null
}

interface RecoveryRecordData {
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

interface TaskProjectionStepData {
  id: string
  description: string
  title?: string
  status?: ScopeRunTaskStepStatusData
  detail?: string | null
  updatedAt?: string
  toolHints?: string[]
  budget?: number
  dependsOn?: string[]
  childTasks?: Array<{
    taskId: string
    taskType: TaskTypeData
    status: TaskProjectionStatusData
    summary?: string | null
    artifactSummary?: string | null
    updatedAt?: string | null
  }>
}

/**
 * Stage U PR U4.v2-2 — wire-derived task-projection record.
 *
 * Top-level shape is now sourced from the canonical wire contract at
 * `src/shared/ipc-contracts/task-projection.ts`. The five ScopeRun*
 * sub-fields (waitingFor / resumableActions / continuationRef /
 * progress / recentArtifacts) are typed permissively as `unknown` in
 * the wire module to keep src/shared/ free of src/main/ imports, so
 * we override them here with the renderer-side strict aliases. The
 * `check-task-projection-wire-canonical.cjs` gate (U4.v2-4) rejects
 * any future PR that reintroduces a full hand-rewrite of this shape.
 *
 * Stage Q canResume contract preserved verbatim from the wire source:
 * renderer must consume `canResume` directly and never recompute from
 * `resumableActions` / `taskRunId` / `interactionState` (audit §C-9 /
 * contract C7).
 */
type TaskProjectionRecordData =
  Omit<
    TaskProjectionRecordWire,
    'steps' | 'waitingFor' | 'resumableActions' | 'continuationRef' | 'progress' | 'recentArtifacts'
  > & {
    /** Renderer uses the narrower ScopeRunTaskStepStatus-compatible
     *  shape (consumers like ChatPanel.normalizeProjectionSteps assign
     *  step.status into ScopeRunTaskStep[] downstream). */
    steps: TaskProjectionStepData[]
    waitingFor?: ScopeRunWaitingForData
    resumableActions?: ScopeRunResumableActionData[]
    continuationRef?: ScopeRunTaskContinuationData | null
    progress?: ScopeRunSkillProgressData | null
    recentArtifacts?: ScopeRunEventData['artifactRefs']
  }

interface ScopeRunSummaryData {
  scopeId: string
  agent: string
  title: string
  sourceKind: ConversationSourceKind
  sourceId: string
  channelKey: string
  threadKey: string
  phase: ScopeRunEventData['phase']
  taskId?: string | null
  taskTitle?: string | null
  taskSummary?: string | null
  steps?: ScopeRunTaskStepData[]
  currentStepId?: string | null
  waitingFor?: ScopeRunWaitingForData
  resumableActions?: ScopeRunResumableActionData[]
  recentArtifacts?: ScopeRunEventData['artifactRefs']
  taskContinuation?: ScopeRunTaskContinuationData | null
  memoryCapture?: ScopeRunMemoryCaptureData | null
  executionDiagnostics?: ScopeRunExecutionDiagnosticsData | null
  contextUsage?: ContextUsageSnapshot | null
  blockedReason?: string | null
  error?: string | null
  terminalReason?: ScopeRunTerminalReasonData | null
  updatedAt: string
}

type SessionRecallMatchKindData =
  | 'message'
  | 'title'
  | 'task'
  | 'attachment'
  | 'recent'
  | 'recent_self_lineage'
  | 'semantic'

interface SessionRecallHitData {
  conversationId: string
  lineageRootId: string
  resumeTitle: string
  title: string
  sourceKind: ConversationSourceKind
  sourceId: string
  threadKey: string
  matchedBy: SessionRecallMatchKindData[]
  score: number
  hitExcerpt?: string | null
  latestTaskTitle?: string | null
  latestTaskSummary?: string | null
  attachmentNames: string[]
  updatedAt: string
}

interface SessionRecallCapsuleData {
  conversationId: string
  lineageRootId: string
  resumeTitle: string
  title: string
  sourceKind: ConversationSourceKind
  sourceId: string
  threadKey: string
  summary: string
  latestTaskTitle?: string | null
  latestTaskSummary?: string | null
  attachmentNames: string[]
  updatedAt: string
}

interface ReferenceSkillHintData {
  id: string
  name: string
  at: number
  expiresAt: number
}

interface DetachedSkillTaskData {
  id: string
  scopeId?: string | null
  sessionId?: string | null
  agent?: string | null
  skillId: string
  action: string
  params: Record<string, unknown>
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'blocked'
  outputDir?: string | null
  runStatePath?: string | null
  sceneScoresPath?: string | null
  deliveryReportPath?: string | null
  error?: string | null
  startedAt: string
  updatedAt: string
  finishedAt?: string | null
}

interface ActiveChildRunSummaryData {
  childRunId: string
  skillId: string
  sessionId: string | null
  scopeId: string | null
  status: string
  startedAt: string
  outputDir: string
  runStatePath: string
  progress: ScopeRunSkillProgressData
  blockedReason: string | null
  liveness: 'foreground' | 'background' | null
  closeStatus: string | null
}

type ScopeRunTerminalReasonData =
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
  | 'infra_error'

interface ScopeRunEventData {
  type: 'started' | 'updated' | 'finished'
  scopeId: string
  /**
   * Stage V V3.2 — top-level mirror of `scopeId` so multi-session
   * renderer wiring routes per-session without aliasing through scopeId.
   * null when the event is not session-scoped.
   */
  sessionId: string | null
  agent: string
  runId?: string
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
  terminalReason?: ScopeRunTerminalReasonData | null
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
    | 'system'
  intent?: string
  executionKind?: 'deterministic' | 'interactive' | 'job' | 'pipeline'
  jobId?: string
  artifactRefs?: Array<{
    id: string
    module:
      | 'browser'
      | 'document'
      | 'design'
      | 'skill'
      | 'video'
      | 'rss'
      | 'calendar'
      | 'feishu'
      | 'research'
      | 'system'
    kind: string
    label: string
    path?: string | null
    url?: string | null
    mimeType?: string | null
    sourceRunId?: string | null
    createdAt: string
    meta?: Record<string, unknown>
  }>
  memoryRefs?: ScopeRunMemoryRefData[]
  triggerHits?: ScopeRunTriggerHitData[]
  contextBudget?: ScopeRunContextBudgetData | null
  contextUsage?: ContextUsageSnapshot | null
  ownerResourceId?: string
  lastEvidenceAt?: string
  toolEvent?: ScopeRunTraceItemData
  error?: string
  blockedReason?: string
  controllerId?: string
  ownerTabId?: string
  checkpointExpiresAt?: number
  taskTitle?: string
  taskSummary?: string
  steps?: ScopeRunTaskStepData[]
  currentStepId?: string | null
  waitingFor?: ScopeRunWaitingForData
  resumableActions?: ScopeRunResumableActionData[]
  recentArtifacts?: ScopeRunEventData['artifactRefs']
  taskContinuation?: ScopeRunTaskContinuationData | null
  memoryCapture?: ScopeRunMemoryCaptureData | null
  executionDiagnostics?: ScopeRunExecutionDiagnosticsData | null
  stepMetrics?: {
    toolCalls: number
    toolResults: number
    lastToolAt: string | null
  }
  timestamp: string
}

interface ElectronAgentAPI {
  /** Best-effort renderer-side telemetry; preload may not surface this in every
   *  build (the callers use optional-chaining). Declared optional so callers
   *  can `window.electronAPI?.agent?.metric?.(...)` without a TS error. */
  metric?: (payload: { name: string; payload?: Record<string, unknown> }) => void
  send: (
    agent: string,
    message: string | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>,
    sessionId?: string,
    requestId?: string,
    deliveryMode?: 'standard' | 'adaptive' | 'thorough'
  ) => Promise<{ success: boolean; error?: string | null }>
  newSession: (agent: string, sessionId?: string) => Promise<{ success: boolean; error?: string }>
  sessionPrerouteEvaluate: (firstMessage: string) => Promise<{
    success: boolean
    data?: {
      decision:
        | { tier: 'state'; targetAgentId: string; taskId: string | null }
        | { tier: 'precedent'; targetAgentId: string; cardRelPath: string; matchedKeywords: string[] }
        | { tier: 'fallback'; targetAgentId: string; reason: string; conflicts?: Array<{ cardRelPath: string; targetAgentId: string }> }
      effect: 'none' | 'suggest' | 'route'
    }
    error?: string
  }>
  // Stage U PR U1.2 — removed `orchestrate / getStatus / getAll / getDiagnostics`
  // legacy AgentManager wrappers. Use `getRuntimeStatus` / `getCapabilityRuntimeSnapshot`.
  kill: (agent: string, sessionId?: string) => Promise<{ success: boolean; error?: string }>
  compactSession: (
    agent: string,
    sessionId?: string
  ) => Promise<IPCResponse<AgentCompactSessionData>>
  getRuntimeStatus: () => Promise<IPCResponse<AgentRuntimeStatusData>>
  getCapabilityRuntimeSnapshot: (config?: unknown) => Promise<IPCResponse<CapabilityRuntimeSnapshotData>>
  listChannels: () => Promise<IPCResponse<AgentChannelConfigData[]>>
  listRegistry: () => Promise<IPCResponse<AgentRegistryRecordData[]>>
  listRegistryKnowledge: (id: string) => Promise<IPCResponse<AgentRegistryKnowledgeCardData[]>>
  getSystemStudioSnapshot: () => Promise<IPCResponse<AgentSystemStudioSnapshot>>
  simulateSystemStudioRouting: (firstMessage: string) => Promise<IPCResponse<AgentSystemStudioRoutingSimulation>>
  stageSystemStudioContentEdit: (payload: AgentSystemStudioStageContentEditInput) => Promise<IPCResponse<AgentSystemStudioContentEditProposal>>
  confirmSystemStudioContentEdit: (proposalId: AgentSystemStudioConfirmContentEditInput['proposalId']) => Promise<IPCResponse<AgentSystemStudioContentEditProposal>>
  rejectSystemStudioContentEdit: (proposalId: AgentSystemStudioRejectContentEditInput['proposalId']) => Promise<IPCResponse<AgentSystemStudioContentEditProposal>>
  listSpecialistBlueprints: () => Promise<IPCResponse<SpecialistAgentBlueprint[]>>
  upsertSpecialistBlueprintDraft: (blueprint: unknown) => Promise<IPCResponse<SpecialistAgentBlueprint>>
  runSpecialistBlueprintAdmission: (payload: {
    blueprint?: unknown
    blueprintId?: string
  }) => Promise<IPCResponse<SpecialistBlueprintAdmissionData>>
  requestSpecialistBlueprintConfirmation: (payload: {
    blueprintId: string
    sessionId: string
    runId?: string | null
    unverifiedSemanticReviewAck?: { kind: 'unverified_semantic_review'; contentHash: string }
  }) => Promise<IPCResponse<SpecialistBlueprintConfirmationData>>
	  confirmSpecialistDraftCreate: (payload: {
	    blueprintId: string
	    sessionId: string
	    runId?: string | null
	    tokenId: string
	    migrateCardRelPaths?: string[]
	  }) => Promise<IPCResponse<SpecialistBlueprintConfirmCreateData>>
  rejectSpecialistBlueprint: (blueprintId: string) => Promise<IPCResponse<SpecialistAgentBlueprint>>
  expireSpecialistBlueprint: (blueprintId: string) => Promise<IPCResponse<SpecialistAgentBlueprint>>
  updateRegistryStatus: (payload: {
    id: string
    status: 'active' | 'disabled' | 'retired' | 'merged'
    mergedIntoAgentId?: string | null
    migrateCardRelPaths?: string[]
  }) => Promise<IPCResponse<AgentRegistryRecordData>>
  deleteRegistryAgent: (id: string) => Promise<IPCResponse<AgentRegistryRecordData>>
  listDerivationCandidates: () => Promise<IPCResponse<AgentDerivationCandidateData[]>>
  confirmDerivation: (payload: {
    candidateRelPath: string
    specialistId: string
    name: string
    charter?: string | null
    seedRulesText: string
    routingTriggers: string[]
    activateRouting?: boolean
    migrateCardRelPaths?: string[]
  }) => Promise<IPCResponse<AgentDerivationConfirmData>>
  rejectDerivation: (candidateRelPath: string) => Promise<IPCResponse<AgentDerivationCandidateData[]>>
  listConversationScopes: (agent?: string) => Promise<IPCResponse<ConversationScopeData[]>>
  listScopeRuns: (payload?: {
    channelKey?: string
    statuses?: string[]
    limit?: number
  }) => Promise<IPCResponse<ScopeRunSummaryData[]>>
  listTaskProjections: (scopeId: string) => Promise<IPCResponse<TaskProjectionRecordData[]>>
  getTaskProjection: (taskId: string) => Promise<IPCResponse<TaskProjectionRecordData>>
  searchSessionRecall: (payload?: {
    query?: string
    channelKey?: string
    sourceKind?: ConversationSourceKind
    userId?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }) => Promise<IPCResponse<SessionRecallHitData[]>>
  listRecentSessions: (payload?: {
    channelKey?: string
    sourceKind?: ConversationSourceKind
    userId?: string
    hasAttachments?: boolean
    currentScopeId?: string
    limit?: number
  }) => Promise<IPCResponse<SessionRecallHitData[]>>
  getSessionRecallCapsule: (
    conversationId: string
  ) => Promise<IPCResponse<SessionRecallCapsuleData>>
  listAttachedSessionRecallContexts: (
    scopeId: string
  ) => Promise<IPCResponse<SessionRecallCapsuleData[]>>
  getReferenceSkillHint: (
    scopeId: string
  ) => Promise<IPCResponse<ReferenceSkillHintData | null>>
  startDetachedSkillAction: (payload: {
    scopeId?: string
    sessionId?: string
    agent?: string
    skillId: string
    action: string
    params?: Record<string, unknown>
  }) => Promise<IPCResponse<DetachedSkillTaskData>>
  inspectDetachedSkillTask: (
    taskId: string,
    scopeId: string
  ) => Promise<IPCResponse<DetachedSkillTaskData>>
  listDetachedSkillTasks: (
    payload?: { scopeId?: string }
  ) => Promise<IPCResponse<DetachedSkillTaskData[]>>
  cancelDetachedSkillTask: (
    taskId: string,
    scopeId: string
  ) => Promise<IPCResponse<DetachedSkillTaskData>>
  listActiveChildRuns: () => Promise<IPCResponse<ActiveChildRunSummaryData[]>>
  cancelChildRun: (
    childRunId: string
  ) => Promise<IPCResponse<unknown>>
  attachSessionRecallContext: (
    currentScopeId: string,
    conversationId: string
  ) => Promise<
    IPCResponse<{
      scope: ConversationScopeData
      capsule: SessionRecallCapsuleData
    }>
  >
  detachSessionRecallContext: (
    currentScopeId: string,
    conversationId: string
  ) => Promise<
    IPCResponse<{
      scope: ConversationScopeData
    }>
  >
  resumeSessionCandidate: (payload: {
    conversationId?: string
    resumeTitle?: string
  }) => Promise<IPCResponse<SessionRecallHitData | null>>
  getConversationScopeMessages: (
    scopeId: string
  ) => Promise<IPCResponse<ConversationScopeMessageData[]>>
  createLocalScope: (agent: string, id?: string) => Promise<IPCResponse<ConversationScopeData>>
  listScopeAttachments: (scopeId?: string) => Promise<IPCResponse<ConversationAttachmentData[]>>
  getScopeAttachment: (
    scopeId: string,
    attachmentId: string
  ) => Promise<IPCResponse<ConversationAttachmentData>>
  clearRemoteAttachmentCache: (
    channelId?: string
  ) => Promise<IPCResponse<{ removedFiles: number; removedBytes: number; targetPath: string }>>
  getRemoteAttachmentCacheStats: (
    channelId?: string
  ) => Promise<IPCResponse<RemoteAttachmentCacheStatsData>>
	  sendScoped: (
	    payload: {
	      scopeId: string
	      agent?: string
	      message: string | Array<{ type: string; text?: string; base64?: string; mimeType?: string }>
	      requestId?: string
	      workspaceRoots?: string[]
	      deliveryMode?: 'standard' | 'adaptive' | 'thorough'
	      userMessage?: {
	        id: string
	        content: string
	        timestamp?: string
	        meta?: Record<string, unknown>
	        attachmentConfirmation?: {
	          selectedCount: number
	          metadataCount: number
	          inputIncludedCount: number
	          inputFailedCount: number
	        }
	      }
	      continuationIntent?: ContinuationIntentData | null
	    }
	  ) => Promise<SendScopedResponse>
	  emitRendererMetric: (
	    name: RendererAgentMetricName,
	    payload?: Record<string, unknown>
	  ) => Promise<IPCResponse>
  reportInfrastructureTimeout: (payload: {
    scopeId: string
    requestId: string
    elapsedMs?: number
	  }) => Promise<IPCResponse<{
	    state?: 'active' | 'stale' | 'not_found' | 'paused_user_input'
	    activeRunId?: string | null
	  }>>
  suspendRun: (payload: {
    scopeId: string
    taskId?: string
  }) => Promise<{ success: boolean; error?: string | null }>
  resumeRun: (payload: {
    scopeId: string
    taskId?: string
    requestId?: string
    responseText?: string
    continuationIntent?: ContinuationIntentData | null
  }) => Promise<{ success: boolean; error?: string | null }>
  respondToInteraction: (payload: {
    scopeId: string
    taskId?: string
    requestId?: string
    responseText: string
    confirmed?: boolean
    continuationIntent?: ContinuationIntentData | null
  }) => Promise<{ success: boolean; error?: string | null }>
  upsertChannel: (payload: {
    id?: string
    type: ChannelAdapterType
    name: string
    enabled?: boolean
    config?: Record<string, unknown>
  }) => Promise<IPCResponse<AgentChannelConfigData>>
  testChannel: (payload: {
    id?: string
    type: ChannelAdapterType
    name: string
    enabled?: boolean
    config?: Record<string, unknown>
  }) => Promise<{ success: boolean; error?: string }>
  startWechatLogin: (payload: {
    id?: string
    force?: boolean
  }) => Promise<IPCResponse<{
    sessionKey?: string
    qrcodeUrl?: string
    qrDataUrl?: string
    status?: string
    message?: string
  }>>
  getWechatLoginStatus: (payload: {
    channelId: string
    sessionKey: string
  }) => Promise<IPCResponse<{
    sessionKey?: string
    qrcodeUrl?: string
    qrDataUrl?: string
    status?: string
    message?: string
    accountId?: string
  }>>
  submitWechatLoginVerifyCode: (payload: {
    channelId: string
    sessionKey: string
    code: string
  }) => Promise<IPCResponse>
  deleteChannel: (id: string) => Promise<{ success: boolean; error?: string }>
  setChannelEnabled: (id: string, enabled: boolean) => Promise<IPCResponse<AgentChannelConfigData>>
  sendChannelProbe: (id: string, text: string) => Promise<{ success: boolean; error?: string }>
  listSchedules: () => Promise<IPCResponse<AgentCronTaskData[]>>
  upsertSchedule: (payload: {
    id?: string
    name: string
    cronExpr: string
    prompt: string
    channelId?: string | null
    enabled?: boolean
    payload?: Record<string, unknown>
  }) => Promise<IPCResponse<AgentCronTaskData>>
  runScheduleNow: (id: string) => Promise<{ success: boolean; error?: string }>
  pauseSchedule: (id: string) => Promise<IPCResponse<AgentCronTaskData>>
  resumeSchedule: (id: string) => Promise<IPCResponse<AgentCronTaskData>>
  deleteSchedule: (id: string) => Promise<{ success: boolean; error?: string }>
  // Stage V V3.2 — push payloads carry `sessionId: string | null` (not
  // optional). null = global event (not session-scoped); a string means
  // the event belongs to a specific session. Renderer routes by this
  // field rather than relying on the historical `scopeId` alias.
  onStream: (
    callback: (data: {
      agent: string
      sessionId: string | null
      runId?: string
      chunk: string
      type: string
    }) => void
  ) => () => void
  onStatusChange: (
    callback: (data: {
      agent: string
      sessionId: string | null
      runId?: string
      status: string
      isMock: boolean
    }) => void
  ) => () => void
  onError: (
    callback: (data: {
      agent: string
      sessionId: string | null
      runId?: string
      error: string
      type: string
      /** Phase 3: classified error kind for capsule UI + telemetry. */
      errorKind?: string
      /** Phase 3: true when UI should show a soft-failure capsule (no system chat message). */
      recoverable?: boolean
      /** Phase 3: tool name attached when the error came from a tool host. */
      toolName?: string
    }) => void
  ) => () => void
  onToolAction: (
    callback: (data: {
      agent?: string
      sessionId: string | null
      runId?: string
      tool: string
      args: Record<string, unknown>
    }) => void
  ) => () => void
  onToolActionRequest: (
    callback: (data: {
      requestId: string
      agent?: string
      sessionId: string | null
      runId?: string
      tool: string
      args: Record<string, unknown>
    }) => void
  ) => () => void
  onCancelToolActionRequest: (
    callback: (data: { requestIds: string[]; agent?: string; sessionId: string | null }) => void
  ) => () => void
  completeToolActionRequest: (payload: {
    requestId: string
    handled: boolean
    payload?: Record<string, unknown>
    error?: string
  }) => Promise<IPCResponse<{ acknowledged: boolean }>>
  onConversationEvent: (callback: (data: ConversationEventData) => void) => () => void
  onScopeRunEvent: (callback: (data: ScopeRunEventData) => void) => () => void
  // Stage U PR U2.1 — projection sync failure diagnostic event.
  // Stage V V3.2 — `sessionId` mirrors `scopeId` on the wire.
  onProjectionSyncFailed: (callback: (data: {
    scopeId: string
    sessionId: string | null
    taskId: string | null
    reason: string
    timestamp: string
  }) => void) => () => void
  // Phase 5.3 — push-based reference-skill hint state changes. Renderer uses
  // this to refresh the "上下文已启用" badge immediately on arm/clear/sweep.
  // Stage V V3.2 — `sessionId` mirrors `scopeId` on the wire.
  onReferenceSkillHintChanged: (callback: (data: { scopeId: string; sessionId: string | null; change: 'armed' | 'cleared' }) => void) => () => void
  // Stage O §0.4 — push notification on `task_projections` mutation. The
  // renderer uses scopeId to decide whether to refetch projections; the
  // 2-second `agent:listActiveChildRuns` polling timer is retired.
  // Stage V V3.2 — `sessionId` mirrors `scopeId` on the wire.
  onTaskProjectionsChanged: (
    callback: (data: TaskProjectionChangeEventData & { sessionId: string | null }) => void,
  ) => () => void
}

/**
 * Stage U PR U4.v2-3 — wire-derived payload of `agent:taskProjectionsChanged`.
 *
 * Previously Stage O hand-mirrored the main-side interface to avoid
 * a `src/main/...` import. U4.v2-3 retires that mirror: the renderer
 * now derives the exact wire shape from the canonical
 * `src/shared/ipc-contracts/task-projection.ts`. Any future change to
 * the wire reason union or payload fields flows here automatically.
 */
export type TaskProjectionChangeEventData = TaskProjectionChangeEventWire

// =============================================================================
// Browser API Types
// =============================================================================

/** Tab info returned by browser:getTabs */
interface BrowserTabInfo {
  id: string
  url: string
  title: string
  domain: string
  favicon: string | null
  owner: 'manual' | 'agent'
  required: boolean
  activity: 'idle' | 'running' | 'attention'
  lastAuditedAt: number | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string | null
  active: boolean
}

/** Tab update event pushed to renderer via browser:tabUpdate */
interface BrowserTabUpdateEvent {
  type: 'title' | 'navigate' | 'loading' | 'error' | 'meta' | 'closed'
  tabId: string
  activeTabId?: string | null
  title?: string
  url?: string
  domain?: string
  favicon?: string | null
  owner?: 'manual' | 'agent'
  required?: boolean
  activity?: 'idle' | 'running' | 'attention'
  lastAuditedAt?: number | null
  canGoBack?: boolean
  canGoForward?: boolean
  loading?: boolean
  error?: string
}

/** activate:false = background/agent tab — list it in the strip without stealing focus (D1). Absent keeps legacy activate-on-open. */
type BrowserTabOpenedEvent = BrowserTabInfo & { activate?: boolean }

interface BrowserBookmarkData {
  id: string
  url: string
  title: string
  favicon: string | null
  created_at: number
}

interface BrowserHistoryData {
  id: string
  url: string
  title: string
  visited_at: number
}

interface BrowserDownloadData {
  id: string
  url: string
  filename: string
  save_path: string
  total_bytes: number
  received_bytes: number
  state: string
  created_at: number
}

interface BrowserDownloadUpdateEvent {
  id: string
  filename: string
  totalBytes: number
  receivedBytes: number
  state: string
  savePath?: string
}

interface BrowserTabContextData {
  title: string
  url: string
  domain: string
  heading: string
  selection: string
  excerpt: string
  capturedAt: number
}

interface BrowserPreviewState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
}

interface BrowserBookmarksChangedEvent {
  action: 'import' | 'export'
  imported?: number
  skipped?: number
  exported?: number
  filePath?: string
}

interface BrowserAdblockStateData {
  enabled: boolean
  previewEnabled: boolean
  whitelistDomains: string[]
  rulesVersion: string
  networkBlockedCount: number
  lastUpdatedAt: number | null
}

interface ElectronBrowserAPI {
  createTab: (
    url: string,
    options?: { background?: boolean }
  ) => Promise<{ success: boolean; tabId?: string; title?: string; error?: string; mock?: boolean }>
  openForCaptureTarget: (
    url: string
  ) => Promise<{ success: boolean; tabId?: string; reused?: boolean; error?: string }>
  closeTab: (tabId: string) => Promise<{ success: boolean; error?: string }>
  switchTab: (tabId: string) => Promise<{
    success: boolean
    url?: string
    title?: string
    domain?: string
    favicon?: string | null
    owner?: 'manual' | 'agent'
    required?: boolean
    activity?: 'idle' | 'running' | 'attention'
    lastAuditedAt?: number | null
    canGoBack?: boolean
    canGoForward?: boolean
    error?: string
  }>
  navigate: (tabId: string, url: string) => Promise<{ success: boolean; error?: string }>
  reorderTabs: (tabIds: string[]) => Promise<{ success: boolean; error?: string }>
  goBack: (tabId: string) => Promise<{ success: boolean; error?: string }>
  goForward: (tabId: string) => Promise<{ success: boolean; error?: string }>
  reload: (tabId: string) => Promise<{ success: boolean; error?: string }>
  // Stage X4 PR-shell-1 — BrowserViewIntent boundary. Renderer pushes
  // declarative intents through `browser:intent`; main is the single
  // decision point. Replaces direct `updateBounds`, `hideAll`,
  // `showActive`, `hideActiveHost` calls.
  sendIntent: (intent: BrowserViewIntent) => { success: true }
  onIntentAck: (callback: (ack: BrowserViewIntentAck) => void) => () => void
  fitActiveTabToBounds: (
    tabId?: string | null
  ) => Promise<{ success: boolean; zoomFactor?: number; error?: string }>
  uploadLocalMediaFiles: (payload: {
    tabId?: string | null
    files: string[]
    x?: number
    y?: number
  }) => Promise<{
    success: boolean
    method?: 'file-input' | 'drop'
    targetDescription?: string
    assignedFileNames?: string[]
    error?: string
  }>
  onLocalMediaUploadStatus: (callback: (data: {
    tabId?: string
    status: { kind: 'uploading' | 'success' | 'error'; message: string } | null
  }) => void) => () => void
  captureWindowSnapshot: (bounds: {
    x: number
    y: number
    width: number
    height: number
  }) => Promise<{ success: boolean; data?: string; error?: string }>
  captureViewportSnapshot: (
    tabId?: string | null
  ) => Promise<{ success: boolean; data?: string; error?: string }>
  getTabs: () => Promise<BrowserTabInfo[]>
  getAdblockState: () => Promise<{
    success: boolean
    data?: BrowserAdblockStateData
    error?: string
  }>
  getDiagnostics: () => Promise<{ success: boolean; data?: BrowserDiagnosticsData; error?: string }>
  // Agent-browser supervision (plan §3.6): two-step interrupt + task listing.
  getAgentSupervisionState: () => Promise<{
    controlState: AgentBrowserControlState
    agentTabId: string | null
    tasks: AgentBrowserCollectionTask[]
    surfaces?: Record<AgentBrowserSurface, BrowserLeaseSurfaceSnapshot>
    activeWriteSurface?: AgentBrowserSurface | null
    error?: string
  }>
  requestAgentInterruption: () => Promise<{ state: AgentBrowserControlState; pending: boolean; error?: string }>
  confirmAgentInterruption: () => Promise<{ state: AgentBrowserControlState; frozen: boolean; takeoverTabId?: string | null; error?: string }>
  dismissAgentInterruption: () => Promise<{ state: AgentBrowserControlState; error?: string }>
  confirmCollectionConsent: (payload: {
    requestId: string
    confirmedVia: 'ask_user_questions' | 'ui_action'
  }) => Promise<{ success: boolean; data?: unknown; error?: string }>
  resumeTask: (payload: {
    taskId: string
  }) => Promise<{ success: boolean; data?: unknown; error?: string }>
  onAgentControlChanged: (callback: (data: { state: AgentBrowserControlState }) => void) => () => void
  onLeaseChanged: (callback: (data: {
    surfaces?: Record<AgentBrowserSurface, BrowserLeaseSurfaceSnapshot>
    activeWriteSurface?: AgentBrowserSurface | null
  }) => void) => () => void
  setAdblockEnabled: (
    enabled: boolean,
    scope?: 'main' | 'preview' | 'all'
  ) => Promise<{ success: boolean; data?: BrowserAdblockStateData; error?: string }>
  toggleAdblockDomain: (
    domain: string
  ) => Promise<{ success: boolean; data?: BrowserAdblockStateData; error?: string }>
  getTabContext: (
    tabId?: string
  ) => Promise<{ success: boolean; data?: BrowserTabContextData; error?: string }>
  previewOpen: (payload: { url: string }) => Promise<{ success: boolean; error?: string }>
  previewNavigate: (payload: { url: string }) => Promise<{ success: boolean; error?: string }>
  previewGoBack: () => Promise<{ success: boolean; error?: string }>
  previewGoForward: () => Promise<{ success: boolean; error?: string }>
  previewReload: () => Promise<{ success: boolean; error?: string }>
  previewUpdateBounds: (bounds: {
    x: number
    y: number
    width: number
    height: number
  }) => Promise<{ success: boolean }>
  previewClose: () => Promise<{ success: boolean }>
  previewGetState: () => Promise<BrowserPreviewState>
  p7cLiveProofStartUserViewLease: () => Promise<{ success: boolean; leaseId?: string; tabId?: string; error?: string }>
  p7cLiveProofCreateManualTab: () => Promise<{ success: boolean; tabId?: string; error?: string }>
  p7cLiveProofPrepareForegroundProbe: () => Promise<{
    success: boolean
    state?: { tabId: string; url: string; title: string; focusToken: string; scrollX: number; scrollY: number }
    error?: string
  }>
  p7cLiveProofSampleActiveTabState: () => Promise<{
    success: boolean
    state?: { tabId: string; url: string; title: string; focusToken: string; scrollX: number; scrollY: number }
    error?: string
  }>
  p7cLiveProofSendUserKey: (key?: string) => Promise<{ success: boolean; error?: string }>
  p7cLiveProofCheckWriteDenied: () => Promise<{ success: boolean; errorKind?: string; error?: string }>
  p7cLiveProofClear: () => Promise<{ success: boolean; error?: string }>
  onPreviewUpdate: (callback: (data: BrowserPreviewState) => void) => () => void
  onTabUpdate: (callback: (data: BrowserTabUpdateEvent) => void) => () => void
  onTabOpened: (callback: (data: BrowserTabOpenedEvent) => void) => () => void
  onAdblockUpdate: (callback: (data: BrowserAdblockStateData) => void) => () => void
  onFastCardContextAction: (callback: (data: BrowserFastCardContextActionEvent) => void) => () => void
  translateFastCardSelection: (payload: FastCardTranslateRequest) => Promise<FastCardIPCResult<FastCardTranslateResult>>
  describeFastCardImage: (payload: FastCardDescribeImageRequest) => Promise<FastCardIPCResult<FastCardDescribeImageResult>>
  resolveFastCardVideo: (payload: FastCardResolveVideoRequest) => Promise<FastCardIPCResult<FastCardResolveVideoResult>>
  showFastCardOverlay: (payload: FastCardOverlaySnapshot) => Promise<FastCardIPCResult<void>>
  hideFastCardOverlay: () => Promise<FastCardIPCResult<void>>
  getFastCardOverlaySnapshot: () => Promise<FastCardIPCResult<FastCardOverlaySnapshot | null>>
  sendFastCardOverlayCommand: (command: FastCardOverlayCommand) => Promise<FastCardIPCResult<void>>
  onFastCardOverlayCommand: (callback: (command: FastCardOverlayCommand) => void) => () => void
  onFastCardOverlaySnapshot: (callback: (snapshot: FastCardOverlaySnapshot) => void) => () => void
  showVerticalRailOverlay: (payload: VerticalRailOverlaySnapshot) => Promise<{ success: boolean; error?: string }>
  hideVerticalRailOverlay: () => Promise<{ success: boolean; error?: string }>
  getVerticalRailOverlaySnapshot: () => Promise<{ success: boolean; error?: string; data?: VerticalRailOverlaySnapshot | null }>
  isVerticalRailOverlayPointerInside: () => Promise<{ success: boolean; error?: string; data?: boolean }>
  sendVerticalRailOverlayCommand: (command: VerticalRailOverlayCommand) => Promise<{ success: boolean; error?: string }>
  onVerticalRailOverlayCommand: (callback: (command: VerticalRailOverlayCommand) => void) => () => void
  onVerticalRailOverlaySnapshot: (callback: (snapshot: VerticalRailOverlaySnapshot) => void) => () => void
  showBrowserLockOverlay: (payload: BrowserLockOverlaySnapshot) => Promise<BrowserLockOverlayIPCResult<void>>
  hideBrowserLockOverlay: () => Promise<BrowserLockOverlayIPCResult<void>>
  getBrowserLockOverlaySnapshot: () => Promise<BrowserLockOverlayIPCResult<BrowserLockOverlaySnapshot | null>>
  onBrowserLockOverlaySnapshot: (callback: (snapshot: BrowserLockOverlaySnapshot) => void) => () => void

  // Bookmarks
  addBookmark: (
    url: string,
    title: string,
    favicon?: string
  ) => Promise<{ success: boolean; id?: string; error?: string }>
  removeBookmark: (url: string) => Promise<{ success: boolean; error?: string }>
  getBookmarks: () => Promise<{ success: boolean; data?: BrowserBookmarkData[]; error?: string }>
  isBookmarked: (url: string) => Promise<{ success: boolean; bookmarked: boolean }>
  importBookmarks: () => Promise<{
    success: boolean
    canceled?: boolean
    imported?: number
    skipped?: number
    error?: string
    filePath?: string
  }>
  exportBookmarks: () => Promise<{
    success: boolean
    canceled?: boolean
    exported?: number
    error?: string
    filePath?: string
  }>
  /** P1.4 — Clip the currently active BrowserView tab into the
   * obsidian-web-clip outputs folder. Triggered by the renderer (slash
   * command / toolbar button); there is no equivalent model-facing tool.
   * Returns `{ ok: false, errorKind, recoverable, errorDetail }` on
   * failure; on success returns the saved-note metadata. */
  clipCurrentTab: (args?: {
    tab_id?: string | null
    preset?: string | null
    preset_file?: string | null
    output_subdir?: string | null
    flatten_path?: boolean
    preserve_pagination?: boolean
    force_render_with_placeholders?: boolean
    target_hint?: string
    target_dir?: string
  }) => Promise<{
    ok: boolean
    errorKind?:
      | 'clip_no_active_tab'
      | 'clip_parse_failed'
      | 'clip_active_tab_unstable'
      | 'clip_fetch_failed'
      | 'clip_preset_render_failed'
      | 'clip_login_required'
      | 'clip_write_blocked'
    recoverable?: boolean
    errorDetail?: Record<string, unknown>
    savedPath?: string
    savedPathRelative?: string
    suggestedVaultRelativePath?: string
    preset?: { id: string; name: string }
    frontmatter?: Record<string, string | string[]>
    title?: string
    url?: string
    copiedPath?: string
    assetPaths?: string[]
    imageDownloadFailures?: number
    copyError?: {
      kind: string
      message: string
    }
    warnings?: string[]
    sanitizationSummary?: Record<string, number>
  }>
  onClipCurrentTabRequested: (callback: (data: { url?: string }) => void) => () => void
  /** Background clip triggered by dragging a browser tab onto FileTree.
   * `invoke` resolves immediately with `{ ok, taskId }`; live progress is
   * pushed via `onClipBackgroundUpdate`. Not exposed to the model. */
  clipDraggedTab: (args: {
    url: string
    title?: string
    preset?: string | null
    preset_file?: string | null
    output_subdir?: string | null
    flatten_path?: boolean
    force_render_with_placeholders?: boolean
    target_hint?: string
    target_dir?: string
    client_task_id?: string
  }) => Promise<{
    ok: boolean
    taskId?: string
    errorKind?: 'invalid_url' | 'invalid_args'
    errorDetail?: { message: string }
  }>
  onClipBackgroundUpdate: (
    callback: (
      data:
        | {
            taskId: string
            status: 'running'
            url: string
            title?: string
            targetHint?: string
          }
        | {
            taskId: string
            status: 'completed'
            url: string
            title?: string
            targetHint?: string
            savedPath: string
            savedPathRelative: string
            suggestedVaultRelativePath: string
            copiedPath?: string
            assetPaths?: string[]
            imageDownloadFailures?: number
            copyError?: {
              kind:
                | 'invalid_target'
                | 'not_a_directory'
                | 'sandbox_read_failed'
                | 'target_write_failed'
                | 'sandbox_unlink_failed'
              message: string
            }
            preset: { id: string; name: string }
            frontmatter: Record<string, string | string[]>
            warnings: string[]
          }
        | {
            taskId: string
            status: 'failed'
            url: string
            title?: string
            targetHint?: string
            errorKind:
              | 'clip_fetch_failed'
              | 'clip_parse_failed'
              | 'clip_preset_render_failed'
              | 'clip_login_required'
              | 'clip_write_blocked'
              | 'clip_active_tab_unstable'
              | 'unexpected'
            recoverable: boolean
            errorDetail?: Record<string, unknown>
          },
    ) => void,
  ) => () => void
  /** Drag-tab "内容学习" pipeline. Acks immediately with both task ids; clip
   * progress streams through `onClipBackgroundUpdate` (existing channel) and
   * the study-phase progress through `onContentStudyUpdate`. Not exposed to
   * the model. */
  contentStudyDraggedTab: (args: {
    url: string
    title?: string
    target_hint?: string
    target_dir?: string
    client_task_id_clip?: string
    client_task_id_study?: string
  }) => Promise<{
    ok: boolean
    clipTaskId?: string
    studyTaskId?: string
    errorKind?: 'invalid_url' | 'invalid_args'
    errorDetail?: { message: string }
  }>
  onContentStudyUpdate: (
    callback: (
      data:
        | {
            kind: 'study'
            taskId: string
            status: 'waiting_for_clip' | 'running'
            url: string
            title?: string
            targetHint?: string
          }
        | {
            kind: 'study'
            taskId: string
            status: 'completed'
            url: string
            title?: string
            targetHint?: string
            copiedPath: string
          }
        | {
            kind: 'study'
            taskId: string
            status: 'failed' | 'skipped'
            url: string
            title?: string
            targetHint?: string
            errorKind:
              | 'clip_failed'
              | 'clip_target_dir_failed'
              | 'no_ai_config'
              | 'skill_md_missing'
              | 'clip_output_unreadable'
              | 'ai_failed'
              | 'write_failed'
              | 'user_too_large'
              | 'unexpected'
            errorMessage?: string
          },
    ) => void,
  ) => () => void
  onBookmarksChanged: (callback: (data: BrowserBookmarksChangedEvent) => void) => () => void

  // History
  getHistory: (
    limit?: number
  ) => Promise<{ success: boolean; data?: BrowserHistoryData[]; error?: string }>
  clearHistory: () => Promise<{ success: boolean; error?: string }>
  searchHistory: (
    query: string
  ) => Promise<{ success: boolean; data?: BrowserHistoryData[]; error?: string }>

  // Downloads
  getDownloads: () => Promise<{ success: boolean; data?: BrowserDownloadData[]; error?: string }>
  clearDownloads: () => Promise<{ success: boolean; error?: string }>
  downloadUrlToDirectory: (payload: {
    url: string
    targetDir: string
    sourcePageUrl?: string | null
    suggestedName?: string | null
    downloadHeaders?: Record<string, string> | null
  }) => Promise<{ success: boolean; savePath?: string; filename?: string; error?: string }>
  onDownloadUpdate: (callback: (data: BrowserDownloadUpdateEvent) => void) => () => void

  // Privacy — clear browsing data & cookie management
  getPrivacySummary: () => Promise<{ success: boolean; data?: BrowserPrivacySummary; error?: string }>
  clearBrowsingData: (payload: {
    dataTypes: BrowsingDataType[]
    sinceEpochSeconds?: number
  }) => Promise<{ success: boolean; data?: ClearBrowsingDataResult; error?: string }>
  listCookies: () => Promise<{ success: boolean; data?: BrowserCookieDomainGroup[]; error?: string }>
  removeCookie: (payload: {
    domain: string
    path: string
    name: string
    secure: boolean
  }) => Promise<{ success: boolean; data?: { removed: number }; error?: string }>
  removeCookiesForDomain: (
    payload: { domain: string }
  ) => Promise<{ success: boolean; data?: { removed: number }; error?: string }>

  showUtilityMenu: (payload: BrowserUtilityMenuRequest) => Promise<{ success: boolean; error?: string }>

  // Print
  print: (tabId: string) => Promise<{ success: boolean; error?: string }>
}

// =============================================================================
// Document API Types
// =============================================================================

/** File item returned by document:list */
interface DocumentFileItem {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modified: Date | string
}

/** Text file data from document:read */
interface DocumentReadTextData {
  type: 'text'
  content: string
}

/** Binary file data from document:read */
interface DocumentReadBinaryData {
  type: 'binary'
  category: 'image' | 'video' | 'audio' | 'pdf' | 'ebook' | 'binary'
  localUrl: string
  extension: string
  /** Raw bytes are attached for PDF/ebook previews to avoid custom-protocol fetch issues. */
  bytes?: Uint8Array | ArrayBuffer | number[]
  /** File byte size from a pre-read stat (added by the D2 perf size guard). */
  size?: number
  /**
   * Set when the file is too large to inline — renderer should stream via `localUrl`
   * (e.g. `<video src={localUrl}>`) instead of attempting a base64/byte fetch.
   */
  kind?: 'large_video_ref' | 'large_image_ref'
}

/** Read file response */
interface DocumentReadResponse {
  success: boolean
  data?: DocumentReadTextData | DocumentReadBinaryData
  /** Backward-compat top-level content (only for text files) */
  content?: string
  error?: string
  errorCode?: string
  /** When refused due to a size guard, the configured max byte cap. */
  max?: number
  /** When refused due to a size guard, the actual byte size. */
  actual?: number
  mock?: boolean
}

/** Write file response */
interface DocumentWriteResponse {
  success: boolean
  error?: string
  mock?: boolean
}

interface DocumentSaveAsResponse {
  success: boolean
  path?: string
  canceled?: boolean
  error?: string
  errorCode?: string
  /** When refused due to a size guard (D2 perf), the configured max byte cap. */
  max?: number
  /** When refused due to a size guard, the actual decoded byte length. */
  actual?: number
  mock?: boolean
}

/** List directory response */
interface DocumentListResponse {
  success: boolean
  items?: DocumentFileItem[]
  error?: string
  errorCode?: string
  mock?: boolean
}

/** DOCX parse result data */
interface DocumentDocxData {
  html: string
  rawText: string
  messages?: Array<{ type: string; message: string }>
}

/** DOCX parse response */
interface DocumentDocxResponse {
  success: boolean
  data?: DocumentDocxData
  /** Backward-compat top-level content */
  content?: string
  html?: string
  file?: string
  error?: string
  errorCode?: string
  mock?: boolean
}

/** Single sheet in XLSX result */
interface DocumentXlsxSheet {
  name: string
  data: unknown[][]
}

/** XLSX parse result data */
interface DocumentXlsxData {
  sheets: DocumentXlsxSheet[]
}

/** XLSX parse response */
interface DocumentXlsxResponse {
  success: boolean
  data?: DocumentXlsxData
  /** Backward-compat: sheet names */
  sheets?: string[]
  /** Backward-compat: flat data map keyed by sheet name */
  sheetData?: Record<string, unknown[][]>
  file?: string
  error?: string
  errorCode?: string
  mock?: boolean
}

interface DocumentEbookImportResponse {
  success: boolean
  outputDir?: string
  indexPath?: string
  assetCount?: number
  warnings?: string[]
  error?: string
  errorCode?: string
  mock?: boolean
}

/** File stat structured data */
interface DocumentStatData {
  size: number
  modifiedTime: number
  createdTime: number
  isDirectory: boolean
  extension: string | null
}

/** Legacy stat shape (backward compat) */
interface DocumentStatLegacy {
  size: number
  isDirectory: boolean
  modified: Date | string
  created?: Date | string
}

/** Stat response */
interface DocumentStatResponse {
  success: boolean
  data?: DocumentStatData
  stat?: DocumentStatLegacy
  error?: string
  mock?: boolean
}

/** Simple success/failure response for file operations (mkdir, rename, delete, copy, move, showInFolder, createFile) */
interface DocumentOperationResponse {
  success: boolean
  error?: string
  mock?: boolean
  path?: string
}

/** Open folder dialog response */
interface DocumentOpenFolderResponse {
  success: boolean
  path?: string
  error?: string
  /** Present when validateAsWorkspace failed; mirrors WorkspaceValidationReason. */
  validationReason?: string
  /** The path the user picked, even if validation rejected it. */
  attemptedPath?: string
}

/** Get home directory response */
interface DocumentHomeResponse {
  success: boolean
  path: string
}

interface DocumentWatchDirectoriesResponse {
  success: boolean
  data?: {
    watchedPaths: string[]
  }
  error?: string
  mock?: boolean
}

interface DocumentMarksResponse {
  success: boolean
  data?: DocumentMarkRecord[]
  error?: string
  mock?: boolean
}

interface DocumentMarkResponse {
  success: boolean
  data?: DocumentMarkRecord
  error?: string
  mock?: boolean
}

interface DocumentDeleteMarkResponse {
  success: boolean
  deleted?: boolean
  error?: string
  mock?: boolean
}

interface ElectronDocumentAPI {
  readFile: (path: string) => Promise<DocumentReadResponse>
  writeFile: (path: string, content: string) => Promise<DocumentWriteResponse>
  saveFileAs: (payload: {
    content?: string
    contentBase64?: string
    suggestedName?: string
    defaultPath?: string | null
  }) => Promise<DocumentSaveAsResponse>
  listFiles: (dir: string) => Promise<DocumentListResponse>
  parseDocx: (path: string) => Promise<DocumentDocxResponse>
  parseXlsx: (path: string) => Promise<DocumentXlsxResponse>
  importEbookAsMarkdown: (payload: { sourcePath: string }) => Promise<DocumentEbookImportResponse>
  // File management
  mkdir: (path: string) => Promise<DocumentOperationResponse>
  rename: (oldPath: string, newPath: string) => Promise<DocumentOperationResponse>
  deleteItem: (path: string) => Promise<DocumentOperationResponse>
  copyItem: (src: string, dest: string) => Promise<DocumentOperationResponse>
  moveItem: (src: string, dest: string) => Promise<DocumentOperationResponse>
  stat: (path: string) => Promise<DocumentStatResponse>
  openFolder: (payload?: { validateAsWorkspace?: boolean; title?: string }) => Promise<DocumentOpenFolderResponse>
  exportWorkspace: (payload: { name: string; folders: string[] }) => Promise<
    | { success: true; path: string; name: string }
    | { success: false; error: string }
  >
  importWorkspace: () => Promise<
    | { success: true; path: string; name: string; folders: string[] }
    | { success: false; error: string }
  >
  exportPdf: (payload: DocumentExportPdfPayload) => Promise<DocumentExportResult>
  exportMarkdownBundle: (payload: DocumentExportMarkdownBundlePayload) => Promise<DocumentExportResult>
  getHome: () => Promise<DocumentHomeResponse>
  showInFolder: (path: string) => Promise<DocumentOperationResponse>
  openPath: (path: string) => Promise<DocumentOperationResponse>
  createFile: (path: string) => Promise<DocumentOperationResponse>
  watchDirectories: (paths: string[]) => Promise<DocumentWatchDirectoriesResponse>
  onDirectoryChange: (
    callback: (data: { paths: string[]; timestamp: number }) => void
  ) => () => void
  notifyWidgetCommitted?: (payload: {
    tabId: string
    widgetId: string
    requestId?: string
    committedAt: number
  }) => void
  reindexWorkspace: (root: string) => Promise<DocumentReindexWorkspaceResponse>
  indexDocument: (payload: { path: string; root?: string; content?: string }) => Promise<DocumentIndexDocumentResponse>
  searchIndex: (payload: {
    query: string
    limit?: number
    workspaceRoot?: string
    workspaceRoots?: string[]
    sources?: string[]
  }) => Promise<DocumentSearchIndexResponse>
  reindexAllSources: (root: string) => Promise<DocumentReindexAllSourcesResponse>
  listSources: () => Promise<DocumentListSourcesResponse>
  getBacklinks: (payload: { path: string; limit?: number }) => Promise<DocumentBacklinksResponse>
  getGraph: (payload?: { centerPath?: string; depth?: number; workspaceRoot?: string }) => Promise<DocumentGraphResponse>
  listMarks: (payload: { documentPath: string }) => Promise<DocumentMarksResponse>
  createMark: (payload: DocumentMarkDraft) => Promise<DocumentMarkResponse>
  updateMark: (payload: { id: string; patch: DocumentMarkPatch }) => Promise<DocumentMarkResponse>
  deleteMark: (payload: { id: string }) => Promise<DocumentDeleteMarkResponse>
  startWatcher: (payload: { workspaceRoot: string }) => Promise<DocumentStartWatcherResponse>
  stopWatcher: (payload: { watcherId: string }) => Promise<DocumentStopWatcherResponse>
}

interface BoardOpenData {
  boardId: string
  path: string
  state: ReadyBoardState
}

interface BoardExternalImageEventData {
  boardId: string
  path: string
  asset: ReadyBoardAsset
  state: ReadyBoardState
}

interface ElectronBoardAPI {
  create: (payload: { parentDir: string }) => Promise<IPCResponse<BoardOpenData>>
  open: (payload: { path: string }) => Promise<IPCResponse<BoardOpenData>>
  setActive: (payload: { boardId: string | null }) => Promise<IPCResponse>
  save: (payload: { boardId: string; state: ReadyBoardState }) => Promise<IPCResponse<BoardOpenData>>
  importAsset: (payload: {
    boardId: string
    srcPath: string
    kind?: ReadyBoardAssetKind
  }) => Promise<IPCResponse<ReadyBoardAsset>>
  importRemoteImage: (payload: { boardId: string; url: string }) => Promise<IPCResponse<ReadyBoardAsset>>
  pickAsset: (payload: {
    boardId: string
    kind?: ReadyBoardAssetKind | 'any'
  }) => Promise<IPCResponse<ReadyBoardAsset>>
  openInDocument: (payload: { boardId: string; relativePath: string }) => Promise<IPCResponse<{ path: string }>>
  onActiveBoardExternalImageAdded: (
    callback: (data: IPCResponse<BoardExternalImageEventData>) => void
  ) => () => void
}

interface DocumentStartWatcherResponse {
  success: boolean
  data?: { watcherId: string; workspaceRoot: string }
  error?: string
  /** When success=false, surfaces why so the renderer can show the right toast. */
  errorKind?: 'invalid_root' | 'enospc' | 'failed' | 'engine_unavailable'
  /** Linux ENOSPC advisory string — `sudo sysctl fs.inotify.max_user_watches=…`. */
  hint?: string
}

interface DocumentStopWatcherResponse {
  success: boolean
  data?: { stopped: boolean }
  error?: string
}

interface DocumentBacklinkReference {
  path: string
  name: string
  kind: string
}

interface DocumentBacklinksResponse {
  success: boolean
  data?: { references: DocumentBacklinkReference[] }
  error?: string
}

interface DocumentGraphNode {
  id: string
  type: 'doc' | 'tag' | 'ghost'
  label: string
  sourceType?: string
}

interface DocumentGraphEdge {
  source: string
  target: string
  kind: string
}

interface DocumentGraphResponse {
  success: boolean
  data?: { nodes: DocumentGraphNode[]; edges: DocumentGraphEdge[] }
  error?: string
}

interface DocumentSearchHit {
  path: string
  name: string
  snippet: string
  rank: number
  nameMatch: boolean
  tagsHit: string[]
  linksHit: string[]
  sourceType: string
  sourceMeta?: Record<string, unknown> | null
}

interface DocumentAdapterReindexResult {
  indexed: number
  skipped: number
  removed: number
  scanned: number
  error?: string
}

interface DocumentReindexAllSourcesResult {
  ok: boolean
  perSource: Record<string, DocumentAdapterReindexResult>
  elapsedMs: number
}

interface DocumentReindexAllSourcesResponse {
  success: boolean
  data?: DocumentReindexAllSourcesResult
  error?: string
  /**
   * When success=false, surfaces why the request was rejected. Aligned with
   * `document:startWatcher` so the renderer can branch on the same vocabulary.
   * `invalid_root` covers unsafe workspace roots (`~`, `/Users/<x>`, etc).
   */
  errorKind?: 'invalid_root' | 'engine_unavailable' | 'failed'
  /** Populated when errorKind='invalid_root', mirrors validateWorkspaceRoot.reason. */
  validationReason?: string
  /** Optional advisory hint (matches startWatcher's hint shape). */
  hint?: string
}

interface DocumentListSourcesResponse {
  success: boolean
  data?: { sources: string[] }
  error?: string
}

interface DocumentSearchIndexResult {
  items: DocumentSearchHit[]
  stats: { returned: number; elapsedMs: number }
  degraded: boolean
}

interface DocumentSearchIndexResponse {
  success: boolean
  data?: DocumentSearchIndexResult
  error?: string
  errorKind?: 'invalid_root' | 'engine_unavailable' | 'failed'
  validationReason?: string
}

interface DocumentReindexWorkspaceResult {
  ok: boolean
  root: string
  workspaceId: number
  indexed: number
  skipped: number
  removed: number
  scanned: number
  elapsedMs: number
  degraded: boolean
  error?: string
}

interface DocumentReindexWorkspaceResponse {
  success: boolean
  data?: DocumentReindexWorkspaceResult
  error?: string
  /**
   * When success=false, surfaces why the request was rejected. Aligned with
   * `document:startWatcher` and `reindexAllSources` so renderers branch on
   * one vocabulary.
   */
  errorKind?: 'invalid_root' | 'engine_unavailable' | 'failed'
  validationReason?: string
  hint?: string
}

interface DocumentIndexDocumentResult {
  ok: boolean
  documentId?: number
  skipped?: boolean
  error?: string
}

interface DocumentIndexDocumentResponse {
  success: boolean
  data?: DocumentIndexDocumentResult
  error?: string
}

// =============================================================================
// RSS API Types
// =============================================================================

/** RSS source record */
interface RSSSourceData {
  id: string
  name: string
  url: string
  group?: string
  enabled?: boolean
  platform?: string
}

interface RSSDraftStoreSourceData {
  sourceId: string
  sourceName: string
  sourceUrl: string
  platform: string
  storedCount: number
  inboxCount: number
  starredCount: number
  refreshMode: 'full' | 'incremental'
  lastFetchedAt: string | null
}

/** RSS item record */
interface RSSItemData {
  id: string
  sourceId: string
  title: string
  link: string
  summary: string
  author?: string
  source?: string
  publishedAt: string
  inboxVisible?: boolean
  read: boolean
  starred: boolean
  coverImage?: string | null
  aiScore?: number | null
  aiTags?: string | null
}

/** Input for adding an RSS source */
interface RSSAddSourceInput {
  name?: string
  url: string
  group?: string
}

/** Unified RSS response shape (all RSS handlers use { success, mock, data?, error? }) */
interface RSSResponse<T> {
  success: boolean
  mock: boolean
  data?: T
  error?: string
}

type RSSAnalysisAction = 'copy' | 'visual'
type RSSAnalysisJobStatus =
  | 'queued'
  | 'paused'
  | 'running_script'
  | 'running_subagent'
  | 'success'
  | 'failed'
  | 'skipped'

interface RSSAnalysisJobData {
  id: string
  itemId: string
  action: RSSAnalysisAction
  sourceUrl: string
  title: string
  targetDir: string
  outputDir: string
  reportPath: string | null
  status: RSSAnalysisJobStatus
  progress: number
  message: string | null
  error: string | null
  meta: Record<string, unknown> | null
  createdAt: string
  startedAt: string | null
  updatedAt: string
  finishedAt: string | null
}

interface RSSItemAnalysisProgress {
  itemId: string
  jobId: string
  action: RSSAnalysisAction
  status: RSSAnalysisJobStatus
  progress: number
  message: string | null
  error: string | null
  outputDir: string
  reportPath: string | null
  updatedAt: string
}

interface ElectronRSSAPI {
  getSources: () => Promise<RSSResponse<RSSSourceData[]>>
  addSource: (source: RSSAddSourceInput) => Promise<
    RSSResponse<{
      id: string
      platform?: string
      name?: string
      itemCount?: number
      warning?: string
    }>
  >
  removeSource: (id: string) => Promise<RSSResponse<{ removed: boolean }>>
  getItems: (sourceId?: string) => Promise<RSSResponse<RSSItemData[]>>
  getDraftStoreSources: () => Promise<RSSResponse<RSSDraftStoreSourceData[]>>
  markRead: (itemId: string) => Promise<RSSResponse<{ marked: boolean }>>
  markReadBatch: (itemIds: string[]) => Promise<RSSResponse<{ marked: number }>>
  deleteItems: (
    payload: string[] | { itemIds: string[]; preserveStarred?: boolean }
  ) => Promise<RSSResponse<{ deleted: number; dismissed?: number }>>
  toggleStarred: (itemId: string) => Promise<RSSResponse<{ toggled: boolean }>>
  clearDraftStore: (payload?: {
    sourceId?: string
  }) => Promise<RSSResponse<{ deletedItems: number; resetSources: number }>>
  refreshSource: (
    sourceId: string
  ) => Promise<RSSResponse<import('../modules/rss/types').RSSRefreshSourceResultData>>
  fetchAll: (options?: {
    digest?: boolean
    classification?: 'simple' | 'none'
    group?: string
    sourceIds?: string[]
  }) => Promise<
    RSSResponse<{
      message: string
      fetched: number
      digest?: boolean
      running?: boolean
      errors?: string[]
      status?: unknown
    }>
  >
  status: () => Promise<RSSResponse<RSSStatusData>>
  stats: () => Promise<
    RSSResponse<{
      totalSources: number
      totalItems: number
      unreadItems: number
      platformDistribution: Record<string, number>
      categoryDistribution: Record<string, number>
    }>
  >
  diagnostics: () => Promise<RSSResponse<RSSDiagnosticsData>>
  benchmarkSources: (options?: {
    group?: string
    sourceIds?: string[]
  }) => Promise<RSSResponse<RSSBenchmarkResultData>>
  repairRuntime: () => Promise<
    RSSResponse<{ repaired: boolean; mock?: boolean; rsshub?: RSSHubRuntimeStatusData }>
  >
  exportOpml: () => Promise<RSSResponse<{ path: string }>>
  exportFeed: (
    type?: 'master' | 'tech' | 'humanities' | 'design' | 'entertainment' | 'others'
  ) => Promise<RSSResponse<{ path: string }>>
  startItemAnalysis: (payload: {
    itemId: string
    action: RSSAnalysisAction
    link: string
    title: string
    targetDir: string
    source?: string
    summary?: string
    publishedAt?: string
    force?: boolean
  }) => Promise<RSSResponse<RSSAnalysisJobData>>
  getItemAnalysisProgress: (payload?: {
    itemIds?: string[]
  }) => Promise<RSSResponse<Record<string, RSSItemAnalysisProgress>>>
  listItemAnalysisJobs: (payload?: {
    itemId?: string
    limit?: number
  }) => Promise<RSSResponse<RSSAnalysisJobData[]>>
  pauseAnalysisJob: (payload: {
    jobId: string
  }) => Promise<RSSResponse<{ paused: boolean; job?: RSSAnalysisJobData }>>
  resumeAnalysisJob: (payload: {
    jobId: string
  }) => Promise<RSSResponse<{ resumed: boolean; job?: RSSAnalysisJobData }>>
  deleteAnalysisJob: (payload: {
    jobId: string
  }) => Promise<RSSResponse<{ deleted: boolean; reason?: string }>>
}

// =============================================================================
// Calendar API Types
// =============================================================================

/** Calendar source record */
interface CalendarSourceData {
  id: string
  name: string
  color: string
  type?: string
  enabled: boolean
}

/** Reminder offset definition; offsetMinutes < 0 = before event start. */
interface CalendarReminderInput {
  offsetMinutes: number
  method: 'notification' | 'sound'
}

/**
 * Calendar event record as it crosses the IPC boundary.
 *
 * Wire contract — this MUST match `CalendarEventWire` in
 * `src/shared/calendar-wire.ts`:
 *   - Time fields (`startTime` / `endTime` / `createdAt` / `updatedAt` /
 *     `occurrenceStart`) are Unix **SECONDS** (not milliseconds, not ISO
 *     strings). The renderer converts via `parseEventFromWire(...)`; no
 *     other call site should construct `new Date(...)` from these values
 *     directly — multiplying by 1000 is the boundary helper's job.
 *   - `allDay` is `boolean` on the wire (the legacy `0 | 1` row form is
 *     normalized by `serializeEventToWire` before IPC).
 *
 * Pre-fix this type declared `startTime: string` even though the live
 * IPC handed back integers, which let callers write `new Date(value)`
 * and land in 1970. Keeping the wire type honest is the type-level
 * counterpart to the `calendar-wire-round-trip` test gate.
 */
interface CalendarEventData {
  id: string
  calendarId: string
  title: string
  description?: string | null
  location?: string | null
  /** Unix SECONDS. */
  startTime: number
  /** Unix SECONDS. */
  endTime: number
  allDay: boolean
  reminders?: CalendarReminderInput[] | null
  /**
   * L3-B — RFC 5545 RRULE body. Null / empty means non-recurring.
   * Returned only on the parent row; expanded EventInstance rows carry
   * the parent's RRULE here too so the renderer can detect "this is
   * an instance, not a single event".
   */
  recurrenceRule?: string | null
  /**
   * L3-B — set on EventInstance rows produced by the rrule engine
   * expansion. For non-recurring single events this equals `id`; for
   * recurring instances it equals the parent event id (without the
   * `#<occurrenceStart>` suffix).
   */
  instanceOf?: string
  /** L3-B — Unix seconds of the ORIGINAL (pre-patch) occurrence start. */
  occurrenceStart?: number
  /** L3-B — `'single' | 'cancelled' | null`; the kind of override
   * applied to this instance (or null if no override). */
  overrideKind?: 'single' | 'cancelled' | null
  /**
   * L4-A — IANA timezone identifier for the start wall-clock; null
   * means "local timezone" (back-compat for pre-039 rows). The renderer
   * uses this together with `useCalendarSession.displayTimezone` to
   * decide how to format the start time.
   */
  startTz?: string | null
  /** L4-A — IANA timezone identifier for the end wall-clock; null = local. */
  endTz?: string | null
  /** Unix SECONDS. */
  createdAt?: number
  /** Unix SECONDS. */
  updatedAt?: number
  /** Renderer key for `EventInstance` (recurring): `${parent}#${occurrence}`.
   *  Equal to `id` for non-recurring events. Required only on the wire
   *  contract; declared optional here to keep migration smooth with older
   *  consumers that ignore the field. */
  syntheticId?: string
  /** L4-B — external ICS UID; null for local events. */
  icsUid?: string | null
  /** L4-B — `calendar_sources.id` when sourced from external sync; null for local. */
  sourceId?: string | null
}

/** Input for creating a calendar event */
interface CalendarCreateEventInput {
  calendarId: string
  title: string
  description?: string
  location?: string
  startTime: Date | string | number
  endTime: Date | string | number
  allDay?: boolean
  reminders?: CalendarReminderInput[] | null
  /** L3-B — RFC 5545 RRULE body or null for non-recurring. */
  recurrenceRule?: string | null
  /** L4-A — IANA tz id; null / undefined = local timezone. */
  startTz?: string | null
  /** L4-A — IANA tz id; null / undefined = local timezone. */
  endTz?: string | null
  [key: string]: unknown
}

/** Input for updating a calendar event (partial) */
interface CalendarUpdateEventInput {
  title?: string
  description?: string
  location?: string
  calendarId?: string
  startTime?: Date | string | number
  endTime?: Date | string | number
  allDay?: boolean
  reminders?: CalendarReminderInput[] | null
  /** L3-B — set / clear the parent's RRULE. */
  recurrenceRule?: string | null
  /** L4-A — set / clear the IANA start tz; null = local. */
  startTz?: string | null
  /** L4-A — set / clear the IANA end tz; null = local. */
  endTz?: string | null
  [key: string]: unknown
}

/** L3-B — payload for "modify this single occurrence" / "skip this occurrence". */
interface CalendarUpsertEventOverrideInput {
  parentEventId: string
  /** Unix seconds, ISO string, or Date. */
  occurrenceStart: number | string | Date
  kind: 'single' | 'cancelled'
  patch?: {
    title?: string
    description?: string | null
    location?: string | null
    startTime?: number | string | Date
    endTime?: number | string | Date
    allDay?: boolean
    reminders?: CalendarReminderInput[] | null
    /** L4-A — per-occurrence start tz; null clears. */
    startTz?: string | null
    /** L4-A — per-occurrence end tz; null clears. */
    endTz?: string | null
  }
}

/** L3-B — payload for "modify this and all future occurrences". */
interface CalendarSplitRecurringSeriesInput {
  parentEventId: string
  occurrenceStart: number | string | Date
  patch: {
    title?: string
    description?: string | null
    location?: string | null
    startTime?: number | string | Date
    endTime?: number | string | Date
    allDay?: boolean
    reminders?: CalendarReminderInput[] | null
    recurrenceRule?: string | null
    calendarId?: string
    /** L4-A — start tz for the new series; null = local. */
    startTz?: string | null
    /** L4-A — end tz for the new series; null = local. */
    endTz?: string | null
  }
}

/** Unified calendar response shape (all calendar handlers use { success, mock, data?, error? }) */
interface CalendarResponse<T> {
  success: boolean
  mock: boolean
  data?: T
  error?: string
}

/**
 * Payload pushed from main → renderer when a reminder fires. Mirrors
 * the shared `ReminderFirePayload` in `src/shared/calendar-types.ts`
 * (which is the single source of truth). Duplicated here because this
 * file is a renderer-internal `declare global` ambient type and pulling
 * a value import would shift it out of the ambient namespace.
 */
interface CalendarReminderFirePayload {
  eventId: string
  eventTitle: string
  /** Unix seconds. */
  eventStartTime: number
  offsetMinutes: number
  method: 'notification' | 'sound'
  /** Unix seconds. */
  firedAt: number
}

/**
 * L4-B — payload shape for `calendar:importIcsString`. The renderer
 * reads the .ics file (FileReader / drop-zone) and ships the string;
 * we don't accept file paths because the renderer doesn't have
 * filesystem access.
 */
interface CalendarImportIcsInput {
  rawIcs: string
  calendarSourceId?: string
  sourceName?: string
}

/**
 * L4-B — payload shape for `calendar:subscribeUrl`. `color` is optional
 * (defaults to the DB default `#5B8DEF`); `syncIntervalMinutes` defaults
 * to 60 and is floored at 5 minutes on the main side.
 */
interface CalendarSubscribeUrlInput {
  url: string
  name: string
  color?: string
  syncIntervalMinutes?: number
}

/**
 * L4-B — result shape emitted per source by the sync scheduler. Used
 * as the data payload of `calendar:syncSourceNow` so the renderer can
 * surface created / updated / removed counts in the source list.
 */
interface CalendarSyncResult {
  sourceId: string
  ok: boolean
  eventsCreated: number
  eventsUpdated: number
  eventsRemoved: number
  error: string | null
}

interface ElectronCalendarAPI {
  getSources: () => Promise<CalendarResponse<CalendarSourceData[]>>
  getEvents: (start: Date, end: Date) => Promise<CalendarResponse<CalendarEventData[]>>
  createEvent: (event: CalendarCreateEventInput) => Promise<CalendarResponse<{ id: string }>>
  updateEvent: (
    id: string,
    event: CalendarUpdateEventInput
  ) => Promise<CalendarResponse<{ updated: boolean }>>
  deleteEvent: (id: string) => Promise<CalendarResponse<{ deleted: boolean }>>
  /**
   * L3-B — per-occurrence override CRUD. See `CalendarUpsertEventOverrideInput`
   * and `CalendarSplitRecurringSeriesInput` for the payload shape.
   */
  upsertEventOverride: (
    payload: CalendarUpsertEventOverrideInput
  ) => Promise<CalendarResponse<{ id: string }>>
  deleteEventOverride: (
    payload: { parentEventId: string; occurrenceStart: number | string | Date }
  ) => Promise<CalendarResponse<{ deleted: boolean }>>
  splitRecurringSeries: (
    payload: CalendarSplitRecurringSeriesInput
  ) => Promise<CalendarResponse<{ newEventId: string }>>
  /**
   * L4-B — import a raw .ics body string into a calendar source.
   * When `calendarSourceId` is omitted the handler auto-creates a
   * new source named `sourceName` (or `'导入的日历'` if also absent).
   */
  importIcsString: (
    payload: CalendarImportIcsInput
  ) => Promise<CalendarResponse<{
    sourceId: string
    created: number
    updated: number
    skipped: number
  }>>
  /**
   * L4-B — subscribe to an ICS URL. Creates a `calendar_sources` row,
   * runs an immediate first sync, then registers a periodic timer.
   * `initialEvents` is the created + updated count from the first sync.
   */
  subscribeUrl: (
    payload: CalendarSubscribeUrlInput
  ) => Promise<CalendarResponse<{ sourceId: string; initialEvents: number }>>
  /**
   * L4-B — unsubscribe / delete a calendar source. FK CASCADE drops
   * all events owned by the source. Returns `removed: false` when
   * the source didn't exist (idempotent).
   */
  unsubscribeSource: (
    sourceId: string
  ) => Promise<CalendarResponse<{ removed: boolean }>>
  /**
   * L4-B — manually trigger a sync for one source. The reply carries
   * the full SyncResult so the UI can show counts inline.
   */
  syncSourceNow: (
    sourceId: string
  ) => Promise<CalendarResponse<CalendarSyncResult>>
  /**
   * L2-B — subscribe to reminder fire events. Returns an unsubscriber.
   */
  onReminderFired: (
    handler: (payload: CalendarReminderFirePayload) => void
  ) => () => void
  /**
   * L5-B — natural-language time-expression detection used by the RSS
   * reader to surface "create calendar event?" hints. The renderer
   * sends plain text (HTML must be stripped beforehand). Returns the
   * sorted list of matches; the consumer is responsible for filtering
   * confidence tiers it doesn't want to show. The main handler returns
   * an empty list when mock mode is enabled.
   */
  detectTimeExpressions: (
    payload: { text: string; referenceDate?: string | number }
  ) => Promise<CalendarResponse<CalendarDetectedTimeExpression[]>>

  /**
   * L5-C-Universal — detect calendar events in a single remote-channel
   * message envelope. Channel-agnostic: works for feishu / telegram /
   * imessage / discord / wechat / slack / generic-webhook (and any
   * future adapter that produces a `RemoteChannelMessage`). The main
   * side applies per-channel policy (registry default OR per-channel
   * user override) and confidence filtering before returning. Returns
   * `[]` whenever policy says "don't detect" — there is no separate
   * error path for "channel disabled".
   */
  detectRemoteChannelEvent: (
    payload: {
      message: import('../../shared/calendar-remote-channel').RemoteChannelMessage
      autoDetectOverride?: boolean | null
      minConfidence?: 'high' | 'medium' | 'low'
    }
  ) => Promise<CalendarResponse<
    import('../../shared/calendar-remote-channel').RemoteCalendarEventSuggestion[]
  >>

  /** Registry enumeration for the settings UI — one entry per known
   *  remote channel kind (display name, icon hint, default policy). */
  listRemoteChannelEntries: () => Promise<CalendarResponse<
    Array<{
      kind: import('../../shared/calendar-remote-channel').RemoteChannelKind
      displayName: string
      iconKey: string
      autoDetectByDefault: boolean
    }>
  >>

  /** Push subscription: the inbound-channel pipeline (runtime.ts) calls
   *  this whenever a freshly-received remote message yields suggestions.
   *  Returns an unsubscribe function. */
  onRemoteEventSuggested: (
    handler: (
      suggestion: import('../../shared/calendar-remote-channel').RemoteCalendarEventSuggestion,
    ) => void,
  ) => () => void
}

/**
 * L5-B — one recognised time expression. Mirrors the
 * `DetectedTimeExpression` shape in
 * `src/main/modules/calendar-engine/time-expression-detector.ts`.
 */
type CalendarDetectedTimeConfidence = 'high' | 'medium' | 'low'

interface CalendarDetectedTimeExpression {
  /** The matched substring (e.g. `"明天下午 3 点"`). */
  text: string
  /** Inclusive UTF-16 offset of the match in the input string. */
  startIndex: number
  /** Exclusive UTF-16 offset of the match end. */
  endIndex: number
  /** Resolved start time, Unix seconds. */
  startTime: number
  /** Resolved end time, Unix seconds. Defaults to `startTime + 3600`. */
  endTime: number
  /** Whether the expression carries an explicit clock time. */
  hasTime: boolean
  /** Coarse confidence tier — drop `'low'` to skip vague phrases. */
  confidence: CalendarDetectedTimeConfidence
  /** Locale that produced this hit. */
  locale: 'en' | 'zh'
}

// =============================================================================
// Video API Types
// =============================================================================

interface ElectronVideoInfo {
  duration: number
  width: number
  height: number
  codec: string
  fps: number
  bitrate: number
  audioCodec: string | null
  format: string
  size: number
}

// =============================================================================
// Skills Runtime API Types
// =============================================================================

type SkillSource = 'embedded' | 'custom'
type SkillRuntimeKind = 'python' | 'node' | 'shell' | 'reference'
type SkillExecutionMode = 'advisory' | 'workflow' | 'direct'
type SkillConfigFieldTypeData = 'text' | 'password' | 'number' | 'boolean' | 'select'
type SkillConfigValueData = string | number | boolean | null

interface SkillServiceBindingDefinitionData {
  id: string
  label: string
  description?: string
  required?: boolean
  allowedKinds: ExternalServiceKindData[]
  defaultServiceId?: string
}

interface SkillConfigFieldDefinitionData {
  id: string
  label: string
  description?: string
  type: SkillConfigFieldTypeData
  required?: boolean
  defaultValue?: SkillConfigValueData
  options?: { value: string; label: string }[]
}

interface SkillConfigurationDefinitionData {
  version: 1
  serviceBindings: SkillServiceBindingDefinitionData[]
  fields: SkillConfigFieldDefinitionData[]
}

interface SkillConfigurationViewData {
  skillId: string
  definition: SkillConfigurationDefinitionData | null
  values: {
    serviceBindings: Record<string, string>
    fields: Record<string, SkillConfigValueData>
  }
}

interface SkillParamDefinition {
  name: string
  type: string
  description: string
  required: boolean
  enum?: string[]
}

interface SkillActionDefinition {
  name: string
  description: string
  runtime: SkillRuntimeKind
  entry: string
  timeoutMs?: number
  params: SkillParamDefinition[]
  baseArgs?: string[]
  inputMode?: 'flags' | 'json'
  visibility?: 'public' | 'internal'
}

interface SkillState {
  id: string
  name: string
  description: string
  version: string
  installed: boolean
  installStatePath: string
  source: SkillSource
  manifestValid: boolean
  defaultAction?: string
  actions: SkillActionDefinition[]
  executionMode: SkillExecutionMode
  managedPath?: string
  sourcePath?: string
  configuration?: SkillConfigurationDefinitionData
}

// Phase 4: SkillExecutionBlocker / SkillExecutionStepRecord /
// SkillArtifactRecord / SkillExecutionDetail retired along with the
// skill_executions state machine.

interface SkillInstallResult {
  success: boolean
  skillId: string
  skillPath?: string
  venvPython?: string
  error?: string
}

interface SkillRunResult {
  success: boolean
  skillId: string
  action: string
  stdout: string
  stderr: string
  outputDir?: string
  command: string[]
  error?: string
  // Phase 4: 'workflow' mode retired; only 'direct' (subprocess / in-process)
  // and 'reference' (SKILL.md inline) survive.
  mode?: 'direct' | 'reference'
  /**
   * C6 — when stdout/stderr exceeded the in-memory cap, surplus bytes are
   * appended to a per-action `.logs/` artifact under
   * `<runtimeRoot>/outputs/<skillId>/`. `*Error` is set when the disk write
   * itself failed; the command result is still returned in either case.
   */
  stdoutArtifactPath?: string
  stderrArtifactPath?: string
  stdoutArtifactError?: string
  stderrArtifactError?: string
}

interface SkillJobRecord {
  id: string
  skillId: string
  action: string
  status: string
  triggerType: 'manual' | 'tool' | 'schedule'
  scheduleId: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  stdout: string
  stderr: string
  outputDir: string | null
  error: string | null
  command: string[]
}

interface SkillScheduleRecord {
  id: string
  skillId: string
  action: string
  params: Record<string, unknown>
  intervalMinutes: number
  nextRunAt: string
  lastRunAt: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

interface SkillsRuntimeInfo {
  runtimeRoot: string
  skillsRoot: string
  customSkillsRoot: string
  outputsRoot: string
  venvRoot: string
}

interface SkillReferenceInlinedEvent {
  sessionId: string | null
  skillId: string
  skillName: string
  source: 'direct_read' | 'tool_fallback'
  bytesInjected: number
  truncated: boolean
  at: number
}

interface ElectronSkillsAPI {
  list: () => Promise<IPCResponse<SkillState[]>>
  runtimeInfo: () => Promise<IPCResponse<SkillsRuntimeInfo>>
  listExternalCandidates: () => Promise<IPCResponse<Array<{ path: string; name: string; description: string; source: 'user_agents_dir'; alreadyImported: boolean }>>>
  listShellConsent: () => Promise<IPCResponse<Record<string, { hasScripts: boolean; consent: boolean }>>>
  setShellConsent: (payload: { skillId: string; granted: boolean }) => Promise<IPCResponse<{ skillId: string; granted: boolean }>>
  importCustomSkill: (payload: { path: string }) => Promise<IPCResponse<{ skill: SkillState; ignoredFields: string[]; warnings: string[] }>>
  removeCustomSkill: (payload: { skillId: string }) => Promise<IPCResponse<{ removed: boolean }>>
  updateCustomSkillDescription: (payload: {
    skillId: string
    description: string
    name?: string
  }) => Promise<IPCResponse<SkillState>>
  install: (payload: {
    skillId: string
    force?: boolean
  }) => Promise<IPCResponse<SkillInstallResult>>
  run: (payload: {
    skillId: string
    action: string
    params?: Record<string, unknown>
    timeoutMs?: number
    sessionId?: string
    executionMode?: 'auto' | 'workflow' | 'direct'
  }) => Promise<IPCResponse<SkillRunResult>>
  listJobs: (limit?: number) => Promise<IPCResponse<SkillJobRecord[]>>
  getConfiguration: (payload: { skillId: string }) => Promise<IPCResponse<SkillConfigurationViewData>>
  updateConfiguration: (payload: {
    skillId: string
    serviceBindings?: Record<string, string>
    fields?: Record<string, SkillConfigValueData>
  }) => Promise<IPCResponse<SkillConfigurationViewData>>
  listModelPacks: () => Promise<IPCResponse<ModelPackStatus[]>>
  getModelPackStatus: (payload: { id: ModelPackId }) => Promise<IPCResponse<ModelPackStatus>>
  startModelPackDownload: (payload: { id: ModelPackId; source?: ModelSource }) => Promise<IPCResponse<ModelPackStatus>>
  cancelModelPackDownload: (payload: { id: ModelPackId }) => Promise<IPCResponse<ModelPackStatus>>
  selfTestModelPacks: () => Promise<IPCResponse<ModelPackSelfTestReport>>
  onModelPackDownloadUpdate?: (handler: (update: ModelPackDownloadUpdate) => void) => () => void
  // One-click skill-runtime provisioning (Python + ffmpeg + core deps).
  getSkillRuntimeStatus: () => Promise<IPCResponse<RuntimeStatus>>
  provisionSkillRuntime: (payload?: { force?: boolean }) => Promise<IPCResponse<RuntimeStatus | { kind?: string }>>
  cancelSkillRuntimeProvision: () => Promise<IPCResponse<void>>
  getSkillRuntimeMirror: () => Promise<IPCResponse<string>>
  setSkillRuntimeMirror: (payload: { mirror: string }) => Promise<IPCResponse<void>>
  selfTestSkillRuntime: () => Promise<IPCResponse<RuntimeStatus>>
  onSkillRuntimeProvisionUpdate?: (handler: (progress: RuntimeProvisionProgress) => void) => () => void
	  // Skill-source diagnostics (reachability self-test for the agent install path).
	  selfTestSkillSources: () => Promise<IPCResponse<SkillSourceSelfTestReport>>
	  submitAskUserAnswer: (payload: { executionId: string; answer: string }) => Promise<IPCResponse>
	  listPendingAskUser: () => Promise<Array<{
	    executionId: string
	    sessionId: string | null
	    scopeId?: string | null
	    agent?: string | null
	    requestId?: string | null
	    skillId: string | null
	    question: string
	    options: string[] | null
	    placeholder: string | null
	    askedAt: number
	  }>>
	  onAskUserQuestion: (handler: (event: {
	    executionId: string
	    sessionId: string | null
	    scopeId?: string | null
	    agent?: string | null
	    requestId?: string | null
	    skillId: string | null
	    question: string
	    options: string[] | null
	    placeholder: string | null
	    askedAt: number
	  }) => void) => () => void
	  onAskUserCleared: (handler: (event: {
	    executionId: string
	    sessionId: string | null
	    scopeId: string | null
	    agent: string | null
	    requestId: string | null
	    reason: 'resolved' | 'rejected' | 'cleared'
	  }) => void) => () => void
	  // Phase 4: skills:executions:* API surface retired along with the
  // skill_executions state machine. Removed: listExecutions / getExecution /
  // submitInput / submitConfirmation / submitAgentResult / restartFromStep /
  // cancelExecution. Progress now exposed via in-memory todo projection.
  onSkillReferenceInlined?: (handler: (event: SkillReferenceInlinedEvent) => void) => () => void
  listSchedules: () => Promise<IPCResponse<SkillScheduleRecord[]>>
  createSchedule: (payload: {
    skillId: string
    action: string
    params?: Record<string, unknown>
    intervalMinutes: number
    startAt?: string
  }) => Promise<IPCResponse<SkillScheduleRecord>>
  toggleSchedule: (payload: {
    id: string
    enabled: boolean
  }) => Promise<IPCResponse<SkillScheduleRecord>>
  deleteSchedule: (payload: { id: string }) => Promise<IPCResponse<{ removed: boolean }>>
}

// =============================================================================
// Window API Types
// =============================================================================

interface ElectronWindowAPI {
  minimize: () => Promise<void>
  maximize: () => Promise<void>
  close: () => Promise<void>
  refreshTransparentSurface: () => Promise<void>
  /** macOS fullscreen lifecycle push from main; Stage 2 onwards 才有事件，Stage 1 是空订阅 */
  onFullscreenChanged: (listener: (isFullscreen: boolean) => void) => () => void
}

// =============================================================================
// Theme API Types
// =============================================================================

interface ThemeSnapshotPayload {
  option: ThemeOption
  resolved: ResolvedTheme
  skin: ThemeSkin
  /** 主窗口当前是否在 macOS 原生 fullscreen 态。renderer 启动 reconciliation 用以同步 data-native-fullscreen attr */
  isNativeFullscreen: boolean
}

interface ElectronThemeAPI {
  set: (theme: string) => Promise<void>
  /** 切换玻璃风格；不触发昼夜 ritual，仅影响窗口材料和 .ready-app-bg 渐变可见性 */
  setSkin: (skin: ThemeSkin) => Promise<void>
  get: () => Promise<{ success: boolean; data?: ThemeSnapshotPayload; error?: string }>
  onChanged: (listener: (snapshot: ThemeSnapshotPayload) => void) => () => void
}

// =============================================================================
// App / Auto-update API Types
// =============================================================================

interface ElectronUpdateStatus {
  status: string
  version?: string
  releaseDate?: string
  percent?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
  error?: string
}

interface ElectronAppShortcutEvent {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}

interface ElectronAppAPI {
  checkUpdate: () => Promise<{ success: boolean; version?: string | null; error?: string }>
  installUpdate: () => Promise<void>
  writeImageToClipboard: (payload: { path: string; text?: string }) => Promise<{ success: boolean; error?: string }>
  onUpdateStatus: (callback: (data: ElectronUpdateStatus) => void) => () => void
  onShortcut: (callback: (data: ElectronAppShortcutEvent) => void) => () => void
  // D1: cache stats + cleanup
  getCacheStats: () => Promise<{
    success: boolean
    error?: string
    data?: {
      codeCacheBytes: number
      cacheBytes: number
      puppeteerCacheBytes: number
      sharedCacheBytes: number
    }
  }>
  clearCache: (opts?: { includePuppeteer?: boolean }) => Promise<{
    success: boolean
    error?: string
    data?: { clearedBytes: number; errors: string[] }
  }>
  exportDiagnosticPack: () => Promise<{
    success: boolean
    error?: string
    data?: {
      path: string
      fileName: string
      bytes: number
      includedLogs: string[]
      skippedLogs: Array<{ name: string; reason: string }>
    }
  }>
}

// =============================================================================
// Settings API Types
// =============================================================================

interface AIModelConfigData {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  modelIds?: string[]
  displayName?: string
  agentProtocol?: 'anthropic' | 'openai'
  wireApi?: 'chat/completions' | 'responses'
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  toolUseMode?: 'auto' | 'on' | 'off'
  visionMode?: 'auto' | 'on' | 'off'
  nativeVideoMode?: 'auto' | 'on' | 'off'
  capabilityModes?: Record<string, 'auto' | 'on' | 'off'>
  contextWindowOverride?: number
  maxOutputTokensOverride?: number
  endpointId?: string
}

interface AIProviderProfileData {
  id: string
  category: 'openai' | 'anthropic' | 'gemini' | 'custom'
  name: string
  builtIn: boolean
  showInChatSwitcher: boolean
  config: AIModelConfigData
}

interface AIProviderWorkspaceData {
  version: 1
  activeProfileId: string
  profiles: AIProviderProfileData[]
}

interface SettingsTestResult {
  latencyMs: number
  modelList?: string[]
}

type ExternalServiceKindData =
  | 'tavily'
  | 'duckduckgo'
  | 'jina'
  | 'rsshub'
  | 'bilibili'
  | 'github'
  | 'amap'
  | 'vision-model'

type ExternalServiceOptionValueData = string | number | boolean | string[] | null

interface PublicExternalServiceProfileData {
  id: string
  kind: ExternalServiceKindData
  name: string
  enabled: boolean
  baseUrl?: string
  options: Record<string, ExternalServiceOptionValueData>
  secretStatus: Record<string, { configured: boolean; masked?: string }>
  updatedAt?: string
}

interface ExternalServiceUpdateInputData {
  id: string
  kind?: ExternalServiceKindData
  name?: string
  enabled?: boolean
  baseUrl?: string
  options?: Record<string, ExternalServiceOptionValueData>
  secrets?: Record<string, string>
  clearSecrets?: string[]
}

interface ExternalServiceTestResultData {
  ok: boolean
  serviceId: string
  message: string
  latencyMs?: number
}

interface ElectronSettingsAPI {
  get: (key: string) => Promise<{ success: boolean; data?: string | null; error?: string }>
  set: (key: string, value: string) => Promise<{ success: boolean; error?: string }>
  getAll: () => Promise<{ success: boolean; data?: Record<string, string>; error?: string }>
  getAgentAutoNarrationContinuation: () => Promise<{ success: boolean; data?: boolean; error?: string }>
  setAgentAutoNarrationContinuation: (enabled: boolean) => Promise<{ success: boolean; error?: string }>
  getAgentSessionPrerouteMode: () => Promise<{ success: boolean; data?: 'off' | 'suggest' | 'auto'; error?: string }>
  setAgentSessionPrerouteMode: (mode: 'off' | 'suggest' | 'auto') => Promise<{ success: boolean; error?: string }>
  getAIConfig: () => Promise<{ success: boolean; data?: AIModelConfigData | null; error?: string }>
  setAIConfig: (config: AIModelConfigData) => Promise<{ success: boolean; error?: string }>
  getAIWorkspace: () => Promise<{ success: boolean; data?: AIProviderWorkspaceData; error?: string }>
  setAIWorkspace: (workspace: AIProviderWorkspaceData) => Promise<{ success: boolean; error?: string }>
  testAIConnection: (
    config: AIModelConfigData
  ) => Promise<{ success: boolean; data?: SettingsTestResult; error?: string }>
  listExternalServices: () => Promise<{ success: boolean; data?: PublicExternalServiceProfileData[]; error?: string }>
  updateExternalService: (
    input: ExternalServiceUpdateInputData
  ) => Promise<{ success: boolean; data?: PublicExternalServiceProfileData; error?: string }>
  resetExternalService: (
    payload: { id: string }
  ) => Promise<{ success: boolean; data?: PublicExternalServiceProfileData; error?: string }>
  testExternalService: (
    payload: { id: string }
  ) => Promise<{ success: boolean; data?: ExternalServiceTestResultData; error?: string }>
  testExternalServiceDraft: (
    input: ExternalServiceUpdateInputData
  ) => Promise<{ success: boolean; data?: ExternalServiceTestResultData; error?: string }>
}

interface ElectronPetAPI {
  getSettings: () => Promise<IPCResponse<PetSettings>>
  updateSettings: (patch: Partial<PetSettings>) => Promise<IPCResponse<PetSettings>>
  listPets: () => Promise<IPCResponse<PetDefinition[]>>
  getSnapshot: () => Promise<IPCResponse<PetWindowSnapshot>>
  show: () => Promise<IPCResponse<PetWindowSnapshot>>
  hide: () => Promise<IPCResponse<boolean>>
  setPet: (petId: string) => Promise<IPCResponse<PetSettings>>
  updateActivity: (snapshot: PetActivitySnapshot) => Promise<IPCResponse<boolean>>
  resetPosition: () => Promise<IPCResponse<PetSettings>>
  moveBy: (delta: { dx: number; dy: number }) => Promise<IPCResponse<boolean>>
  pushStickyNote: (note: PetStickyNoteInput) => Promise<IPCResponse<PetStickyNote>>
  dismissStickyNote: (id: string) => Promise<IPCResponse<boolean>>
  clearStickyNotes: () => Promise<IPCResponse<boolean>>
  onSnapshot: (callback: (snapshot: PetWindowSnapshot) => void) => () => void
}

// =============================================================================
// Chat History + File API Types
// =============================================================================

interface ChatConversationData {
  id: string
  agent: string
  title: string
  created_at: string
  updated_at: string
}

interface ChatMessageData {
  id: string
  conversation_id: string
  role: string
  content: string
  timestamp: string
}

interface ChatPickedFile {
  name: string
  path: string
  type: 'image' | 'video' | 'text' | 'spreadsheet' | 'other'
  size: number
  ext: string
}

interface ChatFileForAI {
  type: 'image' | 'video' | 'text'
  base64?: string
  mimeType?: string
  content?: string
  name?: string
}

interface ElectronChatAPI {
  getConversations: (
    agent: string
  ) => Promise<{ success: boolean; data?: ChatConversationData[]; error?: string }>
  getMessages: (
    conversationId: string
  ) => Promise<{ success: boolean; data?: ChatMessageData[]; error?: string }>
  deleteConversation: (conversationId: string) => Promise<{ success: boolean; error?: string }>
  saveMessage: (data: {
    id: string
    conversationId: string
    role: string
    content: string
    timestamp: string
    meta?: Record<string, unknown>
  }) => Promise<{ success: boolean; error?: string }>
  createConversation: (data: {
    id: string
    agent: string
    title: string
  }) => Promise<{ success: boolean; error?: string }>
  updateConversationTitle: (data: {
    id: string
    title: string
  }) => Promise<{ success: boolean; error?: string }>
  pickFiles: () => Promise<{ success: boolean; data?: ChatPickedFile[]; error?: string }>
  readFileForAI: (
    filePath: string
  ) => Promise<{ success: boolean; data?: ChatFileForAI; error?: string }>
}

// =============================================================================
// User Profile API Types
// =============================================================================

interface UserProfileData {
  id: string
  name?: string
  avatarUrl?: string
  preferredLanguage: string
  communicationStyle?: string
  preferencesJson?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

interface ElectronUserProfileAPI {
  get: (userId: string) => Promise<{ success: boolean; data?: UserProfileData; error?: string }>
  list: () => Promise<{ success: boolean; data?: UserProfileData[]; error?: string }>
  create: (profile: {
    id?: string
    name?: string
    avatarUrl?: string
    preferredLanguage?: string
    communicationStyle?: string
    preferencesJson?: Record<string, unknown>
  }) => Promise<{ success: boolean; data?: UserProfileData; error?: string }>
  update: (
    userId: string,
    updates: {
      name?: string
      avatarUrl?: string
      preferredLanguage?: string
      communicationStyle?: string
      preferencesJson?: Record<string, unknown>
    }
  ) => Promise<{ success: boolean; error?: string }>
  delete: (userId: string) => Promise<{ success: boolean; error?: string }>
}

// =============================================================================
// Agent Personality API Types
// =============================================================================

interface AgentPersonalityData {
  id: string
  agentName: string
  displayName?: string
  personalityText: string
  tone?: string
  metaJson?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

interface ElectronAgentPersonalityAPI {
  get: (
    agentName: string
  ) => Promise<{ success: boolean; data?: AgentPersonalityData; error?: string }>
  list: () => Promise<{ success: boolean; data?: AgentPersonalityData[]; error?: string }>
  create: (personality: {
    agentName: string
    displayName?: string
    personalityText: string
    tone?: string
    metaJson?: Record<string, unknown>
  }) => Promise<{ success: boolean; data?: AgentPersonalityData; error?: string }>
  update: (
    agentName: string,
    updates: {
      displayName?: string
      personalityText?: string
      tone?: string
      metaJson?: Record<string, unknown>
    }
  ) => Promise<{ success: boolean; error?: string }>
  delete: (agentName: string) => Promise<{ success: boolean; error?: string }>
}

// =============================================================================
// Memory API Types
// =============================================================================

type MemoryLayer = 'l0' | 'l1' | 'l2'
type MemoryCategory =
  | 'summary'
  | 'learning'
  | 'trigger'
  | 'rule'
  | 'user_preference'
  | 'global_fact'
  | 'personality_trait'
type MemorySourceType = 'resident_agent' | 'resident_user' | 'scope_memory' | 'trigger_rule'

interface MemoryEntry {
  id: string
  layer: MemoryLayer
  scopeId: string | null
  userId?: string | null
  sourceType: MemorySourceType
  category: MemoryCategory
  title: string
  summary: string | null
  contentKey: string
  priority: number
  accessCount: number
  lastAccessedAt: number | null
  createdAt: number
  updatedAt: number
  expiresAt: number | null
  archivedAt: number | null
  tags: string[] | null
  meta: Record<string, unknown>
}

interface TriggerDefinition {
  id: string
  label: string
  module: string | null
  pattern: string
  patternFlags: string
  blocking: boolean
  priority: number
  enabled: boolean
  hitCount: number
  lastHitAt: number | null
  createdAt: number
  updatedAt: number
  meta: Record<string, unknown>
}

interface MemoryQueryFilters {
  layer?: MemoryLayer
  scopeId?: string | null
  userId?: string
  sourceType?: MemorySourceType
  category?: MemoryCategory
  includeArchived?: boolean
  limit?: number
  offset?: number
}

interface TriggerFilters {
  enabled?: boolean
  module?: string
  limit?: number
}

interface MemoryStats {
  totalMemories: number
  byLayer: Record<MemoryLayer, number>
  byCategory: Record<MemoryCategory, number>
  bySourceType: Record<MemorySourceType, number>
  archivedCount: number
  avgAccessCount: number
}

interface MemoryLifecycleStatus {
  running: boolean
  lastMaintenanceAt: string | null
}

interface MemoryMaintenanceResult {
  archivedL1Count: number
  archivedL2Count: number
  prunedCount: number
  optimizedTriggers: number
  timestamp: string
}

type BeliefCardStatusData = 'staged' | 'active' | 'rejected' | 'invalid'
type BeliefCardRiskLevelData = 'low' | 'medium' | 'high'

interface BeliefCardSettingsItemData {
  relPath: string
  scopeId: string
  title: string
  description: string
  confidence: string | null
  tag: string | null
  status: BeliefCardStatusData
  created: string | null
  source: string | null
  stage: string | null
  site: string | null
  siteRiskLevel: BeliefCardRiskLevelData | null
  siteRiskAuthority: 'code' | null
  isSiteCard: boolean
  isRiskSuggestion: boolean
  bodyPreview: string
}

interface BeliefCardSettingsSummaryData {
  total: number
  staged: number
  active: number
  rejected: number
  invalid: number
  agentScoped: number
  siteCards: number
  highRiskSiteCards: number
  riskSuggestions: number
}

interface BeliefCardMaintenanceRoundData {
  lastRunAt: string
  decision: 'run' | 'skip'
  reason: string
  llmCalls: number
  applied: number
  rejected: number
  terminal: string
}

interface BeliefCardSettingsSnapshotData {
  knowledgeSystemEnabled: boolean
  cards: BeliefCardSettingsItemData[]
  summary: BeliefCardSettingsSummaryData
  maintenance: {
    lifecycleRunning: boolean
    lastLifecycleMaintenanceAt: string | null
    llmRound: BeliefCardMaintenanceRoundData | null
  }
}

interface ElectronMemoryAPI {
  query: (filters: MemoryQueryFilters) => Promise<IPCResponse<MemoryEntry[]>>
  create: (entry: Partial<MemoryEntry>) => Promise<IPCResponse<MemoryEntry>>
  update: (id: string, updates: Partial<MemoryEntry>) => Promise<IPCResponse<void>>
  delete: (id: string) => Promise<IPCResponse<void>>
  stats: () => Promise<IPCResponse<MemoryStats>>
  createFromConversation: (payload: {
    scopeId: string
    category: 'summary' | 'learning'
    title: string
    content: string
    tags?: string[]
    priority?: number
  }) => Promise<IPCResponse<{ memoryId: string }>>
}

interface ElectronMemoryCardsAPI {
  list: () => Promise<IPCResponse<BeliefCardSettingsSnapshotData>>
  transition: (payload: { relPath: string; action: 'approve' | 'reject' }) =>
    Promise<IPCResponse<BeliefCardSettingsSnapshotData>>
  setKnowledgeSystemEnabled: (enabled: boolean) => Promise<IPCResponse<BeliefCardSettingsSnapshotData>>
}

// P0-4 (2026-07-02 P0 visibility batch) — run quality dashboard payload.
interface RunQualityDayData {
  date: string
  total: number
  done: number
  proofGap: number
  degraded: number
  unconfirmed: number
}

interface RunQualityStatsData {
  windowDays: number
  sampleSize: number
  days: RunQualityDayData[]
  divergenceCount: number
  firstDelta: { count: number; p50Ms: number | null; avgMs: number | null }
  streamFallbacks: Record<string, number>
}

interface ElectronRunQualityAPI {
  stats: () => Promise<IPCResponse<RunQualityStatsData>>
}

// D5 后端切片 (2026-07-03) — per-run 用户反馈记录（run_feedback 表投影）。
interface RunFeedbackRecordData {
  feedbackId: string
  runId: string
  taskId: string | null
  rating: 1 | 2 | 3 | 4 | 5 | null
  signal: string | null
  comment: string | null
  createdAt: number
  updatedAt: number
}

interface ElectronRunFeedbackAPI {
  submit: (payload: {
    /** runId 与 taskId 至少给一个；只给 taskId 时由 main 解析权威 runId。 */
    runId?: string
    taskId?: string | null
    feedbackId?: string
    rating?: 1 | 2 | 3 | 4 | 5 | null
    signal?: string | null
    comment?: string | null
  }) => Promise<IPCResponse<RunFeedbackRecordData>>
  list: (options?: {
    runId?: string
    taskId?: string
    limit?: number
  }) => Promise<IPCResponse<RunFeedbackRecordData[]>>
}

// 梯队三 (2026-07-03) — emergence feed 卡（确定性提取，带证据链与行动出口）。
interface EmergenceCardData {
  id: string
  projectKey?: string
  type: 'resume' | 'follow_up' | 'crystallize' | 'prepare' | 'harvest' | 'forming'
  title: string
  evidence: Array<{ fact: string; ref: string }>
  confidence: number
  action: {
    kind:
      | 'resume_task'
      | 'adjudicate_task'
      | 'supply_input'
      | 'adopt_candidate'
      | 'review_duplicate'
      | 'open_project'
      | 'open_artifact'
      | 'open_project_group'
    ref: string
    targetPath?: string | null
    memberPaths?: string[]
  }
  requiresExplicitConfirm: boolean
}

interface EmergenceFeedEntryData {
  card: EmergenceCardData
  scopeId: string | null
}

interface ElectronEmergenceAPI {
  feed: () => Promise<IPCResponse<EmergenceFeedEntryData[]>>
}

interface ElectronTriggerAPI {
  list: (filters?: TriggerFilters) => Promise<IPCResponse<TriggerDefinition[]>>
  create: (trigger: Partial<TriggerDefinition>) => Promise<IPCResponse<TriggerDefinition>>
  update: (id: string, updates: Partial<TriggerDefinition>) => Promise<IPCResponse<void>>
  createWithMemories: (payload: {
    label: string
    pattern: string
    patternFlags?: string
    memoryIds: string[]
    module?: string
    blocking?: boolean
    priority?: number
  }) => Promise<IPCResponse<{ triggerId: string }>>
}

interface ElectronMemoryLifecycleAPI {
  status: () => Promise<IPCResponse<MemoryLifecycleStatus>>
  runMaintenance: () => Promise<IPCResponse<MemoryMaintenanceResult>>
}

// =============================================================================
// Tools API Types
// =============================================================================

interface ToolEventLogPayload {
  type: 'dispatch' | 'ack' | 'watchdog' | 'cancel' | 'self-rescue' | 'duplicate'
  requestId: string
  tool: string
  scopeId?: string | null
  elapsedMs?: number
  error?: string
}

interface ElectronToolsAPI {
  logToolEvent: (payload: ToolEventLogPayload) => void
}

interface ElectronUIAPI {
  showNativeContextMenu: (payload: NativeContextMenuRequest) => Promise<NativeContextMenuResponse>
}

// =============================================================================
// Top-level API
// =============================================================================

interface AskUserQuestionsCardQuestionPayload {
  id: string
  question: string
  kind: 'single_choice' | 'multi_choice' | 'free_text'
  options?: string[]
  placeholder?: string
  required?: boolean
}

interface AskUserQuestionsCardPushEvent {
  cardId: string
  sessionId: string | null
  conversationId: string | null
  questions: AskUserQuestionsCardQuestionPayload[]
  askedAt: number
}

interface AskUserQuestionsPendingCard {
  cardId: string
  conversationId: string | null
  askedAt: number
  questions: AskUserQuestionsCardQuestionPayload[]
}

interface ElectronAgentInteractionAPI {
  submitAskUserQuestions: (payload: {
    cardId: string
    answers: Array<{ id: string; answer: string | string[] }>
  }) => Promise<IPCResponse | { success: boolean; error?: string }>
  cancelAskUserQuestions: (payload: { cardId: string; reason?: string }) =>
    Promise<{ success: boolean; error?: string }>
  listPendingAskUserQuestions: () =>
    Promise<IPCResponse<AskUserQuestionsPendingCard[]>>
  // EP1-I3-2 — confirm/deny a frozen tool call awaiting user confirmation.
  respondFrozenCall: (payload: { frozenCallId: string; decision: 'confirm' | 'deny' }) =>
    Promise<{ success: boolean; errorKind?: string; error?: string }>
  onAskUserQuestionsCard: (handler: (event: AskUserQuestionsCardPushEvent) => void) => () => void
}

interface ElectronFileEmergenceAPI {
  getSnapshot: (payload: FileEmergenceGetSnapshotPayload) => Promise<IPCResponse<FileEmergenceSnapshot>>
  recordActivity: (payload: FileEmergenceRecordActivityPayload) => Promise<IPCResponse>
  recordReadingSession: (payload: FileEmergenceRecordReadingSessionPayload) => Promise<IPCResponse>
  renameProject: (payload: FileEmergenceRenameProjectPayload) => Promise<IPCResponse>
  feedbackProject: (payload: FileEmergenceFeedbackPayload) => Promise<IPCResponse>
  listSuppressed: (payload: { workspaceRoots: string[] }) => Promise<IPCResponse<Array<{ projectKey: string; displayName: string; reason: 'not_related' | 'snoozed' | 'hidden'; until: number | null }>>>
  getEvaluation: (payload: { workspaceRoots: string[] }) => Promise<IPCResponse<unknown>>
  assignFile: (payload: FileEmergenceAssignFilePayload) => Promise<IPCResponse>
  createProjectForFile: (payload: FileEmergenceCreateProjectForFilePayload) => Promise<IPCResponse>
  onFlushReadingSessions: (handler: (requestId: string) => void) => () => void
  ackReadingSessionsFlushed: (requestId: string) => void
}
interface ElectronTagForgeAPI {
  beginCreation: (payload:{sourceRunId:string})=>Promise<IPCResponse<{creationToken:string}|null>>
  recordCreation: (payload:{creationToken:string;sourceRunId:string;path:string;workspaceRoots:string[]})=>Promise<IPCResponse<{receiptId:string}>>
  validateCreation:(payload:{creationToken:string;sourceRunId:string;proposals:Array<{facet:'form'|'domain'|'entity'|'use';label:string;evidenceCode:string;evidenceExcerpt?:string;confidence:number}>})=>Promise<IPCResponse<{tags:string[];sparse:boolean;pending:Array<{facet:string;label:string}>}>>
  finalizeCreation: (payload:{creationToken:string;receiptId:string;sourceRunId:string;path:string;workspaceRoots:string[]})=>Promise<IPCResponse<{receiptId:string;revision:string;path:string;status?:string}>>
  listPending: ()=>Promise<IPCResponse<Array<{proposalId:string;facet:string;label:string;evidenceCode:string;evidenceExcerpt:string|null}>>>
  reviewPending: (payload:{proposalId:string;decision:'approve'|'reject'})=>Promise<IPCResponse>
}

interface ElectronAPI {
  agent: ElectronAgentAPI
  memory: ElectronMemoryAPI
  memoryCards: ElectronMemoryCardsAPI
  runQuality: ElectronRunQualityAPI
  runFeedback: ElectronRunFeedbackAPI
  emergence: ElectronEmergenceAPI
  trigger: ElectronTriggerAPI
  memoryLifecycle: ElectronMemoryLifecycleAPI
  browser: ElectronBrowserAPI
  document: ElectronDocumentAPI
  board: ElectronBoardAPI
  rss: ElectronRSSAPI
  calendar: ElectronCalendarAPI
  skills: ElectronSkillsAPI
  app: ElectronAppAPI
  window: ElectronWindowAPI
  theme: ElectronThemeAPI
  settings: ElectronSettingsAPI
  fileEmergence: ElectronFileEmergenceAPI
  tagForge: ElectronTagForgeAPI
  pet: ElectronPetAPI
  chat: ElectronChatAPI
  userProfile: ElectronUserProfileAPI
  agentPersonality: ElectronAgentPersonalityAPI
  tools?: ElectronToolsAPI
  ui?: ElectronUIAPI
  agentInteraction?: ElectronAgentInteractionAPI
  mcp?: ElectronMcpAPI
  platform: string
  startNativeFileDrag: (paths: string[]) => void
  getFilePathFromDrop: (file: File) => string
}

// Phase M 管理面（2026-07-05）—— MCP 设置页 IPC 面
export interface ElectronMcpServerStatus {
  serverId: string
  toolCount: number
  toolNames: string[]
  requiresAuthorization: boolean
  clientConnected: boolean
  lastError?: string
}

export interface ElectronMcpStatus {
  rawConfig: string
  configuredCount: number
  skipped: Array<{ reason: string }>
  servers: ElectronMcpServerStatus[]
}

export interface ElectronMcpAPI {
  getStatus: () => Promise<ElectronMcpStatus>
  saveConfig: (json: string) => Promise<{
    success: boolean
    error?: string
    configuredCount?: number
    skipped?: Array<{ reason: string }>
  }>
  reload: () => Promise<{
    success: boolean
    error?: string
    outcomes?: Array<{ serverId: string; ok: boolean; toolCount: number; dropped: string[]; error?: string }>
  }>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export type {
  MemoryLayer,
  MemoryCategory,
  MemoryEntry,
  TriggerDefinition,
  MemoryQueryFilters,
  TriggerFilters,
  MemoryStats,
  MemoryLifecycleStatus,
  MemoryMaintenanceResult,
  BeliefCardSettingsItemData,
  BeliefCardSettingsSnapshotData,
  RunQualityDayData,
  RunQualityStatsData,
  RunFeedbackRecordData,
  EmergenceCardData,
  EmergenceFeedEntryData,
  AgentDerivationCandidateData,
  AgentDerivationConfirmData,
  AgentRegistryKnowledgeCardData,
  TaskProjectionRecordData,
  RecoveryRecordData,
  ReferenceSkillHintData,
  DetachedSkillTaskData,
  ActiveChildRunSummaryData
}
