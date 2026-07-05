import type { MemorySession } from '@openai/agents'
import type { AIModelConfig } from '../../../../shared/ai-providers'
import type {
  BudgetWarningLevel,
  RunBudgetSeed,
  RunBudgetUsage,
  RunMessage,
  TaskBudgetRuntime,
} from '../contracts/run-contracts'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'
import type { TurnTerminalReason } from './turn-frame'
import type { AbortInitiator } from '../contracts/run-contracts-internal'
import type { AIConfigLoad } from '../../claude-bridge/direct-chat-ai-config'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import type { ToolRuntimeActiveFrameContext } from '../tools-runtime/tool-runtime'
import type { AgentSpawnContext } from '../../../../shared/skill-host-contract'
import type { BrowserTurnLease } from '../../browser-engine/agent-browser-turn-lease'
import type { DomainAdapter } from '../domain-adapters/domain-adapter'
import type {
  resumeSkillChildRun as defaultResumeSkillChildRun,
  waitForSkillChildRunClose as defaultWaitForSkillChildRunClose,
} from '../skills/skill-child-runner'
import type { toToolExecutorContext } from '../tools-runtime/tool-runtime-context-builder'
import type { ContinuationIntent, ContinuationState } from '../contracts/continuation-state'
import type { FollowupTaskRef } from '../../../../shared/agent-followup-intent'
import type {
  SpecialistBlueprintSourceMessageUnavailableReason,
} from '../../../../shared/agent-specialist-blueprint'
import type { CompactResult } from '../compaction/compact-agent-input'
import type { AgentInputItem, ModelProvider } from '@openai/agents'
import { type Tool as AgentSdkTool } from '@openai/agents'

export interface AgentSdkSession {
  sdkSession: MemorySession
  systemPrompt: string
  generation: number
  currentRun: RunHandle | null
  orphanCount: number
  pendingCompact: PendingCompact | null
  contextWindowTokens: number
  lastUsageTokens: number
}

export interface RunHandle {
  runId: string
  runGeneration: number
  abortController: AbortController | null
  abortInitiator: AbortInitiator | null
  settled: Promise<void>
  resolveSettled: () => void
  capturedSession: MemorySession
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
  | { ok: true; session: AgentSdkSession; runHandle: RunHandle; abortController: AbortController; runGeneration: number }
  | { ok: false; reason: 'superseded' | 'orphan_limit'; message: string; currentRunId?: string | null }

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
  onTextDelta: (delta: string) => void
}

export interface ReadyAgentSdkRunResult {
  finalText: string
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
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
  currentUserText?: string
  sourceMessageId?: string | null
  sourceMessageUnavailableReason?: SpecialistBlueprintSourceMessageUnavailableReason | null
  requestEnvelope?: unknown
  signal: AbortSignal
  allowedToolNames: string[]
  definitionByName: Map<string, ToolDefinition>
  authorization: SkillToolAuthorization
  activeFrame: ToolRuntimeActiveFrameContext
  agentContext?: AgentSpawnContext | null
  documentTargetGuard?: DocumentTargetGuard | null
  emitOutput: (chunk: string, type: string, projectionPatch?: Record<string, unknown> | null) => void
  emitToolAction: (toolName: string, args: Record<string, unknown>) => void
  recordToolResult: (toolName: string, output: ToolExecutionOutput) => void
  nativeMapCriticalClose?: MapToolFailureClose | null
  nativeMapAmbiguityResolved?: boolean
  runHandle: RunHandle
  browserTurnLease?: BrowserTurnLease | null
  taskBudgetRuntime: TaskBudgetRuntime | null
  budgetWarningMessages: BudgetWarningLevel[]
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

export interface AgentSdkProviderDiagnostics {
  provider: string | null
  agentProtocol: string | null
  wireApi: string | null
  contextWindow: number | null
  protocolSource: 'explicit' | 'inferred' | null
  contextWindowSource: 'explicit' | 'model' | 'fallback' | null
}

export interface RunMetaRepositoryLike {
  get(runId: string): unknown | null
  create(input: Record<string, unknown>): unknown
  update(runId: string, patch: Record<string, unknown>): unknown
}

export interface AgentSdkExecutionOptions {
  taskId?: string
  publicSessionId?: string
  sourceMessageId?: string | null
  requestEnvelope?: unknown
  intentClassification?: unknown
  budget?: RunBudgetSeed | null
  budgetState?: RunBudgetUsage | null
  taskBudgetRuntime?: TaskBudgetRuntime | null
  continuationIntent?: ContinuationIntent | null
  continuationState?: ContinuationState | null
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
  }>
  buildPreferredSkillToolNames?: (userText: string, sessionId?: string) => string[] | null
  peekCurrentReferenceSkillHint?: (sessionId?: string) => { id: string; name: string } | null
  getCurrentReferenceSkillHint?: (sessionId?: string) => { id: string; name: string } | null
  rememberExplicitReferenceSkillHint?: (userText: string, sessionId?: string) => boolean
  maybeInjectExplicitSkillContext?: (params: {
    userText: string
    session: { messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> }
    sessionId?: string
    emitOutput: (chunk: string, type: string) => void
    emitToolAction: (tool: string, args: Record<string, unknown>) => void
    executeTool: (tool: string, args: Record<string, unknown>) => Promise<ToolExecutionOutput>
  }) => Promise<void>
}

export interface AgentSdkRuntimeDeps {
  domainAdapters?: ReadonlyArray<DomainAdapter>
  loadAIConfig?: () => AIConfigLoad
  runAgent?: (params: ReadyAgentSdkRunParams) => Promise<ReadyAgentSdkRunResult>
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
    recentCollectionIntent?: boolean
    recentBatchCollectionIntent?: boolean
    requestEnvelope?: unknown
  }) => ToolDefinition[]
  executeToolCall?: (
    toolName: string,
    args: Record<string, unknown>,
    context: ReturnType<typeof toToolExecutorContext>,
  ) => Promise<ToolExecutionOutput>
  fetchWithTimeout?: (
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    label: string,
    timeoutMs?: number,
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
