import type { TaskType } from '../../../../shared/task-types'
import type {
  BudgetWarningLevel,
  TaskBudget,
  TaskBudgetRuntime,
  TaskProjectionRecord,
} from '../contracts/run-contracts'
import type { DeliveryStateV1 } from '../../../../shared/dynamic-delivery'
import type { CanonicalAssistantMessageReceipt } from '../../../../shared/ipc-contracts/canonical-message'
import type {
  BrowserWorkflowCloseoutSeal,
  BrowserWorkflowCompletionVerifierReceipt,
} from '../../../../shared/browser-workflow-control'
import type { CheckInRecord } from '../quality/task-adjudicator'

export interface RunCloseMetric {
  runId: string
  terminalReason: string
  initiator: string
  toolCallsUsed: number
  durationMs: number
  taskType?: string | null
  lastProviderFailureHttpStatus?: number | null
  lastProviderFailureErrorKind?: string | null
}

export interface FinalizedRunOutcome {
  status: string
  terminalReason: string
  canonicalMessage?: CanonicalAssistantMessageReceipt['canonicalMessage']
  canonicalMessageDigest?: string
}

export interface RunOutcomeProviderDiagnostics {
  provider?: string | null
  agentProtocol?: string | null
  wireApi?: string | null
  contextWindow?: number | null
  protocolSource?: 'explicit' | 'inferred' | null
  contextWindowSource?: 'explicit' | 'model' | 'fallback' | null
  usageSource?: 'provider' | 'estimated' | 'missing'
  providerCallCount?: number
  missingCallCount?: number
  lastProviderFailureHttpStatus?: number | null
  lastProviderFailureErrorKind?: string | null
}

export interface RunOutcomeUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

interface RunOutcomeTaskFacts {
  taskBudgetRuntime?: TaskBudgetRuntime | null
  providerDiagnostics?: RunOutcomeProviderDiagnostics | null
  usage?: RunOutcomeUsage | null
  workflowCloseoutSeal?: BrowserWorkflowCloseoutSeal | null
  workflowVerifierAcceptance?: Omit<
    BrowserWorkflowCompletionVerifierReceipt,
    'parentTaskId' | 'ownerRunId' | 'terminalQualityPatchDigest'
  > | null
  canonicalMessageReceipt?: CanonicalAssistantMessageReceipt | null
}

interface RunOutcomeBase {
  runId: string
  taskId?: string | null
  scopeId?: string | null
  messageVisibilityEpoch?: number
  durationMs: number
  toolCallsUsed: number
  initiator: string
  projectionPatch?: Record<string, unknown> | null
  terminalReason?: string | null
  finalText?: string | null
}

export type RunOutcome =
  | ({ kind: 'done' } & RunOutcomeBase & RunOutcomeTaskFacts)
  | ({ kind: 'checkpoint'; continuationHandle: string | null } & RunOutcomeBase & RunOutcomeTaskFacts)
  | ({
      kind: 'error' | 'cancelled' | 'preempted' | 'interrupted'
      terminalReason: string
    } & RunOutcomeBase & RunOutcomeTaskFacts)

export interface RunMetaRepositoryLike {
  get(runId: string): unknown | null
  create(input: Record<string, unknown>): unknown
  update(runId: string, patch: Record<string, unknown>): unknown
}

export interface TerminalAdjudicationDecision {
  verdict: CheckInRecord['verdict']
  blockers: string[]
  proofCount: number
  satisfiedCount: number
  derived: {
    checkIn: CheckInRecord
    projection: TaskProjectionRecord
    now: Date
    projectionPatch: Partial<TaskProjectionRecord>
    persistProjectionPatch: boolean
  }
  terminalQualityPatch?: {
    proofRefs: unknown[]
    checkins: unknown[]
    criteria: Record<string, unknown>
    learningRefs?: unknown[]
  }
}

export interface RunFinalizerDeps {
  runMetaRepository?: RunMetaRepositoryLike | null
  writeProjectionTerminalPatch?: (
    projectionPatch: Record<string, unknown> | null,
    terminalReason: string,
    status: string,
    canonicalReceipt?: CanonicalAssistantMessageReceipt,
  ) => void | Promise<void>
  commitCanonicalCoreCloseout?: (input: {
    parentTaskId: string
    ownerRunId: string
    status: 'done' | 'error' | 'cancelled' | 'interrupted'
    terminalReason: string
    initiator: string
    durationMs: number
    finalText: string
    conversationId: string
    taskType?: string | null
    module?: string | null
    budget?: TaskBudget | null
    budgetUsagePercent?: number | null
    budgetWarningLevel?: BudgetWarningLevel | null
    providerDiagnostics?: Record<string, unknown> | null
    usage?: RunOutcomeUsage | null
    deliveryState?: DeliveryStateV1 | null
    workflowCloseoutSeal?: BrowserWorkflowCloseoutSeal | null
    terminalQualityPatch?: TerminalAdjudicationDecision['terminalQualityPatch'] | null
    completionVerifierReceipt?: BrowserWorkflowCompletionVerifierReceipt | null
  }) => Promise<CanonicalAssistantMessageReceipt>
  writeRunCloseMetric: (metric: RunCloseMetric) => void
  taskProjectionStore?: {
    get(taskId: string): TaskProjectionRecord | null
    update(
      taskId: string,
      patch: Partial<TaskProjectionRecord>,
      options?: { silent?: boolean; reasonHint?: string }
    ): void
  } | null
  now?: () => Date
  learnFromCheckIn?: (input: {
    checkIn: CheckInRecord
    projection: TaskProjectionRecord
    now: Date
    terminalStatus?: string | null
    terminalReason?: string | null
  }) => void
  verifyRunStateTerminal?: (runStatePath: string) => boolean
  verifyArtifactExists?: (path: string) => boolean
}

export type EffectiveTaskType = TaskType | string | null
