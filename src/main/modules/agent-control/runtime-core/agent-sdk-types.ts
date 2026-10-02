import type { MemorySession } from '@openai/agents'
import type { AIModelConfig } from '../../../../shared/ai-providers'
import type {
  RunBudgetSeed,
  RunBudgetUsage,
  RunMessage,
  TaskBudgetRuntime
} from '../contracts/run-contracts'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import type { TurnTerminalReason } from './turn-frame'
import type { AbortInitiator } from '../contracts/run-contracts-internal'
import type { AIConfigLoad } from '../../claude-bridge/direct-chat-ai-config'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import type { PreparedSkillTurnTruth } from '../contracts/browser-workflow-control'
import type { ToolRuntimeActiveFrameContext } from '../tools-runtime/tool-runtime'
import type { AgentSpawnContext } from '../../../../shared/skill-host-contract'
import type {
  ActiveToolUseModeUpdateRequest,
  ActiveToolUseModeUpdateResult
} from './tool-use-mode-config-update'
import type { BrowserTurnLease } from '../../browser-engine/agent-browser-turn-lease'
import type { DomainAdapter } from '../domain-adapters/domain-adapter'
import type { CapabilityResolution } from '../domain-adapters/capability-resolver'
import type {
  resumeSkillChildRun as defaultResumeSkillChildRun,
  waitForSkillChildRunClose as defaultWaitForSkillChildRunClose
} from '../skills/skill-child-runner'
import type { toToolExecutorContext } from '../tools-runtime/tool-runtime-context-builder'
import type { ContinuationIntent, ContinuationState } from '../contracts/continuation-state'
import type { FollowupTaskRef } from '../../../../shared/agent-followup-intent'
import type { CompactResult } from '../compaction/compact-agent-input'
import type { AgentInputItem, ModelProvider } from '@openai/agents'
import { type Tool as AgentSdkTool } from '@openai/agents'
import type { SkillSurfaceComposition, ExclusiveScopeRef } from '../../../../shared/browser-workflow-control'

export interface AgentSdkSession {
  sdkSession: MemorySession
  systemPrompt: string
  /** Stable scope context generation owned by this in-memory transcript. */
  messageVisibilityEpoch: number
  generation: number
  currentRun: RunHandle | null
  orphanCount: number
  pendingCompact: PendingCompact | null
  contextWindowTokens: number
  lastUsageTokens: number
}

export interface AgentSdkSkillCatalogSnapshotEntry {
  id: string
  name: string
  description: string
  managedPath?: string
  readOnlyDependencyRoots?: string[]
}

export interface RunHandle {
  runId: string
  runGeneration: number
  abortController: AbortController | null
  abortInitiator: AbortInitiator | null
  settled: Promise<void>
  resolveSettled: () => void
  capturedSession: MemorySession
  /** 本轮 turn-execution 装配的模型流存活监听（reasoning/thinking 增量也算活）；turn 收尾必须清空。 */
  noteModelStreamActivity?: (() => void) | null
}

export interface PendingCompact {
  reason: CompactReason
}

export type CompactReason = 'overflow' | 'manual' | 'queued'

export type CompactSessionResult =
  | { status: 'compacted' | 'noop'; report: CompactResult['report'] }
  | { status: 'queued' }
  | { status: 'not_found' | 'superseded'; message: string }

export type BeginRunResult =
  | {
      ok: true
      session: AgentSdkSession
      runHandle: RunHandle
      abortController: AbortController
      runGeneration: number
    }
  | {
      ok: false
      reason: 'superseded' | 'orphan_limit' | 'active_owner_exists'
      message: string
      currentRunId?: string | null
    }

export interface ReadyAgentSdkRunParams {
  agentName: string
  runId: string
  taskId: string
  sessionId?: string
  input: string | AgentInputItem[]
  instructions: string
  model: string
  provider: ModelProvider
  session: MemorySession
  tools: AgentSdkTool[]
  signal: AbortSignal
  maxTurns: number
  contextWindowTokens: number
  maxOutputTokens: number
  onTextDelta: (delta: string) => void
  /** Runs after SDK compaction and before each provider request. */
  callModelInputFilter?: (
    items: AgentInputItem[],
    context: { sourceItems: AgentInputItem[]; compacted: boolean },
  ) => Promise<AgentInputItem[]>
}

