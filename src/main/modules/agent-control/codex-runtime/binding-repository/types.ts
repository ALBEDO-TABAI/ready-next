import type { LifecycleOperationFacts } from '../../../../../shared/ipc-contracts/agent-lifecycle-snapshot'
import type { StartIdentityReservationSet } from '../../send-scoped-confirmation'
import type { ToolExecutionOutput } from '../../tools-runtime/tool-result-types'
import type { CodexHeadActionBlocker, CodexHeadActionFacts } from '../codex-action-surface'
import type { PreparedCodexProductRun } from '../codex-product-run-preparer'
import type { RuntimeContinuityCatalog } from '../codex-runtime-compatibility'
import type { SameThreadContinuationCandidate, StoredThreadContinuationContract } from '../codex-same-thread-continuation'
import type { CodexTerminalFacts, CodexTerminalNativeReadbackReceipt } from '../codex-terminal-facts'
import type { ReadyToolSurface } from '../codex-tool-surface'
import type { CoreTurnCandidate } from '../codex-turn-collector'
import type { CodexDeliveredUserTail } from '../codex-turn-input-builder'
import type { CodexUserInput } from '../codex-user-input'

export type StartMethod = 'thread/start' | 'thread/fork' | 'turn/start'

export type StartState = 'held' | 'pending' | 'recovery_held'

export type RunResult = { changes?: number }

export type JsonObject = Record<string, unknown>

export type NativeTerminalCandidate = Extract<CoreTurnCandidate, { kind: 'native_terminal' }>

export type FrozenOutputDestination = {
  logicalResourceId: string
  path: string
  policyEpoch: number
  directoryIdentity: { device: string; inode: string; mode: number }
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
  continuationCandidate: SameThreadContinuationCandidate | null
}

