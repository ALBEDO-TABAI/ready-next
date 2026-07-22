import type { MemorySession, ModelProvider } from '@openai/agents'
import { classifyFollowupIntent } from '../../../../shared/agent-followup-intent'
import { resolveAIConfigCapabilities } from '../../../../shared/ai-providers'
import { buildAgentSpawnContextFromAIConfig } from '../../skills-runtime/agent-context-source'
import type {
  ExecutionTurnResult,
  RunMessage,
  TaskBudgetRuntime,
  TurnTranscriptEvent
} from '../contracts/run-contracts'
import { computeCapabilityFloors } from '../domain-adapters/capability-floors'
import type { RequestedCapabilityConflict } from '../domain-adapters/capability-resolver'
import type { SkillToolAuthorization } from '../skills/skill-tool-authorization'
import type { PreparedSkillTurnTruth } from '../contracts/browser-workflow-control'
import type { ResolvedSkillSurfaceComposition } from '../skills/skill-surface-composition'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import { createEmptyActiveFrameContext } from '../tools-runtime/tool-runtime'
import { resolveSkillHintRelevanceForTurn } from './agent-sdk-skill-intent-utils'
import { buildExecutionTurnResult } from './agent-sdk-turn-closeout'
import type { TurnOrchestratorHost } from './agent-sdk-turn-context'
import type {
  AgentSdkBudgetCheckpointRestore,
  AgentSdkExecutionOptions,
  AgentSdkProviderDiagnostics,
  AgentSdkSession,
  AgentSdkSkillCatalogSnapshotEntry,
  DocumentTargetGuard,
  ObservedDocumentToolTarget,
  ReadyAgentSdkRunResult,
  RunHandle,
  SdkLongSkillCheckpoint
} from './agent-sdk-types'
import type { TurnTerminalReason } from './turn-frame'
import type { CanonicalAssistantMessageReceipt } from '../../../../shared/ipc-contracts/canonical-message'

export interface AgentSdkPreparedTurnState {
  actionAnnouncementSteered: boolean
  criteriaSelfCheckInjected: boolean
  fileReadExcerptCheckpointForRecovery: string | null
  finalText: string
  hasSuccessfulDocumentTargetMutation: boolean
  hasSuccessfulLocalDocumentSourceRead: boolean
  hasSuccessfulLocalDocumentSourceReadForRecovery: boolean
  hasSuccessfulToolProgress: boolean
  lastDocumentSaveFailure: string | null
  lastDocumentSaveSuccessText: string | null
  lastRollingCheckpointToolCalls: number
  longSkillCheckpoint: SdkLongSkillCheckpoint | null
  newDocumentNeedsSave: boolean
  observedDocumentMutationConflict: boolean
  observedDocumentMutationMissingTarget: boolean
  observedDocumentMutationTarget: ObservedDocumentToolTarget | null
  runMetaBudgetRuntime: TaskBudgetRuntime | null
  runMetaContinuationRef: Record<string, unknown> | null
  runMetaProviderDiagnostics: AgentSdkProviderDiagnostics | null
  runMetaUsage: ReadyAgentSdkRunResult['usage'] | null
  sessionRestoreNotice: string | null
  skillClarificationSteered: boolean
  checkpointCanonicalReceipt: CanonicalAssistantMessageReceipt | null
  finishProviderTransferCheckpoint: ((
    providerDiagnostics: AgentSdkProviderDiagnostics | null,
  ) => Promise<ExecutionTurnResult | null>) | null
}

export interface AgentSdkPreparedTurnContext {
  state: AgentSdkPreparedTurnState
  host: TurnOrchestratorHost
  name: string
  runId: string
  taskId: string
  sessionId?: string
  runStartedAt: number
  content: RunMessage
  pureUserTurnText: string
  effectiveExecutionOptions?: AgentSdkExecutionOptions
  checkpointRestore: AgentSdkBudgetCheckpointRestore | null
  checkpointRequiredCapabilityGroups: string[]
  checkpointRequiredToolNames: string[]
  skillHintRelevanceForTurn: ReturnType<typeof resolveSkillHintRelevanceForTurn>
  skillCatalogSnapshot: readonly AgentSdkSkillCatalogSnapshotEntry[]
  turnCapabilityFloors: ReturnType<typeof computeCapabilityFloors>
  toolDefinitions: ToolDefinition[]
  abortController: AbortController
  runHandle: RunHandle
  committedPublicSession: MemorySession
  session: AgentSdkSession
  isCurrentRun: () => boolean
  toolArgsByName: Map<string, Record<string, unknown>[]>
  transcriptEvents: TurnTranscriptEvent[]
  usedTools: string[]
  projectionPatches: Record<string, unknown>[]
  emitOutputForRun: (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null,
    canonicalReceipt?: CanonicalAssistantMessageReceipt,
  ) => void
  emitOutput: (
    chunk: string,
    type: string,
    projectionPatch?: Record<string, unknown> | null
  ) => void
  emitHeartbeat: (text: string) => void
  emitStatusForRun: (status: string, terminalReason?: TurnTerminalReason | null) => void
  finalizeEarlyReturn: (params: {
    status: 'done' | 'checkpoint' | 'error' | 'cancelled'
    terminalReason: TurnTerminalReason
    finalText: string
    error?: string
    continuationHandle?: string | null
    taskBudgetRuntime?: TaskBudgetRuntime | null
    providerDiagnostics?: AgentSdkProviderDiagnostics | null
    initiator?: string
  }) => Promise<ExecutionTurnResult>
  finalizeBudgetCheckpointReturn: (checkpointText: string) => Promise<ExecutionTurnResult>
  buildResult: (params: Parameters<typeof buildExecutionTurnResult>[1]) => ExecutionTurnResult
  requestedCapabilityConflicts: readonly RequestedCapabilityConflict[]
  turnFollowup: ReturnType<typeof classifyFollowupIntent>
  useTextToolBridge: boolean
  documentTargetGuard: DocumentTargetGuard | null
  requiresLocalDocumentExcerpt: boolean
  preferCurrentDocumentRead: boolean
  requiresLocalDocumentWrite: boolean
  providerContent: RunMessage
  capabilities: ReturnType<typeof resolveAIConfigCapabilities>
  authorization: SkillToolAuthorization
  preparedSkillTurn: PreparedSkillTurnTruth
  skillSurface: ResolvedSkillSurfaceComposition
  activeFrame: ReturnType<typeof createEmptyActiveFrameContext>
  contextWindowTokens: number
  maxOutputTokens: number
  agentContext: ReturnType<typeof buildAgentSpawnContextFromAIConfig>
  provider: ModelProvider
  model: string
  nativeTextToolBoundaryFlush: { current: (() => void) | null }
}
