import { CodexBindingRepositoryError } from '../codex-binding-error'
import { digestCanonicalJson } from '../codex-model-gateway-contract'
import type { CodexBindingContext } from './context'
import { requireThread } from './core'
import { changes, hostFailureContinuationBlockedReason, nonEmpty, parseStringArray } from './shared'
import type { CodexBindingRecoveryGuard, CodexBindingRecoveryMember, CodexBindingRecoverySnapshot, CodexHostFailureRecovery, CodexManualCompactionRecovery, CodexProductFenceClaimRead, ProcessLeaseDbRow, ThreadBindingRow, TurnBindingRow } from './types'

// Boot recovery snapshot and product fence claims.

export function readRecoverySnapshot(context: CodexBindingContext, connectionIsLive: (connectionEpoch: string) => boolean): CodexBindingRecoverySnapshot {
  const members: CodexBindingRecoveryMember[] = []
  const guards: CodexBindingRecoveryGuard[] = []
  const threads = context.db.prepare(`SELECT * FROM codex_thread_bindings`).all<ThreadBindingRow>()
  const turns = context.db.prepare(`SELECT * FROM codex_turn_bindings`).all<TurnBindingRow>()
  for (const row of threads) {
    if (row.thread_start_reservation_set_id === null) continue
    const method: 'thread/start' | 'thread/fork' = row.thread_materialization_kind === 'native_fork'
      ? 'thread/fork'
      : 'thread/start'
    const requiredMemberCount: 1 | 2 = method === 'thread/fork' ? 1 : 2
    if (row.thread_start_reservation_released_at === null) {
      if (row.thread_start_reconciled_at || row.codex_thread_id) {
        throw new CodexBindingRepositoryError('released_member_invariant_broken')
      }
      members.push({
        reservationSetId: row.thread_start_reservation_set_id,
        reservationId: row.thread_start_reservation_member_id as string,
        scopeId: row.ready_scope_id,
        method,
        requiredMemberCount,
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
        method,
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
      const thread = requireThread(context, row.thread_binding_id)
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
  const manualRows = context.db.prepare(`
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
    const latestAttempt = context.db.prepare(`
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
  const productFences = context.db.prepare(`
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
  const productFenceCount = context.db.prepare(`
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

export function claimProductFenceForBoot(context: CodexBindingContext, input: {
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
  return context.immediate(() => {
    const fence = context.db.prepare(`
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
    const lease = context.db.prepare(`
        SELECT * FROM codex_sidecar_process_leases
         WHERE owner_main_boot_id = ?
           AND owner_main_dead_at IS NOT NULL
           AND owner_main_death_evidence_digest IS NOT NULL
           AND tree_zero_at IS NOT NULL
           AND tree_zero_evidence_digest IS NOT NULL
         ORDER BY tree_zero_at DESC LIMIT 1
      `).get<ProcessLeaseDbRow>(fence.owner_main_boot_id)
    if (!lease) throw new CodexBindingRepositoryError('product_fence_old_owner_unproven')
    const newLease = context.db.prepare(`
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
    context.db.prepare(`
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
    const claimed = context.db.prepare(`
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
