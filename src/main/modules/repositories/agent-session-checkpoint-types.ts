import type {
  BrowserCheckpointWakeKind,
  BrowserWorkflowCloseoutSeal,
  BrowserWorkflowCompletionVerifierReceipt,
  DurableRequestAnchor,
  ParentSteeringReceipt,
  SteeringMessageContentInput,
} from '../../../shared/browser-workflow-control'
import type { TaskExecutionBinding } from '../../../shared/agent-execution-profile'
import type { DeliveryStateV1 } from '../../../shared/dynamic-delivery'
import type { CanonicalAssistantMessageReceipt } from '../../../shared/ipc-contracts/canonical-message'
import type { VerifiedBrowserWorkflowEvidence } from '../browser-engine/browser-workflow-evidence'
import type {
  AgentSessionCheckpoint,
  BrowserWorkflowParentRecord,
} from './browser-workflow-row-mapping'

export interface BrowserObservationGap {
  browserTaskId: string
  actionId: string
  actionSeq: number
  operationId: string
  outcome: Record<string, unknown>
}

interface BrowserWorkflowCloseoutInspectionBase {
  browserTaskId: string
  childRevision: number
  evidence: VerifiedBrowserWorkflowEvidence
}

export type BrowserWorkflowCloseoutInspection =
  | { state: 'absent'; browserTaskId: null; childRevision: null; evidence: null; seal: null }
  | (BrowserWorkflowCloseoutInspectionBase & { state: 'action_in_flight'; seal: null })
  | (BrowserWorkflowCloseoutInspectionBase & { state: 'observation_required'; seal: null })
  | (BrowserWorkflowCloseoutInspectionBase & { state: 'research_incomplete'; seal: null })
  | (BrowserWorkflowCloseoutInspectionBase & {
      state: 'sealable'
      seal: BrowserWorkflowCloseoutSeal
    })

export interface PersistSteeringInput {
  parentTaskId: string
  ownerRunId: string
  message: {
    id: string
    conversationId: string
    content: string
    structuredContent: SteeringMessageContentInput
    timestamp: string
    meta?: Record<string, unknown>
  }
  repairDerivedState?: (
    message: {
      id: string
      conversationId: string
      role: 'user'
      content: string
      timestamp: string
      meta: Record<string, unknown>
    },
    messageDigest: string,
  ) => Promise<void>
}

export interface BindBrowserWorkflowRouteInput {
  parentTaskId: string
  ownerRunId: string
  sourceMessageId?: string | null
  executionBinding: TaskExecutionBinding
  resourceAnchors?: DurableRequestAnchor['resourceAnchors']
  now?: string
}

export interface BrowserWorkflowRouteBinding {
  browserTaskId: string
  requestAnchorSnapshotDigest: string
  parentRevision: number
  dependencyGeneration: number
}

export interface HumanTakeoverResumeBinding {
  parent: BrowserWorkflowParentRecord
  browserTaskId: string
  checkpoint: AgentSessionCheckpoint
  previousOwnerRunId: string
  newOwnerRunId: string
}

export interface BrowserCheckpointWakeReceiptInput {
  wakeId: string
  kind: BrowserCheckpointWakeKind
  sourceId: string
  sourceDigest: string
  checkpointId: string
  basisRevision: number
  issuedAt: string
  decision?: 'confirmed' | 'denied'
}

export interface CanonicalCoreCloseoutInput {
  parentTaskId: string
  ownerRunId: string
  browserTaskId?: string | null
  status: 'done' | 'error' | 'cancelled' | 'interrupted'
  terminalReason: string
  initiator: string
  durationMs: number
  finalText: string
  conversationId: string
  taskType?: string | null
  budget?: Record<string, unknown> | null
  providerDiagnostics?: Record<string, unknown> | null
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null
  deliveryState?: DeliveryStateV1 | null
  continuationRef?: Record<string, unknown> | null
  workflowCloseoutSeal?: BrowserWorkflowCloseoutSeal | null
  terminalQualityPatch?: {
    proofRefs: unknown[]
    checkins: unknown[]
    criteria: Record<string, unknown>
    learningRefs?: unknown[]
  } | null
  completionVerifierReceipt?: BrowserWorkflowCompletionVerifierReceipt | null
  repairDerivedState?: (receipt: CanonicalAssistantMessageReceipt) => Promise<void>
  now?: string
}

export interface CanonicalCoreCloseoutResult extends CanonicalAssistantMessageReceipt {
  parent: BrowserWorkflowParentRecord
  browserTaskId: string | null
}

export interface BrowserWorkflowVerifierBundle {
  requestText: string
  requestDigest: string
  browserTaskId: string
  seal: BrowserWorkflowCloseoutSeal
  evidence: VerifiedBrowserWorkflowEvidence
}

export interface BrowserWorkflowVerifierInspection {
  inspection: BrowserWorkflowCloseoutInspection
  bundle: BrowserWorkflowVerifierBundle | null
}