export type CodexStoredContinuationRead = {
  stored: StoredThreadContinuationContract
  runtimeSourceManifestDigests: string[]
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

export type CodexNativeForkSeedInput = {
  targetCwd: string
  reservationSetId: string
  reservationId: string
  reservationEvidenceDigest: string
}

export type CodexUncommittedUserTailItem = {
  originUserMessageId: string
  input: CodexUserInput[]
  inputDigest: string
  policy: 'untrusted_text_history' | 'resource_restatement_required' | 'task_restatement_required'
}

export type CodexNativeCoverageItem = {
  messageId: string
  digest: string
}

export type CodexNativeCoverageReceiptRef = {
  receiptId: string
  digest: string
}

export type CodexAcceptedNativePrefixHead = {
  acceptedNativeHeadKind: 'turn' | 'compaction'
  acceptedNativeHeadId: string
  acceptedProductReadyRunId: string | null
  coverageReceiptRef: CodexNativeCoverageReceiptRef
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
  materializationKind: 'legacy' | 'fresh_start' | 'native_fork' | 'fresh_root_with_tail'
  materializationState: 'pending' | 'confirmed' | 'unknown' | 'proven_absent' | 'abandoned'
  historySeedDigest: string | null
  hasActiveFence: boolean
  continuationBlockedAt: string | null
  continuationBlockedReason: string | null
  retiredAt: string | null
  /** The thread's frozen Ready instructions, re-declared whenever Codex rebuilds its context. */
  instructionContractDigest: string | null
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
  /** The request tools the pinned runtime sends for the turn's frozen surface. */
  requestToolsDigest: string
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
  turnStartConnectionEpoch: string
  turnRevision: number
}

export type CodexTerminalCloseoutEvidence = {
  nativeReadback: CodexTerminalNativeReadbackReceipt
  terminalFacts: CodexTerminalFacts
}

export type CodexEngineTerminalReceiptRead = {
  readyRunId: string
  codexThreadId: string
  codexTurnId: string
  engineOutcome: 'completed' | 'interrupted' | 'failed'
  candidate: unknown
  candidateDigest: string
  recordedAt: string
  revision: number
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
  hasLegacyPreparedRun: boolean
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
  retiredGeneration: number | null
  retirementTransactionDigest: string | null
  archiveIntentDigest: string | null
  scopeClosureEvidenceDigest: string | null
  newGeneration: number | null
  newThreadBindingId: string | null
}

export type CodexModelGatewayBindingReadInput = {
  kind: 'product' | 'automatic_compaction' | 'manual_compaction'
  codexThreadId: string
  codexForkedFromId: string | null
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
  requestToolsDigest: string
  turnContractDigest: string | null
  instructionContractDigest: string
  additionalContextDigest: string | null
  deliveredUserTail: readonly CodexDeliveredUserTail[]
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

export type ThreadBindingRow = {
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
  thread_start_request_digest: string | null
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
  thread_materialization_kind: 'legacy' | 'fresh_start' | 'native_fork' | 'fresh_root_with_tail'
  history_source_thread_binding_id: string | null
  history_source_terminal_facts_digest: string | null
  fork_accepted_through_codex_turn_id: string | null
  fork_expected_prefix_turn_ids_json: string | null
  fork_expected_prefix_turn_ids_digest: string | null
  materialization_request_digest: string | null
  accepted_product_boundary_ready_run_id: string | null
  native_inherited_contract_digest: string | null
  source_accepted_native_coverage_receipt_id: string | null
  source_accepted_native_coverage_receipt_digest: string | null
  materialization_state: 'pending' | 'confirmed' | 'unknown' | 'proven_absent' | 'abandoned'
  materialization_effective_receipt_json: string | null
  materialization_effective_receipt_digest: string | null
  materialization_evidence_digest: string | null
  history_seed_digest: string | null
  uncommitted_user_tail_json: string | null
  uncommitted_user_tail_digest: string | null
  action_projection_sequence: number
  retired_at: string | null
  retired_reason: string | null
  retirement_evidence_digest: string | null
  continuation_blocked_at: string | null
  continuation_blocked_reason: string | null
  continuation_blocked_evidence_digest: string | null
  revision: number
}

export type TurnBindingRow = {
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
  turn_start_request_digest: string | null
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
  additional_context_digest: string
  turn_contract_digest: string
  attempt_kind: 'user_ingress'
    | 'recovery_successor' | 'checkpoint_successor' | 'explicit_retry'
  ingress_admitted_digest: string
  engine_terminal_status: 'completed' | 'interrupted' | 'failed' | null
  engine_terminal_candidate_json: string | null
  engine_terminal_candidate_digest: string | null
  engine_terminal_recorded_at: string | null
  terminal_native_readback_receipt_json: string | null
  terminal_native_readback_receipt_digest: string | null
  terminal_native_readback_revision: number | null
  terminal_facts_json: string | null
  terminal_facts_digest: string | null
  accepted_native_coverage_receipt_id: string | null
  accepted_native_coverage_receipt_digest: string | null
  publication_receipt_refs_json: string | null
  publication_receipt_digest: string | null
  publication_recorded_at: string | null
  effective_upstream_snapshot_ref: string
  effective_upstream_snapshot_digest: string
  fence_release_revision: number | null
  revision: number
}

export type CodexBrowserVerifierAttemptRow = {
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

export type ClosedTurnUpstreamRouteRow = {
  effective_codex_model: string
  effective_upstream_snapshot_ref: string
  effective_upstream_snapshot_digest: string
}

export type ProcessLeaseDbRow = {
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

export type ProductTurnHeadReadSnapshot = {
  liveTail: CodexUncommittedUserTailItem[]
  hasHeadProduct: boolean
  compacted: Map<string, string>
  headFacts: CodexHeadActionFacts
}

/** What the current runtime and Ready instructions produce; continuity and gateway reads compare against it. */
export type CodexBindingRepositoryContract = {
      runtimeManifestDigest: string
      protocolSchemaDigest: string
      /** The instruction contract the current runtime and Ready's developer instructions produce for a thread. */
      instructionContractDigest?: string
      runtimeContinuityCatalog?: RuntimeContinuityCatalog
      resolveHeadContractBlocker?: (input: {
        aliasId: string
        aliasGeneration: number
        scopeEpoch: number
        workbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
        threadBindingId: string
        codexThreadId: string | null
        materializationKind: 'legacy' | 'fresh_start' | 'native_fork' | 'fresh_root_with_tail'
      }) => CodexHeadActionBlocker | null | undefined
    }
