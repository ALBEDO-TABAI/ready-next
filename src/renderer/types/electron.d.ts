import type { RSSSieveAPI } from '../../shared/rss-sieve'
import type { ObjectPresentationAPI } from '../../shared/object-identity'
import type { ObjectLinkQuery, ObjectLinksResponse } from '../../shared/object-links'
import type { LibraryBook, LibraryBookPatch, LibraryBookmark, LibraryImportResult, LibraryReadingPosition, LibraryResult, LibraryState } from '../../shared/library'
import type { DocumentSyncRequest, DocumentSyncReply } from '../../shared/document-operations'
import type { ChatGptOAuthStatus } from '../../shared/chatgpt-oauth'
import type { BrowserDiagnosticsData } from '../modules/browser/types'
import type { BrowserUtilityMenuRequest } from '../../shared/browser-utility-menu'
import type { BrowserViewIntent, BrowserViewIntentAck } from '../../shared/browser-view-intent'
import type {
  DocumentIndexChangedEvent,
  DocumentWatcherFailedEvent,
} from '../../shared/document-index-events'
import type {
  BrowserCookieDomainGroup,
  BrowserPrivacySummary,
  BrowsingDataType,
  ClearBrowsingDataResult,
} from '../../shared/browser-privacy'
import type { NativeContextMenuRequest, NativeContextMenuResponse } from '../../shared/native-context-menu'
import type { RSSAutoRefreshSnapshot } from '../../shared/rss-auto-refresh'
import type { CapabilityRuntimeSnapshot } from '../../shared/ai-capability-runtime'
import type { RendererAgentMetricName } from '../../shared/renderer-agent-metrics'
import type { CanonicalAssistantMessage } from '../../shared/ipc-contracts/canonical-message'
import type {
  CreateSessionRequest,
  CreateSessionResult,
  BeginNewContextRequest,
  BeginNewContextResult,
  IngressAdmittedEvent,
  LifecycleRequest,
  LifecycleResult,
  ProductLifecycleRequest,
  StopLifecycleRequest,
  SendScopedRequest,
  SendScopedResponse,
} from '../../shared/ipc-contracts/agent-runtime'
import type { LifecycleOperationProjectionV2 } from '../../shared/ipc-contracts/agent-lifecycle-snapshot'
import type { AgentRuntimeReadinessSnapshot } from '../../shared/ipc-contracts/agent-runtime-readiness'
import type { RendererStateFlushOutcome } from '../../shared/renderer-state-flush'
import type { ContextUsageSnapshot } from '../../shared/context-usage-types'
import type { ModelPackDownloadUpdate, ModelPackId, ModelPackSelfTestReport, ModelPackStatus, ModelSource } from '../../shared/model-pack-types'
import type { RuntimeStatus, RuntimeProvisionTaskSnapshot } from '../../shared/runtime-provision-types'
import type { SkillSourceSelfTestReport } from '../../shared/skill-source-types'
import type {
  AgentBrowserCollectionTask,
  AgentBrowserControlState,
  AgentBrowserSurface,
  BrowserLeaseSurfaceSnapshot,
  BrowserTargetClaimSnapshot,
} from '../modules/browser/useAgentBrowserSupervision'
import type {
  PetDefinition,
  PetActivityOpenIdentity,
  PetSettings,
  PetStickyNote,
  PetStickyNoteInput,
  PetWindowSnapshot,
} from '../../shared/pet'
import type {
  RSSBenchmarkResultData,
  RSSDiagnosticsData, RSSHubRuntimeStatusData,
  RSSStatusData
} from '../modules/rss/types'
import type { ThemeOption, ResolvedTheme, Transparency } from '../stores/useTheme'
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
import type { BrowserAgentPointerSnapshot } from '../../shared/browser-agent-pointer'
import type {
  FastCardStorageAPI,
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
  ReadyMemoryAddRequest,
  ReadyMemoryConversationPolicyRequest,
  ReadyMemoryDeleteRequest,
  ReadyMemoryGlobalPolicyRequest,
  ReadyMemoryPinRequest,
  ReadyMemoryReadRequest,
  ReadyMemoryResetRequest,
  ReadyMemoryUpdateRequest,
  ReadyMemoryView,
  ReadyMemoryStateChange,
} from '../../shared/ready-memory'

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
  credentialState: 'ready' | 'missing' | 'recovery_required' | 'vault_unavailable'
  secretStatus: Record<string, {
    configured: boolean
    state: 'ready' | 'missing' | 'recovery_required' | 'vault_unavailable'
  }>
  createdAt: string
  updatedAt: string
  lastError?: string | null
  lastSeenAt?: string | null
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
  orchestrator: 'codex-native'
  sidecarEnabled: boolean
  sidecar: AgentHeartbeatSnapshot['sidecar']
  channels: {
    total: number
    enabled: number
    connected: number
    errors: number
    byType: Record<string, number>
  }
  heartbeat: AgentHeartbeatSnapshot
}

type CapabilityRuntimeSnapshotData = CapabilityRuntimeSnapshot

type ConversationSourceKind = 'local' | 'channel'

