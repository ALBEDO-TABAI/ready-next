import { CodexBindingRepositoryError } from '../codex-binding-error'
import { advanceCodexConversationMessageVisibilityInOpenTransaction } from '../codex-conversation-scope-closure'
import { canonicalJson, digestCanonicalJson } from '../codex-model-gateway-contract'
import { excludeAlreadyCoveredItems } from '../codex-native-coverage-reader'
import type { CodexBindingContext } from './context'
import { assertRuntimeOperationForThread } from './continuity'
import { insertEmptyAliasGenerationInOpenTransaction, nextThreadBindingId, recordThreadArchiveIntentInOpenTransaction, requireThread } from './core'
import { appendAcceptedNativeCoverageReceiptInOpenTransaction, readFormalCoverageItemsForNativeTurns } from './native-history'
import { changes, digest, isRecord, nonEmpty, safePositive } from './shared'
import { readLatestClosedTurnUpstreamRoute } from './turns'

// Manual compaction bindings, dispatch attempts, recovery and consumption.

export function beginManualCompaction(context: CodexBindingContext, input: {
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
  return context.immediate(() => {
    const thread = requireThread(context, input.threadBindingId)
    if (
      !thread.codex_thread_id
      || thread.retired_at
      || thread.continuation_blocked_at
    ) throw new CodexBindingRepositoryError('manual_compaction_thread_not_eligible')
    assertRuntimeOperationForThread(context, thread.thread_binding_id, 'manual_compaction')
    const latestTurn = readLatestClosedTurnUpstreamRoute(context, thread.thread_binding_id)
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
    context.db.prepare(`
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
    context.db.prepare(`
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
    const readback = context.db.prepare(`
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

export function activateManualCompactionDispatch(context: CodexBindingContext, input: {
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
  return context.immediate(() => {
    const rows = context.db.prepare(`
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
    context.db.prepare(`
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

export function markManualCompactionWriteAttempted(context: CodexBindingContext, input: {
  connectionEpoch: string
  rpcId: number
  manualCompactionId: string
  attemptedAt: string
}): void {
  updateManualAttempt(context, input, 'attempted')
}

export function markManualCompactionWriteConfirmed(context: CodexBindingContext, input: {
  connectionEpoch: string
  rpcId: number
  manualCompactionId: string
  childWriteDigest: string
  confirmedAt: string
}): void {
  updateManualAttempt(context, input, 'confirmed')
}

export function markManualCompactionDispatchUnresolved(context: CodexBindingContext, input: {
  connectionEpoch: string
  rpcId: number
  manualCompactionId: string
  reason: 'response_timeout' | 'child_write_error' | 'connection_closed'
  unresolvedAt: string
}): void {
  updateManualAttempt(context, input, 'unresolved')
}

export function recordManualCompactionDispatchResponse(context: CodexBindingContext, input: {
  connectionEpoch: string
  rpcId: number
  manualCompactionId: string
  responseKind: 'accepted' | 'rejected'
  responseDigest: string
  responseAt: string
}): void {
  updateManualAttempt(context, input, 'response')
}

export function consumeLateManualCompactionResponse(context: CodexBindingContext, input: {
  connectionEpoch: string
  rpcId: number
  responseKind: 'accepted' | 'rejected'
  responseDigest: string
  responseAt: string
}): boolean {
  const row = context.db.prepare(`
      SELECT manual_compaction_id FROM codex_manual_compaction_dispatch_attempts
       WHERE connection_epoch = ? AND rpc_id = ? LIMIT 1
    `).get<{ manual_compaction_id: string }>(input.connectionEpoch, input.rpcId)
  if (!row) return false
  context.self.recordManualCompactionDispatchResponse({
    ...input,
    manualCompactionId: row.manual_compaction_id,
  })
  return true
}

export function markManualCompactionConnectionClosed(context: CodexBindingContext, connectionEpoch: string, closedAt: string): void {
  nonEmpty(connectionEpoch, 'manual_connection_epoch_invalid')
  nonEmpty(closedAt, 'manual_connection_close_time_invalid')
  context.immediate(() => {
    context.db.prepare(`
        UPDATE codex_manual_compaction_dispatch_attempts
           SET unresolved_at = COALESCE(unresolved_at, ?),
               unresolved_reason = COALESCE(unresolved_reason, 'connection_closed'),
               revision = revision + 1, updated_at = ?
         WHERE connection_epoch = ? AND response_kind IS NULL
           AND proven_absent_at IS NULL AND unresolved_at IS NULL
      `).run(closedAt, closedAt, connectionEpoch)
  })
}

export function proveManualCompactionAttemptAbsent(context: CodexBindingContext, input: {
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
  context.immediate(() => {
    const update = context.db.prepare(`
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

export function renewManualCompactionRecoveryWindow(context: CodexBindingContext, input: {
  manualCompactionId: string
  expiresAt: string
  renewedAt: string
}): void {
  for (const value of [input.manualCompactionId, input.expiresAt, input.renewedAt]) {
    nonEmpty(value, 'manual_recovery_window_invalid')
  }
  context.immediate(() => {
    const row = context.db.prepare(`
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
    const update = context.db.prepare(`
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

export function recordManualCompactionUnknown(context: CodexBindingContext, input: {
  manualCompactionId: string
  reason: string
  evidenceDigest: string
  unknownAt: string
}): void {
  for (const value of [input.manualCompactionId, input.reason, input.evidenceDigest, input.unknownAt]) {
    nonEmpty(value, 'manual_unknown_identity_invalid')
  }
  context.immediate(() => {
    const row = context.db.prepare(`
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
    const update = context.db.prepare(`
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

export function consumeManualCompaction(context: CodexBindingContext, input: {
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
  context.immediate(() => {
    const row = context.db.prepare(`
        SELECT manual_compaction_id, thread_binding_id, codex_thread_id,
               pre_dispatch_turn_ids_json, consumed_at, abandoned_at, unknown_at, revision
          FROM codex_manual_compaction_bindings WHERE manual_compaction_id = ?
      `).get<{
      manual_compaction_id: string
      thread_binding_id: string
      codex_thread_id: string
      pre_dispatch_turn_ids_json: string
      consumed_at: string | null
      abandoned_at: string | null
      unknown_at: string | null
      revision: number
    }>(input.manualCompactionId)
    if (!row || row.consumed_at || row.abandoned_at || row.unknown_at) {
      throw new CodexBindingRepositoryError('manual_compaction_not_consumable')
    }
    const claimed = context.db.prepare(`
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
    const update = context.db.prepare(`
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
    const priorHead = context.self.readAcceptedNativePrefixHead(row.thread_binding_id)
    const preDispatchTurnIds = JSON.parse(row.pre_dispatch_turn_ids_json) as unknown
    if (!Array.isArray(preDispatchTurnIds)
      || preDispatchTurnIds.some((turnId) => typeof turnId !== 'string' || !turnId.trim())
      || new Set(preDispatchTurnIds).size !== preDispatchTurnIds.length) {
      throw new CodexBindingRepositoryError('manual_compaction_pre_dispatch_turns_invalid')
    }
    const manualCandidates = readFormalCoverageItemsForNativeTurns(
      context,
      row.thread_binding_id,
      preDispatchTurnIds,
    )
    appendAcceptedNativeCoverageReceiptInOpenTransaction(context, {
      threadBindingId: row.thread_binding_id,
      producerKind: 'manual_compaction',
      producerOwnerId: input.manualCompactionId,
      codexThreadId: row.codex_thread_id,
      acceptedNativeHeadKind: 'compaction',
      acceptedNativeHeadId: input.codexCompactionTurnId,
      acceptedProductReadyRunId: priorHead?.acceptedProductReadyRunId ?? null,
      newlyCovered: excludeAlreadyCoveredItems(context.db,
        priorHead?.coverageReceiptRef.receiptId ?? null,
        manualCandidates,
      ),
      createdAt: input.consumedAt,
    })
    const headAdvanced = context.db.prepare(`
        UPDATE codex_thread_bindings
           SET action_projection_sequence = action_projection_sequence + 1,
               revision = revision + 1, updated_at = ?
         WHERE thread_binding_id = ?
      `).run(input.consumedAt, row.thread_binding_id)
    if (changes(headAdvanced) !== 1) {
      throw new CodexBindingRepositoryError('manual_compaction_head_advance_failed')
    }
    const fence = context.db.prepare(`
        DELETE FROM codex_thread_dispatch_fences
         WHERE thread_binding_id = ? AND owner_manual_compaction_id = ?
      `).run(row.thread_binding_id, input.manualCompactionId)
    if (changes(fence) !== 1) throw new CodexBindingRepositoryError('manual_compaction_fence_release_failed')
  })
}

/**
 * Codex answered the compaction request with an error and two readbacks showed the thread unchanged since before
 * dispatch: nothing started. Settle the request and release its fence so the conversation is idle again.
 */
export function settleRejectedManualCompaction(context: CodexBindingContext, input: {
  manualCompactionId: string
  settledAt: string
}): void {
  for (const value of [input.manualCompactionId, input.settledAt]) {
    nonEmpty(value, 'manual_rejection_identity_invalid')
  }
  context.immediate(() => {
    const row = context.db.prepare(`
        SELECT thread_binding_id, codex_compaction_turn_id, consumed_at, abandoned_at, revision
          FROM codex_manual_compaction_bindings WHERE manual_compaction_id = ?
      `).get<{
      thread_binding_id: string
      codex_compaction_turn_id: string | null
      consumed_at: string | null
      abandoned_at: string | null
      revision: number
    }>(input.manualCompactionId)
    if (!row || row.consumed_at || row.abandoned_at || row.codex_compaction_turn_id) {
      throw new CodexBindingRepositoryError('manual_compaction_not_settleable')
    }
    const attempt = context.db.prepare(`
        SELECT response_kind FROM codex_manual_compaction_dispatch_attempts
         WHERE manual_compaction_id = ?
         ORDER BY created_at DESC, rpc_id DESC LIMIT 1
      `).get<{ response_kind: 'accepted' | 'rejected' | null }>(input.manualCompactionId)
    if (attempt?.response_kind !== 'rejected') {
      throw new CodexBindingRepositoryError('manual_compaction_rejection_missing')
    }
    const settled = context.db.prepare(`
        UPDATE codex_manual_compaction_bindings
           SET abandoned_at = ?, abandoned_reason = 'dispatch_rejected', abandoned_reconciled_at = ?,
               revision = revision + 1, updated_at = ?
         WHERE manual_compaction_id = ? AND revision = ?
           AND consumed_at IS NULL AND abandoned_at IS NULL AND codex_compaction_turn_id IS NULL
      `).run(
      input.settledAt,
      input.settledAt,
      input.settledAt,
      input.manualCompactionId,
      row.revision,
    )
    if (changes(settled) !== 1) throw new CodexBindingRepositoryError('manual_rejection_cas_failed')
    const fence = context.db.prepare(`
        DELETE FROM codex_thread_dispatch_fences
         WHERE thread_binding_id = ? AND owner_manual_compaction_id = ? AND quarantined_at IS NULL
      `).run(row.thread_binding_id, input.manualCompactionId)
    if (changes(fence) !== 1) throw new CodexBindingRepositoryError('manual_rejection_fence_release_failed')
    const headAdvanced = context.db.prepare(`
        UPDATE codex_thread_bindings
           SET action_projection_sequence = action_projection_sequence + 1,
               revision = revision + 1, updated_at = ?
         WHERE thread_binding_id = ?
      `).run(input.settledAt, row.thread_binding_id)
    if (changes(headAdvanced) !== 1) throw new CodexBindingRepositoryError('manual_rejection_head_advance_failed')
  })
}

export function quarantineUnknownManualCompaction(context: CodexBindingContext, input: {
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
  return context.immediate(() => {
    const row = context.db.prepare(`
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
    const manual = context.db.prepare(`
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
    const thread = requireThread(context, row.thread_binding_id)
    if (
      thread.ready_conversation_alias !== input.aliasId
      || thread.alias_generation !== input.aliasGeneration
      || thread.retired_at
    ) throw new CodexBindingRepositoryError('manual_quarantine_alias_mismatch')
    const retired = context.db.prepare(`
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
    const fence = context.db.prepare(`
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
    const newThreadBindingId = nextThreadBindingId(
      context,
      thread.ready_conversation_alias,
      nextAliasGeneration,
      input.evidenceDigest,
    )
    insertEmptyAliasGenerationInOpenTransaction(context, {
      threadBindingId: newThreadBindingId,
      aliasId: thread.ready_conversation_alias,
      aliasGeneration: nextAliasGeneration,
      readyScopeId: thread.ready_scope_id,
      runtimeManifestDigest: thread.runtime_manifest_digest,
      protocolSchemaDigest: thread.protocol_schema_digest,
      createdAt: input.quarantinedAt,
    })
    const visibility = advanceCodexConversationMessageVisibilityInOpenTransaction(context.db, {
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

export function reconcileQuarantinedManualCompaction(context: CodexBindingContext, input: {
  manualCompactionId: string
  threadReadDigest: string
  reconciledAt: string
}): { archiveIntentDigest: string | null } {
  for (const value of [input.manualCompactionId, input.threadReadDigest, input.reconciledAt]) {
    nonEmpty(value, 'manual_reconciliation_identity_invalid')
  }
  return context.immediate(() => {
    const row = context.db.prepare(`
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
      const manual = context.db.prepare(`
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
      const fence = context.db.prepare(`
          DELETE FROM codex_thread_dispatch_fences
           WHERE thread_binding_id = ? AND owner_manual_compaction_id = ?
             AND quarantined_at IS NOT NULL
        `).run(row.thread_binding_id, input.manualCompactionId)
      if (changes(fence) !== 1) {
        throw new CodexBindingRepositoryError('manual_reconciliation_fence_release_failed')
      }
    }
    const thread = requireThread(context, row.thread_binding_id)
    if (thread.retired_reason !== 'manual_compaction_quarantine'
      || !thread.retired_at || !thread.retirement_evidence_digest) {
      throw new CodexBindingRepositoryError('manual_reconciliation_thread_retirement_missing')
    }
    const successor = context.db.prepare(`
        SELECT thread_binding_id, alias_generation FROM codex_thread_bindings
         WHERE ready_conversation_alias = ? AND alias_generation = ? LIMIT 1
      `).get<{ thread_binding_id: string; alias_generation: number }>(
      thread.ready_conversation_alias,
      thread.alias_generation + 1,
    )
    if (!successor) throw new CodexBindingRepositoryError('manual_reconciliation_successor_missing')
    if (thread.codex_thread_id) context.self.assertThreadArchiveEligible(thread.codex_thread_id)
    const retirementTransactionDigest = digest({
      aliasId: thread.ready_conversation_alias,
      retiredGeneration: thread.alias_generation,
      nextAliasGeneration: successor.alias_generation,
      newThreadBindingId: successor.thread_binding_id,
      manualCompactionId: input.manualCompactionId,
      evidenceDigest: thread.retirement_evidence_digest,
    })
    return {
      archiveIntentDigest: recordThreadArchiveIntentInOpenTransaction(context, {
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

export function updateManualAttempt(
  context: CodexBindingContext,
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
  context.immediate(() => {
    const row = context.db.prepare(`
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
      const update = context.db.prepare(`
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
      const update = context.db.prepare(`
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
      const update = context.db.prepare(`
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
    const update = context.db.prepare(`
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