export interface ReadyAgentSdkRunResult {
  finalText: string
  outputIncomplete?: boolean
  iterationsUsed?: number
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    /** 最后一次 provider 请求的实报 input（合同 §5：上下文占用显示最后一次真实请求，不是整轮累计）。 */
    lastRequestInputTokens?: number
  }
  lastResponseId?: string
}

export interface MapToolFailureClose {
  message: string
  status: 'checkpoint' | 'error'
  terminalReason: TurnTerminalReason
  success: boolean
}

export interface ToolBridgeRuntimeContext {
  agentName: string
  runId: string
  taskId: string
  sessionId?: string
  messageVisibilityEpoch?: number
  executionBinding?: import('../../../../shared/agent-execution-profile').TaskExecutionBinding | null
  executionProfile?: import('../../../../shared/agent-execution-profile').AgentExecutionProfile | null
  currentUserText?: string
  sourceMessageId?: string | null
  requestEnvelope?: unknown
  signal: AbortSignal
  canPublishScopeRunEvent: () => boolean
  allowedToolNames: string[]
  definitionByName: Map<string, ToolDefinition>
  authorization: SkillToolAuthorization
  preparedSkillTurn: PreparedSkillTurnTruth
  /** `use_skill` refreshes this exact request's authorization and returns the
   *  newly enabled definitions for the next model iteration. */
  activateSkillForCurrentRun?: (skillId: string) => ToolDefinition[] | null
  activateBrowserForCurrentRun?: () => ToolDefinition[]
  ensureBrowserWorkflowRoute?: () => Promise<{
    browserTaskId: string
    requestAnchorSnapshotDigest: string
  }>
  browserWorkflowRoute?: {
    browserTaskId: string
    requestAnchorSnapshotDigest: string
  } | null
  /** Exact Browser registry operations whose standard results are present in
   * the owner-local history.  This is an accumulated typed closure, never
   * inferred from tool names or user text. */
  browserRequiredOperationIds: string[]
  /** Highest contiguous settled mutate result that has crossed the standard
   * tool-result boundary for this owner. */
  lastEffectiveBrowserActionSeq: number
  /** Journal-derived actions that still require a causally linked readback. */
  browserObservationGaps: Array<{
    actionId: string
    actionSeq: number
    operationId: string
    outcome: Record<string, unknown>
    clearedByObservationSeq: number | null
  }>
  browserObservationBarrier?: {
    actionId: string
    actionSeq: number
    operationId: string
    outcome: Record<string, unknown>
    clearedByObservationSeq: number | null
  } | null
  /** Run-local admission latch for the single observation-closing model
   * response. It never replaces the journal-derived barrier; it only keeps a
   * second tool call in the same response observe-only after the first read
   * has already cleared that barrier. */
  browserObservationClosureActive?: boolean
  browserSuspensionRequest?: (
    | { kind: 'human_takeover'; takeoverId: string }
    | import('../../../../shared/browser-workflow-control').BrowserConfirmationSuspensionRequest
  ) | null
  browserSuspensionCanonicalReceipt?: import('../../../../shared/ipc-contracts/canonical-message').CanonicalAssistantMessageReceipt | null
  confirmedBrowserPowerRequest?: import('../../../../shared/browser-workflow-control').BrowserPowerConfirmationSuspensionRequest | null
  confirmedBrowserPowerRequestConsumed?: boolean
  confirmedBrowserPermissionRequest?: import('../../../../shared/browser-workflow-control').BrowserPermissionSuspensionRequest | null
  confirmedBrowserPermissionRequestConsumed?: boolean
  sameRunActivatedSkillId?: string | null
  activatedCapabilityGroups: string[]
  skillSurfaceComposition: SkillSurfaceComposition
  exclusiveScopeRef: ExclusiveScopeRef | null
  useTextToolBridge?: boolean
  activeFrame: ToolRuntimeActiveFrameContext
  agentContext?: AgentSpawnContext | null
  documentTargetGuard?: DocumentTargetGuard | null
  emitOutput: (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null
  ) => void
  emitToolAction: (toolName: string, args: Record<string, unknown>) => void
  recordToolResult: (toolName: string, output: ToolExecutionOutput) => void
  beginToolExecution?: (
    definition: ToolDefinition,
    args: Record<string, unknown>,
  ) => string
  endToolExecution?: (token: string, error?: unknown) => void
  latestResearchSearchDelivery?: import('./research-result-delivery').ResearchSearchDelivery | null
  nativeMapCriticalClose?: MapToolFailureClose | null
  nativeMapAmbiguityResolved?: boolean
  runHandle: RunHandle
  browserTurnLease?: BrowserTurnLease | null
  taskBudgetRuntime: TaskBudgetRuntime | null
  hostControl?: 'handoff_takeover' | null
  toolExecutionChain?: Promise<void>
}

