import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { normalizeContextUsageSnapshot } from '../../../../../shared/context-usage-types'
import { CodexBindingRepositoryError } from '../codex-binding-error'
import { digestCanonicalJson } from '../codex-model-gateway-contract'
import type { CodexAdmittedBindingInput, CodexBrowserVerifierAttemptRead, CodexBrowserVerifierAttemptRow, CodexBrowserVerifierVerdict, CodexHostFailureRecovery, CodexLifecycleAction, CodexProcessLeaseRow, CodexProductInterruptOwnerRead, FrozenOutputDestination, JsonObject, NativeTerminalCandidate, ProcessLeaseDbRow, RunResult, TurnBindingRow } from './types'

export function assertNativeTerminalCandidate(value: unknown): asserts value is NativeTerminalCandidate {
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
    || !isRecord(value.runtimeDiagnostics)
    || (value.contextUsage !== null && !normalizeContextUsageSnapshot(value.contextUsage))) {
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

export function readyToolResultSuccess(value: unknown): boolean | null {
  if (!isRecord(value)) return null
  if (isRecord(value.data)
    && (value.data.ok === false
      || (typeof value.data.errorKind === 'string' && value.data.errorKind.trim().length > 0))) {
    return false
  }
  if (isRecord(value.envelope)) return value.envelope.ok === true
  return true
}

export function frozenOutputDestination(ingressJson: string | null): FrozenOutputDestination | null {
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
    // silent-catch: unparseable ingress JSON means no frozen output destination
    return null
  }
}

export function hashPath(path: string): { bytes: number; sha256: string } {
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

export function safeTargetPath(root: string, relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/').trim()
  if (!normalized || isAbsolute(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')) return null
  const target = resolve(root, normalized)
  const rel = relative(resolve(root), target)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return target
}

export const CODEX_DELIVERY_LANE_TOOL_NAMES = new Set([
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
    continuationCandidate: input.continuationCandidate,
  }
}

export function buildCodexIngressAdmittedDigest(
  input: Omit<CodexAdmittedBindingInput, 'ingressAdmittedDigest'>,
): string {
  return digestCanonicalJson(buildCodexIngressAdmissionReceipt(input))
}

export function nonEmpty(value: string, code: string): void {
  if (!value.trim()) throw new CodexBindingRepositoryError(code)
}

export function safePositive(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new CodexBindingRepositoryError(code)
}

export function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isPinnedReadOnlySandbox(value: unknown): boolean {
  if (!isRecord(value) || value.type !== 'readOnly') return false
  const keys = Object.keys(value)
  return keys.every((key) => key === 'type' || key === 'networkAccess')
    && (value.networkAccess === undefined || value.networkAccess === false)
}

export function parseStringArray(value: string, code: string): string[] {
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

export function parseNullableObjectStrict(
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

export function parseArrayOrEmptyStrict(
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

export function parseProductBudgetLimits(value: string): {
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

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function codexLifecycleActionEvidence(input: CodexProductInterruptOwnerRead & {
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

export function codexLifecycleActionRetirementDigest(input: {
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

export function changes(result: unknown): number {
  return Number((result as RunResult | null)?.changes || 0)
}

export function browserVerifierAttemptFromRow(
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

export function hostFailureContinuationBlockedReason(
  turn: Pick<TurnBindingRow, 'codex_thread_id'>,
): CodexHostFailureRecovery['continuationBlockedReason'] {
  return turn.codex_thread_id === null ? 'start_delivery_absent' : 'publication_diverged'
}

export function processLeaseFromRow(row: ProcessLeaseDbRow): CodexProcessLeaseRow {
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
