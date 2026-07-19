import type { BrowserPowerEffect } from './browser-power'

export interface DurableRequestAnchor {
  messageId: string
  messageDigest: string
  canonicalMessageSnapshot: {
    role: 'user'
    content: string
    timestamp: string
  }
  resourceAnchors: Array<{
    resourceId: string
    kind: string
    version: string | null
    contentDigest: string
    provenanceDigest: string
  }>
  snapshotDigest: string
  createdAt: string
}

export interface GoalMutationReceipt {
  mutationId: string
  sourceMessageId: string
  sourceMessageDigest: string
  operation: 'upsert' | 'supersede'
  goalId: string
  value: Record<string, unknown> | null
  createdAt: string
}

export interface ParentSteeringReceipt {
  receiptId: string
  messageId: string
  messageDigest: string
  sequence: number
  ownerRunIdAtIngress: string
  wakeClaimedByRunId: string | null
  contentCheckpointId: string | null
  consumedByOwnerRunId: string | null
  contentVersion: 1
  contentDigest: string
  resourceRefs: SteeringMessageResourceRef[]
  createdAt: string
}

export interface SteeringMessageResourceRef {
  resourceId: string
  ordinal: number
  blockType: 'text' | 'image' | 'video'
  mediaType: string | null
  contentDigest: string
  provenanceDigest: string
}

export type SteeringMessageContentInput = string | Array<{
  type: 'text' | 'image' | 'video'
  text?: string
  base64?: string
  mimeType?: string
}>

export interface HumanTakeoverRef {
  taskId: string
  takeoverId: string
  ownerRunId: string
  browserTaskId: string | null
  basisRevision: number
  state: 'pending' | 'claimed'
  claimedByRunId: string | null
  physicalTarget: BrowserHumanTakeoverPhysicalTarget | null
  createdAt: string
}

export interface BrowserHumanTakeoverPhysicalTarget {
  surface: 'user-view' | 'agent-view'
  scopeId: string | null
  profileId: string | null
  sessionId: string | null
  tabId: string
  physicalTargetToken: string
  source: 'physical_input' | 'supervision_button'
}

/** The Browser controller may request this durable boundary, but never writes
 * Parent or Browser-child state itself. */
export interface BrowserHumanTakeoverIntentInput extends BrowserHumanTakeoverPhysicalTarget {
  parentTaskId: string
  ownerRunId: string
  browserTaskId: string
}

export type BrowserHumanTakeoverIntentPort = (
  input: BrowserHumanTakeoverIntentInput,
) => Promise<{ takeoverId: string }>

export interface BrowserWorkflowWriteTarget {
  parentTaskId: string
  ownerRunId: string
  browserTaskId: string
  surface: 'user-view' | 'agent-view'
  scopeId: string | null
  profileId: string | null
  sessionId: string | null
  tabId: string
  physicalTargetToken: string
}

export type BrowserWorkflowWriteAdmissionPort = (
  target: BrowserWorkflowWriteTarget,
) => boolean

export interface BrowserPowerConfirmationSuspensionRequest {
  version: 1
  kind: 'browser_power_confirmation'
  requestId: string
  wakeKind: 'browser_power_confirmation'
  toolName: 'browser_eval' | 'browser_cdp'
  effects: BrowserPowerEffect[]
  actionIntent: {
    objectRef: string
    inputHash: string
  }
  target: {
    scopeId: string
    ownerRunId: string
    browserTaskId: string
    tabId: string | null
    documentKeyHash: string
    origin: string | null
    targetDigest: string
  }
  purpose: string
}

export interface BrowserPermissionSuspensionRequest {
  version: 1
  kind: 'browser_permission'
  requestId: string
  wakeKind: 'browser_permission'
  toolName: 'browser_permission'
  actionIntent: {
    siteRequestId: string
    permission: string
    origin: string
    decision: 'allow' | 'deny'
    inputHash: string
  }
  target: {
    scopeId: string
    ownerRunId: string
    browserTaskId: string
    tabId: string
    targetDigest: string
  }
  purpose: 'site_permission_request'
}

export type BrowserConfirmationSuspensionRequest =
  | BrowserPowerConfirmationSuspensionRequest
  | BrowserPermissionSuspensionRequest

/** Exhaustive durable sources allowed to create a new Browser owner. A fresh
 * observation is deliberately absent: unfinished effects stay with the
 * current owner or wait for another real wake source. */
export const BROWSER_CHECKPOINT_WAKE_KINDS = [
  'user_continue',
  'browser_power_confirmation',
  'browser_permission',
  'steering',
  'human_takeover',
  'provider_transfer',
  'background_ready',
  'foreground_resume',
  'capability_revision',
  'config_revision',
  'owner_crash',
] as const

export type BrowserCheckpointWakeKind = typeof BROWSER_CHECKPOINT_WAKE_KINDS[number]

export type BrowserCheckpointSuspensionReason =
  | 'human_takeover'
  | 'browser_power_confirmation'
  | 'browser_permission'
  | 'budget'
  | 'steering'
  | 'background'
  | 'foreground'
  | 'capability'
  | 'config'
  | 'provider_transfer'
  | 'owner_crash'
  | 'manual'

export function browserWakeKindForSuspensionReason(
  reason: BrowserCheckpointSuspensionReason,
): BrowserCheckpointWakeKind {
  switch (reason) {
    case 'human_takeover': return 'human_takeover'
    case 'browser_power_confirmation': return 'browser_power_confirmation'
    case 'browser_permission': return 'browser_permission'
    case 'steering': return 'steering'
    case 'provider_transfer': return 'provider_transfer'
    case 'owner_crash': return 'owner_crash'
    case 'background': return 'background_ready'
    case 'foreground': return 'foreground_resume'
    case 'capability': return 'capability_revision'
    case 'config': return 'config_revision'
    case 'budget':
    case 'manual':
      return 'user_continue'
    default: {
      const unreachable: never = reason
      return unreachable
    }
  }
}

/** Parent-owned authoritative pointers. Recovery never guesses by timestamp. */
export interface AgentCheckpointRefs {
  cleanBaseCheckpointId: string | null
  suspensionCheckpointId: string | null
}

export interface BrowserOwnerCrashRecoveryReceipt {
  version: 1
  receiptId: string
  failedOwnerRunId: string
  checkpointId: string
  errorDigest: string
  createdAt: string
}

export interface BrowserWorkflowCloseoutSeal {
  parentRevision: number
  requestAnchorSnapshotDigest: string
  browserTaskId: string
  childRevision: number
  childPayloadDigest: string
  childEvidenceDigest: string
}

/** Code-issued receipt binding verifier acceptance to one immutable Browser
 *  workflow snapshot, one terminal candidate and its derived quality patch. */
export interface BrowserWorkflowCompletionVerifierReceipt {
  version: 1
  verdict: 'accept'
  parentTaskId: string
  ownerRunId: string
  candidateDigest: string
  workflowCloseoutSealDigest: string
  sealedCandidateDigest: string
  terminalQualityPatchDigest: string
  verifiedAt: string
}

export type SkillSurfaceComposition = 'additive' | 'exclusive'

export type ExclusiveScopeRef = { kind: 'owner'; ownerRunId: string }