export interface InterruptedToolExecution {
  toolName: string
  args: Record<string, unknown>
  startedAtMs: number
  expectedTimeoutMs: number
}

export interface SdkLongSkillCheckpoint {
  toolName: string
  skillId: string | null
  action: string | null
  childRunId: string | null
  outputDir: string | null
  runStatePath: string | null
  terminalReason: TurnTerminalReason
}

export interface AgentSdkBudgetCheckpoint {
  outputDir: string
  runStatePath: string
  projectionPatch: Record<string, unknown>
}

export interface AgentSdkBudgetCheckpointRestore {
  sessionSnapshot: AgentInputItem[]
  taskBudgetRuntime: TaskBudgetRuntime
  requiredCapabilityGroups: string[]
  requiredToolNames: string[]
  usedToolNames: string[]
  runStatePath: string
}

export type AgentSdkBudgetCheckpointLoadResult =
  | { status: 'absent' }
  | {
      status: 'invalid'
      runStatePath: string
      reason:
        | 'unreadable'
        | 'corrupt'
        | 'wrong_kind'
        | 'wrong_resume_kind'
        | 'task_mismatch'
        | 'scope_mismatch'
        | 'invalid_budget'
    }
  | { status: 'loaded'; restore: AgentSdkBudgetCheckpointRestore }

export interface AgentSdkProviderDiagnostics {
  provider: string | null
  agentProtocol: string | null
  wireApi: string | null
  contextWindow: number | null
  protocolSource: 'explicit' | 'inferred' | null
  contextWindowSource: 'explicit' | 'model' | 'fallback' | null
  lastProviderFailureHttpStatus?: number | null
  lastProviderFailureErrorKind?: string | null
}

export interface RunMetaRepositoryLike {
  get(runId: string): unknown | null
  create(input: Record<string, unknown>): unknown
  update(runId: string, patch: Record<string, unknown>): unknown
}

export interface AgentSdkExecutionOptions {
  taskId?: string
  publicSessionId?: string
  messageVisibilityEpoch?: number
  sourceMessageId?: string | null
  requestEnvelope?: unknown
  intentClassification?: unknown
  budget?: RunBudgetSeed | null
  budgetState?: RunBudgetUsage | null
  taskBudgetRuntime?: TaskBudgetRuntime | null
  continuationIntent?: ContinuationIntent | null
  continuationState?: ContinuationState | null
  executionBinding?: import('../../../../shared/agent-execution-profile').TaskExecutionBinding | null
  executionProfile?: import('../../../../shared/agent-execution-profile').AgentExecutionProfile | null
  /** Typed product choice; never inferred from user text. */
  deliveryMode?: import('../../../../shared/dynamic-delivery').DeliveryMode
}

export interface DocumentTargetGuard {
  targetName: string
  targetPath: string
  opened: boolean
  preserveExistingContent: boolean
  initialContent?: string
  requiredPreservedSnippets?: string[]
  openToolDefinition?: ToolDefinition
  saveToolDefinition?: ToolDefinition
}

export type ObservedDocumentSaveState = 'saved' | 'dirty' | 'unsaved'

export interface ObservedDocumentToolTarget {
  tabId: string
  title: string
  path: string | null
  dirty: boolean
  requiresSave: boolean
  saveState: ObservedDocumentSaveState
}