interface ConversationScopeData {
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

interface ScopeRunActivityNarrationData {
  itemId: string
  source: 'commentary' | 'reasoning_summary'
  text: string
  status: 'streaming' | 'completed'
}

type ScopeRunTaskStepStatusData = 'pending' | 'running' | 'blocked' | 'done' | 'error'
type ScopeRunWaitingForData = 'input' | 'confirmation' | 'agent_result' | 'background' | 'verification' | 'none'
type ActionAuthorizationModeData = 'ask' | 'auto' | 'full'
type ScopeRunResumableActionData = 'continue' | 'retry' | 'open_artifact' | 'cancel' | 'none'

interface ScopeRunTaskStepData {
  id: string
  title: string
  status: ScopeRunTaskStepStatusData
  detail?: string | null
  updatedAt: string
}

interface ScopeRunTaskContinuationData {
  kind?: string | null
  checkpointId?: string | null
  browserTaskId?: string | null
  suspensionReason?: string | null
  suspensionRequest?: import('../../shared/browser-workflow-control').BrowserConfirmationSuspensionRequest | null
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

type TaskProjectionStatusData = 'queued' | 'running' | 'recoverable_paused' | 'budget_paused' | 'blocked' | 'completed' | 'failed' | 'killed'

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
  ownerRunId?: string | null
  messageVisibilityEpoch?: number
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
  messageVisibilityEpoch: number
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
  | 'infra_error'

interface ScopeRunEventData {
  type: 'started' | 'updated' | 'finished'
  scopeId: string
  /** Exact product alias identity; renderer drops events that omit or drift. */
  aliasGeneration: number
  /** Exact visible conversation epoch; renderer drops stale events after reset. */
  messageVisibilityEpoch: number
  /** Durable owner used by Main to prove this event is still current. */
  visibilityOwnerKind: 'product_alias' | 'context_background'
  visibilityOwnerLedger?: {
    kind: 'run_meta' | 'skill_task_run' | 'task_projection'
    id: string
  }
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
  contextUsage?: ContextUsageSnapshot | null
  ownerResourceId?: string
  lastEvidenceAt?: string
  toolEvent?: ScopeRunTraceItemData
  activityNarration?: ScopeRunActivityNarrationData | null
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
  createSession: (request: CreateSessionRequest) => Promise<CreateSessionResult>
  beginNewContext: (request: BeginNewContextRequest) => Promise<BeginNewContextResult>
  resetSession: (request: ProductLifecycleRequest) => Promise<LifecycleResult>
  // Stage U PR U1.2 — removed `orchestrate / getStatus / getAll / getDiagnostics`
  // legacy AgentManager wrappers. Use `getRuntimeStatus` / `getCapabilityRuntimeSnapshot`.
  kill: (request: StopLifecycleRequest) => Promise<LifecycleResult>
  closeSession: (request: ProductLifecycleRequest) => Promise<LifecycleResult>
  compactSession: (request: LifecycleRequest) => Promise<LifecycleResult>
  readRuntimeReady: () => Promise<AgentRuntimeReadinessSnapshot>
  onRuntimeReady: (callback: (snapshot: AgentRuntimeReadinessSnapshot) => void) => () => void
  getRuntimeStatus: () => Promise<IPCResponse<AgentRuntimeStatusData>>
  getCapabilityRuntimeSnapshot: (config?: unknown) => Promise<IPCResponse<CapabilityRuntimeSnapshotData>>
  listChannels: () => Promise<IPCResponse<AgentChannelConfigData[]>>
  listConversationScopes: () => Promise<IPCResponse<ConversationScopeData[]>>
  listScopeRuns: (payload?: {
    channelKey?: string
    statuses?: string[]
    limit?: number
  }) => Promise<IPCResponse<ScopeRunSummaryData[]>>
  readProductTurnPresentation: (
    readyRunId: string,
    requestedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar',
  ) => Promise<IPCResponse<import('../../shared/ipc-contracts/agent-runtime').ProductTurnReceipt>>
  readProductTurnPresentations: (
    readyRunIds: string[],
    requestedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar',
  ) => Promise<IPCResponse<import('../../shared/ipc-contracts/agent-runtime').ProductTurnReceipt[]>>
  readReadyMemory: (request: ReadyMemoryReadRequest) => Promise<IPCResponse<ReadyMemoryView>>
  setReadyMemoryGlobalPolicy: (request: ReadyMemoryGlobalPolicyRequest) => Promise<IPCResponse<ReadyMemoryView>>
  setReadyMemoryConversationPolicy: (request: ReadyMemoryConversationPolicyRequest) => Promise<IPCResponse<ReadyMemoryView>>
  addReadyMemory: (request: ReadyMemoryAddRequest) => Promise<IPCResponse<ReadyMemoryView>>
  updateReadyMemory: (request: ReadyMemoryUpdateRequest) => Promise<IPCResponse<ReadyMemoryView>>
  pinReadyMemory: (request: ReadyMemoryPinRequest) => Promise<IPCResponse<ReadyMemoryView>>
  deleteReadyMemory: (request: ReadyMemoryDeleteRequest) => Promise<IPCResponse<ReadyMemoryView>>
  resetReadyMemory: (request: ReadyMemoryResetRequest) => Promise<IPCResponse<ReadyMemoryView>>
  onReadyMemoryStateChanged: (callback: (event: ReadyMemoryStateChange) => void) => () => void
  onCodexActionSurfaceInvalidated: (
    callback: (event: import('../../shared/ipc-contracts/agent-runtime').CodexActionSurfaceInvalidation) => void,
  ) => () => void
  readCodexLifecycleSnapshot: (
    request: LifecycleRequest,
  ) => Promise<IPCResponse<LifecycleOperationProjectionV2>>
  readCodexHeadActionProjection: (
    request: LifecycleRequest,
  ) => Promise<IPCResponse<import('../../shared/ipc-contracts/agent-runtime').CodexHeadActionProjection>>
  readCodexActionSurface: (
    request: LifecycleRequest,
  ) => Promise<IPCResponse<import('../../shared/ipc-contracts/agent-runtime').CodexActionSurfaceEnvelope>>
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
    conversationId: string,
    expectedMessageVisibilityEpoch: number,
  ) => Promise<
    IPCResponse<{
      scope: ConversationScopeData
      capsule: SessionRecallCapsuleData
    }>
  >
  detachSessionRecallContext: (
    currentScopeId: string,
    conversationId: string,
    expectedMessageVisibilityEpoch: number,
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
  setProjectDirectory: (scopeId: string, path: string | null, expectedMessageVisibilityEpoch: number) =>
    Promise<IPCResponse<ConversationScopeData>>
  setActionAuthorizationMode: (
    scopeId: string,
    mode: ActionAuthorizationModeData,
    expectedMessageVisibilityEpoch: number
  ) => Promise<IPCResponse<{
    scopeId: string
    mode: ActionAuthorizationModeData
    messageVisibilityEpoch: number
  }>>
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
  sendScoped: (payload: SendScopedRequest) => Promise<SendScopedResponse>
  onIngressAdmitted: (callback: (event: IngressAdmittedEvent) => void) => () => void
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
  startChannelPairing: (id: string) => Promise<IPCResponse<{ code: string; expiresAt: string }>>
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
    sessionKey?: string
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
      canonicalMessage?: CanonicalAssistantMessage | null
      canonicalMessageDigest?: string | null
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
  profile: string | null
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
  profile?: string | null
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
  registerDormantTabs: (
    request: import('../../shared/browser-tab-session').RegisterDormantBrowserTabsRequest,
  ) => Promise<import('../../shared/browser-tab-session').RegisterDormantBrowserTabsResult>
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
    profile?: string | null
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
  getDiagnostics: (options?: { includePerformance?: boolean }) => Promise<{ success: boolean; data?: BrowserDiagnosticsData; error?: string }>
  // Agent-browser supervision: one-step takeover + task listing.
  getAgentSupervisionState: () => Promise<{
    controlState: AgentBrowserControlState
    agentTabId: string | null
    tasks: AgentBrowserCollectionTask[]
    claims?: BrowserTargetClaimSnapshot[]
    surfaces?: Record<AgentBrowserSurface, BrowserLeaseSurfaceSnapshot>
    activeWriteSurface?: AgentBrowserSurface | null
    error?: string
  }>
  requestAgentInterruption: () => Promise<{ state: AgentBrowserControlState; frozen: boolean; takeoverTabId?: string | null; error?: string }>
  onAgentControlChanged: (callback: (data: { state: AgentBrowserControlState; takeoverError?: string | null }) => void) => () => void
  onLeaseChanged: (callback: (data: {
    claims?: BrowserTargetClaimSnapshot[]
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
  p7cLiveProofAgentClick: (x?: number, y?: number) => Promise<{
    success: boolean
    tabId?: string
    x?: number
    y?: number
    error?: string
  }>
  p7cLiveProofFinishAgentAction: (phase?: 'finish' | 'abort') => Promise<{
    success: boolean
    phase?: 'finish' | 'abort'
    error?: string
  }>
  p7cLiveProofCheckWriteDenied: () => Promise<{ success: boolean; errorKind?: string; error?: string }>
  p7cLiveProofClear: () => Promise<{ success: boolean; error?: string }>
  onPreviewUpdate: (callback: (data: BrowserPreviewState) => void) => () => void
  onTabUpdate: (callback: (data: BrowserTabUpdateEvent) => void) => () => void
  onTabOpened: (callback: (data: BrowserTabOpenedEvent) => void) => () => void
  onAdblockUpdate: (callback: (data: BrowserAdblockStateData) => void) => () => void
  onFastCardContextAction: (callback: (data: BrowserFastCardContextActionEvent) => void) => () => void
  listFastCardItems: FastCardStorageAPI['listFastCardItems']
  addFastCardItem: FastCardStorageAPI['addFastCardItem']
  removeFastCardItem: FastCardStorageAPI['removeFastCardItem']
  clearFastCardItems: FastCardStorageAPI['clearFastCardItems']
  translateFastCardSelection: (payload: FastCardTranslateRequest) => Promise<FastCardIPCResult<FastCardTranslateResult>>
  describeFastCardImage: (payload: FastCardDescribeImageRequest) => Promise<FastCardIPCResult<FastCardDescribeImageResult>>
  resolveFastCardVideo: (payload: FastCardResolveVideoRequest) => Promise<FastCardIPCResult<FastCardResolveVideoResult>>
  showFastCardOverlay: (payload: FastCardOverlaySnapshot) => Promise<FastCardIPCResult<void>>
  hideFastCardOverlay: () => Promise<FastCardIPCResult<void>>
  getFastCardOverlaySnapshot: () => Promise<FastCardIPCResult<FastCardOverlaySnapshot | null>>
  sendFastCardOverlayCommand: (command: FastCardOverlayCommand) => Promise<FastCardIPCResult<void>>
  onFastCardOverlayCommand: (callback: (command: FastCardOverlayCommand) => void) => () => void
  onFastCardOverlaySnapshot: (callback: (snapshot: FastCardOverlaySnapshot) => void) => () => void
  showBrowserLockOverlay: (payload: BrowserLockOverlaySnapshot) => Promise<BrowserLockOverlayIPCResult<void>>
  hideBrowserLockOverlay: () => Promise<BrowserLockOverlayIPCResult<void>>
  dismissBrowserLockOverlay: () => Promise<BrowserLockOverlayIPCResult<void>>
  getBrowserLockOverlaySnapshot: () => Promise<BrowserLockOverlayIPCResult<BrowserLockOverlaySnapshot | null>>
  onBrowserLockOverlaySnapshot: (callback: (snapshot: BrowserLockOverlaySnapshot) => void) => () => void
  getBrowserAgentPointerSnapshot: () => Promise<BrowserLockOverlayIPCResult<BrowserAgentPointerSnapshot | null>>
  onBrowserAgentPointerSnapshot: (callback: (snapshot: BrowserAgentPointerSnapshot) => void) => () => void

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
  /** Text guard aliases with explicit units. */
  limitBytes?: number
  bytes?: number
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
  registerOperationSync: () => Promise<void>
  onOperationSync: (callback: (payload: { requestId: string; request: DocumentSyncRequest }) => void) => () => void
  replyOperationSync: (requestId: string, reply: DocumentSyncReply) => void
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
  onIndexChanged: (callback: (event: DocumentIndexChangedEvent) => void) => () => void
  onWatcherFailed: (callback: (event: DocumentWatcherFailedEvent) => void) => () => void
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
  getObjectOutgoingLinks: (payload: ObjectLinkQuery) => Promise<ObjectLinksResponse>
  getObjectIncomingLinks: (payload: ObjectLinkQuery) => Promise<ObjectLinksResponse>
  getBacklinks: (payload: { path: string; limit?: number }) => Promise<DocumentBacklinksResponse>
  getGraph: (payload?: { centerPath?: string; depth?: number; workspaceRoot?: string }) => Promise<DocumentGraphResponse>
  listMarks: (payload: { documentPath: string }) => Promise<DocumentMarksResponse>
  createMark: (payload: DocumentMarkDraft) => Promise<DocumentMarkResponse>
  updateMark: (payload: { id: string; patch: DocumentMarkPatch }) => Promise<DocumentMarkResponse>
  deleteMark: (payload: { id: string }) => Promise<DocumentDeleteMarkResponse>
  startWatcher: (payload: { workspaceRoot: string }) => Promise<DocumentStartWatcherResponse>
  stopWatcher: (payload: { watcherId: string }) => Promise<DocumentStopWatcherResponse>
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
  path?: string
}

interface DocumentGraphEdge {
  source: string
  target: string
  kind: string
}

interface DocumentGraphResponse {
  success: boolean
  data?: {
    nodes: DocumentGraphNode[]
    edges: DocumentGraphEdge[]
    totalDocs: number
    truncated: boolean
    note?: string
  }
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
  sourceWarning?: string | null
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
  sourceWarning?: string | null
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

interface ElectronRSSAPI extends RSSSieveAPI {
  readExcerpt: (input: import('../../shared/rss-excerpt').RSSReadExcerptInput) => Promise<RSSResponse<import('../../shared/rss-excerpt').RSSSelectionExcerpt>>
  readDigests: (input?: import('../../shared/rss-digests').RSSDigestReadInput) => Promise<RSSResponse<import('../../shared/rss-digests').RSSDigestReadResult>>
  digestSettings: () => Promise<RSSResponse<import('../../shared/rss-digests').RSSDigestScheduleState | null>>
  configureDigests: (input: import('../../shared/rss-digests').RSSDigestSettings) => Promise<RSSResponse<import('../../shared/rss-digests').RSSDigestScheduleState>>
  generateDigest: (input: import('../../shared/rss-digests').RSSDigestGenerateInput) => Promise<RSSResponse<import('../../shared/rss-digests').RSSDigestHeader>>
  exportDigest: (input: { reportId: string }) => Promise<RSSResponse<{ canceled: boolean; path?: string; reportId?: string }>>
  onDigestsChanged: (callback: () => void) => () => void
  markEventFactsSeen: (input: { factIds: string[] }) => Promise<RSSResponse<{ changed: number; seenIds: string[] }>>
  onEventSeenChanged: (callback: () => void) => () => void
  queryCards: (query?: import('../../shared/rss-workspace').RSSQueryInput) => Promise<RSSResponse<import('../../shared/rss-workspace').RSSQueryResult>>
  readEvents: (input?: import('../../shared/rss-events').RSSReadEventsInput) => Promise<RSSResponse<import('../../shared/rss-events').RSSReadEventsResult>>
  moveEventMember: (input: import('../../shared/rss-events').RSSEventMoveInput) => Promise<RSSResponse<import('../../shared/rss-events').RSSEventMembership>>
  mergeEvents: (input: import('../../shared/rss-events').RSSEventMergeInput) => Promise<RSSResponse<import('../../shared/rss-events').RSSEventSummary>>
  processingStatus: () => Promise<RSSResponse<import('../../shared/rss-processing').RSSProcessingStatus>>
  processingJobs: (input?: import('../../shared/rss-processing').RSSProcessingListInput) => Promise<RSSResponse<import('../../shared/rss-processing').RSSProcessingList>>
  configureProcessing: (input: import('../../shared/rss-processing').RSSProcessingSettings) => Promise<RSSResponse<import('../../shared/rss-processing').RSSProcessingSettings>>
  reprocessArticle: (input: { itemId: string; expectedArticleRevision: string }) => Promise<RSSResponse<{ jobIds: string[] }>>
  retryUnresolvedProcessing: (input: { expectedCount: number }) => Promise<RSSResponse<{ queued: number; jobIds: string[] }>>
  cancelProcessing: (id: string) => Promise<RSSResponse<{ id: string }>>
  resumeProcessing: () => Promise<RSSResponse<{ requested: boolean }>>
  getDefinitions: () => Promise<RSSResponse<import('../../shared/rss-organization').RSSDefinition[]>>
  saveDefinition: (input: import('../../shared/rss-organization').RSSDefinitionWrite) => Promise<RSSResponse<import('../../shared/rss-organization').RSSDefinition>>
  removeDefinition: (input: { id: string; expectedRevision: number }) => Promise<RSSResponse<{ id: string }>>
  setMembership: (input: import('../../shared/rss-organization').RSSMembershipWrite) => Promise<RSSResponse<import('../../shared/rss-organization').RSSMembership[]>>
  onOrganizationChanged: (callback: () => void) => () => void
  saveArticleNote: (input: import('../../shared/rss-workspace').RSSSaveNoteInput) => Promise<RSSResponse<import('../../shared/rss-workspace').RSSNoteSaveResult>>
  exportQuery: (input: import('../../shared/rss-workspace').RSSQueryInput) => Promise<RSSResponse<import('../../shared/rss-workspace').RSSQueryExportResult>>
  queryItems: (query?: import('../../shared/rss-workspace').RSSQueryInput) => Promise<RSSResponse<import('../../shared/rss-workspace').RSSQueryResult>>
  dismissQuery: (input: import('../../shared/rss-workspace').RSSQueryInput) => Promise<RSSResponse<{ dismissed: number }>>
  readArticle: (input: import('../../shared/rss-workspace').RSSReadArticleInput) => Promise<RSSResponse<import('../../shared/rss-workspace').RSSArticleExcerpt>>
  translateArticle: (input: import('../../shared/rss-translation').RSSTranslateArticleInput) => Promise<RSSResponse<import('../../shared/rss-translation').RSSArticleTranslation>>
  readTranslation: (input: import('../../shared/rss-translation').RSSTranslationRef) => Promise<RSSResponse<import('../../shared/rss-translation').RSSArticleTranslation | null>>
  cancelTranslation: (input: import('../../shared/rss-translation').RSSTranslationRef) => Promise<RSSResponse<null>>
  onTranslationChanged: (callback: (ref: import('../../shared/rss-translation').RSSTranslationRef) => void) => () => void
  loadArticle: (input: { itemId: string; force?: boolean }) => Promise<RSSResponse<Omit<import('../../shared/rss-workspace').RSSArticle, 'body'> & { body: Omit<import('../../shared/rss-workspace').RSSArticle['body'], 'markdown'> }>>
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
  autoRefreshStatus: () => Promise<RSSResponse<RSSAutoRefreshSnapshot>>
  onAutoRefreshCompleted: (callback: (snapshot: RSSAutoRefreshSnapshot) => void) => () => void
  status: () => Promise<RSSResponse<RSSStatusData>>
  stats: () => Promise<
    RSSResponse<{
      totalSources: number
      totalItems: number
      unreadItems: number
      platformDistribution: Record<string, number>
      categories: Array<{ id: string; name: string; count: number }>
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
    type?: string
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
  prepareStandaloneImport(): Promise<CalendarResponse<{ ticket:string; fileName:string; calendars:number; events:number; possibleExamples:number } | null>>
  applyStandaloneImport(ticket:string,skipExamples:boolean): Promise<CalendarResponse<{ created:number; skipped:number }>>
  getAttachmentDisplayRefs(messageIds: string[]): Promise<CalendarResponse<import('../../shared/calendar-event-identity').CalendarAttachmentDisplayRef[]>>
  revealEvent(id: string): Promise<CalendarResponse<boolean>>
  revealDay(date: string): Promise<CalendarResponse<boolean>>
  peekNavigation(): Promise<CalendarResponse<import('../../shared/calendar/desktop').CalendarNavigationRequest | null>>
  ackNavigation(id: string): Promise<CalendarResponse<void>>
  onNavigation(handler: () => void): () => void
  createMeetingNote(input: import('../../shared/calendar/event-links').MeetingNoteInput): Promise<CalendarResponse<import('../../shared/calendar/event-links').MeetingNoteReceipt>>
  pendingMeetingNote(key: string): Promise<CalendarResponse<import('../../shared/document-drafts').DraftFinalizeInput | null>>
  snapshot(): Promise<CalendarResponse<import('../../shared/calendar/commands').CalendarSnapshot>>
  mutate(command: import('../../shared/calendar/commands').CalendarCommand, versions: Record<string, number>): Promise<CalendarResponse<import('../../shared/calendar/commands').CalendarMutationReceipt>>
  restore(delta: import('../../shared/calendar/commands').CalendarDelta, versions: Record<string, number>): Promise<CalendarResponse<import('../../shared/calendar/commands').CalendarMutationReceipt>>
  putCalendars(calendars: import('../../shared/calendar/model').Calendar[]): Promise<CalendarResponse<import('../../shared/calendar/commands').CalendarSnapshot>>
  putCalendar(calendar: import('../../shared/calendar/model').Calendar): Promise<CalendarResponse<import('../../shared/calendar/commands').CalendarSnapshot>>
  deleteCalendar(id: string): Promise<CalendarResponse<import('../../shared/calendar/commands').CalendarSnapshot>>
  putPreferences(prefs: Record<string, unknown>): Promise<CalendarResponse<import('../../shared/calendar/commands').CalendarSnapshot>>
  exportIcs(id?: string): Promise<CalendarResponse<string>>
  importCalendar(raw: string, name: string, sourceId?: string): Promise<CalendarResponse<{ sourceId: string; created: number; updated: number; skipped: number }>>
  openIcs(): Promise<CalendarResponse<{ name: string; text: string; sourceId: string } | null>>
  saveIcs(name: string, text: string): Promise<CalendarResponse<boolean>>
  openLink(url: string): Promise<CalendarResponse<boolean>>
  getLoginItem(): Promise<CalendarResponse<boolean>>
  setLoginItem(enabled: boolean): Promise<CalendarResponse<boolean>>
  onChanged(handler: () => void): () => void
  getSources: () => Promise<CalendarResponse<CalendarSourceData[]>>
  getEvents: (start: Date, end: Date, timeZone?: string) => Promise<CalendarResponse<CalendarEventData[]>>
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
  requiredBins?: string[]
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
  getSkillRuntimeProvisionState: () => Promise<IPCResponse<RuntimeProvisionTaskSnapshot>>
  provisionSkillRuntime: (payload?: { force?: boolean }) => Promise<IPCResponse<RuntimeProvisionTaskSnapshot>>
  cancelSkillRuntimeProvision: () => Promise<IPCResponse<RuntimeProvisionTaskSnapshot>>
  getSkillRuntimeMirror: () => Promise<IPCResponse<string>>
  setSkillRuntimeMirror: (payload: { mirror: string }) => Promise<IPCResponse<void>>
  selfTestSkillRuntime: () => Promise<IPCResponse<RuntimeStatus>>
  onSkillRuntimeProvisionUpdate?: (handler: (snapshot: RuntimeProvisionTaskSnapshot) => void) => () => void
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
  /** 生效的透明度：用户的“减少透明”或系统的“减少透明度”任一打开即为 reduced（W1 DL12） */
  transparency: Transparency
  /** 用户自己的“减少透明”开关 */
  reduceTransparency: boolean
  /** 主窗口当前是否在 macOS 原生 fullscreen 态。renderer 启动 reconciliation 用以同步 data-native-fullscreen attr */
  isNativeFullscreen: boolean
}

interface ElectronThemeAPI {
  set: (theme: string) => Promise<void>
  /** “减少透明”开关；不触发昼夜 ritual，只改变 DOM 层的不透明底与浮层模糊 */
  setReduceTransparency: (enabled: boolean) => Promise<ThemeSnapshotPayload>
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
  browserLiveProofHandshake: (nonce: string) => Promise<{
    success: boolean
    error?: string
    proofNonce?: string
    pid?: number
    execPath?: string
    execSha256?: string
    asarPath?: string | null
    asarSha256?: string | null
    sourceManifestDigest?: string
    appPath?: string
    runtimeOutputManifestDigest?: string | null
    bootIncarnationId?: string
    userDataPath?: string
    databasePath?: string
    appVersion?: string
  }>
  browserLiveProofInspectFrozenCall: (payload: unknown) => Promise<{
    success: boolean
    error?: string
    frozenCallId?: string
    readyRunId?: string | null
    scopeId?: string | null
    toolName?: string
    proof?: Record<string, unknown>
  }>
  browserLiveProofQuit: (nonce: string) => Promise<{ success: boolean; error?: string }>
  checkUpdate: () => Promise<{ success: boolean; version?: string | null; error?: string }>
  installUpdate: () => Promise<void>
  captureWindow: () => Promise<{ success: boolean; path?: string; error?: string }>
  writeImageToClipboard: (payload: { path: string; text?: string }) => Promise<{ success: boolean; error?: string }>
  onUpdateStatus: (callback: (data: ElectronUpdateStatus) => void) => () => void
  onShortcut: (callback: (data: ElectronAppShortcutEvent) => void) => () => void
  onBeforeQuitFlush: (callback: (requestId: string) => void) => () => void
  onBeforeQuitFlushCancelled: (callback: (requestId: string) => void) => () => void
  ackBeforeQuitFlushed: (requestId: string, outcome: RendererStateFlushOutcome) => void
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
  authMode?: 'api-key' | 'chatgpt-oauth'
  modelIds?: string[]
  displayName?: string
  agentProtocol?: 'anthropic' | 'openai'
  wireApi?: 'chat/completions' | 'responses'
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
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
  | 'anysearch'
  | 'duckduckgo'
  | 'jina'
  | 'rsshub'
  | 'bilibili'
  | 'github'
  | 'amap'
  | 'vision-model'
  | 'image-generation'

type ExternalServiceOptionValueData = string | number | boolean | string[] | null

interface PublicExternalServiceProfileData {
  id: string
  kind: ExternalServiceKindData
  name: string
  enabled: boolean
  baseUrl?: string
  options: Record<string, ExternalServiceOptionValueData>
  secretStatus: Record<string, {
    configured: boolean
    state: 'ready' | 'missing' | 'recovery_required' | 'vault_unavailable'
    masked?: string
  }>
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
  getAIConfig: () => Promise<{ success: boolean; data?: AIModelConfigData | null; error?: string }>
  setAIConfig: (config: AIModelConfigData) => Promise<{ success: boolean; error?: string }>
  getAIWorkspace: () => Promise<{ success: boolean; data?: AIProviderWorkspaceData; error?: string }>
  setAIWorkspace: (workspace: AIProviderWorkspaceData) => Promise<{ success: boolean; error?: string }>
  testAIConnection: (
    config: AIModelConfigData
  ) => Promise<{ success: boolean; data?: SettingsTestResult; error?: string }>
  cancelChatGptOAuth: (operationId: string) => Promise<{ success: boolean; data?: ChatGptOAuthStatus; error?: string }>
  reopenChatGptOAuth: (operationId: string) => Promise<{ success: boolean; error?: string }>
  getChatGptOAuthStatus: () => Promise<{
    success: boolean
    data?: ChatGptOAuthStatus
    error?: string
  }>
  connectChatGptOAuth: () => Promise<{
    success: boolean
    data?: ChatGptOAuthStatus
    error?: string
  }>
  resumeChatGptOAuth: () => Promise<{
    success: boolean
    data?: ChatGptOAuthStatus
    error?: string
  }>
  disconnectChatGptOAuth: () => Promise<{
    success: boolean
    data?: ChatGptOAuthStatus
    error?: string
  }>
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

interface ElectronImageGenerationAPI {
  persistToDocument: (input: {
    sourcePath: string
    documentPath: string
  }) => Promise<IPCResponse<{ path: string; name: string; relativePath?: string }>>
  persistToDirectory: (input: {
    sourcePath: string
    directoryPath: string
  }) => Promise<IPCResponse<{ path: string; name: string; relativePath?: string }>>
  copyToClipboard: (input: { sourcePath: string }) => Promise<IPCResponse>
}

interface ElectronPetAPI {
  getSettings: () => Promise<IPCResponse<PetSettings>>
  updateSettings: (patch: Partial<PetSettings>) => Promise<IPCResponse<PetSettings>>
  listPets: () => Promise<IPCResponse<PetDefinition[]>>
  getSnapshot: () => Promise<IPCResponse<PetWindowSnapshot>>
  show: () => Promise<IPCResponse<PetWindowSnapshot>>
  hide: () => Promise<IPCResponse<boolean>>
  setPet: (petId: string) => Promise<IPCResponse<PetSettings>>
  resetPosition: () => Promise<IPCResponse<PetSettings>>
  moveBy: (delta: { dx: number; dy: number }) => Promise<IPCResponse<boolean>>
  pushStickyNote: (note: PetStickyNoteInput) => Promise<IPCResponse<PetStickyNote>>
  dismissStickyNote: (id: string) => Promise<IPCResponse<boolean>>
  clearStickyNotes: () => Promise<IPCResponse<boolean>>
  snapshotApplied: (applied: { revision: number; contentDigest: string }) => void
  openActivity: (activity: PetActivityOpenIdentity) => Promise<IPCResponse<boolean>>
  activityOpened: (activity: PetActivityOpenIdentity) => void
  scopeViewed: (scopeId: string) => void
  onOpenActivity: (callback: (activity: PetActivityOpenIdentity) => void) => () => void
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
  updateConversationTitle: (data: {
    id: string
    title: string
  }) => Promise<{ success: boolean; error?: string }>
  pickFiles: () => Promise<{ success: boolean; data?: ChatPickedFile[]; error?: string }>
  savePastedImage: (bytes: Uint8Array) => Promise<{ success: boolean; data?: import('../../shared/chat-pasted-image').PastedImageFile; error?: string }>
  readFileForAI: (
    filePath: string
  ) => Promise<{ success: boolean; data?: ChatFileForAI; error?: string }>
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
  type: 'follow_up' | 'crystallize' | 'prepare' | 'harvest' | 'forming'
  title: string
  evidence: Array<{ fact: string; ref: string }>
  confidence: number
  action: {
    kind:
      | 'adjudicate_task'
      | 'supply_input'
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
  readyRunId?: string | null
  aliasGeneration?: number | null
  messageVisibilityEpoch?: number | null
  questions: AskUserQuestionsCardQuestionPayload[]
  askedAt: number
}

interface AskUserQuestionsPendingCard {
  cardId: string
  conversationId: string | null
  readyRunId?: string | null
  aliasGeneration?: number | null
  messageVisibilityEpoch?: number | null
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
}
interface ElectronTagForgeAPI {
  prepareCreation:(payload:{sourceRunId:string;path:string;workspaceRoots:string[];content:string;proposals:Array<{facet:'form'|'domain'|'entity'|'use';label:string;evidenceCode:string;evidenceExcerpt:string;confidence:number}>;creationPending:boolean})=>Promise<IPCResponse<{receiptId:string;content:string;tags:string[];workflowState:string|null}|null>>
  finalizeCreation: (payload:{receiptId:string;sourceRunId:string;path:string;workspaceRoots:string[]})=>Promise<IPCResponse<{receiptId:string;revision:string;path:string;status:'completed'}>>
}

interface ElectronAPI {
  agent: ElectronAgentAPI
  runQuality: ElectronRunQualityAPI
  runFeedback: ElectronRunFeedbackAPI
  emergence: ElectronEmergenceAPI
  browser: ElectronBrowserAPI
  objectRelations: import('../../main/modules/object-relations/contract').ObjectRelationsAPI
  objects: ObjectPresentationAPI
  document: ElectronDocumentAPI
  canvas: import('../../main/modules/board-engine/ipc').CanvasAPI
  canvasComposition: import('../../shared/document-drafts').CanvasCompositionAPI
  fastCard: import('../../shared/fastcard').FastCardTransferAPI & import('../../shared/fastcard').FastCardQuickNoteAPI
  linkPreview: { get(url: string): Promise<import('../../shared/fastcard').FastCardIPCResult<import('../../main/modules/link-preview').LinkPreview>> }
  sourceAnnotations: import('../../main/modules/library-engine/source-document-ipc').SourceAnnotationsAPI
  rss: ElectronRSSAPI
  dateMentions: import('../../shared/calendar/date-mentions').DateMentionsAPI
  calendarLinkage: import('../../shared/calendar-linkage').CalendarLinkageAPI
  /** Calendar projections and Markdown todo list/toggle/schedule receipts. */
  calendarLayers: import('../../shared/calendar-layers').CalendarLayersAPI
  calendar: ElectronCalendarAPI
  skills: ElectronSkillsAPI
  app: ElectronAppAPI
  window: ElectronWindowAPI
  theme: ElectronThemeAPI
  settings: ElectronSettingsAPI
  vault: import('../../shared/vault').VaultAPI
  documentDrafts: import('../../shared/document-drafts').DocumentDraftAPI
  documentPages: import('../../shared/document-pages').DocumentPagesAPI
  documentAnnotations: import('../../shared/document-comments').DocumentAnnotationsAPI
  documentImport: import('../../shared/document-import').DocumentImportAPI
  documentDatabase: (request: import('../../shared/document-database').DatabaseRequest) => Promise<import('../../shared/document-database').DatabaseReply>
  bookSources: import('../../shared/library-sources').BookSourcesAPI
  libraryArchive: import('../../shared/library').LibraryArchiveAPI
  library: import('../../shared/library').LibraryHighlightAPI & {
    prepareAgentSelection(input: import('../modules/agent/libraryResourceSelection').LibrarySelectionRequest): Promise<LibraryResult<import('../../shared/ipc-contracts/agent-runtime').LibraryResourceSelection[]>>
    get(): Promise<LibraryResult<LibraryState>>
    importFiles(paths: string[]): Promise<LibraryResult<LibraryImportResult>>
    pickAndImport(): Promise<LibraryResult<LibraryImportResult>>
    updateBook(input: { id: string; patch: LibraryBookPatch }): Promise<LibraryResult<LibraryBook>>
    getPosition(bookId: string): Promise<LibraryResult<LibraryReadingPosition | null>>
    setPosition(position: LibraryReadingPosition): Promise<LibraryResult<LibraryReadingPosition>>
    listBookmarks(bookId: string): Promise<LibraryResult<LibraryBookmark[]>>
    setBookmarks(input: { bookId: string; bookmarks: LibraryBookmark[] }): Promise<LibraryResult<LibraryBookmark[]>>
    onChanged(listener: (state: LibraryState) => void): () => void
  }
  imageGeneration: ElectronImageGenerationAPI
  fileEmergence: ElectronFileEmergenceAPI
  tagForge: ElectronTagForgeAPI
  pet: ElectronPetAPI
  chat: ElectronChatAPI
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
  displayName: string
  toolCount: number
  toolNames: string[]
  approvalMode: 'always' | 'writes' | 'never'
  clientConnected: boolean
  resourceCount: number
  resourceTemplateCount: number
  catalogGeneration: number
  catalogDigest: string
  serverInfo: Record<string, unknown> | null
  instructions: string | null
  stderrTail: string
  lastError?: string
}

export interface ElectronMcpStatus {
  rawConfig: string
  configs: ElectronMcpServerConfig[]
  configuredCount: number
  skipped: Array<{ reason: string }>
  servers: ElectronMcpServerStatus[]
  catalogGeneration: number
  catalogDigest: string
}

export interface ElectronMcpServerConfig {
  id: string
  displayName: string
  enabled: boolean
  command: string
  args: string[]
  approvalMode: 'always' | 'writes' | 'never'
  envEntries: Array<{ key: string; value: string; hasStoredValue?: boolean }>
}

export interface ElectronMcpAPI {
  getStatus: () => Promise<ElectronMcpStatus>
  saveConfig: (servers: ElectronMcpServerConfig[]) => Promise<{
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
  listResources: (serverId: string) => Promise<IPCResponse<{
    serverId: string
    catalogGeneration: number
    catalogDigest: string
    resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>
    resourceTemplates: Array<{ uriTemplate: string; name?: string; description?: string; mimeType?: string }>
  }>>
  readResource: (payload: { serverId: string; uri: string; catalogGeneration: number }) => Promise<IPCResponse<{
    serverId: string
    uri: string
    catalogGeneration: number
    catalogDigest: string
    content: Record<string, unknown>
    contentDigest: string
  }>>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export type {
  RunQualityDayData,
  RunQualityStatsData,
  RunFeedbackRecordData,
  EmergenceCardData,
  EmergenceFeedEntryData,
  TaskProjectionRecordData,
  RecoveryRecordData,
  ReferenceSkillHintData,
  DetachedSkillTaskData,
  ActiveChildRunSummaryData
}
