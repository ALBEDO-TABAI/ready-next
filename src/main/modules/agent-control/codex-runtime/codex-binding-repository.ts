import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import type { DatabaseConnection } from '../../database'
import { parseObjectStrict, workflowDigest } from '../../repositories/browser-workflow-codec'
import {
  readWorkflowVerifierBundleFromDb
} from '../../repositories/agent-session-checkpoint-route'
import {
  classifyLifecycleOperation,
  type LifecycleOperationFacts,
  type LifecycleOperationSnapshot,
} from '../../../../shared/ipc-contracts/agent-lifecycle-snapshot'
import {
  codexCurrentDocumentAnchorSchema,
  type CodexCurrentDocumentAnchor,
} from '../../../../shared/ipc-contracts/agent-runtime'
import type { StartIdentityReservationSet } from '../send-scoped-confirmation'
import {
  isPreparedCodexProductRun,
  type PreparedCodexProductRun,
} from './codex-product-run-preparer'
import type { CoreTurnCandidate } from './codex-turn-collector'
import { CodexBindingRepositoryError } from './codex-binding-error'
import {
  normalizeCodexThread,
  normalizeCodexTurn,
} from './codex-native-runtime'
import {
  canonicalJson,
  digestCanonicalJson,
  resolveCodexNativeModelSettings,
  type CodexUpstreamProfileSnapshot,
} from './codex-model-gateway-contract'
import {
  assertReadyBoundTurnToolAuthorization,
  assertReadyToolSurface,
  assertReadyTurnToolAuthorization,
  buildReadyBoundTurnToolAuthorization,
  type ReadyBoundTurnToolAuthorization,
  type ReadyToolSurface,
} from './codex-tool-surface'
import {
  effectiveCodexFolderOutputToolNames,
  readCodexFolderOutputActivation,
} from './codex-folder-output-activation'
import { CodexToolBindingRepository } from './codex-tool-binding-repository'
import { buildCodexToolActionIdentity } from './codex-tool-action-identity'
import { buildReadyToolActionAbsenceEvidenceDigest } from './codex-tool-action-journal'
import {
  codexBrowserVerifierFrozenIdentityDigest,
  type CodexBrowserVerifierIdentityProjection,
} from './codex-browser-verifier-identity'
import {
  advanceCodexConversationMessageVisibilityInOpenTransaction,
  closeCodexConversationScopeInOpenTransaction,
  readCodexClosedConversationScope,
} from './codex-conversation-scope-closure'
import {
  recordCodexThreadArchiveIntentInOpenTransaction,
  type CodexThreadArchiveSourceKind,
  type CodexThreadRetirementReason,
} from './codex-thread-archive-cleanup'
import {
  readProductTurnPresentation,
  readProductTurnPresentations,
} from './codex-product-turn-presentation'
import type { ProductTurnReceipt } from '../../../../shared/ipc-contracts/agent-runtime'
import type { ToolExecutionOutput } from '../tools-runtime/tool-result-types'
export { CodexBindingRepositoryError } from './codex-binding-error'
export type {
  CodexToolBridgeExecutionBinding,
  CodexToolCallBindingRead,
} from './codex-tool-binding-repository'

type StartMethod = 'thread/start' | 'turn/start'
type StartState = 'held' | 'pending' | 'recovery_held'
type RunResult = { changes?: number }
type JsonObject = Record<string, unknown>
type NativeTerminalCandidate = Extract<CoreTurnCandidate, { kind: 'native_terminal' }>

function assertNativeTerminalCandidate(value: unknown): asserts value is NativeTerminalCandidate {
  if (!isRecord(value)
    || value.kind !== 'native_terminal'
    || typeof value.readyTaskId !== 'string' || !value.readyTaskId
    || typeof value.readyRunId !== 'string' || !value.readyRunId
    || typeof value.scopeId !== 'string' || !value.scopeId
    || typeof value.codexThreadId !== 'string' || !value.codexThreadId
    || typeof value.codexTurnId !== 'string' || !value.codexTurnId
    || !['completed', 'interrupted', 'failed'].includes(String(value.engineOutcome))
    || !isRecord(value.candidateSelection)
    || !Array.isArray(value.usedToolCalls)
    || !value.usedToolCalls.every((entry) => isRecord(entry)
      && typeof entry.itemId === 'string' && entry.itemId.length > 0
      && typeof entry.tool === 'string' && entry.tool.length > 0
      && ['inProgress', 'completed', 'failed'].includes(String(entry.status))
      && (typeof entry.success === 'boolean' || entry.success === null)
      && (entry.responseDigest === undefined || entry.responseDigest === null
        || (typeof entry.responseDigest === 'string' && /^[0-9a-f]{64}$/.test(entry.responseDigest))))
    || !Array.isArray(value.actionReceiptRefs)
    || value.actionReceiptRefs.length !== 0
    || !Array.isArray(value.browserProofRefs)
    || !Array.isArray(value.otherProofRefs)
    || !Array.isArray(value.projectionPatchRefs)
    || !isRecord(value.runtimeDiagnostics)) {
    throw new CodexBindingRepositoryError('engine_terminal_candidate_invalid')
  }
  if (value.candidateSelection.kind === 'accepted') {
    if (typeof value.candidateSelection.itemId !== 'string' || !value.candidateSelection.itemId
      || typeof value.candidateText !== 'string'
      || typeof value.candidateDigest !== 'string'
      || createHash('sha256').update(value.candidateText).digest('hex') !== value.candidateDigest) {
      throw new CodexBindingRepositoryError('engine_terminal_candidate_invalid')
    }
    return
  }
  if (!['none', 'protocol_failure'].includes(String(value.candidateSelection.kind))
    || value.candidateText !== null || value.candidateDigest !== null) {
    throw new CodexBindingRepositoryError('engine_terminal_candidate_invalid')
  }
}

function readyToolResultSuccess(value: unknown): boolean | null {
  if (!isRecord(value)) return null
  if (isRecord(value.data)
    && (value.data.ok === false
      || (typeof value.data.errorKind === 'string' && value.data.errorKind.trim().length > 0))) {
    return false
  }
  if (isRecord(value.envelope)) return value.envelope.ok === true
  return true
}

type FrozenOutputDestination = {
  logicalResourceId: string
  path: string
  policyEpoch: number
  directoryIdentity: { device: string; inode: string; mode: number }
}

function frozenOutputDestination(ingressJson: string | null): FrozenOutputDestination | null {
  try {
    const ingress = JSON.parse(ingressJson || '') as unknown
    const prepared = isRecord(ingress) && isRecord(ingress.prepared) ? ingress.prepared : null
    const contract = prepared && isRecord(prepared.outputContract) ? prepared.outputContract : null
    const destination = contract && isRecord(contract.destination) ? contract.destination : null
    const identity = destination && isRecord(destination.directoryIdentity)
      ? destination.directoryIdentity
      : null
    if (!destination || !identity
      || typeof destination.logicalResourceId !== 'string'
      || typeof destination.path !== 'string'
      || !Number.isSafeInteger(destination.policyEpoch)
      || typeof identity.device !== 'string'
      || typeof identity.inode !== 'string'
      || !Number.isSafeInteger(identity.mode)) return null
    return {
      logicalResourceId: destination.logicalResourceId,
      path: destination.path,
      policyEpoch: Number(destination.policyEpoch),
      directoryIdentity: {
        device: identity.device,
        inode: identity.inode,
        mode: Number(identity.mode),
      },
    }
  } catch {
    return null
  }
}

function hashPath(path: string): { bytes: number; sha256: string } {
  const fd = openSync(path, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let bytes = 0
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null)
      if (count === 0) break
      hash.update(buffer.subarray(0, count))
      bytes += count
    }
  } finally {
    closeSync(fd)
  }
  return { bytes, sha256: hash.digest('hex') }
}

function safeTargetPath(root: string, relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/').trim()
  if (!normalized || isAbsolute(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')) return null
  const target = resolve(root, normalized)
  const rel = relative(resolve(root), target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return target
}

const CODEX_DELIVERY_LANE_TOOL_NAMES = new Set([
  'declare_completion_criteria',
  'skill_write_artifact',
  'skill_read_artifact',
  'skill_export_artifact',
])

export function currentDocumentReadReceiptMatches(
  receipt: unknown,
  expected: {
    readyRunId: string
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
    readyActionId: string | null
    actionIdentityDigest: string | null
    logicalResourceId: string
    currentVersion: string
    currentDigest: string
    policyEpoch: number
    tabId: string
    pane: 'primary' | 'split'
    pathDigest: string | null
    incarnationKey: string
    modelVisibleText: string
  },
): boolean {
  if (!isRecord(receipt)
    || typeof receipt.summaryDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(receipt.summaryDigest)
    || !Number.isSafeInteger(receipt.bodyBytes)
    || Number(receipt.bodyBytes) <= 0) return false
  const { modelVisibleText, ...identity } = expected
  if (receipt.summaryDigest !== createHash('sha256').update(modelVisibleText).digest('hex')
    || receipt.bodyBytes !== Buffer.byteLength(modelVisibleText)) return false
  const unsignedReceipt = {
    ...identity,
    operation: 'read_section',
    summaryDigest: receipt.summaryDigest,
    bodyBytes: receipt.bodyBytes,
  }
  return receipt.readyRunId === unsignedReceipt.readyRunId
    && receipt.codexThreadId === unsignedReceipt.codexThreadId
    && receipt.codexTurnId === unsignedReceipt.codexTurnId
    && receipt.codexCallId === unsignedReceipt.codexCallId
    && receipt.readyActionId === unsignedReceipt.readyActionId
    && receipt.actionIdentityDigest === unsignedReceipt.actionIdentityDigest
    && receipt.logicalResourceId === unsignedReceipt.logicalResourceId
    && receipt.currentVersion === unsignedReceipt.currentVersion
    && receipt.currentDigest === unsignedReceipt.currentDigest
    && receipt.policyEpoch === unsignedReceipt.policyEpoch
    && receipt.tabId === unsignedReceipt.tabId
    && receipt.pane === unsignedReceipt.pane
    && receipt.pathDigest === unsignedReceipt.pathDigest
    && receipt.incarnationKey === unsignedReceipt.incarnationKey
    && receipt.operation === unsignedReceipt.operation
    && receipt.receiptDigest === digestCanonicalJson(unsignedReceipt)
}

export type CodexBindingRecoveryMember = {
  reservationSetId: string
  reservationId: string
  scopeId: string
  method: StartMethod
  requiredMemberCount: 1 | 2
  state: StartState
  bindingId: string
  connectionEpoch: string | null
  rpcId: number | null
  crashSeam: 1 | 2 | 3 | 4 | 5 | 6
}

export type CodexBindingRecoveryGuard = {
  connectionEpoch: string
  rpcId: number
  method: StartMethod
  bindingId: string
  nativeId: string
}

export type CodexHostFailureRecovery = {
  readyRunId: string
  reservationSetId: string
  kind: string
  evidenceDigest: string
  continuationBlockedReason: 'start_delivery_absent' | 'publication_diverged'
}

export type CodexManualCompactionRecovery = {
  manualCompactionId: string
  threadBindingId: string
  codexThreadId: string
  codexCompactionTurnId: string | null
  preDispatchThreadReadDigest: string
  preDispatchTurnIds: string[]
  aliasId: string
  aliasGeneration: number
  upstreamProfileSnapshotDigest: string
  unknownAt: string | null
  unknownReason: string | null
  latestAttempt: null | {
    connectionEpoch: string
    rpcId: number
    childWriteAttemptedAt: string | null
    childWriteConfirmedAt: string | null
    unresolvedReason: string | null
    responseKind: 'accepted' | 'rejected' | null
  }
  state: 'pending' | 'quarantined'
  fenceQuarantined: boolean
}

export type CodexProductFenceRecovery = {
  threadBindingId: string
  readyRunId: string
  ownerMainBootId: string
  quarantinedAt: string | null
  quarantineReason: string | null
}

export type CodexProductFenceClaimRead = {
  readyRunId: string
  previousOwnerMainBootId: string
  ownerMainBootId: string
  revision: number
  transferred: boolean
  evidenceDigest: string | null
}

export type CodexBindingRecoverySnapshot = {
  members: CodexBindingRecoveryMember[]
  lateResponseGuards: CodexBindingRecoveryGuard[]
  hostFailureCloseouts: CodexHostFailureRecovery[]
  manualCompactions: CodexManualCompactionRecovery[]
  productFences: CodexProductFenceRecovery[]
}

export type CodexAdmittedBindingInput = {
  prepared: PreparedCodexProductRun
  reservation: StartIdentityReservationSet
  ownerMainBootId: string
  admittedAt: string
  ingressAdmittedRevision: number
  ingressAdmittedDigest: string
  threadBindingId: string
  isolatedThreadCwd: string
  turnRequestId: string
  runtimeManifestDigest: string
  protocolSchemaDigest: string
  instructionContractDigest: string
  codexModel: string
  upstreamProfileSnapshotRef: string
  upstreamProfileSnapshotDigest: string
  additionalContextDigest: string
  turnContractDigest: string
  messageVisibilityEpoch: number
  readyParentReceipt: {
        messageRole: 'user'
        messageContent: string
        messageTimestamp: string
        messageMetaDigest: string
        executionBindingDigest: string
      }
}

export function buildCodexIngressAdmissionReceipt(
  input: Omit<CodexAdmittedBindingInput, 'ingressAdmittedDigest'>,
): Record<string, unknown> {
  return {
    contract: 'codex_ingress_admission_v1',
    event: {
      type: 'ingress_admitted',
      requestId: input.prepared.ingressBinding.requestId,
      scopeId: input.prepared.readyToolHostIdentity.scopeId,
      originUserMessageId: input.prepared.ingress.originUserMessageId,
      messageVisibilityEpoch: input.messageVisibilityEpoch,
      ingressAdmittedRevision: input.ingressAdmittedRevision,
      admittedAt: input.admittedAt,
    },
    prepared: input.prepared,
    reservation: input.reservation,
    ownerMainBootId: input.ownerMainBootId,
    threadBindingId: input.threadBindingId,
    isolatedThreadCwd: input.isolatedThreadCwd,
    turnRequestId: input.turnRequestId,
    runtimeManifestDigest: input.runtimeManifestDigest,
    protocolSchemaDigest: input.protocolSchemaDigest,
    instructionContractDigest: input.instructionContractDigest,
    codexModel: input.codexModel,
    upstreamProfileSnapshotRef: input.upstreamProfileSnapshotRef,
    upstreamProfileSnapshotDigest: input.upstreamProfileSnapshotDigest,
    additionalContextDigest: input.additionalContextDigest,
    turnContractDigest: input.turnContractDigest,
    messageVisibilityEpoch: input.messageVisibilityEpoch,
    readyParentReceipt: input.readyParentReceipt,
  }
}

export function buildCodexIngressAdmittedDigest(
  input: Omit<CodexAdmittedBindingInput, 'ingressAdmittedDigest'>,
): string {
  return digestCanonicalJson(buildCodexIngressAdmissionReceipt(input))
}

export type CodexProcessLeaseIdentity = {
  processLeaseId: string
  ownerMainBootId: string
  ownerMainPid: number
  ownerMainProcessStartIdentity: string
  sidecarSpawnInstanceId: string
  connectionEpoch: string
  runtimeManifestDigest: string
  binarySha256: string
  executablePath: string
  isolatedStateDir: string
}

export type CodexProcessLeaseRow = CodexProcessLeaseIdentity & {
  singletonSlot: 1
  spawnIntentAt: string
  spawnVisibilityDeadlineAt: string
  pid: number | null
  processGroupId: number | null
  processStartIdentity: string | null
  ownershipConfirmedAt: string | null
  ownerMainDeadAt: string | null
  ownerMainDeathEvidenceDigest: string | null
  connectionOpenedAt: string | null
  closedAt: string | null
  treeZeroAt: string | null
  treeZeroMatcherMode: 'pre_cas' | 'post_cas' | null
  stableZeroSampleTranscriptDigest: string | null
  treeZeroEvidenceDigest: string | null
  revision: number
}

export type CodexEmptyAliasGenerationInput = {
  threadBindingId: string
  aliasId: string
  aliasGeneration: number
  readyScopeId: string
  runtimeManifestDigest: string
  protocolSchemaDigest: string
  createdAt: string
}

export type CodexActiveAliasBindingRead = {
  threadBindingId: string
  aliasId: string
  aliasGeneration: number
  readyScopeId: string
  codexThreadId: string | null
  codexSessionId: string | null
  isolatedThreadCwd: string | null
  toolSurface: ReadyToolSurface | null
  hasActiveFence: boolean
  continuationBlockedAt: string | null
  continuationBlockedReason: string | null
  retiredAt: string | null
}

export type CodexManualCompactionRouteRead = {
  threadBindingId: string
  aliasId: string
  aliasGeneration: number
  codexThreadId: string
  codexModel: string
  upstreamProfileSnapshotRef: string
  upstreamProfileSnapshotDigest: string
}

export type CodexProductTurnRuntimeRead = {
  readyRunId: string
  readyTaskId: string
  readyScopeId: string
  readyAliasId: string
  aliasGeneration: number
  threadBindingId: string
  codexThreadId: string | null
  codexTurnId: string | null
  gatewayClaimedCodexTurnId: string | null
  turnRequestId: string
  reservationSetId: string
  toolSurfaceDigest: string
  turnContractDigest: string
  instructionContractDigest: string
  upstreamProfileSnapshotRef: string
  upstreamProfileSnapshotDigest: string
  isolatedThreadCwd: string
  codexModel: string
  prepared: PreparedCodexProductRun
  ingress: PreparedCodexProductRun['ingress']
  admittedAt: string
  messageVisibilityEpoch: number
}

export type CodexEngineTerminalReceiptRead = {
  readyRunId: string
  codexThreadId: string
  codexTurnId: string
  engineOutcome: 'completed' | 'interrupted' | 'failed'
  candidate: unknown
  candidateDigest: string
  recordedAt: string
}

export type CodexToolPublicationReceiptRead = {
  readyRunId: string
  verifiedReceiptRefs: string[]
  receiptDigest: string
  recordedAt: string
}

export type CodexToolPublicationBarrierRead =
  | { kind: 'accepted'; verifiedReceiptRefs: string[]; code: null; callId: null }
  | {
      kind: 'diverged' | 'fabricated' | 'incomplete' | 'indeterminate'
      verifiedReceiptRefs: []
      code: string
      callId: string | null
    }

export type CodexProductCloseoutRead = {
  productTerminalDigest: string
  productCloseoutAt: string
}

export type CodexPublishedToolOutputRead = {
  itemId: string
  toolName: string
  output: ToolExecutionOutput
  completedAt: string
}

export type CodexBrowserVerifierVerdict = {
  version: 1
  verdict: 'accept' | 'repair' | 'block'
  gaps: Array<{
    kind: 'text' | 'artifact' | 'external_action'
    description: string
    targetRefId?: string
  }>
  summary: string
}

export type CodexBrowserVerifierAttemptOutcome =
  | 'accept'
  | 'repair'
  | 'block'
  | 'invalid'
  | 'provider_unavailable'
  | 'result_unknown'
  | 'identity_drift'

export type CodexBrowserVerifierAttemptRead = {
  attemptId: string
  readyRunId: string
  readyTaskId: string
  readyScopeId: string
  readyAliasId: string
  aliasGeneration: number
  threadBindingId: string
  codexThreadId: string
  codexTurnId: string
  candidateDigest: string
  frozenIdentityDigest: string
  upstreamProfileSnapshotRef: string
  upstreamProfileSnapshotDigest: string
  workflowCloseoutSealDigest: string
  status: 'dispatching' | 'settled'
  outcome: CodexBrowserVerifierAttemptOutcome | null
  verdict: CodexBrowserVerifierVerdict | null
  verdictDigest: string | null
  sealedCandidateDigest: string | null
  verificationUsage: unknown
  receiptDigest: string | null
  dispatchedAt: string
  verifiedAt: string | null
  settledAt: string | null
}

export type CodexProductInterruptOwnerRead = {
  readyRunId: string
  readyTaskId: string
  readyScopeId: string
  readyAliasId: string
}

export type CodexLifecycleAction = 'stop' | 'close' | 'reset'

export type CodexProductLifecycleActionRead = CodexProductInterruptOwnerRead & {
  aliasGeneration: number
  threadBindingId: string
  codexThreadId: string
  codexTurnId: string
  lifecycleAction: CodexLifecycleAction
  lifecycleActionRequestedAt: string
  lifecycleActionEvidenceDigest: string
}

export type CodexPendingInteractionBindingRead = {
  readyRunId: string
  readyTaskId: string
  readyScopeId: string
  readyAliasId: string
  aliasGeneration: number
  threadBindingId: string
  codexThreadId: string
  codexTurnId: string
  messageVisibilityEpoch: number
}

export type CodexProductStartStateRead = {
  codexThreadId: string | null
  codexTurnId: string | null
  threadStartDispatchIntentAt: string | null
  turnStartDispatchIntentAt: string | null
  hostFailureKind: string | null
  productCloseoutCommitted: boolean
}

export type CodexLifecycleOperationRead = {
  identity: { aliasId: string; aliasGeneration: number }
  facts: LifecycleOperationFacts
  activeReadyRunId: string | null
  activeManualCompactionId: string | null
  latestReadyRunId: string | null
  interruptRequested: boolean
  interruptAcknowledged: boolean
  requestedAction: CodexLifecycleAction | null
}

export type CodexLifecycleCloseoutRead = {
  aliasId: string
  aliasGeneration: number
  codexThreadId: string
  codexTurnId: string
  terminal: 'completed' | 'interrupted' | 'failed'
  closeoutDigest: string
  fenceReleaseRevision: number
}

export type CodexLifecycleActionCloseoutRead = CodexLifecycleCloseoutRead & {
  action: CodexLifecycleAction
  readyRunId: string
  lifecycleActionEvidenceDigest: string
  retiredGeneration: number
  retirementTransactionDigest: string
  archiveIntentDigest: string
  scopeClosureEvidenceDigest: string | null
  newGeneration: number | null
  newThreadBindingId: string | null
}

export type CodexModelGatewayBindingReadInput = {
  kind: 'product' | 'automatic_compaction' | 'manual_compaction'
  codexThreadId: string
  codexTurnId: string
  readyRunId: string | null
  toolSurfaceDigest: string | null
  turnContractDigest: string | null
  upstreamProfileSnapshotDigest: string | null
  receivedAt: string
}

export type CodexModelGatewayBindingRead = {
  kind: 'product' | 'automatic_compaction' | 'manual_compaction'
  ownerId: string
  codexModel: string
  upstreamProfileSnapshotRef: string
  upstreamProfileSnapshotDigest: string
  toolSurfaceDigest: string
  turnContractDigest: string | null
  instructionContractDigest: string
  additionalContextDigest: string | null
  providerSnapshotJson: string | null
  maxIterations: number | null
  iterationLanes: {
    ordinary: number
    delivery: number
    final: 1
  } | null
  toolCallsExhausted: boolean
  allowedToolNames: readonly string[] | null
}

type ThreadBindingRow = {
  thread_binding_id: string
  codex_thread_id: string | null
  codex_session_id: string | null
  codex_parent_thread_id: string | null
  codex_forked_from_id: string | null
  codex_source_json: string | null
  codex_thread_source_json: string | null
  thread_start_reservation_set_id: string | null
  thread_start_reservation_member_id: string | null
  thread_start_reservation_released_at: string | null
  thread_start_request_id: string | null
  thread_start_rpc_connection_epoch: string | null
  thread_start_rpc_id: number | null
  thread_start_dispatch_intent_at: string | null
  thread_start_child_write_confirmed_at: string | null
  thread_start_child_write_digest: string | null
  thread_start_response_at: string | null
  thread_start_reconciled_at: string | null
  thread_start_reconciliation_evidence_digest: string | null
  thread_start_late_response_guard_closed_at: string | null
  isolated_thread_cwd: string | null
  ready_conversation_alias: string
  alias_generation: number
  ready_scope_id: string
  runtime_manifest_digest: string
  protocol_schema_digest: string
  tool_surface_digest: string | null
  tool_surface_snapshot_digest: string | null
  tool_surface_json: string | null
  instruction_contract_digest: string | null
  codex_model_provider_id: string | null
  codex_model: string | null
  upstream_profile_snapshot_ref: string | null
  upstream_profile_snapshot_digest: string | null
  retired_at: string | null
  retired_reason: string | null
  retirement_evidence_digest: string | null
  continuation_blocked_at: string | null
  continuation_blocked_reason: string | null
  continuation_blocked_evidence_digest: string | null
  revision: number
}

type TurnBindingRow = {
  ready_run_id: string
  ready_task_id: string
  thread_binding_id: string
  codex_thread_id: string | null
  codex_turn_id: string | null
  gateway_claimed_codex_turn_id: string | null
  start_reservation_set_id: string
  start_reservation_required_member_count: number
  turn_start_reservation_member_id: string
  turn_start_reservation_released_at: string | null
  turn_request_id: string
  turn_start_rpc_connection_epoch: string | null
  turn_start_rpc_id: number | null
  turn_start_dispatch_intent_at: string | null
  turn_start_child_write_confirmed_at: string | null
  turn_start_child_write_digest: string | null
  turn_start_response_at: string | null
  turn_start_reconciled_at: string | null
  turn_start_reconciliation_evidence_digest: string | null
  turn_start_late_response_guard_closed_at: string | null
  host_failure_kind: string | null
  host_failure_recorded_at: string | null
  host_failure_evidence_digest: string | null
  host_failure_product_terminal_digest: string | null
  host_failure_closeout_at: string | null
  recovery_failure_code: string | null
  recovery_failure_evidence_digest: string | null
  recovery_failure_recorded_at: string | null
  product_terminal_digest: string | null
  product_closeout_at: string | null
  interrupt_requested_at: string | null
  interrupt_ack_at: string | null
  interrupt_state_unknown_at: string | null
  lifecycle_action: CodexLifecycleAction | null
  lifecycle_action_requested_at: string | null
  lifecycle_action_evidence_digest: string | null
  ingress_json: string | null
  attempt_kind: 'user_ingress'
    | 'recovery_successor' | 'checkpoint_successor' | 'explicit_retry'
  ingress_admitted_digest: string
  engine_terminal_status: 'completed' | 'interrupted' | 'failed' | null
  engine_terminal_candidate_json: string | null
  engine_terminal_candidate_digest: string | null
  engine_terminal_recorded_at: string | null
  publication_receipt_refs_json: string | null
  publication_receipt_digest: string | null
  publication_recorded_at: string | null
  effective_upstream_snapshot_ref: string
  effective_upstream_snapshot_digest: string
  fence_release_revision: number | null
  revision: number
}

type CodexBrowserVerifierAttemptRow = {
  attempt_id: string
  ready_run_id: string
  ready_task_id: string
  ready_scope_id: string
  ready_alias_id: string
  alias_generation: number
  thread_binding_id: string
  codex_thread_id: string
  codex_turn_id: string
  candidate_digest: string
  frozen_identity_digest: string
  upstream_profile_snapshot_ref: string
  upstream_profile_snapshot_digest: string
  workflow_closeout_seal_digest: string
  status: 'dispatching' | 'settled'
  outcome: CodexBrowserVerifierAttemptOutcome | null
  verdict_json: string | null
  verdict_digest: string | null
  sealed_candidate_digest: string | null
  verification_usage_json: string | null
  receipt_digest: string | null
  dispatched_at: string
  verified_at: string | null
  settled_at: string | null
}

type ClosedTurnUpstreamRouteRow = {
  effective_codex_model: string
  effective_upstream_snapshot_ref: string
  effective_upstream_snapshot_digest: string
}

type ProcessLeaseDbRow = {
  process_lease_id: string
  singleton_slot: number
  owner_main_boot_id: string
  owner_main_pid: number
  owner_main_process_start_identity: string
  sidecar_spawn_instance_id: string
  connection_epoch: string
  runtime_manifest_digest: string
  binary_sha256: string
  executable_path: string
  isolated_state_dir: string
  spawn_intent_at: string
  spawn_visibility_deadline_at: string
  pid: number | null
  process_group_id: number | null
  process_start_identity: string | null
  ownership_confirmed_at: string | null
  owner_main_dead_at: string | null
  owner_main_death_evidence_digest: string | null
  connection_opened_at: string | null
  closed_at: string | null
  tree_zero_at: string | null
  tree_zero_matcher_mode: 'pre_cas' | 'post_cas' | null
  stable_zero_sample_transcript_digest: string | null
  tree_zero_evidence_digest: string | null
  revision: number
}

function nonEmpty(value: string, code: string): void {
  if (!value.trim()) throw new CodexBindingRepositoryError(code)
}

function safePositive(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new CodexBindingRepositoryError(code)
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseStringArray(value: string, code: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new CodexBindingRepositoryError(code)
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string' && entry.trim())) {
    throw new CodexBindingRepositoryError(code)
  }
  return parsed
}

function parseNullableObjectStrict(
  value: string | null | undefined,
  code: string,
): Record<string, unknown> | null {
  if (!value) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new CodexBindingRepositoryError(code)
  }
  if (!isRecord(parsed)) throw new CodexBindingRepositoryError(code)
  return parsed
}

function parseArrayOrEmptyStrict(
  value: string | null | undefined,
  code: string,
): unknown[] {
  if (!value) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new CodexBindingRepositoryError(code)
  }
  if (!Array.isArray(parsed)) throw new CodexBindingRepositoryError(code)
  return parsed
}

function parseProductBudgetLimits(value: string): {
  maxIterations: number
  maxToolCalls: number
  lanes: {
    ordinary: { maxIterations: number; maxToolCalls: number; maxParallelToolGroups: number }
    delivery: { maxIterations: number; maxToolCalls: number; maxParallelToolGroups: number }
    final: { maxIterations: 1 }
  }
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new CodexBindingRepositoryError('gateway_product_budget_snapshot_invalid')
  }
  if (
    !isRecord(parsed)
    || !Number.isSafeInteger(parsed.maxIterations)
    || Number(parsed.maxIterations) <= 0
    || !Number.isSafeInteger(parsed.maxToolCalls)
    || Number(parsed.maxToolCalls) < 0
    || !isRecord(parsed.lanes)
    || !isRecord(parsed.lanes.ordinary)
    || !isRecord(parsed.lanes.delivery)
    || !isRecord(parsed.lanes.final)
  ) throw new CodexBindingRepositoryError('gateway_product_budget_snapshot_invalid')
  const parseLane = (lane: Record<string, unknown>, allowZero: boolean) => {
    if (!Number.isSafeInteger(lane.maxIterations)
      || Number(lane.maxIterations) < (allowZero ? 0 : 1)
      || !Number.isSafeInteger(lane.maxToolCalls) || Number(lane.maxToolCalls) < 0
      || !Number.isSafeInteger(lane.maxParallelToolGroups)
      || Number(lane.maxParallelToolGroups) < 0) {
      throw new CodexBindingRepositoryError('gateway_product_budget_snapshot_invalid')
    }
    return {
      maxIterations: Number(lane.maxIterations),
      maxToolCalls: Number(lane.maxToolCalls),
      maxParallelToolGroups: Number(lane.maxParallelToolGroups),
    }
  }
  const ordinary = parseLane(parsed.lanes.ordinary, false)
  const delivery = parseLane(parsed.lanes.delivery, true)
  if (parsed.lanes.final.maxIterations !== 1
    || Number(parsed.maxIterations) !== ordinary.maxIterations + delivery.maxIterations + 1
    || Number(parsed.maxToolCalls) !== ordinary.maxToolCalls + delivery.maxToolCalls) {
    throw new CodexBindingRepositoryError('gateway_product_budget_snapshot_invalid')
  }
  return {
    maxIterations: Number(parsed.maxIterations),
    maxToolCalls: Number(parsed.maxToolCalls),
    lanes: { ordinary, delivery, final: { maxIterations: 1 } },
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function codexLifecycleActionEvidence(input: CodexProductInterruptOwnerRead & {
  action: CodexLifecycleAction
  aliasGeneration: number
  codexThreadId: string
  codexTurnId: string
  requestedAt: string
}): string {
  return digestCanonicalJson({
    contract: 'codex_turn_lifecycle_action_v1',
    action: input.action,
    requestedAt: input.requestedAt,
    readyRunId: input.readyRunId,
    readyTaskId: input.readyTaskId,
    readyScopeId: input.readyScopeId,
    readyAliasId: input.readyAliasId,
    aliasGeneration: input.aliasGeneration,
    codexThreadId: input.codexThreadId,
    codexTurnId: input.codexTurnId,
  })
}

function codexLifecycleActionRetirementDigest(input: {
  action: CodexLifecycleAction
  readyRunId: string
  aliasId: string
  retiredGeneration: number
  threadBindingId: string
  lifecycleActionEvidenceDigest: string
  productTerminalDigest: string
  closeoutAt: string
  newGeneration: number | null
  newThreadBindingId: string | null
}): string {
  return digestCanonicalJson({
    contract: 'codex_turn_lifecycle_action_closeout_v1',
    ...input,
  })
}

function changes(result: unknown): number {
  return Number((result as RunResult | null)?.changes || 0)
}

function browserVerifierAttemptFromRow(
  row: CodexBrowserVerifierAttemptRow,
): CodexBrowserVerifierAttemptRead {
  let verdict: CodexBrowserVerifierVerdict | null = null
  let verificationUsage: unknown = null
  try {
    verdict = row.verdict_json
      ? JSON.parse(row.verdict_json) as CodexBrowserVerifierVerdict
      : null
    verificationUsage = row.verification_usage_json
      ? JSON.parse(row.verification_usage_json)
      : null
  } catch {
    throw new CodexBindingRepositoryError('browser_verifier_attempt_json_invalid')
  }
  if (
    (row.status === 'dispatching' && (verdict || row.outcome || row.receipt_digest))
    || (row.status === 'settled' && (!verdict || !row.outcome || !row.receipt_digest))
    || (verdict && digestCanonicalJson(verdict) !== row.verdict_digest)
  ) throw new CodexBindingRepositoryError('browser_verifier_attempt_invalid')
  if (row.status === 'settled') {
    if (
      !verdict
      || !row.outcome
      || !row.verdict_digest
      || !row.receipt_digest
      || !row.verified_at
      || !row.settled_at
      || (verdict.verdict === 'accept' && row.outcome !== 'accept')
      || (verdict.verdict === 'repair' && row.outcome !== 'repair')
      || (verdict.verdict === 'block'
        && !['block', 'invalid', 'provider_unavailable', 'result_unknown', 'identity_drift'].includes(row.outcome))
      || (row.outcome === 'accept' && !row.sealed_candidate_digest)
      || (row.sealed_candidate_digest !== null
        && !/^[a-f0-9]{64}$/.test(row.sealed_candidate_digest))
    ) throw new CodexBindingRepositoryError('browser_verifier_attempt_invalid')
    const receipt = {
      version: 1,
      attemptId: row.attempt_id,
      readyRunId: row.ready_run_id,
      readyTaskId: row.ready_task_id,
      readyScopeId: row.ready_scope_id,
      readyAliasId: row.ready_alias_id,
      aliasGeneration: row.alias_generation,
      threadBindingId: row.thread_binding_id,
      codexThreadId: row.codex_thread_id,
      codexTurnId: row.codex_turn_id,
      candidateDigest: row.candidate_digest,
      frozenIdentityDigest: row.frozen_identity_digest,
      upstreamProfileSnapshotRef: row.upstream_profile_snapshot_ref,
      upstreamProfileSnapshotDigest: row.upstream_profile_snapshot_digest,
      workflowCloseoutSealDigest: row.workflow_closeout_seal_digest,
      outcome: row.outcome,
      verdict,
      verdictDigest: row.verdict_digest,
      sealedCandidateDigest: row.sealed_candidate_digest,
      verificationUsage: verificationUsage,
      dispatchedAt: row.dispatched_at,
      verifiedAt: row.verified_at,
      settledAt: row.settled_at,
    }
    if (digestCanonicalJson(receipt) !== row.receipt_digest) {
      throw new CodexBindingRepositoryError('browser_verifier_attempt_receipt_digest_mismatch')
    }
  }
  return {
    attemptId: row.attempt_id,
    readyRunId: row.ready_run_id,
    readyTaskId: row.ready_task_id,
    readyScopeId: row.ready_scope_id,
    readyAliasId: row.ready_alias_id,
    aliasGeneration: row.alias_generation,
    threadBindingId: row.thread_binding_id,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    candidateDigest: row.candidate_digest,
    frozenIdentityDigest: row.frozen_identity_digest,
    upstreamProfileSnapshotRef: row.upstream_profile_snapshot_ref,
    upstreamProfileSnapshotDigest: row.upstream_profile_snapshot_digest,
    workflowCloseoutSealDigest: row.workflow_closeout_seal_digest,
    status: row.status,
    outcome: row.outcome,
    verdict,
    verdictDigest: row.verdict_digest,
    sealedCandidateDigest: row.sealed_candidate_digest,
    verificationUsage,
    receiptDigest: row.receipt_digest,
    dispatchedAt: row.dispatched_at,
    verifiedAt: row.verified_at,
    settledAt: row.settled_at,
  }
}

function hostFailureContinuationBlockedReason(
  turn: Pick<TurnBindingRow, 'codex_thread_id'>,
): CodexHostFailureRecovery['continuationBlockedReason'] {
  return turn.codex_thread_id === null ? 'start_delivery_absent' : 'publication_diverged'
}

function processLeaseFromRow(row: ProcessLeaseDbRow): CodexProcessLeaseRow {
  return {
    processLeaseId: row.process_lease_id,
    singletonSlot: 1,
    ownerMainBootId: row.owner_main_boot_id,
    ownerMainPid: row.owner_main_pid,
    ownerMainProcessStartIdentity: row.owner_main_process_start_identity,
    sidecarSpawnInstanceId: row.sidecar_spawn_instance_id,
    connectionEpoch: row.connection_epoch,
    runtimeManifestDigest: row.runtime_manifest_digest,
    binarySha256: row.binary_sha256,
    executablePath: row.executable_path,
    isolatedStateDir: row.isolated_state_dir,
    spawnIntentAt: row.spawn_intent_at,
    spawnVisibilityDeadlineAt: row.spawn_visibility_deadline_at,
    pid: row.pid,
    processGroupId: row.process_group_id,
    processStartIdentity: row.process_start_identity,
    ownershipConfirmedAt: row.ownership_confirmed_at,
    ownerMainDeadAt: row.owner_main_dead_at,
    ownerMainDeathEvidenceDigest: row.owner_main_death_evidence_digest,
    connectionOpenedAt: row.connection_opened_at,
    closedAt: row.closed_at,
    treeZeroAt: row.tree_zero_at,
    treeZeroMatcherMode: row.tree_zero_matcher_mode,
    stableZeroSampleTranscriptDigest: row.stable_zero_sample_transcript_digest,
    treeZeroEvidenceDigest: row.tree_zero_evidence_digest,
    revision: row.revision,
  }
}

export class CodexBindingRepository {
  private readonly toolBindings: CodexToolBindingRepository

  constructor(private readonly db: DatabaseConnection) {
    this.toolBindings = new CodexToolBindingRepository(db)
  }

  private readArtifactPublicationBarrier(input: {
    readyRunId: string
    ingressJson: string | null
  }): CodexToolPublicationBarrierRead {
    const destination = frozenOutputDestination(input.ingressJson)
    if (!destination) {
      return { kind: 'accepted', verifiedReceiptRefs: [], code: null, callId: null }
    }
    const activation = readCodexFolderOutputActivation(this.db, input.readyRunId)
    if (activation.kind === 'pending'
      || activation.kind === 'no_contract'
      || activation.kind === 'selection_required') {
      return {
        kind: 'incomplete', verifiedReceiptRefs: [],
        code: 'folder_output_intent_receipt_missing', callId: null,
      }
    }
    if (!('destinationResourceId' in activation)) {
      return {
        kind: 'incomplete', verifiedReceiptRefs: [],
        code: 'folder_output_intent_receipt_missing', callId: null,
      }
    }
    if (activation.destinationResourceId !== destination.logicalResourceId) {
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'folder_output_destination_mismatch', callId: null,
      }
    }
    const declarationRefs = [
      activation.declarationReceiptId,
      activation.deliveryAttemptId,
    ]
    if (activation.kind === 'no_write') {
      return {
        kind: 'accepted', verifiedReceiptRefs: declarationRefs.sort(), code: null, callId: null,
      }
    }
    let retrySources: readonly import('./codex-product-run-preparer').CodexRetryArtifactSource[] = []
    try {
      const prepared = this.readProductTurnRuntime(input.readyRunId).prepared
      if (prepared.ingress.attemptKind === 'explicit_retry') {
        retrySources = prepared.ingress.artifactSources ?? []
      }
    } catch {
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'tool_publication_ingress_invalid', callId: null,
      }
    }
    const rows = this.db.prepare(`
      SELECT binding.codex_call_id, binding.tool_name, action.receipt_id,
             action.result_digest, action.result_json, delivery.attempt_id
        FROM codex_tool_call_bindings binding
        JOIN ready_tool_action_receipts action
          ON action.ready_action_id = binding.ready_action_id
         AND action.state = 'confirmed'
        JOIN codex_tool_response_delivery_attempts delivery
          ON delivery.ready_action_id = binding.ready_action_id
         AND delivery.codex_thread_id = binding.codex_thread_id
         AND delivery.codex_turn_id = binding.codex_turn_id
         AND delivery.codex_call_id = binding.codex_call_id
         AND delivery.transport_write_confirmed_at IS NOT NULL
       WHERE binding.ready_run_id = ?
         AND binding.tool_name IN ('skill_write_artifact', 'skill_export_artifact')
       ORDER BY binding.created_at, binding.codex_call_id, delivery.created_at
    `).all<{
      codex_call_id: string
      tool_name: string
      receipt_id: string
      result_digest: string
      result_json: string
      attempt_id: string
    }>(input.readyRunId)
    const staged = new Map<string, {
      logicalArtifactRef: string
      version: string
      sha256: string
      receiptId: string
      attemptId: string
    }>()
    const exported = new Map<string, {
      logicalArtifactRef: string
      version: string
      sha256: string
      bytes: number
      targetDevice: string
      targetInode: string
      receiptId: string
      attemptId: string
    }>()
    for (const row of rows) {
      let result: unknown
      try {
        result = JSON.parse(row.result_json)
      } catch {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'artifact_action_result_invalid', callId: row.codex_call_id,
        }
      }
      if (digestCanonicalJson(result) !== row.result_digest || !isRecord(result) || !isRecord(result.data)) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'artifact_action_result_digest_mismatch', callId: row.codex_call_id,
        }
      }
      const data = result.data
      if (row.tool_name === 'skill_write_artifact') {
        if (typeof data.relativePath !== 'string'
          || typeof data.logicalArtifactRef !== 'string'
          || typeof data.version !== 'string'
          || typeof data.logicalSha256 !== 'string') continue
        staged.set(data.relativePath, {
          logicalArtifactRef: data.logicalArtifactRef,
          version: data.version,
          sha256: data.logicalSha256,
          receiptId: row.receipt_id,
          attemptId: row.attempt_id,
        })
      } else {
        if (typeof data.targetRelativePath !== 'string'
          || typeof data.logicalArtifactRef !== 'string'
          || typeof data.version !== 'string'
          || typeof data.sha256 !== 'string'
          || !Number.isSafeInteger(data.bytes)
          || typeof data.targetDevice !== 'string'
          || typeof data.targetInode !== 'string'
          || data.destinationResourceId !== destination.logicalResourceId
          || data.readbackVerified !== true) continue
        exported.set(data.targetRelativePath, {
          logicalArtifactRef: data.logicalArtifactRef,
          version: data.version,
          sha256: data.sha256,
          bytes: Number(data.bytes),
          targetDevice: data.targetDevice,
          targetInode: data.targetInode,
          receiptId: row.receipt_id,
          attemptId: row.attempt_id,
        })
      }
    }
    let rootStat: ReturnType<typeof statSync>
    try {
      if (realpathSync(destination.path) !== destination.path) throw new Error('root_realpath_drift')
      rootStat = statSync(destination.path)
    } catch {
      return {
        kind: 'indeterminate', verifiedReceiptRefs: [],
        code: 'artifact_destination_readback_failed', callId: null,
      }
    }
    if (!rootStat.isDirectory()
      || String(rootStat.dev) !== destination.directoryIdentity.device
      || String(rootStat.ino) !== destination.directoryIdentity.inode
      || rootStat.mode !== destination.directoryIdentity.mode) {
      return {
        kind: 'indeterminate', verifiedReceiptRefs: [],
        code: 'artifact_destination_identity_drift', callId: null,
      }
    }
    const refs = [...declarationRefs]
    for (const expected of activation.expectedOutputs) {
      const write = staged.get(expected)
      const retrySource = write ? null : retrySources.find((source) => (
        source.relativePath === expected && source.sourceReadyRunId !== input.readyRunId
      )) ?? null
      const output = exported.get(expected)
      const source = write ?? retrySource
      if (!source || !output) {
        return {
          kind: 'incomplete', verifiedReceiptRefs: [],
          code: !source ? 'artifact_staged_receipt_missing' : 'artifact_export_receipt_missing',
          callId: null,
        }
      }
      if (source.logicalArtifactRef !== output.logicalArtifactRef
        || source.version !== output.version || source.sha256 !== output.sha256) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'artifact_staged_exported_version_mismatch', callId: null,
        }
      }
      let durableHead: ReturnType<CodexBindingRepository['readArtifactWriteHead']>
      try {
        durableHead = this.readArtifactWriteHead(
          write ? input.readyRunId : retrySource!.sourceReadyRunId,
          expected,
        )
      } catch {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'artifact_write_receipt_chain_invalid', callId: null,
        }
      }
      if (!durableHead
        || durableHead.logicalArtifactRef !== source.logicalArtifactRef
        || durableHead.version !== source.version
        || durableHead.logicalSha256 !== source.sha256) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'artifact_write_head_mismatch', callId: null,
        }
      }
      const target = safeTargetPath(destination.path, expected)
      if (!target) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'artifact_target_path_invalid', callId: null,
        }
      }
      try {
        const parentRealpath = realpathSync(dirname(target))
        const parentRelative = relative(destination.path, parentRealpath)
        if (parentRelative === '..' || parentRelative.startsWith(`..${sep}`) || isAbsolute(parentRelative)) {
          throw new Error('parent_escape')
        }
        const targetStat = lstatSync(target)
        if (!targetStat.isFile() || targetStat.isSymbolicLink()
          || String(targetStat.dev) !== output.targetDevice
          || String(targetStat.ino) !== output.targetInode) throw new Error('target_identity_drift')
        const fresh = hashPath(target)
        if (fresh.bytes !== output.bytes || fresh.sha256 !== output.sha256) {
          throw new Error('target_hash_drift')
        }
      } catch {
        return {
          kind: 'indeterminate', verifiedReceiptRefs: [],
          code: 'artifact_target_readback_mismatch', callId: null,
        }
      }
      refs.push(
        ...durableHead.receiptRefs,
        ...(write ? [write.receiptId, write.attemptId] : []),
        output.receiptId,
        output.attemptId,
      )
    }
    return {
      kind: 'accepted',
      verifiedReceiptRefs: Array.from(new Set(refs)).sort(),
      code: null,
      callId: null,
    }
  }

  readOpenProductRunIds(): ReadonlySet<string> {
    const rows = this.db.prepare(`
      SELECT ready_run_id
        FROM codex_turn_bindings
       WHERE product_terminal_digest IS NULL
         AND host_failure_product_terminal_digest IS NULL
    `).all<Array<{ ready_run_id: string }>[number]>()
    return new Set(rows.map((row) => row.ready_run_id))
  }

  readArtifactStorageRetention(): {
    protectedRunIds: string[]
    collectibleRunIds: string[]
  } {
    const rows = this.db.prepare(`
      SELECT turn.ready_run_id, turn.predecessor_run_id,
             turn.product_terminal_digest, turn.publication_receipt_digest,
             run.status
        FROM codex_turn_bindings turn
        LEFT JOIN run_meta run ON run.run_id = turn.ready_run_id
       ORDER BY turn.created_at, turn.ready_run_id
    `).all<{
      ready_run_id: string
      predecessor_run_id: string | null
      product_terminal_digest: string | null
      publication_receipt_digest: string | null
      status: string | null
    }>()
    const succeeded = new Set(rows.filter((row) => (
      row.status === 'done'
      && row.product_terminal_digest !== null
      && row.publication_receipt_digest !== null
    )).map((row) => row.ready_run_id))
    const successors = new Map<string, string>()
    for (const row of rows) {
      if (!row.predecessor_run_id) continue
      successors.set(row.predecessor_run_id, row.ready_run_id)
    }
    const protectedRunIds: string[] = []
    const collectibleRunIds: string[] = []
    for (const row of rows) {
      let tailRunId = row.ready_run_id
      for (let depth = 0; depth <= rows.length; depth += 1) {
        const successorRunId = successors.get(tailRunId)
        if (!successorRunId) break
        if (depth === rows.length) {
          throw new CodexBindingRepositoryError('artifact_retention_lineage_invalid')
        }
        tailRunId = successorRunId
      }
      if (succeeded.has(tailRunId)) collectibleRunIds.push(row.ready_run_id)
      else protectedRunIds.push(row.ready_run_id)
    }
    return { protectedRunIds, collectibleRunIds }
  }

  hasProductTurnBinding(readyRunId: string): boolean {
    nonEmpty(readyRunId, 'ready_run_id_invalid')
    return Boolean(this.db.prepare(`
      SELECT 1 AS found FROM codex_turn_bindings WHERE ready_run_id = ? LIMIT 1
    `).get<{ found: number }>(readyRunId))
  }

  readActiveProductRunVisibilityIdentity(readyRunId: string): {
    readyRunId: string
    readyScopeId: string
    readyAliasId: string
    aliasGeneration: number
    messageVisibilityEpoch: number
  } | null {
    nonEmpty(readyRunId, 'ready_run_id_invalid')
    const row = this.db.prepare(`
      SELECT turn.ready_run_id,
             turn.message_visibility_epoch,
             binding.ready_scope_id,
             binding.ready_conversation_alias,
             binding.alias_generation
        FROM codex_turn_bindings turn
        JOIN codex_thread_bindings binding
          ON binding.thread_binding_id = turn.thread_binding_id
       WHERE turn.ready_run_id = ?
         AND binding.retired_at IS NULL
         AND turn.product_terminal_digest IS NULL
         AND turn.host_failure_product_terminal_digest IS NULL
       LIMIT 1
    `).get<{
      ready_run_id: string
      ready_scope_id: string
      ready_conversation_alias: string
      alias_generation: number
      message_visibility_epoch: number
    }>(readyRunId)
    return row ? {
      readyRunId: row.ready_run_id,
      readyScopeId: row.ready_scope_id,
      readyAliasId: row.ready_conversation_alias,
      aliasGeneration: row.alias_generation,
      messageVisibilityEpoch: row.message_visibility_epoch,
    } : null
  }

  readCommittedProductRunVisibilityIdentity(readyRunId: string): {
    readyRunId: string
    readyScopeId: string
    readyAliasId: string
    aliasGeneration: number
    messageVisibilityEpoch: number
  } | null {
    nonEmpty(readyRunId, 'ready_run_id_invalid')
    const row = this.db.prepare(`
      SELECT turn.ready_run_id,
             turn.message_visibility_epoch,
             binding.ready_scope_id,
             binding.ready_conversation_alias,
             binding.alias_generation
        FROM codex_turn_bindings turn
        JOIN codex_thread_bindings binding
          ON binding.thread_binding_id = turn.thread_binding_id
       WHERE turn.ready_run_id = ?
         AND (
           (turn.product_terminal_digest IS NOT NULL AND turn.product_closeout_at IS NOT NULL)
           OR
           (turn.host_failure_product_terminal_digest IS NOT NULL
             AND turn.host_failure_closeout_at IS NOT NULL)
         )
       LIMIT 1
    `).get<{
      ready_run_id: string
      ready_scope_id: string
      ready_conversation_alias: string
      alias_generation: number
      message_visibility_epoch: number
    }>(readyRunId)
    return row ? {
      readyRunId: row.ready_run_id,
      readyScopeId: row.ready_scope_id,
      readyAliasId: row.ready_conversation_alias,
      aliasGeneration: row.alias_generation,
      messageVisibilityEpoch: row.message_visibility_epoch,
    } : null
  }

  hasExactProductFence(input: { readyRunId: string; threadBindingId: string }): boolean {
    nonEmpty(input.readyRunId, 'ready_run_id_invalid')
    nonEmpty(input.threadBindingId, 'thread_binding_id_invalid')
    return Boolean(this.db.prepare(`
      SELECT 1 AS found
        FROM codex_thread_dispatch_fences
       WHERE operation_kind = 'product_turn'
         AND owner_ready_run_id = ? AND thread_binding_id = ?
       LIMIT 1
    `).get<{ found: number }>(input.readyRunId, input.threadBindingId))
  }

  readPendingInteractionBinding(input: {
    readyRunId: string
    readyScopeId: string
  }): CodexPendingInteractionBindingRead | null {
    nonEmpty(input.readyRunId, 'ready_run_id_invalid')
    nonEmpty(input.readyScopeId, 'ready_scope_id_invalid')
    const row = this.db.prepare(`
      SELECT t.ready_run_id, t.ready_task_id, t.codex_thread_id, t.codex_turn_id,
             t.message_visibility_epoch,
             b.ready_scope_id, b.ready_conversation_alias, b.alias_generation,
             b.thread_binding_id
        FROM codex_turn_bindings t
        JOIN codex_thread_bindings b ON b.thread_binding_id = t.thread_binding_id
        JOIN codex_thread_dispatch_fences f
          ON f.thread_binding_id = t.thread_binding_id
         AND f.operation_kind = 'product_turn'
         AND f.owner_ready_run_id = t.ready_run_id
       WHERE t.ready_run_id = ? AND b.ready_scope_id = ?
         AND t.product_terminal_digest IS NULL
         AND t.host_failure_product_terminal_digest IS NULL
       LIMIT 1
    `).get<{
      ready_run_id: string
      ready_task_id: string
      codex_thread_id: string | null
      codex_turn_id: string | null
      ready_scope_id: string
      ready_conversation_alias: string
      alias_generation: number
      thread_binding_id: string
      message_visibility_epoch: number
    }>(input.readyRunId, input.readyScopeId)
    if (!row?.codex_thread_id || !row.codex_turn_id) return null
    return {
      readyRunId: row.ready_run_id,
      readyTaskId: row.ready_task_id,
      readyScopeId: row.ready_scope_id,
      readyAliasId: row.ready_conversation_alias,
      aliasGeneration: row.alias_generation,
      threadBindingId: row.thread_binding_id,
      codexThreadId: row.codex_thread_id,
      codexTurnId: row.codex_turn_id,
      messageVisibilityEpoch: row.message_visibility_epoch,
    }
  }

  readActiveUpstreamProfileUsages(): readonly {
    profileId: string
    snapshotDigest: string
  }[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT snapshot.profile_id, snapshot.snapshot_digest
        FROM codex_turn_bindings turn
        JOIN codex_thread_dispatch_fences fence
          ON fence.thread_binding_id = turn.thread_binding_id
         AND fence.operation_kind = 'product_turn'
         AND fence.owner_ready_run_id = turn.ready_run_id
         AND fence.quarantined_at IS NULL
        JOIN ready_model_gateway_profile_snapshots snapshot
          ON snapshot.snapshot_ref = turn.effective_upstream_snapshot_ref
       WHERE turn.product_terminal_digest IS NULL
         AND turn.host_failure_product_terminal_digest IS NULL
      UNION
      SELECT DISTINCT snapshot.profile_id, snapshot.snapshot_digest
        FROM codex_manual_compaction_bindings manual
        JOIN codex_thread_dispatch_fences fence
          ON fence.thread_binding_id = manual.thread_binding_id
         AND fence.operation_kind = 'manual_compaction'
         AND fence.owner_manual_compaction_id = manual.manual_compaction_id
         AND fence.quarantined_at IS NULL
        JOIN ready_model_gateway_profile_snapshots snapshot
          ON snapshot.snapshot_ref = manual.upstream_profile_snapshot_ref
       WHERE manual.consumed_at IS NULL
         AND manual.abandoned_at IS NULL
    `).all<Array<{ profile_id: string; snapshot_digest: string }>[number]>()
    return rows.map((row) => ({
      profileId: row.profile_id,
      snapshotDigest: row.snapshot_digest,
    }))
  }

  readActiveUpstreamProfileIds(): ReadonlySet<string> {
    return new Set(this.readActiveUpstreamProfileUsages().map((usage) => usage.profileId))
  }

  readLatestAliasGeneration(aliasId: string): number | null {
    nonEmpty(aliasId, 'alias_identity_invalid')
    const row = this.db.prepare(`
      SELECT MAX(alias_generation) AS alias_generation
        FROM codex_thread_bindings
       WHERE ready_conversation_alias = ?
    `).get<{ alias_generation: number | null }>(aliasId)
    return typeof row?.alias_generation === 'number' ? row.alias_generation : null
  }

  readActiveAliasBinding(aliasId: string): CodexActiveAliasBindingRead | null {
    nonEmpty(aliasId, 'alias_identity_invalid')
    const row = this.readActiveThreadByAlias(aliasId)
    if (!row) return null
    let toolSurface: ReadyToolSurface | null = null
    if (row.tool_surface_json !== null) {
      try {
        toolSurface = JSON.parse(row.tool_surface_json) as ReadyToolSurface
        assertReadyToolSurface(toolSurface)
      } catch {
        throw new CodexBindingRepositoryError('tool_surface_snapshot_invalid')
      }
    }
    const fence = this.db.prepare(`
      SELECT 1 AS present FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? LIMIT 1
    `).get<{ present: number }>(row.thread_binding_id)
    return {
      threadBindingId: row.thread_binding_id,
      aliasId: row.ready_conversation_alias,
      aliasGeneration: row.alias_generation,
      readyScopeId: row.ready_scope_id,
      codexThreadId: row.codex_thread_id,
      codexSessionId: row.codex_session_id,
      isolatedThreadCwd: row.isolated_thread_cwd,
      toolSurface,
      hasActiveFence: fence?.present === 1,
      continuationBlockedAt: row.continuation_blocked_at,
      continuationBlockedReason: row.continuation_blocked_reason,
      retiredAt: row.retired_at,
    }
  }

  resolveUserIngressAliasBinding(input: {
    aliasId: string
    runtimeManifestDigest: string
    protocolSchemaDigest: string
    createdAt: string
    currentToolSurfaceDigest?: string
  }): CodexActiveAliasBindingRead | null {
    for (const value of [
      input.aliasId,
      input.runtimeManifestDigest,
      input.protocolSchemaDigest,
      input.createdAt,
    ]) nonEmpty(value, 'alias_restore_identity_invalid')
    if (input.currentToolSurfaceDigest !== undefined) {
      nonEmpty(input.currentToolSurfaceDigest, 'alias_restore_identity_invalid')
    }
    const current = this.readActiveThreadByAlias(input.aliasId)
    if (
      current
      && current.runtime_manifest_digest === input.runtimeManifestDigest
      && current.protocol_schema_digest === input.protocolSchemaDigest
      && (
        input.currentToolSurfaceDigest === undefined
        || current.tool_surface_digest === null
        || current.tool_surface_digest === input.currentToolSurfaceDigest
      )
    ) return this.readActiveAliasBinding(input.aliasId)
    const available = this.immediate(() => {
      const active = this.readActiveThreadByAlias(input.aliasId)
      if (active) {
        if (
          active.runtime_manifest_digest === input.runtimeManifestDigest
          && active.protocol_schema_digest === input.protocolSchemaDigest
          && (
            input.currentToolSurfaceDigest === undefined
            || active.tool_surface_digest === null
            || active.tool_surface_digest === input.currentToolSurfaceDigest
          )
        ) return true
        const turn = this.db.prepare(`
          SELECT ready_run_id FROM codex_turn_bindings
           WHERE thread_binding_id = ? LIMIT 1
        `).get<{ ready_run_id: string }>(active.thread_binding_id)
        const fence = this.db.prepare(`
          SELECT thread_binding_id FROM codex_thread_dispatch_fences
           WHERE thread_binding_id = ? LIMIT 1
        `).get<{ thread_binding_id: string }>(active.thread_binding_id)
        const unresolvedTurn = this.db.prepare(`
          SELECT ready_run_id FROM codex_turn_bindings
           WHERE thread_binding_id = ?
             AND (
               turn_start_reservation_released_at IS NULL
               OR (product_terminal_digest IS NULL
                 AND host_failure_product_terminal_digest IS NULL)
             )
           LIMIT 1
        `).get<{ ready_run_id: string }>(active.thread_binding_id)
        const isPristineEmpty = (
          active.revision === 1
          && active.thread_start_reservation_set_id === null
          && active.codex_thread_id === null
          && active.codex_session_id === null
          && active.thread_start_dispatch_intent_at === null
          && active.thread_start_reconciled_at === null
          && active.retired_at === null
          && active.continuation_blocked_at === null
          && !turn
          && !fence
        )
        if (isPristineEmpty) {
          const replacementEvidenceDigest = digest({
            kind: 'empty_alias_runtime_contract_superseded',
            aliasId: active.ready_conversation_alias,
            aliasGeneration: active.alias_generation,
            threadBindingId: active.thread_binding_id,
            previousRuntimeManifestDigest: active.runtime_manifest_digest,
            previousProtocolSchemaDigest: active.protocol_schema_digest,
            runtimeManifestDigest: input.runtimeManifestDigest,
            protocolSchemaDigest: input.protocolSchemaDigest,
          })
          const retired = this.db.prepare(`
            UPDATE codex_thread_bindings
               SET retired_at = ?, retired_reason = 'cleanup',
                   retirement_evidence_digest = ?, revision = revision + 1, updated_at = ?
             WHERE thread_binding_id = ? AND revision = 1 AND retired_at IS NULL
          `).run(
            input.createdAt,
            replacementEvidenceDigest,
            input.createdAt,
            active.thread_binding_id,
          )
          if (changes(retired) !== 1) {
            throw new CodexBindingRepositoryError('empty_alias_contract_retire_cas_failed')
          }
          const aliasGeneration = active.alias_generation + 1
          this.insertEmptyAliasGenerationInOpenTransaction({
            threadBindingId: this.nextThreadBindingId(
              active.ready_conversation_alias,
              aliasGeneration,
              replacementEvidenceDigest,
            ),
            aliasId: active.ready_conversation_alias,
            aliasGeneration,
            readyScopeId: active.ready_scope_id,
            runtimeManifestDigest: input.runtimeManifestDigest,
            protocolSchemaDigest: input.protocolSchemaDigest,
            createdAt: input.createdAt,
          })
          return true
        }
        if (
          fence
          || unresolvedTurn
          || active.continuation_blocked_at !== null
        ) return true
        const lastClosed = this.db.prepare(`
          SELECT ready_run_id FROM codex_turn_bindings
           WHERE thread_binding_id = ?
             AND (product_terminal_digest IS NOT NULL
               OR host_failure_product_terminal_digest IS NOT NULL)
             AND turn_start_reservation_released_at IS NOT NULL
           ORDER BY COALESCE(product_closeout_at, host_failure_closeout_at, updated_at) DESC,
                    created_at DESC, ready_run_id DESC
           LIMIT 1
        `).get<{ ready_run_id: string }>(active.thread_binding_id)
        if (
          !active.codex_thread_id
          || !active.codex_session_id
          || !active.isolated_thread_cwd
          || !active.thread_start_reservation_released_at
          || !lastClosed
        ) return true
        this.supersedeIdleStartedAliasForRootContractChangeInOpenTransaction({
          thread: active,
          readyRunId: lastClosed.ready_run_id,
          createdAt: input.createdAt,
          runtimeManifestDigest: input.runtimeManifestDigest,
          protocolSchemaDigest: input.protocolSchemaDigest,
          previousToolSurfaceDigest: active.tool_surface_digest,
          currentToolSurfaceDigest: input.currentToolSurfaceDigest ?? null,
        })
        return true
      }
      const retired = this.db.prepare(`
        SELECT * FROM codex_thread_bindings
         WHERE ready_conversation_alias = ?
         ORDER BY alias_generation DESC LIMIT 1
      `).get<ThreadBindingRow>(input.aliasId)
      if (
        !retired
        || retired.retired_reason !== 'publication_diverged'
        || retired.continuation_blocked_reason !== 'publication_diverged'
        || !retired.retirement_evidence_digest
        || retired.retirement_evidence_digest !== retired.continuation_blocked_evidence_digest
      ) return false
      const unresolvedTurn = this.db.prepare(`
        SELECT ready_run_id FROM codex_turn_bindings
         WHERE thread_binding_id = ?
           AND (product_terminal_digest IS NULL OR product_closeout_at IS NULL)
         LIMIT 1
      `).get<{ ready_run_id: string }>(retired.thread_binding_id)
      const exactCloseout = this.db.prepare(`
        SELECT ready_run_id FROM codex_turn_bindings
         WHERE thread_binding_id = ?
           AND (
             engine_terminal_candidate_digest = ?
             OR recovery_failure_evidence_digest = ?
             OR (lifecycle_action = 'stop' AND lifecycle_action_evidence_digest = ?)
             OR EXISTS (
               SELECT 1 FROM codex_browser_verifier_attempts verifier
                WHERE verifier.ready_run_id = codex_turn_bindings.ready_run_id
                  AND verifier.status = 'settled'
                  AND verifier.outcome <> 'accept'
                  AND verifier.receipt_digest = ?
             )
           )
           AND product_terminal_digest IS NOT NULL
           AND product_closeout_at IS NOT NULL
           AND fence_release_revision IS NOT NULL
         LIMIT 1
      `).get<{ ready_run_id: string }>(
        retired.thread_binding_id,
        retired.retirement_evidence_digest,
        retired.retirement_evidence_digest,
        retired.retirement_evidence_digest,
        retired.retirement_evidence_digest,
      )
      const fence = this.db.prepare(`
        SELECT thread_binding_id FROM codex_thread_dispatch_fences
         WHERE thread_binding_id = ? LIMIT 1
      `).get<{ thread_binding_id: string }>(retired.thread_binding_id)
      if (unresolvedTurn || !exactCloseout || fence) return false
      const aliasGeneration = retired.alias_generation + 1
      this.insertEmptyAliasGenerationInOpenTransaction({
        threadBindingId: this.nextThreadBindingId(
          retired.ready_conversation_alias,
          aliasGeneration,
          retired.retirement_evidence_digest,
        ),
        aliasId: retired.ready_conversation_alias,
        aliasGeneration,
        readyScopeId: retired.ready_scope_id,
        runtimeManifestDigest: input.runtimeManifestDigest,
        protocolSchemaDigest: input.protocolSchemaDigest,
        createdAt: input.createdAt,
      })
      return true
    })
    return available ? this.readActiveAliasBinding(input.aliasId) : null
  }

  readManualCompactionRoute(input: {
    aliasId: string
    aliasGeneration: number
  }): CodexManualCompactionRouteRead {
    nonEmpty(input.aliasId, 'alias_identity_invalid')
    safePositive(input.aliasGeneration, 'alias_generation_invalid')
    const row = this.readActiveThreadByAlias(input.aliasId)
    if (
      !row
      || row.alias_generation !== input.aliasGeneration
      || row.retired_at
      || row.continuation_blocked_at
      || !row.codex_thread_id
      || !row.codex_model
    ) throw new CodexBindingRepositoryError('manual_compaction_route_unavailable')
    const latestTurn = this.readLatestClosedTurnUpstreamRoute(row.thread_binding_id)
    if (!latestTurn) throw new CodexBindingRepositoryError('manual_compaction_route_unavailable')
    return {
      threadBindingId: row.thread_binding_id,
      aliasId: row.ready_conversation_alias,
      aliasGeneration: row.alias_generation,
      codexThreadId: row.codex_thread_id,
      codexModel: latestTurn.effective_codex_model,
      upstreamProfileSnapshotRef: latestTurn.effective_upstream_snapshot_ref,
      upstreamProfileSnapshotDigest: latestTurn.effective_upstream_snapshot_digest,
    }
  }

  readLifecycleOperation(input: {
    aliasId: string
    aliasGeneration: number
  }): CodexLifecycleOperationRead {
    nonEmpty(input.aliasId, 'alias_identity_invalid')
    safePositive(input.aliasGeneration, 'alias_generation_invalid')
    const thread = this.readActiveThreadByAlias(input.aliasId)
    if (!thread || thread.alias_generation !== input.aliasGeneration || thread.retired_at) {
      throw new CodexBindingRepositoryError('active_alias_generation_mismatch')
    }
    const turns = this.db.prepare(`
      SELECT turn.*, projection.status AS projection_status
        FROM codex_turn_bindings turn
        LEFT JOIN task_projections projection
          ON projection.task_id = turn.ready_task_id AND projection.run_id = turn.ready_run_id
       WHERE turn.thread_binding_id = ?
       ORDER BY turn.created_at ASC, turn.ready_run_id ASC
    `).all<(TurnBindingRow & { projection_status: string | null })>(thread.thread_binding_id)
    const fences = this.db.prepare(`
      SELECT operation_kind, owner_ready_run_id, owner_manual_compaction_id
        FROM codex_thread_dispatch_fences WHERE thread_binding_id = ?
    `).all<{
      operation_kind: 'product_turn' | 'manual_compaction'
      owner_ready_run_id: string | null
      owner_manual_compaction_id: string | null
    }>(thread.thread_binding_id)
    if (fences.length > 1) throw new CodexBindingRepositoryError('lifecycle_fence_invariant_broken')
    const fence = fences[0] || null
    const activeTurn = fence?.operation_kind === 'product_turn'
      ? turns.filter((turn) => turn.ready_run_id === fence.owner_ready_run_id)
      : []
    if (activeTurn.length > 1) throw new CodexBindingRepositoryError('lifecycle_owner_invariant_broken')
    if (fence?.operation_kind === 'product_turn' && activeTurn.length !== 1) {
      throw new CodexBindingRepositoryError('lifecycle_owner_missing')
    }
    const owner = activeTurn[0] || null
    const manual = this.db.prepare(`
      SELECT consumed_at, abandoned_at, abandoned_reconciled_at, unknown_at
        FROM codex_manual_compaction_bindings
       WHERE thread_binding_id = ? ORDER BY created_at DESC LIMIT 1
    `).get<{
      consumed_at: string | null
      abandoned_at: string | null
      abandoned_reconciled_at: string | null
      unknown_at: string | null
    }>(thread.thread_binding_id)
    const manualCompactionState: LifecycleOperationFacts['manualCompactionState'] = !manual
      ? 'none'
      : manual.consumed_at || (manual.abandoned_at && manual.abandoned_reconciled_at)
        ? 'consumed'
        : manual.abandoned_at || manual.unknown_at ? 'unknown' : 'pending'
    const allNativeThreadAttemptsSettled = turns.every((turn) => (
      turn.turn_start_reservation_released_at !== null
      && Boolean(turn.product_terminal_digest || turn.host_failure_product_terminal_digest)
    ))
    return {
      identity: { aliasId: thread.ready_conversation_alias, aliasGeneration: thread.alias_generation },
      activeReadyRunId: owner?.ready_run_id || null,
      activeManualCompactionId: fence?.operation_kind === 'manual_compaction'
        ? fence.owner_manual_compaction_id
        : null,
      latestReadyRunId: turns.at(-1)?.ready_run_id || null,
      interruptRequested: Boolean(owner?.interrupt_requested_at),
      interruptAcknowledged: Boolean(owner?.interrupt_ack_at),
      requestedAction: owner?.lifecycle_action || null,
      facts: {
        readyRunCreated: turns.length > 0,
        codexThreadId: thread.codex_thread_id,
        codexTurnId: owner?.codex_turn_id || null,
        activeFence: fence?.operation_kind || null,
        threadStartUnreconciled: Boolean(
          thread.thread_start_reservation_set_id
          && !thread.thread_start_reservation_released_at,
        ),
        turnStartUnreconciled: Boolean(
          owner
          && !owner.turn_start_reservation_released_at
          && !owner.turn_start_reconciled_at,
        ),
        productRunNonterminal: Boolean(
          owner && !owner.product_terminal_digest && !owner.host_failure_product_terminal_digest,
        ),
        interruptStateUnknown: Boolean(owner?.interrupt_state_unknown_at),
        engineTerminalRecorded: Boolean(owner?.engine_terminal_recorded_at
          && !owner.product_terminal_digest && !owner.host_failure_product_terminal_digest),
        readyCloseoutCommitted: Boolean(
          owner?.product_terminal_digest || owner?.host_failure_product_terminal_digest,
        ),
        readyTerminalWithoutNativeThread: !thread.codex_thread_id && turns.some((turn) => (
          Boolean(turn.product_terminal_digest || turn.host_failure_product_terminal_digest)
        )),
        allNativeThreadAttemptsSettled,
        hostFailureEvidenceComplete: Boolean(owner?.host_failure_kind && owner.host_failure_evidence_digest),
        hostFailureProductTerminalCommitted: Boolean(owner?.host_failure_product_terminal_digest),
        manualCompactionState,
      },
    }
  }

  readLatestLifecycleCloseout(input: {
    aliasId: string
    aliasGeneration: number
    readyRunId?: string
  }): CodexLifecycleCloseoutRead {
    nonEmpty(input.aliasId, 'alias_identity_invalid')
    safePositive(input.aliasGeneration, 'alias_generation_invalid')
    if (input.readyRunId !== undefined) nonEmpty(input.readyRunId, 'ready_run_id_invalid')
    const row = this.db.prepare(`
      SELECT turn.ready_run_id, turn.thread_binding_id,
             turn.codex_thread_id, turn.codex_turn_id, turn.product_terminal_digest,
             turn.host_failure_product_terminal_digest, turn.fence_release_revision,
             turn.engine_terminal_status,
             projection.status AS projection_status,
             thread.retired_reason
        FROM codex_turn_bindings turn
        JOIN codex_thread_bindings thread ON thread.thread_binding_id = turn.thread_binding_id
        JOIN task_projections projection
          ON projection.task_id = turn.ready_task_id AND projection.run_id = turn.ready_run_id
       WHERE thread.ready_conversation_alias = ? AND thread.alias_generation = ?
         AND (? IS NULL OR turn.ready_run_id = ?)
         AND (turn.product_terminal_digest IS NOT NULL
           OR turn.host_failure_product_terminal_digest IS NOT NULL)
       ORDER BY COALESCE(turn.product_closeout_at, turn.host_failure_closeout_at) DESC
       LIMIT 1
    `).get<{
      ready_run_id: string
      thread_binding_id: string
      codex_thread_id: string | null
      codex_turn_id: string | null
      product_terminal_digest: string | null
      host_failure_product_terminal_digest: string | null
      fence_release_revision: number | null
      engine_terminal_status: 'completed' | 'interrupted' | 'failed' | null
      projection_status: string
      retired_reason: string | null
    }>(
      input.aliasId,
      input.aliasGeneration,
      input.readyRunId ?? null,
      input.readyRunId ?? null,
    )
    if (!row?.codex_thread_id || !row.codex_turn_id) {
      throw new CodexBindingRepositoryError('lifecycle_closeout_readback_missing')
    }
    const ownerFence = this.db.prepare(`
      SELECT 1 AS present FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND operation_kind = 'product_turn'
         AND owner_ready_run_id = ? LIMIT 1
    `).get<{ present: number }>(row.thread_binding_id, row.ready_run_id)
    const productTerminal = row.projection_status === 'completed'
      ? 'completed' as const
      : row.projection_status === 'killed'
        ? 'interrupted' as const
        : row.projection_status === 'failed'
          ? 'failed' as const
          : null
    const terminal = row.retired_reason === 'publication_diverged'
      ? productTerminal
      : row.engine_terminal_status || productTerminal
    const closeoutDigest = row.product_terminal_digest || row.host_failure_product_terminal_digest
    if (!terminal || !closeoutDigest || ownerFence
      || row.fence_release_revision === null) {
      throw new CodexBindingRepositoryError('lifecycle_closeout_incomplete')
    }
    return {
      aliasId: input.aliasId,
      aliasGeneration: input.aliasGeneration,
      codexThreadId: row.codex_thread_id,
      codexTurnId: row.codex_turn_id,
      terminal,
      closeoutDigest,
      fenceReleaseRevision: row.fence_release_revision,
    }
  }

  readProductTurnRuntime(readyRunId: string): CodexProductTurnRuntimeRead {
    nonEmpty(readyRunId, 'ready_run_id_invalid')
    const row = this.db.prepare(`
      SELECT t.ready_run_id, t.ready_task_id, t.codex_thread_id, t.codex_turn_id,
             t.gateway_claimed_codex_turn_id, t.turn_request_id,
             t.start_reservation_set_id,
             t.tool_surface_digest, t.turn_contract_digest,
             t.message_visibility_epoch,
             t.effective_upstream_snapshot_ref, t.effective_upstream_snapshot_digest,
             t.ready_memory_snapshot_json, t.ready_memory_snapshot_digest,
             t.ready_memory_state_revision, t.ready_memory_revocation_revision,
             t.ingress_json, t.ingress_admitted_digest, t.ingress_admitted_at,
             b.thread_binding_id, b.ready_scope_id, b.ready_conversation_alias,
             b.alias_generation, b.isolated_thread_cwd, b.codex_model,
             b.instruction_contract_digest
        FROM codex_turn_bindings t
        JOIN codex_thread_bindings b ON b.thread_binding_id = t.thread_binding_id
       WHERE t.ready_run_id = ? LIMIT 1
    `).get<{
      ready_run_id: string
      ready_task_id: string
      codex_thread_id: string | null
      codex_turn_id: string | null
      gateway_claimed_codex_turn_id: string | null
      turn_request_id: string
      start_reservation_set_id: string
      tool_surface_digest: string
      turn_contract_digest: string
      message_visibility_epoch: number
      effective_upstream_snapshot_ref: string
      effective_upstream_snapshot_digest: string
      ready_memory_snapshot_json: string | null
      ready_memory_snapshot_digest: string | null
      ready_memory_state_revision: number | null
      ready_memory_revocation_revision: number | null
      ingress_json: string | null
      ingress_admitted_digest: string
      ingress_admitted_at: string
      thread_binding_id: string
      ready_scope_id: string
      ready_conversation_alias: string
      alias_generation: number
      isolated_thread_cwd: string | null
      codex_model: string | null
      instruction_contract_digest: string
    }>(readyRunId)
    if (!row) throw new CodexBindingRepositoryError('product_turn_binding_missing')
    if (!row.ingress_json) throw new CodexBindingRepositoryError('product_turn_ingress_missing')
    let receipt: unknown
    try {
      receipt = JSON.parse(row.ingress_json)
    } catch {
      throw new CodexBindingRepositoryError('product_turn_ingress_invalid')
    }
    if (!isRecord(receipt)
      || receipt.contract !== 'codex_ingress_admission_v1'
      || !isPreparedCodexProductRun(receipt.prepared)
      || receipt.prepared.runId !== row.ready_run_id
      || receipt.prepared.taskId !== row.ready_task_id
      || receipt.prepared.readyToolHostIdentity.scopeId !== row.ready_scope_id
      || receipt.prepared.conversationAlias.aliasId !== row.ready_conversation_alias
      || receipt.prepared.conversationAlias.aliasGeneration !== row.alias_generation
      || receipt.messageVisibilityEpoch !== row.message_visibility_epoch
      || row.ready_memory_snapshot_json !== canonicalJson(receipt.prepared.readyMemorySnapshot)
      || row.ready_memory_snapshot_digest !== receipt.prepared.readyMemorySnapshot.snapshotDigest
      || row.ready_memory_state_revision !== receipt.prepared.readyMemorySnapshot.stateRevision
      || row.ready_memory_revocation_revision !== receipt.prepared.readyMemorySnapshot.revocationRevision
      || !row.isolated_thread_cwd
      || !row.codex_model
      || digestCanonicalJson(receipt) !== row.ingress_admitted_digest) {
      throw new CodexBindingRepositoryError('product_turn_ingress_invalid')
    }
    const ingress = receipt.prepared.ingress
    return {
      readyRunId: row.ready_run_id,
      readyTaskId: row.ready_task_id,
      readyScopeId: row.ready_scope_id,
      readyAliasId: row.ready_conversation_alias,
      aliasGeneration: row.alias_generation,
      threadBindingId: row.thread_binding_id,
      codexThreadId: row.codex_thread_id,
      codexTurnId: row.codex_turn_id,
      gatewayClaimedCodexTurnId: row.gateway_claimed_codex_turn_id,
      turnRequestId: row.turn_request_id,
      reservationSetId: row.start_reservation_set_id,
      toolSurfaceDigest: row.tool_surface_digest,
      turnContractDigest: row.turn_contract_digest,
      instructionContractDigest: row.instruction_contract_digest,
      upstreamProfileSnapshotRef: row.effective_upstream_snapshot_ref,
      upstreamProfileSnapshotDigest: row.effective_upstream_snapshot_digest,
      isolatedThreadCwd: row.isolated_thread_cwd,
      codexModel: row.codex_model,
      prepared: receipt.prepared,
      ingress,
      admittedAt: row.ingress_admitted_at,
      messageVisibilityEpoch: row.message_visibility_epoch,
    }
  }

  readProductTurnSuccessorId(readyRunId: string): string | null {
    nonEmpty(readyRunId, 'ready_run_id_invalid')
    const rows = this.db.prepare(`
      SELECT ready_run_id
        FROM codex_turn_bindings
       WHERE predecessor_run_id = ?
         AND attempt_kind IN ('recovery_successor', 'checkpoint_successor', 'explicit_retry')
       ORDER BY created_at, ready_run_id
       LIMIT 2
    `).all<Array<{ ready_run_id: string }>[number]>(readyRunId)
    if (rows.length > 1) throw new CodexBindingRepositoryError('product_turn_successor_ambiguous')
    return rows[0]?.ready_run_id ?? null
  }

  readPublishedToolOutputs(readyRunId: string): CodexPublishedToolOutputRead[] {
    nonEmpty(readyRunId, 'ready_run_id_invalid')
    return this.db.prepare(`
      SELECT admission.codex_call_id, admission.tool_name,
             action.result_json, action.result_digest, action.updated_at
        FROM codex_tool_call_admissions admission
        JOIN codex_tool_call_bindings binding
          ON binding.codex_thread_id = admission.codex_thread_id
         AND binding.codex_turn_id = admission.codex_turn_id
         AND binding.codex_call_id = admission.codex_call_id
        JOIN ready_tool_action_receipts action
          ON action.ready_action_id = binding.ready_action_id
       WHERE admission.ready_run_id = ?
         AND action.state = 'confirmed'
         AND EXISTS (
           SELECT 1
             FROM codex_tool_response_delivery_attempts delivery
            WHERE delivery.codex_thread_id = binding.codex_thread_id
              AND delivery.codex_turn_id = binding.codex_turn_id
              AND delivery.codex_call_id = binding.codex_call_id
              AND delivery.ready_action_id = binding.ready_action_id
              AND delivery.transport_write_confirmed_at IS NOT NULL
         )
       ORDER BY admission.admitted_at, admission.codex_call_id
    `).all<{
      codex_call_id: string
      tool_name: string
      result_json: string
      result_digest: string
      updated_at: string
    }>(readyRunId).map((row) => {
      let output: unknown
      try {
        output = JSON.parse(row.result_json)
      } catch {
        throw new CodexBindingRepositoryError('published_tool_output_invalid')
      }
      if (!isRecord(output) || digestCanonicalJson(output) !== row.result_digest) {
        throw new CodexBindingRepositoryError('published_tool_output_digest_mismatch')
      }
      return {
        itemId: row.codex_call_id,
        toolName: row.tool_name,
        output: output as unknown as ToolExecutionOutput,
        completedAt: row.updated_at,
      }
    })
  }

  recordEngineTerminalCandidate(input: {
    readyRunId: string
    codexThreadId: string
    codexTurnId: string
    engineOutcome: 'completed' | 'interrupted' | 'failed'
    candidate: NativeTerminalCandidate
    recordedAt: string
  }): CodexEngineTerminalReceiptRead {
    nonEmpty(input.readyRunId, 'ready_run_id_invalid')
    nonEmpty(input.codexThreadId, 'codex_thread_id_invalid')
    nonEmpty(input.codexTurnId, 'codex_turn_id_invalid')
    nonEmpty(input.recordedAt, 'engine_terminal_recorded_at_invalid')
    assertNativeTerminalCandidate(input.candidate)
    const candidateJson = canonicalJson(input.candidate)
    const candidateDigest = digestCanonicalJson(input.candidate)
    this.immediate(() => {
      const row = this.requireTurn(input.readyRunId)
      const thread = this.requireThread(row.thread_binding_id)
      if (row.codex_thread_id !== input.codexThreadId || row.codex_turn_id !== input.codexTurnId) {
        throw new CodexBindingRepositoryError('engine_terminal_identity_mismatch')
      }
      if (input.candidate.readyRunId !== row.ready_run_id
        || input.candidate.readyTaskId !== row.ready_task_id
        || input.candidate.scopeId !== thread.ready_scope_id
        || input.candidate.codexThreadId !== input.codexThreadId
        || input.candidate.codexTurnId !== input.codexTurnId
        || input.candidate.engineOutcome !== input.engineOutcome) {
        throw new CodexBindingRepositoryError('engine_terminal_identity_mismatch')
      }
      if (row.engine_terminal_recorded_at) {
        if (row.engine_terminal_status !== input.engineOutcome
          || row.engine_terminal_candidate_json !== candidateJson
          || row.engine_terminal_candidate_digest !== candidateDigest) {
          throw new CodexBindingRepositoryError('engine_terminal_immutable')
        }
        return
      }
      const result = this.db.prepare(`
        UPDATE codex_turn_bindings
           SET engine_terminal_status = ?, engine_terminal_candidate_json = ?,
               engine_terminal_candidate_digest = ?, engine_terminal_recorded_at = ?,
               revision = revision + 1, updated_at = ?
         WHERE ready_run_id = ? AND revision = ?
           AND engine_terminal_recorded_at IS NULL
      `).run(
        input.engineOutcome,
        candidateJson,
        candidateDigest,
        input.recordedAt,
        input.recordedAt,
        input.readyRunId,
        row.revision,
      )
      if (changes(result) !== 1) {
        throw new CodexBindingRepositoryError('engine_terminal_cas_failed')
      }
    })
    return this.readEngineTerminalCandidate(input.readyRunId) as CodexEngineTerminalReceiptRead
  }

  readEngineTerminalCandidate(readyRunId: string): CodexEngineTerminalReceiptRead | null {
    nonEmpty(readyRunId, 'ready_run_id_invalid')
    const row = this.requireTurn(readyRunId)
    if (!row.engine_terminal_recorded_at) return null
    if (!row.codex_thread_id || !row.codex_turn_id || !row.engine_terminal_status
      || !row.engine_terminal_candidate_json || !row.engine_terminal_candidate_digest) {
      throw new CodexBindingRepositoryError('engine_terminal_receipt_incomplete')
    }
    let candidate: unknown
    try {
      candidate = JSON.parse(row.engine_terminal_candidate_json)
    } catch {
      throw new CodexBindingRepositoryError('engine_terminal_candidate_invalid')
    }
    if (digestCanonicalJson(candidate) !== row.engine_terminal_candidate_digest) {
      throw new CodexBindingRepositoryError('engine_terminal_candidate_digest_mismatch')
    }
    assertNativeTerminalCandidate(candidate)
    const thread = this.requireThread(row.thread_binding_id)
    if (candidate.readyRunId !== row.ready_run_id
      || candidate.readyTaskId !== row.ready_task_id
      || candidate.scopeId !== thread.ready_scope_id
      || candidate.codexThreadId !== row.codex_thread_id
      || candidate.codexTurnId !== row.codex_turn_id
      || candidate.engineOutcome !== row.engine_terminal_status) {
      throw new CodexBindingRepositoryError('engine_terminal_identity_mismatch')
    }
    return {
      readyRunId,
      codexThreadId: row.codex_thread_id,
      codexTurnId: row.codex_turn_id,
      engineOutcome: row.engine_terminal_status,
      candidate,
      candidateDigest: row.engine_terminal_candidate_digest,
      recordedAt: row.engine_terminal_recorded_at,
    }
  }

  recordToolPublicationReceipt(input: {
    readyRunId: string
    recordedAt: string
  }): CodexToolPublicationReceiptRead {
    nonEmpty(input.readyRunId, 'ready_run_id_invalid')
    nonEmpty(input.recordedAt, 'publication_recorded_at_invalid')
    const terminal = this.readEngineTerminalCandidate(input.readyRunId)
    if (!terminal) throw new CodexBindingRepositoryError('engine_terminal_receipt_missing')
    const candidate = terminal.candidate as NativeTerminalCandidate
    const publication = this.readToolPublicationBarrier({
      readyRunId: input.readyRunId,
      codexThreadId: terminal.codexThreadId,
      codexTurnId: terminal.codexTurnId,
      candidateCalls: candidate.usedToolCalls,
    })
    if (publication.kind !== 'accepted') {
      throw new CodexBindingRepositoryError(`tool_publication_${publication.kind}`)
    }
    const refsJson = canonicalJson(publication.verifiedReceiptRefs)
    const receiptDigest = digestCanonicalJson({
      readyRunId: input.readyRunId,
      engineTerminalCandidateDigest: terminal.candidateDigest,
      verifiedReceiptRefs: publication.verifiedReceiptRefs,
    })
    this.immediate(() => {
      const row = this.requireTurn(input.readyRunId)
      if (row.publication_recorded_at) {
        if (row.publication_receipt_refs_json !== refsJson
          || row.publication_receipt_digest !== receiptDigest) {
          throw new CodexBindingRepositoryError('publication_receipt_immutable')
        }
        return
      }
      const updated = this.db.prepare(`
        UPDATE codex_turn_bindings
           SET publication_receipt_refs_json = ?, publication_receipt_digest = ?,
               publication_recorded_at = ?, revision = revision + 1, updated_at = ?
         WHERE ready_run_id = ? AND revision = ?
           AND engine_terminal_recorded_at IS NOT NULL
           AND publication_recorded_at IS NULL
           AND product_terminal_digest IS NULL
           AND host_failure_product_terminal_digest IS NULL
      `).run(
        refsJson,
        receiptDigest,
        input.recordedAt,
        input.recordedAt,
        input.readyRunId,
        row.revision,
      )
      if (changes(updated) !== 1) {
        throw new CodexBindingRepositoryError('publication_receipt_cas_failed')
      }
    })
    return this.readToolPublicationReceipt(input.readyRunId) as CodexToolPublicationReceiptRead
  }

  readToolPublicationReceipt(readyRunId: string): CodexToolPublicationReceiptRead | null {
    const row = this.requireTurn(readyRunId)
    if (!row.publication_recorded_at) return null
    if (!row.publication_receipt_refs_json || !row.publication_receipt_digest
      || !row.engine_terminal_candidate_digest) {
      throw new CodexBindingRepositoryError('publication_receipt_incomplete')
    }
    let refs: unknown
    try {
      refs = JSON.parse(row.publication_receipt_refs_json)
    } catch {
      throw new CodexBindingRepositoryError('publication_receipt_invalid')
    }
    if (!Array.isArray(refs)
      || !refs.every((entry) => typeof entry === 'string' && entry.length > 0)
      || new Set(refs).size !== refs.length
      || digestCanonicalJson({
        readyRunId,
        engineTerminalCandidateDigest: row.engine_terminal_candidate_digest,
        verifiedReceiptRefs: refs,
      }) !== row.publication_receipt_digest) {
      throw new CodexBindingRepositoryError('publication_receipt_invalid')
    }
    const terminal = this.readEngineTerminalCandidate(readyRunId)
    if (!terminal) throw new CodexBindingRepositoryError('engine_terminal_receipt_missing')
    const publication = this.readToolPublicationBarrier({
      readyRunId,
      codexThreadId: terminal.codexThreadId,
      codexTurnId: terminal.codexTurnId,
      candidateCalls: (terminal.candidate as NativeTerminalCandidate).usedToolCalls,
    })
    if (publication.kind !== 'accepted'
      || canonicalJson(publication.verifiedReceiptRefs) !== canonicalJson(refs)) {
      throw new CodexBindingRepositoryError('publication_receipt_readback_mismatch')
    }
    return {
      readyRunId,
      verifiedReceiptRefs: refs,
      receiptDigest: row.publication_receipt_digest,
      recordedAt: row.publication_recorded_at,
    }
  }

  readToolPublicationBarrier(input: {
    readyRunId: string
    codexThreadId: string
    codexTurnId: string
    candidateCalls: NativeTerminalCandidate['usedToolCalls']
    effectSettlementOnly?: boolean
  }): CodexToolPublicationBarrierRead {
    for (const value of [input.readyRunId, input.codexThreadId, input.codexTurnId]) {
      nonEmpty(value, 'tool_publication_identity_invalid')
    }
    const owner = this.db.prepare(`
      SELECT turn.codex_thread_id, turn.codex_turn_id, turn.ingress_json,
             turn.ready_task_id, turn.turn_contract_digest,
             turn.authorization_snapshot_digest, turn.authorization_snapshot_json,
             thread.ready_conversation_alias, thread.codex_session_id,
             thread.tool_surface_digest, thread.tool_surface_snapshot_digest,
             thread.tool_surface_json
        FROM codex_turn_bindings turn
        JOIN codex_thread_bindings thread ON thread.thread_binding_id = turn.thread_binding_id
       WHERE turn.ready_run_id = ? LIMIT 1
    `).get<{
      codex_thread_id: string | null
      codex_turn_id: string | null
      ingress_json: string | null
      ready_task_id: string
      turn_contract_digest: string
      authorization_snapshot_digest: string
      authorization_snapshot_json: string
      ready_conversation_alias: string
      codex_session_id: string | null
      tool_surface_digest: string | null
      tool_surface_snapshot_digest: string | null
      tool_surface_json: string | null
    }>(input.readyRunId)
    if (!owner
      || owner.codex_thread_id !== input.codexThreadId
      || owner.codex_turn_id !== input.codexTurnId) {
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'tool_publication_turn_identity_mismatch', callId: null,
      }
    }
    let frozenToolSurface: ReadyToolSurface
    let frozenAuthorization: ReadyBoundTurnToolAuthorization
    try {
      frozenToolSurface = JSON.parse(owner.tool_surface_json || '') as ReadyToolSurface
      assertReadyToolSurface(frozenToolSurface)
      frozenAuthorization = JSON.parse(owner.authorization_snapshot_json) as ReadyBoundTurnToolAuthorization
      assertReadyBoundTurnToolAuthorization(frozenAuthorization)
      if (frozenToolSurface.toolSurfaceDigest !== owner.tool_surface_digest
        || frozenToolSurface.surfaceSnapshotDigest !== owner.tool_surface_snapshot_digest
        || frozenAuthorization.authorizationSnapshotDigest !== owner.authorization_snapshot_digest
        || frozenAuthorization.toolSurfaceDigest !== owner.tool_surface_digest) {
        throw new Error('frozen_tool_surface_digest_mismatch')
      }
    } catch {
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'tool_publication_frozen_snapshot_invalid', callId: null,
      }
    }
    const currentDocumentReadRequired = frozenAuthorization.allowedToolNames.includes(
      'document_read_section',
    )
    const effectSettlementOnly = input.effectSettlementOnly === true
    let publicationDivergedCallId: string | null = null
    const recordedTerminal = this.readEngineTerminalCandidate(input.readyRunId)
    if (recordedTerminal) {
      const recordedCandidate = recordedTerminal.candidate as NativeTerminalCandidate
      if (canonicalJson(recordedCandidate.usedToolCalls) !== canonicalJson(input.candidateCalls)) {
        if (!effectSettlementOnly) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'candidate_tool_calls_terminal_mismatch', callId: null,
          }
        }
        publicationDivergedCallId = input.candidateCalls[0]?.itemId || 'candidate'
      }
    }
    const terminalAllowsPreHostAbandonment = recordedTerminal !== null
      && recordedTerminal.engineOutcome !== 'completed'
    let currentDocumentAnchor: CodexCurrentDocumentAnchor | null = null
    try {
      const ingressReceipt = JSON.parse(owner.ingress_json || '') as {
        prepared?: { ingress?: { currentDocumentAnchor?: unknown } }
      }
      const rawAnchor = ingressReceipt.prepared?.ingress?.currentDocumentAnchor
      if (rawAnchor !== undefined && rawAnchor !== null) {
        const parsedAnchor = codexCurrentDocumentAnchorSchema.safeParse(rawAnchor)
        if (!parsedAnchor.success) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'current_document_anchor_invalid', callId: null,
          }
        }
        currentDocumentAnchor = parsedAnchor.data
      }
    } catch {
      return {
        kind: 'fabricated', verifiedReceiptRefs: [],
        code: 'tool_publication_ingress_invalid', callId: null,
      }
    }
    const candidateById = new Map<string, NativeTerminalCandidate['usedToolCalls'][number]>()
    for (const call of input.candidateCalls) {
      if (candidateById.has(call.itemId)) {
        if (!effectSettlementOnly) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'candidate_tool_call_duplicate', callId: call.itemId,
          }
        }
        publicationDivergedCallId ||= call.itemId
        continue
      }
      candidateById.set(call.itemId, call)
    }
    const rows = this.db.prepare(`
      SELECT admission.codex_call_id, admission.tool_name,
             admission.args_digest AS admission_args_digest,
             gateway.receipt_id AS gateway_receipt_id,
             binding.codex_call_id AS bound_call_id,
             binding.tool_name AS bound_tool_name,
             binding.args_digest AS bound_args_digest,
             binding.ready_action_id, binding.ready_alias_id, binding.codex_session_id,
             binding.ready_task_id, binding.turn_contract_digest,
             binding.surface_snapshot_digest, binding.authorization_snapshot_digest,
             binding.tool_surface_digest, binding.tool_schema_digest,
             binding.receipt_id AS binding_receipt_id,
             binding.result_digest AS binding_result_digest,
             binding.request_connection_epoch, binding.request_rpc_id,
             binding.delivered_connection_epoch, binding.delivered_rpc_id,
             binding.delivery_intent_at,
             binding.tool_response_digest,
             binding.legacy_delivery_evidence_unverifiable,
             action.state AS action_state, action.receipt_id AS action_receipt_id,
             action.result_digest AS action_result_digest,
             action.action_identity_digest AS action_identity_digest,
             action.result_json AS action_result_json,
             action.resolution_reason AS action_resolution_reason,
             action.resolution_evidence_digest AS action_resolution_evidence_digest
        FROM codex_tool_call_admissions admission
        JOIN codex_tool_group_admissions group_admission
          ON group_admission.gateway_request_receipt_id = admission.gateway_request_receipt_id
         AND group_admission.ready_run_id = admission.ready_run_id
         AND group_admission.codex_thread_id = admission.codex_thread_id
         AND group_admission.codex_turn_id = admission.codex_turn_id
        LEFT JOIN ready_model_gateway_request_receipts gateway
          ON gateway.receipt_id = admission.gateway_request_receipt_id
         AND gateway.request_kind = 'product'
         AND gateway.ready_run_id = admission.ready_run_id
         AND gateway.codex_thread_id = admission.codex_thread_id
         AND gateway.codex_turn_id = admission.codex_turn_id
        LEFT JOIN codex_tool_call_bindings binding
          ON binding.ready_run_id = admission.ready_run_id
         AND binding.codex_thread_id = admission.codex_thread_id
         AND binding.codex_turn_id = admission.codex_turn_id
         AND binding.codex_call_id = admission.codex_call_id
        LEFT JOIN ready_tool_action_receipts action
          ON action.ready_action_id = binding.ready_action_id
       WHERE admission.ready_run_id = ?
         AND admission.codex_thread_id = ?
         AND admission.codex_turn_id = ?
       ORDER BY admission.codex_call_id ASC
    `).all<{
      codex_call_id: string
      tool_name: string
      admission_args_digest: string
      gateway_receipt_id: string | null
      bound_call_id: string | null
      bound_tool_name: string | null
      bound_args_digest: string | null
      ready_action_id: string | null
      ready_alias_id: string | null
      codex_session_id: string | null
      ready_task_id: string | null
      turn_contract_digest: string | null
      surface_snapshot_digest: string | null
      authorization_snapshot_digest: string | null
      tool_surface_digest: string | null
      tool_schema_digest: string | null
      binding_receipt_id: string | null
      binding_result_digest: string | null
      request_connection_epoch: string | null
      request_rpc_id: string | null
      delivered_connection_epoch: string | null
      delivered_rpc_id: string | null
      delivery_intent_at: string | null
      tool_response_digest: string | null
      legacy_delivery_evidence_unverifiable: number
      action_state: 'pending' | 'confirmed' | 'proven_absent' | 'indeterminate' | null
      action_receipt_id: string | null
      action_result_digest: string | null
      action_identity_digest: string | null
      action_result_json: string | null
      action_resolution_reason: string | null
      action_resolution_evidence_digest: string | null
    }>(input.readyRunId, input.codexThreadId, input.codexTurnId)
    const admissionIds = new Set(rows.map((row) => row.codex_call_id))
    for (const call of input.candidateCalls) {
      if (!admissionIds.has(call.itemId)) {
        if (!effectSettlementOnly) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'candidate_tool_call_not_admitted', callId: call.itemId,
          }
        }
        publicationDivergedCallId ||= call.itemId
      }
    }
    const receipts: string[] = []
    let exactCurrentDocumentReadCallId: string | null = null
    for (const row of rows) {
      if (row.bound_call_id && row.bound_tool_name !== row.tool_name) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'bound_tool_name_mismatch', callId: row.codex_call_id,
        }
      }
      if (row.bound_call_id && row.bound_args_digest !== row.admission_args_digest) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'bound_args_digest_mismatch', callId: row.codex_call_id,
        }
      }
      if (row.bound_call_id) {
        const frozenEntry = frozenToolSurface.entries.find((entry) => entry.name === row.tool_name)
        if (row.ready_alias_id !== owner.ready_conversation_alias
          || row.codex_session_id !== owner.codex_session_id
          || row.ready_task_id !== owner.ready_task_id
          || row.turn_contract_digest !== owner.turn_contract_digest
          || row.surface_snapshot_digest !== owner.tool_surface_snapshot_digest
          || row.tool_surface_digest !== owner.tool_surface_digest
          || row.authorization_snapshot_digest !== owner.authorization_snapshot_digest
          || !frozenEntry
          || row.tool_schema_digest !== frozenEntry.schemaDigest) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'bound_frozen_identity_mismatch', callId: row.codex_call_id,
          }
        }
        const expectedActionIdentity = buildCodexToolActionIdentity({
          readyAliasId: owner.ready_conversation_alias,
          codexSessionId: owner.codex_session_id || '',
          codexThreadId: input.codexThreadId,
          codexTurnId: input.codexTurnId,
          codexCallId: row.codex_call_id,
          readyTaskId: owner.ready_task_id,
          readyRunId: input.readyRunId,
          toolName: row.tool_name,
          argsDigest: row.admission_args_digest,
          turnContractDigest: owner.turn_contract_digest,
          surfaceSnapshotDigest: owner.tool_surface_snapshot_digest || '',
          authorizationSnapshotDigest: owner.authorization_snapshot_digest,
          toolSchemaDigest: frozenEntry.schemaDigest,
        })
        if (row.ready_action_id !== expectedActionIdentity.readyActionId) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'bound_action_identity_mismatch', callId: row.codex_call_id,
          }
        }
        if (row.action_identity_digest !== null
          && row.action_identity_digest !== expectedActionIdentity.actionIdentityDigest) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'action_receipt_identity_mismatch', callId: row.codex_call_id,
          }
        }
      }
      let deliveryAttempts: ReturnType<CodexToolBindingRepository['readToolCallDeliveryAttempts']>
      try {
        deliveryAttempts = row.bound_call_id
          ? this.toolBindings.readToolCallDeliveryAttempts({
              codexThreadId: input.codexThreadId,
              codexTurnId: input.codexTurnId,
              codexCallId: row.codex_call_id,
            })
          : []
      } catch {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'tool_delivery_attempt_invalid', callId: row.codex_call_id,
        }
      }
      if (deliveryAttempts.some((attempt) => (
        attempt.codexThreadId !== input.codexThreadId
        || attempt.codexTurnId !== input.codexTurnId
        || attempt.codexCallId !== row.codex_call_id
        || attempt.readyActionId !== row.ready_action_id
      ))) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'tool_delivery_attempt_identity_mismatch', callId: row.codex_call_id,
        }
      }
      if (effectSettlementOnly && row.gateway_receipt_id && !row.bound_call_id) {
        if (row.ready_action_id !== null
          || row.binding_receipt_id !== null
          || row.binding_result_digest !== null
          || row.action_state !== null
          || row.action_receipt_id !== null
          || row.action_result_digest !== null
          || row.action_result_json !== null
          || deliveryAttempts.length !== 0) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'unbound_tool_action_evidence_invalid', callId: row.codex_call_id,
          }
        }
        publicationDivergedCallId ||= row.codex_call_id
        continue
      }
      if (effectSettlementOnly && row.action_state === 'proven_absent') {
        const expectedEvidenceDigest = row.action_identity_digest
          && row.action_resolution_reason
          && row.request_connection_epoch
          ? buildReadyToolActionAbsenceEvidenceDigest({
              readyActionId: row.ready_action_id || '',
              actionIdentityDigest: row.action_identity_digest,
              connectionEpoch: row.request_connection_epoch,
              reason: row.action_resolution_reason,
            })
          : null
        if (!row.gateway_receipt_id
          || !row.bound_call_id
          || !row.ready_action_id
          || !expectedEvidenceDigest
          || expectedEvidenceDigest !== row.action_resolution_evidence_digest
          || row.binding_receipt_id !== null
          || row.binding_result_digest !== null
          || row.action_receipt_id !== null
          || row.action_result_digest !== null
          || row.action_result_json !== null
          || row.delivered_connection_epoch !== null
          || row.delivered_rpc_id !== null
          || row.tool_response_digest !== null
          || deliveryAttempts.length !== 0) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'tool_action_absence_evidence_invalid', callId: row.codex_call_id,
          }
        }
        publicationDivergedCallId ||= row.codex_call_id
        continue
      }
      const candidate = candidateById.get(row.codex_call_id)
      if (!candidate) {
        if (!effectSettlementOnly
          && terminalAllowsPreHostAbandonment
          && row.gateway_receipt_id
          && row.bound_call_id === null) {
          continue
        }
        if (!terminalAllowsPreHostAbandonment
          || !row.gateway_receipt_id
          || !row.ready_action_id) {
          return {
            kind: 'incomplete', verifiedReceiptRefs: [],
            code: 'admitted_tool_call_missing_from_terminal', callId: row.codex_call_id,
          }
        }
        if (row.action_state === 'pending' || row.action_state === 'indeterminate') {
          return {
            kind: 'indeterminate', verifiedReceiptRefs: [],
            code: `tool_action_${row.action_state}`, callId: row.codex_call_id,
          }
        }
        if (row.action_state === 'proven_absent') {
          const expectedEvidenceDigest = row.action_identity_digest
            && row.action_resolution_reason
            && row.request_connection_epoch
            ? buildReadyToolActionAbsenceEvidenceDigest({
                readyActionId: row.ready_action_id,
                actionIdentityDigest: row.action_identity_digest,
                connectionEpoch: row.request_connection_epoch,
                reason: row.action_resolution_reason,
              })
            : null
          if (!expectedEvidenceDigest
            || expectedEvidenceDigest !== row.action_resolution_evidence_digest
            || row.binding_receipt_id !== null
            || row.binding_result_digest !== null
            || row.action_receipt_id !== null
            || row.action_result_digest !== null
            || row.action_result_json !== null
            || row.delivered_connection_epoch !== null
            || row.delivered_rpc_id !== null
            || row.tool_response_digest !== null
            || deliveryAttempts.length !== 0) {
            return {
              kind: 'fabricated', verifiedReceiptRefs: [],
              code: 'tool_action_absence_evidence_invalid', callId: row.codex_call_id,
            }
          }
          publicationDivergedCallId ||= row.codex_call_id
          continue
        }
        if (row.action_state !== 'confirmed') {
          return {
            kind: 'incomplete', verifiedReceiptRefs: [],
            code: 'admitted_tool_call_missing_from_terminal', callId: row.codex_call_id,
          }
        }
      }
      if (candidate && candidate.tool !== row.tool_name) {
        if (!effectSettlementOnly) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'candidate_tool_name_mismatch', callId: row.codex_call_id,
          }
        }
        publicationDivergedCallId ||= row.codex_call_id
      }
      if (candidate && candidate.status !== 'completed' && candidate.status !== 'failed') {
        if (!effectSettlementOnly) {
          return {
            kind: 'incomplete', verifiedReceiptRefs: [],
            code: 'candidate_tool_call_nonterminal', callId: row.codex_call_id,
          }
        }
        publicationDivergedCallId ||= row.codex_call_id
      }
      if (!row.gateway_receipt_id || !row.ready_action_id) {
        return {
          kind: 'incomplete', verifiedReceiptRefs: [],
          code: 'tool_binding_or_gateway_receipt_missing', callId: row.codex_call_id,
        }
      }
      if (row.action_state === 'pending' || row.action_state === 'indeterminate') {
        return {
          kind: 'indeterminate', verifiedReceiptRefs: [],
          code: `tool_action_${row.action_state}`, callId: row.codex_call_id,
        }
      }
      if (row.action_state !== 'confirmed'
        || !row.binding_receipt_id || !row.binding_result_digest
        || row.binding_receipt_id !== row.action_receipt_id
        || row.binding_result_digest !== row.action_result_digest
        || !row.request_connection_epoch || !row.request_rpc_id) {
        return {
          kind: effectSettlementOnly ? 'fabricated' : 'incomplete', verifiedReceiptRefs: [],
          code: 'tool_result_evidence_incomplete', callId: row.codex_call_id,
        }
      }
      const candidateResponseDigest = candidate?.responseDigest ?? null
      const candidateDeliveryAttempt = candidateResponseDigest
        ? deliveryAttempts.find((attempt) => (
            attempt.toolResponseDigest === candidateResponseDigest
            && digestCanonicalJson(attempt.toolResponse) === candidateResponseDigest
          )) || null
        : null
      if (!effectSettlementOnly && candidate && !candidateDeliveryAttempt) {
        if (row.legacy_delivery_evidence_unverifiable === 1
          && row.tool_response_digest === null) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'legacy_failed_tool_delivery_unverifiable', callId: row.codex_call_id,
          }
        }
        return {
          kind: 'incomplete', verifiedReceiptRefs: [],
          code: 'candidate_tool_result_not_delivered', callId: row.codex_call_id,
        }
      }
      let authoritativeSuccess: boolean | null = null
      let authoritativeResult: unknown = null
      try {
        authoritativeResult = JSON.parse(row.action_result_json || '')
        if (digestCanonicalJson(authoritativeResult) !== row.action_result_digest) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'tool_action_result_digest_mismatch', callId: row.codex_call_id,
          }
        }
        const expectedReceiptId = `ready-tool-receipt-${digestCanonicalJson({
          readyActionId: row.ready_action_id,
          resultDigest: row.action_result_digest,
        })}`
        if (row.action_receipt_id !== expectedReceiptId) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'tool_action_receipt_identity_mismatch', callId: row.codex_call_id,
          }
        }
        authoritativeSuccess = readyToolResultSuccess(authoritativeResult)
      } catch {
        if (effectSettlementOnly) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'tool_action_result_invalid', callId: row.codex_call_id,
          }
        }
        authoritativeSuccess = null
      }
      if (!effectSettlementOnly && authoritativeSuccess === null) {
        return {
          kind: 'incomplete', verifiedReceiptRefs: [],
          code: 'tool_result_success_unknown', callId: row.codex_call_id,
        }
      }
      if (candidate && candidate.success !== authoritativeSuccess) {
        if (!effectSettlementOnly) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'candidate_tool_success_mismatch', callId: row.codex_call_id,
          }
        }
        publicationDivergedCallId ||= row.codex_call_id
      }
      if (!effectSettlementOnly && candidateDeliveryAttempt
        && (!isRecord(candidateDeliveryAttempt.toolResponse)
          || candidateDeliveryAttempt.toolResponse.success !== authoritativeSuccess)) {
        return {
          kind: 'fabricated', verifiedReceiptRefs: [],
          code: 'tool_delivery_attempt_result_mismatch', callId: row.codex_call_id,
        }
      }
      if (!effectSettlementOnly
        && currentDocumentAnchor
        && currentDocumentReadRequired
        && row.tool_name === 'document_read_section'
        && authoritativeSuccess) {
        const resultData = isRecord(authoritativeResult) && isRecord(authoritativeResult.data)
          ? authoritativeResult.data
          : null
        const receipt = resultData && isRecord(resultData.resourceReadReceipt)
          ? resultData.resourceReadReceipt
          : null
        if (!receipt) {
          return {
            kind: 'incomplete', verifiedReceiptRefs: [],
            code: 'current_document_read_receipt_missing', callId: row.codex_call_id,
          }
        }
        const expectedReceipt = {
          readyRunId: input.readyRunId,
          codexThreadId: input.codexThreadId,
          codexTurnId: input.codexTurnId,
          codexCallId: row.codex_call_id,
          readyActionId: row.ready_action_id,
          actionIdentityDigest: row.action_identity_digest,
          logicalResourceId: currentDocumentAnchor.logicalResourceId,
          currentVersion: currentDocumentAnchor.currentVersion,
          currentDigest: currentDocumentAnchor.currentDigest,
          policyEpoch: currentDocumentAnchor.policyEpoch,
          tabId: currentDocumentAnchor.tabId,
          pane: currentDocumentAnchor.pane,
          pathDigest: currentDocumentAnchor.pathDigest,
          incarnationKey: currentDocumentAnchor.incarnationKey,
          modelVisibleText: isRecord(authoritativeResult)
            && typeof authoritativeResult.text === 'string'
            ? authoritativeResult.text
            : '',
        }
        if (!currentDocumentReadReceiptMatches(receipt, expectedReceipt)) {
          return {
            kind: 'fabricated', verifiedReceiptRefs: [],
            code: 'current_document_read_receipt_mismatch', callId: row.codex_call_id,
          }
        }
        exactCurrentDocumentReadCallId = row.codex_call_id
      }
      receipts.push(row.binding_receipt_id)
      if (!candidate) publicationDivergedCallId ||= row.codex_call_id
    }
    if (!effectSettlementOnly
      && currentDocumentAnchor
      && currentDocumentReadRequired
      && !exactCurrentDocumentReadCallId
      && (!recordedTerminal || recordedTerminal.engineOutcome === 'completed')) {
      return {
        kind: 'incomplete', verifiedReceiptRefs: [],
        code: 'current_document_read_required', callId: null,
      }
    }
    if (publicationDivergedCallId) {
      return {
        kind: 'diverged', verifiedReceiptRefs: [],
        code: 'settled_tool_call_missing_from_failed_terminal',
        callId: publicationDivergedCallId,
      }
    }
    if (!effectSettlementOnly
      && (!recordedTerminal || recordedTerminal.engineOutcome === 'completed')) {
      const artifactPublication = this.readArtifactPublicationBarrier({
        readyRunId: input.readyRunId,
        ingressJson: owner.ingress_json,
      })
      if (artifactPublication.kind !== 'accepted') return artifactPublication
      receipts.push(...artifactPublication.verifiedReceiptRefs)
    }
    return {
      kind: 'accepted',
      verifiedReceiptRefs: Array.from(new Set(receipts)).sort(),
      code: null,
      callId: null,
    }
  }

  readProductCloseout(readyRunId: string): CodexProductCloseoutRead | null {
    nonEmpty(readyRunId, 'ready_run_id_invalid')
    const row = this.db.prepare(`
      SELECT product_terminal_digest, host_failure_product_terminal_digest,
             product_closeout_at, host_failure_closeout_at
        FROM codex_turn_bindings WHERE ready_run_id = ? LIMIT 1
    `).get<{
      product_terminal_digest: string | null
      host_failure_product_terminal_digest: string | null
      product_closeout_at: string | null
      host_failure_closeout_at: string | null
    }>(readyRunId)
    if (!row) throw new CodexBindingRepositoryError('product_turn_binding_missing')
    if (row.product_terminal_digest && row.host_failure_product_terminal_digest) {
      throw new CodexBindingRepositoryError('product_closeout_kind_conflict')
    }
    const productTerminalDigest = row.product_terminal_digest || row.host_failure_product_terminal_digest
    const productCloseoutAt = row.product_terminal_digest
      ? row.product_closeout_at
      : row.host_failure_closeout_at
    if (!productTerminalDigest || !productCloseoutAt) return null
    return {
      productTerminalDigest,
      productCloseoutAt,
    }
  }

  readProductTurnPresentation(readyRunId: string): ProductTurnReceipt {
    return readProductTurnPresentation(this.db, readyRunId)
  }

  readProductTurnPresentations(readyRunIds: readonly string[]): ProductTurnReceipt[] {
    return readProductTurnPresentations(this.db, readyRunIds)
  }

  readArtifactWriteHead(readyRunId: string, relativePath: string): {
    logicalArtifactRef: string
    version: string
    logicalSha256: string
    receiptRefs: string[]
  } | null {
    nonEmpty(readyRunId, 'ready_run_id_invalid')
    nonEmpty(relativePath, 'artifact_relative_path_invalid')
    const prepared = this.readProductTurnRuntime(readyRunId).prepared
    const frozenRetrySources = prepared.ingress.attemptKind === 'explicit_retry'
      ? prepared.ingress.artifactSources ?? []
      : []
    const rows = this.db.prepare(`
      SELECT binding.ready_action_id, action.receipt_id, action.result_json
        FROM codex_tool_call_bindings binding
        JOIN ready_tool_action_receipts action
          ON action.ready_action_id = binding.ready_action_id
         AND action.state = 'confirmed'
       WHERE binding.ready_run_id = ?
         AND binding.tool_name = 'skill_write_artifact'
         AND EXISTS (
           SELECT 1 FROM codex_tool_response_delivery_attempts delivery
            WHERE delivery.ready_action_id = binding.ready_action_id
              AND delivery.transport_write_confirmed_at IS NOT NULL
         )
       ORDER BY binding.created_at, binding.ready_action_id
    `).all<{
      ready_action_id: string
      receipt_id: string
      result_json: string
    }>(readyRunId)
    let head: {
      logicalArtifactRef: string
      version: string
      logicalSha256: string
    } | null = null
    const receiptRefs: string[] = []
    for (const row of rows) {
      let result: unknown
      try { result = JSON.parse(row.result_json) } catch {
        throw new CodexBindingRepositoryError('artifact_write_receipt_invalid')
      }
      const outer = isRecord(result) ? result : null
      const envelope = outer && isRecord(outer.envelope) ? outer.envelope : null
      const data = outer && isRecord(outer.data)
        ? outer.data
        : envelope && isRecord(envelope.data) ? envelope.data : null
      if (!data || data.relativePath !== relativePath) continue
      const expectedVersion = data.expectedVersion === null || data.expectedVersion === 'empty'
        ? null
        : typeof data.expectedVersion === 'string' ? data.expectedVersion : undefined
      let expectedHeadVersion = head?.version ?? null
      let retryReceiptRefs: string[] = []
      if (!head && isRecord(data.retrySeed)
        && isRecord(data.retrySeed.source)
        && isRecord(data.retrySeed.copyReceipt)) {
        const source = data.retrySeed.source
        const copy = data.retrySeed.copyReceipt
        const frozen = frozenRetrySources.find((candidate) => (
          candidate.sourceReadyRunId === source.sourceReadyRunId
          && candidate.relativePath === relativePath
        ))
        if (!frozen
          || source.sourceReadyRunId === readyRunId
          || source.version !== frozen.version
          || source.sha256 !== frozen.sha256
          || source.logicalArtifactRef !== frozen.logicalArtifactRef
          || copy.actionId !== `${row.ready_action_id}:cow`
          || copy.expectedVersion !== null
          || copy.mode !== 'replace'
          || typeof copy.version !== 'string'
          || copy.logicalSha256 !== frozen.sha256) {
          throw new CodexBindingRepositoryError('artifact_retry_seed_invalid')
        }
        const sourceHead = this.readArtifactWriteHead(frozen.sourceReadyRunId, relativePath)
        if (!sourceHead
          || sourceHead.logicalArtifactRef !== frozen.logicalArtifactRef
          || sourceHead.version !== frozen.version
          || sourceHead.logicalSha256 !== frozen.sha256) {
          throw new CodexBindingRepositoryError('artifact_retry_source_readback_mismatch')
        }
        expectedHeadVersion = copy.version
        retryReceiptRefs = sourceHead.receiptRefs
      }
      if (expectedVersion === undefined
        || expectedVersion !== expectedHeadVersion
        || data.actionId !== row.ready_action_id
        || !['replace', 'append'].includes(String(data.mode))
        || typeof data.logicalArtifactRef !== 'string'
        || typeof data.version !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(data.version)
        || typeof data.logicalSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.logicalSha256)) {
        throw new CodexBindingRepositoryError('artifact_write_receipt_chain_invalid')
      }
      head = {
        logicalArtifactRef: data.logicalArtifactRef,
        version: data.version,
        logicalSha256: data.logicalSha256,
      }
      receiptRefs.push(...retryReceiptRefs, row.receipt_id)
    }
    return head ? { ...head, receiptRefs } : null
  }

  beginBrowserVerifierAttempt(input: {
    readyRunId: string
    readyTaskId: string
    readyScopeId: string
    readyAliasId: string
    aliasGeneration: number
    threadBindingId: string
    codexThreadId: string
    codexTurnId: string
    candidateDigest: string
    frozenIdentityDigest: string
    upstreamProfileSnapshotRef: string
    upstreamProfileSnapshotDigest: string
    workflowCloseoutSealDigest: string
    dispatchedAt: string
  }): { created: boolean; attempt: CodexBrowserVerifierAttemptRead } {
    for (const value of [
      input.readyRunId,
      input.readyTaskId,
      input.readyScopeId,
      input.readyAliasId,
      input.threadBindingId,
      input.codexThreadId,
      input.codexTurnId,
      input.upstreamProfileSnapshotRef,
      input.dispatchedAt,
    ]) nonEmpty(value, 'browser_verifier_attempt_identity_invalid')
    for (const digest of [
      input.candidateDigest,
      input.frozenIdentityDigest,
      input.upstreamProfileSnapshotDigest,
      input.workflowCloseoutSealDigest,
    ]) {
      if (!/^[a-f0-9]{64}$/.test(digest)) {
        throw new CodexBindingRepositoryError('browser_verifier_attempt_digest_invalid')
      }
    }
    if (!Number.isSafeInteger(input.aliasGeneration) || input.aliasGeneration < 1) {
      throw new CodexBindingRepositoryError('browser_verifier_attempt_alias_generation_invalid')
    }
    return this.immediate(() => {
      const turn = this.requireTurn(input.readyRunId)
      const thread = this.requireThread(turn.thread_binding_id)
      if (turn.lifecycle_action) {
        throw new CodexBindingRepositoryError('browser_verifier_lifecycle_action_pending')
      }
      if (
        turn.ready_task_id !== input.readyTaskId
        || turn.thread_binding_id !== input.threadBindingId
        || turn.codex_thread_id !== input.codexThreadId
        || turn.codex_turn_id !== input.codexTurnId
        || turn.effective_upstream_snapshot_ref !== input.upstreamProfileSnapshotRef
        || turn.effective_upstream_snapshot_digest !== input.upstreamProfileSnapshotDigest
        || turn.engine_terminal_status !== 'completed'
        || !turn.engine_terminal_candidate_json
        || thread.ready_scope_id !== input.readyScopeId
        || thread.ready_conversation_alias !== input.readyAliasId
        || thread.alias_generation !== input.aliasGeneration
        || thread.thread_binding_id !== input.threadBindingId
        || turn.product_terminal_digest
        || turn.host_failure_product_terminal_digest
      ) throw new CodexBindingRepositoryError('browser_verifier_attempt_parent_mismatch')
      let candidate: NativeTerminalCandidate
      try {
        candidate = JSON.parse(turn.engine_terminal_candidate_json) as NativeTerminalCandidate
        assertNativeTerminalCandidate(candidate)
      } catch {
        throw new CodexBindingRepositoryError('browser_verifier_attempt_candidate_invalid')
      }
      if (
        candidate.candidateSelection.kind !== 'accepted'
        || candidate.candidateDigest !== input.candidateDigest
      ) throw new CodexBindingRepositoryError('browser_verifier_attempt_candidate_mismatch')
      const workflowInspection = readWorkflowVerifierBundleFromDb(this.db, input.readyTaskId)
      if (
        workflowInspection.inspection.state !== 'sealable'
        || !workflowInspection.bundle
        || workflowDigest(workflowInspection.bundle.seal) !== input.workflowCloseoutSealDigest
      ) throw new CodexBindingRepositoryError('browser_verifier_attempt_workflow_mismatch')
      const projectionRow = this.db.prepare(`
        SELECT task_id, run_id, revision, request_anchor_json, criteria_json,
               model_criteria_json, proof_refs_json, recent_artifacts_json,
               expected_outputs_json
          FROM task_projections WHERE task_id = ? AND run_id = ? LIMIT 1
      `).get<{
        task_id: string
        run_id: string
        revision: number
        request_anchor_json: string | null
        criteria_json: string | null
        model_criteria_json: string | null
        proof_refs_json: string | null
        recent_artifacts_json: string | null
        expected_outputs_json: string | null
      }>(input.readyTaskId, input.readyRunId)
      if (!projectionRow) {
        throw new CodexBindingRepositoryError('browser_verifier_attempt_projection_missing')
      }
      const product = this.readProductTurnRuntime(input.readyRunId)
      const frozenIdentityDigest = codexBrowserVerifierFrozenIdentityDigest({
        product: {
          readyRunId: product.readyRunId,
          readyTaskId: product.readyTaskId,
          readyScopeId: product.readyScopeId,
          readyAliasId: product.readyAliasId,
          aliasGeneration: product.aliasGeneration,
          threadBindingId: product.threadBindingId,
          codexThreadId: product.codexThreadId,
          codexTurnId: product.codexTurnId,
          turnRequestId: product.turnRequestId,
          toolSurfaceDigest: product.toolSurfaceDigest,
          turnContractDigest: product.turnContractDigest,
          upstreamProfileSnapshotRef: product.upstreamProfileSnapshotRef,
          upstreamProfileSnapshotDigest: product.upstreamProfileSnapshotDigest,
          codexModel: product.codexModel,
        },
        workflowBundle: workflowInspection.bundle,
        projection: {
          taskId: projectionRow.task_id,
          runId: projectionRow.run_id,
          revision: projectionRow.revision,
          requestAnchor: parseNullableObjectStrict(
            projectionRow.request_anchor_json,
            'browser_verifier_attempt_request_anchor_invalid',
          ) as CodexBrowserVerifierIdentityProjection['requestAnchor'],
          criteria: parseNullableObjectStrict(
            projectionRow.criteria_json,
            'browser_verifier_attempt_criteria_invalid',
          ),
          modelCriteria: parseArrayOrEmptyStrict(
            projectionRow.model_criteria_json,
            'browser_verifier_attempt_model_criteria_invalid',
          ).filter((entry): entry is string => typeof entry === 'string'),
          proofRefs: parseArrayOrEmptyStrict(
            projectionRow.proof_refs_json,
            'browser_verifier_attempt_proof_refs_invalid',
          ),
          recentArtifacts: parseArrayOrEmptyStrict(
            projectionRow.recent_artifacts_json,
            'browser_verifier_attempt_recent_artifacts_invalid',
          ) as CodexBrowserVerifierIdentityProjection['recentArtifacts'],
          expectedOutputs: parseArrayOrEmptyStrict(
            projectionRow.expected_outputs_json,
            'browser_verifier_attempt_expected_outputs_invalid',
          ).filter((entry): entry is string => typeof entry === 'string'),
        },
      })
      if (frozenIdentityDigest !== input.frozenIdentityDigest) {
        throw new CodexBindingRepositoryError('browser_verifier_attempt_frozen_identity_mismatch')
      }

      const attemptId = `codex-browser-verifier-${digestCanonicalJson({
        readyRunId: input.readyRunId,
        candidateDigest: input.candidateDigest,
        frozenIdentityDigest: input.frozenIdentityDigest,
      })}`
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO codex_browser_verifier_attempts (
          attempt_id, ready_run_id, ready_task_id, ready_scope_id, ready_alias_id,
          alias_generation, thread_binding_id, codex_thread_id, codex_turn_id,
          candidate_digest, frozen_identity_digest, upstream_profile_snapshot_ref,
          upstream_profile_snapshot_digest, workflow_closeout_seal_digest,
          status, dispatched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?)
      `).run(
        attemptId,
        input.readyRunId,
        input.readyTaskId,
        input.readyScopeId,
        input.readyAliasId,
        input.aliasGeneration,
        input.threadBindingId,
        input.codexThreadId,
        input.codexTurnId,
        input.candidateDigest,
        input.frozenIdentityDigest,
        input.upstreamProfileSnapshotRef,
        input.upstreamProfileSnapshotDigest,
        input.workflowCloseoutSealDigest,
        input.dispatchedAt,
      )
      const row = this.db.prepare(`
        SELECT * FROM codex_browser_verifier_attempts WHERE ready_run_id = ? LIMIT 1
      `).get<CodexBrowserVerifierAttemptRow>(input.readyRunId)
      if (!row) throw new CodexBindingRepositoryError('browser_verifier_attempt_readback_missing')
      const attempt = browserVerifierAttemptFromRow(row)
      if (
        attempt.attemptId !== attemptId
        || attempt.readyTaskId !== input.readyTaskId
        || attempt.readyScopeId !== input.readyScopeId
        || attempt.readyAliasId !== input.readyAliasId
        || attempt.aliasGeneration !== input.aliasGeneration
        || attempt.threadBindingId !== input.threadBindingId
        || attempt.codexThreadId !== input.codexThreadId
        || attempt.codexTurnId !== input.codexTurnId
        || attempt.candidateDigest !== input.candidateDigest
        || attempt.frozenIdentityDigest !== input.frozenIdentityDigest
        || attempt.upstreamProfileSnapshotRef !== input.upstreamProfileSnapshotRef
        || attempt.upstreamProfileSnapshotDigest !== input.upstreamProfileSnapshotDigest
        || attempt.workflowCloseoutSealDigest !== input.workflowCloseoutSealDigest
      ) throw new CodexBindingRepositoryError('browser_verifier_attempt_identity_conflict')
      return { created: changes(inserted) === 1, attempt }
    })
  }

  settleBrowserVerifierAttempt(input: {
    readyRunId: string
    attemptId: string
    outcome: CodexBrowserVerifierAttemptOutcome
    verdict: CodexBrowserVerifierVerdict
    sealedCandidateDigest: string | null
    verificationUsage: unknown
    verifiedAt: string
    settledAt: string
  }): CodexBrowserVerifierAttemptRead {
    if (
      input.verdict.version !== 1
      || !['accept', 'repair', 'block'].includes(input.verdict.verdict)
      || (input.verdict.verdict === 'accept' && input.outcome !== 'accept')
      || (input.verdict.verdict === 'repair' && input.outcome !== 'repair')
      || (input.verdict.verdict === 'block'
        && !['block', 'invalid', 'provider_unavailable', 'result_unknown', 'identity_drift'].includes(input.outcome))
      || (input.outcome === 'accept' && !input.sealedCandidateDigest)
      || (input.sealedCandidateDigest !== null && !/^[a-f0-9]{64}$/.test(input.sealedCandidateDigest))
    ) throw new CodexBindingRepositoryError('browser_verifier_settlement_invalid')
    return this.immediate(() => {
      const turn = this.requireTurn(input.readyRunId)
      if (turn.lifecycle_action
        || turn.interrupt_requested_at || turn.interrupt_ack_at || turn.interrupt_state_unknown_at) {
        throw new CodexBindingRepositoryError('browser_verifier_settlement_interrupted')
      }
      const row = this.db.prepare(`
        SELECT * FROM codex_browser_verifier_attempts WHERE ready_run_id = ? LIMIT 1
      `).get<CodexBrowserVerifierAttemptRow>(input.readyRunId)
      if (!row || row.attempt_id !== input.attemptId) {
        throw new CodexBindingRepositoryError('browser_verifier_attempt_not_found')
      }
      const existing = browserVerifierAttemptFromRow(row)
      if (existing.status === 'settled') return existing
      const verdictDigest = digestCanonicalJson(input.verdict)
      const receipt = {
        version: 1,
        attemptId: existing.attemptId,
        readyRunId: existing.readyRunId,
        readyTaskId: existing.readyTaskId,
        readyScopeId: existing.readyScopeId,
        readyAliasId: existing.readyAliasId,
        aliasGeneration: existing.aliasGeneration,
        threadBindingId: existing.threadBindingId,
        codexThreadId: existing.codexThreadId,
        codexTurnId: existing.codexTurnId,
        candidateDigest: existing.candidateDigest,
        frozenIdentityDigest: existing.frozenIdentityDigest,
        upstreamProfileSnapshotRef: existing.upstreamProfileSnapshotRef,
        upstreamProfileSnapshotDigest: existing.upstreamProfileSnapshotDigest,
        workflowCloseoutSealDigest: existing.workflowCloseoutSealDigest,
        outcome: input.outcome,
        verdict: input.verdict,
        verdictDigest,
        sealedCandidateDigest: input.sealedCandidateDigest,
        verificationUsage: input.verificationUsage ?? null,
        dispatchedAt: existing.dispatchedAt,
        verifiedAt: input.verifiedAt,
        settledAt: input.settledAt,
      }
      const receiptDigest = digestCanonicalJson(receipt)
      const updated = this.db.prepare(`
        UPDATE codex_browser_verifier_attempts
           SET status = 'settled', outcome = ?, verdict_json = ?, verdict_digest = ?,
               sealed_candidate_digest = ?, verification_usage_json = ?, receipt_digest = ?,
               verified_at = ?, settled_at = ?
         WHERE ready_run_id = ? AND attempt_id = ? AND status = 'dispatching'
      `).run(
        input.outcome,
        canonicalJson(input.verdict),
        verdictDigest,
        input.sealedCandidateDigest,
        canonicalJson(input.verificationUsage ?? null),
        receiptDigest,
        input.verifiedAt,
        input.settledAt,
        input.readyRunId,
        input.attemptId,
      )
      if (changes(updated) !== 1) {
        throw new CodexBindingRepositoryError('browser_verifier_settlement_conflict')
      }
      const readback = this.db.prepare(`
        SELECT * FROM codex_browser_verifier_attempts WHERE ready_run_id = ? LIMIT 1
      `).get<CodexBrowserVerifierAttemptRow>(input.readyRunId)
      if (!readback) throw new CodexBindingRepositoryError('browser_verifier_settlement_readback_missing')
      const settled = browserVerifierAttemptFromRow(readback)
      if (settled.receiptDigest !== receiptDigest) {
        throw new CodexBindingRepositoryError('browser_verifier_settlement_readback_mismatch')
      }
      return settled
    })
  }

  readBrowserVerifierAttempt(readyRunId: string): CodexBrowserVerifierAttemptRead | null {
    nonEmpty(readyRunId, 'ready_run_id_invalid')
    const row = this.db.prepare(`
      SELECT * FROM codex_browser_verifier_attempts WHERE ready_run_id = ? LIMIT 1
    `).get<CodexBrowserVerifierAttemptRow>(readyRunId)
    return row ? browserVerifierAttemptFromRow(row) : null
  }

  resolveProductInterruptOwner(input: {
    aliasId: string
    aliasGeneration: number
    readyRunId?: string
    codexThreadId: string
    codexTurnId: string
  }): CodexProductInterruptOwnerRead {
    nonEmpty(input.aliasId, 'interrupt_alias_id_invalid')
    safePositive(input.aliasGeneration, 'interrupt_alias_generation_invalid')
    if (input.readyRunId !== undefined) nonEmpty(input.readyRunId, 'ready_run_id_invalid')
    nonEmpty(input.codexThreadId, 'interrupt_thread_id_invalid')
    nonEmpty(input.codexTurnId, 'interrupt_turn_id_invalid')
    const rows = this.db.prepare(`
      SELECT turn.ready_run_id, turn.ready_task_id,
             thread.ready_scope_id, thread.ready_conversation_alias
        FROM codex_turn_bindings turn
        JOIN codex_thread_bindings thread
          ON thread.thread_binding_id = turn.thread_binding_id
        JOIN codex_thread_dispatch_fences fence
          ON fence.thread_binding_id = turn.thread_binding_id
         AND fence.operation_kind = 'product_turn'
         AND fence.owner_ready_run_id = turn.ready_run_id
       WHERE thread.ready_conversation_alias = ?
         AND thread.alias_generation = ?
         AND (? IS NULL OR turn.ready_run_id = ?)
         AND thread.retired_at IS NULL
         AND thread.codex_thread_id = ?
         AND turn.codex_thread_id = ?
         AND turn.codex_turn_id = ?
         AND turn.product_terminal_digest IS NULL
         AND turn.host_failure_product_terminal_digest IS NULL
         AND fence.quarantined_at IS NULL
    `).all<{
      ready_run_id: string
      ready_task_id: string
      ready_scope_id: string
      ready_conversation_alias: string
    }>(
      input.aliasId,
      input.aliasGeneration,
      input.readyRunId ?? null,
      input.readyRunId ?? null,
      input.codexThreadId,
      input.codexThreadId,
      input.codexTurnId,
    )
    if (rows.length !== 1) {
      throw new CodexBindingRepositoryError('product_interrupt_owner_mismatch')
    }
    return {
      readyRunId: rows[0].ready_run_id,
      readyTaskId: rows[0].ready_task_id,
      readyScopeId: rows[0].ready_scope_id,
      readyAliasId: rows[0].ready_conversation_alias,
    }
  }

  requestProductInterrupt(input: {
    action: CodexLifecycleAction
    aliasId: string
    aliasGeneration: number
    readyRunId?: string
    codexThreadId: string
    codexTurnId: string
    requestedAt: string
  }): CodexProductLifecycleActionRead
  requestProductInterrupt(input: {
    action?: null
    aliasId: string
    aliasGeneration: number
    readyRunId?: string
    codexThreadId: string
    codexTurnId: string
    requestedAt: string
  }): CodexProductInterruptOwnerRead
  requestProductInterrupt(input: {
    action?: CodexLifecycleAction | null
    aliasId: string
    aliasGeneration: number
    readyRunId?: string
    codexThreadId: string
    codexTurnId: string
    requestedAt: string
  }): CodexProductInterruptOwnerRead | CodexProductLifecycleActionRead {
    nonEmpty(input.requestedAt, 'interrupt_requested_at_invalid')
    const owner = this.resolveProductInterruptOwner(input)
    return this.immediate(() => {
      const row = this.requireTurn(owner.readyRunId)
      if (input.action && row.lifecycle_action) {
        if (row.lifecycle_action !== input.action) {
          throw new CodexBindingRepositoryError('product_lifecycle_action_conflict')
        }
        if (!row.lifecycle_action_requested_at || !row.lifecycle_action_evidence_digest) {
          throw new CodexBindingRepositoryError('product_lifecycle_action_evidence_missing')
        }
        const expectedDigest = codexLifecycleActionEvidence({
          ...owner,
          action: row.lifecycle_action,
          aliasGeneration: input.aliasGeneration,
          codexThreadId: input.codexThreadId,
          codexTurnId: input.codexTurnId,
          requestedAt: row.lifecycle_action_requested_at,
        })
        if (expectedDigest !== row.lifecycle_action_evidence_digest) {
          throw new CodexBindingRepositoryError('product_lifecycle_action_evidence_mismatch')
        }
        return {
          ...owner,
          aliasGeneration: input.aliasGeneration,
          threadBindingId: row.thread_binding_id,
          codexThreadId: input.codexThreadId,
          codexTurnId: input.codexTurnId,
          lifecycleAction: row.lifecycle_action,
          lifecycleActionRequestedAt: row.lifecycle_action_requested_at,
          lifecycleActionEvidenceDigest: row.lifecycle_action_evidence_digest,
        }
      }
      if (input.action && row.interrupt_requested_at && !row.lifecycle_action) {
        throw new CodexBindingRepositoryError('product_lifecycle_action_conflict')
      }
      if (!input.action && row.interrupt_requested_at) return owner
      const lifecycleActionEvidenceDigest = input.action
        ? codexLifecycleActionEvidence({
            ...owner,
            action: input.action,
            aliasGeneration: input.aliasGeneration,
            codexThreadId: input.codexThreadId,
            codexTurnId: input.codexTurnId,
            requestedAt: input.requestedAt,
          })
        : null
      const updated = this.db.prepare(`
        UPDATE codex_turn_bindings
           SET interrupt_requested_at = ?, lifecycle_action = ?,
               lifecycle_action_requested_at = ?, lifecycle_action_evidence_digest = ?,
               revision = revision + 1, updated_at = ?
         WHERE ready_run_id = ? AND revision = ?
           AND interrupt_requested_at IS NULL
           AND lifecycle_action IS NULL
           AND product_terminal_digest IS NULL
           AND host_failure_product_terminal_digest IS NULL
      `).run(
        input.requestedAt,
        input.action || null,
        input.action ? input.requestedAt : null,
        lifecycleActionEvidenceDigest,
        input.requestedAt,
        owner.readyRunId,
        row.revision,
      )
      if (changes(updated) !== 1) {
        throw new CodexBindingRepositoryError('interrupt_request_cas_failed')
      }
      return input.action
        ? {
            ...owner,
            aliasGeneration: input.aliasGeneration,
            threadBindingId: row.thread_binding_id,
            codexThreadId: input.codexThreadId,
            codexTurnId: input.codexTurnId,
            lifecycleAction: input.action,
            lifecycleActionRequestedAt: input.requestedAt,
            lifecycleActionEvidenceDigest: lifecycleActionEvidenceDigest as string,
          }
        : owner
    })
  }

  readProductLifecycleAction(readyRunId: string): CodexProductLifecycleActionRead | null {
    nonEmpty(readyRunId, 'ready_run_id_invalid')
    const turn = this.requireTurn(readyRunId)
    if (!turn.lifecycle_action) return null
    if (!turn.lifecycle_action_requested_at || !turn.lifecycle_action_evidence_digest
      || !turn.codex_thread_id || !turn.codex_turn_id) {
      throw new CodexBindingRepositoryError('product_lifecycle_action_evidence_missing')
    }
    const thread = this.requireThread(turn.thread_binding_id)
    const owner: CodexProductInterruptOwnerRead = {
      readyRunId: turn.ready_run_id,
      readyTaskId: turn.ready_task_id,
      readyScopeId: thread.ready_scope_id,
      readyAliasId: thread.ready_conversation_alias,
    }
    if (codexLifecycleActionEvidence({
      ...owner,
      action: turn.lifecycle_action,
      aliasGeneration: thread.alias_generation,
      codexThreadId: turn.codex_thread_id,
      codexTurnId: turn.codex_turn_id,
      requestedAt: turn.lifecycle_action_requested_at,
    }) !== turn.lifecycle_action_evidence_digest) {
      throw new CodexBindingRepositoryError('product_lifecycle_action_evidence_mismatch')
    }
    return {
      ...owner,
      aliasGeneration: thread.alias_generation,
      threadBindingId: turn.thread_binding_id,
      codexThreadId: turn.codex_thread_id,
      codexTurnId: turn.codex_turn_id,
      lifecycleAction: turn.lifecycle_action,
      lifecycleActionRequestedAt: turn.lifecycle_action_requested_at,
      lifecycleActionEvidenceDigest: turn.lifecycle_action_evidence_digest,
    }
  }

  acknowledgeProductInterrupt(input: {
    readyRunId: string
    acknowledgedAt: string
  }): void {
    nonEmpty(input.readyRunId, 'ready_run_id_invalid')
    nonEmpty(input.acknowledgedAt, 'interrupt_ack_at_invalid')
    this.immediate(() => {
      const row = this.requireTurn(input.readyRunId)
      if (!row.interrupt_requested_at) {
        throw new CodexBindingRepositoryError('interrupt_request_missing')
      }
      if (row.interrupt_ack_at) return
      const updated = this.db.prepare(`
        UPDATE codex_turn_bindings
           SET interrupt_ack_at = ?, revision = revision + 1, updated_at = ?
         WHERE ready_run_id = ? AND revision = ?
           AND interrupt_requested_at IS NOT NULL AND interrupt_ack_at IS NULL
           AND product_terminal_digest IS NULL
           AND host_failure_product_terminal_digest IS NULL
      `).run(input.acknowledgedAt, input.acknowledgedAt, input.readyRunId, row.revision)
      if (changes(updated) !== 1) {
        throw new CodexBindingRepositoryError('interrupt_ack_cas_failed')
      }
    })
  }

  markProductInterruptUnknown(input: {
    readyRunId: string
    unknownAt: string
  }): void {
    nonEmpty(input.readyRunId, 'ready_run_id_invalid')
    nonEmpty(input.unknownAt, 'interrupt_unknown_at_invalid')
    this.immediate(() => {
      const row = this.requireTurn(input.readyRunId)
      if (!row.interrupt_requested_at) {
        throw new CodexBindingRepositoryError('interrupt_request_missing')
      }
      if (row.interrupt_state_unknown_at) return
      const updated = this.db.prepare(`
        UPDATE codex_turn_bindings
           SET interrupt_state_unknown_at = ?, revision = revision + 1, updated_at = ?
         WHERE ready_run_id = ? AND revision = ?
           AND interrupt_requested_at IS NOT NULL AND interrupt_state_unknown_at IS NULL
           AND product_terminal_digest IS NULL
           AND host_failure_product_terminal_digest IS NULL
      `).run(input.unknownAt, input.unknownAt, input.readyRunId, row.revision)
      if (changes(updated) !== 1) {
        throw new CodexBindingRepositoryError('interrupt_unknown_cas_failed')
      }
    })
  }

  readProductStartState(readyRunId: string): CodexProductStartStateRead {
    nonEmpty(readyRunId, 'ready_run_id_invalid')
    const row = this.db.prepare(`
      SELECT turn.codex_thread_id, turn.codex_turn_id,
             thread.thread_start_dispatch_intent_at,
             turn.turn_start_dispatch_intent_at,
             turn.host_failure_kind, turn.product_terminal_digest,
             turn.host_failure_product_terminal_digest
        FROM codex_turn_bindings turn
        JOIN codex_thread_bindings thread
          ON thread.thread_binding_id = turn.thread_binding_id
       WHERE turn.ready_run_id = ? LIMIT 1
    `).get<{
      codex_thread_id: string | null
      codex_turn_id: string | null
      thread_start_dispatch_intent_at: string | null
      turn_start_dispatch_intent_at: string | null
      host_failure_kind: string | null
      product_terminal_digest: string | null
      host_failure_product_terminal_digest: string | null
    }>(readyRunId)
    if (!row) throw new CodexBindingRepositoryError('product_turn_binding_missing')
    return {
      codexThreadId: row.codex_thread_id,
      codexTurnId: row.codex_turn_id,
      threadStartDispatchIntentAt: row.thread_start_dispatch_intent_at,
      turnStartDispatchIntentAt: row.turn_start_dispatch_intent_at,
      hostFailureKind: row.host_failure_kind,
      productCloseoutCommitted: Boolean(
        row.product_terminal_digest || row.host_failure_product_terminal_digest,
      ),
    }
  }

  createEmptyAliasGeneration(input: CodexEmptyAliasGenerationInput): {
    threadBindingId: string
    aliasId: string
    aliasGeneration: number
  } {
    this.validateEmptyAlias(input)
    return this.immediate(() => this.insertEmptyAliasGenerationInOpenTransaction(input))
  }

  createEmptyAliasGenerationInOpenTransaction(input: CodexEmptyAliasGenerationInput): {
    threadBindingId: string
    aliasId: string
    aliasGeneration: number
  } {
    this.validateEmptyAlias(input)
    if (this.db.inTransaction !== true) {
      throw new CodexBindingRepositoryError('alias_create_transaction_missing')
    }
    return this.insertEmptyAliasGenerationInOpenTransaction(input)
  }

  resetIdleAlias(input: {
    aliasId: string
    expectedGeneration: number
    retirementEvidenceDigest: string
    resetAt: string
  }): {
    aliasId: string
    retiredGeneration: number
    newGeneration: number
    newThreadBindingId: string
    transactionDigest: string
    archiveIntentDigest: string | null
    messageVisibilityEpoch: number
  } {
    for (const value of [input.aliasId, input.retirementEvidenceDigest, input.resetAt]) {
      nonEmpty(value, 'alias_reset_identity_invalid')
    }
    safePositive(input.expectedGeneration, 'alias_generation_invalid')
    return this.immediate(() => {
      const thread = this.readActiveThreadByAlias(input.aliasId)
      if (!thread || thread.alias_generation !== input.expectedGeneration) {
        throw new CodexBindingRepositoryError('active_alias_generation_mismatch')
      }
      const fence = this.db.prepare(`
        SELECT thread_binding_id FROM codex_thread_dispatch_fences
         WHERE thread_binding_id = ? LIMIT 1
      `).get(thread.thread_binding_id)
      if (fence) throw new CodexBindingRepositoryError('alias_not_idle')
      const retired = this.db.prepare(`
        UPDATE codex_thread_bindings
           SET retired_at = ?, retired_reason = 'user_reset',
               retirement_evidence_digest = ?, revision = revision + 1, updated_at = ?
         WHERE thread_binding_id = ? AND revision = ? AND retired_at IS NULL
      `).run(
        input.resetAt,
        input.retirementEvidenceDigest,
        input.resetAt,
        thread.thread_binding_id,
        thread.revision,
      )
      if (changes(retired) !== 1) throw new CodexBindingRepositoryError('alias_reset_cas_failed')
      if (thread.codex_thread_id) this.assertThreadArchiveEligible(thread.codex_thread_id)
      const newGeneration = thread.alias_generation + 1
      const newThreadBindingId = this.nextThreadBindingId(
        thread.ready_conversation_alias,
        newGeneration,
        input.retirementEvidenceDigest,
      )
      this.insertEmptyAliasGenerationInOpenTransaction({
        threadBindingId: newThreadBindingId,
        aliasId: thread.ready_conversation_alias,
        aliasGeneration: newGeneration,
        readyScopeId: thread.ready_scope_id,
        runtimeManifestDigest: thread.runtime_manifest_digest,
        protocolSchemaDigest: thread.protocol_schema_digest,
        createdAt: input.resetAt,
      })
      const visibility = advanceCodexConversationMessageVisibilityInOpenTransaction(this.db, {
        scopeId: thread.ready_scope_id,
        resetAt: input.resetAt,
      })
      const transactionDigest = digest({
        aliasId: thread.ready_conversation_alias,
        retiredGeneration: thread.alias_generation,
        newGeneration,
        newThreadBindingId,
        retirementEvidenceDigest: input.retirementEvidenceDigest,
      })
      const archiveIntentDigest = this.recordThreadArchiveIntentInOpenTransaction({
        thread,
        sourceKind: 'idle_reset',
        retiredReason: 'user_reset',
        readyRunId: null,
        retirementEvidenceDigest: input.retirementEvidenceDigest,
        retirementTransactionDigest: transactionDigest,
        retiredAt: input.resetAt,
      })
      return {
        aliasId: thread.ready_conversation_alias,
        retiredGeneration: thread.alias_generation,
        newGeneration,
        newThreadBindingId,
        transactionDigest,
        archiveIntentDigest,
        messageVisibilityEpoch: visibility.messageVisibilityEpoch,
      }
    })
  }

  retireIdleAliasForClose(input: {
    aliasId: string
    expectedGeneration: number
    expectedSnapshot: Extract<
      LifecycleOperationSnapshot,
      'idle_never_started' | 'idle_ready_terminal_no_native' | 'idle_native_thread'
    >
    retirementEvidenceDigest: string
    retiredAt: string
    idleThreadReadDigest: string | null
    onClosedInOpenTransaction: (input: { conversationId: string; closedAt: string }) => void
  }): {
    aliasId: string
    retiredGeneration: number
    codexThreadId: string | null
    lastCommittedReadyTerminalTransactionDigest: string | null
    lastCommittedProductTerminalDigest: string | null
    transactionDigest: string
    archiveIntentDigest: string | null
    scopeClosureEvidenceDigest: string
  } {
    for (const value of [input.aliasId, input.retirementEvidenceDigest, input.retiredAt]) {
      nonEmpty(value, 'alias_close_identity_invalid')
    }
    safePositive(input.expectedGeneration, 'alias_generation_invalid')
    if (
      (input.expectedSnapshot === 'idle_native_thread') !== Boolean(input.idleThreadReadDigest)
    ) throw new CodexBindingRepositoryError('alias_close_thread_readback_invalid')

    return this.immediate(() => {
      const thread = this.readActiveThreadByAlias(input.aliasId)
      if (!thread || thread.alias_generation !== input.expectedGeneration) {
        throw new CodexBindingRepositoryError('active_alias_generation_mismatch')
      }
      const operation = this.readLifecycleOperation({
        aliasId: input.aliasId,
        aliasGeneration: input.expectedGeneration,
      })
      if (classifyLifecycleOperation(operation.facts) !== input.expectedSnapshot) {
        throw new CodexBindingRepositoryError('alias_not_idle')
      }
      const unresolvedTurn = this.db.prepare(`
        SELECT ready_run_id FROM codex_turn_bindings
         WHERE thread_binding_id = ?
           AND (
             turn_start_reservation_released_at IS NULL
             OR (product_terminal_digest IS NULL
               AND host_failure_product_terminal_digest IS NULL)
           )
         LIMIT 1
      `).get(thread.thread_binding_id)
      if (unresolvedTurn) throw new CodexBindingRepositoryError('alias_close_turn_unresolved')

      const latestTerminal = this.db.prepare(`
        SELECT product_terminal_digest, host_failure_product_terminal_digest
          FROM codex_turn_bindings
         WHERE thread_binding_id = ?
           AND (product_terminal_digest IS NOT NULL
             OR host_failure_product_terminal_digest IS NOT NULL)
         ORDER BY COALESCE(product_closeout_at, host_failure_closeout_at, updated_at) DESC,
                  created_at DESC, ready_run_id DESC
         LIMIT 1
      `).get<{
        product_terminal_digest: string | null
        host_failure_product_terminal_digest: string | null
      }>(thread.thread_binding_id)
      const lastTerminalDigest = latestTerminal?.product_terminal_digest
        || latestTerminal?.host_failure_product_terminal_digest
        || null
      if (
        input.expectedSnapshot === 'idle_never_started'
        && (thread.codex_thread_id !== null || lastTerminalDigest !== null)
      ) throw new CodexBindingRepositoryError('alias_close_snapshot_mismatch')
      if (
        input.expectedSnapshot === 'idle_ready_terminal_no_native'
        && (thread.codex_thread_id !== null || lastTerminalDigest === null)
      ) throw new CodexBindingRepositoryError('alias_close_snapshot_mismatch')
      if (
        input.expectedSnapshot === 'idle_native_thread'
        && (thread.codex_thread_id === null || lastTerminalDigest === null)
      ) throw new CodexBindingRepositoryError('alias_close_snapshot_mismatch')

      const retired = this.db.prepare(`
        UPDATE codex_thread_bindings
           SET retired_at = ?, retired_reason = 'closed',
               retirement_evidence_digest = ?, revision = revision + 1, updated_at = ?
         WHERE thread_binding_id = ? AND revision = ? AND retired_at IS NULL
      `).run(
        input.retiredAt,
        input.retirementEvidenceDigest,
        input.retiredAt,
        thread.thread_binding_id,
        thread.revision,
      )
      if (changes(retired) !== 1) {
        throw new CodexBindingRepositoryError('alias_close_cas_failed')
      }
      if (thread.codex_thread_id) this.assertThreadArchiveEligible(thread.codex_thread_id)

      const transactionDigest = digest({
        aliasId: thread.ready_conversation_alias,
        retiredGeneration: thread.alias_generation,
        codexThreadId: thread.codex_thread_id,
        expectedSnapshot: input.expectedSnapshot,
        retirementEvidenceDigest: input.retirementEvidenceDigest,
        lastTerminalDigest,
        idleThreadReadDigest: input.idleThreadReadDigest,
      })
      const archiveIntentDigest = this.recordThreadArchiveIntentInOpenTransaction({
        thread,
        sourceKind: 'idle_close',
        retiredReason: 'closed',
        readyRunId: null,
        retirementEvidenceDigest: input.retirementEvidenceDigest,
        retirementTransactionDigest: transactionDigest,
        retiredAt: input.retiredAt,
      })
      const scopeClosure = closeCodexConversationScopeInOpenTransaction(this.db, {
        scopeId: thread.ready_scope_id,
        closedAt: input.retiredAt,
        closeEvidenceDigest: transactionDigest,
      })
      input.onClosedInOpenTransaction({
        conversationId: thread.ready_scope_id,
        closedAt: input.retiredAt,
      })

      return {
        aliasId: thread.ready_conversation_alias,
        retiredGeneration: thread.alias_generation,
        codexThreadId: thread.codex_thread_id,
        lastCommittedReadyTerminalTransactionDigest:
          input.expectedSnapshot === 'idle_ready_terminal_no_native' ? lastTerminalDigest : null,
        lastCommittedProductTerminalDigest:
          input.expectedSnapshot === 'idle_native_thread' ? lastTerminalDigest : null,
        transactionDigest,
        archiveIntentDigest,
        scopeClosureEvidenceDigest: scopeClosure.closeEvidenceDigest,
      }
    })
  }

  admitProductBindings(input: CodexAdmittedBindingInput): {
    threadBindingId: string
    readyRunId: string
    threadState: 'unstarted' | 'loaded'
  } {
    return this.immediate(() => this.admitProductBindingsInOpenTransaction(input))
  }

  admitProductBindingsInOpenTransaction(input: CodexAdmittedBindingInput): {
    threadBindingId: string
    readyRunId: string
    threadState: 'unstarted' | 'loaded'
  } {
    if (this.db.inTransaction !== true) {
      throw new CodexBindingRepositoryError('product_admission_transaction_missing')
    }
    this.validateAdmission(input)
    this.assertReadyParents(input)
    const { ingressAdmittedDigest: _, ...digestInput } = input
      const existing = this.readActiveThreadByAlias(input.prepared.conversationAlias.aliasId)
      let thread: ThreadBindingRow
      if (input.reservation.existingThread) {
        if (
          !existing
          || existing.thread_binding_id !== input.threadBindingId
          || existing.alias_generation !== input.prepared.conversationAlias.aliasGeneration
          || existing.ready_scope_id !== input.prepared.readyToolHostIdentity.scopeId
          || existing.retired_at !== null
          || existing.continuation_blocked_at !== null
          || !existing.codex_thread_id
          || !existing.thread_start_reservation_set_id
        ) throw new CodexBindingRepositoryError('active_thread_binding_mismatch')
        if (existing.codex_model !== input.codexModel) {
          throw new CodexBindingRepositoryError('model_change_requires_new_thread')
        }
        if (
          existing.upstream_profile_snapshot_ref !== input.upstreamProfileSnapshotRef
          || existing.upstream_profile_snapshot_digest !== input.upstreamProfileSnapshotDigest
        ) {
          const existingSnapshot = this.readUpstreamProfileSnapshot(
            existing.upstream_profile_snapshot_ref,
            existing.upstream_profile_snapshot_digest,
          )
          const nextSnapshot = this.readUpstreamProfileSnapshot(
            input.upstreamProfileSnapshotRef,
            input.upstreamProfileSnapshotDigest,
          )
          if (canonicalJson(resolveCodexNativeModelSettings(existingSnapshot).threadConfig)
            !== canonicalJson(resolveCodexNativeModelSettings(nextSnapshot).threadConfig)) {
            throw new CodexBindingRepositoryError(
              'native_thread_config_change_requires_new_generation',
            )
          }
        }
        if (
          existing.isolated_thread_cwd !== input.isolatedThreadCwd
          || existing.instruction_contract_digest !== input.instructionContractDigest
          || existing.runtime_manifest_digest !== input.runtimeManifestDigest
          || existing.protocol_schema_digest !== input.protocolSchemaDigest
        ) throw new CodexBindingRepositoryError('thread_contract_change_requires_new_thread')
        if (existing.tool_surface_digest !== input.prepared.readyToolSurface.toolSurfaceDigest) {
          throw new CodexBindingRepositoryError('tool_surface_change_requires_new_thread')
        }
        const surfaceJson = canonicalJson(input.prepared.readyToolSurface)
        if (
          existing.tool_surface_snapshot_digest === null
          && existing.tool_surface_json === null
        ) {
          const backfilled = this.db.prepare(`
            UPDATE codex_thread_bindings
               SET tool_surface_snapshot_digest = ?, tool_surface_json = ?,
                   revision = revision + 1, updated_at = ?
             WHERE thread_binding_id = ? AND revision = ?
               AND tool_surface_digest = ?
               AND tool_surface_snapshot_digest IS NULL AND tool_surface_json IS NULL
          `).run(
            input.prepared.readyToolSurface.surfaceSnapshotDigest,
            surfaceJson,
            input.admittedAt,
            existing.thread_binding_id,
            existing.revision,
            input.prepared.readyToolSurface.toolSurfaceDigest,
          )
          if (changes(backfilled) !== 1) {
            throw new CodexBindingRepositoryError('tool_surface_backfill_cas_failed')
          }
          thread = this.requireThread(input.threadBindingId)
        } else {
          if (
            existing.tool_surface_snapshot_digest !== input.prepared.readyToolSurface.surfaceSnapshotDigest
            || existing.tool_surface_json !== surfaceJson
          ) throw new CodexBindingRepositoryError('tool_surface_snapshot_mismatch')
          thread = existing
        }
      } else {
        if (
          !existing
          || existing.thread_binding_id !== input.threadBindingId
          || existing.alias_generation !== input.prepared.conversationAlias.aliasGeneration
          || existing.ready_scope_id !== input.prepared.readyToolHostIdentity.scopeId
          || existing.runtime_manifest_digest !== input.runtimeManifestDigest
          || existing.protocol_schema_digest !== input.protocolSchemaDigest
          || existing.thread_start_reservation_set_id !== null
          || existing.codex_thread_id !== null
          || existing.retired_at !== null
        ) throw new CodexBindingRepositoryError('empty_alias_binding_mismatch')
        const threadMember = input.reservation.members[0]
        const hydrated = this.db.prepare(`
          UPDATE codex_thread_bindings
             SET thread_start_reservation_set_id = ?,
                 thread_start_reservation_member_id = ?,
                 thread_start_reservation_admitted_at = ?,
                 thread_start_request_id = ?, isolated_thread_cwd = ?,
                 tool_surface_digest = ?, tool_surface_snapshot_digest = ?,
                 tool_surface_json = ?, instruction_contract_digest = ?,
                 codex_model_provider_id = 'ready_gateway', codex_model = ?,
                 upstream_profile_snapshot_ref = ?, upstream_profile_snapshot_digest = ?,
                 revision = revision + 1, updated_at = ?
           WHERE thread_binding_id = ? AND revision = ?
             AND thread_start_reservation_set_id IS NULL AND retired_at IS NULL
        `).run(
          input.reservation.reservationSetId,
          threadMember.reservationId,
          input.admittedAt,
          input.prepared.ingressBinding.requestId,
          input.isolatedThreadCwd,
          input.prepared.readyToolSurface.toolSurfaceDigest,
          input.prepared.readyToolSurface.surfaceSnapshotDigest,
          canonicalJson(input.prepared.readyToolSurface),
          input.instructionContractDigest,
          input.codexModel,
          input.upstreamProfileSnapshotRef,
          input.upstreamProfileSnapshotDigest,
          input.admittedAt,
          existing.thread_binding_id,
          existing.revision,
        )
        if (changes(hydrated) !== 1) throw new CodexBindingRepositoryError('empty_alias_hydration_cas_failed')
        thread = this.requireThread(input.threadBindingId)
      }

      const turnMember = input.reservation.members[input.reservation.members.length - 1]
      const boundAuthorization = buildReadyBoundTurnToolAuthorization({
        authorization: input.prepared.readyTurnToolAuthorization,
        readySessionKey: input.prepared.conversationAlias.aliasId,
        readyTaskId: input.prepared.taskId,
        readyRunId: input.prepared.runId,
        scopeId: input.prepared.readyToolHostIdentity.scopeId,
        toolSurfaceDigest: input.prepared.readyToolSurface.toolSurfaceDigest,
        turnContractDigest: input.turnContractDigest,
        resourceAnchorDigest: input.prepared.resourceAnchorDigest,
        createdAt: input.admittedAt,
      })
      this.db.prepare(`
        INSERT INTO codex_turn_bindings (
          ready_run_id,
          ready_task_id,
          thread_binding_id,
          codex_thread_id,
          start_reservation_set_id,
          start_reservation_required_member_count,
          turn_start_reservation_member_id,
          turn_start_reservation_admitted_at,
          turn_request_id,
          origin_user_message_id,
          message_visibility_epoch,
          ingress_admitted_revision,
          ingress_admitted_digest,
          ingress_admitted_at,
          attempt_kind,
          predecessor_run_id,
          history_parity_evidence_digest,
          current_thread_read_evidence_digest,
          continuation_contract_digest,
          tool_surface_digest,
          authorization_snapshot_digest,
          authorization_snapshot_json,
          product_budget_seed_json,
          effective_codex_model,
          effective_upstream_snapshot_ref,
          effective_upstream_snapshot_digest,
          additional_context_digest,
          ready_memory_snapshot_json,
          ready_memory_snapshot_digest,
          ready_memory_state_revision,
          ready_memory_revocation_revision,
          turn_contract_digest,
          ingress_json,
          revision,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        input.prepared.runId,
        input.prepared.taskId,
        thread.thread_binding_id,
        thread.codex_thread_id,
        input.reservation.reservationSetId,
        input.reservation.members.length,
        turnMember.reservationId,
        input.admittedAt,
        input.turnRequestId,
        input.prepared.ingress.kind === 'user_ingress'
          ? input.prepared.ingress.originUserMessageId
          : null,
        input.messageVisibilityEpoch,
        input.ingressAdmittedRevision,
        input.ingressAdmittedDigest,
        input.admittedAt,
        input.prepared.ingress.attemptKind,
        input.prepared.ingress.predecessorRunId || null,
        input.prepared.ingress.historyParityEvidenceDigest || null,
        input.prepared.ingress.currentThreadReadEvidenceDigest || null,
        input.prepared.ingress.continuationContractDigest || null,
        input.prepared.readyToolSurface.toolSurfaceDigest,
        boundAuthorization.authorizationSnapshotDigest,
        canonicalJson(boundAuthorization),
        canonicalJson(input.prepared.productBudgetSeed),
        input.codexModel,
        input.upstreamProfileSnapshotRef,
        input.upstreamProfileSnapshotDigest,
        input.additionalContextDigest,
        canonicalJson(input.prepared.readyMemorySnapshot),
        input.prepared.readyMemorySnapshot.snapshotDigest,
        input.prepared.readyMemorySnapshot.stateRevision,
        input.prepared.readyMemorySnapshot.revocationRevision,
        input.turnContractDigest,
        canonicalJson(buildCodexIngressAdmissionReceipt(digestInput)),
        input.admittedAt,
        input.admittedAt,
      )
      this.db.prepare(`
        INSERT INTO codex_thread_dispatch_fences (
          thread_binding_id, owner_main_boot_id, operation_kind,
          owner_ready_run_id, acquired_at, revision
        ) VALUES (?, ?, 'product_turn', ?, ?, 1)
      `).run(thread.thread_binding_id, input.ownerMainBootId, input.prepared.runId, input.admittedAt)

      const turn = this.requireTurn(input.prepared.runId)
      const fence = this.db.prepare(`
        SELECT thread_binding_id, owner_ready_run_id, revision
          FROM codex_thread_dispatch_fences WHERE thread_binding_id = ?
      `).get<{ thread_binding_id: string; owner_ready_run_id: string; revision: number }>(
        thread.thread_binding_id,
      )
      if (
        turn.thread_binding_id !== thread.thread_binding_id
        || turn.start_reservation_set_id !== input.reservation.reservationSetId
        || fence?.owner_ready_run_id !== input.prepared.runId
        || fence.revision !== 1
      ) throw new CodexBindingRepositoryError('admission_readback_mismatch')
      return {
        threadBindingId: thread.thread_binding_id,
        readyRunId: turn.ready_run_id,
        threadState: thread.codex_thread_id ? 'loaded' : 'unstarted',
      }
  }

  activateStartDispatch(input: {
    connectionEpoch: string
    rpcId: number
    method: StartMethod
    bindingLookupKey: string
    requestDigest: string
    dispatchedAt: string
  }): {
    bindingId: string
    reservationSetId: string
    reservationId: string
    inboundIdentity:
      | { method: 'thread/start'; expectedCwd: string }
      | { method: 'turn/start'; threadId: string; clientUserMessageId: string }
  } {
    nonEmpty(input.connectionEpoch, 'connection_epoch_invalid')
    nonEmpty(input.bindingLookupKey, 'binding_lookup_invalid')
    nonEmpty(input.requestDigest, 'request_digest_invalid')
    safePositive(input.rpcId, 'rpc_identity_invalid')
    return this.immediate(() => {
      if (input.method === 'thread/start') {
        const row = this.db.prepare(`
          SELECT * FROM codex_thread_bindings WHERE isolated_thread_cwd = ?
        `).get<ThreadBindingRow>(input.bindingLookupKey)
        if (
          !row
          || !row.thread_start_reservation_set_id
          || !row.thread_start_reservation_member_id
          || !row.isolated_thread_cwd
          || row.thread_start_reservation_released_at
          || row.thread_start_dispatch_intent_at
        ) {
          throw new CodexBindingRepositoryError('thread_start_not_dispatchable')
        }
        const updated = this.db.prepare(`
          UPDATE codex_thread_bindings
             SET thread_start_rpc_connection_epoch = ?, thread_start_rpc_id = ?,
                 thread_start_dispatch_intent_at = ?, revision = revision + 1, updated_at = ?
           WHERE thread_binding_id = ? AND revision = ?
             AND thread_start_dispatch_intent_at IS NULL
             AND thread_start_reservation_released_at IS NULL
        `).run(
          input.connectionEpoch,
          input.rpcId,
          input.dispatchedAt,
          input.dispatchedAt,
          row.thread_binding_id,
          row.revision,
        )
        if (changes(updated) !== 1) throw new CodexBindingRepositoryError('start_dispatch_cas_failed')
        const readback = this.requireThread(row.thread_binding_id)
        if (
          readback.thread_start_rpc_connection_epoch !== input.connectionEpoch
          || readback.thread_start_rpc_id !== input.rpcId
        ) throw new CodexBindingRepositoryError('start_dispatch_readback_mismatch')
        return {
          bindingId: row.thread_binding_id,
          reservationSetId: row.thread_start_reservation_set_id,
          reservationId: row.thread_start_reservation_member_id,
          inboundIdentity: {
            method: 'thread/start',
            expectedCwd: row.isolated_thread_cwd,
          },
        }
      }
      const row = this.db.prepare(`
        SELECT * FROM codex_turn_bindings WHERE ready_run_id = ?
      `).get<TurnBindingRow>(input.bindingLookupKey)
      if (
        !row
        || row.turn_start_reservation_released_at
        || row.turn_start_dispatch_intent_at
        || !row.codex_thread_id
      ) throw new CodexBindingRepositoryError('turn_start_not_dispatchable')
      const updated = this.db.prepare(`
        UPDATE codex_turn_bindings
           SET turn_start_rpc_connection_epoch = ?, turn_start_rpc_id = ?,
               turn_start_dispatch_intent_at = ?, revision = revision + 1, updated_at = ?
         WHERE ready_run_id = ? AND revision = ?
           AND turn_start_dispatch_intent_at IS NULL
           AND turn_start_reservation_released_at IS NULL
      `).run(
        input.connectionEpoch,
        input.rpcId,
        input.dispatchedAt,
        input.dispatchedAt,
        row.ready_run_id,
        row.revision,
      )
      if (changes(updated) !== 1) throw new CodexBindingRepositoryError('start_dispatch_cas_failed')
      const readback = this.requireTurn(row.ready_run_id)
      if (
        readback.turn_start_rpc_connection_epoch !== input.connectionEpoch
        || readback.turn_start_rpc_id !== input.rpcId
      ) throw new CodexBindingRepositoryError('start_dispatch_readback_mismatch')
      return {
        bindingId: row.ready_run_id,
        reservationSetId: row.start_reservation_set_id,
        reservationId: row.turn_start_reservation_member_id,
        inboundIdentity: {
          method: 'turn/start',
          threadId: row.codex_thread_id,
          clientUserMessageId: row.turn_request_id,
        },
      }
    })
  }

  markStartChildWriteConfirmed(input: {
    connectionEpoch: string
    rpcId: number
    method: StartMethod
    bindingId: string
    childWriteDigest: string
    confirmedAt: string
  }): void {
    this.immediate(() => {
      const descriptor = this.startDescriptor(input.method)
      const row = this.requireStartRow(input.method, input.bindingId)
      this.assertStartRpc(row, descriptor, input)
      const priorAt = row[descriptor.writeAt] as string | null
      const priorDigest = row[descriptor.writeDigest] as string | null
      if (priorAt || priorDigest) {
        if (priorDigest !== input.childWriteDigest) {
          throw new CodexBindingRepositoryError('child_write_digest_conflict')
        }
        return
      }
      const result = this.db.prepare(`
        UPDATE ${descriptor.table}
           SET ${descriptor.writeAt} = ?, ${descriptor.writeDigest} = ?,
               revision = revision + 1, updated_at = ?
         WHERE ${descriptor.key} = ? AND revision = ?
           AND ${descriptor.epoch} = ? AND ${descriptor.rpcId} = ?
           AND ${descriptor.intent} IS NOT NULL
           AND ${descriptor.writeAt} IS NULL AND ${descriptor.writeDigest} IS NULL
      `).run(
        input.confirmedAt,
        input.childWriteDigest,
        input.confirmedAt,
        input.bindingId,
        row.revision,
        input.connectionEpoch,
        input.rpcId,
      )
      if (changes(result) !== 1) throw new CodexBindingRepositoryError('child_write_cas_failed')
    })
  }

  validateUnresolvedStart(input: {
    connectionEpoch: string
    rpcId: number
    method: StartMethod
    bindingId: string
  }): void {
    const descriptor = this.startDescriptor(input.method)
    const row = this.requireStartRow(input.method, input.bindingId)
    this.assertStartRpc(row, descriptor, input)
    if (row[descriptor.releaseAt] !== null) {
      throw new CodexBindingRepositoryError('unresolved_start_already_released')
    }
  }

  reconcileStartAccepted(input: {
    connectionEpoch: string
    rpcId: number
    method: StartMethod
    bindingId: string
    nativeId: string
    nativeResult: unknown
    responseDigest: string
    responsePending: boolean
    reconciledAt: string
  }): void {
    nonEmpty(input.nativeId, 'native_identity_invalid')
    nonEmpty(input.responseDigest, 'response_digest_invalid')
    this.immediate(() => {
      if (input.method === 'thread/start') this.reconcileThreadAccepted(input)
      else this.reconcileTurnAccepted(input)
    })
  }

  consumeLateStartResponse(input: {
    connectionEpoch: string
    rpcId: number
    method: StartMethod
    nativeId: string
    responseDigest: string
    closedAt: string
  }): boolean {
    return this.immediate(() => {
      const descriptor = this.startDescriptor(input.method)
      const row = this.db.prepare(`
        SELECT * FROM ${descriptor.table}
         WHERE ${descriptor.epoch} = ? AND ${descriptor.rpcId} = ?
           AND ${descriptor.reconciledAt} IS NOT NULL
           AND ${descriptor.responseAt} IS NULL
           AND ${descriptor.guardClosedAt} IS NULL
      `).get<Record<string, unknown>>(input.connectionEpoch, input.rpcId)
      if (!row) return false
      if (row[descriptor.nativeId] !== input.nativeId) {
        throw new CodexBindingRepositoryError('late_response_native_identity_mismatch')
      }
      const bindingId = String(row[descriptor.key])
      const result = this.db.prepare(`
        UPDATE ${descriptor.table}
           SET ${descriptor.responseAt} = ?, ${descriptor.guardClosedAt} = ?,
               ${descriptor.guardCloseReason} = 'response_received',
               revision = revision + 1, updated_at = ?
         WHERE ${descriptor.key} = ? AND revision = ?
           AND ${descriptor.responseAt} IS NULL AND ${descriptor.guardClosedAt} IS NULL
      `).run(input.closedAt, input.closedAt, input.closedAt, bindingId, row.revision)
      if (changes(result) !== 1) throw new CodexBindingRepositoryError('late_response_guard_cas_failed')
      return true
    })
  }

  closeLateResponseGuardsForConnection(connectionEpoch: string, closedAt: string): number {
    nonEmpty(connectionEpoch, 'connection_epoch_invalid')
    return this.immediate(() => {
      const threadResult = this.db.prepare(`
        UPDATE codex_thread_bindings
           SET thread_start_late_response_guard_closed_at = ?,
               thread_start_late_response_guard_close_reason = 'connection_closed',
               revision = revision + 1, updated_at = ?
         WHERE thread_start_rpc_connection_epoch = ?
           AND thread_start_reconciled_at IS NOT NULL
           AND thread_start_response_at IS NULL
           AND thread_start_late_response_guard_closed_at IS NULL
      `).run(closedAt, closedAt, connectionEpoch)
      const turnResult = this.db.prepare(`
        UPDATE codex_turn_bindings
           SET turn_start_late_response_guard_closed_at = ?,
               turn_start_late_response_guard_close_reason = 'connection_closed',
               revision = revision + 1, updated_at = ?
         WHERE turn_start_rpc_connection_epoch = ?
           AND turn_start_reconciled_at IS NOT NULL
           AND turn_start_response_at IS NULL
           AND turn_start_late_response_guard_closed_at IS NULL
      `).run(closedAt, closedAt, connectionEpoch)
      return changes(threadResult) + changes(turnResult)
    })
  }

  readRecoverySnapshot(connectionIsLive: (connectionEpoch: string) => boolean): CodexBindingRecoverySnapshot {
    const members: CodexBindingRecoveryMember[] = []
    const guards: CodexBindingRecoveryGuard[] = []
    const threads = this.db.prepare(`SELECT * FROM codex_thread_bindings`).all<ThreadBindingRow>()
    const turns = this.db.prepare(`SELECT * FROM codex_turn_bindings`).all<TurnBindingRow>()
    for (const row of threads) {
      if (row.thread_start_reservation_set_id === null) continue
      if (row.thread_start_reservation_released_at === null) {
        if (row.thread_start_reconciled_at || row.codex_thread_id) {
          throw new CodexBindingRepositoryError('released_member_invariant_broken')
        }
        members.push({
          reservationSetId: row.thread_start_reservation_set_id,
          reservationId: row.thread_start_reservation_member_id as string,
          scopeId: row.ready_scope_id,
          method: 'thread/start',
          requiredMemberCount: 2,
          state: row.thread_start_dispatch_intent_at === null
            ? 'held'
            : row.thread_start_rpc_connection_epoch
                && connectionIsLive(row.thread_start_rpc_connection_epoch)
              ? 'pending'
              : 'recovery_held',
          bindingId: row.thread_binding_id,
          connectionEpoch: row.thread_start_rpc_connection_epoch,
          rpcId: row.thread_start_rpc_id,
          crashSeam: row.thread_start_dispatch_intent_at === null
            ? 1
            : row.thread_start_child_write_confirmed_at === null ? 2 : 3,
        })
      } else if (
        row.thread_start_reconciled_at
        && row.thread_start_response_at === null
        && row.thread_start_late_response_guard_closed_at === null
      ) {
        guards.push({
          connectionEpoch: row.thread_start_rpc_connection_epoch as string,
          rpcId: row.thread_start_rpc_id as number,
          method: 'thread/start',
          bindingId: row.thread_binding_id,
          nativeId: row.codex_thread_id as string,
        })
      }
    }
    for (const row of turns) {
      if (row.turn_start_reservation_released_at === null) {
        if (row.turn_start_reconciled_at || row.codex_turn_id) {
          throw new CodexBindingRepositoryError('released_member_invariant_broken')
        }
        const thread = this.requireThread(row.thread_binding_id)
        members.push({
          reservationSetId: row.start_reservation_set_id,
          reservationId: row.turn_start_reservation_member_id,
          scopeId: thread.ready_scope_id,
          method: 'turn/start',
          requiredMemberCount: row.start_reservation_required_member_count as 1 | 2,
          state: row.turn_start_dispatch_intent_at === null
            ? 'held'
            : row.turn_start_rpc_connection_epoch
                && connectionIsLive(row.turn_start_rpc_connection_epoch)
              ? 'pending'
              : 'recovery_held',
          bindingId: row.ready_run_id,
          connectionEpoch: row.turn_start_rpc_connection_epoch,
          rpcId: row.turn_start_rpc_id,
          crashSeam: row.turn_start_dispatch_intent_at === null
            ? 4
            : row.turn_start_child_write_confirmed_at === null ? 5 : 6,
        })
      } else if (
        row.turn_start_reconciled_at
        && row.turn_start_response_at === null
        && row.turn_start_late_response_guard_closed_at === null
      ) {
        guards.push({
          connectionEpoch: row.turn_start_rpc_connection_epoch as string,
          rpcId: row.turn_start_rpc_id as number,
          method: 'turn/start',
          bindingId: row.ready_run_id,
          nativeId: row.codex_turn_id as string,
        })
      }
    }
    const hostFailureCloseouts = turns.flatMap((row): CodexHostFailureRecovery[] => (
      row.host_failure_kind
      && row.host_failure_evidence_digest
      && !row.host_failure_product_terminal_digest
        ? [{
            readyRunId: row.ready_run_id,
            reservationSetId: row.start_reservation_set_id,
            kind: row.host_failure_kind,
            evidenceDigest: row.host_failure_evidence_digest,
            continuationBlockedReason: hostFailureContinuationBlockedReason(row),
          }]
        : []
    ))
    const manualRows = this.db.prepare(`
      SELECT manual.manual_compaction_id, manual.thread_binding_id,
             manual.codex_thread_id, manual.codex_compaction_turn_id,
             manual.pre_dispatch_thread_read_digest, manual.pre_dispatch_turn_ids_json,
             manual.upstream_profile_snapshot_digest,
             manual.unknown_at, manual.unknown_reason,
             manual.consumed_at, manual.abandoned_at,
             thread.ready_conversation_alias, thread.alias_generation,
             manual.abandoned_reconciled_at, fence.owner_manual_compaction_id,
             fence.quarantined_at
        FROM codex_manual_compaction_bindings manual
        JOIN codex_thread_bindings thread
          ON thread.thread_binding_id = manual.thread_binding_id
        LEFT JOIN codex_thread_dispatch_fences fence
          ON fence.thread_binding_id = manual.thread_binding_id
         AND fence.owner_manual_compaction_id = manual.manual_compaction_id
    `).all<{
      manual_compaction_id: string
      thread_binding_id: string
      codex_thread_id: string
      codex_compaction_turn_id: string | null
      pre_dispatch_thread_read_digest: string | null
      pre_dispatch_turn_ids_json: string | null
      upstream_profile_snapshot_digest: string
      ready_conversation_alias: string
      alias_generation: number
      unknown_at: string | null
      unknown_reason: string | null
      consumed_at: string | null
      abandoned_at: string | null
      abandoned_reconciled_at: string | null
      owner_manual_compaction_id: string | null
      quarantined_at: string | null
    }>()
    const manualCompactions: CodexManualCompactionRecovery[] = []
    for (const row of manualRows) {
      if (row.consumed_at) {
        if (row.owner_manual_compaction_id) {
          throw new CodexBindingRepositoryError('consumed_manual_fence_invariant_broken')
        }
        continue
      }
      if (row.abandoned_at && row.abandoned_reconciled_at) {
        if (row.owner_manual_compaction_id) {
          throw new CodexBindingRepositoryError('reconciled_manual_fence_invariant_broken')
        }
        continue
      }
      if (row.abandoned_at && (!row.owner_manual_compaction_id || !row.quarantined_at)) {
        throw new CodexBindingRepositoryError('manual_quarantine_fence_invariant_broken')
      }
      if (!row.abandoned_at && (!row.owner_manual_compaction_id || row.quarantined_at)) {
        throw new CodexBindingRepositoryError('manual_pending_fence_invariant_broken')
      }
      if (!row.pre_dispatch_thread_read_digest || !row.pre_dispatch_turn_ids_json) {
        throw new CodexBindingRepositoryError('manual_pre_dispatch_evidence_missing')
      }
      const preDispatchTurnIds = parseStringArray(
        row.pre_dispatch_turn_ids_json,
        'manual_pre_dispatch_turn_ids_invalid',
      )
      const latestAttempt = this.db.prepare(`
        SELECT connection_epoch, rpc_id, child_write_attempted_at,
               child_write_confirmed_at, unresolved_reason, response_kind
          FROM codex_manual_compaction_dispatch_attempts
         WHERE manual_compaction_id = ?
         ORDER BY created_at DESC, rpc_id DESC LIMIT 1
      `).get<{
        connection_epoch: string
        rpc_id: number
        child_write_attempted_at: string | null
        child_write_confirmed_at: string | null
        unresolved_reason: string | null
        response_kind: 'accepted' | 'rejected' | null
      }>(row.manual_compaction_id)
      manualCompactions.push({
        manualCompactionId: row.manual_compaction_id,
        threadBindingId: row.thread_binding_id,
        codexThreadId: row.codex_thread_id,
        codexCompactionTurnId: row.codex_compaction_turn_id,
        preDispatchThreadReadDigest: row.pre_dispatch_thread_read_digest,
        preDispatchTurnIds,
        aliasId: row.ready_conversation_alias,
        aliasGeneration: row.alias_generation,
        upstreamProfileSnapshotDigest: row.upstream_profile_snapshot_digest,
        unknownAt: row.unknown_at,
        unknownReason: row.unknown_reason,
        latestAttempt: latestAttempt ? {
          connectionEpoch: latestAttempt.connection_epoch,
          rpcId: latestAttempt.rpc_id,
          childWriteAttemptedAt: latestAttempt.child_write_attempted_at,
          childWriteConfirmedAt: latestAttempt.child_write_confirmed_at,
          unresolvedReason: latestAttempt.unresolved_reason,
          responseKind: latestAttempt.response_kind,
        } : null,
        state: row.abandoned_at ? 'quarantined' : 'pending',
        fenceQuarantined: Boolean(row.quarantined_at),
      })
    }
    const productFences = this.db.prepare(`
      SELECT fence.thread_binding_id, fence.owner_ready_run_id, fence.owner_main_boot_id,
             fence.quarantined_at, fence.quarantine_reason
        FROM codex_thread_dispatch_fences fence
        JOIN codex_turn_bindings turn
          ON turn.ready_run_id = fence.owner_ready_run_id
         AND turn.thread_binding_id = fence.thread_binding_id
       WHERE fence.operation_kind = 'product_turn'
    `).all<{
      thread_binding_id: string
      owner_ready_run_id: string
      owner_main_boot_id: string
      quarantined_at: string | null
      quarantine_reason: string | null
    }>().map((row) => ({
      threadBindingId: row.thread_binding_id,
      readyRunId: row.owner_ready_run_id,
      ownerMainBootId: row.owner_main_boot_id,
      quarantinedAt: row.quarantined_at,
      quarantineReason: row.quarantine_reason,
    }))
    const productFenceCount = this.db.prepare(`
      SELECT COUNT(*) AS count FROM codex_thread_dispatch_fences
       WHERE operation_kind = 'product_turn'
    `).get<{ count: number }>()?.count || 0
    if (productFenceCount !== productFences.length) {
      throw new CodexBindingRepositoryError('product_fence_parent_invariant_broken')
    }
    return {
      members,
      lateResponseGuards: guards,
      hostFailureCloseouts,
      manualCompactions,
      productFences,
    }
  }

  claimProductFenceForBoot(input: {
    threadBindingId: string
    readyRunId: string
    expectedOwnerMainBootId: string
    newOwnerMainBootId: string
    claimedAt: string
  }): CodexProductFenceClaimRead {
    for (const value of [
      input.threadBindingId,
      input.readyRunId,
      input.expectedOwnerMainBootId,
      input.newOwnerMainBootId,
      input.claimedAt,
    ]) nonEmpty(value, 'product_fence_claim_identity_invalid')
    return this.immediate(() => {
      const fence = this.db.prepare(`
        SELECT owner_main_boot_id, revision, quarantined_at
          FROM codex_thread_dispatch_fences
         WHERE thread_binding_id = ? AND operation_kind = 'product_turn'
           AND owner_ready_run_id = ? LIMIT 1
      `).get<{
        owner_main_boot_id: string
        revision: number
        quarantined_at: string | null
      }>(input.threadBindingId, input.readyRunId)
      if (!fence || fence.quarantined_at) {
        throw new CodexBindingRepositoryError('product_fence_claim_missing')
      }
      if (fence.owner_main_boot_id !== input.expectedOwnerMainBootId) {
        throw new CodexBindingRepositoryError('product_fence_claim_owner_mismatch')
      }
      if (fence.owner_main_boot_id === input.newOwnerMainBootId) {
        return {
          readyRunId: input.readyRunId,
          previousOwnerMainBootId: fence.owner_main_boot_id,
          ownerMainBootId: fence.owner_main_boot_id,
          revision: fence.revision,
          transferred: false,
          evidenceDigest: null,
        }
      }
      const lease = this.db.prepare(`
        SELECT * FROM codex_sidecar_process_leases
         WHERE owner_main_boot_id = ?
           AND owner_main_dead_at IS NOT NULL
           AND owner_main_death_evidence_digest IS NOT NULL
           AND tree_zero_at IS NOT NULL
           AND tree_zero_evidence_digest IS NOT NULL
         ORDER BY tree_zero_at DESC LIMIT 1
      `).get<ProcessLeaseDbRow>(fence.owner_main_boot_id)
      if (!lease) throw new CodexBindingRepositoryError('product_fence_old_owner_unproven')
      const newLease = this.db.prepare(`
        SELECT * FROM codex_sidecar_process_leases
         WHERE owner_main_boot_id = ?
           AND connection_opened_at IS NOT NULL
           AND tree_zero_at IS NULL
         ORDER BY connection_opened_at DESC LIMIT 1
      `).get<ProcessLeaseDbRow>(input.newOwnerMainBootId)
      if (!newLease) throw new CodexBindingRepositoryError('product_fence_new_owner_unproven')
      const previousRevision = fence.revision
      const nextRevision = previousRevision + 1
      const evidenceDigest = digestCanonicalJson({
        threadBindingId: input.threadBindingId,
        readyRunId: input.readyRunId,
        previousOwnerMainBootId: fence.owner_main_boot_id,
        newOwnerMainBootId: input.newOwnerMainBootId,
        previousRevision,
        nextRevision,
        processLeaseId: lease.process_lease_id,
        ownerMainDeadAt: lease.owner_main_dead_at,
        ownerMainDeathEvidenceDigest: lease.owner_main_death_evidence_digest,
        treeZeroAt: lease.tree_zero_at,
        treeZeroEvidenceDigest: lease.tree_zero_evidence_digest,
        newProcessLeaseId: newLease.process_lease_id,
      })
      this.db.prepare(`
        INSERT INTO codex_fence_owner_transfers (
          transfer_id, thread_binding_id, operation_kind, owner_ready_run_id,
          owner_manual_compaction_id, previous_owner_main_boot_id,
          new_owner_main_boot_id, previous_fence_revision, new_fence_revision,
          process_lease_id, new_process_lease_id, evidence_digest, transferred_at
        ) VALUES (?, ?, 'product_turn', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `fence-transfer-${evidenceDigest}`,
        input.threadBindingId,
        input.readyRunId,
        fence.owner_main_boot_id,
        input.newOwnerMainBootId,
        previousRevision,
        nextRevision,
        lease.process_lease_id,
        newLease.process_lease_id,
        evidenceDigest,
        input.claimedAt,
      )
      const claimed = this.db.prepare(`
        UPDATE codex_thread_dispatch_fences
           SET owner_main_boot_id = ?, revision = ?
         WHERE thread_binding_id = ? AND operation_kind = 'product_turn'
           AND owner_ready_run_id = ? AND owner_main_boot_id = ?
           AND revision = ? AND quarantined_at IS NULL
      `).run(
        input.newOwnerMainBootId,
        nextRevision,
        input.threadBindingId,
        input.readyRunId,
        fence.owner_main_boot_id,
        previousRevision,
      )
      if (changes(claimed) !== 1) {
        throw new CodexBindingRepositoryError('product_fence_claim_cas_failed')
      }
      return {
        readyRunId: input.readyRunId,
        previousOwnerMainBootId: fence.owner_main_boot_id,
        ownerMainBootId: input.newOwnerMainBootId,
        revision: nextRevision,
        transferred: true,
        evidenceDigest,
      }
    })
  }

  readProductRunForThreadBinding(threadBindingId: string): string {
    const row = this.db.prepare(`
      SELECT ready_run_id FROM codex_turn_bindings
       WHERE thread_binding_id = ? AND host_failure_product_terminal_digest IS NULL
       ORDER BY created_at ASC LIMIT 1
    `).get<{ ready_run_id: string }>(threadBindingId)
    if (!row) throw new CodexBindingRepositoryError('thread_product_run_not_found')
    return row.ready_run_id
  }

  readStartInboundIdentity(
    method: StartMethod,
    bindingId: string,
  ):
    | { method: 'thread/start'; expectedCwd: string }
    | { method: 'turn/start'; threadId: string; clientUserMessageId: string } {
    if (method === 'thread/start') {
      const row = this.requireThread(bindingId)
      if (!row.isolated_thread_cwd || !row.thread_start_reservation_set_id) {
        throw new CodexBindingRepositoryError('thread_start_not_admitted')
      }
      return { method, expectedCwd: row.isolated_thread_cwd }
    }
    const row = this.requireTurn(bindingId)
    if (!row.codex_thread_id) throw new CodexBindingRepositoryError('turn_thread_identity_missing')
    return {
      method,
      threadId: row.codex_thread_id,
      clientUserMessageId: row.turn_request_id,
    }
  }

  quarantineStartInbound(input: {
    method: StartMethod
    bindingId: string
    reason: string
    quarantinedAt: string
  }): void {
    nonEmpty(input.bindingId, 'start_inbound_binding_invalid')
    nonEmpty(input.reason, 'start_inbound_unknown_reason_invalid')
    nonEmpty(input.quarantinedAt, 'start_inbound_unknown_time_invalid')
    this.immediate(() => {
      const readyRunId = input.method === 'turn/start'
        ? input.bindingId
        : this.readProductRunForThreadBinding(input.bindingId)
      const turn = this.requireTurn(readyRunId)
      const descriptor = this.startDescriptor(input.method)
      const start = this.requireStartRow(input.method, input.bindingId)
      if (start[descriptor.intent] === null) {
        throw new CodexBindingRepositoryError('start_inbound_not_dispatched')
      }
      const fence = this.db.prepare(`
        SELECT owner_ready_run_id, quarantined_at, quarantine_reason, revision
          FROM codex_thread_dispatch_fences
         WHERE thread_binding_id = ? AND operation_kind = 'product_turn'
      `).get<{
        owner_ready_run_id: string | null
        quarantined_at: string | null
        quarantine_reason: string | null
        revision: number
      }>(turn.thread_binding_id)
      if (!fence || fence.owner_ready_run_id !== readyRunId) {
        throw new CodexBindingRepositoryError('start_inbound_fence_missing')
      }
      if (fence.quarantined_at) {
        if (fence.quarantine_reason !== input.reason) {
          throw new CodexBindingRepositoryError('start_inbound_quarantine_conflict')
        }
        return
      }
      const updated = this.db.prepare(`
        UPDATE codex_thread_dispatch_fences
           SET quarantined_at = ?, quarantine_reason = ?, revision = revision + 1
         WHERE thread_binding_id = ? AND revision = ? AND quarantined_at IS NULL
      `).run(
        input.quarantinedAt,
        input.reason,
        turn.thread_binding_id,
        fence.revision,
      )
      if (changes(updated) !== 1) {
        throw new CodexBindingRepositoryError('start_inbound_quarantine_cas_failed')
      }
    })
  }

  assertThreadArchiveEligible(threadId: string): void {
    nonEmpty(threadId, 'archive_thread_identity_invalid')
    const thread = this.db.prepare(`
      SELECT thread_binding_id, retired_at, retired_reason, retirement_evidence_digest,
             thread_start_reservation_released_at
        FROM codex_thread_bindings WHERE codex_thread_id = ? LIMIT 1
    `).get<{
      thread_binding_id: string
      retired_at: string | null
      retired_reason: string | null
      retirement_evidence_digest: string | null
      thread_start_reservation_released_at: string | null
    }>(threadId)
    if (!thread || !thread.retired_at) {
      throw new CodexBindingRepositoryError('thread_archive_not_retired')
    }
    const cleanupIntent = thread.retired_reason === 'cleanup'
      && thread.retirement_evidence_digest !== null
      && Boolean(this.db.prepare(`
        SELECT 1 FROM codex_thread_archive_intents
         WHERE thread_binding_id = ? AND codex_thread_id = ?
           AND source_kind = 'retired_backfill' AND retired_reason = 'cleanup'
           AND ready_run_id IS NULL AND state = 'pending'
           AND retirement_evidence_digest = ?
         LIMIT 1
      `).get(thread.thread_binding_id, threadId, thread.retirement_evidence_digest))
    if (!thread.thread_start_reservation_released_at && !cleanupIntent) {
      throw new CodexBindingRepositoryError('thread_archive_not_retired')
    }
    const fence = this.db.prepare(`
      SELECT thread_binding_id FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? LIMIT 1
    `).get(thread.thread_binding_id)
    if (fence && !cleanupIntent) throw new CodexBindingRepositoryError('thread_archive_fence_active')
    const unresolved = this.db.prepare(`
      SELECT ready_run_id FROM codex_turn_bindings
       WHERE thread_binding_id = ?
         AND (
           turn_start_reservation_released_at IS NULL
           OR (product_terminal_digest IS NULL AND host_failure_product_terminal_digest IS NULL)
         )
       LIMIT 1
    `).get(thread.thread_binding_id)
    if (unresolved && !cleanupIntent) throw new CodexBindingRepositoryError('thread_archive_turn_unresolved')
    const unresolvedCall = this.db.prepare(`
      SELECT call_row.codex_call_id
        FROM codex_tool_call_bindings call_row
        JOIN codex_turn_bindings turn_row ON turn_row.ready_run_id = call_row.ready_run_id
       WHERE turn_row.thread_binding_id = ?
         AND (call_row.receipt_id IS NULL OR call_row.result_digest IS NULL)
       LIMIT 1
    `).get(thread.thread_binding_id)
    if (unresolvedCall && !cleanupIntent) throw new CodexBindingRepositoryError('thread_archive_call_unresolved')
    const descendant = this.db.prepare(`
      SELECT thread_binding_id FROM codex_thread_bindings
       WHERE codex_parent_thread_id = ? OR codex_forked_from_id = ? LIMIT 1
    `).get(threadId, threadId)
    if (descendant) throw new CodexBindingRepositoryError('thread_archive_descendant_exists')
  }

  recordHostFailureEvidence(input: {
    readyRunId: string
    kind:
      | 'sidecar_spawn_failed'
      | 'thread_start_rpc_rejected'
      | 'thread_start_delivery_proven_absent'
      | 'turn_start_rpc_rejected'
      | 'turn_start_delivery_proven_absent'
    evidenceDigest: string
    recordedAt: string
  }): void {
    this.immediate(() => {
      const row = this.requireTurn(input.readyRunId)
      if (row.host_failure_kind) {
        if (
          row.host_failure_kind !== input.kind
          || row.host_failure_evidence_digest !== input.evidenceDigest
        ) throw new CodexBindingRepositoryError('host_failure_evidence_immutable')
        return
      }
      const result = this.db.prepare(`
        UPDATE codex_turn_bindings
           SET host_failure_kind = ?, host_failure_recorded_at = ?,
               host_failure_evidence_digest = ?, revision = revision + 1, updated_at = ?
         WHERE ready_run_id = ? AND revision = ? AND host_failure_kind IS NULL
      `).run(
        input.kind,
        input.recordedAt,
        input.evidenceDigest,
        input.recordedAt,
        input.readyRunId,
        row.revision,
      )
      if (changes(result) !== 1) throw new CodexBindingRepositoryError('host_failure_evidence_cas_failed')
    })
  }

  completeHostFailureCloseout(input: {
    readyRunId: string
    productTerminalDigest: string
    continuationBlockedReason: 'start_delivery_absent' | 'publication_diverged'
    closeoutAt: string
  }): { reservationSetId: string } {
    nonEmpty(input.productTerminalDigest, 'product_terminal_digest_invalid')
    nonEmpty(input.closeoutAt, 'product_closeout_at_invalid')
    return this.immediate(() => this.completeHostFailureCloseoutInOpenTransaction(input))
  }

  completeProductTurnCloseout(input: {
    readyRunId: string
    productTerminalDigest: string
    closeoutAt: string
  }): void {
    nonEmpty(input.productTerminalDigest, 'product_terminal_digest_invalid')
    nonEmpty(input.closeoutAt, 'product_closeout_at_invalid')
    this.immediate(() => {
      const turn = this.requireTurn(input.readyRunId)
      const terminal = this.db.prepare(`
        SELECT status FROM task_projections
         WHERE task_id = ? AND run_id = ? AND status IN ('completed', 'failed', 'killed')
         LIMIT 1
      `).get<{ status: string }>(turn.ready_task_id, input.readyRunId)
      if (!terminal) throw new CodexBindingRepositoryError('product_terminal_not_committed')
      this.completeProductTurnCloseoutInOpenTransaction(input, turn)
    })
  }

  completeCanonicalProductCloseoutInOpenTransaction(input: {
    readyRunId: string
    productTerminalDigest: string
    closeoutAt: string
  }): { handled: boolean; reservationSetId: string | null } {
    nonEmpty(input.readyRunId, 'ready_run_id_invalid')
    nonEmpty(input.productTerminalDigest, 'product_terminal_digest_invalid')
    nonEmpty(input.closeoutAt, 'product_closeout_at_invalid')
    if (this.db.inTransaction !== true) {
      throw new CodexBindingRepositoryError('canonical_closeout_transaction_missing')
    }
    const turn = this.db.prepare(`
      SELECT * FROM codex_turn_bindings WHERE ready_run_id = ?
    `).get<TurnBindingRow>(input.readyRunId)
    if (!turn) return { handled: false, reservationSetId: null }
    if (turn.host_failure_kind) {
      const completed = this.completeHostFailureCloseoutInOpenTransaction({
        ...input,
        continuationBlockedReason: hostFailureContinuationBlockedReason(turn),
      })
      return { handled: true, reservationSetId: completed.reservationSetId }
    }
    this.completeProductTurnCloseoutInOpenTransaction(input, turn)
    return { handled: true, reservationSetId: turn.start_reservation_set_id }
  }

  completeVerifierAcceptedCloseoutInOpenTransaction(input: {
    readyRunId: string
    productTerminalDigest: string
    closeoutAt: string
  }): { handled: boolean; reservationSetId: string | null } {
    nonEmpty(input.readyRunId, 'ready_run_id_invalid')
    nonEmpty(input.productTerminalDigest, 'product_terminal_digest_invalid')
    nonEmpty(input.closeoutAt, 'product_closeout_at_invalid')
    if (this.db.inTransaction !== true) {
      throw new CodexBindingRepositoryError('canonical_closeout_transaction_missing')
    }
    const turn = this.db.prepare(`
      SELECT * FROM codex_turn_bindings WHERE ready_run_id = ? LIMIT 1
    `).get<TurnBindingRow>(input.readyRunId)
    if (!turn) return { handled: false, reservationSetId: null }
    if (
      turn.host_failure_kind
      || turn.host_failure_product_terminal_digest
      || turn.recovery_failure_code
    ) throw new CodexBindingRepositoryError('product_closeout_kind_conflict')
    if (turn.lifecycle_action
      || turn.interrupt_requested_at || turn.interrupt_ack_at || turn.interrupt_state_unknown_at) {
      throw new CodexBindingRepositoryError('browser_verifier_accept_interrupted')
    }
    const thread = this.requireThread(turn.thread_binding_id)
    const attemptRow = this.db.prepare(`
      SELECT * FROM codex_browser_verifier_attempts WHERE ready_run_id = ? LIMIT 1
    `).get<CodexBrowserVerifierAttemptRow>(input.readyRunId)
    if (!attemptRow) throw new CodexBindingRepositoryError('browser_verifier_receipt_missing')
    const attempt = browserVerifierAttemptFromRow(attemptRow)
    if (
      attempt.status !== 'settled'
      || attempt.outcome !== 'accept'
      || attempt.verdict?.verdict !== 'accept'
      || !attempt.receiptDigest
      || !attempt.sealedCandidateDigest
      || !attempt.verifiedAt
      || attempt.readyRunId !== input.readyRunId
      || attempt.readyTaskId !== turn.ready_task_id
      || attempt.readyScopeId !== thread.ready_scope_id
      || attempt.readyAliasId !== thread.ready_conversation_alias
      || attempt.aliasGeneration !== thread.alias_generation
      || attempt.threadBindingId !== turn.thread_binding_id
      || attempt.codexThreadId !== turn.codex_thread_id
      || attempt.codexTurnId !== turn.codex_turn_id
      || attempt.upstreamProfileSnapshotRef !== turn.effective_upstream_snapshot_ref
      || attempt.upstreamProfileSnapshotDigest !== turn.effective_upstream_snapshot_digest
    ) throw new CodexBindingRepositoryError('browser_verifier_receipt_identity_mismatch')
    let candidate: NativeTerminalCandidate
    try {
      candidate = JSON.parse(turn.engine_terminal_candidate_json || '') as NativeTerminalCandidate
      assertNativeTerminalCandidate(candidate)
    } catch {
      throw new CodexBindingRepositoryError('browser_verifier_closeout_candidate_invalid')
    }
    if (
      turn.engine_terminal_status !== 'completed'
      || candidate.candidateSelection.kind !== 'accepted'
      || candidate.candidateDigest !== attempt.candidateDigest
    ) throw new CodexBindingRepositoryError('browser_verifier_closeout_candidate_mismatch')
    const terminalMessage = this.db.prepare(`
      SELECT id, conversation_id, role, content, timestamp, meta_json
        FROM chat_messages WHERE id = ? LIMIT 1
    `).get<{
      id: string
      conversation_id: string
      role: string
      content: string
      timestamp: string
      meta_json: string | null
    }>(`assistant:${turn.ready_task_id}:${input.readyRunId}:terminal`)
    if (
      !terminalMessage
      || terminalMessage.role !== 'assistant'
      || terminalMessage.conversation_id !== thread.ready_scope_id
      || terminalMessage.content !== candidate.candidateText
      || terminalMessage.timestamp !== input.closeoutAt
    ) throw new CodexBindingRepositoryError('browser_verifier_canonical_message_mismatch')
    const meta = parseObjectStrict<Record<string, unknown>>(
      terminalMessage.meta_json || '{}',
      'browser_verifier_canonical_message_meta_invalid',
    )
    const receipt = isRecord(meta.completionVerifierReceipt)
      ? meta.completionVerifierReceipt
      : null
    if (
      !receipt
      || receipt.version !== 1
      || receipt.verdict !== 'accept'
      || receipt.parentTaskId !== turn.ready_task_id
      || receipt.ownerRunId !== input.readyRunId
      || receipt.candidateDigest !== workflowDigest(candidate.candidateText)
      || receipt.workflowCloseoutSealDigest !== attempt.workflowCloseoutSealDigest
      || receipt.sealedCandidateDigest !== attempt.sealedCandidateDigest
      || receipt.durableVerifierReceiptDigest !== attempt.receiptDigest
      || receipt.verifiedAt !== attempt.verifiedAt
      || typeof receipt.terminalQualityPatchDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(receipt.terminalQualityPatchDigest)
    ) throw new CodexBindingRepositoryError('browser_verifier_canonical_receipt_mismatch')
    const canonicalMessage = {
      id: terminalMessage.id,
      conversationId: terminalMessage.conversation_id,
      role: 'assistant',
      content: terminalMessage.content,
      timestamp: terminalMessage.timestamp,
      meta,
    }
    if (workflowDigest(canonicalMessage) !== input.productTerminalDigest) {
      throw new CodexBindingRepositoryError('browser_verifier_canonical_digest_mismatch')
    }
    this.completeProductTurnCloseoutInOpenTransaction(input, turn)
    return { handled: true, reservationSetId: turn.start_reservation_set_id }
  }

  completeVerifierRejectedCloseoutInOpenTransaction(input: {
    readyRunId: string
    productTerminalDigest: string
    closeoutAt: string
  }): { handled: boolean; reservationSetId: string | null } {
    nonEmpty(input.readyRunId, 'ready_run_id_invalid')
    nonEmpty(input.productTerminalDigest, 'product_terminal_digest_invalid')
    nonEmpty(input.closeoutAt, 'product_closeout_at_invalid')
    if (this.db.inTransaction !== true) {
      throw new CodexBindingRepositoryError('canonical_closeout_transaction_missing')
    }
    const turn = this.db.prepare(`
      SELECT * FROM codex_turn_bindings WHERE ready_run_id = ? LIMIT 1
    `).get<TurnBindingRow>(input.readyRunId)
    if (!turn) return { handled: false, reservationSetId: null }
    if (turn.host_failure_kind || turn.host_failure_product_terminal_digest
      || turn.recovery_failure_code) {
      throw new CodexBindingRepositoryError('product_closeout_kind_conflict')
    }
    if (turn.lifecycle_action
      || turn.interrupt_requested_at || turn.interrupt_ack_at || turn.interrupt_state_unknown_at) {
      throw new CodexBindingRepositoryError('browser_verifier_rejection_interrupted')
    }
    const thread = this.requireThread(turn.thread_binding_id)
    const attemptRow = this.db.prepare(`
      SELECT * FROM codex_browser_verifier_attempts WHERE ready_run_id = ? LIMIT 1
    `).get<CodexBrowserVerifierAttemptRow>(input.readyRunId)
    if (!attemptRow) throw new CodexBindingRepositoryError('browser_verifier_receipt_missing')
    const attempt = browserVerifierAttemptFromRow(attemptRow)
    if (
      attempt.status !== 'settled'
      || attempt.outcome === 'accept'
      || !attempt.receiptDigest
      || attempt.readyTaskId !== turn.ready_task_id
      || attempt.readyScopeId !== thread.ready_scope_id
      || attempt.readyAliasId !== thread.ready_conversation_alias
      || attempt.aliasGeneration !== thread.alias_generation
      || attempt.threadBindingId !== turn.thread_binding_id
      || attempt.codexThreadId !== turn.codex_thread_id
      || attempt.codexTurnId !== turn.codex_turn_id
      || attempt.upstreamProfileSnapshotRef !== turn.effective_upstream_snapshot_ref
      || attempt.upstreamProfileSnapshotDigest !== turn.effective_upstream_snapshot_digest
    ) throw new CodexBindingRepositoryError('browser_verifier_receipt_identity_mismatch')
    let candidate: NativeTerminalCandidate
    try {
      candidate = JSON.parse(turn.engine_terminal_candidate_json || '') as NativeTerminalCandidate
      assertNativeTerminalCandidate(candidate)
    } catch {
      throw new CodexBindingRepositoryError('browser_verifier_closeout_candidate_invalid')
    }
    if (
      turn.engine_terminal_status !== 'completed'
      || candidate.candidateSelection.kind !== 'accepted'
      || candidate.candidateDigest !== attempt.candidateDigest
      || !turn.publication_receipt_digest
      || !turn.publication_recorded_at
    ) throw new CodexBindingRepositoryError('browser_verifier_closeout_candidate_mismatch')
    const parent = this.db.prepare(`
      SELECT status, interaction_state, continuation_ref_json, resumable_actions_json
        FROM task_projections WHERE task_id = ? AND run_id = ? LIMIT 1
    `).get<{
      status: string
      interaction_state: string
      continuation_ref_json: string | null
      resumable_actions_json: string
    }>(turn.ready_task_id, input.readyRunId)
    const run = this.db.prepare(`
      SELECT status, terminal_reason, initiator, continuation_ref_json,
             provider_diagnostics_json, updated_at
        FROM run_meta WHERE run_id = ? AND task_id = ? LIMIT 1
    `).get<{
      status: string
      terminal_reason: string | null
      initiator: string | null
      continuation_ref_json: string | null
      provider_diagnostics_json: string | null
      updated_at: number
    }>(input.readyRunId, turn.ready_task_id)
    const diagnostics = parseObjectStrict<Record<string, unknown>>(
      run?.provider_diagnostics_json || '{}',
      'browser_verifier_closeout_provider_diagnostics_json',
    )
    const failure = isRecord(diagnostics.codexFailure) ? diagnostics.codexFailure : null
    const expectedTerminalReason = attempt.outcome === 'identity_drift'
      ? 'persistence_failed'
      : attempt.outcome === 'provider_unavailable'
        || attempt.outcome === 'result_unknown'
        || attempt.outcome === 'invalid'
        ? 'blocked_external'
        : 'proof_gap'
    if (
      parent?.status !== 'failed'
      || parent.interaction_state !== 'suspended'
      || parent.continuation_ref_json !== null
      || canonicalJson(JSON.parse(parent.resumable_actions_json)) !== canonicalJson(['none'])
      || run?.status !== 'error'
      || run.terminal_reason !== expectedTerminalReason
      || run.initiator !== 'codex_browser_verifier'
      || run.continuation_ref_json !== null
      || new Date(run.updated_at).toISOString() !== input.closeoutAt
      || failure?.verifierReceiptDigest !== attempt.receiptDigest
    ) throw new CodexBindingRepositoryError('browser_verifier_failure_closeout_mismatch')
    const terminalMessage = this.db.prepare(`
      SELECT id FROM chat_messages WHERE id = ? LIMIT 1
    `).get<{ id: string }>(`assistant:${turn.ready_task_id}:${input.readyRunId}:terminal`)
    if (!terminalMessage) throw new CodexBindingRepositoryError('browser_verifier_terminal_message_missing')
    const child = this.db.prepare(`
      SELECT status FROM browser_tasks
       WHERE parent_task_id = ? AND kind = 'browser_workflow' LIMIT 1
    `).get<{ status: string }>(turn.ready_task_id)
    if (child && !['completed', 'failed', 'cancelled'].includes(child.status)) {
      throw new CodexBindingRepositoryError('browser_verifier_browser_child_not_terminal')
    }
    if (thread.continuation_blocked_at || thread.retired_at) {
      if (
        thread.continuation_blocked_at !== input.closeoutAt
        || thread.continuation_blocked_reason !== 'publication_diverged'
        || thread.continuation_blocked_evidence_digest !== attempt.receiptDigest
        || thread.retired_at !== input.closeoutAt
        || thread.retired_reason !== 'publication_diverged'
        || thread.retirement_evidence_digest !== attempt.receiptDigest
      ) throw new CodexBindingRepositoryError('browser_verifier_thread_retirement_mismatch')
    } else {
      const retired = this.db.prepare(`
        UPDATE codex_thread_bindings
           SET continuation_blocked_at = ?,
               continuation_blocked_reason = 'publication_diverged',
               continuation_blocked_evidence_digest = ?,
               retired_at = ?, retired_reason = 'publication_diverged',
               retirement_evidence_digest = ?, revision = revision + 1, updated_at = ?
         WHERE thread_binding_id = ? AND revision = ?
           AND continuation_blocked_at IS NULL AND retired_at IS NULL
      `).run(
        input.closeoutAt,
        attempt.receiptDigest,
        input.closeoutAt,
        attempt.receiptDigest,
        input.closeoutAt,
        thread.thread_binding_id,
        thread.revision,
      )
      if (changes(retired) !== 1) {
        throw new CodexBindingRepositoryError('browser_verifier_thread_retirement_cas_failed')
      }
    }
    if (turn.product_terminal_digest) {
      if (
        turn.product_terminal_digest !== input.productTerminalDigest
        || turn.product_closeout_at !== input.closeoutAt
        || turn.fence_release_revision === null
      ) throw new CodexBindingRepositoryError('product_terminal_immutable')
      this.assertProductFenceReleased(turn.thread_binding_id, input.readyRunId)
      return { handled: true, reservationSetId: turn.start_reservation_set_id }
    }
    const fence = this.requireProductFenceForRelease(turn.thread_binding_id, input.readyRunId)
    const fenceReleaseRevision = fence.revision + 1
    const turnUpdate = this.db.prepare(`
      UPDATE codex_turn_bindings
         SET product_terminal_digest = ?, product_closeout_at = ?,
             fence_release_revision = ?, revision = revision + 1, updated_at = ?
       WHERE ready_run_id = ? AND revision = ? AND product_terminal_digest IS NULL
    `).run(
      input.productTerminalDigest,
      input.closeoutAt,
      fenceReleaseRevision,
      input.closeoutAt,
      input.readyRunId,
      turn.revision,
    )
    if (changes(turnUpdate) !== 1) throw new CodexBindingRepositoryError('product_terminal_cas_failed')
    const fenceDelete = this.db.prepare(`
      DELETE FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND owner_ready_run_id = ? AND revision = ?
    `).run(turn.thread_binding_id, input.readyRunId, fence.revision)
    if (changes(fenceDelete) !== 1) throw new CodexBindingRepositoryError('product_fence_release_failed')
    this.assertThreadArchiveEligible(turn.codex_thread_id as string)
    const retirementTransactionDigest = digest({
      contract: 'codex_browser_verifier_retirement_v1',
      readyRunId: input.readyRunId,
      threadBindingId: thread.thread_binding_id,
      verifierReceiptDigest: attempt.receiptDigest,
      productTerminalDigest: input.productTerminalDigest,
      closeoutAt: input.closeoutAt,
    })
    this.recordThreadArchiveIntentInOpenTransaction({
      thread,
      sourceKind: 'browser_verifier_nonaccept',
      retiredReason: 'publication_diverged',
      readyRunId: input.readyRunId,
      retirementEvidenceDigest: attempt.receiptDigest,
      retirementTransactionDigest,
      retiredAt: input.closeoutAt,
    })
    return { handled: true, reservationSetId: turn.start_reservation_set_id }
  }

  completeLifecycleActionCloseoutInOpenTransaction(input: {
    action: CodexLifecycleAction
    readyRunId: string
    productTerminalDigest: string
    closeoutAt: string
  }): { handled: boolean; reservationSetId: string | null } {
    nonEmpty(input.readyRunId, 'ready_run_id_invalid')
    nonEmpty(input.productTerminalDigest, 'product_terminal_digest_invalid')
    nonEmpty(input.closeoutAt, 'product_closeout_at_invalid')
    if (this.db.inTransaction !== true) {
      throw new CodexBindingRepositoryError('canonical_closeout_transaction_missing')
    }
    const turn = this.db.prepare(`
      SELECT * FROM codex_turn_bindings WHERE ready_run_id = ? LIMIT 1
    `).get<TurnBindingRow>(input.readyRunId)
    if (!turn) return { handled: false, reservationSetId: null }
    const thread = this.requireThread(turn.thread_binding_id)
    const lifecycle = this.readProductLifecycleAction(input.readyRunId)
    if (!lifecycle || lifecycle.lifecycleAction !== input.action
      || lifecycle.readyTaskId !== turn.ready_task_id
      || lifecycle.readyScopeId !== thread.ready_scope_id
      || lifecycle.readyAliasId !== thread.ready_conversation_alias
      || !turn.codex_thread_id || !turn.codex_turn_id
      || !turn.engine_terminal_recorded_at || !turn.engine_terminal_candidate_json
      || !turn.engine_terminal_candidate_digest || !turn.engine_terminal_status
      || turn.host_failure_kind || turn.host_failure_product_terminal_digest
      || turn.recovery_failure_code) {
      throw new CodexBindingRepositoryError('lifecycle_action_closeout_identity_mismatch')
    }
    let candidate: NativeTerminalCandidate
    try {
      candidate = JSON.parse(turn.engine_terminal_candidate_json) as NativeTerminalCandidate
      assertNativeTerminalCandidate(candidate)
    } catch {
      throw new CodexBindingRepositoryError('lifecycle_action_closeout_candidate_invalid')
    }
    if (candidate.readyRunId !== turn.ready_run_id
      || candidate.readyTaskId !== turn.ready_task_id
      || candidate.scopeId !== thread.ready_scope_id
      || candidate.codexThreadId !== turn.codex_thread_id
      || candidate.codexTurnId !== turn.codex_turn_id
      || candidate.engineOutcome !== turn.engine_terminal_status) {
      throw new CodexBindingRepositoryError('lifecycle_action_closeout_candidate_mismatch')
    }
    const effectSettlement = this.readToolPublicationBarrier({
      readyRunId: turn.ready_run_id,
      codexThreadId: turn.codex_thread_id,
      codexTurnId: turn.codex_turn_id,
      candidateCalls: candidate.usedToolCalls,
      effectSettlementOnly: true,
    })
    if (effectSettlement.kind !== 'accepted' && effectSettlement.kind !== 'diverged') {
      throw new CodexBindingRepositoryError(
        `codex_tool_publication_${effectSettlement.kind}:${effectSettlement.code}`,
      )
    }
    const projection = this.db.prepare(`
      SELECT status, interaction_state, continuation_ref_json, resumable_actions_json
        FROM task_projections WHERE task_id = ? AND run_id = ? LIMIT 1
    `).get<{
      status: string
      interaction_state: string
      continuation_ref_json: string | null
      resumable_actions_json: string
    }>(turn.ready_task_id, turn.ready_run_id)
    const run = this.db.prepare(`
      SELECT status, terminal_reason, initiator, continuation_ref_json, updated_at
        FROM run_meta WHERE run_id = ? AND task_id = ? LIMIT 1
    `).get<{
      status: string
      terminal_reason: string | null
      initiator: string | null
      continuation_ref_json: string | null
      updated_at: number
    }>(turn.ready_run_id, turn.ready_task_id)
    if (!projection || projection.status !== 'killed'
      || projection.interaction_state !== 'suspended'
      || projection.continuation_ref_json !== null
      || canonicalJson(JSON.parse(projection.resumable_actions_json)) !== canonicalJson(['none'])
      || !run || run.status !== 'interrupted'
      || run.terminal_reason !== 'cancelled_user'
      || run.initiator !== `user_${input.action}`
      || run.continuation_ref_json !== null
      || new Date(run.updated_at).toISOString() !== input.closeoutAt) {
      throw new CodexBindingRepositoryError('lifecycle_action_core_closeout_mismatch')
    }
    const terminalMessage = this.db.prepare(`
      SELECT id FROM chat_messages WHERE id = ? LIMIT 1
    `).get<{ id: string }>(`assistant:${turn.ready_task_id}:${turn.ready_run_id}:terminal`)
    if (!terminalMessage) throw new CodexBindingRepositoryError('lifecycle_action_terminal_message_missing')
    const child = this.db.prepare(`
      SELECT status FROM browser_tasks
       WHERE parent_task_id = ? AND kind = 'browser_workflow' LIMIT 1
    `).get<{ status: string }>(turn.ready_task_id)
    if (child && child.status !== 'cancelled') {
      throw new CodexBindingRepositoryError('lifecycle_action_browser_child_not_cancelled')
    }
    const verifier = this.db.prepare(`
      SELECT ready_task_id, ready_scope_id, ready_alias_id, alias_generation,
             thread_binding_id, codex_thread_id, codex_turn_id, candidate_digest
        FROM codex_browser_verifier_attempts WHERE ready_run_id = ? LIMIT 1
    `).get<{
      ready_task_id: string
      ready_scope_id: string
      ready_alias_id: string
      alias_generation: number
      thread_binding_id: string
      codex_thread_id: string
      codex_turn_id: string
      candidate_digest: string
    }>(turn.ready_run_id)
    if (verifier && (verifier.ready_task_id !== turn.ready_task_id
      || verifier.ready_scope_id !== thread.ready_scope_id
      || verifier.ready_alias_id !== thread.ready_conversation_alias
      || verifier.alias_generation !== thread.alias_generation
      || verifier.thread_binding_id !== thread.thread_binding_id
      || verifier.codex_thread_id !== turn.codex_thread_id
      || verifier.codex_turn_id !== turn.codex_turn_id
      || (candidate.candidateSelection.kind === 'accepted'
        && verifier.candidate_digest !== candidate.candidateDigest))) {
      throw new CodexBindingRepositoryError('lifecycle_action_verifier_identity_mismatch')
    }
    if (turn.product_terminal_digest) {
      if (turn.product_terminal_digest !== input.productTerminalDigest
        || turn.product_closeout_at !== input.closeoutAt
        || turn.fence_release_revision === null) {
        throw new CodexBindingRepositoryError('lifecycle_action_terminal_immutable')
      }
      this.readLifecycleActionCloseout(input.readyRunId)
      this.assertProductFenceReleased(turn.thread_binding_id, input.readyRunId)
      return { handled: true, reservationSetId: turn.start_reservation_set_id }
    }
    if (thread.retired_at || thread.retirement_evidence_digest) {
      throw new CodexBindingRepositoryError('lifecycle_action_thread_already_retired')
    }
    const fence = this.requireProductFenceForRelease(turn.thread_binding_id, input.readyRunId)
    const retiredReason = input.action === 'reset'
      ? 'user_reset'
      : input.action === 'close' ? 'closed' : 'publication_diverged'
    const threadUpdate = input.action === 'stop'
      ? this.db.prepare(`
          UPDATE codex_thread_bindings
             SET continuation_blocked_at = ?, continuation_blocked_reason = 'publication_diverged',
                 continuation_blocked_evidence_digest = ?, retired_at = ?, retired_reason = ?,
                 retirement_evidence_digest = ?, revision = revision + 1, updated_at = ?
           WHERE thread_binding_id = ? AND revision = ?
             AND continuation_blocked_at IS NULL AND retired_at IS NULL
        `).run(
          input.closeoutAt,
          lifecycle.lifecycleActionEvidenceDigest,
          input.closeoutAt,
          retiredReason,
          lifecycle.lifecycleActionEvidenceDigest,
          input.closeoutAt,
          thread.thread_binding_id,
          thread.revision,
        )
      : this.db.prepare(`
          UPDATE codex_thread_bindings
             SET retired_at = ?, retired_reason = ?, retirement_evidence_digest = ?,
                 revision = revision + 1, updated_at = ?
           WHERE thread_binding_id = ? AND revision = ? AND retired_at IS NULL
             AND continuation_blocked_at IS NULL
        `).run(
          input.closeoutAt,
          retiredReason,
          lifecycle.lifecycleActionEvidenceDigest,
          input.closeoutAt,
          thread.thread_binding_id,
          thread.revision,
        )
    if (changes(threadUpdate) !== 1) {
      throw new CodexBindingRepositoryError('lifecycle_action_thread_retirement_cas_failed')
    }
    let newGeneration: number | null = null
    let newThreadBindingId: string | null = null
    if (input.action === 'reset') {
      newGeneration = thread.alias_generation + 1
      newThreadBindingId = this.nextThreadBindingId(
          thread.ready_conversation_alias,
          newGeneration,
          lifecycle.lifecycleActionEvidenceDigest,
        )
      this.insertEmptyAliasGenerationInOpenTransaction({
        threadBindingId: newThreadBindingId,
        aliasId: thread.ready_conversation_alias,
        aliasGeneration: newGeneration,
        readyScopeId: thread.ready_scope_id,
        runtimeManifestDigest: thread.runtime_manifest_digest,
        protocolSchemaDigest: thread.protocol_schema_digest,
        createdAt: input.closeoutAt,
      })
      advanceCodexConversationMessageVisibilityInOpenTransaction(this.db, {
        scopeId: thread.ready_scope_id,
        resetAt: input.closeoutAt,
      })
    }
    const fenceReleaseRevision = fence.revision + 1
    const turnUpdate = this.db.prepare(`
      UPDATE codex_turn_bindings
         SET product_terminal_digest = ?, product_closeout_at = ?,
             fence_release_revision = ?, revision = revision + 1, updated_at = ?
       WHERE ready_run_id = ? AND revision = ? AND product_terminal_digest IS NULL
    `).run(
      input.productTerminalDigest,
      input.closeoutAt,
      fenceReleaseRevision,
      input.closeoutAt,
      input.readyRunId,
      turn.revision,
    )
    if (changes(turnUpdate) !== 1) {
      throw new CodexBindingRepositoryError('lifecycle_action_terminal_cas_failed')
    }
    const fenceDelete = this.db.prepare(`
      DELETE FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND owner_ready_run_id = ? AND revision = ?
    `).run(turn.thread_binding_id, input.readyRunId, fence.revision)
    if (changes(fenceDelete) !== 1) {
      throw new CodexBindingRepositoryError('product_fence_release_failed')
    }
    this.assertThreadArchiveEligible(turn.codex_thread_id)
    const retirementTransactionDigest = codexLifecycleActionRetirementDigest({
      action: input.action,
      readyRunId: input.readyRunId,
      aliasId: thread.ready_conversation_alias,
      retiredGeneration: thread.alias_generation,
      threadBindingId: thread.thread_binding_id,
      lifecycleActionEvidenceDigest: lifecycle.lifecycleActionEvidenceDigest,
      productTerminalDigest: input.productTerminalDigest,
      closeoutAt: input.closeoutAt,
      newGeneration,
      newThreadBindingId,
    })
    this.recordThreadArchiveIntentInOpenTransaction({
      thread,
      sourceKind: input.action === 'close'
        ? 'engine_terminal_close'
        : input.action === 'reset' ? 'engine_terminal_reset' : 'engine_terminal_stop',
      retiredReason,
      readyRunId: input.readyRunId,
      retirementEvidenceDigest: lifecycle.lifecycleActionEvidenceDigest,
      retirementTransactionDigest,
      retiredAt: input.closeoutAt,
    })
    if (input.action === 'close') {
      closeCodexConversationScopeInOpenTransaction(this.db, {
        scopeId: thread.ready_scope_id,
        closedAt: input.closeoutAt,
        closeEvidenceDigest: retirementTransactionDigest,
      })
    }
    return { handled: true, reservationSetId: turn.start_reservation_set_id }
  }

  readLifecycleActionCloseout(readyRunId: string): CodexLifecycleActionCloseoutRead {
    nonEmpty(readyRunId, 'ready_run_id_invalid')
    const turn = this.requireTurn(readyRunId)
    const thread = this.requireThread(turn.thread_binding_id)
    const lifecycle = this.readProductLifecycleAction(readyRunId)
    if (!lifecycle || !turn.codex_thread_id || !turn.codex_turn_id
      || !turn.engine_terminal_status || !turn.product_terminal_digest
      || !turn.product_closeout_at || turn.fence_release_revision === null
      || thread.retired_at !== turn.product_closeout_at
      || thread.retirement_evidence_digest !== lifecycle.lifecycleActionEvidenceDigest) {
      throw new CodexBindingRepositoryError('lifecycle_action_closeout_readback_missing')
    }
    if (lifecycle.lifecycleAction === 'stop') {
      if (thread.retired_reason !== 'publication_diverged'
        || thread.continuation_blocked_at !== turn.product_closeout_at
        || thread.continuation_blocked_reason !== 'publication_diverged'
        || thread.continuation_blocked_evidence_digest !== lifecycle.lifecycleActionEvidenceDigest) {
        throw new CodexBindingRepositoryError('lifecycle_action_closeout_readback_mismatch')
      }
    } else if (thread.continuation_blocked_at !== null
      || thread.retired_reason !== (lifecycle.lifecycleAction === 'reset' ? 'user_reset' : 'closed')) {
      throw new CodexBindingRepositoryError('lifecycle_action_closeout_readback_mismatch')
    }
    const successor = lifecycle.lifecycleAction === 'reset'
      ? this.db.prepare(`
          SELECT thread_binding_id, alias_generation FROM codex_thread_bindings
           WHERE ready_conversation_alias = ? AND alias_generation = ? LIMIT 1
        `).get<{ thread_binding_id: string; alias_generation: number }>(
          thread.ready_conversation_alias,
          thread.alias_generation + 1,
        )
      : null
    if (lifecycle.lifecycleAction === 'reset' && !successor) {
      throw new CodexBindingRepositoryError('lifecycle_action_reset_successor_missing')
    }
    const newGeneration = successor?.alias_generation ?? null
    const newThreadBindingId = successor?.thread_binding_id ?? null
    const retirementTransactionDigest = codexLifecycleActionRetirementDigest({
      action: lifecycle.lifecycleAction,
      readyRunId,
      aliasId: thread.ready_conversation_alias,
      retiredGeneration: thread.alias_generation,
      threadBindingId: thread.thread_binding_id,
      lifecycleActionEvidenceDigest: lifecycle.lifecycleActionEvidenceDigest,
      productTerminalDigest: turn.product_terminal_digest,
      closeoutAt: turn.product_closeout_at,
      newGeneration,
      newThreadBindingId,
    })
    const archiveSource: CodexThreadArchiveSourceKind = lifecycle.lifecycleAction === 'close'
      ? 'engine_terminal_close'
      : lifecycle.lifecycleAction === 'reset' ? 'engine_terminal_reset' : 'engine_terminal_stop'
    const archiveIntent = this.requireThreadArchiveIntent({
      threadBindingId: thread.thread_binding_id,
      sourceKind: archiveSource,
      readyRunId,
      retirementTransactionDigest,
    })
    const scopeClosure = lifecycle.lifecycleAction === 'close'
      ? readCodexClosedConversationScope(this.db, thread.ready_scope_id)
      : null
    if (lifecycle.lifecycleAction === 'close' && (!scopeClosure
      || scopeClosure.closedAt !== turn.product_closeout_at
      || scopeClosure.closeEvidenceDigest !== retirementTransactionDigest)) {
      throw new CodexBindingRepositoryError('lifecycle_action_scope_closeout_readback_missing')
    }
    return {
      action: lifecycle.lifecycleAction,
      readyRunId,
      aliasId: thread.ready_conversation_alias,
      aliasGeneration: thread.alias_generation,
      codexThreadId: turn.codex_thread_id,
      codexTurnId: turn.codex_turn_id,
      terminal: turn.engine_terminal_status,
      closeoutDigest: turn.product_terminal_digest,
      fenceReleaseRevision: turn.fence_release_revision,
      lifecycleActionEvidenceDigest: lifecycle.lifecycleActionEvidenceDigest,
      retiredGeneration: thread.alias_generation,
      retirementTransactionDigest,
      archiveIntentDigest: archiveIntent.intentDigest,
      scopeClosureEvidenceDigest: scopeClosure?.closeEvidenceDigest ?? null,
      newGeneration,
      newThreadBindingId,
    }
  }

  completePublicationDivergenceCloseoutInOpenTransaction(input: {
    readyRunId: string
    productTerminalDigest: string
    closeoutAt: string
  }): { handled: boolean; reservationSetId: string | null } {
    if (this.db.inTransaction !== true) {
      throw new CodexBindingRepositoryError('canonical_closeout_transaction_missing')
    }
    const turn = this.db.prepare(`
      SELECT * FROM codex_turn_bindings WHERE ready_run_id = ?
    `).get<TurnBindingRow>(input.readyRunId)
    if (!turn) return { handled: false, reservationSetId: null }
    if (turn.host_failure_kind || !turn.engine_terminal_recorded_at
      || !turn.engine_terminal_candidate_digest) {
      throw new CodexBindingRepositoryError('publication_divergence_evidence_missing')
    }
    const thread = this.requireThread(turn.thread_binding_id)
    if (thread.continuation_blocked_at) {
      if (thread.continuation_blocked_at !== input.closeoutAt
        || thread.continuation_blocked_reason !== 'publication_diverged'
        || thread.continuation_blocked_evidence_digest !== turn.engine_terminal_candidate_digest
        || thread.retired_at !== input.closeoutAt
        || thread.retired_reason !== 'publication_diverged'
        || thread.retirement_evidence_digest !== turn.engine_terminal_candidate_digest) {
        throw new CodexBindingRepositoryError('publication_divergence_immutable')
      }
    } else {
      const blocked = this.db.prepare(`
        UPDATE codex_thread_bindings
           SET continuation_blocked_at = ?,
               continuation_blocked_reason = 'publication_diverged',
               continuation_blocked_evidence_digest = ?,
               retired_at = ?, retired_reason = 'publication_diverged',
               retirement_evidence_digest = ?,
               revision = revision + 1, updated_at = ?
         WHERE thread_binding_id = ? AND revision = ?
           AND continuation_blocked_at IS NULL AND retired_at IS NULL
      `).run(
        input.closeoutAt,
        turn.engine_terminal_candidate_digest,
        input.closeoutAt,
        turn.engine_terminal_candidate_digest,
        input.closeoutAt,
        thread.thread_binding_id,
        thread.revision,
      )
      if (changes(blocked) !== 1) {
        throw new CodexBindingRepositoryError('publication_divergence_block_cas_failed')
      }
    }
    this.completeProductTurnCloseoutInOpenTransaction(input, turn)
    if (!turn.codex_thread_id) {
      throw new CodexBindingRepositoryError('publication_divergence_thread_identity_missing')
    }
    this.assertThreadArchiveEligible(turn.codex_thread_id)
    const retirementTransactionDigest = digest({
      contract: 'codex_publication_divergence_retirement_v1',
      readyRunId: input.readyRunId,
      threadBindingId: thread.thread_binding_id,
      retirementEvidenceDigest: turn.engine_terminal_candidate_digest,
      productTerminalDigest: input.productTerminalDigest,
      closeoutAt: input.closeoutAt,
    })
    this.recordThreadArchiveIntentInOpenTransaction({
      thread,
      sourceKind: 'publication_divergence',
      retiredReason: 'publication_diverged',
      readyRunId: input.readyRunId,
      retirementEvidenceDigest: turn.engine_terminal_candidate_digest,
      retirementTransactionDigest,
      retiredAt: input.closeoutAt,
    })
    return { handled: true, reservationSetId: turn.start_reservation_set_id }
  }

  completeRecoveryFailureCloseoutInOpenTransaction(input: {
    readyRunId: string
    productTerminalDigest: string
    closeoutAt: string
    recoveryFailureCode: string
    recoveryFailureEvidenceDigest: string
  }): { handled: boolean; reservationSetId: string | null } {
    nonEmpty(input.readyRunId, 'ready_run_id_invalid')
    nonEmpty(input.productTerminalDigest, 'product_terminal_digest_invalid')
    nonEmpty(input.closeoutAt, 'product_closeout_at_invalid')
    nonEmpty(input.recoveryFailureCode, 'recovery_failure_code_invalid')
    if (!/^[a-f0-9]{64}$/.test(input.recoveryFailureEvidenceDigest)) {
      throw new CodexBindingRepositoryError('recovery_failure_evidence_digest_invalid')
    }
    if (this.db.inTransaction !== true) {
      throw new CodexBindingRepositoryError('canonical_closeout_transaction_missing')
    }
    const turn = this.db.prepare(`
      SELECT * FROM codex_turn_bindings WHERE ready_run_id = ?
    `).get<TurnBindingRow>(input.readyRunId)
    if (!turn) return { handled: false, reservationSetId: null }
    this.completeRecoveryFailureCloseout(input, turn)
    return { handled: true, reservationSetId: turn.start_reservation_set_id }
  }

  bindToolCall(input: Parameters<CodexToolBindingRepository['bindToolCall']>[0]): { duplicate: boolean } {
    return this.toolBindings.bindToolCall(input)
  }

  admitToolResponseGroup(
    input: Parameters<CodexToolBindingRepository['admitToolResponseGroup']>[0],
  ): void {
    this.toolBindings.admitToolResponseGroup(input)
  }

  readToolBridgeExecutionBinding(
    bindingId: string,
  ): ReturnType<CodexToolBindingRepository['readToolBridgeExecutionBinding']> {
    return this.toolBindings.readToolBridgeExecutionBinding(bindingId)
  }

  readToolCallBinding(
    input: Parameters<CodexToolBindingRepository['readToolCallBinding']>[0],
  ): ReturnType<CodexToolBindingRepository['readToolCallBinding']> {
    return this.toolBindings.readToolCallBinding(input)
  }

  completeToolCall(
    input: Parameters<CodexToolBindingRepository['completeToolCall']>[0],
  ): void {
    this.toolBindings.completeToolCall(input)
  }

  markToolCallDeliveryIntent(
    input: Parameters<CodexToolBindingRepository['markToolCallDeliveryIntent']>[0],
  ): void {
    this.toolBindings.markToolCallDeliveryIntent(input)
  }

  beginToolCallDeliveryAttempt(
    input: Parameters<CodexToolBindingRepository['beginToolCallDeliveryAttempt']>[0],
  ): ReturnType<CodexToolBindingRepository['beginToolCallDeliveryAttempt']> {
    return this.toolBindings.beginToolCallDeliveryAttempt(input)
  }

  readToolCallDeliveryAttempts(
    input: Parameters<CodexToolBindingRepository['readToolCallDeliveryAttempts']>[0],
  ): ReturnType<CodexToolBindingRepository['readToolCallDeliveryAttempts']> {
    return this.toolBindings.readToolCallDeliveryAttempts(input)
  }

  confirmToolCallDeliveryTransportWrite(
    input: Parameters<CodexToolBindingRepository['confirmToolCallDeliveryTransportWrite']>[0],
  ): void {
    this.toolBindings.confirmToolCallDeliveryTransportWrite(input)
  }

  readModelGatewayBinding(input: CodexModelGatewayBindingReadInput): CodexModelGatewayBindingRead {
    nonEmpty(input.codexThreadId, 'gateway_thread_id_invalid')
    nonEmpty(input.codexTurnId, 'gateway_turn_id_invalid')
    nonEmpty(input.receivedAt, 'gateway_received_at_invalid')
    if (input.kind === 'product' || input.kind === 'automatic_compaction') {
      if (!input.readyRunId) throw new CodexBindingRepositoryError('gateway_ready_run_id_missing')
      const row = this.db.prepare(`
        SELECT t.ready_run_id, t.ready_task_id, t.codex_thread_id, t.codex_turn_id,
               t.gateway_claimed_codex_turn_id, t.product_closeout_at, t.revision,
               t.turn_start_dispatch_intent_at,
               t.tool_surface_digest, t.effective_codex_model,
               t.effective_upstream_snapshot_ref, t.effective_upstream_snapshot_digest,
               t.additional_context_digest, t.turn_contract_digest, t.product_budget_seed_json,
               t.authorization_snapshot_digest, t.authorization_snapshot_json,
               t.attempt_kind, t.ingress_json, t.ingress_admitted_digest,
               th.instruction_contract_digest,
               th.codex_thread_id AS thread_codex_thread_id,
               f.owner_ready_run_id AS fence_owner_ready_run_id,
               f.quarantined_at AS fence_quarantined_at
          FROM codex_turn_bindings t
          JOIN codex_thread_bindings th ON th.thread_binding_id = t.thread_binding_id
          JOIN codex_thread_dispatch_fences f ON f.thread_binding_id = t.thread_binding_id
         WHERE t.ready_run_id = ? AND f.operation_kind = 'product_turn'
         LIMIT 1
      `).get<{
        ready_run_id: string
        ready_task_id: string
        codex_thread_id: string | null
        codex_turn_id: string | null
        gateway_claimed_codex_turn_id: string | null
        product_closeout_at: string | null
        revision: number
        turn_start_dispatch_intent_at: string | null
        tool_surface_digest: string
        effective_codex_model: string
        effective_upstream_snapshot_ref: string
        effective_upstream_snapshot_digest: string
        additional_context_digest: string
        turn_contract_digest: string
        product_budget_seed_json: string
        authorization_snapshot_digest: string
        authorization_snapshot_json: string
        attempt_kind: TurnBindingRow['attempt_kind']
        ingress_json: string | null
        ingress_admitted_digest: string
        instruction_contract_digest: string | null
        thread_codex_thread_id: string | null
        fence_owner_ready_run_id: string | null
        fence_quarantined_at: string | null
      }>(input.readyRunId)
      if (
        !row
        || row.product_closeout_at
        || !row.turn_start_dispatch_intent_at
        || row.fence_owner_ready_run_id !== row.ready_run_id
        || row.fence_quarantined_at
        || row.thread_codex_thread_id !== input.codexThreadId
        || (row.codex_thread_id && row.codex_thread_id !== input.codexThreadId)
        || (row.codex_turn_id && row.codex_turn_id !== input.codexTurnId)
        || (row.gateway_claimed_codex_turn_id
          && row.gateway_claimed_codex_turn_id !== input.codexTurnId)
        || input.toolSurfaceDigest !== row.tool_surface_digest
        || input.turnContractDigest !== row.turn_contract_digest
        || input.upstreamProfileSnapshotDigest !== row.effective_upstream_snapshot_digest
        || !row.instruction_contract_digest
      ) throw new CodexBindingRepositoryError('gateway_product_binding_mismatch')
      if (!row.gateway_claimed_codex_turn_id) {
        const claimed = this.db.prepare(`
          UPDATE codex_turn_bindings
             SET gateway_claimed_codex_turn_id = ?, revision = revision + 1, updated_at = ?
           WHERE ready_run_id = ? AND revision = ?
             AND gateway_claimed_codex_turn_id IS NULL
             AND (codex_turn_id IS NULL OR codex_turn_id = ?)
        `).run(
          input.codexTurnId,
          input.receivedAt,
          row.ready_run_id,
          row.revision,
          input.codexTurnId,
        )
        if (changes(claimed) !== 1) {
          throw new CodexBindingRepositoryError('gateway_turn_identity_claim_failed')
        }
      }
      const budget = parseProductBudgetLimits(row.product_budget_seed_json)
      const admittedToolCalls = this.db.prepare(`
        SELECT COALESCE(SUM(tool_call_count), 0) AS count
          FROM codex_tool_group_admissions WHERE ready_run_id = ?
      `).get<{ count: number }>(row.ready_run_id)?.count || 0
      if (admittedToolCalls > budget.maxToolCalls) {
        throw new CodexBindingRepositoryError('gateway_product_budget_snapshot_invalid')
      }
      const folderActivation = readCodexFolderOutputActivation(this.db, row.ready_run_id)
      const admittedLaneCalls = folderActivation.kind === 'no_contract'
        ? {
            ordinary_calls: admittedToolCalls,
            delivery_calls: 0,
          }
        : this.db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN tool_name IN (
            'declare_completion_criteria', 'skill_write_artifact',
            'skill_read_artifact', 'skill_export_artifact'
          ) THEN 0 ELSE 1 END), 0) AS ordinary_calls,
          COALESCE(SUM(CASE WHEN tool_name IN (
            'declare_completion_criteria', 'skill_write_artifact',
            'skill_read_artifact', 'skill_export_artifact'
          ) THEN 1 ELSE 0 END), 0) AS delivery_calls
          FROM codex_tool_call_admissions WHERE ready_run_id = ?
      `).get<{ ordinary_calls: number; delivery_calls: number }>(row.ready_run_id)
      const ordinaryExhausted = Number(admittedLaneCalls?.ordinary_calls || 0)
        >= budget.lanes.ordinary.maxToolCalls
      const deliveryExhausted = Number(admittedLaneCalls?.delivery_calls || 0)
        >= budget.lanes.delivery.maxToolCalls
      let authorization: ReadyBoundTurnToolAuthorization
      try {
        authorization = JSON.parse(row.authorization_snapshot_json) as ReadyBoundTurnToolAuthorization
        assertReadyBoundTurnToolAuthorization(authorization)
      } catch {
        throw new CodexBindingRepositoryError('gateway_tool_authorization_invalid')
      }
      if (
        authorization.authorizationSnapshotDigest !== row.authorization_snapshot_digest
        || authorization.readyRunId !== row.ready_run_id
        || authorization.readyTaskId !== row.ready_task_id
        || authorization.toolSurfaceDigest !== row.tool_surface_digest
        || authorization.turnContractDigest !== row.turn_contract_digest
      ) throw new CodexBindingRepositoryError('gateway_tool_authorization_mismatch')
      const effectiveNames = input.kind === 'product'
        ? effectiveCodexFolderOutputToolNames(
            authorization.allowedToolNames,
            folderActivation,
          ).filter((name) => (
            folderActivation.kind !== 'no_contract' && CODEX_DELIVERY_LANE_TOOL_NAMES.has(name)
              ? !deliveryExhausted
              : !ordinaryExhausted
          ))
        : null
      return {
        kind: input.kind,
        ownerId: row.ready_run_id,
        codexModel: row.effective_codex_model,
        upstreamProfileSnapshotRef: row.effective_upstream_snapshot_ref,
        upstreamProfileSnapshotDigest: row.effective_upstream_snapshot_digest,
        toolSurfaceDigest: row.tool_surface_digest,
        turnContractDigest: row.turn_contract_digest,
        instructionContractDigest: row.instruction_contract_digest,
        additionalContextDigest: row.additional_context_digest,
        providerSnapshotJson: null,
        maxIterations: budget.maxIterations,
        iterationLanes: input.kind === 'product'
          ? {
              ordinary: budget.lanes.ordinary.maxIterations,
              delivery: budget.lanes.delivery.maxIterations,
              final: 1,
            }
          : null,
        toolCallsExhausted: input.kind === 'product' && effectiveNames?.length === 0,
        allowedToolNames: effectiveNames,
      }
    }

    const rows = this.db.prepare(`
      SELECT m.manual_compaction_id, m.codex_thread_id, m.codex_compaction_turn_id,
             m.codex_model, m.revision,
             m.upstream_profile_snapshot_ref, m.upstream_profile_snapshot_digest,
             m.expected_tools_digest, m.provider_snapshot_json, m.expires_at,
             m.pre_dispatch_turn_ids_json,
             m.consumed_at, m.abandoned_at,
             th.instruction_contract_digest,
             f.owner_manual_compaction_id AS fence_owner_manual_compaction_id,
             f.quarantined_at AS fence_quarantined_at
        FROM codex_manual_compaction_bindings m
        JOIN codex_thread_bindings th ON th.thread_binding_id = m.thread_binding_id
        JOIN codex_thread_dispatch_fences f ON f.thread_binding_id = m.thread_binding_id
       WHERE m.codex_thread_id = ? AND f.operation_kind = 'manual_compaction'
         AND m.consumed_at IS NULL AND m.abandoned_at IS NULL
       LIMIT 2
    `).all<{
      manual_compaction_id: string
      codex_thread_id: string
      codex_compaction_turn_id: string | null
      codex_model: string
      revision: number
      upstream_profile_snapshot_ref: string
      upstream_profile_snapshot_digest: string
      expected_tools_digest: string
      provider_snapshot_json: string
      expires_at: string
      pre_dispatch_turn_ids_json: string | null
      consumed_at: string | null
      abandoned_at: string | null
      instruction_contract_digest: string | null
      fence_owner_manual_compaction_id: string | null
      fence_quarantined_at: string | null
    }>(input.codexThreadId)
    if (rows.length !== 1) throw new CodexBindingRepositoryError('gateway_manual_binding_not_unique')
    const row = rows[0]
    const preDispatchTurnIds = row.pre_dispatch_turn_ids_json
      ? parseStringArray(row.pre_dispatch_turn_ids_json, 'manual_pre_dispatch_turn_ids_invalid')
      : []
    if (
      row.codex_thread_id !== input.codexThreadId
      || (row.codex_compaction_turn_id && row.codex_compaction_turn_id !== input.codexTurnId)
      || row.fence_owner_manual_compaction_id !== row.manual_compaction_id
      || row.fence_quarantined_at
      || !Number.isFinite(Date.parse(row.expires_at))
      || !Number.isFinite(Date.parse(input.receivedAt))
      || Date.parse(row.expires_at) < Date.parse(input.receivedAt)
      || !row.instruction_contract_digest
      || preDispatchTurnIds.includes(input.codexTurnId)
    ) throw new CodexBindingRepositoryError('gateway_manual_binding_mismatch')
    if (!row.codex_compaction_turn_id) {
      const claimed = this.db.prepare(`
        UPDATE codex_manual_compaction_bindings
           SET codex_compaction_turn_id = ?, revision = revision + 1, updated_at = ?
         WHERE manual_compaction_id = ? AND revision = ?
           AND codex_compaction_turn_id IS NULL
           AND consumed_at IS NULL AND abandoned_at IS NULL
      `).run(
        input.codexTurnId,
        input.receivedAt,
        row.manual_compaction_id,
        row.revision,
      )
      if (changes(claimed) !== 1) {
        throw new CodexBindingRepositoryError('gateway_turn_identity_claim_failed')
      }
    }
    return {
      kind: 'manual_compaction',
      ownerId: row.manual_compaction_id,
      codexModel: row.codex_model,
      upstreamProfileSnapshotRef: row.upstream_profile_snapshot_ref,
      upstreamProfileSnapshotDigest: row.upstream_profile_snapshot_digest,
      toolSurfaceDigest: row.expected_tools_digest,
      turnContractDigest: null,
      instructionContractDigest: row.instruction_contract_digest,
      additionalContextDigest: null,
      providerSnapshotJson: row.provider_snapshot_json,
      maxIterations: null,
      iterationLanes: null,
      toolCallsExhausted: false,
      allowedToolNames: null,
    }
  }

  beginManualCompaction(input: {
    manualCompactionId: string
    threadBindingId: string
    ownerMainBootId: string
    codexModel: string
    upstreamProfileSnapshotRef: string
    upstreamProfileSnapshotDigest: string
    providerSnapshot: unknown
    credentialReferenceId: string
    expectedToolsDigest: string
    preDispatchThreadReadDigest: string
    preDispatchTurnIds: string[]
    expiresAt: string
    createdAt: string
  }): { manualCompactionId: string; codexThreadId: string } {
    return this.immediate(() => {
      const thread = this.requireThread(input.threadBindingId)
      if (
        !thread.codex_thread_id
        || thread.retired_at
        || thread.continuation_blocked_at
      ) throw new CodexBindingRepositoryError('manual_compaction_thread_not_eligible')
      const latestTurn = this.readLatestClosedTurnUpstreamRoute(thread.thread_binding_id)
      if (
        !latestTurn
        || latestTurn.effective_codex_model !== input.codexModel
        || latestTurn.effective_upstream_snapshot_ref !== input.upstreamProfileSnapshotRef
        || latestTurn.effective_upstream_snapshot_digest !== input.upstreamProfileSnapshotDigest
        || digestCanonicalJson(input.providerSnapshot)
          !== latestTurn.effective_upstream_snapshot_digest
        || !isRecord(input.providerSnapshot)
        || input.providerSnapshot.credentialReferenceId !== input.credentialReferenceId
      ) throw new CodexBindingRepositoryError('manual_compaction_route_mismatch')
      if (input.expectedToolsDigest !== digestCanonicalJson([])) {
        throw new CodexBindingRepositoryError('manual_compaction_tool_surface_invalid')
      }
      nonEmpty(input.preDispatchThreadReadDigest, 'manual_pre_dispatch_evidence_invalid')
      if (!input.preDispatchTurnIds.every((turnId) => typeof turnId === 'string' && turnId.trim())) {
        throw new CodexBindingRepositoryError('manual_pre_dispatch_evidence_invalid')
      }
      const preDispatchTurnIdsJson = canonicalJson(input.preDispatchTurnIds)
      this.db.prepare(`
        INSERT INTO codex_manual_compaction_bindings (
          manual_compaction_id, thread_binding_id, codex_thread_id,
          codex_model_provider_id, codex_model, upstream_profile_snapshot_ref,
          upstream_profile_snapshot_digest, provider_snapshot_json,
          credential_reference_id, expected_tools_digest, expires_at,
          pre_dispatch_thread_read_digest, pre_dispatch_turn_ids_json,
          pre_dispatch_turn_ids_digest,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, 'ready_gateway', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        input.manualCompactionId,
        input.threadBindingId,
        thread.codex_thread_id,
        input.codexModel,
        input.upstreamProfileSnapshotRef,
        input.upstreamProfileSnapshotDigest,
        JSON.stringify(input.providerSnapshot),
        input.credentialReferenceId,
        input.expectedToolsDigest,
        input.expiresAt,
        input.preDispatchThreadReadDigest,
        preDispatchTurnIdsJson,
        digestCanonicalJson(input.preDispatchTurnIds),
        input.createdAt,
        input.createdAt,
      )
      this.db.prepare(`
        INSERT INTO codex_thread_dispatch_fences (
          thread_binding_id, owner_main_boot_id, operation_kind,
          owner_manual_compaction_id, acquired_at, revision
        ) VALUES (?, ?, 'manual_compaction', ?, ?, 1)
      `).run(
        input.threadBindingId,
        input.ownerMainBootId,
        input.manualCompactionId,
        input.createdAt,
      )
      const readback = this.db.prepare(`
        SELECT manual_compaction_id, codex_thread_id
          FROM codex_manual_compaction_bindings WHERE manual_compaction_id = ?
      `).get<{ manual_compaction_id: string; codex_thread_id: string }>(input.manualCompactionId)
      if (!readback) throw new CodexBindingRepositoryError('manual_compaction_readback_failed')
      return {
        manualCompactionId: readback.manual_compaction_id,
        codexThreadId: readback.codex_thread_id,
      }
    })
  }

  activateManualCompactionDispatch(input: {
    connectionEpoch: string
    rpcId: number
    codexThreadId: string
    requestDigest: string
    dispatchIntentAt: string
  }): { manualCompactionId: string } {
    for (const value of [
      input.connectionEpoch,
      input.codexThreadId,
      input.requestDigest,
      input.dispatchIntentAt,
    ]) nonEmpty(value, 'manual_dispatch_identity_invalid')
    safePositive(input.rpcId, 'manual_dispatch_rpc_id_invalid')
    return this.immediate(() => {
      const rows = this.db.prepare(`
        SELECT manual.manual_compaction_id
          FROM codex_manual_compaction_bindings manual
          JOIN codex_thread_dispatch_fences fence
            ON fence.thread_binding_id = manual.thread_binding_id
           AND fence.owner_manual_compaction_id = manual.manual_compaction_id
         WHERE manual.codex_thread_id = ?
           AND manual.consumed_at IS NULL AND manual.abandoned_at IS NULL
           AND manual.unknown_at IS NULL
           AND fence.operation_kind = 'manual_compaction'
           AND fence.quarantined_at IS NULL
         LIMIT 2
      `).all<{ manual_compaction_id: string }>(input.codexThreadId)
      if (rows.length !== 1) {
        throw new CodexBindingRepositoryError('manual_dispatch_binding_not_unique')
      }
      const manualCompactionId = rows[0].manual_compaction_id
      const attemptId = `manual-attempt-${digestCanonicalJson({
        manualCompactionId,
        connectionEpoch: input.connectionEpoch,
        rpcId: input.rpcId,
        requestDigest: input.requestDigest,
      })}`
      this.db.prepare(`
        INSERT INTO codex_manual_compaction_dispatch_attempts (
          attempt_id, manual_compaction_id, connection_epoch, rpc_id,
          request_digest, dispatch_intent_at, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        attemptId,
        manualCompactionId,
        input.connectionEpoch,
        input.rpcId,
        input.requestDigest,
        input.dispatchIntentAt,
        input.dispatchIntentAt,
        input.dispatchIntentAt,
      )
      return { manualCompactionId }
    })
  }

  markManualCompactionWriteAttempted(input: {
    connectionEpoch: string
    rpcId: number
    manualCompactionId: string
    attemptedAt: string
  }): void {
    this.updateManualAttempt(input, 'attempted')
  }

  markManualCompactionWriteConfirmed(input: {
    connectionEpoch: string
    rpcId: number
    manualCompactionId: string
    childWriteDigest: string
    confirmedAt: string
  }): void {
    this.updateManualAttempt(input, 'confirmed')
  }

  markManualCompactionDispatchUnresolved(input: {
    connectionEpoch: string
    rpcId: number
    manualCompactionId: string
    reason: 'response_timeout' | 'child_write_error' | 'connection_closed'
    unresolvedAt: string
  }): void {
    this.updateManualAttempt(input, 'unresolved')
  }

  recordManualCompactionDispatchResponse(input: {
    connectionEpoch: string
    rpcId: number
    manualCompactionId: string
    responseKind: 'accepted' | 'rejected'
    responseDigest: string
    responseAt: string
  }): void {
    this.updateManualAttempt(input, 'response')
  }

  consumeLateManualCompactionResponse(input: {
    connectionEpoch: string
    rpcId: number
    responseKind: 'accepted' | 'rejected'
    responseDigest: string
    responseAt: string
  }): boolean {
    const row = this.db.prepare(`
      SELECT manual_compaction_id FROM codex_manual_compaction_dispatch_attempts
       WHERE connection_epoch = ? AND rpc_id = ? LIMIT 1
    `).get<{ manual_compaction_id: string }>(input.connectionEpoch, input.rpcId)
    if (!row) return false
    this.recordManualCompactionDispatchResponse({
      ...input,
      manualCompactionId: row.manual_compaction_id,
    })
    return true
  }

  markManualCompactionConnectionClosed(connectionEpoch: string, closedAt: string): void {
    nonEmpty(connectionEpoch, 'manual_connection_epoch_invalid')
    nonEmpty(closedAt, 'manual_connection_close_time_invalid')
    this.immediate(() => {
      this.db.prepare(`
        UPDATE codex_manual_compaction_dispatch_attempts
           SET unresolved_at = COALESCE(unresolved_at, ?),
               unresolved_reason = COALESCE(unresolved_reason, 'connection_closed'),
               revision = revision + 1, updated_at = ?
         WHERE connection_epoch = ? AND response_kind IS NULL
           AND proven_absent_at IS NULL AND unresolved_at IS NULL
      `).run(closedAt, closedAt, connectionEpoch)
    })
  }

  proveManualCompactionAttemptAbsent(input: {
    manualCompactionId: string
    connectionEpoch: string
    rpcId: number
    reason: 'write_not_attempted'
    evidenceDigest: string
    provenAt: string
  }): void {
    for (const value of [
      input.manualCompactionId,
      input.connectionEpoch,
      input.evidenceDigest,
      input.provenAt,
    ]) nonEmpty(value, 'manual_absence_identity_invalid')
    safePositive(input.rpcId, 'manual_absence_rpc_id_invalid')
    this.immediate(() => {
      const update = this.db.prepare(`
        UPDATE codex_manual_compaction_dispatch_attempts
           SET proven_absent_at = ?, proven_absent_reason = ?,
               proven_absent_evidence_digest = ?, revision = revision + 1, updated_at = ?
         WHERE manual_compaction_id = ? AND connection_epoch = ? AND rpc_id = ?
           AND child_write_attempted_at IS NULL AND response_kind IS NULL
           AND proven_absent_at IS NULL
      `).run(
        input.provenAt,
        input.reason,
        input.evidenceDigest,
        input.provenAt,
        input.manualCompactionId,
        input.connectionEpoch,
        input.rpcId,
      )
      if (changes(update) !== 1) {
        throw new CodexBindingRepositoryError('manual_absence_not_proven')
      }
    })
  }

  renewManualCompactionRecoveryWindow(input: {
    manualCompactionId: string
    expiresAt: string
    renewedAt: string
  }): void {
    for (const value of [input.manualCompactionId, input.expiresAt, input.renewedAt]) {
      nonEmpty(value, 'manual_recovery_window_invalid')
    }
    this.immediate(() => {
      const row = this.db.prepare(`
        SELECT revision, consumed_at, abandoned_at, unknown_at
          FROM codex_manual_compaction_bindings WHERE manual_compaction_id = ?
      `).get<{
        revision: number
        consumed_at: string | null
        abandoned_at: string | null
        unknown_at: string | null
      }>(input.manualCompactionId)
      if (!row || row.consumed_at || row.abandoned_at || row.unknown_at) {
        throw new CodexBindingRepositoryError('manual_recovery_window_not_renewable')
      }
      const update = this.db.prepare(`
        UPDATE codex_manual_compaction_bindings
           SET expires_at = ?, revision = revision + 1, updated_at = ?
         WHERE manual_compaction_id = ? AND revision = ?
           AND consumed_at IS NULL AND abandoned_at IS NULL AND unknown_at IS NULL
      `).run(input.expiresAt, input.renewedAt, input.manualCompactionId, row.revision)
      if (changes(update) !== 1) {
        throw new CodexBindingRepositoryError('manual_recovery_window_cas_failed')
      }
    })
  }

  recordManualCompactionUnknown(input: {
    manualCompactionId: string
    reason: string
    evidenceDigest: string
    unknownAt: string
  }): void {
    for (const value of [input.manualCompactionId, input.reason, input.evidenceDigest, input.unknownAt]) {
      nonEmpty(value, 'manual_unknown_identity_invalid')
    }
    this.immediate(() => {
      const row = this.db.prepare(`
        SELECT unknown_at, unknown_reason, unknown_evidence_digest, revision
          FROM codex_manual_compaction_bindings WHERE manual_compaction_id = ?
      `).get<{
        unknown_at: string | null
        unknown_reason: string | null
        unknown_evidence_digest: string | null
        revision: number
      }>(input.manualCompactionId)
      if (!row) throw new CodexBindingRepositoryError('manual_compaction_not_found')
      if (row.unknown_at) {
        if (
          row.unknown_at !== input.unknownAt
          || row.unknown_reason !== input.reason
          || row.unknown_evidence_digest !== input.evidenceDigest
        ) throw new CodexBindingRepositoryError('manual_unknown_conflict')
        return
      }
      const update = this.db.prepare(`
        UPDATE codex_manual_compaction_bindings
           SET unknown_at = ?, unknown_reason = ?, unknown_evidence_digest = ?,
               revision = revision + 1, updated_at = ?
         WHERE manual_compaction_id = ? AND revision = ? AND unknown_at IS NULL
      `).run(
        input.unknownAt,
        input.reason,
        input.evidenceDigest,
        input.unknownAt,
        input.manualCompactionId,
        row.revision,
      )
      if (changes(update) !== 1) {
        throw new CodexBindingRepositoryError('manual_unknown_cas_failed')
      }
    })
  }

  consumeManualCompaction(input: {
    manualCompactionId: string
    codexCompactionTurnId: string
    notificationContextCompactionItemId: string | null
    contextCompactionItemId: string
    threadReadDigest: string
    terminalEvidenceDigest: string
    gatewayRequestReceiptId: string
    gatewayRequestEvidenceDigest: string
    gatewayResponseEvidenceDigest: string
    consumedAt: string
  }): void {
    this.immediate(() => {
      const row = this.db.prepare(`
        SELECT manual_compaction_id, thread_binding_id, codex_thread_id,
               consumed_at, abandoned_at, unknown_at, revision
          FROM codex_manual_compaction_bindings WHERE manual_compaction_id = ?
      `).get<{
        manual_compaction_id: string
        thread_binding_id: string
        codex_thread_id: string
        consumed_at: string | null
        abandoned_at: string | null
        unknown_at: string | null
        revision: number
      }>(input.manualCompactionId)
      if (!row || row.consumed_at || row.abandoned_at || row.unknown_at) {
        throw new CodexBindingRepositoryError('manual_compaction_not_consumable')
      }
      const claimed = this.db.prepare(`
        SELECT codex_compaction_turn_id
          FROM codex_manual_compaction_bindings WHERE manual_compaction_id = ?
      `).get<{ codex_compaction_turn_id: string | null }>(input.manualCompactionId)
      if (
        claimed?.codex_compaction_turn_id
        && claimed.codex_compaction_turn_id !== input.codexCompactionTurnId
      ) throw new CodexBindingRepositoryError('manual_compaction_turn_identity_conflict')
      const evidenceDigest = digest({
        manualCompactionId: input.manualCompactionId,
        codexThreadId: row.codex_thread_id,
        codexCompactionTurnId: input.codexCompactionTurnId,
        notificationContextCompactionItemId: input.notificationContextCompactionItemId,
        contextCompactionItemId: input.contextCompactionItemId,
        threadReadDigest: input.threadReadDigest,
        terminalEvidenceDigest: input.terminalEvidenceDigest,
        gatewayRequestReceiptId: input.gatewayRequestReceiptId,
        gatewayRequestEvidenceDigest: input.gatewayRequestEvidenceDigest,
        gatewayResponseEvidenceDigest: input.gatewayResponseEvidenceDigest,
      })
      const update = this.db.prepare(`
        UPDATE codex_manual_compaction_bindings
           SET codex_compaction_turn_id = ?, notification_context_compaction_item_id = ?,
               context_compaction_item_id = ?,
               terminal_status = 'completed', terminal_evidence_digest = ?,
               thread_read_digest = ?, gateway_request_receipt_id = ?,
               gateway_request_evidence_digest = ?, gateway_response_evidence_digest = ?,
               consumed_at = ?, consume_evidence_digest = ?,
               revision = revision + 1, updated_at = ?
         WHERE manual_compaction_id = ? AND revision = ?
           AND consumed_at IS NULL AND abandoned_at IS NULL AND unknown_at IS NULL
      `).run(
        input.codexCompactionTurnId,
        input.notificationContextCompactionItemId,
        input.contextCompactionItemId,
        input.terminalEvidenceDigest,
        input.threadReadDigest,
        input.gatewayRequestReceiptId,
        input.gatewayRequestEvidenceDigest,
        input.gatewayResponseEvidenceDigest,
        input.consumedAt,
        evidenceDigest,
        input.consumedAt,
        input.manualCompactionId,
        row.revision,
      )
      if (changes(update) !== 1) throw new CodexBindingRepositoryError('manual_compaction_consume_cas_failed')
      const fence = this.db.prepare(`
        DELETE FROM codex_thread_dispatch_fences
         WHERE thread_binding_id = ? AND owner_manual_compaction_id = ?
      `).run(row.thread_binding_id, input.manualCompactionId)
      if (changes(fence) !== 1) throw new CodexBindingRepositoryError('manual_compaction_fence_release_failed')
    })
  }

  quarantineUnknownManualCompaction(input: {
    aliasId: string
    aliasGeneration: number
    manualCompactionId: string
    reason: string
    evidenceDigest: string
    quarantinedAt: string
  }): {
    aliasId: string
    retiredGeneration: number
    nextAliasGeneration: number
    newThreadBindingId: string
    transactionDigest: string
    messageVisibilityEpoch: number
  } {
    for (const value of [
      input.aliasId,
      input.manualCompactionId,
      input.reason,
      input.evidenceDigest,
      input.quarantinedAt,
    ]) nonEmpty(value, 'manual_quarantine_identity_invalid')
    safePositive(input.aliasGeneration, 'alias_generation_invalid')
    return this.immediate(() => {
      const row = this.db.prepare(`
        SELECT manual_compaction_id, thread_binding_id, consumed_at, abandoned_at, unknown_at, revision
          FROM codex_manual_compaction_bindings WHERE manual_compaction_id = ?
      `).get<{
        manual_compaction_id: string
        thread_binding_id: string
        consumed_at: string | null
        abandoned_at: string | null
        unknown_at: string | null
        revision: number
      }>(input.manualCompactionId)
      if (!row || row.consumed_at || row.abandoned_at || !row.unknown_at) {
        throw new CodexBindingRepositoryError('manual_compaction_not_quarantinable')
      }
      const manual = this.db.prepare(`
        UPDATE codex_manual_compaction_bindings
           SET abandoned_at = ?, abandoned_reason = ?,
               revision = revision + 1, updated_at = ?
         WHERE manual_compaction_id = ? AND revision = ?
           AND consumed_at IS NULL AND abandoned_at IS NULL
      `).run(
        input.quarantinedAt,
        input.reason,
        input.quarantinedAt,
        input.manualCompactionId,
        row.revision,
      )
      if (changes(manual) !== 1) throw new CodexBindingRepositoryError('manual_quarantine_cas_failed')
      const thread = this.requireThread(row.thread_binding_id)
      if (
        thread.ready_conversation_alias !== input.aliasId
        || thread.alias_generation !== input.aliasGeneration
        || thread.retired_at
      ) throw new CodexBindingRepositoryError('manual_quarantine_alias_mismatch')
      const retired = this.db.prepare(`
        UPDATE codex_thread_bindings
           SET retired_at = ?, retired_reason = 'manual_compaction_quarantine',
               retirement_evidence_digest = ?, revision = revision + 1, updated_at = ?
         WHERE thread_binding_id = ? AND revision = ? AND retired_at IS NULL
      `).run(
        input.quarantinedAt,
        input.evidenceDigest,
        input.quarantinedAt,
        row.thread_binding_id,
        thread.revision,
      )
      if (changes(retired) !== 1) throw new CodexBindingRepositoryError('manual_quarantine_thread_cas_failed')
      const fence = this.db.prepare(`
        UPDATE codex_thread_dispatch_fences
           SET quarantined_at = ?, quarantine_reason = ?, revision = revision + 1
         WHERE thread_binding_id = ? AND owner_manual_compaction_id = ?
           AND quarantined_at IS NULL
      `).run(
        input.quarantinedAt,
        input.reason,
        row.thread_binding_id,
        input.manualCompactionId,
      )
      if (changes(fence) !== 1) throw new CodexBindingRepositoryError('manual_quarantine_fence_release_failed')
      const nextAliasGeneration = thread.alias_generation + 1
      const newThreadBindingId = this.nextThreadBindingId(
        thread.ready_conversation_alias,
        nextAliasGeneration,
        input.evidenceDigest,
      )
      this.insertEmptyAliasGenerationInOpenTransaction({
        threadBindingId: newThreadBindingId,
        aliasId: thread.ready_conversation_alias,
        aliasGeneration: nextAliasGeneration,
        readyScopeId: thread.ready_scope_id,
        runtimeManifestDigest: thread.runtime_manifest_digest,
        protocolSchemaDigest: thread.protocol_schema_digest,
        createdAt: input.quarantinedAt,
      })
      const visibility = advanceCodexConversationMessageVisibilityInOpenTransaction(this.db, {
        scopeId: thread.ready_scope_id,
        resetAt: input.quarantinedAt,
      })
      return {
        aliasId: thread.ready_conversation_alias,
        retiredGeneration: thread.alias_generation,
        nextAliasGeneration,
        newThreadBindingId,
        transactionDigest: digest({
          aliasId: thread.ready_conversation_alias,
          retiredGeneration: thread.alias_generation,
          nextAliasGeneration,
          newThreadBindingId,
          manualCompactionId: input.manualCompactionId,
          evidenceDigest: input.evidenceDigest,
        }),
        messageVisibilityEpoch: visibility.messageVisibilityEpoch,
      }
    })
  }

  reconcileQuarantinedManualCompaction(input: {
    manualCompactionId: string
    threadReadDigest: string
    reconciledAt: string
  }): { archiveIntentDigest: string | null } {
    for (const value of [input.manualCompactionId, input.threadReadDigest, input.reconciledAt]) {
      nonEmpty(value, 'manual_reconciliation_identity_invalid')
    }
    return this.immediate(() => {
      const row = this.db.prepare(`
        SELECT manual_compaction_id, thread_binding_id, abandoned_at,
               abandoned_reconciled_at, revision
          FROM codex_manual_compaction_bindings WHERE manual_compaction_id = ?
      `).get<{
        manual_compaction_id: string
        thread_binding_id: string
        abandoned_at: string | null
        abandoned_reconciled_at: string | null
        revision: number
      }>(input.manualCompactionId)
      if (!row?.abandoned_at) {
        throw new CodexBindingRepositoryError('manual_compaction_not_abandoned')
      }
      if (!row.abandoned_reconciled_at) {
        const manual = this.db.prepare(`
          UPDATE codex_manual_compaction_bindings
             SET abandoned_reconciled_at = ?, revision = revision + 1, updated_at = ?
           WHERE manual_compaction_id = ? AND revision = ?
             AND abandoned_at IS NOT NULL AND abandoned_reconciled_at IS NULL
        `).run(
          input.reconciledAt,
          input.reconciledAt,
          input.manualCompactionId,
          row.revision,
        )
        if (changes(manual) !== 1) {
          throw new CodexBindingRepositoryError('manual_reconciliation_cas_failed')
        }
        const fence = this.db.prepare(`
          DELETE FROM codex_thread_dispatch_fences
           WHERE thread_binding_id = ? AND owner_manual_compaction_id = ?
             AND quarantined_at IS NOT NULL
        `).run(row.thread_binding_id, input.manualCompactionId)
        if (changes(fence) !== 1) {
          throw new CodexBindingRepositoryError('manual_reconciliation_fence_release_failed')
        }
      }
      const thread = this.requireThread(row.thread_binding_id)
      if (thread.retired_reason !== 'manual_compaction_quarantine'
        || !thread.retired_at || !thread.retirement_evidence_digest) {
        throw new CodexBindingRepositoryError('manual_reconciliation_thread_retirement_missing')
      }
      const successor = this.db.prepare(`
        SELECT thread_binding_id, alias_generation FROM codex_thread_bindings
         WHERE ready_conversation_alias = ? AND alias_generation = ? LIMIT 1
      `).get<{ thread_binding_id: string; alias_generation: number }>(
        thread.ready_conversation_alias,
        thread.alias_generation + 1,
      )
      if (!successor) throw new CodexBindingRepositoryError('manual_reconciliation_successor_missing')
      if (thread.codex_thread_id) this.assertThreadArchiveEligible(thread.codex_thread_id)
      const retirementTransactionDigest = digest({
        aliasId: thread.ready_conversation_alias,
        retiredGeneration: thread.alias_generation,
        nextAliasGeneration: successor.alias_generation,
        newThreadBindingId: successor.thread_binding_id,
        manualCompactionId: input.manualCompactionId,
        evidenceDigest: thread.retirement_evidence_digest,
      })
      return {
        archiveIntentDigest: this.recordThreadArchiveIntentInOpenTransaction({
          thread,
          sourceKind: 'manual_compaction_quarantine',
          retiredReason: 'manual_compaction_quarantine',
          readyRunId: null,
          retirementEvidenceDigest: thread.retirement_evidence_digest,
          retirementTransactionDigest,
          retiredAt: thread.retired_at,
        }),
      }
    })
  }

  recordThreadResumeEvidence(input: {
    aliasId: string
    aliasGeneration: number
    threadId: string
    connectionEpoch: string
    preResumeThreadReadDigest: string
    resumedThreadDigest: string
    recordedAt: string
  }): { resumeEvidenceId: string; evidenceDigest: string } {
    for (const value of [
      input.aliasId,
      input.threadId,
      input.connectionEpoch,
      input.preResumeThreadReadDigest,
      input.resumedThreadDigest,
      input.recordedAt,
    ]) nonEmpty(value, 'thread_resume_evidence_invalid')
    safePositive(input.aliasGeneration, 'thread_resume_generation_invalid')
    return this.immediate(() => {
      const thread = this.db.prepare(`
        SELECT thread_binding_id, codex_thread_id
          FROM codex_thread_bindings
         WHERE ready_conversation_alias = ? AND alias_generation = ?
           AND retired_at IS NULL
         LIMIT 1
      `).get<{
        thread_binding_id: string
        codex_thread_id: string | null
      }>(input.aliasId, input.aliasGeneration)
      const lease = this.db.prepare(`
        SELECT connection_epoch FROM codex_sidecar_process_leases
         WHERE connection_epoch = ? AND connection_opened_at IS NOT NULL
           AND closed_at IS NULL
           AND tree_zero_at IS NULL
         LIMIT 1
      `).get<{ connection_epoch: string }>(input.connectionEpoch)
      if (!thread || thread.codex_thread_id !== input.threadId || !lease) {
        throw new CodexBindingRepositoryError('thread_resume_evidence_parent_mismatch')
      }
      const evidence = {
        contract: 'codex_thread_read_before_resume_v1',
        threadBindingId: thread.thread_binding_id,
        codexThreadId: input.threadId,
        connectionEpoch: input.connectionEpoch,
        preResumeThreadReadDigest: input.preResumeThreadReadDigest,
        resumedThreadDigest: input.resumedThreadDigest,
      }
      const evidenceDigest = digest(evidence)
      const resumeEvidenceId = `resume-${evidenceDigest}`
      const existing = this.db.prepare(`
        SELECT resume_evidence_id, evidence_digest
          FROM codex_thread_resume_evidence
         WHERE thread_binding_id = ? AND connection_epoch = ?
         LIMIT 1
      `).get<{ resume_evidence_id: string; evidence_digest: string }>(
        thread.thread_binding_id,
        input.connectionEpoch,
      )
      if (existing) {
        if (existing.resume_evidence_id !== resumeEvidenceId
          || existing.evidence_digest !== evidenceDigest) {
          throw new CodexBindingRepositoryError('thread_resume_evidence_conflict')
        }
        return { resumeEvidenceId, evidenceDigest }
      }
      this.db.prepare(`
        INSERT INTO codex_thread_resume_evidence (
          resume_evidence_id, thread_binding_id, codex_thread_id, connection_epoch,
          pre_resume_thread_read_digest, resumed_thread_digest, evidence_digest, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        resumeEvidenceId,
        thread.thread_binding_id,
        input.threadId,
        input.connectionEpoch,
        input.preResumeThreadReadDigest,
        input.resumedThreadDigest,
        evidenceDigest,
        input.recordedAt,
      )
      const readback = this.db.prepare(`
        SELECT evidence_digest FROM codex_thread_resume_evidence
         WHERE resume_evidence_id = ?
      `).get<{ evidence_digest: string }>(resumeEvidenceId)
      if (readback?.evidence_digest !== evidenceDigest) {
        throw new CodexBindingRepositoryError('thread_resume_evidence_readback_failed')
      }
      return { resumeEvidenceId, evidenceDigest }
    })
  }

  createProcessLeaseIntent(input: CodexProcessLeaseIdentity & {
    spawnIntentAt: string
    spawnVisibilityDeadlineAt: string
  }): CodexProcessLeaseRow {
    this.assertDistinctProcessIdentities(input)
    return this.immediate(() => {
      this.db.prepare(`
        INSERT INTO codex_sidecar_process_leases (
          process_lease_id, singleton_slot, owner_main_boot_id, owner_main_pid,
          owner_main_process_start_identity, sidecar_spawn_instance_id, connection_epoch,
          runtime_manifest_digest, binary_sha256, executable_path, isolated_state_dir,
          spawn_intent_at, spawn_visibility_deadline_at, revision
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        input.processLeaseId,
        input.ownerMainBootId,
        input.ownerMainPid,
        input.ownerMainProcessStartIdentity,
        input.sidecarSpawnInstanceId,
        input.connectionEpoch,
        input.runtimeManifestDigest,
        input.binarySha256,
        input.executablePath,
        input.isolatedStateDir,
        input.spawnIntentAt,
        input.spawnVisibilityDeadlineAt,
      )
      return this.requireProcessLease(input.processLeaseId)
    })
  }

  confirmProcessLeaseOwnership(input: {
    processLeaseId: string
    expectedRevision: number
    pid: number
    processGroupId: number
    processStartIdentity: string
    confirmedAt: string
  }): CodexProcessLeaseRow {
    safePositive(input.pid, 'sidecar_pid_invalid')
    safePositive(input.processGroupId, 'sidecar_process_group_invalid')
    nonEmpty(input.processStartIdentity, 'sidecar_process_start_identity_invalid')
    return this.immediate(() => {
      const result = this.db.prepare(`
        UPDATE codex_sidecar_process_leases
           SET pid = ?, process_group_id = ?, process_start_identity = ?,
               ownership_confirmed_at = ?, revision = revision + 1
         WHERE process_lease_id = ? AND revision = ?
           AND pid IS NULL AND ownership_confirmed_at IS NULL AND tree_zero_at IS NULL
      `).run(
        input.pid,
        input.processGroupId,
        input.processStartIdentity,
        input.confirmedAt,
        input.processLeaseId,
        input.expectedRevision,
      )
      if (changes(result) !== 1) throw new CodexBindingRepositoryError('process_lease_ownership_cas_failed')
      return this.requireProcessLease(input.processLeaseId)
    })
  }

  markProcessConnectionOpened(input: {
    processLeaseId: string
    expectedRevision: number
    openedAt: string
  }): CodexProcessLeaseRow {
    return this.updateProcessLease(
      input.processLeaseId,
      input.expectedRevision,
      'connection_opened_at = ?',
      [input.openedAt],
      'connection_opened_at IS NULL AND ownership_confirmed_at IS NOT NULL',
    )
  }

  markProcessConnectionClosed(input: {
    processLeaseId: string
    expectedRevision: number
    closedAt: string
  }): CodexProcessLeaseRow {
    return this.updateProcessLease(
      input.processLeaseId,
      input.expectedRevision,
      'closed_at = ?',
      [input.closedAt],
      'closed_at IS NULL AND tree_zero_at IS NULL',
    )
  }

  recordOldMainDeath(input: {
    processLeaseId: string
    expectedRevision: number
    deadAt: string
    evidenceDigest: string
  }): CodexProcessLeaseRow {
    return this.updateProcessLease(
      input.processLeaseId,
      input.expectedRevision,
      'owner_main_dead_at = ?, owner_main_death_evidence_digest = ?',
      [input.deadAt, input.evidenceDigest],
      'owner_main_dead_at IS NULL',
    )
  }

  recordProcessTreeZero(input: {
    processLeaseId: string
    expectedRevision: number
    treeZeroAt: string
    matcherMode: 'pre_cas' | 'post_cas'
    sampleTranscriptDigest: string
    evidenceDigest: string
  }): CodexProcessLeaseRow {
    return this.updateProcessLease(
      input.processLeaseId,
      input.expectedRevision,
      `tree_zero_at = ?, tree_zero_matcher_mode = ?,
       stable_zero_sample_transcript_digest = ?, tree_zero_evidence_digest = ?`,
      [
        input.treeZeroAt,
        input.matcherMode,
        input.sampleTranscriptDigest,
        input.evidenceDigest,
      ],
      'tree_zero_at IS NULL',
    )
  }

  readLiveProcessLease(): CodexProcessLeaseRow | null {
    const row = this.db.prepare(`
      SELECT * FROM codex_sidecar_process_leases WHERE tree_zero_at IS NULL LIMIT 1
    `).get<ProcessLeaseDbRow>()
    return row ? processLeaseFromRow(row) : null
  }

  readProcessLeaseByConnectionEpoch(connectionEpoch: string): CodexProcessLeaseRow | null {
    nonEmpty(connectionEpoch, 'connection_epoch_invalid')
    const row = this.db.prepare(`
      SELECT * FROM codex_sidecar_process_leases
       WHERE connection_epoch = ? LIMIT 1
    `).get<ProcessLeaseDbRow>(connectionEpoch)
    return row ? processLeaseFromRow(row) : null
  }

  readLatestProcessLeaseByOwnerMainBootId(ownerMainBootId: string): CodexProcessLeaseRow | null {
    nonEmpty(ownerMainBootId, 'owner_main_boot_id_invalid')
    const row = this.db.prepare(`
      SELECT * FROM codex_sidecar_process_leases
       WHERE owner_main_boot_id = ?
       ORDER BY spawn_intent_at DESC LIMIT 1
    `).get<ProcessLeaseDbRow>(ownerMainBootId)
    return row ? processLeaseFromRow(row) : null
  }

  private completeProductTurnCloseoutInOpenTransaction(
    input: { readyRunId: string; productTerminalDigest: string; closeoutAt: string },
    turn = this.requireTurn(input.readyRunId),
  ): void {
    if (turn.host_failure_kind || turn.host_failure_product_terminal_digest
      || turn.recovery_failure_code) {
      throw new CodexBindingRepositoryError('product_closeout_kind_conflict')
    }
    if (turn.product_terminal_digest) {
      if (
        turn.product_terminal_digest !== input.productTerminalDigest
        || turn.product_closeout_at !== input.closeoutAt
        || turn.fence_release_revision === null
      ) throw new CodexBindingRepositoryError('product_terminal_immutable')
      this.assertProductFenceReleased(turn.thread_binding_id, input.readyRunId)
      return
    }
    if (
      !turn.codex_turn_id
      || !turn.turn_start_reconciled_at
      || !turn.turn_start_reservation_released_at
      || !turn.engine_terminal_recorded_at
      || !turn.engine_terminal_status
      || !turn.engine_terminal_candidate_digest
    ) throw new CodexBindingRepositoryError('product_turn_not_reconciled')
    this.assertEngineTerminalPublicationMatchesReady(
      turn,
      input.closeoutAt,
      input.productTerminalDigest,
    )
    const fence = this.requireProductFenceForRelease(turn.thread_binding_id, input.readyRunId)
    const fenceReleaseRevision = fence.revision + 1
    const turnUpdate = this.db.prepare(`
      UPDATE codex_turn_bindings
         SET product_terminal_digest = ?, product_closeout_at = ?,
             fence_release_revision = ?,
             revision = revision + 1, updated_at = ?
       WHERE ready_run_id = ? AND revision = ? AND product_terminal_digest IS NULL
    `).run(
      input.productTerminalDigest,
      input.closeoutAt,
      fenceReleaseRevision,
      input.closeoutAt,
      input.readyRunId,
      turn.revision,
    )
    if (changes(turnUpdate) !== 1) throw new CodexBindingRepositoryError('product_terminal_cas_failed')
    const fenceDelete = this.db.prepare(`
      DELETE FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND owner_ready_run_id = ? AND revision = ?
    `).run(turn.thread_binding_id, input.readyRunId, fence.revision)
    if (changes(fenceDelete) !== 1) throw new CodexBindingRepositoryError('product_fence_release_failed')
  }

  private completeRecoveryFailureCloseout(input: {
    readyRunId: string
    productTerminalDigest: string
    closeoutAt: string
    recoveryFailureCode: string
    recoveryFailureEvidenceDigest: string
  }, turn: TurnBindingRow): void {
    const thread = this.requireThread(turn.thread_binding_id)
    if (turn.product_terminal_digest) {
      if (
        turn.product_terminal_digest !== input.productTerminalDigest
        || turn.product_closeout_at !== input.closeoutAt
        || turn.recovery_failure_code !== input.recoveryFailureCode
        || turn.recovery_failure_evidence_digest !== input.recoveryFailureEvidenceDigest
        || turn.recovery_failure_recorded_at !== input.closeoutAt
        || turn.fence_release_revision === null
      ) throw new CodexBindingRepositoryError('recovery_failure_terminal_immutable')
      if (
        thread.continuation_blocked_at !== input.closeoutAt
        || thread.continuation_blocked_reason !== 'publication_diverged'
        || thread.continuation_blocked_evidence_digest !== input.recoveryFailureEvidenceDigest
        || thread.retired_at !== input.closeoutAt
        || thread.retired_reason !== 'publication_diverged'
        || thread.retirement_evidence_digest !== input.recoveryFailureEvidenceDigest
      ) throw new CodexBindingRepositoryError('recovery_failure_closeout_incomplete')
      this.assertProductFenceReleased(turn.thread_binding_id, input.readyRunId)
      return
    }
    if (turn.recovery_failure_code || turn.recovery_failure_evidence_digest
      || turn.recovery_failure_recorded_at) {
      throw new CodexBindingRepositoryError('recovery_failure_evidence_conflict')
    }
    if (thread.continuation_blocked_at || thread.retired_at) {
      throw new CodexBindingRepositoryError('recovery_failure_thread_already_closed')
    }
    const fence = this.requireProductFenceForRelease(turn.thread_binding_id, input.readyRunId)
    const fenceReleaseRevision = fence.revision + 1
    const turnUpdate = this.db.prepare(`
      UPDATE codex_turn_bindings
         SET recovery_failure_code = ?, recovery_failure_evidence_digest = ?,
             recovery_failure_recorded_at = ?, product_terminal_digest = ?,
             product_closeout_at = ?, fence_release_revision = ?,
             turn_start_reservation_released_at = COALESCE(turn_start_reservation_released_at, ?),
             turn_start_reservation_release_reason = COALESCE(
               turn_start_reservation_release_reason, 'product_recovery_failure'
             ),
             revision = revision + 1, updated_at = ?
       WHERE ready_run_id = ? AND revision = ? AND product_terminal_digest IS NULL
         AND recovery_failure_code IS NULL
    `).run(
      input.recoveryFailureCode,
      input.recoveryFailureEvidenceDigest,
      input.closeoutAt,
      input.productTerminalDigest,
      input.closeoutAt,
      fenceReleaseRevision,
      input.closeoutAt,
      input.closeoutAt,
      input.readyRunId,
      turn.revision,
    )
    if (changes(turnUpdate) !== 1) {
      throw new CodexBindingRepositoryError('recovery_failure_terminal_cas_failed')
    }
    const threadUpdate = this.db.prepare(`
      UPDATE codex_thread_bindings
         SET thread_start_reservation_released_at = COALESCE(thread_start_reservation_released_at, ?),
             thread_start_reservation_release_reason = COALESCE(
               thread_start_reservation_release_reason, 'product_recovery_failure'
             ),
             continuation_blocked_at = ?, continuation_blocked_reason = 'publication_diverged',
             continuation_blocked_evidence_digest = ?, retired_at = ?,
             retired_reason = 'publication_diverged', retirement_evidence_digest = ?,
             revision = revision + 1, updated_at = ?
       WHERE thread_binding_id = ? AND revision = ?
         AND continuation_blocked_at IS NULL AND retired_at IS NULL
    `).run(
      input.closeoutAt,
      input.closeoutAt,
      input.recoveryFailureEvidenceDigest,
      input.closeoutAt,
      input.recoveryFailureEvidenceDigest,
      input.closeoutAt,
      thread.thread_binding_id,
      thread.revision,
    )
    if (changes(threadUpdate) !== 1) {
      throw new CodexBindingRepositoryError('recovery_failure_thread_cas_failed')
    }
    const fenceDelete = this.db.prepare(`
      DELETE FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND owner_ready_run_id = ? AND revision = ?
    `).run(turn.thread_binding_id, input.readyRunId, fence.revision)
    if (changes(fenceDelete) !== 1) {
      throw new CodexBindingRepositoryError('product_fence_release_failed')
    }
    if (!turn.codex_thread_id) {
      throw new CodexBindingRepositoryError('recovery_failure_thread_identity_missing')
    }
    this.assertThreadArchiveEligible(turn.codex_thread_id)
    const retirementTransactionDigest = digest({
      contract: 'codex_recovery_failure_retirement_v1',
      readyRunId: input.readyRunId,
      threadBindingId: thread.thread_binding_id,
      recoveryFailureCode: input.recoveryFailureCode,
      retirementEvidenceDigest: input.recoveryFailureEvidenceDigest,
      productTerminalDigest: input.productTerminalDigest,
      closeoutAt: input.closeoutAt,
    })
    this.recordThreadArchiveIntentInOpenTransaction({
      thread,
      sourceKind: 'publication_divergence',
      retiredReason: 'publication_diverged',
      readyRunId: input.readyRunId,
      retirementEvidenceDigest: input.recoveryFailureEvidenceDigest,
      retirementTransactionDigest,
      retiredAt: input.closeoutAt,
    })
  }

  private completeHostFailureCloseoutInOpenTransaction(input: {
    readyRunId: string
    productTerminalDigest: string
    continuationBlockedReason: 'start_delivery_absent' | 'publication_diverged'
    closeoutAt: string
  }): { reservationSetId: string } {
    const turn = this.requireTurn(input.readyRunId)
    if (!turn.host_failure_kind || !turn.host_failure_evidence_digest) {
      throw new CodexBindingRepositoryError('host_failure_evidence_missing')
    }
    if (turn.product_terminal_digest) {
      throw new CodexBindingRepositoryError('product_closeout_kind_conflict')
    }
    const thread = this.requireThread(turn.thread_binding_id)
    if (turn.host_failure_product_terminal_digest) {
      if (
        turn.host_failure_product_terminal_digest !== input.productTerminalDigest
        || turn.host_failure_closeout_at !== input.closeoutAt
        || turn.fence_release_revision === null
      ) {
        throw new CodexBindingRepositoryError('host_failure_terminal_immutable')
      }
      if (
        !turn.turn_start_reservation_released_at
        || !thread.continuation_blocked_at
      ) throw new CodexBindingRepositoryError('host_failure_closeout_incomplete')
      if (
        thread.continuation_blocked_at !== input.closeoutAt
        || thread.continuation_blocked_reason !== input.continuationBlockedReason
        || thread.continuation_blocked_evidence_digest !== turn.host_failure_evidence_digest
      ) throw new CodexBindingRepositoryError('host_failure_closeout_immutable')
      this.assertProductFenceReleased(thread.thread_binding_id, input.readyRunId)
      return { reservationSetId: turn.start_reservation_set_id }
    }
    const productFence = this.requireProductFenceForRelease(thread.thread_binding_id, input.readyRunId)
    const fenceReleaseRevision = productFence.revision + 1
    const turnUpdate = this.db.prepare(`
      UPDATE codex_turn_bindings
         SET host_failure_product_terminal_digest = ?, host_failure_closeout_at = ?,
             fence_release_revision = ?,
             turn_start_reservation_released_at = COALESCE(turn_start_reservation_released_at, ?),
             turn_start_reservation_release_reason = COALESCE(
               turn_start_reservation_release_reason, 'host_failure_product_terminal'
             ),
             revision = revision + 1, updated_at = ?
       WHERE ready_run_id = ? AND revision = ?
         AND host_failure_product_terminal_digest IS NULL
    `).run(
      input.productTerminalDigest,
      input.closeoutAt,
      fenceReleaseRevision,
      input.closeoutAt,
      input.closeoutAt,
      input.readyRunId,
      turn.revision,
    )
    if (changes(turnUpdate) !== 1) throw new CodexBindingRepositoryError('host_failure_terminal_cas_failed')
    if (thread.thread_start_reservation_released_at === null) {
      const threadUpdate = this.db.prepare(`
        UPDATE codex_thread_bindings
           SET thread_start_reservation_released_at = ?,
               thread_start_reservation_release_reason = 'host_failure_product_terminal',
               continuation_blocked_at = ?, continuation_blocked_reason = ?,
               continuation_blocked_evidence_digest = ?,
               revision = revision + 1, updated_at = ?
         WHERE thread_binding_id = ? AND revision = ?
           AND thread_start_reservation_released_at IS NULL
      `).run(
        input.closeoutAt,
        input.closeoutAt,
        input.continuationBlockedReason,
        turn.host_failure_evidence_digest,
        input.closeoutAt,
        thread.thread_binding_id,
        thread.revision,
      )
      if (changes(threadUpdate) !== 1) throw new CodexBindingRepositoryError('thread_member_release_cas_failed')
    } else {
      const threadUpdate = this.db.prepare(`
        UPDATE codex_thread_bindings
           SET continuation_blocked_at = ?, continuation_blocked_reason = ?,
               continuation_blocked_evidence_digest = ?, revision = revision + 1, updated_at = ?
         WHERE thread_binding_id = ? AND revision = ? AND continuation_blocked_at IS NULL
      `).run(
        input.closeoutAt,
        input.continuationBlockedReason,
        turn.host_failure_evidence_digest,
        input.closeoutAt,
        thread.thread_binding_id,
        thread.revision,
      )
      if (changes(threadUpdate) !== 1) throw new CodexBindingRepositoryError('continuation_blocker_cas_failed')
    }
    const fence = this.db.prepare(`
      DELETE FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND owner_ready_run_id = ? AND revision = ?
    `).run(thread.thread_binding_id, input.readyRunId, productFence.revision)
    if (changes(fence) !== 1) throw new CodexBindingRepositoryError('product_fence_release_failed')
    return { reservationSetId: turn.start_reservation_set_id }
  }

  private assertProductFenceReleased(threadBindingId: string, readyRunId: string): void {
    const fence = this.db.prepare(`
      SELECT owner_ready_run_id FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND operation_kind = 'product_turn'
         AND owner_ready_run_id = ? LIMIT 1
    `).get(threadBindingId, readyRunId)
    if (fence) throw new CodexBindingRepositoryError('product_fence_owner_mismatch')
  }

  private assertEngineTerminalPublicationMatchesReady(
    turn: TurnBindingRow,
    closeoutAt: string,
    productTerminalDigest: string,
  ): void {
    const receipt = this.readEngineTerminalCandidate(turn.ready_run_id)
    if (!receipt) throw new CodexBindingRepositoryError('engine_terminal_receipt_missing')
    const candidate = receipt.candidate as NativeTerminalCandidate
    const thread = this.requireThread(turn.thread_binding_id)
    const publication = this.readToolPublicationReceipt(turn.ready_run_id)
    const projection = this.db.prepare(`
      SELECT status FROM task_projections
       WHERE task_id = ? AND run_id = ? LIMIT 1
    `).get<{ status: string }>(turn.ready_task_id, turn.ready_run_id)
    const messageId = `assistant:${turn.ready_task_id}:${turn.ready_run_id}:terminal`
    const message = this.db.prepare(`
      SELECT conversation_id, role, content, timestamp, meta_json
        FROM chat_messages WHERE id = ? LIMIT 1
    `).get<{
      conversation_id: string
      role: string
      content: string
      timestamp: string
      meta_json: string
    }>(messageId)
    let canonicalDigest = ''
    try {
      canonicalDigest = message ? workflowDigest({
        id: messageId,
        conversationId: message.conversation_id,
        role: 'assistant',
        content: message.content,
        timestamp: message.timestamp,
        meta: JSON.parse(message.meta_json),
      }) : ''
    } catch {
      canonicalDigest = ''
    }
    const canonicalFailureMessageMatches = Boolean(
      message
      && message.conversation_id === thread.ready_scope_id
      && message.role === 'assistant'
      && message.timestamp === closeoutAt
      && canonicalDigest === productTerminalDigest,
    )
    if (thread.continuation_blocked_reason === 'publication_diverged') {
      if (!projection
        || !['failed', 'killed'].includes(projection.status)
        || !canonicalFailureMessageMatches) {
        throw new CodexBindingRepositoryError('engine_terminal_publication_mismatch')
      }
      return
    }
    if (!publication) throw new CodexBindingRepositoryError('publication_receipt_missing')
    if (candidate.candidateSelection.kind === 'accepted') {
      if (candidate.engineOutcome !== 'completed'
        || projection?.status !== 'completed'
        || !message
        || message.conversation_id !== thread.ready_scope_id
        || message.role !== 'assistant'
        || message.timestamp !== closeoutAt
        || createHash('sha256').update(message.content).digest('hex') !== candidate.candidateDigest
        || canonicalDigest !== productTerminalDigest) {
        throw new CodexBindingRepositoryError('engine_terminal_publication_mismatch')
      }
      return
    }
    if (!projection
      || !['failed', 'killed'].includes(projection.status)
      || !canonicalFailureMessageMatches) {
      throw new CodexBindingRepositoryError('engine_terminal_publication_mismatch')
    }
  }

  private updateManualAttempt(
    input:
      | { connectionEpoch: string; rpcId: number; manualCompactionId: string; attemptedAt: string }
      | { connectionEpoch: string; rpcId: number; manualCompactionId: string; childWriteDigest: string; confirmedAt: string }
      | { connectionEpoch: string; rpcId: number; manualCompactionId: string; reason: 'response_timeout' | 'child_write_error' | 'connection_closed'; unresolvedAt: string }
      | { connectionEpoch: string; rpcId: number; manualCompactionId: string; responseKind: 'accepted' | 'rejected'; responseDigest: string; responseAt: string },
    kind: 'attempted' | 'confirmed' | 'unresolved' | 'response',
  ): void {
    for (const value of [input.connectionEpoch, input.manualCompactionId]) {
      nonEmpty(value, 'manual_attempt_identity_invalid')
    }
    safePositive(input.rpcId, 'manual_attempt_rpc_id_invalid')
    this.immediate(() => {
      const row = this.db.prepare(`
        SELECT child_write_attempted_at, child_write_confirmed_at, child_write_digest,
               unresolved_at, unresolved_reason, response_kind, response_digest,
               response_at, revision
          FROM codex_manual_compaction_dispatch_attempts
         WHERE manual_compaction_id = ? AND connection_epoch = ? AND rpc_id = ?
      `).get<{
        child_write_attempted_at: string | null
        child_write_confirmed_at: string | null
        child_write_digest: string | null
        unresolved_at: string | null
        unresolved_reason: string | null
        response_kind: 'accepted' | 'rejected' | null
        response_digest: string | null
        response_at: string | null
        revision: number
      }>(input.manualCompactionId, input.connectionEpoch, input.rpcId)
      if (!row) throw new CodexBindingRepositoryError('manual_attempt_not_found')
      if (kind === 'attempted') {
        const exact = input as Extract<typeof input, { attemptedAt: string }>
        if (row.child_write_attempted_at) return
        const update = this.db.prepare(`
          UPDATE codex_manual_compaction_dispatch_attempts
             SET child_write_attempted_at = ?, revision = revision + 1, updated_at = ?
           WHERE manual_compaction_id = ? AND connection_epoch = ? AND rpc_id = ?
             AND revision = ? AND child_write_attempted_at IS NULL
        `).run(
          exact.attemptedAt, exact.attemptedAt, input.manualCompactionId,
          input.connectionEpoch, input.rpcId, row.revision,
        )
        if (changes(update) !== 1) throw new CodexBindingRepositoryError('manual_attempt_write_cas_failed')
        return
      }
      if (kind === 'confirmed') {
        const exact = input as Extract<typeof input, { confirmedAt: string }>
        if (!row.child_write_attempted_at) throw new CodexBindingRepositoryError('manual_write_not_attempted')
        if (row.child_write_confirmed_at) {
          if (row.child_write_digest !== exact.childWriteDigest) {
            throw new CodexBindingRepositoryError('manual_write_confirmation_conflict')
          }
          return
        }
        const update = this.db.prepare(`
          UPDATE codex_manual_compaction_dispatch_attempts
             SET child_write_confirmed_at = ?, child_write_digest = ?,
                 revision = revision + 1, updated_at = ?
           WHERE manual_compaction_id = ? AND connection_epoch = ? AND rpc_id = ?
             AND revision = ? AND child_write_attempted_at IS NOT NULL
             AND child_write_confirmed_at IS NULL
        `).run(
          exact.confirmedAt, exact.childWriteDigest, exact.confirmedAt,
          input.manualCompactionId, input.connectionEpoch, input.rpcId, row.revision,
        )
        if (changes(update) !== 1) throw new CodexBindingRepositoryError('manual_write_confirmation_cas_failed')
        return
      }
      if (kind === 'unresolved') {
        const exact = input as Extract<typeof input, { unresolvedAt: string }>
        if (row.response_kind || row.unresolved_at) return
        const update = this.db.prepare(`
          UPDATE codex_manual_compaction_dispatch_attempts
             SET unresolved_at = ?, unresolved_reason = ?,
                 revision = revision + 1, updated_at = ?
           WHERE manual_compaction_id = ? AND connection_epoch = ? AND rpc_id = ?
             AND revision = ? AND unresolved_at IS NULL AND response_kind IS NULL
        `).run(
          exact.unresolvedAt, exact.reason, exact.unresolvedAt,
          input.manualCompactionId, input.connectionEpoch, input.rpcId, row.revision,
        )
        if (changes(update) !== 1) throw new CodexBindingRepositoryError('manual_unresolved_cas_failed')
        return
      }
      const exact = input as Extract<typeof input, { responseAt: string }>
      if (row.response_kind) {
        if (row.response_kind !== exact.responseKind || row.response_digest !== exact.responseDigest) {
          throw new CodexBindingRepositoryError('manual_response_conflict')
        }
        return
      }
      const update = this.db.prepare(`
        UPDATE codex_manual_compaction_dispatch_attempts
           SET response_kind = ?, response_digest = ?, response_at = ?,
               revision = revision + 1, updated_at = ?
         WHERE manual_compaction_id = ? AND connection_epoch = ? AND rpc_id = ?
           AND revision = ? AND response_kind IS NULL
      `).run(
        exact.responseKind, exact.responseDigest, exact.responseAt, exact.responseAt,
        input.manualCompactionId, input.connectionEpoch, input.rpcId, row.revision,
      )
      if (changes(update) !== 1) throw new CodexBindingRepositoryError('manual_response_cas_failed')
    })
  }

  private requireProductFenceForRelease(
    threadBindingId: string,
    readyRunId: string,
  ): { revision: number } {
    const fence = this.db.prepare(`
      SELECT revision FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND operation_kind = 'product_turn'
         AND owner_ready_run_id = ? AND owner_manual_compaction_id IS NULL
         AND quarantined_at IS NULL
       LIMIT 1
    `).get<{ revision: number }>(threadBindingId, readyRunId)
    if (!fence) throw new CodexBindingRepositoryError('product_fence_owner_mismatch')
    return fence
  }

  private assertStartFenceNotQuarantined(threadBindingId: string, readyRunId: string): void {
    const fence = this.db.prepare(`
      SELECT owner_ready_run_id, quarantined_at FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND operation_kind = 'product_turn' LIMIT 1
    `).get<{ owner_ready_run_id: string | null; quarantined_at: string | null }>(threadBindingId)
    if (!fence || fence.owner_ready_run_id !== readyRunId) {
      throw new CodexBindingRepositoryError('start_dispatch_fence_mismatch')
    }
    if (fence.quarantined_at) {
      throw new CodexBindingRepositoryError('start_inbound_identity_unknown')
    }
  }

  private validateAdmission(input: CodexAdmittedBindingInput): void {
    const { prepared, reservation } = input
    try {
      assertReadyToolSurface(prepared.readyToolSurface)
      assertReadyTurnToolAuthorization(prepared.readyTurnToolAuthorization)
    } catch {
      throw new CodexBindingRepositoryError('admission_tool_snapshot_invalid')
    }
    if (prepared.readyTurnToolAuthorization.allowedToolNames.some(
      (toolName) => !prepared.readyToolSurface.toolNames.includes(toolName),
    )) throw new CodexBindingRepositoryError('admission_tool_authorization_mismatch')
    if (
      reservation.scopeId !== prepared.readyToolHostIdentity.scopeId
      || reservation.reservationSetId !== prepared.ingressBinding.reservationSetId
      || reservation.reservationEvidenceDigest !== prepared.ingressBinding.reservationEvidenceDigest
      || reservation.members.length !== (reservation.existingThread ? 1 : 2)
      || reservation.members[reservation.members.length - 1]?.method !== 'turn/start'
      || (!reservation.existingThread && reservation.members[0]?.method !== 'thread/start')
    ) throw new CodexBindingRepositoryError('admission_reservation_mismatch')
    safePositive(input.ingressAdmittedRevision, 'ingress_revision_invalid')
    if (!Number.isSafeInteger(input.messageVisibilityEpoch) || input.messageVisibilityEpoch < 0) {
      throw new CodexBindingRepositoryError('message_visibility_epoch_invalid')
    }
    for (const value of [
      input.ownerMainBootId,
      input.admittedAt,
      input.ingressAdmittedDigest,
      input.threadBindingId,
      input.isolatedThreadCwd,
      input.turnRequestId,
      input.runtimeManifestDigest,
      input.protocolSchemaDigest,
      input.instructionContractDigest,
      input.codexModel,
      input.upstreamProfileSnapshotRef,
      input.upstreamProfileSnapshotDigest,
      input.additionalContextDigest,
      input.turnContractDigest,
      input.readyParentReceipt.messageTimestamp,
      input.readyParentReceipt.messageMetaDigest,
      input.readyParentReceipt.executionBindingDigest,
    ]) nonEmpty(value, 'admission_identity_invalid')
    const { ingressAdmittedDigest: _, ...digestInput } = input
    if (input.ingressAdmittedDigest !== buildCodexIngressAdmittedDigest(digestInput)) {
      throw new CodexBindingRepositoryError('ingress_admission_digest_mismatch')
    }
  }

  private assertReadyParents(input: CodexAdmittedBindingInput): void {
    const scope = this.db.prepare(`
      SELECT id, message_visibility_epoch
        FROM chat_conversations WHERE id = ? AND closed_at IS NULL
    `).get<{ id: string; message_visibility_epoch: number }>(
      input.prepared.readyToolHostIdentity.scopeId,
    )
    const message = this.db.prepare(`
      SELECT message.id, message.conversation_id, message.role, message.content,
             message.timestamp, message.meta_json, message.message_visibility_epoch
        FROM chat_messages message
        JOIN chat_conversations scope ON scope.id = message.conversation_id
       WHERE message.id = ? AND scope.closed_at IS NULL
         AND message.message_visibility_epoch = scope.message_visibility_epoch
    `).get<{
      id: string
      conversation_id: string
      role: string
      content: string
      timestamp: string
      meta_json: string
      message_visibility_epoch: number
    }>(
      input.prepared.ingress.originUserMessageId,
    )
    const canonicalText = input.prepared.ingress.canonicalCurrentInputRef.input
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('')
    const task = this.db.prepare(`
      SELECT task_id, run_id, scope_id, status, execution_binding_json
        FROM task_projections WHERE task_id = ?
    `).get<{
      task_id: string
      run_id: string
      scope_id: string
      status: string
      execution_binding_json: string | null
    }>(input.prepared.taskId)
    const run = this.db.prepare(`
      SELECT run_id, task_id, scope_id, status, execution_binding_json
        FROM run_meta WHERE run_id = ?
    `).get<{
      run_id: string
      task_id: string | null
      scope_id: string | null
      status: string
      execution_binding_json: string | null
    }>(input.prepared.runId)
    if (!scope || !message || !task || !run) {
      throw new CodexBindingRepositoryError('ready_parent_mismatch')
    }
    let messageMetaDigest = ''
    let taskExecutionBindingDigest = ''
    let runExecutionBindingDigest = ''
    try {
      if (message) messageMetaDigest = digestCanonicalJson(JSON.parse(message.meta_json))
      taskExecutionBindingDigest = digestCanonicalJson(JSON.parse(task.execution_binding_json || ''))
      runExecutionBindingDigest = digestCanonicalJson(JSON.parse(run.execution_binding_json || ''))
    } catch {
      throw new CodexBindingRepositoryError('ready_parent_receipt_invalid')
    }
    if (
      scope.id !== input.prepared.readyToolHostIdentity.scopeId
      || scope.message_visibility_epoch !== input.messageVisibilityEpoch
      || message.conversation_id !== input.prepared.readyToolHostIdentity.scopeId
      || message.role !== 'user'
      || message.content !== canonicalText
      || message.timestamp !== input.readyParentReceipt.messageTimestamp
      || message.message_visibility_epoch !== input.messageVisibilityEpoch
      || messageMetaDigest !== input.readyParentReceipt.messageMetaDigest
      || task?.run_id !== input.prepared.runId
      || task.scope_id !== input.prepared.readyToolHostIdentity.scopeId
      || task.status !== 'running'
      || !task.execution_binding_json
      || run?.task_id !== input.prepared.taskId
      || run.scope_id !== input.prepared.readyToolHostIdentity.scopeId
      || run.status !== 'running'
      || run.execution_binding_json !== task.execution_binding_json
      || taskExecutionBindingDigest !== input.readyParentReceipt.executionBindingDigest
      || runExecutionBindingDigest !== input.readyParentReceipt.executionBindingDigest
    ) throw new CodexBindingRepositoryError('ready_parent_mismatch')
  }

  private reconcileThreadAccepted(input: {
    connectionEpoch: string
    rpcId: number
    bindingId: string
    nativeId: string
    nativeResult: unknown
    responseDigest: string
    responsePending: boolean
    reconciledAt: string
  }): void {
    if (!isRecord(input.nativeResult)) throw new CodexBindingRepositoryError('thread_result_invalid')
    const thread = normalizeCodexThread(input.nativeResult.thread)
    const instructionSources = input.nativeResult.instructionSources ?? []
    const row = this.requireThread(input.bindingId)
    this.assertStartRpc(row, this.startDescriptor('thread/start'), input)
    this.assertStartFenceNotQuarantined(
      row.thread_binding_id,
      this.readProductRunForThreadBinding(row.thread_binding_id),
    )
    if (
      !thread
      || thread.id !== input.nativeId
      || thread.sessionId !== thread.id
      || thread.parentThreadId !== null
      || thread.forkedFromId !== null
      || thread.cwd !== row.isolated_thread_cwd
      || thread.source !== 'vscode'
      || thread.threadSource !== null
      || thread.modelProvider !== 'ready_gateway'
      || !Array.isArray(instructionSources)
      || instructionSources.length !== 0
    ) throw new CodexBindingRepositoryError('thread_reconciliation_metadata_mismatch')
    if (row.thread_start_reconciled_at) {
      if (row.codex_thread_id !== thread.id) {
        throw new CodexBindingRepositoryError('thread_reconciliation_identity_conflict')
      }
      return
    }
    const evidenceDigest = digest({
      responseDigest: input.responseDigest,
      thread,
      instructionSources,
    })
    const update = this.db.prepare(`
      UPDATE codex_thread_bindings
         SET codex_thread_id = ?, codex_session_id = ?, codex_parent_thread_id = ?,
             codex_forked_from_id = ?, codex_source_json = ?, codex_thread_source_json = ?,
             thread_start_response_at = ?, thread_start_reconciled_at = ?,
             thread_start_reconciliation_evidence_digest = ?,
             thread_start_reservation_released_at = ?,
             thread_start_reservation_release_reason = 'native_identity_reconciled',
             thread_started_at = ?, revision = revision + 1, updated_at = ?
       WHERE thread_binding_id = ? AND revision = ?
         AND thread_start_reconciled_at IS NULL
         AND thread_start_reservation_released_at IS NULL
    `).run(
      thread.id,
      thread.sessionId,
      thread.parentThreadId,
      thread.forkedFromId,
      JSON.stringify(thread.source),
      JSON.stringify(thread.threadSource),
      input.responsePending ? null : input.reconciledAt,
      input.reconciledAt,
      evidenceDigest,
      input.reconciledAt,
      input.reconciledAt,
      input.reconciledAt,
      row.thread_binding_id,
      row.revision,
    )
    if (changes(update) !== 1) throw new CodexBindingRepositoryError('thread_reconciliation_cas_failed')
    this.db.prepare(`
      UPDATE codex_turn_bindings
         SET codex_thread_id = ?, revision = revision + 1, updated_at = ?
       WHERE thread_binding_id = ? AND codex_thread_id IS NULL
    `).run(thread.id, input.reconciledAt, row.thread_binding_id)
    const readback = this.requireThread(row.thread_binding_id)
    if (
      readback.codex_thread_id !== thread.id
      || readback.thread_start_reservation_released_at !== input.reconciledAt
    ) throw new CodexBindingRepositoryError('thread_reconciliation_readback_mismatch')
  }

  private reconcileTurnAccepted(input: {
    connectionEpoch: string
    rpcId: number
    bindingId: string
    nativeId: string
    nativeResult: unknown
    responseDigest: string
    responsePending: boolean
    reconciledAt: string
  }): void {
    if (!isRecord(input.nativeResult)) throw new CodexBindingRepositoryError('turn_result_invalid')
    const turn = normalizeCodexTurn(input.nativeResult.turn)
    const row = this.requireTurn(input.bindingId)
    const thread = this.requireThread(row.thread_binding_id)
    this.assertStartRpc(row, this.startDescriptor('turn/start'), input)
    this.assertStartFenceNotQuarantined(row.thread_binding_id, row.ready_run_id)
    if (
      !turn
      || turn.id !== input.nativeId
      || !thread.codex_thread_id
      || row.codex_thread_id !== thread.codex_thread_id
      || (row.gateway_claimed_codex_turn_id
        && row.gateway_claimed_codex_turn_id !== turn.id)
    ) throw new CodexBindingRepositoryError('turn_reconciliation_metadata_mismatch')
    if (row.turn_start_reconciled_at) {
      if (row.codex_turn_id !== turn.id) {
        throw new CodexBindingRepositoryError('turn_reconciliation_identity_conflict')
      }
      return
    }
    const evidenceDigest = digest({ responseDigest: input.responseDigest, turn })
    const update = this.db.prepare(`
      UPDATE codex_turn_bindings
         SET codex_turn_id = ?, turn_start_response_at = ?, turn_start_reconciled_at = ?,
             turn_start_reconciliation_evidence_digest = ?,
             turn_start_reservation_released_at = ?,
             turn_start_reservation_release_reason = 'native_identity_reconciled',
             revision = revision + 1, updated_at = ?
       WHERE ready_run_id = ? AND revision = ?
         AND turn_start_reconciled_at IS NULL
         AND turn_start_reservation_released_at IS NULL
    `).run(
      turn.id,
      input.responsePending ? null : input.reconciledAt,
      input.reconciledAt,
      evidenceDigest,
      input.reconciledAt,
      input.reconciledAt,
      row.ready_run_id,
      row.revision,
    )
    if (changes(update) !== 1) throw new CodexBindingRepositoryError('turn_reconciliation_cas_failed')
  }

  private readUpstreamProfileSnapshot(
    snapshotRef: string | null,
    snapshotDigest: string | null,
  ): CodexUpstreamProfileSnapshot {
    if (!snapshotRef || !snapshotDigest) {
      throw new CodexBindingRepositoryError('upstream_profile_snapshot_unavailable')
    }
    const row = this.db.prepare(`
      SELECT snapshot_digest, snapshot_json, credential_reference_id
        FROM ready_model_gateway_profile_snapshots
       WHERE snapshot_ref = ?
    `).get<{
      snapshot_digest: string
      snapshot_json: string
      credential_reference_id: string
    }>(snapshotRef)
    if (!row || row.snapshot_digest !== snapshotDigest) {
      throw new CodexBindingRepositoryError('upstream_profile_snapshot_unavailable')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(row.snapshot_json)
    } catch {
      throw new CodexBindingRepositoryError('upstream_profile_snapshot_invalid')
    }
    if (
      !isRecord(parsed)
      || digestCanonicalJson(parsed) !== snapshotDigest
      || parsed.credentialReferenceId !== row.credential_reference_id
    ) throw new CodexBindingRepositoryError('upstream_profile_snapshot_invalid')
    return parsed as CodexUpstreamProfileSnapshot
  }

  private readLatestClosedTurnUpstreamRoute(
    threadBindingId: string,
  ): ClosedTurnUpstreamRouteRow | null {
    return this.db.prepare(`
      SELECT effective_codex_model, effective_upstream_snapshot_ref,
             effective_upstream_snapshot_digest
        FROM codex_turn_bindings
       WHERE thread_binding_id = ?
         AND fence_release_revision IS NOT NULL
         AND (
           (product_terminal_digest IS NOT NULL AND product_closeout_at IS NOT NULL)
           OR
           (host_failure_product_terminal_digest IS NOT NULL
             AND host_failure_closeout_at IS NOT NULL)
         )
       ORDER BY created_at DESC, ready_run_id DESC
       LIMIT 1
    `).get<ClosedTurnUpstreamRouteRow>(threadBindingId) || null
  }

  private readActiveThreadByAlias(aliasId: string): ThreadBindingRow | null {
    return this.db.prepare(`
      SELECT * FROM codex_thread_bindings
       WHERE ready_conversation_alias = ? AND retired_at IS NULL LIMIT 1
    `).get<ThreadBindingRow>(aliasId) || null
  }

  private validateEmptyAlias(input: CodexEmptyAliasGenerationInput): void {
    safePositive(input.aliasGeneration, 'alias_generation_invalid')
    for (const value of [
      input.threadBindingId,
      input.aliasId,
      input.readyScopeId,
      input.runtimeManifestDigest,
      input.protocolSchemaDigest,
      input.createdAt,
    ]) nonEmpty(value, 'empty_alias_identity_invalid')
  }

  private supersedeIdleStartedAliasForRootContractChangeInOpenTransaction(input: {
    thread: ThreadBindingRow
    readyRunId: string
    createdAt: string
    runtimeManifestDigest: string
    protocolSchemaDigest: string
    previousToolSurfaceDigest: string | null
    currentToolSurfaceDigest: string | null
  }): void {
    if (this.db.inTransaction !== true) {
      throw new CodexBindingRepositoryError('alias_create_transaction_missing')
    }
    const replacementEvidenceDigest = digest({
      kind: 'idle_started_alias_root_contract_superseded',
      aliasId: input.thread.ready_conversation_alias,
      aliasGeneration: input.thread.alias_generation,
      threadBindingId: input.thread.thread_binding_id,
      previousRuntimeManifestDigest: input.thread.runtime_manifest_digest,
      previousProtocolSchemaDigest: input.thread.protocol_schema_digest,
      previousToolSurfaceDigest: input.previousToolSurfaceDigest,
      runtimeManifestDigest: input.runtimeManifestDigest,
      protocolSchemaDigest: input.protocolSchemaDigest,
      currentToolSurfaceDigest: input.currentToolSurfaceDigest,
    })
    const retired = this.db.prepare(`
      UPDATE codex_thread_bindings
         SET retired_at = ?, retired_reason = 'cleanup',
             retirement_evidence_digest = ?, revision = revision + 1, updated_at = ?
       WHERE thread_binding_id = ? AND revision = ? AND retired_at IS NULL
         AND continuation_blocked_at IS NULL
    `).run(
      input.createdAt,
      replacementEvidenceDigest,
      input.createdAt,
      input.thread.thread_binding_id,
      input.thread.revision,
    )
    if (changes(retired) !== 1) {
      throw new CodexBindingRepositoryError('idle_started_alias_contract_retire_cas_failed')
    }
    const retiredThread = this.requireThread(input.thread.thread_binding_id)
    this.assertThreadArchiveEligible(retiredThread.codex_thread_id as string)
    const transactionDigest = digest({
      aliasId: input.thread.ready_conversation_alias,
      retiredGeneration: input.thread.alias_generation,
      readyRunId: input.readyRunId,
      retirementEvidenceDigest: replacementEvidenceDigest,
    })
    this.recordThreadArchiveIntentInOpenTransaction({
      thread: retiredThread,
      sourceKind: 'retired_backfill',
      retiredReason: 'cleanup',
      readyRunId: null,
      retirementEvidenceDigest: replacementEvidenceDigest,
      retirementTransactionDigest: transactionDigest,
      retiredAt: input.createdAt,
    })
    const aliasGeneration = input.thread.alias_generation + 1
    this.insertEmptyAliasGenerationInOpenTransaction({
      threadBindingId: this.nextThreadBindingId(
        input.thread.ready_conversation_alias,
        aliasGeneration,
        replacementEvidenceDigest,
      ),
      aliasId: input.thread.ready_conversation_alias,
      aliasGeneration,
      readyScopeId: input.thread.ready_scope_id,
      runtimeManifestDigest: input.runtimeManifestDigest,
      protocolSchemaDigest: input.protocolSchemaDigest,
      createdAt: input.createdAt,
    })
  }

  private insertEmptyAliasGenerationInOpenTransaction(
    input: CodexEmptyAliasGenerationInput,
  ): {
    threadBindingId: string
    aliasId: string
    aliasGeneration: number
  } {
    this.validateEmptyAlias(input)
    this.db.prepare(`
      INSERT INTO codex_thread_bindings (
        thread_binding_id, ready_conversation_alias, alias_generation, ready_scope_id,
        runtime_manifest_digest, protocol_schema_digest, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      input.threadBindingId,
      input.aliasId,
      input.aliasGeneration,
      input.readyScopeId,
      input.runtimeManifestDigest,
      input.protocolSchemaDigest,
      input.createdAt,
      input.createdAt,
    )
    const readback = this.requireThread(input.threadBindingId)
    if (
      readback.ready_conversation_alias !== input.aliasId
      || readback.alias_generation !== input.aliasGeneration
      || readback.thread_start_reservation_set_id !== null
      || readback.codex_thread_id !== null
    ) throw new CodexBindingRepositoryError('empty_alias_readback_mismatch')
    return {
      threadBindingId: input.threadBindingId,
      aliasId: input.aliasId,
      aliasGeneration: input.aliasGeneration,
    }
  }

  private nextThreadBindingId(
    aliasId: string,
    aliasGeneration: number,
    evidenceDigest: string,
  ): string {
    return `codex-thread-${digest({ aliasId, aliasGeneration, evidenceDigest }).slice(0, 32)}`
  }

  private requireThread(threadBindingId: string): ThreadBindingRow {
    const row = this.db.prepare(`
      SELECT * FROM codex_thread_bindings WHERE thread_binding_id = ?
    `).get<ThreadBindingRow>(threadBindingId)
    if (!row) throw new CodexBindingRepositoryError('thread_binding_not_found')
    return row
  }

  private requireTurn(readyRunId: string): TurnBindingRow {
    const row = this.db.prepare(`
      SELECT * FROM codex_turn_bindings WHERE ready_run_id = ?
    `).get<TurnBindingRow>(readyRunId)
    if (!row) throw new CodexBindingRepositoryError('turn_binding_not_found')
    return row
  }

  private requireProcessLease(processLeaseId: string): CodexProcessLeaseRow {
    const row = this.db.prepare(`
      SELECT * FROM codex_sidecar_process_leases WHERE process_lease_id = ?
    `).get<ProcessLeaseDbRow>(processLeaseId)
    if (!row) throw new CodexBindingRepositoryError('process_lease_not_found')
    return processLeaseFromRow(row)
  }

  private startDescriptor(method: StartMethod) {
    return method === 'thread/start'
      ? {
          table: 'codex_thread_bindings', key: 'thread_binding_id',
          epoch: 'thread_start_rpc_connection_epoch', rpcId: 'thread_start_rpc_id',
          intent: 'thread_start_dispatch_intent_at', writeAt: 'thread_start_child_write_confirmed_at',
          writeDigest: 'thread_start_child_write_digest', releaseAt: 'thread_start_reservation_released_at',
          reconciledAt: 'thread_start_reconciled_at', responseAt: 'thread_start_response_at',
          guardClosedAt: 'thread_start_late_response_guard_closed_at',
          guardCloseReason: 'thread_start_late_response_guard_close_reason', nativeId: 'codex_thread_id',
        } as const
      : {
          table: 'codex_turn_bindings', key: 'ready_run_id',
          epoch: 'turn_start_rpc_connection_epoch', rpcId: 'turn_start_rpc_id',
          intent: 'turn_start_dispatch_intent_at', writeAt: 'turn_start_child_write_confirmed_at',
          writeDigest: 'turn_start_child_write_digest', releaseAt: 'turn_start_reservation_released_at',
          reconciledAt: 'turn_start_reconciled_at', responseAt: 'turn_start_response_at',
          guardClosedAt: 'turn_start_late_response_guard_closed_at',
          guardCloseReason: 'turn_start_late_response_guard_close_reason', nativeId: 'codex_turn_id',
        } as const
  }

  private requireStartRow(method: StartMethod, bindingId: string): Record<string, unknown> & {
    revision: number
  } {
    const descriptor = this.startDescriptor(method)
    const row = this.db.prepare(`
      SELECT * FROM ${descriptor.table} WHERE ${descriptor.key} = ?
    `).get<Record<string, unknown> & { revision: number }>(bindingId)
    if (!row) throw new CodexBindingRepositoryError('start_binding_not_found')
    return row
  }

  private assertStartRpc(
    row: Record<string, unknown>,
    descriptor: ReturnType<CodexBindingRepository['startDescriptor']>,
    input: { connectionEpoch: string; rpcId: number },
  ): void {
    if (
      row[descriptor.epoch] !== input.connectionEpoch
      || row[descriptor.rpcId] !== input.rpcId
      || row[descriptor.intent] === null
    ) throw new CodexBindingRepositoryError('start_rpc_identity_mismatch')
  }

  private assertDistinctProcessIdentities(input: CodexProcessLeaseIdentity): void {
    const identities = [
      input.ownerMainBootId,
      input.sidecarSpawnInstanceId,
      input.connectionEpoch,
    ]
    identities.forEach((value) => nonEmpty(value, 'process_identity_invalid'))
    if (new Set(identities).size !== identities.length) {
      throw new CodexBindingRepositoryError('process_identity_reused')
    }
    safePositive(input.ownerMainPid, 'owner_main_pid_invalid')
    for (const value of [
      input.processLeaseId,
      input.ownerMainProcessStartIdentity,
      input.runtimeManifestDigest,
      input.binarySha256,
      input.executablePath,
      input.isolatedStateDir,
    ]) nonEmpty(value, 'process_lease_identity_invalid')
  }

  private updateProcessLease(
    processLeaseId: string,
    expectedRevision: number,
    assignments: string,
    values: unknown[],
    condition: string,
  ): CodexProcessLeaseRow {
    return this.immediate(() => {
      const result = this.db.prepare(`
        UPDATE codex_sidecar_process_leases
           SET ${assignments}, revision = revision + 1
         WHERE process_lease_id = ? AND revision = ? AND ${condition}
      `).run(...values, processLeaseId, expectedRevision)
      if (changes(result) !== 1) throw new CodexBindingRepositoryError('process_lease_cas_failed')
      return this.requireProcessLease(processLeaseId)
    })
  }

  private recordThreadArchiveIntentInOpenTransaction(input: {
    thread: ThreadBindingRow
    sourceKind: CodexThreadArchiveSourceKind
    retiredReason: CodexThreadRetirementReason
    readyRunId: string | null
    retirementEvidenceDigest: string
    retirementTransactionDigest: string
    retiredAt: string
  }): string | null {
    const thread = input.thread
    if (!thread.codex_thread_id) return null
    if (!thread.codex_session_id || !thread.isolated_thread_cwd) {
      throw new CodexBindingRepositoryError('thread_archive_native_identity_missing')
    }
    const intent = recordCodexThreadArchiveIntentInOpenTransaction(this.db, {
      threadBindingId: thread.thread_binding_id,
      codexThreadId: thread.codex_thread_id,
      codexSessionId: thread.codex_session_id,
      isolatedThreadCwd: thread.isolated_thread_cwd,
      aliasId: thread.ready_conversation_alias,
      aliasGeneration: thread.alias_generation,
      sourceKind: input.sourceKind,
      retiredReason: input.retiredReason,
      readyRunId: input.readyRunId,
      retirementEvidenceDigest: input.retirementEvidenceDigest,
      retirementTransactionDigest: input.retirementTransactionDigest,
      requestedAt: input.retiredAt,
    })
    return intent.intentDigest
  }

  private requireThreadArchiveIntent(input: {
    threadBindingId: string
    sourceKind: CodexThreadArchiveSourceKind
    readyRunId: string | null
    retirementTransactionDigest: string
  }): { intentDigest: string } {
    const row = this.db.prepare(`
      SELECT intent_digest, source_kind, ready_run_id, retirement_transaction_digest
        FROM codex_thread_archive_intents WHERE thread_binding_id = ? LIMIT 1
    `).get<{
      intent_digest: string
      source_kind: string
      ready_run_id: string | null
      retirement_transaction_digest: string
    }>(input.threadBindingId)
    if (!row
      || row.source_kind !== input.sourceKind
      || row.ready_run_id !== input.readyRunId
      || row.retirement_transaction_digest !== input.retirementTransactionDigest) {
      throw new CodexBindingRepositoryError('thread_archive_intent_readback_missing')
    }
    return { intentDigest: row.intent_digest }
  }

  private immediate<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