export interface SkillContextOrchestratorLike {
  findExplicitlyRequestedSkills?: (userText: string) => Array<{
    id?: string
    skillId?: string
    name?: string
    managedPath?: string
    requiredBins?: readonly string[]
  }>
  buildPreferredSkillToolNames?: (
    userText: string,
    sessionId?: string,
    observedHint?: { id: string; name: string; applicableToolNames?: string[] } | null,
  ) => string[] | null
  observeCurrentReferenceSkillHint?: (sessionId?: string) => { id: string; name: string; applicableToolNames?: string[] } | null
  peekCurrentReferenceSkillHint?: (sessionId?: string) => { id: string; name: string; applicableToolNames?: string[] } | null
  getCurrentReferenceSkillHint?: (sessionId?: string) => { id: string; name: string; applicableToolNames?: string[] } | null
  rememberExplicitReferenceSkillHint?: (
    userText: string,
    sessionId?: string,
    messageVisibilityEpoch?: number,
  ) => boolean
  rememberReferenceSkillToolApplicability?: (
    skillId: string,
    toolNames: readonly string[],
    sessionId?: string,
    messageVisibilityEpoch?: number,
  ) => boolean
  maybeInjectExplicitSkillContext?: (params: {
    userText: string
    session: { messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> }
    sessionId?: string
    messageVisibilityEpoch?: number
    emitOutput: (chunk: string, type: string) => void
    emitToolAction: (tool: string, args: Record<string, unknown>) => void
    executeTool: (tool: string, args: Record<string, unknown>) => Promise<ToolExecutionOutput>
  }) => Promise<void>
}

export interface AgentSdkRuntimeDeps {
  domainAdapters?: ReadonlyArray<DomainAdapter>
  loadAIConfig?: () => AIConfigLoad
  runAgent?: (params: ReadyAgentSdkRunParams) => Promise<ReadyAgentSdkRunResult>
  setActiveToolUseMode?: (
    request: ActiveToolUseModeUpdateRequest
  ) => ActiveToolUseModeUpdateResult | Promise<ActiveToolUseModeUpdateResult>
  dispatchToolConsentRetry?: (input: {
    scopeId: string
    agent: string
    message: string | import('../contracts/run-contracts').MultimodalBlock[]
    requestId: string
    taskId: string
    deliveryMode?: import('../../../../shared/dynamic-delivery').DeliveryMode
    runOrigin?: import('../../../../shared/agent-execution-profile').RunExecutionOrigin
  }) => Promise<unknown>
  listToolDefinitions?: (params: {
    message: RunMessage
    sessionId?: string
    scopeId?: string
    config: AIModelConfig
    browserHostAvailable: boolean
    feishuConnected: boolean
    /** Phase I —— scope 绑定远程渠道线程时暴露 channel_outbound。 */
    channelScopeBound?: boolean
    authorization: SkillToolAuthorization
    localSendImIntent?: boolean
    skillSurfaceComposition?: import('../../../../shared/browser-workflow-control').SkillSurfaceComposition
    requestEnvelope?: unknown
    /** P2-2 — the L1 skill catalog is non-empty this turn (gates use_skill exposure). */
    skillCatalogAvailable?: boolean
    /** Frozen boolean only; the API key remains owned by ExternalServiceStore. */
    mapRouteServiceAvailable?: boolean
    onCapabilityResolution?: (resolution: CapabilityResolution) => void
  }) => ToolDefinition[]
  executeToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
    context: ReturnType<typeof toToolExecutorContext>
  ) => Promise<ToolExecutionOutput>
  fetchWithTimeout?: (
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    label: string,
    timeoutMs?: number
  ) => Promise<Response>
  skillContextOrchestrator?: SkillContextOrchestratorLike | null
  resumeSkillChildRun?: typeof defaultResumeSkillChildRun
  waitForSkillChildRunClose?: typeof defaultWaitForSkillChildRunClose
  /** EP2-I1 — task-ref facts for state-first follow-up routing (05 §2.1).
   *  Absent = legacy text-recall behavior (facts unavailable). */
  getScopeTaskRefs?: (scopeId: string) => FollowupTaskRef[]
}

export type TerminalFailureReason =
  | 'delivery_failed'
  | 'tool_unavailable'
  | 'no_artifact'
  | 'proof_gap'
  | 'browser_transaction_unconfirmed'

/** One tool result inside a native-SDK tool-bridge turn (name + args + structured output). */
export interface ToolBridgeResultItem {
  id: string
  name: string
  args: Record<string, unknown>
  result: ToolExecutionOutput
}
