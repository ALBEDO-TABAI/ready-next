import { createHash } from 'node:crypto'

import type { DatabaseConnection } from '../../database'
import type { PreparedCodexProductRun } from './codex-product-run-preparer'
import {
  normalizeCodexThread,
  normalizeCodexTurn,
} from './codex-native-runtime'
import type { StartIdentityReservationSet } from '../send-scoped-confirmation'

type StartMethod = 'thread/start' | 'turn/start'
type StartState = 'held' | 'pending' | 'recovery_held'
type RunResult = { changes?: number }
type JsonObject = Record<string, unknown>

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

export class CodexBindingRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CodexBindingRepositoryError'
  }
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
  instruction_contract_digest: string | null
  codex_model_provider_id: string | null
  codex_model: string | null
  upstream_profile_snapshot_ref: string | null
  upstream_profile_snapshot_digest: string | null
  retired_at: string | null
  continuation_blocked_at: string | null
  revision: number
}

type TurnBindingRow = {
  ready_run_id: string
  ready_task_id: string
  thread_binding_id: string
  codex_thread_id: string | null
  codex_turn_id: string | null
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
  product_terminal_digest: string | null
  product_closeout_at: string | null
  revision: number
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

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function changes(result: unknown): number {
  return Number((result as RunResult | null)?.changes || 0)
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
  constructor(private readonly db: DatabaseConnection) {}

  createEmptyAliasGeneration(input: CodexEmptyAliasGenerationInput): {
    threadBindingId: string
    aliasId: string
    aliasGeneration: number
  } {
    this.validateEmptyAlias(input)
    return this.immediate(() => this.insertEmptyAliasGenerationInOpenTransaction(input))
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
      return {
        aliasId: thread.ready_conversation_alias,
        retiredGeneration: thread.alias_generation,
        newGeneration,
        newThreadBindingId,
        transactionDigest: digest({
          aliasId: thread.ready_conversation_alias,
          retiredGeneration: thread.alias_generation,
          newGeneration,
          newThreadBindingId,
          retirementEvidenceDigest: input.retirementEvidenceDigest,
        }),
      }
    })
  }

  admitProductBindings(input: CodexAdmittedBindingInput): {
    threadBindingId: string
    readyRunId: string
    threadState: 'unstarted' | 'loaded'
  } {
    this.validateAdmission(input)
    return this.immediate(() => {
      this.assertReadyParents(input)
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
        thread = existing
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
                 tool_surface_digest = ?, instruction_contract_digest = ?,
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
          ingress_admitted_revision,
          ingress_admitted_digest,
          ingress_admitted_at,
          attempt_kind,
          tool_surface_digest,
          authorization_snapshot_digest,
          effective_codex_model,
          effective_upstream_snapshot_ref,
          effective_upstream_snapshot_digest,
          additional_context_digest,
          turn_contract_digest,
          revision,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user_ingress', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
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
        input.prepared.ingress.originUserMessageId,
        input.ingressAdmittedRevision,
        input.ingressAdmittedDigest,
        input.admittedAt,
        input.prepared.readyToolSurface.toolSurfaceDigest,
        input.prepared.readyTurnToolAuthorization.authorizationDigest,
        input.codexModel,
        input.upstreamProfileSnapshotRef,
        input.upstreamProfileSnapshotDigest,
        input.additionalContextDigest,
        input.turnContractDigest,
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
    })
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
            continuationBlockedReason: row.host_failure_kind.startsWith('thread_start')
              ? 'start_delivery_absent'
              : 'publication_diverged',
          }]
        : []
    ))
    const manualRows = this.db.prepare(`
      SELECT manual.manual_compaction_id, manual.thread_binding_id,
             manual.codex_thread_id, manual.consumed_at, manual.abandoned_at,
             manual.abandoned_reconciled_at, fence.owner_manual_compaction_id,
             fence.quarantined_at
        FROM codex_manual_compaction_bindings manual
        LEFT JOIN codex_thread_dispatch_fences fence
          ON fence.thread_binding_id = manual.thread_binding_id
         AND fence.owner_manual_compaction_id = manual.manual_compaction_id
    `).all<{
      manual_compaction_id: string
      thread_binding_id: string
      codex_thread_id: string
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
      manualCompactions.push({
        manualCompactionId: row.manual_compaction_id,
        threadBindingId: row.thread_binding_id,
        codexThreadId: row.codex_thread_id,
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
      SELECT thread_binding_id, retired_at, thread_start_reservation_released_at
        FROM codex_thread_bindings WHERE codex_thread_id = ? LIMIT 1
    `).get<{
      thread_binding_id: string
      retired_at: string | null
      thread_start_reservation_released_at: string | null
    }>(threadId)
    if (!thread || !thread.retired_at || !thread.thread_start_reservation_released_at) {
      throw new CodexBindingRepositoryError('thread_archive_not_retired')
    }
    const fence = this.db.prepare(`
      SELECT thread_binding_id FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? LIMIT 1
    `).get(thread.thread_binding_id)
    if (fence) throw new CodexBindingRepositoryError('thread_archive_fence_active')
    const unresolved = this.db.prepare(`
      SELECT ready_run_id FROM codex_turn_bindings
       WHERE thread_binding_id = ?
         AND (
           turn_start_reservation_released_at IS NULL
           OR (product_terminal_digest IS NULL AND host_failure_product_terminal_digest IS NULL)
         )
       LIMIT 1
    `).get(thread.thread_binding_id)
    if (unresolved) throw new CodexBindingRepositoryError('thread_archive_turn_unresolved')
    const unresolvedCall = this.db.prepare(`
      SELECT call_row.codex_call_id
        FROM codex_tool_call_bindings call_row
        JOIN codex_turn_bindings turn_row ON turn_row.ready_run_id = call_row.ready_run_id
       WHERE turn_row.thread_binding_id = ?
         AND (call_row.receipt_id IS NULL OR call_row.result_digest IS NULL)
       LIMIT 1
    `).get(thread.thread_binding_id)
    if (unresolvedCall) throw new CodexBindingRepositoryError('thread_archive_call_unresolved')
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
        continuationBlockedReason: turn.host_failure_kind.startsWith('thread_start')
          ? 'start_delivery_absent'
          : 'publication_diverged',
      })
      return { handled: true, reservationSetId: completed.reservationSetId }
    }
    this.completeProductTurnCloseoutInOpenTransaction(input, turn)
    return { handled: true, reservationSetId: turn.start_reservation_set_id }
  }

  bindToolCall(input: {
    codexThreadId: string
    codexTurnId: string
    codexCallId: string
    readyRunId: string
    readyActionId: string
    toolName: string
    argsDigest: string
    turnContractDigest: string
    at: string
  }): { duplicate: boolean } {
    return this.immediate(() => {
      const owner = this.requireTurn(input.readyRunId)
      if (
        owner.codex_thread_id !== input.codexThreadId
        || owner.codex_turn_id !== input.codexTurnId
      ) throw new CodexBindingRepositoryError('tool_call_parent_identity_mismatch')
      this.assertStartFenceNotQuarantined(owner.thread_binding_id, owner.ready_run_id)
      const existing = this.db.prepare(`
        SELECT * FROM codex_tool_call_bindings
         WHERE codex_thread_id = ? AND codex_turn_id = ? AND codex_call_id = ?
      `).get<Record<string, unknown>>(input.codexThreadId, input.codexTurnId, input.codexCallId)
      if (existing) {
        if (
          existing.ready_run_id !== input.readyRunId
          || existing.ready_action_id !== input.readyActionId
          || existing.tool_name !== input.toolName
          || existing.args_digest !== input.argsDigest
          || existing.turn_contract_digest !== input.turnContractDigest
        ) throw new CodexBindingRepositoryError('tool_call_identity_conflict')
        return { duplicate: true }
      }
      this.db.prepare(`
        INSERT INTO codex_tool_call_bindings (
          codex_thread_id, codex_turn_id, codex_call_id, ready_run_id,
          ready_action_id, tool_name, args_digest, turn_contract_digest,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        input.codexThreadId,
        input.codexTurnId,
        input.codexCallId,
        input.readyRunId,
        input.readyActionId,
        input.toolName,
        input.argsDigest,
        input.turnContractDigest,
        input.at,
        input.at,
      )
      return { duplicate: false }
    })
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
      this.db.prepare(`
        INSERT INTO codex_manual_compaction_bindings (
          manual_compaction_id, thread_binding_id, codex_thread_id,
          codex_model_provider_id, codex_model, upstream_profile_snapshot_ref,
          upstream_profile_snapshot_digest, provider_snapshot_json,
          credential_reference_id, expected_tools_digest, expires_at,
          revision, created_at, updated_at
        ) VALUES (?, ?, ?, 'ready_gateway', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
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

  consumeManualCompaction(input: {
    manualCompactionId: string
    codexCompactionTurnId: string
    contextCompactionItemId: string
    threadReadDigest: string
    consumedAt: string
  }): void {
    this.immediate(() => {
      const row = this.db.prepare(`
        SELECT manual_compaction_id, thread_binding_id, codex_thread_id,
               consumed_at, abandoned_at, revision
          FROM codex_manual_compaction_bindings WHERE manual_compaction_id = ?
      `).get<{
        manual_compaction_id: string
        thread_binding_id: string
        codex_thread_id: string
        consumed_at: string | null
        abandoned_at: string | null
        revision: number
      }>(input.manualCompactionId)
      if (!row || row.consumed_at || row.abandoned_at) {
        throw new CodexBindingRepositoryError('manual_compaction_not_consumable')
      }
      const evidenceDigest = digest({
        manualCompactionId: input.manualCompactionId,
        codexThreadId: row.codex_thread_id,
        codexCompactionTurnId: input.codexCompactionTurnId,
        contextCompactionItemId: input.contextCompactionItemId,
        threadReadDigest: input.threadReadDigest,
      })
      const update = this.db.prepare(`
        UPDATE codex_manual_compaction_bindings
           SET codex_compaction_turn_id = ?, consumed_at = ?, consume_evidence_digest = ?,
               revision = revision + 1, updated_at = ?
         WHERE manual_compaction_id = ? AND revision = ?
           AND consumed_at IS NULL AND abandoned_at IS NULL
      `).run(
        input.codexCompactionTurnId,
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
    manualCompactionId: string
    reason: string
    evidenceDigest: string
    quarantinedAt: string
  }): {
    aliasId: string
    retiredGeneration: number
    nextAliasGeneration: number
    newThreadBindingId: string
  } {
    for (const value of [
      input.manualCompactionId,
      input.reason,
      input.evidenceDigest,
      input.quarantinedAt,
    ]) nonEmpty(value, 'manual_quarantine_identity_invalid')
    return this.immediate(() => {
      const row = this.db.prepare(`
        SELECT manual_compaction_id, thread_binding_id, consumed_at, abandoned_at, revision
          FROM codex_manual_compaction_bindings WHERE manual_compaction_id = ?
      `).get<{
        manual_compaction_id: string
        thread_binding_id: string
        consumed_at: string | null
        abandoned_at: string | null
        revision: number
      }>(input.manualCompactionId)
      if (!row || row.consumed_at || row.abandoned_at) {
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
      return {
        aliasId: thread.ready_conversation_alias,
        retiredGeneration: thread.alias_generation,
        nextAliasGeneration,
        newThreadBindingId,
      }
    })
  }

  reconcileQuarantinedManualCompaction(input: {
    manualCompactionId: string
    threadReadDigest: string
    reconciledAt: string
  }): void {
    for (const value of [input.manualCompactionId, input.threadReadDigest, input.reconciledAt]) {
      nonEmpty(value, 'manual_reconciliation_identity_invalid')
    }
    this.immediate(() => {
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
      if (row.abandoned_reconciled_at) return
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
      'owner_main_dead_at IS NULL AND tree_zero_at IS NULL',
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

  private completeProductTurnCloseoutInOpenTransaction(
    input: { readyRunId: string; productTerminalDigest: string; closeoutAt: string },
    turn = this.requireTurn(input.readyRunId),
  ): void {
    if (turn.host_failure_kind || turn.host_failure_product_terminal_digest) {
      throw new CodexBindingRepositoryError('product_closeout_kind_conflict')
    }
    if (turn.product_terminal_digest) {
      if (
        turn.product_terminal_digest !== input.productTerminalDigest
        || turn.product_closeout_at !== input.closeoutAt
      ) throw new CodexBindingRepositoryError('product_terminal_immutable')
      this.assertProductFenceReleased(turn.thread_binding_id)
      return
    }
    if (
      !turn.codex_turn_id
      || !turn.turn_start_reconciled_at
      || !turn.turn_start_reservation_released_at
    ) throw new CodexBindingRepositoryError('product_turn_not_reconciled')
    const turnUpdate = this.db.prepare(`
      UPDATE codex_turn_bindings
         SET product_terminal_digest = ?, product_closeout_at = ?,
             revision = revision + 1, updated_at = ?
       WHERE ready_run_id = ? AND revision = ? AND product_terminal_digest IS NULL
    `).run(
      input.productTerminalDigest,
      input.closeoutAt,
      input.closeoutAt,
      input.readyRunId,
      turn.revision,
    )
    if (changes(turnUpdate) !== 1) throw new CodexBindingRepositoryError('product_terminal_cas_failed')
    const fence = this.db.prepare(`
      DELETE FROM codex_thread_dispatch_fences
       WHERE thread_binding_id = ? AND owner_ready_run_id = ?
    `).run(turn.thread_binding_id, input.readyRunId)
    if (changes(fence) !== 1) throw new CodexBindingRepositoryError('product_fence_release_failed')
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
      if (turn.host_failure_product_terminal_digest !== input.productTerminalDigest) {
        throw new CodexBindingRepositoryError('host_failure_terminal_immutable')
      }
      if (
        !turn.turn_start_reservation_released_at
        || !thread.continuation_blocked_at
      ) throw new CodexBindingRepositoryError('host_failure_closeout_incomplete')
      this.assertProductFenceReleased(thread.thread_binding_id)
      return { reservationSetId: turn.start_reservation_set_id }
    }
    const turnUpdate = this.db.prepare(`
      UPDATE codex_turn_bindings
         SET host_failure_product_terminal_digest = ?,
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
       WHERE thread_binding_id = ? AND owner_ready_run_id = ?
    `).run(thread.thread_binding_id, input.readyRunId)
    if (changes(fence) !== 1) throw new CodexBindingRepositoryError('product_fence_release_failed')
    return { reservationSetId: turn.start_reservation_set_id }
  }

  private assertProductFenceReleased(threadBindingId: string): void {
    const fence = this.db.prepare(`
      SELECT owner_ready_run_id, owner_manual_compaction_id
        FROM codex_thread_dispatch_fences WHERE thread_binding_id = ? LIMIT 1
    `).get(threadBindingId)
    if (fence) throw new CodexBindingRepositoryError('product_fence_owner_mismatch')
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
    if (
      reservation.scopeId !== prepared.readyToolHostIdentity.scopeId
      || reservation.reservationSetId !== prepared.ingressBinding.reservationSetId
      || reservation.reservationEvidenceDigest !== prepared.ingressBinding.reservationEvidenceDigest
      || reservation.members.length !== (reservation.existingThread ? 1 : 2)
      || reservation.members[reservation.members.length - 1]?.method !== 'turn/start'
      || (!reservation.existingThread && reservation.members[0]?.method !== 'thread/start')
    ) throw new CodexBindingRepositoryError('admission_reservation_mismatch')
    safePositive(input.ingressAdmittedRevision, 'ingress_revision_invalid')
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
    ]) nonEmpty(value, 'admission_identity_invalid')
  }

  private assertReadyParents(input: CodexAdmittedBindingInput): void {
    const scope = this.db.prepare(`SELECT id FROM chat_conversations WHERE id = ?`).get<{ id: string }>(
      input.prepared.readyToolHostIdentity.scopeId,
    )
    const message = this.db.prepare(`
      SELECT id, conversation_id FROM chat_messages WHERE id = ?
    `).get<{ id: string; conversation_id: string }>(input.prepared.ingress.originUserMessageId)
    const task = this.db.prepare(`
      SELECT task_id, run_id, scope_id FROM task_projections WHERE task_id = ?
    `).get<{ task_id: string; run_id: string; scope_id: string }>(input.prepared.taskId)
    if (
      scope?.id !== input.prepared.readyToolHostIdentity.scopeId
      || message?.conversation_id !== input.prepared.readyToolHostIdentity.scopeId
      || task?.run_id !== input.prepared.runId
      || task.scope_id !== input.prepared.readyToolHostIdentity.scopeId
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
